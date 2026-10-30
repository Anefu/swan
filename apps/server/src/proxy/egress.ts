import { timingSafeEqual } from "node:crypto";
import dns from "node:dns/promises";
import { promises as fs } from "node:fs";
import http from "node:http";
import https from "node:https";
import net from "node:net";
import path from "node:path";
import { Transform, type TransformCallback } from "node:stream";
import tls from "node:tls";
import type { EgressEvent } from "@ph/shared";
import type { SecretStore } from "../secrets.js";
import { paths } from "../settings.js";
import { TypedEmitter, errMsg, hostMatches, hostMatchesAny, log, nowIso, randomId } from "../util.js";
import type { CertAuthority } from "./ca.js";

/** What the proxy knows about a running session. Registered by the session, never by the sandbox. */
export interface ProxySession {
  sessionId: string;
  personaId: string;
  token: string;
  allowHosts: string[];
  credentials: string[]; // secret names the persona may use
  placeholders: Map<string, string>; // placeholder -> secret name
}

const ALLOWED_PORTS = new Set([80, 443]);
const HOP_BY_HOP = new Set([
  "connection",
  "proxy-connection",
  "keep-alive",
  "proxy-authorization",
  "proxy-authenticate",
  "te",
  "trailer",
  "transfer-encoding",
  "upgrade",
]);

// Destinations the sandbox must never reach through the proxy: the harness itself (loopback),
// the LAN, link-local/metadata, CGNAT (Tailscale), multicast and reserved space.
const PRIVATE = new net.BlockList();
for (const [a, p] of [
  ["0.0.0.0", 8], ["10.0.0.0", 8], ["100.64.0.0", 10], ["127.0.0.0", 8], ["169.254.0.0", 16],
  ["172.16.0.0", 12], ["192.0.0.0", 24], ["192.168.0.0", 16], ["198.18.0.0", 15], ["224.0.0.0", 4], ["240.0.0.0", 4],
] as const) PRIVATE.addSubnet(a, p, "ipv4");
for (const [a, p] of [["::", 128], ["::1", 128], ["fc00::", 7], ["fe80::", 10], ["ff00::", 8], ["64:ff9b::", 96]] as const)
  PRIVATE.addSubnet(a, p, "ipv6");

export function isPrivateAddress(ip: string): boolean {
  const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/i.exec(ip);
  if (mapped) return PRIVATE.check(mapped[1], "ipv4");
  return PRIVATE.check(ip, net.isIPv6(ip) ? "ipv6" : "ipv4");
}

/** Resolve once and pin the address, so a DNS answer cannot change between check and connect. */
async function resolvePublic(host: string): Promise<string> {
  if (host === "localhost" || host.endsWith(".localhost") || host.endsWith(".internal") || host.endsWith(".local"))
    throw new Error("local hostnames are not reachable from the sandbox");
  const addrs = net.isIP(host) ? [{ address: host }] : await dns.lookup(host, { all: true, verbatim: true });
  if (addrs.length === 0) throw new Error("no address");
  for (const a of addrs) if (isPrivateAddress(a.address)) throw new Error(`${host} resolves to private address ${a.address}`);
  return addrs[0].address;
}

function splitHostPort(s: string, defPort: number): { host: string; port: number } {
  const m = /^\[([^\]]+)\](?::(\d+))?$/.exec(s) ?? /^([^:]+)(?::(\d+))?$/.exec(s);
  if (!m) throw new Error("bad authority");
  return { host: m[1].toLowerCase(), port: m[2] ? Number(m[2]) : defPort };
}

