import { promises as fs } from "node:fs";
import path from "node:path";
import chokidar from "chokidar";
import YAML from "yaml";
import type { ConnectionCredentialStatus, ConnectionState, ConnectionStatus, CredentialKind, CredentialUpsert, DeviceCode } from "@ph/shared";
import type { SecretStore } from "../secrets.js";
import { paths, type Settings } from "../settings.js";
import { networkEnv } from "../network.js";
import { TypedEmitter, debounce, errMsg, exists, log, nowIso, sha256Hex, writeFileAtomic } from "../util.js";
import {
  CONNECTION_NAME,
  CREDENTIAL_NAME,
  CREDENTIAL_REF,
  ConnectionsSchema,
  credentialRefs,
  hostWithin,
  parseRefMatch,
  type CommandConnectionConfig,
  type ConnectionsConfig,
  type ResultLine,
  type WrapperFile,
} from "./config.js";
import { runWrapper, type Verb } from "./runner.js";

/** One credential as the proxy and sessions see it. Values never leave the host. */
export interface ResolvedCredential {
  ref: string; // connection/name
  connection: string;
  name: string;
  kind: CredentialKind;
  hosts: string[];
  inject?: { header: string; format: string };
  substituteInBody?: boolean;
  env?: string; // static: sandbox variable for the placeholder
  value?: string;
  username?: string;
  aws?: { accessKeyId: string; secretAccessKey: string; sessionToken?: string };
  ca?: string;
  expiresAt?: number;
  fingerprint: string | null;
  source: "yaml" | "env" | "command" | null;
  updatedAt: string | null;
}

interface CommandState {
  state: ConnectionState;
  message: string | null;
  creds: Map<string, ResolvedCredential>;
  files: WrapperFile[];
  env: Record<string, string>;
  expiresAt: number | null;
  lastRenewedAt: string | null;
  signIn: DeviceCode | null;
  inflight: { verb: Verb; promise: Promise<ConnectionState>; abort: AbortController } | null;
  timer: NodeJS.Timeout | null;
  users: Set<string>; // running sessions that use the connection
  lastAuthRenew: number;
  stale: boolean; // must be re-checked before use
}

type Events = {
  changed: [string[]]; // refs whose value, hosts or expiry changed
  updated: []; // anything in status() changed
  materials: [string]; // a command connection's files or env changed
  stateChanged: [string, ConnectionState];
  needsSignIn: [string]; // a check or renewal (not the user) found the sign-in gone
  configLoaded: [];
  configError: [string];
};

const LOGIN_TIMEOUT_MS = 10 * 60_000;
const splitRef = (ref: string) => {
  const i = ref.indexOf("/");
  return i < 0 ? null : { connection: ref.slice(0, i), name: ref.slice(i + 1) };
};

/**
 * Every credential an agent can use comes from a connection in config.yaml: `static` ones read
 * values from the secret store, `command` ones run a wrapper (protocol v1) on the host and keep
 * what it returns in memory. Renewal is shared by every session that uses a connection.
 */
export class ConnectionManager extends TypedEmitter<Events> {
  private config: ConnectionsConfig = {};
  private configError: string | null = null;
  private cmd = new Map<string, CommandState>();
  private signatures = new Map<string, string>();
  /** Persona ids per credential ref; set by the persona store. */
  usedBy: () => Map<string, string[]> = () => new Map();

  constructor(
    private secrets: SecretStore,
    private settings: Settings,
  ) {
    super();
    secrets.on("changed", () => this.recompute());
  }

  // ---------- configuration ----------

