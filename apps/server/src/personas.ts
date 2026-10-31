import { promises as fs, realpathSync, statSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import chokidar from "chokidar";
import YAML from "yaml";
import { z } from "zod";
import type { Effort, FolderMount, McpServerSummary, PersonaConfigView, PersonaSummary, SaveResult } from "@ph/shared";
import { PersonaConnectionsSchema, credentialRefs } from "./connections/config.js";
import type { ConnectionManager } from "./connections/manager.js";
import { patternError } from "./connections/rules.js";
import { PH_HOME, paths, type Settings } from "./settings.js";
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
  network: z.strictObject({ allow: z.array(z.string()).default([]) }).prefault({}),
  memory: z
    .strictObject({
      autoBrief: z.boolean().default(true), // load saved memories at the start of each context
      briefTokens: z.number().int().min(0).max(8000).default(1500),
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
      image: z.string().optional(),
      cpus: z.number().positive().default(2),
      memory: z.string().default("2g"),
      pidsLimit: z.number().int().positive().default(512),
      workdir: z.string().optional(),
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
    for (const h of cfg.network.allow) {
      const m = /^([^:]+)(?::(\d{1,5}))?$/.exec(h);
      if (!m || h.includes("/") || h === "*" || (m[2] && (Number(m[2]) < 1 || Number(m[2]) > 65535)))
        errors.push(`network.allow entry "${h}" must be a hostname, *.domain or host:port`);
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
      connections: c.connections,
      permissions: c.permissions,
      skills: c.skills,
      mcpServers: c.mcpServers as Record<string, unknown>,
      memory: c.memory,
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
    doc.delete("credentials");
    if (Object.keys(v.connections).length || doc.has("connections")) doc.set("connections", doc.createNode(v.connections));
    doc.set("permissions", doc.createNode(v.permissions));
    doc.set("skills", doc.createNode(v.skills));
    doc.set("mcpServers", doc.createNode(v.mcpServers));
    doc.set("memory", doc.createNode(v.memory));
    const saved = await this.save(id, doc.toString());
    const eq = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);
    const appliedNow: string[] = [];
    const nextStart: string[] = [];
    if (!before || !eq(before.permissions, v.permissions)) appliedNow.push("permissions");
    if (!before || !eq(before.network.allow, v.networkAllow)) appliedNow.push("network allowlist");
    if (!before || !eq(before.connections, v.connections)) appliedNow.push("credential rules (newly named credentials from the next container start)");
    if (!before || before.name !== v.name || before.description !== v.description) appliedNow.push("name and description");
    if (!before || before.instructions !== v.instructions || !eq(before.memory, v.memory)) nextStart.push("instructions and memory brief (next context)");
    if (!before || !eq(before.folders, v.folders) || !eq(before.skills, v.skills) || !eq(before.mcpServers, v.mcpServers))
      nextStart.push("folders, skills and MCP servers (next container start)");
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
      mcpServers,
      connections: Object.keys(cfg?.connections ?? {}),
      credentials,
      missingCredentials: credentials.filter((c) => !this.connections.usable(c)),
      networkAllow: cfg?.network.allow ?? [],
      errors: p.errors,
    };
  }
}