/** Streams a body through, rewriting real secret values back to placeholders. */
class Redactor extends Transform {
  private pending: Buffer = Buffer.alloc(0);
  private keep: number;
  constructor(private pairs: { secret: Buffer; placeholder: Buffer }[]) {
    super();
    this.keep = Math.max(0, ...pairs.map((p) => p.secret.length - 1));
  }
  private replaceAll(buf: Buffer): Buffer {
    for (const { secret, placeholder } of this.pairs) {
      let idx = buf.indexOf(secret);
      if (idx === -1) continue;
      const parts: Buffer[] = [];
      let from = 0;
      while (idx !== -1) {
        parts.push(buf.subarray(from, idx), placeholder);
        from = idx + secret.length;
        idx = buf.indexOf(secret, from);
      }
      parts.push(buf.subarray(from));
      buf = Buffer.concat(parts);
    }
    return buf;
  }
  _transform(chunk: Buffer, _enc: BufferEncoding, cb: TransformCallback) {
    const data = this.replaceAll(Buffer.concat([this.pending, chunk]));
    const cut = Math.max(0, data.length - this.keep);
    this.pending = data.subarray(cut);
    cb(null, data.subarray(0, cut));
  }
  _flush(cb: TransformCallback) {
    cb(null, this.replaceAll(this.pending));
  }
}

interface MitmContext {
  session: ProxySession;
  host: string;
  port: number;
  ip: string;
  creds: string[]; // session credentials bound to this host
}

type Events = { event: [EgressEvent] };

export class EgressProxy extends TypedEmitter<Events> {
  private sessions = new Map<string, ProxySession>();
  private recent: EgressEvent[] = [];
  private server = http.createServer();
  private mitm = http.createServer();
  private mitmCtx = new WeakMap<net.Socket, MitmContext>();
  private upstreamAgent = new https.Agent({ keepAlive: true, maxSockets: 64 });

  constructor(
    private secrets: SecretStore,
    private ca: CertAuthority,
  ) {
    super();
    this.server.on("connect", (req, socket: net.Socket, head) => void this.onConnect(req, socket, head));
    this.server.on("request", (req, res) => void this.onPlainHttp(req, res));
    this.server.on("clientError", (_e, socket) => socket.destroy());
    this.mitm.on("request", (req, res) => void this.onMitmRequest(req, res));
    this.mitm.on("upgrade", (req, socket: net.Socket, head) => void this.onMitmUpgrade(req, socket, head));
    this.mitm.on("clientError", (_e, socket) => socket.destroy());
  }

  async listen(port: number): Promise<void> {
    // Restore recent history from today's audit log so the UI survives restarts.
    try {
      const file = path.join(paths.audit, `egress-${nowIso().slice(0, 10)}.jsonl`);
      const lines = (await fs.readFile(file, "utf8")).trim().split("\n").slice(-2000);
      this.recent = lines.flatMap((l) => {
        try {
          return [JSON.parse(l) as EgressEvent];
        } catch {
          return [];
        }
      });
    } catch {}
    return new Promise((resolve, reject) => {
      this.server.once("error", reject);
      this.server.listen(port, "127.0.0.1", () => {
        log.info("proxy", `egress proxy on 127.0.0.1:${port}`);
        resolve();
      });
    });
  }

  register(s: ProxySession) {
    this.sessions.set(s.sessionId, s);
  }
  unregister(sessionId: string) {
    this.sessions.delete(sessionId);
  }

  events(sessionId?: string, limit = 200): EgressEvent[] {
    const list = sessionId ? this.recent.filter((e) => e.sessionId === sessionId) : this.recent;
    return list.slice(-limit);
  }

  private record(e: Omit<EgressEvent, "id" | "ts">) {
    const ev: EgressEvent = { id: randomId("eg_", 6), ts: nowIso(), ...e };
    this.recent.push(ev);
    if (this.recent.length > 5000) this.recent.splice(0, this.recent.length - 5000);
    this.emit("event", ev);
    const file = path.join(paths.audit, `egress-${ev.ts.slice(0, 10)}.jsonl`);
    fs.appendFile(file, JSON.stringify(ev) + "\n", { mode: 0o600 }).catch(() => {});
  }

  private authenticate(req: http.IncomingMessage): ProxySession | null {
    const h = req.headers["proxy-authorization"];
    if (!h || !h.startsWith("Basic ")) return null;
    const [sid, token] = Buffer.from(h.slice(6), "base64").toString("utf8").split(":", 2);
    const s = this.sessions.get(sid ?? "");
    if (!s || !token) return null;
    const a = Buffer.from(token);
    const b = Buffer.from(s.token);
    return a.length === b.length && timingSafeEqual(a, b) ? s : null;
  }