  async loadConfig(): Promise<void> {
    let raw: unknown;
    try {
      raw = ((YAML.parse(await fs.readFile(paths.config, "utf8")) ?? {}) as Record<string, unknown>).connections ?? {};
    } catch (e) {
      return this.reportConfigError(`config.yaml: ${errMsg(e)}`);
    }
    const badName = raw && typeof raw === "object" ? Object.keys(raw).find((k) => !CONNECTION_NAME.test(k)) : undefined;
    if (badName !== undefined) return this.reportConfigError(`config.yaml connections: "${badName}": connection names are lowercase letters, digits and dashes (up to 32)`);
    const parsed = ConnectionsSchema.safeParse(raw);
    if (!parsed.success) {
      const i = parsed.error.issues[0];
      return this.reportConfigError(`config.yaml connections.${i?.path.join(".")}: ${i?.message}`);
    }
    const before = this.config;
    this.config = parsed.data;
    this.configError = null;
    for (const [name, st] of this.cmd) {
      const c = this.config[name];
      if (!c || c.type !== "command") {
        st.inflight?.abort.abort();
        if (st.timer) clearTimeout(st.timer);
        this.cmd.delete(name);
      } else if (JSON.stringify(before[name]) !== JSON.stringify(c)) {
        st.stale = true;
        if (st.users.size) void this.runVerb(name, "status");
      }
    }
    this.recompute();
    this.emit("configLoaded");
    this.emit("updated");
  }

  private reportConfigError(msg: string) {
    // Keep the last good set.
    this.configError = msg;
    log.error("connections", msg);
    this.emit("configError", msg);
    this.emit("updated");
  }

  watch(): void {
    const reload = debounce(() => void this.loadConfig(), 150);
    chokidar.watch(paths.config, { ignoreInitial: true, awaitWriteFinish: { stabilityThreshold: 80 } }).on("all", reload);
  }

  get error() {
    return this.configError;
  }

  names(): string[] {
    return Object.keys(this.config).sort();
  }

  configOf(name: string) {
    return this.config[name];
  }

  /** Credential names a connection has now (a command connection's are known once it ran). */
  credentialNames(connection: string): string[] {
    const c = this.config[connection];
    if (!c) return [];
    if (c.type === "static") return Object.keys(c.credentials);
    return [...(this.cmd.get(connection)?.creds.keys() ?? [])];
  }

  // ---------- values ----------

  resolve(ref: string): ResolvedCredential | undefined {
    const r = splitRef(ref);
    const c = r && this.config[r.connection];
    if (!r || !c) return undefined;
    if (c.type === "command") return this.cmd.get(r.connection)?.creds.get(r.name);
    const cc = c.credentials[r.name];
    if (!cc) return undefined;
    const e = this.secrets.get(ref);
    return {
      ref,
      connection: r.connection,
      name: r.name,
      kind: "static",
      hosts: cc.hosts,
      inject: cc.inject,
      substituteInBody: cc.substituteInBody,
      env: cc.env ?? r.name,
      value: e?.value || undefined,
      fingerprint: e?.value ? e.fingerprint : null,
      source: e?.value ? e.source : null,
      updatedAt: e?.value ? e.updatedAt : null,
    };
  }

  /** The credential if it has a value, hosts, and has not expired. */
  usable(ref: string): ResolvedCredential | undefined {
    const c = this.resolve(ref);
    if (!c || !c.hosts.length || (!c.value && !c.aws)) return undefined;
    if (c.expiresAt !== undefined && c.expiresAt <= Date.now()) return undefined;
    return c;
  }

  isExpired(ref: string): boolean {
    const c = this.resolve(ref);
    return !!c?.expiresAt && c.expiresAt <= Date.now();
  }

  /** Real values to scrub from logs and responses. */
  secretValues(c: ResolvedCredential): string[] {
    return [c.value, c.aws?.accessKeyId, c.aws?.secretAccessKey, c.aws?.sessionToken].filter((v): v is string => !!v);
  }

  private signature(c: ResolvedCredential | undefined) {
    return c ? `${c.fingerprint}|${c.hosts.join(",")}|${JSON.stringify(c.inject ?? null)}|${c.expiresAt ?? ""}` : "";
  }

