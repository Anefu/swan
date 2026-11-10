import type { Checkpoint, MemoryChange, MemoryOrigin, MemoryRecord, MemoryType } from "@ph/shared";
import { z } from "zod";
import { FileStore } from "./file-store.js";
import { paths } from "./settings.js";
import { TypedEmitter, nowIso, randomId } from "./util.js";

export const MEMORY_TYPES: MemoryType[] = ["preference", "decision", "observation", "procedure", "episode"];

const tokenize = (s: string) => s.toLowerCase().match(/[a-z0-9_.-]{2,}/g) ?? [];
const ORIGINS: MemoryOrigin[] = ["user", "observation", "inference"];
const live = (r: MemoryRecord | undefined) => !!r && (r.status === "active" || r.status === "tentative");

const strings = z.array(z.string()).default([]);
// Fields Swan doesn't know (from a newer version) are kept as written.
const RecordSchema = z.looseObject({
  id: z.string(),
  version: z.number().default(1),
  type: z.enum(MEMORY_TYPES),
  content: z.string(),
  origin: z.enum(ORIGINS),
  status: z.enum(["active", "tentative", "archived", "forgotten"]),
  pinned: z.boolean().default(false),
  sources: strings,
  createdAt: z.string(),
  updatedAt: z.string(),
  checkedAt: z.string().optional(),
});
const ChangeSchema = z.looseObject({
  id: z.string(),
  ts: z.string(),
  recordId: z.string(),
  action: z.enum(["added", "edited", "pinned", "unpinned", "archived", "forgotten", "merged", "dream"]),
  summary: z.string(),
  by: z.enum(["user", "agent", "dream"]),
  before: z.string().optional(),
  after: z.string().optional(),
});
const CheckpointSchema = z.looseObject({
  sessionId: z.string().optional(),
  epoch: z.number(),
  createdAt: z.string(),
  objective: z.string(),
  constraints: strings,
  decisions: strings,
  completed: strings,
  failures: strings,
  openQuestions: strings,
  nextAction: z.string(),
  sources: strings,
});
const MemorySchema = z.object({ records: z.array(RecordSchema).default([]), changes: z.array(ChangeSchema).default([]), checkpoints: z.array(CheckpointSchema).default([]) });
type PersonaMemory = { records: MemoryRecord[]; changes: MemoryChange[]; checkpoints: Checkpoint[] };

/**
 * Persona-private memory: versioned records, a change log and committed checkpoints, one JSON file
 * per persona under PH_HOME/memory. Never mounted into a sandbox. Search is lexical with metadata
 * filters, ranked by term overlap, pinning and freshness.
 */
export class MemoryStore extends TypedEmitter<{ changed: [string] }> {
  private store = new FileStore<PersonaMemory>({
    name: "memory",
    dir: () => paths.memory,
    format: "json",
    schema: MemorySchema,
    empty: () => ({ records: [], changes: [], checkpoints: [] }),
    mode: 0o600,
    dirMode: 0o700,
  });

  private load(personaId: string): Promise<PersonaMemory> {
    return this.store.get(personaId);
  }

  /** Writes run one at a time per persona, so foreground edits and /dream never interleave. */
  private async save(personaId: string) {
    await this.store.save(personaId);
    this.emit("changed", personaId);
  }

  private log(m: PersonaMemory, c: Omit<MemoryChange, "id" | "ts">) {
    m.changes.push({ id: randomId("mc_", 6), ts: nowIso(), ...c });
    if (m.changes.length > 2000) m.changes.splice(0, m.changes.length - 2000);
  }

  async list(personaId: string, f: { query?: string; type?: string; status?: string } = {}): Promise<MemoryRecord[]> {
    const m = await this.load(personaId);
    let recs = m.records.filter((r) => (f.status ? r.status === f.status : r.status !== "forgotten"));
    if (f.type) recs = recs.filter((r) => r.type === f.type);
    if (f.query?.trim()) return this.rank(recs, f.query);
    return recs.sort((a, b) => Number(b.pinned) - Number(a.pinned) || b.updatedAt.localeCompare(a.updatedAt));
  }

  private rank(recs: MemoryRecord[], query: string): MemoryRecord[] {
    const terms = new Set(tokenize(query));
    const now = Date.now();
    return recs
      .map((r) => {
        const words = tokenize(r.content);
        const hits = words.filter((w) => terms.has(w)).length;
        const ageDays = (now - Date.parse(r.updatedAt)) / 86400_000;
        return { r, score: hits === 0 ? 0 : hits + (r.pinned ? 2 : 0) + (r.origin === "user" ? 1 : 0) + 1 / (1 + ageDays) };
      })
      .filter((x) => x.score > 0)
      .sort((a, b) => b.score - a.score)
      .map((x) => x.r);
  }

  /** Active records the agent may retrieve (tentative ones are labelled, archived/forgotten never). */
  async search(personaId: string, query: string, type?: string, limit = 8) {
    const recs = (await this.load(personaId)).records.filter((r) => (r.status === "active" || r.status === "tentative") && (!type || r.type === type));
    return this.rank(recs, query).slice(0, limit);
  }