  /** Credentials of this session whose host bindings cover `host`. Read live, so edits apply now. */
  private credsFor(s: ProxySession, host: string): string[] {
    return s.credentials.filter((name) => {
      const e = this.secrets.get(name);
      return !!e?.value && e.hosts.some((p) => hostMatches(host, p));
    });
  }

  /**
   * Called for a public host on 80/443 that is not on the allowlist. Resolves to true when the
   * person allowed it (the session re-registers with the host added before resolving).
   */
  asker: ((s: ProxySession, host: string, port: number) => Promise<boolean>) | null = null;

  /** decide(), but an unlisted public host waits for the person instead of failing outright. */
  private async decideOrAsk(s: ProxySession, host: string, port: number): Promise<{ ok: true; creds: string[] } | { ok: false; reason: string }> {
    const d = this.decide(s, host, port);
    if (d.ok || d.reason !== "host not in persona allowlist" || !this.asker) return d;
    try {
      await resolvePublic(host); // never offer private or local destinations
    } catch (e) {
      return { ok: false, reason: errMsg(e) };
    }
    if (!(await this.asker(s, host, port))) return { ok: false, reason: "denied by the user" };
    return this.decide(this.sessions.get(s.sessionId) ?? s, host, port);
  }

  private decide(s: ProxySession, host: string, port: number): { ok: true; creds: string[] } | { ok: false; reason: string } {
    if (!ALLOWED_PORTS.has(port)) {
      // Other ports only by an explicit host:port entry; always tunnelled, never credentialed.
      if (s.allowHosts.some((p) => p.includes(":") && hostMatches(host, p.split(":")[0]) && Number(p.split(":")[1]) === port)) return { ok: true, creds: [] };
      return { ok: false, reason: `port ${port} not allowed` };
    }
    const creds = this.credsFor(s, host);
    if (creds.length === 0 && !hostMatchesAny(host, s.allowHosts)) return { ok: false, reason: "host not in persona allowlist" };
    return { ok: true, creds };
  }

  private async onConnect(req: http.IncomingMessage, client: net.Socket, head: Buffer) {
    client.on("error", () => {});
    const started = Date.now();
    const session = this.authenticate(req);
    let host = "?";
    let port = 0;
    try {
      ({ host, port } = splitHostPort(req.url ?? "", 443));
    } catch {
      client.end("HTTP/1.1 400 Bad Request\r\n\r\n");
      return;
    }
    if (!session) {
      client.end('HTTP/1.1 407 Proxy Authentication Required\r\nProxy-Authenticate: Basic realm="persona-harness"\r\n\r\n');
      this.record({ sessionId: null, personaId: null, method: "CONNECT", host, port, decision: "blocked", credentials: [], reason: "missing or invalid proxy credentials" });
      return;
    }
    const base = { sessionId: session.sessionId, personaId: session.personaId, method: "CONNECT", host, port };
    const d = await this.decideOrAsk(session, host, port);
    if (!d.ok) {
      client.end(`HTTP/1.1 403 Forbidden\r\nX-PH-Reason: ${d.reason}\r\n\r\n`);
      this.record({ ...base, decision: "blocked", credentials: [], reason: d.reason });
      return;
    }
    let ip: string;
    try {
      ip = await resolvePublic(host);
    } catch (e) {
      client.end("HTTP/1.1 403 Forbidden\r\n\r\n");
      this.record({ ...base, decision: "blocked", credentials: [], reason: errMsg(e) });
      return;
    }

    if (d.creds.length > 0) {
      // Terminate TLS so credentials can be substituted; requests are audited individually.
      client.write("HTTP/1.1 200 Connection Established\r\n\r\n");
      if (head.length) client.unshift(head);
      const tlsSock = new tls.TLSSocket(client, {
        isServer: true,
        secureContext: this.ca.contextFor(host),
        ALPNProtocols: ["http/1.1"],
      });
      tlsSock.on("error", () => client.destroy());
      this.mitmCtx.set(tlsSock, { session, host, port, ip, creds: d.creds });
      this.mitm.emit("connection", tlsSock);
      return;
    }

    // No credentials for this host: blind tunnel, no interception.
    const upstream = net.connect({ host: ip, port });
    let up = 0;
    let down = 0;
    upstream.on("connect", () => {
      client.write("HTTP/1.1 200 Connection Established\r\n\r\n");
      if (head.length) upstream.write(head);
      client.on("data", (c: Buffer) => (up += c.length));
      upstream.on("data", (c: Buffer) => (down += c.length));
      client.pipe(upstream);
      upstream.pipe(client);
    });
    let done = false;
    const finish = (err?: Error) => {
      if (done) return;
      done = true;
      client.destroy();
      upstream.destroy();
      this.record({ ...base, decision: "tunneled", credentials: [], durationMs: Date.now() - started, bytesUp: up, bytesDown: down, reason: err ? errMsg(err) : undefined });
    };
    upstream.on("error", finish);
    upstream.on("close", () => finish());
    client.on("close", () => finish());
  }

