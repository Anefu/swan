// Sharing a persona: one readable file with the persona, the connections it uses (never values) and,
// if chosen, its skills. Importing shows what the persona may reach before anything is saved.
import { promises as fs } from "node:fs";
import path from "node:path";
import YAML from "yaml";
import { z } from "zod";
import type { PersonaImportChoices, PersonaImportPreview, PersonaImportResult } from "@ph/shared";
import type { ConnectionManager } from "./connections/manager.js";
import { isHttpMcp, PERSONA_ID, type PersonaStore } from "./personas.js";
import { paths, type Settings } from "./settings.js";
import type { SkillRegistry } from "./skills.js";
import { errMsg } from "./util.js";

export interface ShareDeps {
  settings: Settings;
  personas: PersonaStore;
  connections: ConnectionManager;
  skills: SkillRegistry;
}

const SKILL_NAME = /^[a-z0-9][a-z0-9-]{0,63}$/;
const MAX_SKILL_BYTES = 5 * 1024 * 1024; // all of a skill's files together
const MAX_SKILL_FILES = 200;

const FileSchema = z.strictObject({ base64: z.string(), executable: z.boolean().optional() });
export const ShareFileSchema = z.strictObject({
  swanPersona: z.literal(1),
  exportedAt: z.string(),
  id: z.string(),
  persona: z.string().max(200_000), // the persona's YAML, as written
  connections: z.record(z.string(), z.unknown()).default({}), // as config.yaml writes them: hosts, inject, the sign-in command
  skills: z.record(z.string(), z.strictObject({ files: z.record(z.string(), FileSchema) })).default({}),
  needs: z
    .strictObject({
      values: z.array(z.string()).default([]), // credentials to give a value
      commands: z.array(z.string()).default([]), // sign-in tools that must exist on the Mac
      sandboxTools: z.boolean().default(false), // the exporter's sandbox had extra tools
    })
    .prefault({}),
});
type ShareFile = z.infer<typeof ShareFileSchema>;

/** A skill file's path inside the skill: relative, no "..", nothing hidden above it. */
function safeRel(rel: string): string | null {
  const norm = path.posix.normalize(rel.replace(/\\/g, "/"));
  if (!norm || norm.startsWith("/") || norm.startsWith("..") || norm.split("/").includes("..") || norm.split("/").length > 6) return null;
  return norm;
}

async function readSkill(dir: string): Promise<Record<string, z.infer<typeof FileSchema>>> {
  const files: Record<string, z.infer<typeof FileSchema>> = {};
  let total = 0;
  const walk = async (rel: string, depth: number) => {
    for (const e of await fs.readdir(path.join(dir, rel), { withFileTypes: true })) {
      const r = rel ? `${rel}/${e.name}` : e.name;
      if (e.isDirectory() && depth < 5) await walk(r, depth + 1);
      else if (e.isFile()) {
        const full = path.join(dir, r);
        const st = await fs.stat(full);
        total += st.size;
        if (total > MAX_SKILL_BYTES || Object.keys(files).length >= MAX_SKILL_FILES) throw new Error(`skill at ${dir} is larger than 5 MB or 200 files`);
        files[r] = { base64: (await fs.readFile(full)).toString("base64"), ...(st.mode & 0o111 ? { executable: true } : {}) };
      } // symlinks and anything else stay behind
    }
  };
  await walk("", 0);
  return files;
}

