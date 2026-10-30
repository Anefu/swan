import { promises as fs } from "node:fs";
import path from "node:path";
import type { ApprovalBody, ChatItem, FolderMount, ServerEvent, SessionStatus, SessionSummary, ToolCallStatus, ToolSummary } from "@ph/shared";
import type { PersonaStore } from "../personas.js";
import type { EgressProxy } from "../proxy/egress.js";
import type { PodmanRuntime } from "../sandbox/podman.js";
import { SECRET_REF, type SecretStore } from "../secrets.js";
import { paths, type Settings } from "../settings.js";
import type { SkillRegistry } from "../skills.js";
import { debounce, errMsg, exists, log, nowIso, randomId, truncateMiddle, writeFileAtomic } from "../util.js";
import { SessionMcp } from "./mcp.js";
import { PermissionPolicy } from "./permissions.js";
import { ProviderError, type ContentBlockParam, type MessageParam, type ProviderRegistry, type ToolUse } from "./providers.js";
import { builtinTools, skillTool, type ToolContext, type ToolDef, type ToolOutput } from "./tools.js";

export interface SessionDeps {
  settings: Settings;
  runtime: PodmanRuntime;
  proxy: EgressProxy;
  secrets: SecretStore;
  personas: PersonaStore;
  skills: SkillRegistry;
  providers: ProviderRegistry;
  broadcast: (ev: ServerEvent) => void;
}

interface FrozenTool {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}

interface Persisted {
  version: 1;
  summary: SessionSummary;
  items: ChatItem[];
  messages: MessageParam[];
  // System prompt and tool definitions are fixed for the life of a session (prompt caching,
  // and thinking blocks are only valid against an unchanged prefix).
  frozen: { system: string; tools: FrozenTool[] } | null;
  sessionAllow: string[];
  placeholders: Record<string, string>; // secret name -> placeholder seen inside the sandbox
  proxyToken: string;
}

const MAX_TURNS_PER_MESSAGE = 200;
const DEFAULT_MAX_TOKENS = 64_000;

function systemPrompt(o: {
  name: string;
  instructions: string;
  folders: FolderMount[];
  workdir: string;
  allow: string[];
  credHosts: { name: string; hosts: string[] }[];
  skills: { name: string; description: string }[];
}): string {
  const lines: string[] = [];
  lines.push(`You are an autonomous agent working as the persona "${o.name}" inside persona-harness.`);
  if (o.instructions.trim()) lines.push("", o.instructions.trim());
  lines.push(
    "",
    "# Environment",
    "- Your tools run inside an isolated Linux container (Debian, user `agent`, no root). Only these folders from the user's machine are mounted:",
    ...(o.folders.length ? o.folders.map((f) => `  - ${f.mountPath} (${f.mode === "rw" ? "read-write" : "read-only"})`) : ["  - (none)"]),
    "  Files written anywhere else are lost when the session ends.",
    `- Working directory: ${o.workdir}`,
    `- Today's date: ${new Date().toISOString().slice(0, 10)}`,
    "- Network access goes through an egress proxy. Hosts outside the allowlist are blocked (HTTP 403 from the proxy); do not try to work around it. Tools must honour HTTPS_PROXY (curl, git, npm, pip, uv and Node do).",
    `- Allowed hosts: ${[...o.allow, ...o.credHosts.flatMap((c) => c.hosts)].join(", ") || "none"}`,
  );
  if (o.credHosts.length) {
    lines.push(
      "- Credentials: you never see real secret values. These environment variables hold placeholders that the proxy swaps for the real value only on requests to the listed hosts; use them exactly as you would the real thing (e.g. `curl -H \"Authorization: Bearer $GITHUB_TOKEN\" https://api.github.com/user`). Do not try to reveal, print or transform the real values.",
      ...o.credHosts.map((c) => `  - $${c.name} → ${c.hosts.join(", ") || "(not usable from the sandbox)"}`),
    );
  }
  lines.push("- Some tool calls require the user's approval. If a call is denied, adjust your plan instead of retrying the same call.");
  if (o.skills.length) {
    lines.push(
      "",
      "# Skills",
      "Skills are folders of instructions and scripts mounted read-only at /skills/<name>. When a task matches a skill, call load_skill with its name before starting, then follow it.",
      ...o.skills.map((s) => `- ${s.name}: ${s.description}`),
    );
  }
  return lines.join("\n");
}

