// One-time conversion from the earlier format (credentials in secrets files with their hosts,
// personas listing credential names) to connections. Originals are kept as .bak files.
import { promises as fs } from "node:fs";
import path from "node:path";
import YAML from "yaml";
import type { MigrationNote } from "@ph/shared";
import { SECRET_NAME, envKeys } from "../secrets.js";
import { paths } from "../settings.js";
import { exists, log, nowIso, writeFileAtomic } from "../util.js";

interface Legacy {
  name: string;
  hosts: string[];
  inject?: { header: string; format: string };
  substituteInBody?: boolean;
  yamlValue?: string;
  inEnv: boolean;
}

/** api.github.com -> github, *.example.co.uk -> example. */
export function connectionNameFor(host: string): string {
  const labels = host.replace(/^\*\./, "").toLowerCase().split(".").filter(Boolean);
  let i = labels.length - 2;
  if (i > 0 && labels.at(-1)!.length === 2 && ["co", "com", "net", "org", "gov", "ac", "edu"].includes(labels[i])) i--;
  return (labels[Math.max(0, i)] ?? "").replace(/[^a-z0-9-]/g, "-").replace(/^-+|-+$/g, "").slice(0, 32) || "secrets";
}

async function backup(file: string) {
  if (await exists(file)) await fs.copyFile(file, `${file}.bak`);
  await fs.chmod(`${file}.bak`, 0o600).catch(() => {});
}

function parseEnvLines(text: string) {
  const values = new Map<string, string>();
  for (const line of text.split(/\r?\n/)) {
    const m = /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/.exec(line);
    if (m) values.set(m[1], m[2]);
  }
  return values;
}