  /** Diff every credential against the last view and announce what changed. */
  private recompute() {
    const next = new Map<string, string>();
    for (const conn of this.names()) for (const name of this.credentialNames(conn)) next.set(`${conn}/${name}`, this.signature(this.resolve(`${conn}/${name}`)));
    const changed = [...next].filter(([k, v]) => this.signatures.get(k) !== v).map(([k]) => k);
    for (const k of this.signatures.keys()) if (!next.has(k)) changed.push(k);
    this.signatures = next;
    if (changed.length) {
      this.emit("changed", changed);
      this.emit("updated");
    }
  }

  // ---------- status ----------

  status(): ConnectionStatus[] {
    const used = this.usedBy();
    return this.names().map((name) => {
      const c = this.config[name];
      const creds: ConnectionCredentialStatus[] = this.credentialNames(name).map((n) => {
        const ref = `${name}/${n}`;
        const r = this.resolve(ref)!;
        return {
          name: n,
          ref,
          kind: r.kind,
          present: !!this.usable(ref),
          source: r.source,
          hosts: r.hosts,
          injects: !!r.inject,
          ...(r.env ? { env: r.env } : {}),
          fingerprint: r.fingerprint,
          expiresAt: r.expiresAt ? new Date(r.expiresAt).toISOString() : null,
          updatedAt: r.updatedAt,
          usedBy: used.get(ref) ?? [],
        };
      });
      const usedBy = [...new Set(creds.flatMap((x) => x.usedBy).concat([...used].filter(([ref]) => ref.startsWith(`${name}/`)).flatMap(([, ids]) => ids)))].sort();
      if (c.type === "static") {
        const missing = creds.filter((x) => !x.present).map((x) => x.name);
        return {
          name,
          type: "static",
          state: missing.length ? "incomplete" : "ready",
          message: missing.length ? `No value for ${missing.join(", ")}` : null,
          hosts: [...new Set(creds.flatMap((x) => x.hosts))],
          expiresAt: null,
          lastRenewedAt: null,
          signIn: null,
          credentials: creds,
          usedBy,
        };
      }
      const st = this.cmd.get(name);
      return {
        name,
        type: "command",
        state: st?.state ?? "unknown",
        message: st?.message ?? null,
        hosts: c.hosts,
        command: c.command,
        expiresAt: st?.expiresAt ? new Date(st.expiresAt).toISOString() : null,
        lastRenewedAt: st?.lastRenewedAt ?? null,
        signIn: st?.signIn ?? null,
        credentials: creds,
        usedBy,
      };
    });
  }

  // ---------- command connections ----------

  private stateOf(conn: string): CommandState {
    let st = this.cmd.get(conn);
    if (!st) {
      st = { state: "unknown", message: null, creds: new Map(), files: [], env: {}, expiresAt: null, lastRenewedAt: null, signIn: null, inflight: null, timer: null, users: new Set(), lastAuthRenew: 0, stale: true };
      this.cmd.set(conn, st);
    }
    return st;
  }

  private commandConfig(conn: string): CommandConnectionConfig {
    const c = this.config[conn];
    if (!c) throw new Error(`connection "${conn}" is not defined in config.yaml`);
    if (c.type !== "command") throw new Error(`connection "${conn}" is a static connection`);
    return c;
  }

  /** Make sure a command connection has been checked; returns its state. Static connections are always "ready". */
  async ensure(conn: string): Promise<ConnectionState> {
    const c = this.config[conn];
    if (!c) return "error";
    if (c.type === "static") return "ready";
    const st = this.stateOf(conn);
    if (st.inflight) return st.inflight.promise;
    if (st.state === "ready" && !st.stale && (!st.expiresAt || st.expiresAt > Date.now())) return "ready";
    if (st.state === "ready" && st.expiresAt && st.expiresAt <= Date.now()) return this.runVerb(conn, "renew");
    return this.runVerb(conn, "status");
  }

  login(conn: string): Promise<ConnectionState> {
    this.commandConfig(conn);
    return this.runVerb(conn, "login");
  }