export class Session {
  summary: SessionSummary;
  items: ChatItem[];
  private messages: MessageParam[];
  private frozen: Persisted["frozen"];
  private sessionAllow: string[];
  private placeholders: Record<string, string>;
  private proxyToken: string;

  private container: string | null = null;
  private mcp: SessionMcp | null = null;
  private liveTools = new Map<string, ToolDef>();
  private workdir = "/workspace";
  private starting: Promise<void> | null = null;
  private queue: string[] = [];
  private loopRunning = false;
  private abort: AbortController | null = null;
  private approvals = new Map<string, (d: ApprovalBody) => void>();
  private persistSoon = debounce(() => void this.persist(), 400);

  constructor(
    private deps: SessionDeps,
    data: Persisted,
  ) {
    this.summary = data.summary;
    this.items = data.items;
    this.messages = data.messages;
    this.frozen = data.frozen;
    this.sessionAllow = data.sessionAllow;
    this.placeholders = data.placeholders;
    this.proxyToken = data.proxyToken;
  }

  static create(deps: SessionDeps, personaId: string, title?: string): Session {
    const p = deps.personas.get(personaId);
    if (!p?.config) throw new Error(`persona "${personaId}" not found or invalid`);
    const model = p.config.model ?? deps.settings.defaultModel;
    const ts = nowIso();
    return new Session(deps, {
      version: 1,
      summary: {
        id: randomId("s", 6),
        personaId,
        title: title?.trim() || "New session",
        status: "stopped",
        createdAt: ts,
        updatedAt: ts,
        model: { provider: model.provider, id: model.id },
        usage: { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 },
      },
      items: [],
      messages: [],
      frozen: null,
      sessionAllow: [],
      placeholders: {},
      proxyToken: randomId("", 24),
    });
  }

  static async load(deps: SessionDeps, file: string): Promise<Session> {
    const data = JSON.parse(await fs.readFile(file, "utf8")) as Persisted;
    // Nothing survives a restart except the transcript; reopen as stopped.
    data.summary.status = "stopped";
    data.summary.statusDetail = undefined;
    for (const it of data.items) {
      if (it.kind === "tool_call" && (it.status === "running" || it.status === "pending_approval")) it.status = "interrupted";
      if ((it.kind === "assistant_text" || it.kind === "thinking") && it.streaming) it.streaming = false;
    }
    const s = new Session(deps, data);
    s.repairTranscript();
    return s;
  }

  get id() {
    return this.summary.id;
  }

  private get file() {
    return path.join(paths.sessions, `${this.id}.json`);
  }

  async persist(): Promise<void> {
    const data: Persisted = {
      version: 1,
      summary: this.summary,
      items: this.items,
      messages: this.messages,
      frozen: this.frozen,
      sessionAllow: this.sessionAllow,
      placeholders: this.placeholders,
      proxyToken: this.proxyToken,
    };
    try {
      await writeFileAtomic(this.file, JSON.stringify(data), 0o600);
    } catch (e) {
      log.error("session", `persist ${this.id}: ${errMsg(e)}`);
    }
  }

  async deleteFile() {
    if (await exists(this.file)) await fs.rm(this.file);
  }

  // ---------- events ----------

  private touch() {
    this.summary = { ...this.summary, updatedAt: nowIso() };
    this.deps.broadcast({ type: "session.updated", session: this.summary });
    this.persistSoon();
  }

  private setStatus(status: SessionStatus, detail?: string) {
    this.summary = { ...this.summary, status, statusDetail: detail };
    this.touch();
  }

  private refreshStatus() {
    if (this.approvals.size > 0) this.setStatus("awaiting_approval");
    else if (this.loopRunning && this.summary.status === "awaiting_approval") this.setStatus("running");
  }

