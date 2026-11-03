import { EventEmitter } from "node:events";
import { promises as fs } from "node:fs";
import path from "node:path";
import type { TrackerItem, TriggersInfo, TriggerStatus, WatcherTestResult } from "@ph/shared";
import { intervalMs, type PersonaConfig, type PersonaStore } from "./personas.js";
import { paths } from "./settings.js";
import type { TrackerStore } from "./tracker.js";
import { errMsg, log, truncateMiddle, writeFileAtomic } from "./util.js";

type Schedule = PersonaConfig["schedules"][number];
type Watcher = PersonaConfig["watchers"][number];

/** What the trigger manager needs from a persona's conversation. */
export interface TriggerTarget {
  trigger(label: string, prompt: string): void;
  pollExec(argv: string[], timeoutMs?: number): Promise<{ code: number; stdout: string; stderr: string }>;
}

interface TState {
  lastRun: string | null;
  failures: number;
  lastError: string | null;
  retryAt: string | null; // after a failure
  day: string;
  firedToday: number;
  seen: Record<string, Record<string, string>>; // scope (tracker URL, or "") -> item id -> changed value
}
interface PState {
  paused: boolean;
  day: string;
  turnsToday: number;
  t: Record<string, TState>;
}

const TICK_MS = 20_000;
const MISSED_GRACE_MS = 2 * 3_600_000; // a schedule missed by less than this runs once on start
const SEEN_MAX = 2000;
const BATCH_MAX = 20;
const DAYS = ["sun", "mon", "tue", "wed", "thu", "fri", "sat"];

const today = (d = new Date()) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;

/** A value at a dotted path ("fields.updated"); "" is the value itself. */
export function lookup(v: unknown, p: string): unknown {
  if (!p) return v;
  let cur = v;
  for (const k of p.split(".")) {
    if (cur === null || typeof cur !== "object") return undefined;
    cur = (cur as Record<string, unknown>)[k];
  }
  return cur;
}

const show = (v: unknown) => (v === undefined || v === null ? "" : typeof v === "object" ? JSON.stringify(v) : String(v));

/** API URLs from page URLs, for the shapes a watcher needs most. */
const HELPERS: Record<string, (v: string) => string> = {
  // https://gitlab.example.com/group/project/-/merge_requests/482 -> https://gitlab.example.com/api/v4/projects/group%2Fproject/merge_requests/482
  gitlabApi: (v) => {
    const m = /^(https?:\/\/[^/]+)\/(.+?)\/-\/(merge_requests|issues)\/(\d+)/.exec(v);
    return m ? `${m[1]}/api/v4/projects/${encodeURIComponent(m[2]!)}/${m[3]}/${m[4]}` : v;
  },
  // https://github.com/owner/repo/pull/5 -> https://api.github.com/repos/owner/repo/issues/5
  githubApi: (v) => {
    const m = /^https:\/\/github\.com\/([^/]+)\/([^/]+)\/(?:pull|issues)\/(\d+)/.exec(v);
    return m ? `https://api.github.com/repos/${m[1]}/${m[2]}/issues/${m[3]}` : v;
  },
  urlencode: (v) => encodeURIComponent(v),
};

/** {{path}} lookups and {{helper path}}; nothing else. */
export function render(tpl: string, ctx: Record<string, unknown>): string {
  return tpl.replace(/\{\{\s*([^}]+?)\s*\}\}/g, (_, expr: string) => {
    const [a, b] = expr.split(/\s+/);
    if (b !== undefined && HELPERS[a!]) return HELPERS[a!]!(show(lookup(ctx, b)));
    return show(lookup(ctx, a!));
  });
}

function scheduleSlot(s: Schedule, now: Date): Date | null {
  if (!s.at) return null;
  const [h, m] = s.at.split(":").map(Number);
  const slot = new Date(now);
  slot.setHours(h!, m!, 0, 0);
  return slot;
}
const dayOk = (s: Schedule, d: Date) => !s.days?.length || s.days.includes(DAYS[d.getDay()] as never);

function nextSlot(s: Schedule, now: Date): Date | null {
  for (let i = 0; i < 8; i++) {
    const d = new Date(now.getTime() + i * 86_400_000);
    const slot = scheduleSlot(s, d)!;
    if (slot > now && dayOk(s, slot)) return slot;
  }
  return null;
}