  renew(conn: string): Promise<ConnectionState> {
    this.commandConfig(conn);
    const st = this.stateOf(conn);
    return this.runVerb(conn, st.creds.size ? "renew" : "status");
  }

  /** Stop a sign-in that is waiting on the user. */
  cancel(conn: string) {
    const st = this.cmd.get(conn);
    if (st?.inflight?.verb === "login") st.inflight.abort.abort();
  }

  /** Forget the values Swan holds. The wrapper keeps its own state; the next check may sign in again. */
  logout(conn: string) {
    this.commandConfig(conn);
    const st = this.stateOf(conn);
    st.inflight?.abort.abort();
    st.creds = new Map();
    st.files = [];
    st.env = {};
    st.expiresAt = null;
    st.state = "login_required";
    st.message = "Signed out of Swan";
    st.stale = false;
    if (st.timer) clearTimeout(st.timer);
    this.emit("materials", conn);
    this.emit("stateChanged", conn, st.state);
    this.recompute();
    this.emit("updated");
  }

  /** A running session uses the connection: keep it renewed. */
  acquire(conn: string, sessionId: string) {
    if (this.config[conn]?.type !== "command") return;
    const st = this.stateOf(conn);
    st.users.add(sessionId);
    this.schedule(conn);
  }

  release(conn: string, sessionId: string) {
    this.cmd.get(conn)?.users.delete(sessionId);
  }

  /** A bound host answered 401/403: renew, at most once a minute. */
  authFailed(conn: string) {
    if (this.config[conn]?.type !== "command") return;
    const st = this.stateOf(conn);
    if (Date.now() - st.lastAuthRenew < 60_000 || st.inflight) return;
    st.lastAuthRenew = Date.now();
    void this.runVerb(conn, st.creds.size ? "renew" : "status");
  }

  materials(conn: string): { files: WrapperFile[]; env: Record<string, string> } {
    const st = this.cmd.get(conn);
    return { files: st?.files ?? [], env: st?.env ?? {} };
  }

  private runVerb(conn: string, verb: Verb): Promise<ConnectionState> {
    const st = this.stateOf(conn);
    if (st.inflight) {
      if (st.inflight.verb === verb || st.inflight.verb === "login") return st.inflight.promise;
      return st.inflight.promise.then((s) => (verb === "login" && s !== "ready" ? this.runVerb(conn, verb) : s));
    }
    const abort = new AbortController();
    const promise = this.invoke(conn, verb, abort.signal).finally(() => {
      if (st.inflight?.promise === promise) st.inflight = null;
    });
    st.inflight = { verb, promise, abort };
    return promise;
  }

  private wrapperEnv(): NodeJS.ProcessEnv {
    // The user's environment minus Swan's own secrets.
    const drop = new Set<string>(["PH_HOME", "ANTHROPIC_API_KEY", "OPENAI_API_KEY", "COPILOT_GITHUB_TOKEN"]);
    for (const p of Object.values(this.settings.providers)) if (p.apiKeySecret) drop.add(p.apiKeySecret);
    for (const e of this.secrets.all()) drop.add(e.name);
    return { ...Object.fromEntries(Object.entries(process.env).filter(([k]) => !drop.has(k))), ...networkEnv() };
  }