  /** Replace this session's placeholders for credentials bound to the host. */
  private substitute(value: string, ctx: MitmContext, used: Set<string>): string {
    for (const [ph, name] of ctx.session.placeholders) {
      if (!value.includes(ph) || !ctx.creds.includes(name)) continue;
      const real = this.secrets.value(name);
      if (real === undefined) continue;
      value = value.split(ph).join(real);
      used.add(name);
    }
    return value;
  }

  private buildUpstreamHeaders(req: http.IncomingMessage, ctx: MitmContext, used: Set<string>): http.OutgoingHttpHeaders {
    const out: http.OutgoingHttpHeaders = {};
    for (const [k, v] of Object.entries(req.headers)) {
      if (v === undefined || HOP_BY_HOP.has(k)) continue;
      const vals = Array.isArray(v) ? v : [v];
      const mapped = vals.map((val) => {
        if (k === "authorization" && /^basic /i.test(val)) {
          const decoded = Buffer.from(val.slice(6).trim(), "base64").toString("utf8");
          const sub = this.substitute(decoded, ctx, used);
          return sub === decoded ? val : `Basic ${Buffer.from(sub, "utf8").toString("base64")}`;
        }
        return this.substitute(val, ctx, used);
      });
      out[k] = Array.isArray(v) ? mapped : mapped[0];
    }
    for (const name of ctx.creds) {
      const e = this.secrets.get(name);
      if (!e?.inject || !e.value) continue;
      const key = e.inject.header.toLowerCase();
      if (out[key] === undefined) {
        out[key] = e.inject.format.split("{value}").join(e.value);
        used.add(name);
      }
    }
    out.host = ctx.port === 443 ? ctx.host : `${ctx.host}:${ctx.port}`;
    out["accept-encoding"] = "identity"; // so responses can be scanned for leaked values
    return out;
  }

  private upstreamOptions(ctx: MitmContext, req: http.IncomingMessage, headers: http.OutgoingHttpHeaders, pathAndQuery: string): https.RequestOptions {
    return {
      host: ctx.ip,
      port: ctx.port,
      servername: net.isIP(ctx.host) ? undefined : ctx.host,
      method: req.method,
      path: pathAndQuery,
      headers,
      agent: this.upstreamAgent,
      checkServerIdentity: (_h, cert) => tls.checkServerIdentity(ctx.host, cert),
      timeout: 300_000,
    };
  }

  private redactor(ctx: MitmContext): Redactor | null {
    const pairs: { secret: Buffer; placeholder: Buffer }[] = [];
    for (const [ph, name] of ctx.session.placeholders) {
      const v = this.secrets.value(name);
      if (v && v.length >= 6) pairs.push({ secret: Buffer.from(v), placeholder: Buffer.from(ph) });
    }
    return pairs.length ? new Redactor(pairs) : null;
  }