function scheduleSummary(s: Schedule): string {
  if (s.every) return `Every ${s.every}`;
  const days = !s.days?.length ? "Every day" : s.days.length === 5 && !s.days.includes("sat") && !s.days.includes("sun") ? "Weekdays" : s.days.map((d) => d[0]!.toUpperCase() + d.slice(1)).join(", ");
  return `${days} at ${s.at}`;
}

/**
 * Schedules and watchers for every persona. Watchers fetch from the persona's sandbox, so their
 * requests pass the proxy with the persona's hosts and credential rules, like the agent's own.
 * The first check of anything only records what is there. Emits "changed" (personaId).
 */
export class TriggerManager extends EventEmitter {
  private state = new Map<string, PState>();
  private running = new Set<string>(); // persona/name
  private timer: NodeJS.Timeout | null = null;

  constructor(
    private d: { personas: PersonaStore; tracker: TrackerStore; target: (personaId: string) => TriggerTarget },
  ) {
    super();
  }

  start() {
    this.timer = setInterval(() => void this.tick(), TICK_MS);
    this.timer.unref();
    void this.tick();
  }

  stop() {
    if (this.timer) clearInterval(this.timer);
  }

  private file(personaId: string) {
    return path.join(paths.home, "triggers", `${personaId}.json`);
  }

  private async load(personaId: string): Promise<PState> {
    let st = this.state.get(personaId);
    if (st) return st;
    try {
      st = JSON.parse(await fs.readFile(this.file(personaId), "utf8")) as PState;
    } catch {
      st = { paused: false, day: today(), turnsToday: 0, t: {} };
    }
    this.state.set(personaId, st);
    return st;
  }

  private async save(personaId: string) {
    const st = this.state.get(personaId);
    if (!st) return;
    await fs.mkdir(path.dirname(this.file(personaId)), { recursive: true });
    await writeFileAtomic(this.file(personaId), JSON.stringify(st), 0o644);
    this.emit("changed", personaId);
  }

  private ts(st: PState, name: string): TState {
    const t = (st.t[name] ??= { lastRun: null, failures: 0, lastError: null, retryAt: null, day: today(), firedToday: 0, seen: {} });
    if (t.day !== today()) Object.assign(t, { day: today(), firedToday: 0 });
    return t;
  }

  private async tick() {
    for (const p of this.d.personas.list()) {
      const cfg = p.config;
      if (!cfg || (!cfg.schedules.length && !cfg.watchers.length)) continue;
      const st = await this.load(p.id);
      if (st.paused) continue;
      const now = new Date();
      for (const s of cfg.schedules) {
        const key = `${p.id}/${s.name}`;
        if (this.running.has(key)) continue;
        const t = this.ts(st, s.name);
        const last = t.lastRun ? new Date(t.lastRun) : null;
        if (s.every) {
          if (!last) {
            t.lastRun = now.toISOString(); // first one an interval from now
            await this.save(p.id);
          } else if (now.getTime() - last.getTime() >= intervalMs(s.every)) await this.fireSchedule(p.id, s, now);
          continue;
        }
        const slot = scheduleSlot(s, now)!;
        if (now < slot || !dayOk(s, slot) || (last && last >= slot)) continue;
        if (now.getTime() - slot.getTime() > MISSED_GRACE_MS) {
          Object.assign(t, { lastRun: slot.toISOString(), lastError: `Skipped ${s.at} on ${today(slot)}: Swan wasn't running then.` });
          await this.save(p.id);
        } else await this.fireSchedule(p.id, s, now);
      }
      for (const w of cfg.watchers) {
        const key = `${p.id}/${w.name}`;
        if (this.running.has(key)) continue;
        const t = this.ts(st, w.name);
        if (t.retryAt && now < new Date(t.retryAt)) continue;
        if (t.lastRun && now.getTime() - new Date(t.lastRun).getTime() < intervalMs(w.every)) continue;
        this.running.add(key);
        void this.check(p.id, w).finally(() => this.running.delete(key));
      }
    }
  }