  private async invoke(conn: string, verb: Verb, signal: AbortSignal): Promise<ConnectionState> {
    const cfg = this.commandConfig(conn);
    const st = this.stateOf(conn);
    const dir = path.join(paths.connections, conn);
    await fs.mkdir(dir, { recursive: true, mode: 0o700 });
    const prevState = st.state;
    if (verb === "login") {
      st.state = "signing_in";
      st.signIn = null;
      st.message = null;
      this.emit("stateChanged", conn, st.state);
      this.emit("updated");
    }
    const out = await runWrapper({
      connection: conn,
      command: cfg.command,
      verb,
      cwd: dir,
      env: this.wrapperEnv(),
      timeoutMs: verb === "login" ? LOGIN_TIMEOUT_MS : cfg.timeout,
      signal,
      onDeviceCode: (code) => {
        st.signIn = code;
        this.emit("updated");
      },
    });
    const values = (out.result.credentials ?? []).flatMap((c) => (c.kind === "aws-sigv4" ? [c.accessKeyId, c.secretAccessKey, c.sessionToken ?? ""] : [c.value]));
    for (const c of st.creds.values()) values.push(...this.secretValues(c));
    const redact = (s: string | undefined | null) => {
      let t = s ?? "";
      for (const v of values) if (v && v.length >= 4) t = t.split(v).join("[redacted]");
      return t;
    };
    if (out.stderr) {
      const logFile = path.join(dir, "wrapper.log");
      await fs.appendFile(logFile, `--- ${nowIso()} ${verb}\n${redact(out.stderr).slice(-16_000)}\n`, { mode: 0o600 }).catch(() => {});
    }
    let r: ResultLine = out.result;
    const problem = r.state === "ready" ? this.checkResult(conn, cfg, r) : null;
    if (problem) {
      log.warn("connections", `${conn}: rejected wrapper output: ${problem}`);
      r = { type: "result", state: "error", message: `Swan rejected the wrapper's output: ${problem}` };
    }
    st.signIn = null;
    if (r.state === "ready") this.apply(conn, st, r, redact(r.message) || null);
    else if (signal.aborted && verb === "login") {
      st.state = st.creds.size ? prevState : "login_required";
      st.message = "Sign-in cancelled";
    } else {
      st.state = r.state;
      st.message = redact(r.message) || (r.state === "login_required" ? "Sign-in required" : "The wrapper failed");
      st.stale = false;
      if (r.state === "login_required" && verb !== "login") this.emit("needsSignIn", conn);
    }
    if (st.state !== "ready") log.info("connections", `${conn} ${verb}: ${st.state}${st.message ? ` (${st.message})` : ""}`);
    this.schedule(conn);
    this.emit("stateChanged", conn, st.state);
    this.recompute();
    this.emit("updated");
    return st.state;
  }

  /** What the schema cannot check: host bounds, references, and real values in files. */
  private checkResult(conn: string, cfg: CommandConnectionConfig, r: ResultLine): string | null {
    const creds = r.credentials ?? [];
    const names = new Set<string>();
    for (const c of creds) {
      if (names.has(c.name)) return `credential "${c.name}" appears twice`;
      names.add(c.name);
      for (const h of c.hosts) if (!cfg.hosts.some((b) => hostWithin(h, b))) return `credential "${c.name}" host ${h} is outside the connection's hosts (${cfg.hosts.join(", ")})`;
    }
    const byName = new Map(creds.map((c) => [c.name, c] as const));
    const values = creds.flatMap((c) => (c.kind === "aws-sigv4" ? [c.accessKeyId, c.secretAccessKey, c.sessionToken ?? ""] : [c.value])).filter((v) => v.length >= 8);
    const checkText = (where: string, text: string): string | null => {
      for (const ref of credentialRefs(text)) {
        if (ref.legacy) return `${where} uses {{secret:…}}; wrappers use {{credential:NAME}}`;
        if (ref.connection && ref.connection !== conn) return `${where} refers to another connection (${ref.connection})`;
        const c = byName.get(ref.name);
        if (!c) return `${where} refers to unknown credential "${ref.name}"`;
        const awsField = ref.field === "accessKeyId" || ref.field === "secretAccessKey" || ref.field === "sessionToken";
        if (c.kind === "aws-sigv4" && !awsField) return `${where}: aws-sigv4 credential "${ref.name}" needs .accessKeyId, .secretAccessKey or .sessionToken`;
        if (c.kind !== "aws-sigv4" && awsField) return `${where}: .${ref.field} only fits an aws-sigv4 credential`;
        if ((ref.field === "username" || ref.basic) && c.kind !== "basic") return `${where}: ${ref.basic ? "|basic" : ".username"} needs a basic credential`;
      }
      for (const v of values) if (text.includes(v)) return `${where} contains a credential value; use {{credential:NAME}} instead`;
      return null;
    };
    const paths = new Set<string>();
    for (const f of r.files ?? []) {
      if (paths.has(f.path)) return `file ${f.path} appears twice`;
      paths.add(f.path);
      const p = checkText(`file ${f.path}`, f.content);
      if (p) return p;
    }
    for (const [k, v] of Object.entries(r.env ?? {})) {
      const p = checkText(`env ${k}`, v);
      if (p) return p;
    }
    return null;
  }

