import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { SSEClientTransport } from "@modelcontextprotocol/sdk/client/sse.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import type { ResolvedCredential } from "../connections/manager.js";
import { isHttpMcp, type McpHttpConfig, type McpStdioConfig } from "../personas.js";
import { Redactor } from "../proxy/redactor.js";
import type { PodmanRuntime } from "../sandbox/podman.js";
import type { Settings } from "../settings.js";
import { errMsg, hostMatches, log, truncateMiddle } from "../util.js";
import { mcpTool, type ToolDef, type ToolOutput } from "./tools.js";

const sanitize = (s: string) => s.replace(/[^A-Za-z0-9_-]/g, "_");

interface Conn {
  name: string;
  cfg: McpStdioConfig | McpHttpConfig;
  client: Client | null;
  error: string | null;
  credentialRefs: string[]; // refs its http headers use
}

/** What http MCP servers need from the session's credentials, on the host. */
export interface McpCredentials {
  resolve(template: string): { text: string; used: string[] };
  hosts(ref: string): string[];
  /** Real values in a server's output, rewritten before the agent sees them. */
  scrub(text: string, refs: string[]): string;
}

/** A credential's real values long enough to recognise. */
export function credentialValues(c: ResolvedCredential | undefined): string[] {
  if (!c) return [];
  return [c.value, c.aws?.accessKeyId, c.aws?.secretAccessKey, c.aws?.sessionToken].filter((v): v is string => !!v && v.length >= 6);
}

/** Text with each value, raw or encoded, replaced by its label. */
export function scrubValues(text: string, values: { secret: string; placeholder: string }[]): string {
  return values.length ? new Redactor(Redactor.pairs(values)).text(text) : text;
}

/**
 * The headers to send an http MCP server. A credential goes only over HTTPS, only to one of its
 * own hosts, and never follows a redirect: the same terms the egress proxy gives it.
 */
export function httpMcpHeaders(cfg: McpHttpConfig, creds: McpCredentials): { url: URL; headers: Record<string, string>; refs: string[] } {
  const url = new URL(cfg.url);
  const headers: Record<string, string> = {};
  const refs = new Set<string>();
  for (const [k, v] of Object.entries(cfg.headers)) {
    const r = creds.resolve(v);
    for (const ref of r.used) refs.add(ref);
    headers[k] = r.text;
  }
  for (const ref of refs) {
    if (url.protocol !== "https:") throw new Error(`credential ${ref} is only sent over HTTPS, and ${url.origin} isn't`);
    const hosts = creds.hosts(ref);
    if (!hosts.some((p) => hostMatches(url.hostname, p)))
      throw new Error(`credential ${ref} is only sent to its own hosts (${hosts.join(", ") || "none"}), and ${url.hostname} isn't one of them`);
  }
  return { url, headers, refs: [...refs] };
}

/**
 * MCP servers for one session. stdio servers run inside the session container through
 * `podman exec -i` and only ever see placeholders; http servers are called from the host
 * with headers resolved from the session's credentials (and reconnect when those change).
 */
export class SessionMcp {
  private conns = new Map<string, Conn>();

  constructor(
    private runtime: PodmanRuntime,
    private creds: McpCredentials,
    private settings: Settings,
    private container: string,
    private workdir: string,
    private renderPlaceholders: (template: string) => string,
  ) {}

  async start(servers: Record<string, McpStdioConfig | McpHttpConfig>, onProgress: (msg: string) => void): Promise<string[]> {
    const problems: string[] = [];
    await Promise.all(
      Object.entries(servers)
        .filter(([, cfg]) => cfg.enabled)
        .map(async ([name, cfg]) => {
          const refs = isHttpMcp(cfg) ? [...new Set(Object.values(cfg.headers).flatMap((v) => this.creds.resolve(v).used))] : [];
          const conn: Conn = { name, cfg, client: null, error: null, credentialRefs: refs };
          this.conns.set(name, conn);
          onProgress(`starting MCP server ${name}`);
          try {
            await this.connect(conn);
          } catch (e) {
            conn.error = this.creds.scrub(errMsg(e), refs);
            problems.push(`MCP server "${name}" failed to start: ${conn.error}`);
            log.warn("mcp", `${name}: ${conn.error}`);
          }
        }),
    );
    return problems;
  }

