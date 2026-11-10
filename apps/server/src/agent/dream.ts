// /dream: consolidating a conversation's events into the persona's memory, on request, at a
// rollover, or once the conversation has been quiet for a while.
import type { ChatItem, MemoryRecord } from "@ph/shared";
import type { MemoryStore } from "../memory.js";
import type { PersonaStore } from "../personas.js";
import type { UsagePurpose } from "../usage.js";
import { errMsg, truncateMiddle } from "../util.js";
import { itemLine, objs, parseJson, strs } from "./model-text.js";
import { ProviderError, type TurnResult } from "./providers.js";

const DREAM_EVENT_CHARS = 80_000; // events one /dream reads; later ones wait for the next run
const DREAM_RECHECK = 8; // saved memories one /dream rereads against their sources
export const IDLE_DREAM_MS = 10 * 60_000; // a conversation the user wrote in dreams once it has been quiet this long

/** /dream's view of an event: what a schedule, a watcher or another conversation sent is not the user's word. */
const dreamLine = (it: ChatItem): string => (it.kind === "user" && it.trigger ? itemLine(it).replace("] User:", `] Sent by ${it.trigger}, not the user:`) : itemLine(it));

export interface DreamHost {
  personaId: string;
  personas: PersonaStore;
  memory: MemoryStore;
  items(): ChatItem[];
  /** The events behind saved memories, from any of this persona's conversations. */
  findEvents(ids: string[]): ChatItem[];
  auxCall(system: string, prompt: string, purpose: UsagePurpose): Promise<{ text: string; result: TurnResult }>;
  receipt(action: "dream", title: string, detail: string): { done(detail: string, status?: "done" | "error"): void };
  notice(level: "info" | "warn" | "error", text: string): void;
  usageChanged(): void;
  persist(): Promise<void>;
  /** A turn or an approval is in progress, or the conversation is gone. */
  busy(): boolean;
}

export class SessionDream {
  private running = false;
  private idle: ReturnType<typeof setTimeout> | null = null;

  constructor(
    private host: DreamHost,
    public dreamedThrough: string | null, // id of the last event /dream has read in this conversation
  ) {}

  get active() {
    return this.running;
  }

  /** The persona dreams on its own, at rollovers and when quiet. */
  get auto() {
    const cfg = this.host.personas.get(this.host.personaId)?.config;
    return !!cfg && cfg.memory.autoDream !== false;
  }

  cancelIdle() {
    if (this.idle) clearTimeout(this.idle);
    this.idle = null;
  }

  /** Once the conversation has been quiet for a while, consolidate what the user said in it. */
  scheduleIdle() {
    this.cancelIdle();
    if (!this.auto) return;
    const t = setTimeout(() => {
      this.idle = null;
      void this.ifQuiet();
    }, IDLE_DREAM_MS);
    t.unref?.();
    this.idle = t;
  }

  /** Scheduled runs and messages from other conversations dream only at a rollover, or on /dream. */
  async ifQuiet() {
    if (this.host.busy() || this.running || !this.auto) return;
    if (!this.host.items().slice(this.from()).some((it) => it.kind === "user" && !it.trigger)) return;
    await this.run("quiet");
  }

  /**
   * Where this conversation's unconsolidated events start: after the last event /dream read here.
   * A conversation from before the bookmark was kept per conversation starts after its own last
   * successful /dream, never after one that ran in another conversation of the persona.
   */
  private from(): number {
    const items = this.host.items();
    if (this.dreamedThrough) {
      const i = items.findIndex((it) => it.id === this.dreamedThrough);
      if (i >= 0) return i + 1;
    }
    return items.findLastIndex((it) => it.kind === "receipt" && it.action === "dream" && it.status === "done") + 1;
  }

  /**
   * A /dream record may say the user said it only when it cites a message the user wrote (a revised
   * record's earlier sources count too); otherwise it is saved as a tentative inference.
   */
  private userOriginNeedsUserSource(add: Record<string, unknown>[], revise: Record<string, unknown>[], recs: MemoryRecord[]) {
    const sourcesOf = (e: Record<string, unknown>) => [...strs(e.sources), ...(recs.find((r) => r.id === e.id)?.sources ?? [])];
    const claims = [...add.map((e) => ({ e, sources: strs(e.sources) })), ...revise.map((e) => ({ e, sources: sourcesOf(e) }))].filter((c) => c.e.origin === "user");
    if (!claims.length) return;
    const said = new Set(
      this.host
        .findEvents([...new Set(claims.flatMap((c) => c.sources))])
        .filter((it) => it.kind === "user" && !it.trigger)
        .map((it) => it.id),
    );
    for (const c of claims) if (!c.sources.some((s) => said.has(s))) c.e.origin = "inference";
  }