  private apply(conn: string, st: CommandState, r: ResultLine, message: string | null) {
    const creds = new Map<string, ResolvedCredential>();
    for (const c of r.credentials ?? []) {
      const prev = st.creds.get(c.name);
      const secret = c.kind === "aws-sigv4" ? `${c.accessKeyId}:${c.secretAccessKey}:${c.sessionToken ?? ""}` : c.kind === "basic" ? `${c.username}:${c.value}` : c.value;
      const fingerprint = sha256Hex(secret).slice(0, 8);
      creds.set(c.name, {
        ref: `${conn}/${c.name}`,
        connection: conn,
        name: c.name,
        kind: c.kind,
        hosts: c.hosts,
        inject: c.kind === "header" ? c.inject : c.kind === "bearer" ? { header: "Authorization", format: "Bearer {value}" } : undefined,
        value: c.kind === "aws-sigv4" ? undefined : c.value,
        username: c.kind === "basic" ? c.username : undefined,
        aws: c.kind === "aws-sigv4" ? { accessKeyId: c.accessKeyId, secretAccessKey: c.secretAccessKey, sessionToken: c.sessionToken } : undefined,
        ca: c.ca,
        expiresAt: c.expiresAt ? Date.parse(c.expiresAt) : undefined,
        fingerprint,
        source: "command",
        updatedAt: prev?.fingerprint === fingerprint ? prev.updatedAt : nowIso(),
      });
    }
    const materialsBefore = JSON.stringify([st.files, st.env]);
    st.creds = creds;
    st.files = r.files ?? [];
    st.env = r.env ?? {};
    const expiries = [...creds.values()].flatMap((c) => (c.expiresAt ? [c.expiresAt] : []));
    st.expiresAt = r.expiresAt ? Date.parse(r.expiresAt) : expiries.length ? Math.min(...expiries) : null;
    st.state = "ready";
    st.message = message;
    st.lastRenewedAt = nowIso();
    st.stale = false;
    if (JSON.stringify([st.files, st.env]) !== materialsBefore) this.emit("materials", conn);
  }

  private schedule(conn: string) {
    const st = this.cmd.get(conn);
    const cfg = this.config[conn];
    if (!st || cfg?.type !== "command") return;
    if (st.timer) clearTimeout(st.timer);
    st.timer = null;
    let delay: number | null = null;
    if (st.state === "ready" && st.expiresAt) delay = Math.max(5_000, st.expiresAt - cfg.renewBefore - Date.now());
    else if (st.state === "error" && st.users.size) delay = 60_000;
    if (delay === null) return;
    st.timer = setTimeout(() => {
      st.timer = null;
      if (st.users.size) void this.runVerb(conn, st.creds.size ? "renew" : "status");
      else st.stale = true;
    }, Math.min(delay, 2 ** 31 - 1));
    st.timer.unref();
  }