/** The share file for a persona: its YAML, the connections its rules use, and the chosen skills. */
export async function exportPersona(d: ShareDeps, id: string, skillNames: string[]): Promise<string> {
  const p = d.personas.get(id);
  if (!p?.config) throw new Error(`persona "${id}" is missing or invalid; fix its YAML first`);
  const connections: Record<string, unknown> = {};
  const values: string[] = [];
  const commands: string[] = [];
  for (const conn of Object.keys(p.config.connections)) {
    const raw = await d.connections.rawConfigOf(conn);
    if (!raw) continue;
    connections[conn] = raw;
    const cfg = d.connections.configOf(conn);
    if (cfg?.type === "static") for (const name of Object.keys(cfg.credentials)) values.push(`${conn}/${name}`);
    if (cfg?.type === "command") commands.push(cfg.command[0]!);
  }
  const skills: ShareFile["skills"] = {};
  for (const name of skillNames) {
    if (!p.config.skills.includes(name)) continue;
    const s = d.skills.get(name);
    if (s) skills[name] = { files: await readSkill(s.hostPath) };
  }
  const t = d.settings.sandboxTools; // config.yaml's stand in for tools the persona doesn't set, and don't travel
  const file: ShareFile = {
    swanPersona: 1,
    exportedAt: new Date().toISOString(),
    id,
    persona: p.yaml,
    connections,
    skills,
    needs: { values, commands, sandboxTools: !p.config.sandbox.tools && (t.packages.length > 0 || !!t.install?.trim()) },
  };
  const header = `# A Swan persona. Import it in Swan: persona menu → Import persona…\n# It holds no secret values; check the persona's instructions, env and sandbox tools before sharing.\n`;
  return header + YAML.stringify(file, { lineWidth: 0 });
}

function parseFile(text: string): ShareFile {
  let raw: unknown;
  try {
    raw = YAML.parse(text);
  } catch (e) {
    throw new Error(`not a Swan persona file: ${errMsg(e).split("\n")[0]}`);
  }
  if (!raw || typeof raw !== "object" || !("swanPersona" in raw)) throw new Error("not a Swan persona file. Export one from a persona's Settings → Export…");
  const r = ShareFileSchema.safeParse(raw);
  if (!r.success) throw new Error(`not a Swan persona file: ${r.error.issues[0]?.path.join(".") ?? ""} ${r.error.issues[0]?.message ?? ""}`.trim());
  for (const name of Object.keys(r.data.skills)) {
    if (!SKILL_NAME.test(name)) throw new Error(`skill name "${name}" in the file is not valid`);
    for (const rel of Object.keys(r.data.skills[name]!.files)) if (!safeRel(rel)) throw new Error(`skill "${name}" has a file outside its folder (${rel})`);
  }
  return r.data;
}

/** What importing would do, for the review screen. Saves nothing. */
export async function previewImport(d: ShareDeps, text: string): Promise<PersonaImportPreview> {
  const f = parseFile(text);
  const parsed = d.personas.parse(PERSONA_ID.test(f.id) ? f.id : "imported", f.persona);
  const c = parsed.config;
  if (!c) throw new Error(`the persona in the file is not valid: ${parsed.errors.join("; ")}`);
  let id = PERSONA_ID.test(f.id) ? f.id : "imported";
  for (let n = 2; d.personas.get(id); n++) id = `${f.id.replace(/-\d+$/, "")}-${n}`.slice(0, 63);
  const connections = await Promise.all(
    Object.entries(f.connections).map(async ([name, raw]) => {
      const mine = await d.connections.rawConfigOf(name);
      const r = raw as { type?: string; command?: string[]; hosts?: string[]; credentials?: Record<string, { hosts?: string[] }> };
      const hosts = r.type === "command" ? (r.hosts ?? []) : Object.values(r.credentials ?? {}).flatMap((x) => x.hosts ?? []);
      return {
        name,
        type: r.type === "command" ? ("command" as const) : ("static" as const),
        status: !mine ? ("new" as const) : JSON.stringify(mine) === JSON.stringify(raw) ? ("same" as const) : ("different" as const),
        hosts,
        ...(r.type === "command" ? { command: r.command ?? [] } : {}),
      };
    }),
  );
  return {
    id,
    name: c.name,
    description: c.description,
    folders: c.folders.map((x) => ({ path: x.path, ...(x.mount ? { mount: x.mount } : {}), mode: x.mode })),
    access: {
      networkAllow: c.network.allow,
      networkInternal: c.network.internal,
      otherCredentials: c.network.otherCredentials,
      permissions: c.permissions,
      allowsAllCommands: c.permissions.allow.includes("bash") || c.permissions.default === "allow",
      credentialRules: Object.entries(c.connections).flatMap(([conn, pc]) => pc.rules.map((r) => ({ connection: conn, credential: r.credential, api: r.api, allow: r.allow, ask: r.ask, deny: r.deny }))),
      mcpServers: Object.entries(c.mcpServers).map(([name, s]) => (isHttpMcp(s) ? { name, kind: "http" as const, target: s.url } : { name, kind: "stdio" as const, target: [s.command, ...s.args].join(" ") })),
      image: c.sandbox.image ?? null,
      tools: c.sandbox.tools ? { packages: c.sandbox.tools.packages, install: c.sandbox.tools.install?.trim() || null } : null,
      envNames: Object.keys(c.env),
    },
    connections,
    skills: Object.entries(f.skills).map(([name, s]) => ({ name, files: Object.keys(s.files).length, exists: !!d.skills.get(name) })),
    skillsNotIncluded: c.skills.filter((s) => !f.skills[s] && !d.skills.get(s)),
    needs: { ...f.needs, values: f.needs.values.filter((ref) => !d.connections.usable(ref)) },
  };
}