  private async onMitmRequest(req: http.IncomingMessage, res: http.ServerResponse) {
    const ctx = this.mitmCtx.get(req.socket);
    if (!ctx) {
      res.writeHead(500).end();
      return;
    }
    const started = Date.now();
    const used = new Set<string>();
    const rawPath = req.url ?? "/";
    const hostHeader = (req.headers.host ?? ctx.host).toLowerCase().replace(/:443$/, "");
    const base = { sessionId: ctx.session.sessionId, personaId: ctx.session.personaId, method: req.method ?? "GET", host: ctx.host, port: ctx.port, path: rawPath.split("?")[0] };
    if (hostHeader !== ctx.host && hostHeader !== `${ctx.host}:${ctx.port}`) {
      res.writeHead(421, { "content-type": "text/plain" }).end("Host header does not match CONNECT target\n");
      this.record({ ...base, decision: "blocked", credentials: [], reason: `Host header ${hostHeader} != ${ctx.host}` });
      return;
    }
    const headers = this.buildUpstreamHeaders(req, ctx, used);
    const pathAndQuery = this.substitute(rawPath, ctx, used);
    const body = await this.substitutedBody(req, ctx, used, headers);
    let bytesUp = 0;
    let bytesDown = 0;
    req.on("data", (c: Buffer) => (bytesUp += c.length));

    const upstream = https.request(this.upstreamOptions(ctx, req, headers, pathAndQuery), (up) => {
      const respHeaders: http.OutgoingHttpHeaders = {};
      for (const [k, v] of Object.entries(up.headers)) if (v !== undefined && !HOP_BY_HOP.has(k)) respHeaders[k] = v;
      const ct = String(up.headers["content-type"] ?? "");
      const textual = !ct || /json|text|xml|javascript|form-urlencoded|event-stream|graphql/i.test(ct);
      const red = textual && !up.headers["content-encoding"] ? this.redactor(ctx) : null;
      if (red) delete respHeaders["content-length"];
      res.writeHead(up.statusCode ?? 502, up.statusMessage, respHeaders);
      up.on("data", (c: Buffer) => (bytesDown += c.length));
      (red ? up.pipe(red) : up).pipe(res);
      up.on("end", () =>
        this.record({ ...base, status: up.statusCode, decision: used.size ? "injected" : "inspected", credentials: [...used], durationMs: Date.now() - started, bytesUp, bytesDown }),
      );
    });
    upstream.on("timeout", () => upstream.destroy(new Error("upstream timeout")));
    upstream.on("error", (e) => {
      if (!res.headersSent) res.writeHead(502, { "content-type": "text/plain" }).end(`upstream error: ${errMsg(e)}\n`);
      else res.destroy();
      this.record({ ...base, status: 502, decision: used.size ? "injected" : "inspected", credentials: [...used], reason: errMsg(e), durationMs: Date.now() - started });
    });
    if (body) upstream.end(body);
    else req.pipe(upstream);
  }

  /**
   * Opt-in (per credential, substituteInBody) placeholder swap in JSON or form bodies up to 1 MB with
   * a declared length. Anything else streams through untouched.
   */
  private async substitutedBody(req: http.IncomingMessage, ctx: MitmContext, used: Set<string>, headers: http.OutgoingHttpHeaders): Promise<Buffer | null> {
    const opted = ctx.creds.filter((n) => this.secrets.get(n)?.substituteInBody);
    const len = Number(req.headers["content-length"] ?? NaN);
    const ct = String(req.headers["content-type"] ?? "");
    if (!opted.length || !Number.isFinite(len) || len > 1_000_000 || !/json|x-www-form-urlencoded/i.test(ct) || req.headers["content-encoding"]) return null;
    const chunks: Buffer[] = [];
    for await (const c of req) chunks.push(c as Buffer);
    let text = Buffer.concat(chunks).toString("utf8");
    for (const [ph, name] of ctx.session.placeholders) {
      if (!opted.includes(name) || !text.includes(ph)) continue;
      const real = this.secrets.value(name);
      if (real === undefined) continue;
      text = text.split(ph).join(/json/i.test(ct) ? JSON.stringify(real).slice(1, -1) : encodeURIComponent(real));
      used.add(name);
    }
    const out = Buffer.from(text, "utf8");
    headers["content-length"] = String(out.length);
    return out;
  }


