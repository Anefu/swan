import { promises as fs, statSync } from "node:fs";
import os from "node:os";
import chokidar from "chokidar";
import YAML from "yaml";
import { z } from "zod";
import { paths } from "./settings.js";
import { TypedEmitter, debounce, errMsg, exists, log, sha256Hex, writeFileAtomic } from "./util.js";

/** Host-side keys (model providers) are plain names; connection credentials are `connection/name`. */
export const SECRET_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;
export const SECRET_KEY = /^(?:[A-Za-z_][A-Za-z0-9_]*|[a-z0-9-]{1,32}\/[A-Za-z0-9_-]{1,64})$/;

export interface SecretEntry {
  name: string;
  value: string | undefined;
  source: "yaml" | "env" | null;
  fingerprint: string | null;
  updatedAt: string | null;
  // Earlier format only (read for migration): bindings now live in config.yaml.
  hosts: string[];
  inject?: { header: string; format: string };
  substituteInBody?: boolean;
}

const YamlEntry = z.union([
  z.string(), // shorthand: NAME: value
  z.object({
    value: z.string().optional(),
    hosts: z.array(z.string()).optional(),
    inject: z.object({ header: z.string(), format: z.string().default("{value}") }).optional(),
    substituteInBody: z.boolean().optional(),
  }),
]);

function parseEnv(text: string): Map<string, string> {
  const out = new Map<string, string>();
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    const m = /^(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/.exec(line);
    if (!m) continue;
    let v = m[2];
    // A quoted value may be followed by a comment: KEY="a # b" # note
    const quoted = /^"((?:[^"\\]|\\.)*)"\s*(?:#.*)?$/.exec(v) ?? /^'([^']*)'\s*(?:#.*)?$/.exec(v);
    if (quoted) {
      v = quoted[1];
      if (m[2].startsWith('"')) v = v.replace(/\\n/g, "\n").replace(/\\"/g, '"');
    } else {
      v = v.replace(/\s+#.*$/, "");
    }
    out.set(m[1], v);
  }
  return out;
}

/** secrets.env spellings of `connection/name`: GITHUB__GITHUB_TOKEN (dashes in the connection become _). */
export function envKeys(key: string): string[] {
  const i = key.indexOf("/");
  if (i < 0) return [key];
  const conn = key.slice(0, i).replace(/-/g, "_");
  const name = key.slice(i + 1);
  return [...new Set([`${conn.toUpperCase()}__${name}`, `${conn}__${name}`])];
}

type Events = { changed: [string[]]; status: [string | null] };

const FORMAT_HINT = "Each line is NAME: value, with a space after the colon.";

/**
 * A YAML problem without the text it quotes: the quoted line may hold a secret, and this message
 * reaches the log and the UI.
 */
function yamlProblem(e: unknown): string {
  return errMsg(e).split("\n")[0]!.replace(/:\s*$/, "");
}

/**
 * Secret values live only on the host, in secrets.yaml and/or secrets.env under PH_HOME. Both
 * files are watched; consumers read values at use time, so edits apply without restarts.
 */
export class SecretStore extends TypedEmitter<Events> {
  private entries = new Map<string, SecretEntry>();
  private lastError: string | null = null;

  async load(): Promise<void> {
    const next = new Map<string, SecretEntry>();
    const fileTime = (f: string) => {
      try {
        return statSync(f).mtime.toISOString();
      } catch {
        return null;
      }
    };

    if (await exists(paths.secretsEnv)) {
      const env = parseEnv(await fs.readFile(paths.secretsEnv, "utf8"));
      const t = fileTime(paths.secretsEnv);
      for (const [k, v] of env) {
        if (k.endsWith("__HOSTS") && env.has(k.slice(0, -7))) continue;
        const hosts = (env.get(`${k}__HOSTS`) ?? "").split(",").map((h) => h.trim()).filter(Boolean);
        next.set(k, { name: k, value: v, source: "env", hosts, fingerprint: null, updatedAt: t });
      }
    }

    if (await exists(paths.secretsYaml)) {
      let doc: unknown;
      try {
        doc = YAML.parse(await fs.readFile(paths.secretsYaml, "utf8")) ?? {};
      } catch (e) {
        throw new Error(`secrets.yaml: ${yamlProblem(e)}. ${FORMAT_HINT}`);
      }
      if (typeof doc !== "object" || Array.isArray(doc)) throw new Error(`secrets.yaml is not a list of names and values. ${FORMAT_HINT}`);
      const t = fileTime(paths.secretsYaml);
      for (const [name, rawEntry] of Object.entries(doc as Record<string, unknown>)) {
        if (!SECRET_KEY.test(name)) throw new Error(`invalid secret name "${name}" (use connection/NAME, or a plain NAME for model-provider keys)`);
        if (rawEntry == null) continue;
        const parsed = YamlEntry.safeParse(rawEntry);
        if (!parsed.success) throw new Error(`secrets.yaml: ${name}: ${parsed.error.issues[0]?.message}`);
        const e = typeof parsed.data === "string" ? { value: parsed.data } : parsed.data;
        const prev = next.get(name);
        next.set(name, {
          name,
          value: e.value ?? prev?.value,
          source: e.value !== undefined ? "yaml" : (prev?.source ?? null),
          hosts: "hosts" in e && e.hosts ? e.hosts : (prev?.hosts ?? []),
          inject: "inject" in e ? e.inject : undefined,
          substituteInBody: "substituteInBody" in e ? e.substituteInBody : undefined,
          fingerprint: null,
          updatedAt: e.value !== undefined ? t : (prev?.updatedAt ?? null),
        });
      }
    }

    const changed: string[] = [];
    for (const [name, e] of next) {
      e.fingerprint = e.value ? sha256Hex(e.value).slice(0, 8) : null;
      const prev = this.entries.get(name);
      if (prev && prev.fingerprint === e.fingerprint) e.updatedAt = prev.updatedAt;
      if (!prev || prev.fingerprint !== e.fingerprint || prev.hosts.join(",") !== e.hosts.join(",") || JSON.stringify(prev.inject) !== JSON.stringify(e.inject)) {
        if (prev && prev.fingerprint !== e.fingerprint) e.updatedAt = new Date().toISOString();
        changed.push(name);
      }
    }
    for (const name of this.entries.keys()) if (!next.has(name)) changed.push(name);
    this.entries = next;
    this.setError(null);
    if (changed.length) this.emit("changed", changed);
  }