  private addItem(item: ChatItem) {
    this.items.push(item);
    this.deps.broadcast({ type: "item.added", sessionId: this.id, item });
    this.persistSoon();
  }

  private updateItem(item: ChatItem) {
    this.deps.broadcast({ type: "item.updated", sessionId: this.id, item });
    this.persistSoon();
  }

  notice(level: "info" | "warn" | "error", text: string) {
    this.addItem({ kind: "notice", id: randomId("it_", 6), ts: nowIso(), level, text });
  }

  // ---------- lifecycle ----------

  private ensureStarted(): Promise<void> {
    if (this.container) return Promise.resolve();
    this.starting ??= this.start().finally(() => (this.starting = null));
    return this.starting;
  }

  private renderPlaceholders = (template: string) => template.replace(SECRET_REF, (_m, n: string) => this.placeholders[n] ?? "");

  private proxyRegistration() {
    const cfg = this.deps.personas.get(this.summary.personaId)?.config;
    const allowed = new Set(cfg?.credentials ?? []);
    const creds = Object.keys(this.placeholders).filter((c) => allowed.has(c));
    return {
      sessionId: this.id,
      personaId: this.summary.personaId,
      token: this.proxyToken,
      allowHosts: cfg?.network.allow ?? [],
      credentials: creds,
      placeholders: new Map(creds.map((c) => [this.placeholders[c], c] as const)),
    };
  }

  /** Persona edits (allowlist, credential list, permissions) apply to running sessions. */
  refreshPolicy() {
    if (this.container) this.deps.proxy.register(this.proxyRegistration());
  }

  private async start(): Promise<void> {
    const { personas, runtime, skills, secrets, settings } = this.deps;
    const persona = personas.get(this.summary.personaId);
    if (!persona?.config) throw new Error(`persona "${this.summary.personaId}" is missing or invalid`);
    if (persona.errors.length) throw new Error(`persona has problems: ${persona.errors.join("; ")}`);
    const cfg = persona.config;
    this.setStatus("starting", "starting sandbox container");

    for (const c of cfg.credentials) this.placeholders[c] ??= `phs_${c}_${randomId("", 8)}`;
    this.deps.proxy.register(this.proxyRegistration());

    this.workdir = cfg.sandbox.workdir ?? persona.folders[0]?.mountPath ?? "/workspace";
    const env: Record<string, string> = {};
    for (const c of cfg.credentials) env[c] = this.placeholders[c];
    for (const [k, v] of Object.entries(cfg.env)) env[k] = this.renderPlaceholders(v);
    const skillMounts = cfg.skills.flatMap((name) => {
      const s = skills.get(name);
      return s ? [{ name, hostPath: s.hostPath }] : [];
    });

    try {
      this.container = await runtime.startSession({
        sessionId: this.id,
        personaId: persona.id,
        image: cfg.sandbox.image,
        folders: persona.folders,
        skills: skillMounts,
        env,
        proxyUrl: runtime.proxyUrl(this.id, this.proxyToken),
        workdir: this.workdir,
        cpus: cfg.sandbox.cpus,
        memory: cfg.sandbox.memory,
        pidsLimit: cfg.sandbox.pidsLimit,
      });

      this.mcp = new SessionMcp(runtime, secrets, settings, this.container, this.workdir, this.renderPlaceholders);
      const problems = await this.mcp.start(cfg.mcpServers, (msg) => this.setStatus("starting", msg));
      for (const p of problems) this.notice("warn", p);
    } catch (e) {
      await this.teardown();
      throw e;
    }

    const tools = [...builtinTools(), ...(cfg.skills.length ? [skillTool()] : []), ...(await this.mcp.tools())];
    this.liveTools = new Map(tools.map((t) => [t.name, t]));

    if (!this.frozen) {
      this.frozen = {
        system: systemPrompt({
          name: cfg.name,
          instructions: cfg.instructions,
          folders: persona.folders,
          workdir: this.workdir,
          allow: cfg.network.allow,
          credHosts: cfg.credentials.map((name) => ({ name, hosts: secrets.get(name)?.hosts ?? [] })),
          skills: skillMounts.map((s) => ({ name: s.name, description: skills.get(s.name)?.description ?? "" })),
        }),
        tools: tools.map((t) => ({ name: t.name, description: t.description, inputSchema: t.inputSchema })),
      };
    } else {
      const frozenNames = new Set(this.frozen.tools.map((t) => t.name));
      const added = tools.filter((t) => !frozenNames.has(t.name)).map((t) => t.name);
      const gone = [...frozenNames].filter((n) => !this.liveTools.has(n));
      if (added.length || gone.length)
        this.notice("info", `Tools changed since this session began (${[...added.map((n) => `+${n}`), ...gone.map((n) => `-${n}`)].join(", ")}). The session keeps its original tool set; start a new session to use new tools.`);
    }
    const missing = cfg.credentials.filter((c) => !secrets.value(c));
    if (missing.length) this.notice("warn", `Missing credentials: ${missing.join(", ")}. Requests that need them will go out without auth until you add them (picked up live).`);
    this.setStatus("idle");
  }