  /** Start a turn, within the persona's daily limit. */
  private fire(personaId: string, st: PState, name: string, label: string, prompt: string, max: number): boolean {
    if (st.day !== today()) Object.assign(st, { day: today(), turnsToday: 0 });
    const t = this.ts(st, name);
    if (st.turnsToday >= max) {
      t.lastError = `Not started: this persona reached its ${max} triggered turns for today (unattended.maxTurnsPerDay).`;
      return false;
    }
    st.turnsToday++;
    t.firedToday++;
    this.d.target(personaId).trigger(label, prompt);
    return true;
  }

  private async fireSchedule(personaId: string, s: Schedule, now: Date) {
    const st = await this.load(personaId);
    const t = this.ts(st, s.name);
    t.lastRun = now.toISOString();
    if (this.fire(personaId, st, s.name, `schedule ${s.name}`, s.prompt, this.max(personaId))) t.lastError = null;
    await this.save(personaId);
  }

  private max(personaId: string) {
    return this.d.personas.get(personaId)?.config?.unattended.maxTurnsPerDay ?? 30;
  }

  /** One check of a watcher: fetch each scope, find what's new, start one turn for all of it. */
  private async check(personaId: string, w: Watcher) {
    const st = await this.load(personaId);
    const t = this.ts(st, w.name);
    t.lastRun = new Date().toISOString();
    try {
      const r = await this.poll(personaId, w, t.seen);
      t.seen = r.seen;
      t.failures = 0;
      t.retryAt = null;
      t.lastError = r.errors.length ? r.errors.join("; ") : null;
      if (r.matching.length) {
        const shown = r.matching.slice(0, BATCH_MAX).map((m) => m.text);
        const more = r.matching.length - shown.length;
        const prompt = shown.join("\n\n---\n\n") + (more > 0 ? `\n\n(${more} more new items not shown; check the source for the rest.)` : "");
        this.fire(personaId, st, w.name, `watcher ${w.name} · ${r.matching.length} new`, prompt, this.max(personaId));
      }
    } catch (e) {
      t.failures++;
      t.lastError = errMsg(e);
      const wait = Math.min(intervalMs(w.every) * 2 ** t.failures, 3_600_000);
      t.retryAt = new Date(Date.now() + wait).toISOString();
      log.warn("triggers", `${personaId}/${w.name}: ${t.lastError}`);
    }
    await this.save(personaId);
  }

  /** The tracker items a forEach watcher covers, or one unscoped run. */
  private async scopes(personaId: string, w: Watcher): Promise<{ key: string; ctx: Record<string, unknown> }[]> {
    if (!w.forEach) return [{ key: "", ctx: {} }];
    const f = w.forEach.tracker;
    const items = (await this.d.tracker.list(personaId)).filter((i: TrackerItem) => (!f.kind || i.kind === f.kind) && f.status.includes(i.status));
    return items.map((i) => ({ key: i.url, ctx: { tracker: i } }));
  }

  private async fetchItems(personaId: string, w: Watcher, ctx: Record<string, unknown>): Promise<unknown[]> {
    const argv = w.get
      ? ["curl", "-sS", "--fail-with-body", "--max-time", "30", "-H", "Accept: application/json", render(w.get, ctx)]
      : w.run!.map((a) => render(a, ctx));
    const r = await this.d.target(personaId).pollExec(argv, 60_000);
    if (r.code !== 0) throw new Error(`${w.get ? "request" : "command"} failed (exit ${r.code}): ${truncateMiddle((r.stderr || r.stdout).trim(), 300)}`);
    if (w.run) return r.stdout.split("\n").filter((l) => l.trim()).map((l) => JSON.parse(l) as unknown);
    let body: unknown;
    try {
      body = JSON.parse(r.stdout);
    } catch {
      throw new Error(`the response isn't JSON: ${truncateMiddle(r.stdout.trim(), 200)}`);
    }
    const list = lookup(body, w.items);
    if (!Array.isArray(list)) throw new Error(`no list at "${w.items || "(top level)"}" in the response`);
    return list;
  }