/** Import with the choices made on the review screen: folders mapped, sign-in tools opted in, skills chosen. */
export async function importPersona(d: ShareDeps, text: string, ch: PersonaImportChoices): Promise<PersonaImportResult> {
  const f = parseFile(text);
  if (!PERSONA_ID.test(ch.id)) throw new Error("the id must be lowercase letters, digits and dashes");
  if (d.personas.get(ch.id)) throw new Error(`a persona "${ch.id}" already exists; choose another id`);
  if (!ch.name.trim()) throw new Error("give the persona a name");

  const doc = YAML.parseDocument(f.persona);
  const original = (doc.toJS() as { folders?: { path: string; mount?: string; mode?: string }[] })?.folders ?? [];
  if (ch.folders.length !== original.length) throw new Error("choose a folder on this Mac, or none, for each of the persona's folders");
  const folders = original.flatMap((x, i) => (ch.folders[i] ? [{ path: ch.folders[i]!, ...(x.mount ? { mount: x.mount } : {}), mode: x.mode ?? "ro" }] : []));
  doc.set("name", ch.name.trim());
  doc.set("folders", doc.createNode(folders));
  // The script runs as root in a build outside the egress proxy, so it comes along only when the user agrees.
  if (ch.acceptTools !== true && doc.hasIn(["sandbox", "tools"])) doc.deleteIn(["sandbox", "tools"]);

  // Skills first, so the persona finds them when it is checked.
  const skillsAdded: string[] = [];
  for (const name of ch.skills) {
    const s = f.skills[name];
    if (!s || d.skills.get(name)) continue; // never replace a skill that is already there
    const dir = path.join(paths.skills, name);
    for (const [rel, file] of Object.entries(s.files)) {
      const target = path.join(dir, safeRel(rel)!);
      await fs.mkdir(path.dirname(target), { recursive: true });
      await fs.writeFile(target, Buffer.from(file.base64, "base64"), { mode: file.executable ? 0o755 : 0o644 });
    }
    skillsAdded.push(name);
  }
  if (skillsAdded.length) await d.skills.load();

  // Connections that do not exist yet; a sign-in tool only when the user ticked it, since it runs on this Mac.
  const wanted = Object.fromEntries(
    Object.entries(f.connections).filter(([name, raw]) => (raw as { type?: string }).type !== "command" || ch.commandConnections.includes(name)),
  );
  const connectionsAdded = await d.connections.addConnections(wanted);

  const saved = await d.personas.save(ch.id, doc.toString({ lineWidth: 0 }), { create: true });
  return { persona: d.personas.summary(saved), connectionsAdded, skillsAdded };
}