  private async teardown() {
    await this.mcp?.close().catch(() => {});
    this.mcp = null;
    this.liveTools.clear();
    this.deps.proxy.unregister(this.id);
    if (this.container) await this.deps.runtime.stopSession(this.id).catch(() => {});
    this.container = null;
  }

  async stop(): Promise<void> {
    this.interrupt();
    this.queue = [];
    await this.teardown();
    this.setStatus("stopped");
    await this.persist();
  }

  /** Hot reload: notify the user, reconnect http MCP servers that use the changed secrets. */
  async onSecretsChanged(names: string[]) {
    const mine = names.filter((n) => n in this.placeholders);
    if (!mine.length || !this.container) return;
    const reconnected = (await this.mcp?.onSecretsChanged(mine)) ?? [];
    this.notice("info", `Credentials reloaded: ${mine.join(", ")} — applied to new requests immediately${reconnected.length ? `; reconnected MCP ${reconnected.join(", ")}` : ""}.`);
  }

  // ---------- conversation ----------

  async sendMessage(text: string) {
    if (!text.trim()) throw new Error("empty message");
    this.addItem({ kind: "user", id: randomId("it_", 6), ts: nowIso(), text });
    if (this.summary.title === "New session") this.summary = { ...this.summary, title: text.trim().replace(/\s+/g, " ").slice(0, 60) };
    this.queue.push(text);
    this.touch();
    if (!this.loopRunning) void this.runLoop();
  }

  interrupt() {
    this.abort?.abort();
    this.queue = [];
  }

  approve(toolUseId: string, body: ApprovalBody) {
    const resolve = this.approvals.get(toolUseId);
    if (!resolve) throw new Error("no pending approval for that tool call");
    resolve(body);
  }

  private async runLoop() {
    this.loopRunning = true;
    try {
      try {
        await this.ensureStarted();
      } catch (e) {
        this.queue = [];
        this.notice("error", `Could not start the session: ${errMsg(e)}`);
        this.setStatus("error", errMsg(e));
        return;
      }
      while (this.queue.length) {
        const text = this.queue.shift()!;
        this.messages.push({ role: "user", content: text });
        await this.agentTurns();
      }
      this.setStatus("idle");
    } catch (e) {
      const msg = e instanceof ProviderError ? e.message : `Agent loop error: ${errMsg(e)}`;
      log.error("session", `${this.id}: ${errMsg(e)}`);
      this.notice("error", msg);
      this.setStatus("error", msg);
    } finally {
      this.loopRunning = false;
      this.abort = null;
      await this.persist();
    }
  }

