import { promises as fs } from "node:fs";
import path from "node:path";
import type { ApprovalBody, ChatItem, Checkpoint, FolderMount, PendingApproval, ServerEvent, SessionStatus, SessionSummary, SlashCommand, ToolCallStatus, ToolSummary } from "@ph/shared";
import type { MemoryStore } from "../memory.js";
import type { PersonaStore } from "../personas.js";
import type { EgressProxy } from "../proxy/egress.js";
import type { PodmanRuntime } from "../sandbox/podman.js";
import { SECRET_REF, type SecretStore } from "../secrets.js";
import { paths, type Settings } from "../settings.js";
import type { SkillRegistry } from "../skills.js";
import type { UsageLedger, UsagePurpose } from "../usage.js";
import { debounce, errMsg, exists, log, nowIso, randomId, truncateMiddle, writeFileAtomic } from "../util.js";
import { SessionMcp } from "./mcp.js";
import { MEMORY_READ_TOOLS, memoryTools } from "./memory-tools.js";
import { PermissionPolicy } from "./permissions.js";
import { ProviderError, type ContentBlockParam, type MessageParam, type ProviderRegistry, type ToolUse, type TurnResult } from "./providers.js";
import { builtinTools, skillTool, type ToolContext, type ToolDef, type ToolOutput } from "./tools.js";

export interface SessionDeps {
  settings: Settings;
  runtime: PodmanRuntime;
  proxy: EgressProxy;
  secrets: SecretStore;
  personas: PersonaStore;
  skills: SkillRegistry;
  providers: ProviderRegistry;
  memory: MemoryStore;
  usage: UsageLedger;
  broadcast: (ev: ServerEvent) => void;
  onApprovalsChanged: () => void;
}

interface FrozenTool {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}

/**
 * A context epoch: one bounded model context inside the same conversation. Its system prompt,
 * tools and model are fixed for its lifetime (prompt caching; reasoning blocks are only valid
 * against an unchanged prefix). Its messages are append-only.
 */
interface Epoch {
  n: number;
  model: { provider: string; id: string };
  frozen: { system: string; tools: FrozenTool[] };
  messages: MessageParam[];
  startedAt: string;
  contextTokens?: number; // input context of the latest request in this epoch
}

interface Persisted {
  version: 2;
  summary: SessionSummary;
  items: ChatItem[];
  epochs: Epoch[];
  carry: string | null; // checkpoint text waiting to open the next user message of a new epoch
  placeholders: Record<string, string>; // secret name -> placeholder seen inside the sandbox
  proxyToken: string;
}

const MAX_TURNS_PER_MESSAGE = 200;
const DEFAULT_MAX_TOKENS = 64_000;
const SWAN_COMMANDS: SlashCommand[] = [
  { name: "dream", description: "Consolidate memory now", source: "swan" },
  { name: "stop", description: "Stop the agent and clear allowances", source: "swan" },
  { name: "usage", description: "Open usage for this persona", source: "swan" },
];