  private onMitmUpgrade(req: http.IncomingMessage, socket: net.Socket, head: Buffer) {
    const ctx = this.mitmCtx.get(socket);
    if (!ctx) return socket.destroy();
    const used = new Set<string>();
    const headers = this.buildUpstreamHeaders(req, ctx, used);
    headers.connection = "Upgrade";
    headers.upgrade = req.headers.upgrade;
    const upstream = https.request({ ...this.upstreamOptions(ctx, req, headers, this.substitute(req.url ?? "/", ctx, used)), agent: false });
    upstream.on("upgrade", (up, upSocket, upHead) => {
      const lines = [`HTTP/1.1 ${up.statusCode} ${up.statusMessage}`];
      for (let i = 0; i < up.rawHeaders.length; i += 2) lines.push(`${up.rawHeaders[i]}: ${up.rawHeaders[i + 1]}`);
      socket.write(lines.join("\r\n") + "\r\n\r\n");
      if (upHead.length) socket.write(upHead);
      if (head.length) upSocket.write(head);
      upSocket.pipe(socket).pipe(upSocket);
      upSocket.on("error", () => socket.destroy());
      socket.on("error", () => upSocket.destroy());
      this.record({ sessionId: ctx.session.sessionId, personaId: ctx.session.personaId, method: "UPGRADE", host: ctx.host, port: ctx.port, path: (req.url ?? "/").split("?")[0], status: up.statusCode, decision: used.size ? "injected" : "inspected", credentials: [...used] });
    });
    upstream.on("response", (r) => {
      socket.end(`HTTP/1.1 ${r.statusCode} ${r.statusMessage}\r\n\r\n`);
    });
    upstream.on("error", () => socket.destroy());
    upstream.end();
  }

  /** Absolute-URI requests (plain http:// through the proxy). Never carries credentials. */
  private async onPlainHttp(req: http.IncomingMessage, res: http.ServerResponse) {
    const started = Date.now();
    const session = this.authenticate(req);
    let url: URL;
    try {
      url = new URL(req.url ?? "");
      if (url.protocol !== "http:") throw new Error();
    } catch {
      res.writeHead(400, { "content-type": "text/plain" }).end("persona-harness egress proxy: absolute http:// URL required\n");
      return;
    }
    const host = url.hostname.toLowerCase().replace(/^\[|\]$/g, "");
    const port = Number(url.port || 80);
    if (!session) {
      res.writeHead(407, { "proxy-authenticate": 'Basic realm="persona-harness"' }).end();
      this.record({ sessionId: null, personaId: null, method: req.method ?? "GET", host, port, path: url.pathname, decision: "blocked", credentials: [], reason: "missing or invalid proxy credentials" });
      return;
    }
    const base = { sessionId: session.sessionId, personaId: session.personaId, method: req.method ?? "GET", host, port, path: url.pathname };
    const d = await this.decideOrAsk(session, host, port);
    const reason = !d.ok ? d.reason : d.creds.length ? "credential hosts require https" : null;
    if (reason) {
      res.writeHead(403, { "content-type": "text/plain" }).end(`blocked: ${reason}\n`);
      this.record({ ...base, decision: "blocked", credentials: [], reason });
      return;
    }
    let ip: string;
    try {
      ip = await resolvePublic(host);
    } catch (e) {
      res.writeHead(403, { "content-type": "text/plain" }).end(`blocked: ${errMsg(e)}\n`);
      this.record({ ...base, decision: "blocked", credentials: [], reason: errMsg(e) });
      return;
    }
    const headers: http.OutgoingHttpHeaders = {};
    for (const [k, v] of Object.entries(req.headers)) if (v !== undefined && !HOP_BY_HOP.has(k)) headers[k] = v;
    const upstream = http.request({ host: ip, port, method: req.method, path: url.pathname + url.search, headers: { ...headers, host: url.host } }, (up) => {
      const h: http.OutgoingHttpHeaders = {};
      for (const [k, v] of Object.entries(up.headers)) if (v !== undefined && !HOP_BY_HOP.has(k)) h[k] = v;
      res.writeHead(up.statusCode ?? 502, h);
      up.pipe(res);
      up.on("end", () => this.record({ ...base, status: up.statusCode, decision: "inspected", credentials: [], durationMs: Date.now() - started }));
    });
    upstream.on("error", (e) => {
      if (!res.headersSent) res.writeHead(502).end();
      this.record({ ...base, status: 502, decision: "inspected", credentials: [], reason: errMsg(e) });
    });
    req.pipe(upstream);
  }
}