  private async agentTurns() {
    const ac = new AbortController();
    this.abort = ac;
    const persona = this.deps.personas.get(this.summary.personaId)?.config;
    const model = persona?.model ?? this.deps.settings.defaultModel;
    const frozen = this.frozen!;
    const toolDefs: ToolDef[] = frozen.tools.map((f) => {
      const live = this.liveTools.get(f.name);
      return live ? { ...live, description: f.description, inputSchema: f.inputSchema } : this.unavailableTool(f);
    });

    for (let turn = 0; turn < MAX_TURNS_PER_MESSAGE; turn++) {
      if (ac.signal.aborted) return;
      this.setStatus("running");
      const streaming = new Map<number, Extract<ChatItem, { kind: "assistant_text" | "thinking" }>>();
      const pendingKind = new Map<number, "text" | "thinking">();
      const finalizeStreams = () => {
        for (const it of streaming.values()) {
          if (it.streaming) {
            it.streaming = false;
            this.syncItem(it);
          }
        }
      };
      let result;
      try {
        result = await this.deps.providers.runTurn(
          this.summary.model.provider,
          {
            model: this.summary.model.id,
            system: frozen.system,
            tools: toolDefs,
            messages: this.messages,
            maxTokens: persona?.model?.maxTokens ?? DEFAULT_MAX_TOKENS,
            effort: persona?.model?.effort,
            signal: ac.signal,
          },
          {
            onBlockStart: (index, kind) => pendingKind.set(index, kind),
            onDelta: (index, kind, text) => {
              let it = streaming.get(index);
              if (!it) {
                const created: Extract<ChatItem, { kind: "assistant_text" | "thinking" }> = {
                  kind: (pendingKind.get(index) ?? kind) === "text" ? "assistant_text" : "thinking",
                  id: randomId("it_", 6),
                  ts: nowIso(),
                  text: "",
                  streaming: true,
                };
                streaming.set(index, created);
                this.addItem(created); // same object: later deltas keep this.items current for new subscribers
                it = created;
              }
              it.text += text;
              this.deps.broadcast({ type: "item.delta", sessionId: this.id, itemId: it.id, delta: text });
            },
            onBlockStop: (index) => {
              const it = streaming.get(index);
              if (it?.streaming) {
                it.streaming = false;
                this.syncItem(it);
              }
            },
          },
        );
      } catch (e) {
        finalizeStreams();
        if (ac.signal.aborted) {
          this.notice("info", "Interrupted.");
          return;
        }
        throw e;
      }
      finalizeStreams();

      const u = this.summary.usage;
      this.summary = {
        ...this.summary,
        usage: {
          inputTokens: u.inputTokens + result.usage.inputTokens,
          outputTokens: u.outputTokens + result.usage.outputTokens,
          cacheReadTokens: u.cacheReadTokens + result.usage.cacheReadTokens,
          cacheWriteTokens: u.cacheWriteTokens + result.usage.cacheWriteTokens,
        },
      };
      if (result.notice) this.notice(result.stopReason === "refusal" ? "warn" : "info", result.notice);
      // A refused or truncated tool turn is not appended, so the transcript stays valid.
      if (result.stopReason === "refusal") return;
      if (result.stopReason === "max_tokens" && result.toolUses.length) {
        this.notice("warn", "The model hit its output limit in the middle of a tool call, so the call was not run. Ask it to continue in smaller steps.");
        return;
      }
      this.messages.push({ role: "assistant", content: result.content });
      this.touch();
      if (result.stopReason === "pause_turn") continue;
      if (result.toolUses.length === 0) {
        if (result.stopReason === "max_tokens") this.notice("warn", "The reply was cut off at the output limit.");
        return;
      }
      const results = await this.runTools(result.toolUses, ac.signal);
      this.messages.push({ role: "user", content: results });
      this.touch();
      if (ac.signal.aborted) {
        this.notice("info", "Interrupted.");
        return;
      }
    }
    this.notice("warn", `Stopped after ${MAX_TURNS_PER_MESSAGE} model turns for one message.`);
  }

  /** Replace an item in this.items with the given version and broadcast it. */
  private syncItem(it: ChatItem) {
    const idx = this.items.findIndex((x) => x.id === it.id);
    if (idx >= 0 && this.items[idx] !== it) this.items[idx] = { ...it };
    this.updateItem(it);
  }