  /**
   * Expand `{{credential:NAME…}}` in a wrapper's file or env template. `placeholder(ref, field)`
   * gives this session's stand-in; real values are never written.
   */
  render(conn: string, template: string, placeholder: (ref: string, field?: string) => string): string {
    return template.replace(CREDENTIAL_REF, (...m) => {
      const ref = parseRefMatch(m as unknown as RegExpMatchArray);
      if (ref.legacy || (ref.connection && ref.connection !== conn)) return "";
      const c = this.resolve(`${conn}/${ref.name}`);
      if (!c) return "";
      if (ref.basic) return Buffer.from(`${c.username ?? ""}:${placeholder(c.ref)}`).toString("base64");
      if (ref.field === "username") return c.username ?? "";
      if (c.kind === "aws-sigv4") return ref.field && ref.field !== "value" ? placeholder(c.ref, ref.field) : "";
      return placeholder(c.ref);
    });
  }

  /** Host-side use (http MCP headers): real values for refs in `allowed`. */
  resolveHost(template: string, allowed: ReadonlySet<string>): { text: string; missing: string[]; used: string[] } {
    const missing: string[] = [];
    const used: string[] = [];
    const text = template.replace(CREDENTIAL_REF, (...m) => {
      const r = parseRefMatch(m as unknown as RegExpMatchArray);
      const ref = r.legacy ? [...allowed].find((x) => x.endsWith(`/${r.name}`)) : r.connection ? `${r.connection}/${r.name}` : undefined;
      if (!ref || !allowed.has(ref)) {
        missing.push(ref ?? r.name);
        return "";
      }
      used.push(ref);
      const c = this.usable(ref);
      const v = c ? (r.field === "username" ? c.username : r.field && c.aws ? c.aws[r.field as "accessKeyId"] : c.value) : undefined;
      if (v === undefined) missing.push(ref);
      return v ?? "";
    });
    return { text, missing, used };
  }

  // ---------- static connections (edited from Settings) ----------

  private async editConfig(fn: (doc: YAML.Document) => void) {
    const doc = YAML.parseDocument((await exists(paths.config)) ? await fs.readFile(paths.config, "utf8") : "{}");
    fn(doc);
    await writeFileAtomic(paths.config, doc.toString({ lineWidth: 0 }), 0o600);
    await this.loadConfig();
  }

  async upsertStatic(conn: string, name: string, u: CredentialUpsert): Promise<void> {
    if (!CONNECTION_NAME.test(conn)) throw new Error("connection names are lowercase letters, digits and dashes (up to 32)");
    if (!CREDENTIAL_NAME.test(name)) throw new Error("credential names are letters, digits, _ and - (up to 64)");
    const existing = this.config[conn];
    if (existing && existing.type !== "static") throw new Error(`"${conn}" is a command connection; its credentials come from its wrapper`);
    const cred = existing?.credentials[name];
    if (!cred && !u.hosts?.length) throw new Error("a new credential needs at least one host");
    if (u.hosts || u.inject !== undefined || u.env !== undefined || !cred) {
      await this.editConfig((doc) => {
        if (!existing) doc.setIn(["connections", conn], doc.createNode({ type: "static", credentials: {} }));
        const entry: Record<string, unknown> = { ...(cred ?? {}) };
        if (u.hosts) entry.hosts = u.hosts.map((h) => h.trim().toLowerCase()).filter(Boolean);
        if (u.inject === null) delete entry.inject;
        else if (u.inject) entry.inject = u.inject;
        if (u.env === null) delete entry.env;
        else if (u.env) entry.env = u.env;
        const node = doc.createNode(entry);
        node.flow = false; // keep edits readable even when the existing block is written in flow style
        doc.setIn(["connections", conn, "credentials", name], node);
      });
      if (this.configError) throw new Error(this.configError);
    }
    if (u.value !== undefined) await this.secrets.setValue(`${conn}/${name}`, u.value);
  }

  async removeStatic(conn: string, name: string): Promise<void> {
    const c = this.config[conn];
    if (!c || c.type !== "static" || !c.credentials[name]) throw new Error("not found");
    await this.secrets.remove(`${conn}/${name}`);
    await this.editConfig((doc) => {
      doc.deleteIn(["connections", conn, "credentials", name]);
      if (Object.keys(c.credentials).length === 1) doc.deleteIn(["connections", conn]);
    });
  }
}