  /** Fetch every scope; return what's new against `seen` and the updated record. */
  private async poll(personaId: string, w: Watcher, seen: TState["seen"]) {
    const next: TState["seen"] = {};
    const matching: { label: string; text: string }[] = [];
    const errors: string[] = [];
    let checked = 0;
    let found = 0;
    const scopes = await this.scopes(personaId, w);
    for (const sc of scopes) {
      let list: unknown[];
      try {
        list = await this.fetchItems(personaId, w, sc.ctx);
      } catch (e) {
        if (scopes.length === 1) throw e;
        errors.push(`${sc.key}: ${errMsg(e)}`);
        if (seen[sc.key]) next[sc.key] = seen[sc.key]!;
        continue;
      }
      checked++;
      const before = seen[sc.key];
      const mine: Record<string, string> = { ...before };
      for (const it of list) {
        if (w.skip && Object.entries(w.skip).some(([k, v]) => lookup(it, k) === v)) continue;
        const id = lookup(it, w.id);
        if (id === undefined || id === null) continue;
        found++;
        const changed = w.changed ? show(lookup(it, w.changed)) : "";
        const k = String(id);
        if (before && mine[k] !== changed) matching.push({ label: k, text: render(w.prompt, { ...sc.ctx, item: it }) });
        delete mine[k];
        mine[k] = changed; // most recent last, for trimming
      }
      const keys = Object.keys(mine);
      next[sc.key] = Object.fromEntries(keys.slice(Math.max(0, keys.length - SEEN_MAX)).map((k) => [k, mine[k]!]));
    }
    return { seen: next, matching, errors, checked, found };
  }

  /** One check without recording anything or starting a turn: what would a real run send? */
  async test(personaId: string, name: string): Promise<WatcherTestResult> {
    const w = this.d.personas.get(personaId)?.config?.watchers.find((x) => x.name === name);
    if (!w) throw new Error(`no watcher "${name}" in this persona`);
    const r = await this.poll(personaId, w, Object.fromEntries((await this.scopes(personaId, w)).map((s) => [s.key, {}])));
    return { checked: r.checked, items: r.found, matching: r.matching.slice(0, 10), errors: r.errors };
  }

  /** Run a schedule, or check a watcher, now. */
  async runNow(personaId: string, name: string) {
    const cfg = this.d.personas.get(personaId)?.config;
    const s = cfg?.schedules.find((x) => x.name === name);
    if (s) return this.fireSchedule(personaId, s, new Date());
    const w = cfg?.watchers.find((x) => x.name === name);
    if (!w) throw new Error(`no schedule or watcher "${name}" in this persona`);
    await this.check(personaId, w);
  }

  async setPaused(personaId: string, paused: boolean) {
    (await this.load(personaId)).paused = paused;
    await this.save(personaId);
  }

  async info(personaId: string): Promise<TriggersInfo> {
    const cfg = this.d.personas.get(personaId)?.config;
    const st = await this.load(personaId);
    if (st.day !== today()) Object.assign(st, { day: today(), turnsToday: 0 });
    const now = new Date();
    const triggers: TriggerStatus[] = [];
    for (const s of cfg?.schedules ?? []) {
      const t = this.ts(st, s.name);
      const next = s.every ? (t.lastRun ? new Date(new Date(t.lastRun).getTime() + intervalMs(s.every)) : null) : nextSlot(s, now);
      triggers.push({ name: s.name, type: "schedule", summary: scheduleSummary(s), lastRun: t.lastRun, nextRun: st.paused ? null : (next?.toISOString() ?? null), lastError: t.lastError, failures: t.failures, firedToday: t.firedToday });
    }
    for (const w of cfg?.watchers ?? []) {
      const t = this.ts(st, w.name);
      const scopes = w.forEach ? (await this.scopes(personaId, w)).length : 0;
      const every = t.lastRun ? new Date(t.lastRun).getTime() + intervalMs(w.every) : now.getTime();
      const next = Math.max(every, t.retryAt ? new Date(t.retryAt).getTime() : 0);
      triggers.push({
        name: w.name,
        type: "watcher",
        summary: `Every ${w.every}${w.forEach ? ` · watching ${scopes} tracked ${w.forEach.tracker.kind ?? "item"}${scopes === 1 ? "" : "s"}` : ""}`,
        lastRun: t.lastRun,
        nextRun: st.paused ? null : new Date(next).toISOString(),
        lastError: t.lastError,
        failures: t.failures,
        firedToday: t.firedToday,
      });
    }
    return { paused: st.paused, triggers, turnsToday: st.turnsToday, maxTurnsPerDay: cfg?.unattended.maxTurnsPerDay ?? 30 };
  }
}