  async get(personaId: string, id: string) {
    return (await this.load(personaId)).records.find((r) => r.id === id);
  }

  async add(personaId: string, a: { content: string; type: MemoryType; origin: MemoryOrigin; sources: string[]; pinned?: boolean; by: MemoryChange["by"] }) {
    if (!a.content.trim()) throw new Error("memory content is empty");
    if (!MEMORY_TYPES.includes(a.type)) throw new Error(`type must be one of ${MEMORY_TYPES.join(", ")}`);
    const m = await this.load(personaId);
    const ts = nowIso();
    const rec: MemoryRecord = {
      id: randomId("mem_", 6),
      version: 1,
      type: a.type,
      content: a.content.trim().slice(0, 4000),
      origin: a.origin,
      // Inferred preferences stay tentative until a person confirms them.
      status: a.origin === "inference" ? "tentative" : "active",
      pinned: !!a.pinned,
      sources: a.sources.slice(0, 20),
      createdAt: ts,
      updatedAt: ts,
    };
    m.records.push(rec);
    this.log(m, { recordId: rec.id, action: "added", summary: rec.content.slice(0, 120), by: a.by, after: rec.content });
    await this.save(personaId);
    return rec;
  }

  async edit(personaId: string, id: string, e: { content?: string; type?: MemoryType }, by: MemoryChange["by"] = "user") {
    const m = await this.load(personaId);
    const r = m.records.find((x) => x.id === id);
    if (!r) throw new Error("memory record not found");
    const before = r.content;
    if (e.content !== undefined) r.content = e.content.trim().slice(0, 4000);
    if (e.type) r.type = e.type;
    r.version += 1;
    r.updatedAt = nowIso();
    if (by === "user" && r.status === "tentative") r.status = "active"; // a person's edit confirms it
    this.log(m, { recordId: id, action: "edited", summary: r.content.slice(0, 120), by, before, after: r.content });
    await this.save(personaId);
    return r;
  }

  /**
   * Correct a live record from what the agent or /dream learned: new content, the events it now
   * rests on, and an origin that says who it comes from. A record that becomes an inference is
   * tentative again; one that stops being one becomes active.
   */
  async revise(personaId: string, id: string, v: { content: string; origin?: MemoryOrigin; sources?: string[]; reason?: string }, by: MemoryChange["by"]) {
    const m = await this.load(personaId);
    const r = m.records.find((x) => x.id === id);
    if (!r || !live(r)) throw new Error("memory record not found");
    this.reviseIn(m, r, v, by, nowIso());
    await this.save(personaId);
    return r;
  }

  private reviseIn(m: PersonaMemory, r: MemoryRecord, v: { content: string; origin?: MemoryOrigin; sources?: string[]; reason?: string }, by: MemoryChange["by"], ts: string) {
    const before = r.content;
    r.content = v.content.trim().slice(0, 4000);
    if (v.origin && ORIGINS.includes(v.origin) && v.origin !== r.origin) {
      r.origin = v.origin;
      r.status = v.origin === "inference" ? "tentative" : "active";
    }
    if (v.sources?.length) r.sources = [...new Set([...r.sources, ...v.sources])].slice(-20);
    r.version += 1;
    r.updatedAt = ts;
    const why = v.reason?.trim();
    this.log(m, { recordId: r.id, action: "edited", summary: (why ? `Corrected: ${why}` : r.content).slice(0, 120), by, before, after: r.content });
  }

  /**
   * Records for /dream to reread against the events they were saved from, oldest check first:
   * tentative ones lead, since they are unconfirmed. Only records that cite events qualify.
   */
  async dueForRecheck(personaId: string, limit: number): Promise<MemoryRecord[]> {
    return (await this.load(personaId)).records
      .filter((r) => live(r) && r.sources.some((s) => s !== "user"))
      .sort((a, b) => Number(b.status === "tentative") - Number(a.status === "tentative") || (a.checkedAt ?? "").localeCompare(b.checkedAt ?? "") || a.updatedAt.localeCompare(b.updatedAt))
      .slice(0, limit);
  }

  async act(personaId: string, id: string, action: "pin" | "unpin" | "archive" | "forget", by: MemoryChange["by"] = "user", note?: string) {
    const m = await this.load(personaId);
    const r = m.records.find((x) => x.id === id);
    if (!r) throw new Error("memory record not found");
    if (action === "pin" || action === "unpin") r.pinned = action === "pin";
    else r.status = action === "archive" ? "archived" : "forgotten";
    r.updatedAt = nowIso();
    r.version += 1;
    const verb = { pin: "pinned", unpin: "unpinned", archive: "archived", forget: "forgotten" } as const;
    this.log(m, { recordId: id, action: verb[action], summary: (note?.trim() ? `${note.trim()} — ${r.content}` : r.content).slice(0, 120), by });
    await this.save(personaId);
    return r;
  }

