import { promises as fs, statSync } from "node:fs";
import chokidar from "chokidar";
import YAML from "yaml";
import { z } from "zod";
import type { CredentialStatus, CredentialUpsert } from "@ph/shared";
import { paths } from "./settings.js";
import { TypedEmitter, debounce, errMsg, exists, log, sha256Hex, writeFileAtomic } from "./util.js";

export const SECRET_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;
export const SECRET_REF = /\{\{\s*secret:([A-Za-z_][A-Za-z0-9_]*)\s*\}\}/g;

export interface SecretEntry {
  name: string;
  value: string | undefined;
  source: "yaml" | "env" | null;
  hosts: string[];
  inject?: { header: string; format: string };
  fingerprint: string | null;
  updatedAt: string | null;
}

const YamlEntry = z.union([
  z.string(), // shorthand: NAME: value
  z.object({
    value: z.string().optional(),
    hosts: z.array(z.string()).optional(),
    inject: z.object({ header: z.string(), format: z.string().default("{value}") }).optional(),
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
    if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) {
      v = v.slice(1, -1);
      if (m[2].startsWith('"')) v = v.replace(/\\n/g, "\n").replace(/\\"/g, '"');
    } else {
      v = v.replace(/\s+#.*$/, "");
    }
    out.set(m[1], v);
  }
  return out;
}

type Events = { changed: [string[]]; error: [string] };

/**
 * Credentials live only on the host, in secrets.yaml and/or secrets.env under PH_HOME.
 * Both files are watched; every consumer reads values at use time, so edits take effect
 * immediately without restarting sessions.
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
        if (k.endsWith("__HOSTS")) continue;
        const hosts = (env.get(`${k}__HOSTS`) ?? "").split(",").map((h) => h.trim()).filter(Boolean);
        next.set(k, { name: k, value: v, source: "env", hosts, fingerprint: null, updatedAt: t });
      }
    }

    if (await exists(paths.secretsYaml)) {
      const doc = YAML.parse(await fs.readFile(paths.secretsYaml, "utf8")) ?? {};
      if (typeof doc !== "object" || Array.isArray(doc)) throw new Error("secrets.yaml must be a mapping of NAME: entry");
      const t = fileTime(paths.secretsYaml);
      for (const [name, rawEntry] of Object.entries(doc)) {
        if (!SECRET_NAME.test(name)) throw new Error(`invalid secret name "${name}"`);
        if (rawEntry == null) continue;
        const parsed = YamlEntry.safeParse(rawEntry);
        if (!parsed.success) throw new Error(`secrets.yaml: ${name}: ${parsed.error.issues[0]?.message}`);
        const e = typeof parsed.data === "string" ? { value: parsed.data } : parsed.data;
        const prev = next.get(name);
        next.set(name, {
          name,
          value: e.value ?? prev?.value,
          source: e.value !== undefined ? "yaml" : (prev?.source ?? null),
          hosts: e.hosts ?? prev?.hosts ?? [],
          inject: "inject" in e ? e.inject : undefined,
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
      if (
        !prev ||
        prev.fingerprint !== e.fingerprint ||
        prev.hosts.join(",") !== e.hosts.join(",") ||
        JSON.stringify(prev.inject) !== JSON.stringify(e.inject)
      ) {
        if (prev && prev.fingerprint !== e.fingerprint) e.updatedAt = new Date().toISOString();
        changed.push(name);
      }
    }
    for (const name of this.entries.keys()) if (!next.has(name)) changed.push(name);
    this.entries = next;
    this.lastError = null;
    if (changed.length) this.emit("changed", changed);
  }

  watch(): void {
    const reload = debounce(() => {
      this.load()
        .then(() => log.info("secrets", "reloaded"))
        .catch((e) => {
          // Keep serving the last good set; surface the parse error.
          this.lastError = errMsg(e);
          log.error("secrets", `reload failed, keeping previous values: ${this.lastError}`);
          this.emit("error", this.lastError);
        });
    }, 150);
    chokidar
      .watch([paths.secretsYaml, paths.secretsEnv], { ignoreInitial: true, awaitWriteFinish: { stabilityThreshold: 80 } })
      .on("all", reload);
  }

  get(name: string): SecretEntry | undefined {
    return this.entries.get(name);
  }

  value(name: string): string | undefined {
    return this.entries.get(name)?.value;
  }

  get error() {
    return this.lastError;
  }

  status(usedBy: Map<string, string[]>): CredentialStatus[] {
    const names = new Set([...this.entries.keys(), ...usedBy.keys()]);
    return [...names].sort().map((name) => {
      const e = this.entries.get(name);
      return {
        name,
        present: !!e?.value,
        source: e?.value ? e.source : null,
        hosts: e?.hosts ?? [],
        injects: !!e?.inject,
        fingerprint: e?.fingerprint ?? null,
        updatedAt: e?.updatedAt ?? null,
        usedBy: usedBy.get(name) ?? [],
      };
    });
  }

  /** Render `{{secret:NAME}}` references with real values (host-side use only). */
  resolveHost(template: string): { text: string; missing: string[]; used: string[] } {
    const missing: string[] = [];
    const used: string[] = [];
    const text = template.replace(SECRET_REF, (_m, name: string) => {
      used.push(name);
      const v = this.value(name);
      if (v === undefined) missing.push(name);
      return v ?? "";
    });
    return { text, missing, used };
  }

  /** Edit secrets.yaml in place, preserving comments and ordering. */
  async upsert(name: string, u: CredentialUpsert): Promise<void> {
    if (!SECRET_NAME.test(name)) throw new Error("invalid credential name");
    const text = (await exists(paths.secretsYaml)) ? await fs.readFile(paths.secretsYaml, "utf8") : "";
    const doc = YAML.parseDocument(text || "{}");
    const current = (doc.toJS() ?? {})[name];
    const entry: Record<string, unknown> =
      typeof current === "string" ? { value: current } : current && typeof current === "object" ? { ...current } : {};
    if (u.value !== undefined) entry.value = u.value;
    if (u.hosts !== undefined) entry.hosts = u.hosts;
    if (u.inject === null) delete entry.inject;
    else if (u.inject) entry.inject = u.inject;
    doc.set(name, doc.createNode(entry));
    await writeFileAtomic(paths.secretsYaml, doc.toString(), 0o600);
    await this.load();
  }

  async remove(name: string): Promise<void> {
    if (await exists(paths.secretsYaml)) {
      const doc = YAML.parseDocument(await fs.readFile(paths.secretsYaml, "utf8"));
      if (doc.has(name)) {
        doc.delete(name);
        await writeFileAtomic(paths.secretsYaml, doc.toString(), 0o600);
      }
    }
    if (await exists(paths.secretsEnv)) {
      const lines = (await fs.readFile(paths.secretsEnv, "utf8")).split(/\r?\n/);
      const re = new RegExp(`^\\s*(export\\s+)?${name}(__HOSTS)?\\s*=`);
      const kept = lines.filter((l) => !re.test(l));
      if (kept.length !== lines.length) await writeFileAtomic(paths.secretsEnv, kept.join("\n"), 0o600);
    }
    await this.load();
  }
}
