import { promises as fs, realpathSync, statSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import chokidar from "chokidar";
import YAML from "yaml";
import { z } from "zod";
import type { FolderMount, McpServerSummary, PersonaSummary } from "@ph/shared";
import { SECRET_NAME, SECRET_REF, type SecretStore } from "./secrets.js";
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
  credentials: z.array(z.string()).default([]),
  env: z.record(z.string(), z.string()).default({}),
  network: z.strictObject({ allow: z.array(z.string()).default([]) }).prefault({}),
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
    private secrets: SecretStore,
    private skills: SkillRegistry,
  ) {
    super();
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

    const declared = new Set(cfg.credentials);
    for (const c of cfg.credentials) if (!SECRET_NAME.test(c)) errors.push(`invalid credential name "${c}"`);
    const checkRefs = (where: string, value: string) => {
      for (const m of value.matchAll(SECRET_REF)) {
        if (!declared.has(m[1])) errors.push(`${where} references {{secret:${m[1]}}} but it is not listed under credentials`);
      }
    };
    for (const [k, v] of Object.entries(cfg.env)) checkRefs(`env.${k}`, v);
    for (const [name, srv] of Object.entries(cfg.mcpServers)) {
      if (!/^[a-z0-9_-]{1,32}$/.test(name)) errors.push(`MCP server name "${name}" must be [a-z0-9_-]`);
      if (isHttpMcp(srv)) for (const [k, v] of Object.entries(srv.headers)) checkRefs(`mcpServers.${name}.headers.${k}`, v);
      else for (const [k, v] of Object.entries(srv.env)) checkRefs(`mcpServers.${name}.env.${k}`, v);
    }
    for (const h of cfg.network.allow) {
      if (h.includes("/") || h.includes(":") || h === "*") errors.push(`network.allow entry "${h}" must be a hostname or *.domain`);
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

  async remove(id: string): Promise<void> {
    const p = this.personas.get(id);
    if (!p) throw new Error("not found");
    await fs.rm(p.file);
    this.personas.delete(id);
    this.emit("changed");
  }

  usedBy(): Map<string, string[]> {
    const m = new Map<string, string[]>();
    for (const p of this.personas.values()) {
      for (const c of p.config?.credentials ?? []) m.set(c, [...(m.get(c) ?? []), p.id]);
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
    const credentials = cfg?.credentials ?? [];
    return {
      id: p.id,
      name: cfg?.name ?? p.id,
      description: cfg?.description ?? "",
      model: { provider: model.provider, id: model.id, effort: cfg?.model?.effort },
      folders: p.folders,
      skills: cfg?.skills ?? [],
      mcpServers,
      credentials,
      missingCredentials: credentials.filter((c) => !this.secrets.value(c)),
      networkAllow: cfg?.network.allow ?? [],
      errors: p.errors,
    };
  }
}
