import { createHash, randomBytes } from "node:crypto";
import { EventEmitter } from "node:events";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";

export const nowIso = () => new Date().toISOString();

export const randomId = (prefix = "", bytes = 8) => prefix + randomBytes(bytes).toString("hex");

export const sha256Hex = (s: string) => createHash("sha256").update(s).digest("hex");

export function expandHome(p: string): string {
  if (p === "~") return os.homedir();
  if (p.startsWith("~/")) return path.join(os.homedir(), p.slice(2));
  return p;
}

/** Write via temp file + rename so readers (and file watchers) never see a partial file. */
export async function writeFileAtomic(file: string, data: string, mode = 0o600): Promise<void> {
  const tmp = `${file}.${randomBytes(4).toString("hex")}.tmp`;
  await fs.writeFile(tmp, data, { mode });
  await fs.rename(tmp, file);
}

export async function exists(p: string): Promise<boolean> {
  try {
    await fs.access(p);
    return true;
  } catch {
    return false;
  }
}

/** Keep the head and tail of long tool output so both the command echo and the final error survive. */
export function truncateMiddle(s: string, max: number): string {
  if (s.length <= max) return s;
  const head = Math.floor(max * 0.4);
  const tail = max - head;
  const dropped = s.length - head - tail;
  return `${s.slice(0, head)}\n\n… [${dropped} characters truncated] …\n\n${s.slice(-tail)}`;
}

/** Host pattern match: "api.github.com" exact, "*.github.com" any subdomain (not the apex). */
export function hostMatches(host: string, pattern: string): boolean {
  const h = host.toLowerCase().replace(/\.$/, "");
  const p = pattern.toLowerCase().trim();
  if (p === "*") return false; // never allow "everything" by accident
  if (p.startsWith("*.")) return h.endsWith(p.slice(1)) && h.length > p.length - 1;
  return h === p;
}

export const hostMatchesAny = (host: string, patterns: Iterable<string>) => {
  for (const p of patterns) if (hostMatches(host, p)) return true;
  return false;
};

/** Glob with only `*` wildcards, anchored. */
export function wildcardMatch(value: string, pattern: string): boolean {
  const re = new RegExp(
    "^" + pattern.split("*").map((s) => s.replace(/[.+?^${}()|[\]\\]/g, "\\$&")).join(".*") + "$",
    "s",
  );
  return re.test(value);
}

export function debounce<T extends (...args: never[]) => void>(fn: T, ms: number): T {
  let t: NodeJS.Timeout | undefined;
  return ((...args: Parameters<T>) => {
    clearTimeout(t);
    t = setTimeout(() => fn(...args), ms);
  }) as T;
}

export const log = {
  info: (scope: string, msg: string, extra?: unknown) =>
    console.log(`${new Date().toISOString().slice(11, 19)} [${scope}] ${msg}`, extra ?? ""),
  warn: (scope: string, msg: string, extra?: unknown) =>
    console.warn(`${new Date().toISOString().slice(11, 19)} [${scope}] WARN ${msg}`, extra ?? ""),
  error: (scope: string, msg: string, extra?: unknown) =>
    console.error(`${new Date().toISOString().slice(11, 19)} [${scope}] ERROR ${msg}`, extra ?? ""),
};

export const errMsg = (e: unknown) => (e instanceof Error ? e.message : String(e));

/** Typed event bus shared by subsystems; the API layer fans these out to WebSocket clients. */
export class TypedEmitter<Events extends Record<string, unknown[]>> {
  private ee = new EventEmitter({ captureRejections: false });
  constructor() {
    this.ee.setMaxListeners(100);
  }
  on<K extends keyof Events & string>(event: K, fn: (...args: Events[K]) => void) {
    this.ee.on(event, fn as (...args: unknown[]) => void);
    return () => this.ee.off(event, fn as (...args: unknown[]) => void);
  }
  emit<K extends keyof Events & string>(event: K, ...args: Events[K]) {
    this.ee.emit(event, ...args);
  }
}