/** Runs before the stores load. Returns the note to show once, or null when nothing was converted. */
export async function migrateConnections(providerKeys: Set<string>): Promise<MigrationNote | null> {
  if (!(await exists(paths.config))) return null;
  const configDoc = YAML.parseDocument(await fs.readFile(paths.config, "utf8"));
  if (configDoc.has("connections")) return null;

  const yamlText = (await exists(paths.secretsYaml)) ? await fs.readFile(paths.secretsYaml, "utf8") : "";
  const envText = (await exists(paths.secretsEnv)) ? await fs.readFile(paths.secretsEnv, "utf8") : "";
  const secretsDoc = YAML.parseDocument(yamlText || "{}");
  const raw = (secretsDoc.toJS() ?? {}) as Record<string, unknown>;
  const env = parseEnvLines(envText);

  const legacy = new Map<string, Legacy>();
  const kept: string[] = [];
  for (const [name, entry] of Object.entries(raw)) {
    if (!SECRET_NAME.test(name)) continue;
    const e = entry && typeof entry === "object" ? (entry as Record<string, unknown>) : { value: entry };
    const hosts = Array.isArray(e.hosts) ? e.hosts.map(String).filter(Boolean) : [];
    if (!hosts.length) {
      if (!providerKeys.has(name) && !env.get(`${name}__HOSTS`)) kept.push(name);
      continue;
    }
    legacy.set(name, {
      name,
      hosts,
      inject: e.inject && typeof e.inject === "object" ? { header: String((e.inject as Record<string, unknown>).header), format: String((e.inject as Record<string, unknown>).format ?? "{value}") } : undefined,
      substituteInBody: e.substituteInBody === true ? true : undefined,
      yamlValue: typeof e.value === "string" ? e.value : undefined,
      inEnv: env.has(name),
    });
  }
  for (const [k, v] of env) {
    if (!k.endsWith("__HOSTS") || !env.has(k.slice(0, -7))) continue;
    const name = k.slice(0, -7);
    const hosts = v.replace(/^["']|["']$/g, "").split(",").map((h) => h.trim()).filter(Boolean);
    const prev = legacy.get(name);
    if (prev) prev.inEnv = true;
    else if (hosts.length) legacy.set(name, { name, hosts, inEnv: true });
  }

  const personaFiles = (await exists(paths.personas)) ? (await fs.readdir(paths.personas)).filter((f) => /\.ya?ml$/.test(f)) : [];
  const personaDocs = await Promise.all(personaFiles.map(async (f) => ({ file: path.join(paths.personas, f), doc: YAML.parseDocument(await fs.readFile(path.join(paths.personas, f), "utf8")) })));
  const needsPersonas = personaDocs.some((p) => p.doc.has("credentials"));

  if (!legacy.size && !needsPersonas) {
    configDoc.set("connections", configDoc.createNode({}));
    await writeFileAtomic(paths.config, configDoc.toString(), 0o600);
    return null;
  }

  // Group credentials by their first host's registrable name.
  const connOf = new Map<string, string>();
  const connections: Record<string, { type: "static"; credentials: Record<string, Record<string, unknown>> }> = {};
  for (const l of legacy.values()) {
    const conn = connectionNameFor(l.hosts[0]);
    connOf.set(l.name, conn);
    connections[conn] ??= { type: "static", credentials: {} };
    connections[conn].credentials[l.name] = { hosts: l.hosts, ...(l.inject ? { inject: l.inject } : {}), ...(l.substituteInBody ? { substituteInBody: true } : {}) };
  }

  const moved = [...connOf].map(([name, conn]) => `${name} → ${conn}/${name}`);
  const problems: string[] = [];

  await backup(paths.config);
  configDoc.set("connections", configDoc.createNode(connections));
  await writeFileAtomic(paths.config, configDoc.toString(), 0o600);

  if (yamlText) {
    await backup(paths.secretsYaml);
    for (const l of legacy.values()) {
      if (!secretsDoc.has(l.name)) continue;
      secretsDoc.delete(l.name);
      if (l.yamlValue !== undefined) secretsDoc.set(`${connOf.get(l.name)}/${l.name}`, l.yamlValue);
    }
    await writeFileAtomic(paths.secretsYaml, secretsDoc.toString(), 0o600);
  }
  if (envText && [...legacy.values()].some((l) => l.inEnv)) {
    await backup(paths.secretsEnv);
    const lines = envText.split(/\r?\n/).flatMap((line) => {
      const m = /^(\s*(?:export\s+)?)([A-Za-z_][A-Za-z0-9_]*)(\s*=.*)$/.exec(line);
      if (!m) return [line];
      if (m[2].endsWith("__HOSTS") && legacy.has(m[2].slice(0, -7))) return [];
      const conn = connOf.get(m[2]);
      return conn ? [`${m[1]}${envKeys(`${conn}/${m[2]}`)[0]}${m[3]}`] : [line];
    });
    await writeFileAtomic(paths.secretsEnv, lines.join("\n"), 0o600);
  }

  const personas: string[] = [];
  for (const { file, doc } of personaDocs) {
    const id = path.basename(file).replace(/\.ya?ml$/, "");
    const names = doc.get("credentials");
    const list = YAML.isSeq(names) ? (names.toJSON() as unknown[]).map(String) : [];
    let text = doc.toString();
    const hadRefs = /\{\{\s*secret:/.test(text);
    if (!doc.has("credentials") && !hadRefs) continue;
    await backup(file);
    if (doc.has("credentials")) {
      const rules: Record<string, { rules: { credential: string; api: "http"; allow: string[] }[] }> = {};
      for (const name of list) {
        const conn = connOf.get(name);
        if (!conn) {
          if (!providerKeys.has(name)) problems.push(`${id}: ${name} has no hosts, so it could not become a connection; it was removed from the persona`);
          continue;
        }
        // Keep today's behaviour: any request to the credential's hosts.
        (rules[conn] ??= { rules: [] }).rules.push({ credential: name, api: "http", allow: ["* /**"] });
      }
      doc.delete("credentials");
      if (Object.keys(rules).length) doc.set("connections", doc.createNode(rules));
      text = doc.toString();
      personas.push(id);
    }
    text = text.replace(/\{\{\s*secret:([A-Za-z_][A-Za-z0-9_]*)\s*\}\}/g, (m, name: string) => {
      const conn = connOf.get(name);
      return conn ? `{{credential:${conn}/${name}}}` : m;
    });
    await writeFileAtomic(file, text, 0o600);
  }

  const note: MigrationNote = { at: nowIso(), moved, personas, kept, problems };
  await writeFileAtomic(paths.migrationNote, JSON.stringify(note, null, 2), 0o600);
  log.info("connections", `converted ${moved.length} credentials to connections (${personas.length} personas updated); originals kept as .bak`);
  return note;
}

export async function readMigrationNote(): Promise<MigrationNote | null> {
  try {
    return JSON.parse(await fs.readFile(paths.migrationNote, "utf8")) as MigrationNote;
  } catch {
    return null;
  }
}

export async function dismissMigrationNote() {
  await fs.rm(paths.migrationNote, { force: true });
}