  async history(personaId: string): Promise<MemoryChange[]> {
    return [...(await this.load(personaId)).changes].reverse();
  }

  /** Bounded brief loaded at the start of each context epoch: pinned first, then recent active. */
  async brief(personaId: string, maxChars: number): Promise<string> {
    const recs = (await this.load(personaId)).records
      .filter((r) => r.status === "active" || (r.status === "tentative" && r.pinned))
      .sort((a, b) => Number(b.pinned) - Number(a.pinned) || b.updatedAt.localeCompare(a.updatedAt));
    const lines: string[] = [];
    let used = 0;
    for (const r of recs) {
      const line = `- [${r.id}] (${r.type}${r.origin === "inference" ? ", tentative" : ""}) ${r.content.replace(/\s+/g, " ")}`;
      if (used + line.length > maxChars) break;
      lines.push(line);
      used += line.length;
    }
    return lines.join("\n");
  }

  async addCheckpoint(personaId: string, c: Checkpoint) {
    const m = await this.load(personaId);
    m.checkpoints.push(c);
    if (m.checkpoints.length > 50) m.checkpoints.splice(0, m.checkpoints.length - 50);
    await this.save(personaId);
  }

  /**
   * The latest checkpoint, of one conversation when sessionId is given. Checkpoints from before a
   * persona could have several conversations have no sessionId: one belongs to the conversation
   * that holds its sources. Event ids are unique across conversations, except that a fork keeps
   * the ids of the events it copied, so such a checkpoint serves both.
   */
  async latestCheckpoint(personaId: string, sessionId?: string, hasEvent?: (id: string) => boolean): Promise<Checkpoint | null> {
    const all = (await this.load(personaId)).checkpoints;
    if (!sessionId) return all.at(-1) ?? null;
    return all.findLast((c) => c.sessionId === sessionId || (!c.sessionId && !!hasEvent && c.sources.some(hasEvent))) ?? null;
  }

  /** Apply a consolidation result atomically. Archived and forgotten records are never revived. */
  async applyDream(
    personaId: string,
    d: {
      add: { type: MemoryType; content: string; origin: MemoryOrigin; sources: string[] }[];
      merge: { keep: string; remove: string[]; content: string }[];
      archive: string[];
      revise?: { id: string; content: string; reason?: string; origin?: MemoryOrigin; sources?: string[] }[];
      checked?: string[]; // records it reread against their sources
    },
  ): Promise<number> {
    const m = await this.load(personaId);
    let changed = 0;
    const find = (id: string) => m.records.find((r) => r.id === id && live(r));
    const ts = nowIso();
    for (const v of d.revise ?? []) {
      const r = find(v.id);
      if (!r || typeof v.content !== "string" || !v.content.trim() || v.content.trim() === r.content) continue;
      this.reviseIn(m, r, { ...v, sources: Array.isArray(v.sources) ? v.sources.filter((s) => typeof s === "string") : undefined }, "dream", ts);
      changed++;
    }
    for (const id of d.checked ?? []) {
      const r = find(id);
      if (r) r.checkedAt = ts;
    }
    for (const a of d.add) {
      if (!a.content?.trim() || !MEMORY_TYPES.includes(a.type)) continue;
      const dup = m.records.some((r) => r.content.trim().toLowerCase() === a.content.trim().toLowerCase());
      if (dup) continue;
      const rec: MemoryRecord = {
        id: randomId("mem_", 6),
        version: 1,
        type: a.type,
        content: a.content.trim().slice(0, 4000),
        origin: a.origin === "user" ? "user" : a.origin === "observation" ? "observation" : "inference",
        status: a.origin === "inference" ? "tentative" : "active",
        pinned: false,
        sources: (a.sources ?? []).slice(0, 20),
        createdAt: ts,
        updatedAt: ts,
      };
      m.records.push(rec);
      this.log(m, { recordId: rec.id, action: "dream", summary: `Added: ${rec.content.slice(0, 100)}`, by: "dream", after: rec.content });
      changed++;
    }
    for (const g of d.merge) {
      const keep = find(g.keep);
      if (!keep || !g.content?.trim()) continue;
      const before = keep.content;
      keep.content = g.content.trim().slice(0, 4000);
      keep.version += 1;
      keep.updatedAt = ts;
      for (const id of g.remove) {
        const r = find(id);
        if (!r || r.id === keep.id || r.origin === "user") continue; // never fold away a user statement
        r.status = "archived";
        r.updatedAt = ts;
      }
      this.log(m, { recordId: keep.id, action: "merged", summary: `Merged ${g.remove.length} record(s)`, by: "dream", before, after: keep.content });
      changed++;
    }
    for (const id of d.archive) {
      const r = find(id);
      if (!r || r.origin === "user" || r.pinned) continue;
      r.status = "archived";
      r.updatedAt = ts;
      this.log(m, { recordId: id, action: "archived", summary: r.content.slice(0, 120), by: "dream" });
      changed++;
    }
    await this.save(personaId);
    return changed;
  }

  removePersona(personaId: string) {
    return this.store.remove(personaId);
  }
}
