// A conversation's model context: epochs, each a bounded context with a fixed prompt, tools and
// model, and the rollover from one to the next through a checkpoint.
import type { ChatItem, Checkpoint } from "@ph/shared";
import type { ConnectionManager } from "../connections/manager.js";
import type { MemoryStore } from "../memory.js";
import type { PersonaStore } from "../personas.js";
import type { Settings } from "../settings.js";
import type { SkillRegistry } from "../skills.js";
import type { UsagePurpose } from "../usage.js";
import { errMsg, log, nowIso, truncateMiddle } from "../util.js";
import { itemLine, parseJson, strs } from "./model-text.js";
import { systemText, type ContentBlockParam, type MessageParam, type SystemPrompt, type TurnResult } from "./providers.js";
import { systemPrompt } from "./system-prompt.js";
import type { ToolDef } from "./tools.js";

export interface FrozenTool {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}

/**
 * A context epoch: one bounded model context inside the same conversation. Its system prompt,
 * tools and model are fixed for its lifetime (prompt caching; reasoning blocks are only valid
 * against an unchanged prefix). Its messages are append-only.
 */
export interface Epoch {
  n: number;
  model: { provider: string; id: string };
  frozen: { system: SystemPrompt; tools: FrozenTool[] }; // a string in sessions saved before the prompt had parts
  messages: MessageParam[];
  startedAt: string;
  contextTokens?: number; // input context of the latest request in this epoch
}

export interface ContextHost {
  id: string;
  personaId: string;
  personas: PersonaStore;
  skills: SkillRegistry;
  settings: Settings;
  memory: MemoryStore;
  connections: ConnectionManager;
  credentials: { namedRefs(): string[]; promptLines(): string[] };
  liveTools(): ToolDef[];
  workdir(): string;
  model(): { provider: string; id: string };
  items(): ChatItem[];
  receipt(action: "rollover", title: string, detail: string): { done(detail: string, status?: "done" | "error"): void };
  notice(level: "info" | "warn" | "error", text: string): void;
  auxCall(system: string, prompt: string, purpose: UsagePurpose): Promise<{ text: string; result: TurnResult }>;
  /** /dream alongside a checkpoint, when the persona has it on. */
  dreamForRollover(): Promise<void>;
  aborted(): boolean;
  opened(n: number, model: { provider: string; id: string }): void;
  persist(): Promise<void>;
}

export class ModelContext {
  constructor(
    private host: ContextHost,
    readonly epochs: Epoch[],
    public carry: string | null, // checkpoint text waiting to open the next user message of a new epoch
  ) {}

  get current(): Epoch | undefined {
    return this.epochs.at(-1);
  }

  /** Build a fresh epoch: current persona model, current tools, memory brief, frozen until the next one. */
  async open() {
    const h = this.host;
    const persona = h.personas.get(h.personaId)!;
    const cfg = persona.config!;
    const m = h.model();
    const n = (this.current?.n ?? 0) + 1;
    const brief = cfg.memory.autoBrief ? await h.memory.brief(h.personaId, cfg.memory.briefTokens * 4) : "";
    this.epochs.push({
      n,
      model: { provider: m.provider, id: m.id },
      frozen: {
        system: systemPrompt({
          name: cfg.name,
          instructions: cfg.instructions,
          folders: persona.folders,
          workdir: h.workdir(),
          allow: cfg.network.allow,
          credHosts: h.credentials.namedRefs().flatMap((ref) => h.connections.usable(ref)?.hosts ?? []),
          credentialLines: h.credentials.promptLines(),
          skills: cfg.skills.flatMap((s) => (h.skills.get(s) ? [{ name: s, description: h.skills.get(s)!.description }] : [])),
          brief,
          epoch: n,
        }),
        tools: h.liveTools().map((t) => ({ name: t.name, description: t.description, inputSchema: t.inputSchema })),
      },
      messages: [],
      startedAt: nowIso(),
    });
    h.opened(n, { provider: m.provider, id: m.id });
  }

  /** Why the next request needs a new epoch, or null. */
  rolloverReason(): string | null {
    const e = this.current;
    if (!e || !e.messages.length) return null;
    const m = this.host.model();
    if (e.model.provider !== m.provider || e.model.id !== m.id) return `model changed to ${m.id}`;
    // Tools added since this context began (a new skill, MCP server or Swan version) reach the model only in a fresh one.
    const added = this.host
      .liveTools()
      .map((t) => t.name)
      .filter((n) => !e.frozen.tools.some((t) => t.name === n));
    if (added.length) return `new tools: ${added.slice(0, 5).join(", ")}${added.length > 5 ? "…" : ""}`;
    // A fresh epoch must do some work before it can roll over again, or an oversized carry-over thrashes.
    if (e.messages.filter((x) => x.role === "assistant").length < 2) return null;
    const used = e.contextTokens ?? Math.ceil(JSON.stringify(e.messages).length / 4);
    const limit = this.host.settings.contextLimitTokens;
    if (used > limit * this.host.settings.rolloverAt) return `context reached ${Math.round((used / limit) * 100)}% of ${Math.round(limit / 1000)}k tokens`;
    return null;
  }

