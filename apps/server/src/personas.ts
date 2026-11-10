import { promises as fs, realpathSync, statSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import chokidar from "chokidar";
import YAML from "yaml";
import { z } from "zod";
import { TRACK_STATUSES } from "./tracker.js";
import type { Effort, FolderMount, McpServerSummary, PersonaConfigView, PersonaSummary, SaveResult } from "@ph/shared";
import { PersonaConnectionsSchema, credentialRefs } from "./connections/config.js";
import type { ConnectionManager } from "./connections/manager.js";
import { patternError } from "./connections/rules.js";
import { PH_HOME, paths, SandboxToolsSchema, type Settings } from "./settings.js";
import type { SkillRegistry } from "./skills.js";
import { TypedEmitter, debounce, errMsg, exists, expandHome, log, writeFileAtomic } from "./util.js";

export const PERSONA_ID = /^[a-z0-9][a-z0-9-]{0,62}$/;

const McpStdio = z.strictObject({
  command: z.string().min(1),
  args: z.array(z.string()).default([]),
  env: z.record(z.string(), z.string()).default({}),
  cwd: z.string().optional(),
  enabled: z.boolean().default(true),
});
const McpHttp = z.strictObject({
  url: z.url(),
  headers: z.record(z.string(), z.string()).default({}),
  enabled: z.boolean().default(true),
});

const DAYS = ["mon", "tue", "wed", "thu", "fri", "sat", "sun"] as const;
const TriggerName = z.string().regex(/^[a-z0-9][a-z0-9-]{0,40}$/, "expected lowercase letters, digits and dashes");
/** "90s", "5m", "2h", "1d": at least a minute. */
export const Interval = z
  .string()
  .regex(/^\d+[smhd]$/, "expected an interval such as 5m or 1h")
  .refine((v) => intervalMs(v) >= 60_000, "at least 1m");
export function intervalMs(v: string): number {
  const n = Number(v.slice(0, -1));
  return n * { s: 1000, m: 60_000, h: 3_600_000, d: 86_400_000 }[v.slice(-1) as "s"];
}

export const PersonaSchema = z.strictObject({
  name: z.string().min(1),
  description: z.string().default(""),
  model: z
    .strictObject({
      provider: z.string(),
      id: z.string(),
      effort: z.enum(["low", "medium", "high", "xhigh", "max"]).optional(),
      maxTokens: z.number().int().positive().optional(),
    })
    .optional(),
  instructions: z.string().default(""),
  folders: z
    .array(
      z.strictObject({
        path: z.string(),
        mount: z.string().optional(),
        mode: z.enum(["ro", "rw"]).default("ro"),
      }),
    )
    .default([]),
  skills: z.array(z.string()).default([]),
  mcpServers: z.record(z.string(), z.union([McpStdio, McpHttp])).default({}),
  // Which credentials the agent may use, and for what. A credential no rule names never reaches the sandbox.
  connections: PersonaConnectionsSchema.default({}),
  env: z.record(z.string(), z.string()).default({}),
  network: z
    .strictObject({
      allow: z.array(z.string()).default([]),
      // On the company network: also allowed, and may resolve to private addresses (10/8, 172.16/12, 192.168/16, fc00::/7).
      internal: z.array(z.string()).default([]),
      otherCredentials: z.array(z.string()).default([]), // credential hosts that may get credentials not from Swan
    })
    .prefault({}),
  subagents: z
    .strictObject({
      // Named sub-agents the model can delegate to: a fixed "provider/id" model, or "auto" (the model picks per task).
      agents: z
        .array(z.strictObject({ name: z.string().regex(/^[a-z0-9][a-z0-9-]{0,31}$/, "sub-agent names are lowercase letters, digits and dashes"), model: z.string().min(1) }))
        .default([]),
      maxBackground: z.number().int().min(0).max(32).default(4),
      maxTurns: z.number().int().min(1).max(1000).default(200),
    })
    .prefault({}),
  memory: z
    .strictObject({
      autoBrief: z.boolean().default(true), // load saved memories at the start of each context
      briefTokens: z.number().int().min(0).max(8000).default(1500),
      autoDream: z.boolean().default(true), // run /dream when a context rolls over and when a conversation goes quiet
    })
    .prefault({}),
  permissions: z
    .strictObject({
      default: z.enum(["allow", "ask", "deny"]).default("ask"),
      allow: z.array(z.string()).default([]),
      ask: z.array(z.string()).default([]),
      deny: z.array(z.string()).default([]),
    })
    .prefault({}),
  sandbox: z
    .strictObject({
      // An image of your own; Swan adds its layer (certificates, uid 1000 user) before running it.
      image: z.string().regex(/^[a-z0-9][a-z0-9._\-/:@]*$/i, "expected an image reference such as registry.example.com/team/dev-tools:2026.10").optional(),
      // Extra tools, built into this persona's image. No secrets here: they would stay in the image.
      tools: SandboxToolsSchema.strict().optional(),
      cpus: z.number().positive().default(2),
      memory: z.string().default("2g"),
      pidsLimit: z.number().int().positive().default(512),
      workdir: z.string().optional(),
    })
    .prefault({}),
  // Turns started without you: on a schedule, or when a watcher finds something new.
  schedules: z
    .array(
      z.strictObject({
        name: TriggerName,
        at: z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, "expected a time such as 09:00").optional(),
        days: z.array(z.enum(DAYS)).optional(),
        every: Interval.optional(),
        once: z.string().regex(/^\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}$/, "expected a local date and time such as 2026-11-03 17:00").optional(), // a reminder
        prompt: z.string().min(1),
      }).refine((s) => [s.at, s.every, s.once].filter(Boolean).length === 1, "give one of at (with optional days), every or once"),
    )
    .default([]),
  watchers: z
    .array(
      z.strictObject({
        name: TriggerName,
        every: Interval,
        get: z.string().min(1).optional(), // a URL template, fetched from the sandbox through the proxy
        run: z.array(z.string().min(1)).min(1).optional(), // a command in the sandbox that prints JSON lines
        forEach: z.strictObject({ tracker: z.strictObject({ kind: z.string().optional(), status: z.array(z.enum(TRACK_STATUSES)).default(["in_progress", "waiting"]) }) }).optional(),
        items: z.string().default(""), // path to the list in the JSON response; "" for the top level
        id: z.string().default("id"),
        changed: z.string().optional(),
        skip: z.record(z.string(), z.union([z.string(), z.number(), z.boolean()])).optional(),
        prompt: z.string().min(1),
      }).refine((w) => !!w.get !== !!w.run, "give either get or run"),
    )
    .default([]),
  // What a triggered turn may do. Anything that would ask is refused unless listed here.
  unattended: z
    .strictObject({
      allow: z.array(z.string()).default([]), // permission rules, as in permissions.allow
      credentials: z.record(z.string(), z.array(z.string())).default({}), // "conn/CRED": the ask rules allowed
      maxTurnsPerDay: z.number().int().min(0).max(1000).default(30),
    })
    .prefault({}),
});

