// Everything one session does with connections: placeholders, files and env in the sandbox,
// sign-in cards, ask prompts and blocked-request notices. Real values never pass through here.
import { createHash } from "node:crypto";
import { z } from "zod";
import type { ApprovalBody, ChatItem, ConnectionState, PendingApproval } from "@ph/shared";
import { CREDENTIAL_REF, parseRefMatch } from "../connections/config.js";
import type { ConnectionManager } from "../connections/manager.js";
import { newPlaceholder, placeholderKeys } from "../connections/placeholders.js";
import { ruleKey, type Verdict } from "../connections/rules.js";
import type { PersonaConfig, PersonaStore } from "../personas.js";
import type { ProxySession } from "../proxy/egress.js";
import type { PodmanRuntime } from "../sandbox/podman.js";
import { errMsg, nowIso, randomId } from "../util.js";
import { zodTool, type ToolDef } from "./tools.js";

const HOME = "/home/agent";
export const ENV_FILE = `${HOME}/.swan/env.sh`;

type SignInItem = Extract<ChatItem, { kind: "sign_in" }>;
type BlockedItem = Extract<ChatItem, { kind: "credential_blocked" }>;
type ToolItem = Extract<ChatItem, { kind: "tool_call" }>;

export interface CredentialHost {
  id: string;
  personaId: string;
  connections: ConnectionManager;
  personas: PersonaStore;
  runtime: PodmanRuntime;
  container(): string | null;
  addItem(it: ChatItem): void;
  syncItem(it: ChatItem): void;
  notice(level: "info" | "warn" | "error", text: string): void;
  allowances(): string[];
  setAllowances(a: string[]): void;
  /** Register a pending approval (listed and resolvable like a tool call); null on timeout or stop. */
  waitApproval(id: string, info: PendingApproval, timeoutMs: number): Promise<ApprovalBody | null>;
  refreshPolicy(): void;
}