  private unavailableTool(f: FrozenTool): ToolDef {
    return {
      ...f,
      source: f.name.startsWith("mcp__") ? "mcp" : "builtin",
      validate: (input) => ({ ok: true, value: (input ?? {}) as Record<string, unknown> }),
      preview: (i) => JSON.stringify(i).slice(0, 100),
      run: async () => ({ text: `Tool ${f.name} is not available in this session right now (its MCP server is not running).`, isError: true }),
    };
  }

  private toolCtx(signal: AbortSignal): ToolContext {
    const cfg = this.deps.personas.get(this.summary.personaId)?.config;
    return {
      runtime: this.deps.runtime,
      container: this.container!,
      workdir: this.workdir,
      signal,
      outputLimit: this.deps.settings.toolOutputLimit,
      bashTimeoutMs: this.deps.settings.bashTimeoutMs,
      skills: this.deps.skills,
      personaSkills: cfg?.skills ?? [],
    };
  }

  private runTools(toolUses: ToolUse[], signal: AbortSignal) {
    const cfg = this.deps.personas.get(this.summary.personaId)?.config;
    const policy = new PermissionPolicy(cfg?.permissions ?? { default: "ask", allow: [], ask: [], deny: [] }, this.sessionAllow);
    return Promise.all(toolUses.map((tu) => this.runOne(tu, policy, signal)));
  }

  private async runOne(tu: ToolUse, policy: PermissionPolicy, signal: AbortSignal): Promise<ContentBlockParam> {
    const frozenDef = this.frozen?.tools.find((t) => t.name === tu.name);
    const tool = this.liveTools.get(tu.name) ?? (frozenDef ? this.unavailableTool(frozenDef) : undefined);
    const item: Extract<ChatItem, { kind: "tool_call" }> = {
      kind: "tool_call",
      id: tu.id,
      ts: nowIso(),
      name: tu.name,
      source: tool?.source ?? (tu.name.startsWith("mcp__") ? "mcp" : "builtin"),
      input: tu.input,
      inputPreview: "",
      status: "running",
    };
    let added = false;
    const show = () => {
      if (added) this.syncItem(item);
      else {
        added = true;
        this.addItem({ ...item });
      }
    };
    const finish = (status: ToolCallStatus, out: ToolOutput, extra: Partial<typeof item> = {}): ContentBlockParam => {
      Object.assign(item, extra, {
        status,
        output: out.text + (out.images?.length ? `\n[${out.images.length} image(s)]` : ""),
        isError: !!out.isError,
      });
      show();
      return {
        type: "tool_result",
        tool_use_id: tu.id,
        is_error: out.isError || undefined,
        content: out.images?.length
          ? [{ type: "text", text: out.text }, ...out.images.map((img) => ({ type: "image" as const, source: { type: "base64" as const, media_type: img.mediaType as "image/png", data: img.data } }))]
          : out.text,
      };
    };

    if (!tool) return finish("error", { text: `Unknown tool "${tu.name}".`, isError: true });
    if (tu.invalid !== undefined) return finish("error", { text: JSON.stringify({ INVALID_JSON: tu.invalid }), isError: true });
    const v = tool.validate(tu.input);
    if (!v.ok) return finish("error", { text: `Invalid input: ${v.error}`, isError: true });
    item.inputPreview = tool.preview(v.value);

    const perm = policy.evaluate(tool, v.value);
    if (perm.mode === "deny") return finish("denied", { text: `Denied by the persona's permission policy (${perm.rule}).`, isError: true }, { denyReason: perm.rule });
    if (perm.mode === "ask") {
      item.status = "pending_approval";
      item.approvalReason = perm.rule;
      show();
      const decision = await this.waitForApproval(tu.id, signal);
      this.refreshStatus();
      if (!decision) return finish("interrupted", { text: "Interrupted by the user before approval.", isError: true });
      if (decision.decision === "deny") {
        const why = decision.reason?.trim();
        return finish("denied", { text: `The user denied this tool call${why ? `: ${why}` : "."}`, isError: true }, { denyReason: why || "denied by user" });
      }
      if (decision.decision === "allow_always") this.sessionAllow.push(PermissionPolicy.alwaysAllowRule(tool, v.value));
      item.status = "running";
      item.approvalReason = undefined;
    }
    show();

    const started = Date.now();
    let out: ToolOutput;
    try {
      out = await tool.run(v.value, this.toolCtx(signal));
    } catch (e) {
      out = { text: `Tool failed: ${errMsg(e)}`, isError: true };
    }
    const durationMs = Date.now() - started;
    if (signal.aborted) return finish("interrupted", { text: truncateMiddle(`${out.text}\n[interrupted by the user]`, this.deps.settings.toolOutputLimit), isError: true }, { durationMs });
    return finish(out.isError ? "error" : "done", out, { durationMs });
  }