  /** Before a message: an epoch to write into, rolled over if the current one is done. */
  async prepare() {
    if (!this.current) await this.open();
    const reason = this.rolloverReason();
    if (reason) await this.rollover(reason);
  }

  /**
   * Context rollover: checkpoint the epoch, then open a new one whose first user message carries
   * the checkpoint and a recent tail. Original events are never rewritten. A failed checkpoint keeps
   * the old epoch committed and continues with a mechanical tail instead of losing history.
   */
  async rollover(reason: string) {
    const h = this.host;
    const old = this.current!;
    const items = h.items();
    const r = h.receipt("rollover", "New context", `Condensing earlier context (${reason})…`);
    // Alongside the checkpoint, so what it saves is in the new context's memory brief.
    const dreamt = h.dreamForRollover();
    const own = new Set(items.map((it) => it.id));
    const prev = await h.memory.latestCheckpoint(h.personaId, h.id, (id) => own.has(id));
    const epochItems = items.filter((it) => it.ts >= old.startedAt);
    const transcript = truncateMiddle(epochItems.map(itemLine).filter(Boolean).join("\n\n"), 150_000);
    const strategy = h.settings.rolloverStrategy;
    const cp = strategy === "retrieval" ? null : await this.checkpoint(old, prev, transcript, strategy);
    if (cp) await h.memory.addCheckpoint(h.personaId, cp);
    else if (strategy !== "retrieval") h.notice("warn", "Could not write a structured checkpoint; the new context carries the recent conversation instead. Earlier turns stay searchable with history_search.");

    const parts = [`[Carried over from earlier in this conversation — context ${old.n + 1} starts here (${reason}).]`];
    if (cp) {
      const list = (head: string, xs: string[]) => (xs.length ? `${head}:\n${xs.map((x) => `- ${x}`).join("\n")}` : "");
      parts.push(
        "## Checkpoint",
        `Objective: ${cp.objective}`,
        list("Constraints", cp.constraints),
        list("Decisions", cp.decisions),
        list("Completed", cp.completed),
        list("Failures", cp.failures),
        list("Open questions", cp.openQuestions),
        `Next action: ${cp.nextAction}`,
        cp.sources.length ? `Sources: ${cp.sources.join(", ")}` : "",
      );
    }
    if (strategy === "retrieval") {
      const lastUser = [...items].reverse().find((it) => it.kind === "user");
      parts.push(
        "Earlier turns of this conversation are no longer in your context; nothing has been summarised. Before continuing, use history_search and history_read to recover what you need verbatim: the user's goal, their constraints and corrections, and the state of unfinished work.",
        lastUser ? `The latest user message is event ${lastUser.id}.` : "",
        "[End of carried-over context.]",
      );
    }
    // The new context's prompt depends on what /dream saved, so the room for recent events is known only once it is open.
    await dreamt;
    await this.open();
    if (strategy !== "retrieval") {
      const closing = ["Earlier details (rationale, attempts, tool output) are in history: use history_search / history_read rather than guessing.", "[End of carried-over context.]"];
      // Without a checkpoint the recent events are all the new context gets, so some go even when room is short.
      const room = this.tailRoom(old, this.current!, [...parts, "## Most recent events", ...closing].join("\n\n").length + 100);
      const chars = Math.min(strategy === "full" ? 16_000 : 4_000, cp ? room : Math.max(room, 4_000));
      const tail = truncateMiddle(items.slice(strategy === "full" ? -24 : -6).map(itemLine).filter(Boolean).join("\n\n"), chars);
      if (chars >= 500 && tail) parts.push("## Most recent events", tail);
      parts.push(...closing);
    }
    this.carry = parts.filter(Boolean).join("\n\n");
    r.done(
      strategy === "retrieval" ? `Context ${old.n + 1}: history pointer only (${reason})` : cp ? `Context ${old.n + 1}: ${strategy} checkpoint saved (${reason})` : `Context ${old.n + 1}: recent events carried over (${reason})`,
      cp || strategy === "retrieval" ? "done" : "error",
    );
    await h.persist();
  }