  /** load(), keeping the previous values when the files cannot be read, and remembering why (Swan settings shows it). */
  async tryLoad(): Promise<boolean> {
    try {
      await this.load();
      return true;
    } catch (e) {
      this.setError(errMsg(e));
      log.error("secrets", `could not read the secrets, keeping the previous values: ${this.lastError}`);
      return false;
    }
  }

  private setError(error: string | null) {
    if (error === this.lastError) return;
    this.lastError = error;
    this.emit("status", error);
  }

  watch(): void {
    const reload = debounce(() => {
      void this.tryLoad().then((ok) => ok && log.info("secrets", "reloaded"));
    }, 150);
    chokidar.watch([paths.secretsYaml, paths.secretsEnv], { ignoreInitial: true, awaitWriteFinish: { stabilityThreshold: 80 } }).on("all", reload);
  }

  /** A key's entry: secrets.yaml first, then any secrets.env spelling. */
  get(key: string): SecretEntry | undefined {
    const y = this.entries.get(key);
    if (y?.value !== undefined) return y;
    for (const k of envKeys(key)) {
      const e = this.entries.get(k);
      if (e?.value !== undefined) return e;
    }
    return y;
  }

  value(key: string): string | undefined {
    return this.get(key)?.value;
  }

  /** Every entry as stored, keyed by file spelling (migration reads the earlier format from here). */
  all(): SecretEntry[] {
    return [...this.entries.values()];
  }

  get error() {
    return this.lastError;
  }

  /** Set a value in secrets.yaml, preserving comments and ordering. */
  async setValue(key: string, value: string): Promise<void> {
    if (!SECRET_KEY.test(key)) throw new Error("invalid credential name");
    const text = (await exists(paths.secretsYaml)) ? await fs.readFile(paths.secretsYaml, "utf8") : "";
    const doc = YAML.parseDocument(text || "{}");
    // Never rewrite a file Swan cannot read: that would drop what is in it.
    const where = paths.secretsYaml.replace(os.homedir(), "~");
    if (doc.errors.length) throw new Error(`Not saved: ${where} has a mistake (${yamlProblem(doc.errors[0])}). ${FORMAT_HINT} Fix it, then save again.`);
    if (doc.contents !== null && !YAML.isMap(doc.contents)) throw new Error(`Not saved: ${where} is not a list of names and values. ${FORMAT_HINT} Fix it, then save again.`);
    const current = (doc.toJS() ?? {})[key];
    doc.set(key, current && typeof current === "object" ? doc.createNode({ ...current, value }) : value);
    await writeFileAtomic(paths.secretsYaml, doc.toString(), 0o600);
    await this.load();
  }

  /** Remove a key from both files. */
  async remove(key: string): Promise<void> {
    if (await exists(paths.secretsYaml)) {
      const doc = YAML.parseDocument(await fs.readFile(paths.secretsYaml, "utf8"));
      if (doc.has(key)) {
        doc.delete(key);
        await writeFileAtomic(paths.secretsYaml, doc.toString(), 0o600);
      }
    }
    if (await exists(paths.secretsEnv)) {
      const lines = (await fs.readFile(paths.secretsEnv, "utf8")).split(/\r?\n/);
      const names = envKeys(key).map((k) => k.replace(/[^A-Za-z0-9_]/g, ""));
      const re = new RegExp(`^\\s*(export\\s+)?(${names.join("|")})(__HOSTS)?\\s*=`);
      const kept = lines.filter((l) => !re.test(l));
      if (kept.length !== lines.length) await writeFileAtomic(paths.secretsEnv, kept.join("\n"), 0o600);
    }
    await this.load();
  }
}