function systemPrompt(o: {
  name: string;
  instructions: string;
  folders: FolderMount[];
  workdir: string;
  allow: string[];
  credHosts: { name: string; hosts: string[] }[];
  skills: { name: string; description: string }[];
  brief: string;
  epoch: number;
}): string {
  const lines: string[] = [];
  lines.push(`You are an autonomous agent working as the persona "${o.name}" inside Swan.`);
  if (o.instructions.trim()) lines.push("", o.instructions.trim());
  lines.push(
    "",
    "# Environment",
    "- Your tools run inside an isolated Linux container (Debian, user `agent`, no root). Only these folders from the user's machine are mounted:",
    ...(o.folders.length ? o.folders.map((f) => `  - ${f.mountPath} (${f.mode === "rw" ? "read-write" : "read-only"})`) : ["  - (none)"]),
    "  Files written anywhere else are lost when the container stops.",
    `- Working directory: ${o.workdir}`,
    `- Today's date: ${new Date().toISOString().slice(0, 10)}`,
    "- Network access goes through an egress proxy. Requests to a public host that is not on the allowlist wait while the user decides; if they decline, the proxy answers 403. Just make the request when you need a site: do not refuse in advance and do not try to work around the proxy. Private and local addresses are always blocked. Tools must honour HTTPS_PROXY (curl, git, npm, pip, uv and Node do).",
    `- Allowed without asking: ${[...o.allow, ...o.credHosts.flatMap((c) => c.hosts)].join(", ") || "none yet"}`,
  );
  if (o.credHosts.length) {
    lines.push(
      "- Credentials: you never see real secret values. These environment variables hold placeholders that the proxy swaps for the real value only on requests to the listed hosts; use them exactly as you would the real thing (e.g. `curl -H \"Authorization: Bearer $GITHUB_TOKEN\" https://api.github.com/user`). Do not try to reveal, print or transform the real values.",
      ...o.credHosts.map((c) => `  - $${c.name} → ${c.hosts.join(", ") || "(not usable from the sandbox)"}`),
    );
  }
  lines.push(
    "- Some tool calls require the user's approval. If a call is denied, adjust your plan instead of retrying the same call.",
    "- The user may send a new message while you work; it arrives with your tool results. Take it into account before your next step.",
    "",
    "# Memory",
    "This is one long-running conversation. Older turns may no longer be in your context: use history_search and history_read to recover them, and memory_search / memory_read for this persona's saved memories. When the user states a lasting preference or the project makes a decision worth keeping, save it with memory_propose, citing event ids.",
  );
  if (o.epoch > 1) lines.push("Earlier context was condensed into a checkpoint that opens this part of the conversation; verify consequential details against history before relying on them.");
  if (o.brief) lines.push("", "Saved memories (brief; tentative ones are unconfirmed guesses):", o.brief);
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

const itemLine = (it: ChatItem): string => {
  switch (it.kind) {
    case "user":
      return `[${it.id}] User: ${it.text}`;
    case "assistant_text":
      return `[${it.id}] Assistant: ${it.text}`;
    case "tool_call":
      return `[${it.id}] Tool ${it.name} → ${it.status}: ${it.inputPreview}${it.output ? `\n${truncateMiddle(it.output, 1200)}` : ""}`;
    case "receipt":
      return `[${it.id}] ${it.title}: ${it.detail}`;
    default:
      return "";
  }
};

/** Pull the first JSON object out of a model reply. */
function parseJson(text: string): Record<string, unknown> | null {
  const a = text.indexOf("{");
  const b = text.lastIndexOf("}");
  if (a < 0 || b <= a) return null;
  try {
    return JSON.parse(text.slice(a, b + 1));
  } catch {
    return null;
  }
}

const strs = (v: unknown): string[] => (Array.isArray(v) ? v.filter((x): x is string => typeof x === "string").slice(0, 40) : []);

export class Session {
  summary: SessionSummary;
  items: ChatItem[];
  private epochs: Epoch[];
  private carry: string | null;
  private placeholders: Record<string, string>;
  private proxyToken: string;

  private container: string | null = null;
  private mcp: SessionMcp | null = null;
  private liveTools = new Map<string, ToolDef>();
  private workdir = "/workspace";
  private starting: Promise<void> | null = null;
  private queue: { text: string; receiptId?: string }[] = [];
  private loopRunning = false;
  private dreaming = false;
  private abort: AbortController | null = null;
  private approvals = new Map<string, { resolve: (d: ApprovalBody) => void; info: PendingApproval }>();
  private netPending = new Map<string, Promise<boolean>>(); // host -> decision in flight
  private netDenied = new Set<string>(); // until stopped
  private persistSoon = debounce(() => void this.persist(), 400);

  constructor(
    private deps: SessionDeps,
    data: Persisted,
  ) {
    this.summary = data.summary;
    this.items = data.items;
    this.epochs = data.epochs;
    this.carry = data.carry;
    this.placeholders = data.placeholders;
    this.proxyToken = data.proxyToken;
  }

  static create(deps: SessionDeps, personaId: string, title?: string): Session {
    const p = deps.personas.get(personaId);
    if (!p?.config) throw new Error(`persona "${personaId}" not found or invalid`);
    const model = p.config.model ?? deps.settings.defaultModel;
    const ts = nowIso();
    return new Session(deps, {
      version: 2,
      summary: {
        id: randomId("s", 6),
        personaId,
        title: title?.trim() || "New conversation",
        status: "stopped",
        createdAt: ts,
        updatedAt: ts,
        model: { provider: model.provider, id: model.id },
        usage: { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 },
        epoch: 0,
        allowances: [],
        queued: 0,
      },
      items: [],
      epochs: [],
      carry: null,
      placeholders: {},
      proxyToken: randomId("", 24),
    });
  }

  static async load(deps: SessionDeps, file: string): Promise<Session> {
    const raw = JSON.parse(await fs.readFile(file, "utf8"));
    let data: Persisted;
    if (raw.version === 2) data = raw;
    else {
      // v1: one transcript with one frozen prompt -> a single epoch.
      data = {
        version: 2,
        summary: raw.summary,
        items: raw.items,
        epochs: raw.frozen ? [{ n: 1, model: raw.summary.model, frozen: raw.frozen, messages: raw.messages, startedAt: raw.summary.createdAt }] : [],
        carry: null,
        placeholders: raw.placeholders,
        proxyToken: raw.proxyToken,
      };
    }
    // Nothing survives a restart except the transcript: reopen as stopped, allowances expired.
    data.summary = { ...data.summary, status: "stopped", statusDetail: undefined, allowances: [], queued: 0, epoch: data.epochs.at(-1)?.n ?? 0 };
    for (const it of data.items) {
      if (it.kind === "tool_call" && (it.status === "running" || it.status === "pending_approval")) it.status = "interrupted";
      if ((it.kind === "assistant_text" || it.kind === "thinking") && it.streaming) it.streaming = false;
      if (it.kind === "receipt" && it.status === "running") it.status = "error";
    }
    const s = new Session(deps, data);
    s.repairTranscript();
    return s;
  }

  get id() {
    return this.summary.id;
  }

  get personaId() {
    return this.summary.personaId;
  }

  private get epoch(): Epoch | undefined {
    return this.epochs.at(-1);
  }

  private get file() {
    return path.join(paths.sessions, `${this.id}.json`);
  }

  async persist(): Promise<void> {
    const data: Persisted = {
      version: 2,
      summary: this.summary,
      items: this.items,
      epochs: this.epochs,
      carry: this.carry,
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
    this.summary = { ...this.summary, updatedAt: nowIso(), queued: this.queue.length };
    this.deps.broadcast({ type: "session.updated", session: this.summary });
    this.persistSoon();
  }

  private setStatus(status: SessionStatus, detail?: string) {
    this.summary = { ...this.summary, status, statusDetail: detail };
    this.touch();
  }

  private refreshStatus() {
    if (this.approvals.size > 0) this.setStatus("awaiting_approval");
    else if (this.summary.status === "awaiting_approval") this.setStatus(this.loopRunning ? "running" : "idle");
    this.deps.onApprovalsChanged();
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

  /** Replace an item in this.items with the given version and broadcast it. */
  private syncItem(it: ChatItem) {
    const idx = this.items.findIndex((x) => x.id === it.id);
    if (idx >= 0 && this.items[idx] !== it) this.items[idx] = { ...it };
    this.updateItem(it);
  }

  notice(level: "info" | "warn" | "error", text: string) {
    this.addItem({ kind: "notice", id: randomId("it_", 6), ts: nowIso(), level, text });
  }

  private receipt(action: "dream" | "rollover" | "steer" | "command", title: string, detail: string, status: "running" | "done" | "error" = "running") {
    const it: Extract<ChatItem, { kind: "receipt" }> = { kind: "receipt", id: randomId("it_", 6), ts: nowIso(), action, title, detail, status };
    this.addItem(it);
    return {
      id: it.id,
      done: (d: string, s: "done" | "error" = "done") => {
        it.detail = d;
        it.status = s;
        this.syncItem(it);
      },
    };
  }

  // ---------- allowances ----------

  private setAllowances(a: string[]) {
    this.summary = { ...this.summary, allowances: a };
    this.touch();
    this.refreshPolicy();
  }

  /**
   * The sandbox asked for a public host that is not on the allowlist. The request waits on an
   * approval in the conversation: allow (until stopped), always (adds the host to the persona's
   * config) or deny (remembered until stopped so a retrying tool does not re-prompt).
   */
  requestNetwork(host: string, port: number): Promise<boolean> {
    if (this.netDenied.has(host)) return Promise.resolve(false);
    const inflight = this.netPending.get(host);
    if (inflight) return inflight;
    const id = randomId("net_", 8);
    const target = port === 443 || port === 80 ? host : `${host}:${port}`;
    const item: Extract<ChatItem, { kind: "tool_call" }> = {
      kind: "tool_call",
      id,
      ts: nowIso(),
      name: "network_access",
      source: "builtin",
      input: { host, port },
      inputPreview: target,
      status: "pending_approval",
      approvalReason: "not in this persona's allowed hosts",
    };
    this.addItem(item);
    const p = new Promise<boolean>((resolve) => {
      const done = (ok: boolean, status: ToolCallStatus, output: string) => {
        clearTimeout(timer);
        this.approvals.delete(id);
        this.netPending.delete(host);
        Object.assign(item, { status, output, approvalReason: undefined });
        this.syncItem(item);
        this.refreshStatus();
        resolve(ok);
      };
      const timer = setTimeout(() => done(false, "interrupted", "No decision within 10 minutes; the request was blocked."), 10 * 60_000);
      this.approvals.set(id, {
        info: { sessionId: this.id, personaId: this.personaId, toolUseId: id, name: "network_access", inputPreview: target, rule: "network: ask", since: item.ts },
        resolve: (d) => {
          if (d.decision === "deny") {
            this.netDenied.add(host);
            done(false, "denied", `Blocked ${target}${d.reason?.trim() ? `: ${d.reason.trim()}` : ""}. Other requests to it are blocked until the agent is stopped.`);
            return;
          }
          if (!this.summary.allowances.includes(`net:${host}`)) this.setAllowances([...this.summary.allowances, `net:${host}`]);
          if (d.decision === "allow_always") {
            void this.deps.personas.addNetworkHost(this.personaId, host).catch((e) => this.notice("error", `Could not save ${host} to the persona: ${errMsg(e)}`));
            done(true, "done", `Allowed ${target} and added it to this persona's allowed hosts.`);
          } else done(true, "done", `Allowed ${target} until the agent is stopped.`);
        },
      });
      this.refreshStatus();
    });
    this.netPending.set(host, p);
    return p;
  }

  removeAllowance(rule: string) {
    this.setAllowances(this.summary.allowances.filter((r) => r !== rule));
  }

  resetAllowances() {
    this.setAllowances([]);
  }

  // ---------- lifecycle ----------

  private ensureStarted(): Promise<void> {
    if (this.container) return Promise.resolve();
    this.starting ??= this.start().finally(() => (this.starting = null));
    return this.starting;
  }

  private renderPlaceholders = (template: string) => template.replace(SECRET_REF, (_m, n: string) => this.placeholders[n] ?? "");

  private proxyRegistration() {
    const cfg = this.deps.personas.get(this.personaId)?.config;
    const allowed = new Set(cfg?.credentials ?? []);
    const creds = Object.keys(this.placeholders).filter((c) => allowed.has(c));
    return {
      sessionId: this.id,
      personaId: this.personaId,
      token: this.proxyToken,
      // Hosts allowed "until stopped" ride along with the persona's own allowlist.
      allowHosts: [...(cfg?.network.allow ?? []), ...this.summary.allowances.filter((a) => a.startsWith("net:")).map((a) => a.slice(4))],
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
    const persona = personas.get(this.personaId);
    if (!persona?.config) throw new Error(`persona "${this.personaId}" is missing or invalid`);
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

    const tools = [
      ...builtinTools(),
      ...(cfg.skills.length ? [skillTool()] : []),
      ...memoryTools({ memory: this.deps.memory, personaId: this.personaId, items: () => this.items }),
      ...(await this.mcp.tools()),
    ];
    this.liveTools = new Map(tools.map((t) => [t.name, t]));

    const missing = cfg.credentials.filter((c) => !secrets.value(c));
    if (missing.length) this.notice("warn", `Missing credentials: ${missing.join(", ")}. Requests that need them will go out without auth until you add them (picked up live).`);
    this.setStatus("idle");
  }

  private async teardown() {
    this.deps.providers.releaseSession(this.id);
    await this.mcp?.close().catch(() => {});
    this.mcp = null;
    this.liveTools.clear();
    this.deps.proxy.unregister(this.id);
    if (this.container) await this.deps.runtime.stopSession(this.id).catch(() => {});
    this.container = null;
  }

  async stop(): Promise<void> {
    this.interrupt();
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

  // ---------- epochs ----------

  private currentModel() {
    const cfg = this.deps.personas.get(this.personaId)?.config;
    const m = cfg?.model ?? this.deps.settings.defaultModel;
    return { provider: m.provider, id: m.id, effort: cfg?.model?.effort, maxTokens: cfg?.model?.maxTokens };
  }

  private providerType(provider: string) {
    return this.deps.settings.providers[provider]?.type ?? "openai";
  }

  /** Build a fresh epoch: current persona model, current tools, memory brief, frozen until the next one. */
  private async openEpoch() {
    const { personas, skills, secrets } = this.deps;
    const persona = personas.get(this.personaId)!;
    const cfg = persona.config!;
    const m = this.currentModel();
    const n = (this.epoch?.n ?? 0) + 1;
    const brief = cfg.memory.autoBrief ? await this.deps.memory.brief(this.personaId, cfg.memory.briefTokens * 4) : "";
    const tools = [...this.liveTools.values()];
    this.epochs.push({
      n,
      model: { provider: m.provider, id: m.id },
      frozen: {
        system: systemPrompt({
          name: cfg.name,
          instructions: cfg.instructions,
          folders: persona.folders,
          workdir: this.workdir,
          allow: cfg.network.allow,
          credHosts: cfg.credentials.map((name) => ({ name, hosts: secrets.get(name)?.hosts ?? [] })),
          skills: cfg.skills.flatMap((s) => (skills.get(s) ? [{ name: s, description: skills.get(s)!.description }] : [])),
          brief,
          epoch: n,
        }),
        tools: tools.map((t) => ({ name: t.name, description: t.description, inputSchema: t.inputSchema })),
      },
      messages: [],
      startedAt: nowIso(),
    });
    this.summary = { ...this.summary, epoch: n, model: { provider: m.provider, id: m.id } };
    this.touch();
  }

  /** Why the next request needs a new epoch, or null. */
  private rolloverReason(): string | null {
    const e = this.epoch;
    if (!e || !e.messages.length) return null;
    const m = this.currentModel();
    if (e.model.provider !== m.provider || e.model.id !== m.id) return `model changed to ${m.id}`;
    // A fresh epoch must do some work before it can roll over again, or an oversized carry-over thrashes.
    if (e.messages.filter((x) => x.role === "assistant").length < 2) return null;
    const used = e.contextTokens ?? Math.ceil(JSON.stringify(e.messages).length / 4);
    const limit = this.deps.settings.contextLimitTokens;
    if (used > limit * this.deps.settings.rolloverAt) return `context reached ${Math.round((used / limit) * 100)}% of ${Math.round(limit / 1000)}k tokens`;
    return null;
  }

  /** One model call outside the conversation (checkpoint, /dream). Usage is recorded under its purpose. */
  private async auxCall(system: string, prompt: string, purpose: UsagePurpose): Promise<{ text: string; result: TurnResult }> {
    const m = this.currentModel();
    const auxId = `${this.id}:${purpose}`;
    const ac = new AbortController();
    const abortAux = () => ac.abort();
    this.abort?.signal.addEventListener("abort", abortAux, { once: true });
    let text = "";
    try {
      const result = await this.deps.providers.runTurn(
        m.provider,
        { model: m.id, system, tools: [], messages: [{ role: "user", content: prompt }], maxTokens: 16_000, effort: "medium", signal: ac.signal, sessionId: auxId },
        { onBlockStart: () => {}, onDelta: (_i, kind, t) => kind === "text" && (text += t), onBlockStop: () => {} },
      );
      if (!text) text = result.content.flatMap((b) => (b.type === "text" ? [b.text] : [])).join("");
      this.recordUsage(result, purpose, m.provider, m.id);
      return { text, result };
    } finally {
      this.abort?.signal.removeEventListener("abort", abortAux);
      this.deps.providers.releaseSession(auxId);
    }
  }

  private recordUsage(result: TurnResult, purpose: UsagePurpose, provider: string, model: string) {
    const u = result.usage;
    const providerType = this.providerType(provider);
    this.deps.usage.record({
      personaId: this.personaId,
      sessionId: this.id,
      epoch: this.epoch?.n ?? 0,
      provider,
      providerType,
      model,
      purpose,
      inputTokens: u.inputTokens,
      outputTokens: u.outputTokens,
      cacheReadTokens: u.cacheReadTokens,
      cacheWriteTokens: u.cacheWriteTokens,
      credits: (result as TurnResult & { credits?: number }).credits,
    });
    const s = this.summary.usage;
    this.summary = {
      ...this.summary,
      usage: {
        inputTokens: s.inputTokens + u.inputTokens,
        outputTokens: s.outputTokens + u.outputTokens,
        cacheReadTokens: s.cacheReadTokens + u.cacheReadTokens,
        cacheWriteTokens: s.cacheWriteTokens + u.cacheWriteTokens,
      },
    };
  }

  /**
   * Context rollover: checkpoint the epoch, then open a new one whose first user message carries
   * the checkpoint and a recent tail. Original events are never rewritten. A failed checkpoint keeps
   * the old epoch committed and continues with a mechanical tail instead of losing history.
   */
  private async rollover(reason: string) {
    const old = this.epoch!;
    const r = this.receipt("rollover", "New context", `Condensing earlier context (${reason})…`);
    const prev = await this.deps.memory.latestCheckpoint(this.personaId);
    const since = old.startedAt;
    const epochItems = this.items.filter((it) => it.ts >= since);
    const transcript = truncateMiddle(epochItems.map(itemLine).filter(Boolean).join("\n\n"), 150_000);
    let cp: Checkpoint | null = null;
    for (let attempt = 0; attempt < 2 && !cp; attempt++) {
      try {
        const { text } = await this.auxCall(
          "You write checkpoints that let an agent continue a long task in a fresh context. Output only one JSON object, no prose.",
          `Previous checkpoint (may be null):\n${JSON.stringify(prev)}\n\nEvents since then (ids in brackets):\n${transcript}\n\nWrite the checkpoint for ALL unfinished work as JSON with exactly these keys: "objective" (the user's goal and acceptance criteria), "constraints" (explicit user constraints, verbatim where possible), "decisions" (with rationale), "completed" (work done, with file paths/artifacts), "failures" (what failed and test evidence), "openQuestions", "nextAction" (one concrete next step), "sources" (event ids that support the above). Arrays of strings except objective and nextAction.`,
          "checkpoint",
        );
        const j = parseJson(text);
        if (j && typeof j.objective === "string" && typeof j.nextAction === "string") {
          cp = {
            epoch: old.n,
            createdAt: nowIso(),
            objective: j.objective,
            constraints: strs(j.constraints),
            decisions: strs(j.decisions),
            completed: strs(j.completed),
            failures: strs(j.failures),
            openQuestions: strs(j.openQuestions),
            nextAction: j.nextAction,
            sources: strs(j.sources).filter((id) => this.items.some((it) => it.id === id)),
          };
        }
      } catch (e) {
        if (this.abort?.signal.aborted) throw e;
        log.warn("session", `checkpoint attempt failed: ${errMsg(e)}`);
      }
    }
    if (cp) await this.deps.memory.addCheckpoint(this.personaId, cp);
    else this.notice("warn", "Could not write a structured checkpoint; the new context carries the recent conversation instead. Earlier turns stay searchable with history_search.");

    // The carried tail gets at most a quarter of the context (about 3.5 characters per token).
    const tailChars = Math.min(16_000, Math.floor(this.deps.settings.contextLimitTokens * 0.25 * 3.5));
    const tail = truncateMiddle(this.items.slice(-24).map(itemLine).filter(Boolean).join("\n\n"), tailChars);
    const parts = [`[Carried over from earlier in this conversation — context ${old.n + 1} starts here (${reason}).]`];
    if (cp) {
      const list = (h: string, xs: string[]) => (xs.length ? `${h}:\n${xs.map((x) => `- ${x}`).join("\n")}` : "");
      parts.push(
        "## Checkpoint",
        `Objective: ${cp.objective}`,
        list("Constraints", cp.constraints),
        list("Decisions", cp.decisions),
        list("Completed", cp.completed),
        list("Failures", cp.failures),
        list("Open questions", cp.openQuestions),
        `Next action: ${cp.nextAction}`,
        cp.sources.length ? `Sources: ${cp.sources.join(", ")}` : "",
      );
    }
    parts.push("## Most recent events", tail, "[End of carried-over context.]");
    this.carry = parts.filter(Boolean).join("\n\n");
    await this.openEpoch();
    r.done(cp ? `Context ${old.n + 1}: checkpoint saved (${reason})` : `Context ${old.n + 1}: recent events carried over (${reason})`, cp ? "done" : "error");
    await this.persist();
  }

  /** Append user content to the epoch, opening it with any carried-over checkpoint. */
  private pushUser(content: string | ContentBlockParam[]) {
    const e = this.epoch!;
    if (this.carry) {
      const carried: ContentBlockParam = { type: "text", text: this.carry };
      e.messages.push({ role: "user", content: typeof content === "string" ? [carried, { type: "text", text: content }] : [...content, carried] });
      this.carry = null;
    } else e.messages.push({ role: "user", content });
  }

  private async prepareEpoch() {
    if (!this.epoch) await this.openEpoch();
    const reason = this.rolloverReason();
    if (reason) await this.rollover(reason);
  }

  // ---------- conversation ----------

  commands(): SlashCommand[] {
    const cfg = this.deps.personas.get(this.personaId)?.config;
    return [
      ...SWAN_COMMANDS,
      ...(cfg?.skills ?? []).flatMap((s) => {
        const sk = this.deps.skills.get(s);
        return sk ? [{ name: s, description: sk.description || `Use the ${s} skill`, source: "skill" as const }] : [];
      }),
    ];
  }

  async sendMessage(text: string) {
    const trimmed = text.trim();
    if (!trimmed) throw new Error("empty message");
    if (trimmed.startsWith("/")) return this.command(trimmed);
    this.enqueue(trimmed, trimmed);
  }

  private enqueue(display: string, content: string) {
    this.addItem({ kind: "user", id: randomId("it_", 6), ts: nowIso(), text: display });
    if (this.summary.title === "New conversation" || this.summary.title === "New session")
      this.summary = { ...this.summary, title: display.replace(/\s+/g, " ").slice(0, 60) };
    const steering = this.loopRunning;
    const receiptId = steering ? this.receipt("steer", "Queued", "Will steer the next step").id : undefined;
    this.queue.push({ text: content, receiptId });
    this.touch();
    if (!this.loopRunning) void this.runLoop();
  }

  private async command(line: string) {
    const [head, ...rest] = line.slice(1).split(/\s+/);
    const name = head.toLowerCase();
    const arg = rest.join(" ").trim();
    if (name === "dream") return void this.dream();
    if (name === "stop") {
      this.interrupt();
      this.receipt("command", "/stop", "Stopped; temporary allowances cleared", "done");
      return;
    }
    if (name === "usage") return; // handled by the UI
    const cfg = this.deps.personas.get(this.personaId)?.config;
    if (cfg?.skills.includes(name) && this.deps.skills.get(name)) {
      this.enqueue(line, `Use the "${name}" skill for this: call load_skill with name "${name}" first, then follow its instructions.${arg ? `\n\n${arg}` : ""}`);
      return;
    }
    this.notice("error", `Unknown command /${name}. Type / to see the commands for this persona.`);
  }

  interrupt() {
    this.abort?.abort();
    // Pending network requests are refused; "until stopped" decisions end here too.
    for (const [id, a] of [...this.approvals]) if (a.info.name === "network_access") this.approvals.get(id)?.resolve({ decision: "deny", reason: "stopped" });
    this.netDenied.clear();
    for (const q of this.queue) if (q.receiptId) this.finishReceipt(q.receiptId, "Dropped by Stop", "error");
    this.queue = [];
    // Temporary allowances expire on Stop and Interrupt.
    this.summary = { ...this.summary, allowances: [], queued: 0 };
    this.touch();
  }

  private finishReceipt(id: string, detail: string, status: "done" | "error") {
    const it = this.items.find((x) => x.id === id);
    if (it?.kind !== "receipt") return;
    it.detail = detail;
    it.status = status;
    this.syncItem(it);
  }

  approve(toolUseId: string, body: ApprovalBody) {
    const a = this.approvals.get(toolUseId);
    if (!a) throw new Error("no pending approval for that tool call");
    a.resolve(body);
  }

  pendingApprovals(): PendingApproval[] {
    return [...this.approvals.values()].map((a) => a.info);
  }

  private async runLoop() {
    this.loopRunning = true;
    try {
      try {
        await this.ensureStarted();
      } catch (e) {
        this.queue = [];
        this.notice("error", `Could not start the conversation: ${errMsg(e)}`);
        this.setStatus("error", errMsg(e));
        return;
      }
      while (this.queue.length) {
        const q = this.queue.shift()!;
        if (q.receiptId) this.finishReceipt(q.receiptId, "Read before the next step", "done");
        this.touch();
        await this.prepareEpoch();
        this.pushUser(q.text);
        await this.agentTurns();
      }
      this.setStatus("idle");
    } catch (e) {
      const msg = e instanceof ProviderError ? e.message : `Agent loop error: ${errMsg(e)}`;
      log.error("session", `${this.id}: ${errMsg(e)}`);
      for (const q of this.queue) if (q.receiptId) this.finishReceipt(q.receiptId, "Not sent: the turn failed", "error");
      this.queue = [];
      this.notice("error", msg);
      this.setStatus("error", msg);
    } finally {
      this.loopRunning = false;
      this.abort = null;
      this.touch();
      await this.persist();
    }
  }

  private async agentTurns() {
    const ac = new AbortController();
    this.abort = ac;

    for (let turn = 0; turn < MAX_TURNS_PER_MESSAGE; turn++) {
      if (ac.signal.aborted) return;
      if (turn > 0) {
        const reason = this.rolloverReason();
        if (reason) {
          await this.rollover(reason);
          this.pushUser("Continue from the next action in the checkpoint above.");
        }
      }
      const e = this.epoch!;
      const cfg = this.deps.personas.get(this.personaId)?.config;
      const toolDefs: ToolDef[] = e.frozen.tools.map((f) => {
        const live = this.liveTools.get(f.name);
        return live ? { ...live, description: f.description, inputSchema: f.inputSchema } : this.unavailableTool(f);
      });
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
      let result: TurnResult;
      try {
        result = await this.deps.providers.runTurn(
          e.model.provider,
          {
            model: e.model.id,
            system: e.frozen.system,
            tools: toolDefs,
            messages: e.messages,
            maxTokens: cfg?.model?.maxTokens ?? DEFAULT_MAX_TOKENS,
            effort: cfg?.model?.effort,
            signal: ac.signal,
            sessionId: this.id,
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
      } catch (err) {
        finalizeStreams();
        if (ac.signal.aborted) {
          this.notice("info", "Interrupted.");
          return;
        }
        throw err;
      }
      finalizeStreams();

      this.recordUsage(result, "foreground", e.model.provider, e.model.id);
      const u = result.usage;
      // Anthropic reports cached input separately; OpenAI-style prompt tokens already include it.
      const reported = this.providerType(e.model.provider) === "anthropic" ? u.inputTokens + u.cacheReadTokens + u.cacheWriteTokens : u.inputTokens;
      // Providers that report no usage (some local servers) fall back to a conservative estimate.
      const estimated = reported <= 0;
      e.contextTokens = estimated ? Math.ceil((e.frozen.system.length + JSON.stringify(e.messages).length) / 3.5) : reported;
      this.deps.usage.setContext(this.personaId, { usedTokens: e.contextTokens, limitTokens: this.deps.settings.contextLimitTokens, estimated, epoch: e.n });
      this.deps.broadcast({ type: "usage.updated", personaId: this.personaId });

      if (result.notice) this.notice(result.stopReason === "refusal" ? "warn" : "info", result.notice);
      // A refused or truncated tool turn is not appended, so the transcript stays valid.
      if (result.stopReason === "refusal") return;
      if (result.stopReason === "max_tokens" && result.toolUses.length) {
        this.notice("warn", "The model hit its output limit in the middle of a tool call, so the call was not run. Ask it to continue in smaller steps.");
        return;
      }
      e.messages.push({ role: "assistant", content: result.content });
      this.touch();
      if (result.stopReason === "pause_turn") continue;
      if (result.toolUses.length === 0) {
        if (result.stopReason === "max_tokens") this.notice("warn", "The reply was cut off at the output limit.");
        return;
      }
      const results: ContentBlockParam[] = await this.runTools(result.toolUses, ac.signal);
      // Steering: messages that arrived while tools ran ride along with their results.
      if (this.queue.length && !ac.signal.aborted) {
        const steer = this.queue.splice(0);
        results.push({ type: "text", text: `New message from the user while you were working:\n\n${steer.map((q) => q.text).join("\n\n")}` });
        for (const q of steer) if (q.receiptId) this.finishReceipt(q.receiptId, "Read before the next step", "done");
      }
      e.messages.push({ role: "user", content: results });
      this.touch();
      if (ac.signal.aborted) {
        this.notice("info", "Interrupted.");
        return;
      }
    }
    this.notice("warn", `Stopped after ${MAX_TURNS_PER_MESSAGE} model turns for one message.`);
  }

  // ---------- /dream ----------

  async dream() {
    if (this.dreaming) return this.notice("info", "/dream is already running.");
    this.dreaming = true;
    const r = this.receipt("dream", "/dream", "Consolidating memory…");
    try {
      const recs = (await this.deps.memory.list(this.personaId)).filter((x) => x.status === "active" || x.status === "tentative").slice(0, 200);
      const last = await this.deps.memory.dreamState(this.personaId);
      const fresh = this.items.filter((it) => !last || it.ts > last);
      const events = truncateMiddle(fresh.map(itemLine).filter(Boolean).join("\n\n"), 80_000);
      const { text, result } = await this.auxCall(
        "You maintain a persona's long-term memory. Output only one JSON object, no prose.",
        `Current memory records:\n${JSON.stringify(recs.map((x) => ({ id: x.id, type: x.type, origin: x.origin, status: x.status, pinned: x.pinned, content: x.content })))}\n\nConversation events since the last consolidation (ids in brackets):\n${events || "(none)"}\n\nReturn JSON {"add": [{"type": "preference|decision|observation|procedure|episode", "content": "...", "origin": "user|observation|inference", "sources": ["event ids"]}], "merge": [{"keep": "record id", "remove": ["duplicate record ids"], "content": "merged text"}], "archive": ["ids of records about completed work that no longer matter"]}. Only add durable facts: stated preferences (origin user), decisions with rationale, verified observations, procedures that worked. Never re-add archived or forgotten facts. Use origin "inference" for anything the user did not say or the tools did not show.`,
        "dream",
      );
      const j = parseJson(text);
      if (!j) throw new Error("the model did not return a consolidation plan");
      const changed = await this.deps.memory.applyDream(this.personaId, {
        add: (Array.isArray(j.add) ? j.add : []) as never,
        merge: (Array.isArray(j.merge) ? j.merge : []) as never,
        archive: strs(j.archive),
      });
      const credits = (result as TurnResult & { credits?: number }).credits;
      const tokens = result.usage.inputTokens + result.usage.outputTokens;
      const cost = credits !== undefined ? `${credits.toFixed(2)} credits` : tokens > 0 ? `${Math.max(0.1, Math.round(tokens / 100) / 10)}k tokens` : "usage not reported";
      r.done(`Consolidated memory · ${changed} record${changed === 1 ? "" : "s"} updated · ${cost}`);
      this.deps.broadcast({ type: "usage.updated", personaId: this.personaId });
    } catch (e) {
      r.done(`Memory unchanged: ${e instanceof ProviderError ? e.message : errMsg(e)}`, "error");
    } finally {
      this.dreaming = false;
      await this.persist();
    }
  }

  // ---------- tools ----------

  private unavailableTool(f: FrozenTool): ToolDef {
    return {
      ...f,
      source: f.name.startsWith("mcp__") ? "mcp" : "builtin",
      validate: (input) => ({ ok: true, value: (input ?? {}) as Record<string, unknown> }),
      preview: (i) => JSON.stringify(i).slice(0, 100),
      run: async () => ({ text: `Tool ${f.name} is not available right now (its MCP server is not running).`, isError: true }),
    };
  }

  private toolCtx(signal: AbortSignal): ToolContext {
    const cfg = this.deps.personas.get(this.personaId)?.config;
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

  private policy() {
    const cfg = this.deps.personas.get(this.personaId)?.config;
    return new PermissionPolicy(cfg?.permissions ?? { default: "ask", allow: [], ask: [], deny: [] }, this.summary.allowances);
  }

  private runTools(toolUses: ToolUse[], signal: AbortSignal) {
    const policy = this.policy();
    return Promise.all(toolUses.map((tu) => this.runOne(tu, policy, signal)));
  }

  private async runOne(tu: ToolUse, policy: PermissionPolicy, signal: AbortSignal): Promise<ContentBlockParam> {
    const frozenDef = this.epoch?.frozen.tools.find((t) => t.name === tu.name);
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

    let perm = policy.evaluate(tool, v.value);
    // Memory and history reads are allowed unless a rule says otherwise.
    if (perm.rule.startsWith("default") && MEMORY_READ_TOOLS.has(tool.name)) perm = { mode: "allow", rule: "memory read" };
    if (perm.mode === "deny") return finish("denied", { text: `Denied by the persona's permission policy (${perm.rule}).`, isError: true }, { denyReason: perm.rule });
    if (perm.mode === "ask") {
      item.status = "pending_approval";
      item.approvalReason = perm.rule;
      show();
      const decision = await this.waitForApproval(tu.id, signal, {
        sessionId: this.id,
        personaId: this.personaId,
        toolUseId: tu.id,
        name: tool.name,
        inputPreview: item.inputPreview,
        rule: perm.rule,
        since: nowIso(),
      });
      this.refreshStatus();
      if (!decision) return finish("interrupted", { text: "Interrupted by the user before approval.", isError: true });
      if (decision.decision === "deny") {
        const why = decision.reason?.trim();
        return finish("denied", { text: `The user denied this tool call${why ? `: ${why}` : "."}`, isError: true }, { denyReason: why || "denied by user" });
      }
      if (decision.decision === "allow_always") {
        const rule = PermissionPolicy.alwaysAllowRule(tool, v.value);
        if (!this.summary.allowances.includes(rule)) this.setAllowances([...this.summary.allowances, rule]);
      }
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

  private waitForApproval(id: string, signal: AbortSignal, info: PendingApproval): Promise<ApprovalBody | null> {
    return new Promise((resolve) => {
      if (signal.aborted) return resolve(null);
      const onAbort = () => {
        this.approvals.delete(id);
        this.refreshStatus();
        resolve(null);
      };
      signal.addEventListener("abort", onAbort, { once: true });
      this.approvals.set(id, {
        info,
        resolve: (d) => {
          signal.removeEventListener("abort", onAbort);
          this.approvals.delete(id);
          resolve(d);
        },
      });
      this.refreshStatus();
    });
  }

  /**
   * After a crash mid-turn the epoch can end with tool_use blocks that never got results. That is
   * uncertain execution: append (never rewrite) results that say so, so the model checks state
   * instead of assuming the call did not run.
   */
  private repairTranscript() {
    const e = this.epoch;
    const last = e?.messages.at(-1);
    if (!e || !last || last.role !== "assistant" || typeof last.content === "string") return;
    const open = last.content.filter((b) => b.type === "tool_use").map((b) => (b as { id: string }).id);
    if (!open.length) return;
    e.messages.push({
      role: "user",
      content: open.map((id) => ({
        type: "tool_result" as const,
        tool_use_id: id,
        is_error: true,
        content: "Swan restarted while this call was in flight. It may or may not have run: check the workspace or external state before repeating it.",
      })),
    });
  }

  // ---------- views ----------

  tools(): ToolSummary[] {
    const policy = this.policy();
    const cfg = this.deps.personas.get(this.personaId)?.config;
    const defs = this.liveTools.size
      ? [...this.liveTools.values()]
      : [...builtinTools(), ...(cfg?.skills.length ? [skillTool()] : []), ...memoryTools({ memory: this.deps.memory, personaId: this.personaId, items: () => this.items })];
    return defs.map((t) => ({ name: t.name, source: t.source, server: t.server, description: t.description, permission: MEMORY_READ_TOOLS.has(t.name) && policy.describe(t) !== "deny" ? "allow" : policy.describe(t) }));
  }

  get isActive() {
    return this.container !== null;
  }
}

export class SessionManager {
  private sessions = new Map<string, Session>();
  constructor(private deps: SessionDeps) {
    deps.proxy.asker = async (ps, host, port) => this.sessions.get(ps.sessionId)?.requestNetwork(host, port) ?? false;
  }

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

  /** The persona's one ongoing conversation: the most recently active session, created if absent. */
  conversation(personaId: string) {
    const mine = [...this.sessions.values()].filter((s) => s.personaId === personaId).sort((a, b) => b.summary.updatedAt.localeCompare(a.summary.updatedAt));
    return mine[0] ?? this.create(personaId);
  }

  get(id: string) {
    return this.sessions.get(id);
  }

  list(personaId?: string) {
    return [...this.sessions.values()]
      .filter((s) => !personaId || s.personaId === personaId)
      .map((s) => s.summary)
      .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  }

  pendingApprovals(): PendingApproval[] {
    return [...this.sessions.values()].flatMap((s) => s.pendingApprovals()).sort((a, b) => a.since.localeCompare(b.since));
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