  private async connect(conn: Conn): Promise<void> {
    const client = new Client({ name: "persona-harness", version: "0.1.0" }, { capabilities: {} });
    const timeout = isHttpMcp(conn.cfg) ? 30_000 : 180_000; // npx/uvx installs can be slow on first run
    let transport: Transport;
    if (isHttpMcp(conn.cfg)) {
      const { url, headers } = httpMcpHeaders(conn.cfg, this.creds);
      try {
        transport = new StreamableHTTPClientTransport(url, { requestInit: { headers, redirect: "error" } });
        await withTimeout(client.connect(transport), timeout, "connect");
      } catch (e) {
        log.info("mcp", `${conn.name}: streamable HTTP failed (${errMsg(e)}), trying SSE`);
        transport = new SSEClientTransport(url, {
          requestInit: { headers, redirect: "error" },
          eventSourceInit: { fetch: (u, init) => fetch(u, { ...init, redirect: "error", headers: { ...headers, ...(init?.headers ?? {}) } }) },
        });
        await withTimeout(client.connect(transport), timeout, "connect");
      }
    } else {
      const env: Record<string, string> = {};
      for (const [k, v] of Object.entries(conn.cfg.env)) env[k] = this.renderPlaceholders(v);
      const args = this.runtime.execArgs(this.container, [conn.cfg.command, ...conn.cfg.args], {
        interactive: true,
        env,
        cwd: conn.cfg.cwd ?? this.workdir,
      });
      const stdio = new StdioClientTransport({ command: this.settings.runtime.binary, args, stderr: "pipe" });
      let stderrTail = "";
      stdio.stderr?.on("data", (c: Buffer) => (stderrTail = (stderrTail + c.toString("utf8")).slice(-2000)));
      transport = stdio;
      try {
        await withTimeout(client.connect(transport), timeout, "connect");
      } catch (e) {
        throw new Error(`${errMsg(e)}${stderrTail ? `\n${stderrTail.trim()}` : ""}`);
      }
    }
    conn.client = client;
    conn.error = null;
    client.onclose = () => {
      if (conn.client === client) {
        conn.client = null;
        conn.error = "disconnected";
      }
    };
  }

  /** Tool definitions, deterministic order (cache-friendly). */
  async tools(): Promise<ToolDef[]> {
    const out: ToolDef[] = [];
    for (const conn of [...this.conns.values()].sort((a, b) => a.name.localeCompare(b.name))) {
      if (!conn.client) continue;
      try {
        const listed: { name: string; description?: string; inputSchema: Record<string, unknown> }[] = [];
        let cursor: string | undefined;
        do {
          const page = await conn.client.listTools(cursor ? { cursor } : undefined);
          listed.push(...(page.tools as typeof listed));
          cursor = page.nextCursor;
        } while (cursor);
        for (const t of listed.sort((a, b) => a.name.localeCompare(b.name))) {
          const qualifiedName = `mcp__${sanitize(conn.name)}__${sanitize(t.name)}`.slice(0, 64);
          out.push(
            mcpTool({
              server: conn.name,
              qualifiedName,
              description: t.description ?? "",
              inputSchema: t.inputSchema ?? { type: "object" },
              call: (args, signal) => this.call(conn.name, t.name, args, signal),
            }),
          );
        }
      } catch (e) {
        log.warn("mcp", `${conn.name}: listTools failed: ${errMsg(e)}`);
      }
    }
    return out;
  }

  async call(server: string, tool: string, args: Record<string, unknown>, signal: AbortSignal): Promise<ToolOutput> {
    const conn = this.conns.get(server);
    if (!conn) return { text: `MCP server ${server} is not configured`, isError: true };
    if (!conn.client) {
      try {
        await this.connect(conn);
      } catch (e) {
        return { text: `MCP server ${server} is unavailable: ${this.creds.scrub(errMsg(e), conn.credentialRefs)}`, isError: true };
      }
    }
    try {
      const res = await conn.client!.callTool({ name: tool, arguments: args }, undefined, { signal, timeout: 600_000 });
      const texts: string[] = [];
      const images: { mediaType: string; data: string }[] = [];
      for (const c of (res.content ?? []) as Record<string, unknown>[]) {
        if (c.type === "text") texts.push(String(c.text));
        else if (c.type === "image") images.push({ mediaType: String(c.mimeType), data: String(c.data) });
        else if (c.type === "resource") {
          const r = c.resource as Record<string, unknown>;
          texts.push(typeof r.text === "string" ? `[resource ${r.uri}]\n${r.text}` : `[binary resource ${r.uri}]`);
        } else if (c.type === "resource_link") texts.push(`[resource link ${c.uri}] ${c.name ?? ""}`);
      }
      if (texts.length === 0 && res.structuredContent) texts.push(JSON.stringify(res.structuredContent, null, 2));
      return {
        text: truncateMiddle(this.creds.scrub(texts.join("\n"), conn.credentialRefs) || "(no content)", this.settings.toolOutputLimit),
        isError: !!res.isError,
        images: images.length ? images : undefined,
      };
    } catch (e) {
      return { text: `MCP call failed: ${this.creds.scrub(errMsg(e), conn.credentialRefs)}`, isError: true };
    }
  }

  /** Hot reload: reconnect http servers whose headers use a changed credential. */
  async onCredentialsChanged(refs: string[]): Promise<string[]> {
    const reconnected: string[] = [];
    for (const conn of this.conns.values()) {
      if (!isHttpMcp(conn.cfg) || !conn.credentialRefs.some((r) => refs.includes(r))) continue;
      try {
        await conn.client?.close();
      } catch {}
      conn.client = null;
      try {
        await this.connect(conn);
        reconnected.push(conn.name);
      } catch (e) {
        conn.error = errMsg(e);
      }
    }
    return reconnected;
  }

  async close(): Promise<void> {
    await Promise.all([...this.conns.values()].map((c) => c.client?.close().catch(() => {})));
    this.conns.clear();
  }
}

function withTimeout<T>(p: Promise<T>, ms: number, what: string): Promise<T> {
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error(`${what} timed out after ${ms / 1000}s`)), ms);
    p.then(
      (v) => (clearTimeout(t), resolve(v)),
      (e) => (clearTimeout(t), reject(e)),
    );
  });
}
