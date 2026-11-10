import { promises as fs } from "node:fs";
import path from "node:path";
import YAML from "yaml";
import type { z } from "zod";
import { errMsg, exists, log, writeFileAtomic } from "./util.js";

export interface FileStoreOptions<T> {
  /** For log lines. */
  name: string;
  dir: () => string;
  format: "json" | "yaml";
  schema: z.ZodType<T>;
  empty: () => T;
  mode: number;
  dirMode?: number;
}

/**
 * State kept in one file per key (a persona or a conversation). It is read once, validated, and
 * cached; callers change the cached value and save it, and saves for a key run one at a time.
 * A file that is not valid is moved aside, never written over, and the key starts empty.
 */
export class FileStore<T> {
  private loaded = new Map<string, Promise<T>>();
  private chains = new Map<string, Promise<unknown>>();

  constructor(private o: FileStoreOptions<T>) {}

  file(key: string) {
    return path.join(this.o.dir(), `${key}.${this.o.format}`);
  }

  /** The value once the changes queued for the key have run. */
  async get(key: string): Promise<T> {
    await this.chains.get(key);
    return this.cached(key);
  }

  /** The cached value; the first call for a key reads the file (concurrent first calls share the read). */
  private cached(key: string): Promise<T> {
    let p = this.loaded.get(key);
    if (!p) {
      p = this.read(key);
      this.loaded.set(key, p);
      p.catch(() => this.loaded.delete(key)); // a read that failed is tried again next time
    }
    return p;
  }

  private async read(key: string): Promise<T> {
    const file = this.file(key);
    let raw: string;
    try {
      raw = await fs.readFile(file, "utf8");
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === "ENOENT") return this.o.empty();
      throw new Error(`could not read ${file}: ${errMsg(e)}`);
    }
    let problem: string;
    try {
      const r = this.o.schema.safeParse((this.o.format === "yaml" ? YAML.parse(raw) : JSON.parse(raw)) ?? {});
      if (r.success) return r.data;
      const issue = r.error.issues[0];
      problem = `${issue?.path.join(".") || "file"}: ${issue?.message}`;
    } catch (e) {
      problem = errMsg(e);
    }
    const aside = `${file}.invalid-${Date.now()}`;
    await fs.rename(file, aside).catch(() => {});
    log.warn(this.o.name, `${file} is not valid (${problem}). It was moved to ${path.basename(aside)}, and ${key} starts empty.`);
    return this.o.empty();
  }

  /** Run fn on the latest value, then save it; changes to a key run one at a time. */
  change<R>(key: string, fn: (value: T) => R | Promise<R>): Promise<R> {
    return this.queue(key, async () => {
      const value = await this.cached(key);
      const out = await fn(value);
      await this.write(key, value);
      return out;
    });
  }

  /** Write the cached value as it is now. */
  save(key: string): Promise<void> {
    return this.queue(key, async () => this.write(key, await this.cached(key)));
  }

  private async write(key: string, value: T) {
    await fs.mkdir(this.o.dir(), { recursive: true, ...(this.o.dirMode ? { mode: this.o.dirMode } : {}) });
    await writeFileAtomic(this.file(key), this.o.format === "yaml" ? YAML.stringify(value) : JSON.stringify(value), this.o.mode);
  }

  private queue<R>(key: string, fn: () => Promise<R>): Promise<R> {
    const run = (this.chains.get(key) ?? Promise.resolve()).then(fn);
    this.chains.set(key, run.catch(() => {}));
    return run;
  }

  /** Delete the key and its file, after any write in progress. */
  remove(key: string): Promise<void> {
    return this.queue(key, async () => {
      this.loaded.delete(key);
      await fs.rm(this.file(key), { force: true });
    });
  }

  /** Copy a key's file to another key, once its queued changes have run. */
  async copy(from: string, to: string): Promise<void> {
    await this.chains.get(from);
    if (!(await exists(this.file(from)))) return;
    await fs.mkdir(this.o.dir(), { recursive: true, ...(this.o.dirMode ? { mode: this.o.dirMode } : {}) });
    await fs.copyFile(this.file(from), this.file(to));
    this.loaded.delete(to);
  }
}
