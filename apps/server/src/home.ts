import { promises as fs, readFileSync, unlinkSync } from "node:fs";
import net from "node:net";
import path from "node:path";
import YAML from "yaml";
import { z } from "zod";
import { errMsg, log, nowIso, writeFileAtomic } from "./util.js";

/** A Swan server answers on this port with this home's token (no other server has the token). */
export async function swanAnswers(port: number, token: string): Promise<boolean> {
  if (!port || !token) return false;
  try {
    const r = await fetch(`http://127.0.0.1:${port}/api/runtime`, { headers: { "x-ph-token": token }, signal: AbortSignal.timeout(1500) });
    return r.ok;
  } catch {
    return false;
  }
}

/** The configured port and token of a home, as an older server that predates the lock file would use them. */
async function homeEndpoint(home: string): Promise<{ port: number; token: string }> {
  let port = 4317;
  try {
    const cfg = YAML.parse(await fs.readFile(path.join(home, "config.yaml"), "utf8")) as { port?: unknown } | null;
    if (typeof cfg?.port === "number") port = cfg.port;
  } catch {
    // missing or unreadable config: the server would use the default port
  }
  const token = await fs.readFile(path.join(home, "api-token"), "utf8").then((t) => t.trim(), () => "");
  return { port, token };
}

/**
 * Swan's home moved from ~/.persona-harness to ~/.swan. Move it once, and leave a link at the old
 * path so a checkout from before the move still finds the same data. Refuses while a Swan is
 * running on the old home, since that server would keep writing to it.
 */
export async function moveLegacyHome(from: string, to: string): Promise<boolean> {
  if (await fs.lstat(to).then(() => true, () => false)) return false;
  const old = await fs.lstat(from).catch(() => null);
  if (!old?.isDirectory()) return false;
  const { port, token } = await homeEndpoint(from);
  if (await swanAnswers(port, token))
    throw new Error(`An older Swan is running on ${from} (port ${port}). Stop it, then start Swan again; your data then moves to ${to}.`);
  await fs.rename(from, to);
  await fs.symlink(to, from);
  log.info("main", `moved ${from} to ${to} (the old path is now a link)`);
  return true;
}

const LockRecord = z.object({
  pid: z.number().int(),
  port: z.number().int().nullable(),
  proxyPort: z.number().int().nullable(),
  version: z.string(),
  startedAt: z.string(),
});
export type LockRecord = z.infer<typeof LockRecord>;

export class HomeInUseError extends Error {
  constructor(
    readonly home: string,
    readonly url: string | null,
    readonly pid: number | null,
  ) {
    super(`Swan is already running for ${home}${url ? ` at ${url}` : ""}${pid ? ` (pid ${pid})` : ""}. Use that one, or stop it first.`);
  }
}

// A server that has not listened yet has no port to probe; trust its pid for this long.
const STARTING_GRACE_MS = 120_000;

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === "EPERM";
  }
}

async function readRecord(file: string): Promise<LockRecord | null> {
  try {
    return LockRecord.parse(JSON.parse(await fs.readFile(file, "utf8")));
  } catch {
    return null;
  }
}

async function stillRunning(rec: LockRecord, token: string): Promise<boolean> {
  if (rec.pid === process.pid || !alive(rec.pid)) return false;
  if (rec.port) return swanAnswers(rec.port, token); // a reused pid does not answer with our token
  return Date.now() - Date.parse(rec.startedAt) < STARTING_GRACE_MS;
}

/** server.json in the home: one server per home, whether started from a checkout or the app. */
export class HomeLock {
  private constructor(
    private file: string,
    private rec: LockRecord,
  ) {}

  static async claim(opts: { home: string; file: string; token: string; configPort: number; version: string }): Promise<HomeLock> {
    const url = (port: number) => `http://127.0.0.1:${port}/`;
    // Servers from before the lock file existed only show themselves by answering.
    if (await swanAnswers(opts.configPort, opts.token)) throw new HomeInUseError(opts.home, url(opts.configPort), null);
    const rec: LockRecord = { pid: process.pid, port: null, proxyPort: null, version: opts.version, startedAt: nowIso() };
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        await fs.writeFile(opts.file, JSON.stringify(rec, null, 2) + "\n", { flag: "wx", mode: 0o600 });
        return new HomeLock(opts.file, rec);
      } catch (e) {
        if ((e as NodeJS.ErrnoException).code !== "EEXIST") throw e;
      }
      const other = await readRecord(opts.file);
      if (other && (await stillRunning(other, opts.token))) throw new HomeInUseError(opts.home, other.port ? url(other.port) : null, other.pid);
      log.info("main", `removing a stale ${path.basename(opts.file)}${other ? ` (pid ${other.pid})` : ""}`);
      await fs.rm(opts.file, { force: true });
    }
    throw new Error(`could not claim ${opts.file}; remove it if no Swan is running`);
  }

  async update(patch: Partial<Pick<LockRecord, "port" | "proxyPort">>): Promise<void> {
    this.rec = { ...this.rec, ...patch };
    await writeFileAtomic(this.file, JSON.stringify(this.rec, null, 2) + "\n", 0o600);
  }

  /** Synchronous so it also runs from an exit handler; leaves a file another server has since claimed. */
  releaseSync(): void {
    try {
      const cur = LockRecord.parse(JSON.parse(readFileSync(this.file, "utf8")));
      if (cur.pid === process.pid) unlinkSync(this.file);
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== "ENOENT") log.warn("main", `could not remove ${this.file}: ${errMsg(e)}`);
    }
  }
}

/** The preferred port, or 0 (any free port) when it is taken and falling back is allowed. */
export async function choosePort(preferred: number, fallback: boolean): Promise<number> {
  if (!fallback || preferred === 0) return preferred;
  const free = await new Promise<boolean>((resolve) => {
    const s = net.createServer();
    s.once("error", () => resolve(false));
    s.listen(preferred, "127.0.0.1", () => s.close(() => resolve(true)));
  });
  if (!free) log.warn("main", `port ${preferred} is in use; using a free port instead`);
  return free ? preferred : 0;
}