const sha = (s: string) => createHash("sha256").update(s).digest("hex");
const shellQuote = (s: string) => `'${s.replace(/'/g, `'\\''`)}'`;
const CRED_ALLOWANCE = "cred:";

export class SessionCredentials {
  private signIns = new Map<string, SignInItem>();
  private blocked = new Map<string, BlockedItem>(); // credential|rule -> latest group
  private asking = new Map<string, Promise<boolean>>(); // ref + rule -> decision in flight
  private refused = new Set<string>(); // ref + rule denied until stopped
  private written = new Map<string, string>(); // sandbox path -> sha of content
  private acquired = new Set<string>();

  constructor(
    private host: CredentialHost,
    private placeholders: Record<string, string>, // "ref" or "ref.field" -> placeholder (persisted by the session)
  ) {}

  private get cfg(): PersonaConfig | null {
    return this.host.personas.get(this.host.personaId)?.config ?? null;
  }

  connectionNames(): string[] {
    return Object.keys(this.cfg?.connections ?? {}).filter((c) => this.host.connections.configOf(c));
  }

  commandConnections(): string[] {
    return this.connectionNames().filter((c) => this.host.connections.configOf(c)?.type === "command");
  }

  namedRefs(): string[] {
    const cfg = this.cfg;
    return cfg ? [...this.host.personas.namedRefs(cfg)] : [];
  }

  // ---------- placeholders ----------

  placeholderFor(ref: string, field?: string): string {
    const key = field && field !== "value" ? `${ref}.${field}` : ref;
    let ph = this.placeholders[key];
    if (!ph) {
      ph = this.placeholders[key] = newPlaceholder(ref, field);
      this.host.refreshPolicy();
    }
    return ph;
  }

  /** Make placeholders for every named credential whose kind is known. */
  ensurePlaceholders() {
    for (const ref of this.namedRefs()) {
      const c = this.host.connections.resolve(ref);
      if (!c) continue;
      for (const key of placeholderKeys(ref, c.kind)) {
        const dot = key.lastIndexOf(".");
        const field = c.kind === "aws-sigv4" ? key.slice(dot + 1) : undefined;
        this.placeholders[key] ??= newPlaceholder(ref, field);
      }
    }
  }

  /** `{{credential:conn/NAME…}}` in persona env and MCP stdio env -> placeholders. */
  render(template: string): string {
    const named = this.namedRefs();
    return template.replace(CREDENTIAL_REF, (...m) => {
      const r = parseRefMatch(m as unknown as RegExpMatchArray);
      const ref = r.connection ? `${r.connection}/${r.name}` : undefined;
      if (!ref || !named.includes(ref)) return "";
      const c = this.host.connections.resolve(ref);
      if (r.basic) return Buffer.from(`${c?.username ?? ""}:${this.placeholderFor(ref)}`).toString("base64");
      if (r.field === "username") return c?.username ?? "";
      return this.placeholderFor(ref, c?.kind === "aws-sigv4" ? r.field : undefined);
    });
  }

  /** Sandbox variables for static credentials. */
  staticEnv(): Record<string, string> {
    const env: Record<string, string> = {};
    for (const ref of this.namedRefs()) {
      const c = this.host.connections.resolve(ref);
      if (c?.kind === "static" && c.env) env[c.env] = this.placeholderFor(ref);
    }
    return env;
  }

  proxyFields(): Pick<ProxySession, "credentials" | "placeholders" | "rules" | "sessionAllowed"> {
    const credentials = this.namedRefs();
    const placeholders = new Map<string, { ref: string; field?: string }>();
    for (const [key, ph] of Object.entries(this.placeholders)) {
      const m = /^(.+?)\.(accessKeyId|secretAccessKey|sessionToken)$/.exec(key);
      const ref = m ? m[1] : key;
      if (credentials.includes(ref)) placeholders.set(ph, m ? { ref, field: m[2] } : { ref });
    }
    const rules = new Map(Object.entries(this.cfg?.connections ?? {}).map(([conn, pc]) => [conn, pc.rules] as const));
    const sessionAllowed = new Set(this.host.allowances().filter((a) => a.startsWith(CRED_ALLOWANCE)).map((a) => a.slice(CRED_ALLOWANCE.length)));
    return { credentials, placeholders, rules, sessionAllowed };
  }

  // ---------- lifecycle ----------

  /** Before the container starts: check command connections and keep them renewed while we run. */
  async prepare(): Promise<{ needSignIn: string[]; problems: string[] }> {
    const needSignIn: string[] = [];
    const problems: string[] = [];
    for (const conn of this.commandConnections()) {
      this.host.connections.acquire(conn, this.host.id);
      this.acquired.add(conn);
      const state = await this.host.connections.ensure(conn);
      if (state === "login_required") needSignIn.push(conn);
      else if (state === "error") problems.push(`Connection ${conn}: ${this.host.connections.status().find((s) => s.name === conn)?.message ?? "the wrapper failed"}`);
    }
    this.ensurePlaceholders();
    const cfg = this.cfg;
    for (const [conn, pc] of Object.entries(cfg?.connections ?? {})) {
      if (this.host.connections.configOf(conn)?.type !== "command" || !this.host.connections.credentialNames(conn).length) continue;
      const known = this.host.connections.credentialNames(conn);
      for (const r of pc.rules) if (!/[*?]/.test(r.credential) && !known.includes(r.credential)) problems.push(`A rule names ${conn}/${r.credential}, but the connection did not return that credential (it has ${known.join(", ")}).`);
    }
    const missing = this.namedRefs().filter((ref) => this.host.connections.configOf(ref.split("/")[0])?.type === "static" && !this.host.connections.usable(ref));
    if (missing.length) problems.push(`Missing credentials: ${missing.join(", ")}. Requests that need them go out without auth until you add them (picked up live).`);
    return { needSignIn, problems };
  }

  release() {
    for (const conn of this.acquired) this.host.connections.release(conn, this.host.id);
    this.acquired.clear();
    this.written.clear();
    for (const [, item] of this.signIns) if (item.state === "starting" || item.state === "waiting") this.finishCard(item, "cancelled", "The agent stopped");
  }

  /** Write a command connection's files and the combined env file into the sandbox home. */
  async writeMaterials(): Promise<string[]> {
    const container = this.host.container();
    if (!container) return [];
    const problems: string[] = [];
    const env: string[] = [];
    for (const conn of this.commandConnections()) {
      const { files, env: vars } = this.host.connections.materials(conn);
      const ph = (ref: string, field?: string) => this.placeholderFor(ref, field);
      for (const f of files) {
        const target = `${HOME}/${f.path.slice(2)}`;
        const content = this.host.connections.render(conn, f.content, ph);
        if (this.written.get(target) === sha(content)) continue;
        const r = await this.host.runtime.exec(
          container,
          ["sh", "-c", 'd=$(dirname -- "$1") && mkdir -p -- "$d" && r=$(realpath -m -- "$1") && case "$r" in /home/agent/*) ;; *) echo "resolves outside the home directory" >&2; exit 3;; esac && umask 077 && cat > "$r" && chmod "$2" "$r"', "sh", target, f.mode ?? "0600"],
          { input: content, timeoutMs: 30_000 },
        );
        if (r.code === 0) this.written.set(target, sha(content));
        else problems.push(`Could not write ${f.path} for ${conn}: ${r.stderr.trim() || `exit ${r.code}`}`);
      }
      for (const [k, v] of Object.entries(vars)) env.push(`export ${k}=${shellQuote(this.host.connections.render(conn, v, ph))}`);
    }
    const envText = `# Written by Swan from connection wrappers; placeholders only.\n${env.join("\n")}\n`;
    if (this.written.get(ENV_FILE) !== sha(envText)) {
      const r = await this.host.runtime.exec(container, ["sh", "-c", 'mkdir -p "$(dirname "$1")" && cat > "$1"', "sh", ENV_FILE], { input: envText, timeoutMs: 30_000 });
      if (r.code === 0) this.written.set(ENV_FILE, sha(envText));
      else problems.push(`Could not write the connection environment: ${r.stderr.trim()}`);
    }
    return problems;
  }

  // ---------- sign-in ----------

  private finishCard(item: SignInItem, state: SignInItem["state"], message?: string) {
    item.state = state;
    item.code = undefined;
    item.message = message;
    this.host.syncItem(item);
  }

  /** Show a sign-in card and start (or join) the connection's login. Resolves with its final state. */
  signIn(conn: string): Promise<ConnectionState> {
    let item = this.signIns.get(conn);
    if (!item || item.state === "done" || item.state === "cancelled" || item.state === "failed") {
      item = { kind: "sign_in", id: randomId("it_", 6), ts: nowIso(), connection: conn, state: "starting" };
      this.signIns.set(conn, item);
      this.host.addItem(item);
    }
    const card = item;
    const p = this.host.connections.login(conn);
    this.syncSignIns();
    return p.then(
      (state) => {
        const st = this.host.connections.status().find((s) => s.name === conn);
        if (state === "ready") this.finishCard(card, "done", st?.message ?? "Signed in");
        else if (st?.message === "Sign-in cancelled") this.finishCard(card, "cancelled", "Sign-in cancelled");
        else this.finishCard(card, "failed", st?.message ?? "Sign-in failed");
        return state;
      },
      (e) => {
        this.finishCard(card, "failed", errMsg(e));
        return "error" as const;
      },
    );
  }

  /** Copy the device code onto open cards once the wrapper printed it. */
  syncSignIns() {
    for (const [conn, item] of this.signIns) {
      if (item.state !== "starting" && item.state !== "waiting") continue;
      const code = this.host.connections.status().find((s) => s.name === conn)?.signIn;
      if (code && item.code?.userCode !== code.userCode) {
        item.code = code;
        item.state = "waiting";
        this.host.syncItem(item);
      }
    }
  }

  /** A check or renewal found the connection signed out (not the user signing out). */
  onNeedsSignIn(conn: string) {
    if (!this.host.container() || !this.commandConnections().includes(conn)) return;
    if (this.signIns.get(conn)?.state.match(/starting|waiting/)) return;
    this.host.notice("warn", `${conn} needs a new sign-in; requests that use it fail until then.`);
    void this.signIn(conn);
  }

  // ---------- rules ----------

  /** An `ask` rule matched: pause the request on a card. */
  requestUse(ref: string, v: Verdict): Promise<boolean> {
    const key = `${ref} ${ruleKey(v.api, v.rule ?? "")}`;
    if (this.refused.has(key)) return Promise.resolve(false);
    const inflight = this.asking.get(key);
    if (inflight) return inflight;
    const id = randomId("cred_", 8);
    const name = ref.slice(ref.indexOf("/") + 1);
    const item: ToolItem = {
      kind: "tool_call",
      id,
      ts: nowIso(),
      name: "credential_use",
      source: "builtin",
      input: { credential: ref, operation: v.op.description, rule: v.rule, api: v.api },
      inputPreview: `${v.op.description} with ${name}`,
      status: "pending_approval",
      approvalReason: `ask: ${v.rule}`,
    };
    this.host.addItem(item);
    const p = this.host
      .waitApproval(id, { sessionId: this.host.id, personaId: this.host.personaId, toolUseId: id, name: "credential_use", inputPreview: item.inputPreview, rule: `ask: ${v.rule}`, since: item.ts }, 10 * 60_000)
      .then(async (d) => {
        this.asking.delete(key);
        const done = (ok: boolean, status: ToolItem["status"], output: string) => {
          Object.assign(item, { status, output, approvalReason: undefined });
          this.host.syncItem(item);
          return ok;
        };
        if (!d) return done(false, "interrupted", "No decision; the request went out without the credential.");
        if (d.decision === "deny") {
          this.refused.add(key);
          return done(false, "denied", `Denied. Requests matching "${v.rule}" go out without ${name} until the agent is stopped.`);
        }
        if (d.decision === "allow") return done(true, "done", "Allowed this request.");
        const allowance = `${CRED_ALLOWANCE}${key}`;
        if (!this.host.allowances().includes(allowance)) this.host.setAllowances([...this.host.allowances(), allowance]);
        if (d.decision === "allow_always") {
          try {
            await this.host.personas.promoteAskRule(this.host.personaId, ref, v.api, v.rule ?? "");
            return done(true, "done", `Allowed, and "${v.rule}" is now an allow rule for ${name}.`);
          } catch (e) {
            this.host.notice("error", `Could not save the rule: ${errMsg(e)}`);
          }
        }
        return done(true, "done", `Allowed requests matching "${v.rule}" until the agent is stopped.`);
      });
    this.asking.set(key, p);
    return p;
  }

  /** A request went out without its credential: one notice per credential and rule per minute. */
  blockedRequest(ref: string, v: Verdict) {
    const key = `${ref}|${v.rule ?? ""}`;
    const prev = this.blocked.get(key);
    if (prev && Date.now() - Date.parse(prev.ts) < 60_000) {
      prev.count++;
      prev.operations = [...prev.operations.filter((o) => o !== v.op.description), v.op.description].slice(-5);
      prev.suggestion = v.op.suggestion;
      this.host.syncItem(prev);
      return;
    }
    const item: BlockedItem = { kind: "credential_blocked", id: randomId("it_", 6), ts: nowIso(), credential: ref, api: v.api, rule: v.rule, operations: [v.op.description], count: 1, suggestion: v.op.suggestion };
    this.blocked.set(key, item);
    this.host.addItem(item);
  }

  /** Stop / interrupt: forget "deny until stopped". Pending asks are resolved by the session. */
  reset() {
    this.refused.clear();
  }

  // ---------- agent tools ----------

  statusText(): string {
    const conns = this.connectionNames();
    if (!conns.length) return "This persona uses no connections.";
    const statuses = this.host.connections.status();
    const named = new Set(this.namedRefs());
    return conns
      .map((conn) => {
        const st = statuses.find((s) => s.name === conn)!;
        const lines = [`${conn} (${st.type}): ${st.state}${st.message ? ` — ${st.message}` : ""}${st.expiresAt ? `; expires ${st.expiresAt}` : ""}`];
        for (const c of st.credentials.filter((x) => named.has(x.ref))) {
          const how = c.kind === "static" ? `$${c.env}` : c.kind === "aws-sigv4" ? "AWS keys in ~/.aws/credentials" : c.kind;
          lines.push(`  - ${c.name} (${how}) → ${c.hosts.join(", ")}${c.present ? "" : " [not usable now]"}`);
        }
        if (st.type === "command") {
          const { files, env } = this.host.connections.materials(conn);
          if (files.length) lines.push(`  files: ${files.map((f) => f.path).join(", ")}`);
          if (Object.keys(env).length) lines.push(`  env: ${Object.keys(env).join(", ")}`);
        }
        return lines.join("\n");
      })
      .join("\n");
  }

  tools(): ToolDef[] {
    if (!this.connectionNames().length) return [];
    return [
      zodTool({
        name: "connection_status",
        defaultAllow: { rule: "connection tool" },
        description: "State, expiry, credential names and hosts for this persona's connections. Never shows values.",
        schema: z.object({}),
        preview: () => "connections",
        run: async () => ({ text: this.statusText() }),
      }),
      zodTool({
        name: "connection_login",
        defaultAllow: { rule: "connection tool" },
        description:
          "Ask the user to sign in to a command connection (for example after its credentials expired). Shows them a sign-in card; you never see the code. Returns when they finish, cancel, or it fails.",
        schema: z.object({ connection: z.string().describe("Connection name, as listed by connection_status") }),
        preview: (i) => i.connection,
        primaryArg: (i) => i.connection,
        run: async (i, ctx) => {
          if (!this.commandConnections().includes(i.connection)) return { text: `"${i.connection}" is not a command connection of this persona.`, isError: true };
          const st = this.host.connections.status().find((s) => s.name === i.connection);
          if (st?.state === "ready") return { text: `${i.connection} is already signed in.` };
          const wait = this.signIn(i.connection);
          const aborted = new Promise<"aborted">((r) => ctx.signal.addEventListener("abort", () => r("aborted"), { once: true }));
          const state = await Promise.race([wait, aborted]);
          if (state === "aborted") return { text: "Interrupted while waiting for the sign-in.", isError: true };
          if (state === "ready") {
            await this.writeMaterials();
            return { text: `${i.connection} is signed in. Its files and environment are in place; new shells pick up the environment.` };
          }
          const msg = this.host.connections.status().find((s) => s.name === i.connection)?.message;
          return { text: `Not signed in (${state}${msg ? `: ${msg}` : ""}).`, isError: true };
        },
      }),
    ];
  }

  /** Lines for the system prompt. */
  promptLines(): string[] {
    const named = this.namedRefs();
    if (!named.length && !this.commandConnections().length) return [];
    const lines = [
      "- Credentials: you never see real values. The proxy swaps placeholders for real values only on HTTPS requests to each credential's hosts, and only for requests this persona's rules allow; anything else goes out with the placeholder and fails (the response has an X-Swan-Denied header and the user is told). Use the variables and files exactly as you would the real thing; do not try to reveal or transform the values, and do not retry a denied request unchanged.",
    ];
    for (const ref of named) {
      const c = this.host.connections.resolve(ref);
      if (c?.kind === "static") lines.push(`  - $${c.env} (${ref}) → ${c.hosts.join(", ") || "(not usable from the sandbox)"}`);
    }
    for (const conn of this.commandConnections()) {
      const { files, env } = this.host.connections.materials(conn);
      const st = this.host.connections.status().find((s) => s.name === conn);
      lines.push(
        `  - Connection ${conn} (${st?.state ?? "unknown"}): ${files.length ? `files ${files.map((f) => f.path).join(", ")}` : "no files yet"}${Object.keys(env).length ? `; env ${Object.keys(env).join(", ")} (set in new shells)` : ""}. If it needs a sign-in, call connection_login; connection_status shows its state.`,
      );
    }
    return lines;
  }
}