  private waitForApproval(id: string, signal: AbortSignal): Promise<ApprovalBody | null> {
    return new Promise((resolve) => {
      if (signal.aborted) return resolve(null);
      const onAbort = () => {
        this.approvals.delete(id);
        this.refreshStatus();
        resolve(null);
      };
      signal.addEventListener("abort", onAbort, { once: true });
      this.approvals.set(id, (d) => {
        signal.removeEventListener("abort", onAbort);
        this.approvals.delete(id);
        resolve(d);
      });
      this.refreshStatus();
    });
  }

  /**
   * After a crash mid-turn the transcript can end with tool_use blocks that never got results.
   * Append (never rewrite) the missing results so the next request is valid.
   */
  private repairTranscript() {
    const last = this.messages.at(-1);
    if (!last || last.role !== "assistant" || typeof last.content === "string") return;
    const open = last.content.filter((b) => b.type === "tool_use").map((b) => (b as { id: string }).id);
    if (!open.length) return;
    this.messages.push({
      role: "user",
      content: open.map((id) => ({ type: "tool_result" as const, tool_use_id: id, is_error: true, content: "The harness restarted before this tool call finished." })),
    });
  }

  // ---------- views ----------

  tools(): ToolSummary[] {
    const cfg = this.deps.personas.get(this.summary.personaId)?.config;
    const policy = new PermissionPolicy(cfg?.permissions ?? { default: "ask", allow: [], ask: [], deny: [] }, this.sessionAllow);
    const defs = this.liveTools.size ? [...this.liveTools.values()] : [...builtinTools(), ...(cfg?.skills.length ? [skillTool()] : [])];
    return defs.map((t) => ({ name: t.name, source: t.source, server: t.server, description: t.description, permission: policy.describe(t) }));
  }

  get isActive() {
    return this.container !== null;
  }
}

export class SessionManager {
  private sessions = new Map<string, Session>();
  constructor(private deps: SessionDeps) {}

  async loadAll() {
    for (const f of await fs.readdir(paths.sessions)) {
      if (!f.endsWith(".json")) continue;
      try {
        const s = await Session.load(this.deps, path.join(paths.sessions, f));
        this.sessions.set(s.id, s);
      } catch (e) {
        log.warn("sessions", `skipping ${f}: ${errMsg(e)}`);
      }
    }
  }

  create(personaId: string, title?: string) {
    const s = Session.create(this.deps, personaId, title);
    this.sessions.set(s.id, s);
    void s.persist();
    this.deps.broadcast({ type: "session.updated", session: s.summary });
    return s;
  }

  get(id: string) {
    return this.sessions.get(id);
  }

  list(personaId?: string) {
    return [...this.sessions.values()]
      .filter((s) => !personaId || s.summary.personaId === personaId)
      .map((s) => s.summary)
      .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  }

  async remove(id: string) {
    const s = this.sessions.get(id);
    if (!s) return;
    await s.stop();
    await s.deleteFile();
    this.sessions.delete(id);
    this.deps.broadcast({ type: "session.deleted", sessionId: id });
  }

  onSecretsChanged(names: string[]) {
    for (const s of this.sessions.values()) void s.onSecretsChanged(names);
  }

  onPersonasChanged() {
    for (const s of this.sessions.values()) s.refreshPolicy();
  }

  async shutdown() {
    await Promise.all([...this.sessions.values()].filter((s) => s.isActive).map((s) => s.stop()));
  }
}