  /** The model's checkpoint of the epoch, in two attempts; null if neither gave one. */
  private async checkpoint(old: Epoch, prev: Checkpoint | null, transcript: string, strategy: Settings["rolloverStrategy"]): Promise<Checkpoint | null> {
    const h = this.host;
    const ask =
      strategy === "minimal"
        ? `Write a SMALL continuity checkpoint as JSON with exactly these keys: "objective" (the active goal), "constraints" (explicit user constraints, verbatim), "openQuestions" (unfinished work, one line each), "completed" (artifact references only: file paths, commits, URLs), "nextAction" (one concrete next step), "sources" (event ids to retrieve for details). Do not summarise rationale, attempts or tool output: the agent will retrieve those from history. Arrays of strings except objective and nextAction.`
        : `Write the checkpoint for ALL unfinished work as JSON with exactly these keys: "objective" (the user's goal and acceptance criteria), "constraints" (explicit user constraints, verbatim where possible), "decisions" (with rationale), "completed" (work done, with file paths/artifacts), "failures" (what failed and test evidence), "openQuestions", "nextAction" (one concrete next step), "sources" (event ids that support the above). Arrays of strings except objective and nextAction.`;
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        const { text } = await h.auxCall(
          "You write checkpoints that let an agent continue a long task in a fresh context. Output only one JSON object, no prose.",
          `Previous checkpoint (may be null):\n${JSON.stringify(prev)}\n\nEvents since then (ids in brackets):\n${transcript}\n\n${ask}`,
          "checkpoint",
        );
        const j = parseJson(text);
        if (j && typeof j.objective === "string" && typeof j.nextAction === "string") {
          const items = h.items();
          return {
            sessionId: h.id,
            epoch: old.n,
            createdAt: nowIso(),
            objective: j.objective,
            constraints: strs(j.constraints),
            decisions: strs(j.decisions),
            completed: strs(j.completed),
            failures: strs(j.failures),
            openQuestions: strs(j.openQuestions),
            nextAction: j.nextAction,
            sources: strs(j.sources).filter((id) => items.some((it) => it.id === id)),
          };
        }
      } catch (e) {
        if (h.aborted()) throw e;
        log.warn("session", `checkpoint attempt failed: ${errMsg(e)}`);
      }
    }
    return null;
  }

  /**
   * Characters of recent events a new context can carry: half the room left below the rollover point
   * once its prompt, tools, checkpoint and the lines around the events are in. Carrying more makes it
   * start nearly full and roll over again after a call or two, writing a checkpoint each time. Tokens
   * are converted with the characters per token of the last measured request (about 3.5 when there is none).
   */
  private tailRoom(old: Epoch, next: Epoch, carriedChars: number): number {
    const fixed = (e: Epoch) => systemText(e.frozen.system).length + JSON.stringify(e.frozen.tools).length;
    const measured = old.contextTokens ? (fixed(old) + JSON.stringify(old.messages).length) / old.contextTokens : 3.5;
    const perToken = Math.min(6, Math.max(2, measured));
    const { contextLimitTokens, rolloverAt } = this.host.settings;
    const room = contextLimitTokens * rolloverAt - (fixed(next) + carriedChars) / perToken;
    return Math.max(0, Math.floor((room / 2) * perToken));
  }

  /** Append user content to the epoch, opening it with any carried-over checkpoint. */
  pushUser(content: string | ContentBlockParam[]) {
    const e = this.current!;
    if (this.carry) {
      const carried: ContentBlockParam = { type: "text", text: this.carry };
      e.messages.push({ role: "user", content: typeof content === "string" ? [carried, { type: "text", text: content }] : [...content, carried] });
      this.carry = null;
    } else e.messages.push({ role: "user", content });
  }

  /** The latest usage of the epoch's context, measured or estimated. */
  measure(providerType: string, result: TurnResult): { tokens: number; estimated: boolean } {
    const e = this.current!;
    const u = result.usage;
    // Anthropic reports cached input separately; OpenAI-style prompt tokens already include it.
    const reported = providerType === "anthropic" ? u.inputTokens + u.cacheReadTokens + u.cacheWriteTokens : u.inputTokens;
    // Providers that report no usage (some local servers) fall back to a conservative estimate.
    const estimated = reported <= 0;
    e.contextTokens = estimated ? Math.ceil((systemText(e.frozen.system).length + JSON.stringify(e.messages).length) / 3.5) : reported;
    return { tokens: e.contextTokens, estimated };
  }

  /**
   * After a crash mid-turn the epoch can end with tool_use blocks that never got results. That is
   * uncertain execution: append (never rewrite) results that say so, so the model checks state
   * instead of assuming the call did not run.
   */
  repair() {
    const e = this.current;
    const last = e?.messages.at(-1);
    if (!e || !last || last.role !== "assistant" || typeof last.content === "string") return;
    const open = last.content.filter((b) => b.type === "tool_use").map((b) => (b as { id: string }).id);
    if (!open.length) return;
    e.messages.push({
      role: "user",
      content: open.map((id) => ({
        type: "tool_result" as const,
        tool_use_id: id,
        is_error: true,
        content: "Swan restarted while this call was in flight. It may or may not have run: check the workspace or external state before repeating it.",
      })),
    });
  }
}