  /**
   * Consolidate memory: read this conversation's events since the last run (oldest first, up to a
   * budget; the rest wait for the next run), reread a few saved memories against the events they
   * came from, and apply what the model proposes under MemoryStore's rules.
   */
  async run(auto?: "rollover" | "quiet") {
    const h = this.host;
    if (this.running) return auto ? undefined : h.notice("info", "/dream is already running.");
    this.running = true;
    const r = h.receipt("dream", "/dream", auto ? `Tidying memory (${auto === "rollover" ? "new context" : "conversation went quiet"})…` : "Consolidating memory…");
    try {
      const recs = (await h.memory.list(h.personaId)).filter((x) => x.status === "active" || x.status === "tentative").slice(0, 200);
      const recheck: { id: string; content: string; sourceEvents: string[] }[] = [];
      const checked: string[] = [];
      for (const rec of await h.memory.dueForRecheck(h.personaId, DREAM_RECHECK * 3)) {
        if (recheck.length >= DREAM_RECHECK) break;
        checked.push(rec.id); // also when its events are gone, so it moves to the back of the queue
        const found = h.findEvents(rec.sources).slice(0, 3);
        if (found.length) recheck.push({ id: rec.id, content: rec.content, sourceEvents: found.map((it) => truncateMiddle(dreamLine(it), 1000)) });
      }
      const items = h.items();
      const from = this.from();
      const lines: string[] = [];
      let used = 0;
      let upTo = from;
      for (; upTo < items.length; upTo++) {
        const line = dreamLine(items[upTo]);
        if (!line) continue;
        if (lines.length && used + line.length > DREAM_EVENT_CHARS) break;
        const l = truncateMiddle(line, DREAM_EVENT_CHARS);
        lines.push(l);
        used += l.length + 2;
      }
      const later = upTo < items.length;
      const { text, result } = await h.auxCall("You maintain a persona's long-term memory. Output only one JSON object, no prose.", dreamPrompt(recs, recheck, lines), "dream");
      const j = parseJson(text);
      if (!j) throw new Error("the model did not return a consolidation plan");
      const add = objs(j.add);
      const revise = objs(j.revise);
      this.userOriginNeedsUserSource(add, revise, recs);
      const changed = await h.memory.applyDream(h.personaId, {
        add: add as never,
        merge: objs(j.merge) as never,
        archive: strs(j.archive),
        revise: revise as never,
        checked,
      });
      if (upTo > from) this.dreamedThrough = items[upTo - 1].id;
      const credits = (result as TurnResult & { credits?: number }).credits;
      const tokens = result.usage.inputTokens + result.usage.outputTokens;
      const cost = credits !== undefined ? `${credits.toFixed(2)} credits` : tokens > 0 ? `${Math.max(0.1, Math.round(tokens / 100) / 10)}k tokens` : "usage not reported";
      const parts = [`${changed} record${changed === 1 ? "" : "s"} updated`, recheck.length ? `${recheck.length} rechecked` : "", later ? "newer events next time" : "", cost];
      r.done(`Consolidated memory · ${parts.filter(Boolean).join(" · ")}`);
      h.usageChanged();
    } catch (e) {
      r.done(`Memory unchanged: ${e instanceof ProviderError ? e.message : errMsg(e)}`, "error");
    } finally {
      this.running = false;
      await h.persist();
    }
  }
}

function dreamPrompt(recs: MemoryRecord[], recheck: { id: string; content: string; sourceEvents: string[] }[], lines: string[]): string {
  return [
    "Memory is how this persona gets better at its work: later conversations start out knowing only the saved records, and so does this one after its context rolls over, along with a checkpoint of the task in hand. Every record is loaded into those contexts, so one that isn't needed takes room from the work.",
    [
      "Most events need no memory, and a plan with every list empty is the usual result. Save only what a later conversation would need and could not get back:",
      "- how the user wants things done from now on: preferences, rules, standing instructions;",
      "- decisions and corrections, with the reason when one was given;",
      "- lessons: an approach that worked or failed, or one that was ruled out, and why.",
      "Don't save:",
      "- what can be read again from files, the repository or tools: file contents, sizes and layout, what was written or changed, command and test output;",
      "- the state, progress or next steps of the task in hand (the checkpoint carries those, and they go stale once the task is done);",
      "- an account of what happened, unless it holds a lesson;",
      "- what a current record already says (revise that record instead).",
      'Origin "user" is only for what the user wrote themself, citing that message\'s event id. Events marked "Sent by …, not the user" came from a schedule, a watcher or another conversation. Use "observation" for what tools showed and "inference" for anything else. Keep each record to one point, in a sentence or two.',
    ].join("\n"),
    `Current memory records:\n${JSON.stringify(recs.map((x) => ({ id: x.id, type: x.type, origin: x.origin, status: x.status, pinned: x.pinned, content: x.content })))}`,
    `Records to recheck against the events they were saved from (a record can be wrong from the start, or out of date since):\n${recheck.length ? JSON.stringify(recheck) : "(none)"}`,
    `Conversation events since the last consolidation (ids in brackets):\n${lines.join("\n\n") || "(none)"}`,
    `Return JSON {"add": [{"type": "preference|decision|observation|procedure|episode", "content": "...", "origin": "user|observation|inference", "sources": ["event ids"]}], "revise": [{"id": "record id", "content": "the corrected text", "reason": "what was wrong", "origin": "user|observation|inference", "sources": ["event ids"]}], "merge": [{"keep": "record id", "remove": ["duplicate record ids"], "content": "merged text"}], "archive": ["ids of records that no longer matter, or that the rules above say not to keep"]}. Revise a record when the events show it is wrong, out of date or incomplete. Cite event ids as sources. Never re-add archived or forgotten facts.`,
  ].join("\n\n");
}