export type PersonaConfig = z.infer<typeof PersonaSchema>;
export type McpStdioConfig = z.infer<typeof McpStdio>;
export type McpHttpConfig = z.infer<typeof McpHttp>;
export const isHttpMcp = (c: McpStdioConfig | McpHttpConfig): c is McpHttpConfig => "url" in c;

export interface Persona {
  id: string;
  file: string;
  yaml: string;
  config: PersonaConfig | null; // null when YAML/schema invalid
  folders: FolderMount[];
  errors: string[];
}

const FORBIDDEN_HOST_DIRS = ["/", "/System", "/Library", "/usr", "/bin", "/sbin", "/etc", "/private", "/var", "/Applications", "/Volumes", "/Users"];
const MOUNT_PATH = /^\/workspace(\/[A-Za-z0-9._-]+)+$/;

function isInside(child: string, parent: string) {
  const rel = path.relative(parent, child);
  return rel === "" || (!rel.startsWith("..") && !path.isAbsolute(rel));
}

/** Validate folders and turn them into mounts. Anything questionable is an error, not a warning. */
function resolveFolders(cfg: PersonaConfig, errors: string[]): FolderMount[] {
  const out: FolderMount[] = [];
  const seen = new Set<string>();
  const home = os.homedir();
  let phHomeReal = PH_HOME;
  try {
    phHomeReal = realpathSync(PH_HOME);
  } catch {}
  for (const f of cfg.folders) {
    const expanded = path.resolve(expandHome(f.path));
    let real: string;
    try {
      real = realpathSync(expanded);
      if (!statSync(real).isDirectory()) {
        errors.push(`folder ${f.path} is not a directory`);
        continue;
      }
    } catch {
      errors.push(`folder ${f.path} does not exist`);
      continue;
    }
    if (FORBIDDEN_HOST_DIRS.includes(real) || real === home) {
      errors.push(`folder ${f.path} is too broad to mount`);
      continue;
    }
    if (isInside(phHomeReal, real) || isInside(real, phHomeReal)) {
      errors.push(`folder ${f.path} overlaps the harness home (${PH_HOME}), which holds secrets`);
      continue;
    }
    if (!isInside(real, home)) {
      errors.push(`folder ${f.path} is outside your home directory; Podman on macOS only shares $HOME by default`);
      continue;
    }
    const mountPath = f.mount ?? `/workspace/${path.basename(real)}`;
    if (!MOUNT_PATH.test(mountPath)) {
      errors.push(`mount ${mountPath} must look like /workspace/<name>`);
      continue;
    }
    if (seen.has(mountPath)) {
      errors.push(`two folders map to ${mountPath}; set "mount:" explicitly`);
      continue;
    }
    seen.add(mountPath);
    out.push({ hostPath: real, mountPath, mode: f.mode });
  }
  return out;
}

type Events = { changed: [] };

export class PersonaStore extends TypedEmitter<Events> {
  private personas = new Map<string, Persona>();

  constructor(
    private settings: Settings,
    private connections: ConnectionManager,
    private skills: SkillRegistry,
  ) {
    super();
    connections.usedBy = () => this.usedBy();
  }

  /** `connection/name` refs the persona's rules name; globs expand to the names known now. */
  namedRefs(cfg: PersonaConfig): Set<string> {
    const out = new Set<string>();
    for (const [conn, pc] of Object.entries(cfg.connections)) {
      const known = this.connections.credentialNames(conn);
      for (const r of pc.rules) {
        if (/[*?]/.test(r.credential)) {
          const re = new RegExp(`^${r.credential.replace(/[.+^${}()|[\]\\-]/g, "\\$&").replace(/\*/g, ".*").replace(/\?/g, ".")}$`);
          for (const n of known) if (re.test(n)) out.add(`${conn}/${n}`);
        } else out.add(`${conn}/${r.credential}`);
      }
    }
    return out;
  }

  parse(id: string, yaml: string): Persona {
    const file = path.join(paths.personas, `${id}.yaml`);
    const errors: string[] = [];
    let raw: unknown;
    try {
      raw = YAML.parse(yaml) ?? {};
    } catch (e) {
      return { id, file, yaml, config: null, folders: [], errors: [`YAML: ${errMsg(e)}`] };
    }
    const parsed = PersonaSchema.safeParse(raw);
    if (!parsed.success) {
      const msgs = parsed.error.issues.map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`);
      return { id, file, yaml, config: null, folders: [], errors: msgs };
    }
    const cfg = parsed.data;
    const folders = resolveFolders(cfg, errors);

    const model = cfg.model ?? this.settings.defaultModel;
    if (!this.settings.providers[model.provider]) errors.push(`model.provider "${model.provider}" is not defined in config.yaml`);

    for (const s of cfg.skills) if (!this.skills.get(s)) errors.push(`skill "${s}" not found`);

    const agentNames = new Set<string>();
    cfg.subagents.agents.forEach((a, i) => {
      if (agentNames.has(a.name)) errors.push(`subagents.agents[${i}]: "${a.name}" appears twice`);
      if (a.name === "auto") errors.push(`subagents.agents[${i}]: "auto" is reserved`);
      agentNames.add(a.name);
      if (a.model === "auto") return;
      const slash = a.model.indexOf("/");
      if (slash <= 0 || slash === a.model.length - 1) errors.push(`subagents.agents[${i}].model must be "provider/model" or "auto"`);
      else if (!this.settings.providers[a.model.slice(0, slash)]) errors.push(`subagents.agents[${i}]: provider "${a.model.slice(0, slash)}" is not defined in config.yaml`);
    });

    for (const [conn, pc] of Object.entries(cfg.connections)) {
      const c = this.connections.configOf(conn);
      if (!c) {
        errors.push(`connections.${conn}: connection "${conn}" is not defined in config.yaml`);
        continue;
      }
      pc.rules.forEach((r, i) => {
        const where = `connections.${conn}.rules[${i}]`;
        // A command connection's credential names are only known once its wrapper ran.
        if (c.type === "static" && !/[*?]/.test(r.credential) && !c.credentials[r.credential])
          errors.push(`${where}: connection "${conn}" has no credential "${r.credential}"`);
        for (const list of ["allow", "ask", "deny"] as const)
          for (const p of r[list]) {
            const problem = patternError(r.api, p);
            if (problem) errors.push(`${where}.${list}: ${problem}`);
          }
      });
    }
    const named = this.namedRefs(cfg);
    const checkRefs = (where: string, value: string) => {
      for (const ref of credentialRefs(value)) {
        if (ref.legacy) {
          if (![...named].some((n) => n.endsWith(`/${ref.name}`))) errors.push(`${where} references {{secret:${ref.name}}} but no rule names a credential ${ref.name}`);
        } else if (!ref.connection) errors.push(`${where}: write {{credential:<connection>/${ref.name}}}`);
        else if (!named.has(`${ref.connection}/${ref.name}`)) errors.push(`${where} references {{credential:${ref.connection}/${ref.name}}} but no rule of this persona names it`);
      }
    };
    for (const [k, v] of Object.entries(cfg.env)) checkRefs(`env.${k}`, v);
    for (const [name, srv] of Object.entries(cfg.mcpServers)) {
      if (!/^[a-z0-9_-]{1,32}$/.test(name)) errors.push(`MCP server name "${name}" must be [a-z0-9_-]`);
      if (isHttpMcp(srv)) for (const [k, v] of Object.entries(srv.headers)) checkRefs(`mcpServers.${name}.headers.${k}`, v);
      else for (const [k, v] of Object.entries(srv.env)) checkRefs(`mcpServers.${name}.env.${k}`, v);
    }
    for (const list of ["allow", "internal", "otherCredentials"] as const)
      for (const h of cfg.network[list]) {
        const m = /^([^:]+)(?::(\d{1,5}))?$/.exec(h);
        if (!m || h.includes("/") || h === "*" || (m[2] && (Number(m[2]) < 1 || Number(m[2]) > 65535)))
          errors.push(`network.${list} entry "${h}" must be a hostname, *.domain or host:port`);
      }
    return { id, file, yaml, config: cfg, folders, errors };
  }

  async load(): Promise<void> {
    const next = new Map<string, Persona>();
    for (const f of await fs.readdir(paths.personas)) {
      if (!f.endsWith(".yaml") && !f.endsWith(".yml")) continue;
      const id = f.replace(/\.ya?ml$/, "");
      if (!PERSONA_ID.test(id)) {
        log.warn("personas", `skipping ${f}: file name must be a lowercase id`);
        continue;
      }
      const yaml = await fs.readFile(path.join(paths.personas, f), "utf8");
      next.set(id, { ...this.parse(id, yaml), file: path.join(paths.personas, f) });
    }
    this.personas = next;
    this.emit("changed");
  }

  /** Re-validate without re-reading (e.g. after skills or secrets changed). */
  revalidate(): void {
    for (const [id, p] of this.personas) this.personas.set(id, { ...this.parse(id, p.yaml), file: p.file });
    this.emit("changed");
  }

  watch(): void {
    const reload = debounce(() => this.load().catch((e) => log.error("personas", errMsg(e))), 150);
    chokidar.watch(paths.personas, { ignoreInitial: true, depth: 0 }).on("all", reload);
  }

  get(id: string) {
    return this.personas.get(id);
  }

  list(): Persona[] {
    return [...this.personas.values()].sort((a, b) => a.id.localeCompare(b.id));
  }

  async save(id: string, yaml: string, { create = false } = {}): Promise<Persona> {
    if (!PERSONA_ID.test(id)) throw new Error("persona id must be lowercase letters, digits and dashes");
    const existing = this.personas.get(id);
    if (create && (existing || (await exists(path.join(paths.personas, `${id}.yaml`))))) throw new Error(`persona "${id}" already exists`);
    const p = this.parse(id, yaml);
    if (!p.config) throw new Error(p.errors.join("; "));
    const file = existing?.file ?? path.join(paths.personas, `${id}.yaml`);
    await writeFileAtomic(file, yaml, 0o600);
    this.personas.set(id, { ...p, file });
    this.emit("changed");
    return this.personas.get(id)!;
  }

  configView(id: string): PersonaConfigView {
    const p = this.personas.get(id);
    if (!p?.config) throw new Error(`persona "${id}" is invalid; fix its YAML first`);
    const c = p.config;
    return {
      name: c.name,
      description: c.description,
      instructions: c.instructions,
      folders: c.folders.map((f) => ({ path: f.path, ...(f.mount ? { mount: f.mount } : {}), mode: f.mode })),
      networkAllow: c.network.allow,
      networkInternal: c.network.internal,
      networkOtherCredentials: c.network.otherCredentials,
      connections: c.connections,
      permissions: c.permissions,
      skills: c.skills,
      mcpServers: c.mcpServers as Record<string, unknown>,
      memory: c.memory,
      subagents: c.subagents,
      schedules: c.schedules,
      watchers: c.watchers,
      unattended: c.unattended,
    };
  }

  /** Apply a form edit to the persona's YAML, keeping comments and keys the form does not cover. */
  async saveConfig(id: string, v: PersonaConfigView): Promise<SaveResult> {
    const p = this.personas.get(id);
    if (!p) throw new Error("not found");
    const before = p.config;
    const doc = YAML.parseDocument(p.yaml);
    doc.set("name", v.name);
    doc.set("description", v.description);
    doc.set("instructions", v.instructions);
    doc.set("folders", doc.createNode(v.folders));
    doc.setIn(["network", "allow"], doc.createNode(v.networkAllow));
    const internal = v.networkInternal ?? [];
    if (internal.length || doc.hasIn(["network", "internal"])) doc.setIn(["network", "internal"], doc.createNode(internal));
    const other = v.networkOtherCredentials ?? [];
    if (other.length || doc.hasIn(["network", "otherCredentials"])) doc.setIn(["network", "otherCredentials"], doc.createNode(other));
    doc.delete("credentials");
    if (Object.keys(v.connections).length || doc.has("connections")) doc.set("connections", doc.createNode(v.connections));
    doc.set("permissions", doc.createNode(v.permissions));
    doc.set("skills", doc.createNode(v.skills));
    doc.set("mcpServers", doc.createNode(v.mcpServers));
    doc.set("memory", doc.createNode(v.memory));
    const sub = v.subagents;
    if (sub.agents.length || sub.maxBackground !== 4 || sub.maxTurns !== 200 || doc.has("subagents")) doc.set("subagents", doc.createNode(sub));
    // Older apps send none of these: leave the YAML as it is.
    for (const k of ["schedules", "watchers"] as const) {
      const list = v[k];
      if (list && (list.length || doc.has(k))) doc.set(k, doc.createNode(list));
    }
    const un = v.unattended;
    if (un && (un.allow.length || Object.keys(un.credentials).length || un.maxTurnsPerDay !== 30 || doc.has("unattended"))) doc.set("unattended", doc.createNode(un));
    const saved = await this.save(id, doc.toString());
    const eq = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);
    const appliedNow: string[] = [];
    const nextStart: string[] = [];
    if (!before || !eq(before.permissions, v.permissions)) appliedNow.push("permissions");
    if (!before || !eq(before.network.allow, v.networkAllow) || !eq(before.network.internal, internal) || !eq(before.network.otherCredentials, other)) appliedNow.push("network allowlist");
    if (!before || !eq(before.connections, v.connections)) appliedNow.push("credential rules (a newly named credential restarts the sandbox between turns)");
    if (!before || before.name !== v.name || before.description !== v.description) appliedNow.push("name and description");
    if (!before || before.instructions !== v.instructions || !eq(before.memory, v.memory)) nextStart.push("instructions and memory brief (next context)");
    if (!before || !eq(before.subagents, v.subagents)) appliedNow.push("sub-agents (from the next delegation)");
    if (v.schedules && (!before || !eq(before.schedules, v.schedules) || !eq(before.watchers, v.watchers) || !eq(before.unattended, v.unattended)))
      appliedNow.push("schedules, watchers and unattended runs");
    if (!before || !eq(before.folders, v.folders) || !eq(before.skills, v.skills) || !eq(before.mcpServers, v.mcpServers))
      nextStart.push("folders, skills and MCP servers (the sandbox restarts between turns)");
    return { persona: this.summary(saved), appliedNow, nextStart };
  }

  /** "Always allow" on a network request: add the host to the persona's allowlist. */
  async addNetworkHost(id: string, host: string) {
    const p = this.personas.get(id);
    if (!p?.config) throw new Error("persona is invalid");
    if (p.config.network.allow.includes(host)) return;
    const doc = YAML.parseDocument(p.yaml);
    doc.setIn(["network", "allow"], doc.createNode([...p.config.network.allow, host]));
    await this.save(id, doc.toString());
  }

  /** Add or replace (by name) a schedule or watcher, or remove one (`entry` null). */
  async setTrigger(id: string, kind: "schedules" | "watchers", name: string, entry: Record<string, unknown> | null) {
    const p = this.personas.get(id);
    if (!p?.config) throw new Error("persona is invalid");
    const list = (p.config[kind] as { name: string }[]).filter((t) => t.name !== name);
    if (entry) list.push(entry as { name: string });
    else if (list.length === p.config[kind].length) throw new Error(`no ${kind === "schedules" ? "schedule" : "watcher"} "${name}"`);
    const doc = YAML.parseDocument(p.yaml);
    doc.set(kind, doc.createNode(list));
    const r = PersonaSchema.safeParse(doc.toJS());
    if (!r.success) throw new Error(r.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; "));
    await this.save(id, doc.toString());
  }

  /** "Always allow" on a command card: add the rules to the persona's permissions.allow. */
  async addAllowRules(id: string, rules: string[]) {
    const p = this.personas.get(id);
    if (!p?.config) throw new Error("persona is invalid");
    const allow = p.config.permissions.allow;
    const added = [...new Set(rules)].filter((r) => !allow.includes(r));
    if (!added.length) return;
    const doc = YAML.parseDocument(p.yaml);
    doc.setIn(["permissions", "allow"], doc.createNode([...allow, ...added]));
    await this.save(id, doc.toString());
  }

  /** "Always allow" on an ask prompt: move the pattern from ask to allow in the rules for that credential. */
  async promoteAskRule(id: string, ref: string, api: string, pattern: string) {
    const p = this.personas.get(id);
    if (!p?.config) throw new Error("persona is invalid");
    const i = ref.indexOf("/");
    const conn = ref.slice(0, i);
    const name = ref.slice(i + 1);
    const rules = p.config.connections[conn]?.rules ?? [];
    const glob = (g: string) => new RegExp(`^${g.replace(/[.+^${}()|[\]\\-]/g, "\\$&").replace(/\*/g, ".*").replace(/\?/g, ".")}$`).test(name);
    let changed = false;
    const next = rules.map((r) => {
      if (r.api !== api || !glob(r.credential) || !r.ask.includes(pattern)) return r;
      changed = true;
      return { ...r, ask: r.ask.filter((x) => x !== pattern), allow: r.allow.includes(pattern) ? r.allow : [...r.allow, pattern] };
    });
    if (!changed) return;
    const doc = YAML.parseDocument(p.yaml);
    doc.setIn(["connections", conn, "rules"], doc.createNode(next));
    await this.save(id, doc.toString());
  }

  /** Composer model/effort selectors: saved to the persona, used from the next model turn. */
  async setModel(id: string, m: { provider: string; id: string; effort?: Effort }) {
    const p = this.personas.get(id);
    if (!p) throw new Error("not found");
    if (!this.settings.providers[m.provider]) throw new Error(`unknown provider "${m.provider}"`);
    const doc = YAML.parseDocument(p.yaml);
    const keep = p.config?.model?.maxTokens;
    doc.set("model", doc.createNode({ provider: m.provider, id: m.id, ...(m.effort ? { effort: m.effort } : {}), ...(keep ? { maxTokens: keep } : {}) }));
    return this.summary(await this.save(id, doc.toString()));
  }

  async remove(id: string): Promise<void> {
    const p = this.personas.get(id);
    if (!p) throw new Error("not found");
    await fs.rm(p.file);
    this.personas.delete(id);
    this.emit("changed");
  }

  /** Persona ids per credential ref their rules name. */
  usedBy(): Map<string, string[]> {
    const m = new Map<string, string[]>();
    for (const p of this.personas.values()) {
      if (!p.config) continue;
      for (const ref of this.namedRefs(p.config)) m.set(ref, [...(m.get(ref) ?? []), p.id]);
    }
    return m;
  }

  summary(p: Persona): PersonaSummary {
    const cfg = p.config;
    const model = cfg?.model ?? this.settings.defaultModel;
    const mcpServers: McpServerSummary[] = Object.entries(cfg?.mcpServers ?? {})
      .filter(([, s]) => s.enabled)
      .map(([name, s]) =>
        isHttpMcp(s)
          ? { name, kind: "http", target: s.url }
          : { name, kind: "stdio", target: [s.command, ...s.args].join(" ") },
      );
    const credentials = cfg ? [...this.namedRefs(cfg)].sort() : [];
    return {
      id: p.id,
      name: cfg?.name ?? p.id,
      description: cfg?.description ?? "",
      model: { provider: model.provider, id: model.id, effort: cfg?.model?.effort },
      folders: p.folders,
      skills: cfg?.skills ?? [],
      hasSandboxTools: !!cfg?.sandbox.tools,
      mcpServers,
      connections: Object.keys(cfg?.connections ?? {}),
      credentials,
      missingCredentials: credentials.filter((c) => !this.connections.usable(c)),
      networkAllow: cfg?.network.allow ?? [],
      networkInternal: cfg?.network.internal ?? [],
      networkOtherCredentials: cfg?.network.otherCredentials ?? [],
      errors: p.errors,
    };
  }
}
