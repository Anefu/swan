// One sub-agent: its own model loop on the parent's sandbox and rules. It can pause on a question
// to the parent (ask_parent), take steering messages, and run in the background.
import type { AgentRun, Effort } from "@ph/shared";
import { z } from "zod";
import { errMsg, nowIso, truncateMiddle } from "../util.js";
import { ProviderError, type ContentBlockParam, type MessageParam, type ToolUse, type TurnResult } from "./providers.js";
import { zodTool, type ToolDef, type ToolOutput } from "./tools.js";

export type Outcome =
  | { kind: "report"; text: string; cutShort?: boolean }
  | { kind: "question"; question: string }
  | { kind: "error"; text: string }
  | { kind: "stopped" };

export interface SubAgentHost {
  /** One model call for this agent (usage is recorded by the host). */
  runTurn(req: { model: { provider: string; id: string; effort?: Effort }; system: string; tools: ToolDef[]; messages: MessageParam[]; signal: AbortSignal; sessionId: string }): Promise<TurnResult>;
  /** Run tool calls through the parent's permission rules, nested under the agent's call. */
  runTools(toolUses: ToolUse[], signal: AbortSignal, tools: Map<string, ToolDef>): Promise<ContentBlockParam[]>;
  release(sessionId: string): void;
  outputLimit: number;
}

export const PREAMBLE = (background: boolean) =>
  [
    "# You are a sub-agent",
    "Another agent delegated one task to you. Work on it independently with your tools; you cannot talk to the user.",
    "If you need a decision you cannot make yourself, call ask_parent with one clear question and wait for the answer instead of guessing.",
    background ? "You run in the background while the other agent continues; it may send you new instructions, which arrive with your tool results." : "",
    "Finish with a concise report of what you found or changed (paths, commands, results, open issues): that report is all the other agent will see.",
  ]
    .filter(Boolean)
    .join("\n");

interface Deferred<T> {
  promise: Promise<T>;
  resolve: (v: T) => void;
}
function deferred<T>(): Deferred<T> {
  let resolve!: (v: T) => void;
  const promise = new Promise<T>((r) => (resolve = r));
  return { promise, resolve };
}

export class SubAgent {
  readonly run: AgentRun;
  private abort = new AbortController();
  private outcome = deferred<Outcome>();
  private answer: Deferred<string | null> | null = null;
  private steering: string[] = [];
  private ended = false;
  report = "";
  /** Called whenever `run` changes. */
  onChange: () => void = () => {};

  constructor(
    init: Omit<AgentRun, "turns" | "state" | "startedAt">,
    private host: SubAgentHost,
    private system: string,
    private toolDefs: ToolDef[],
    private messages: MessageParam[],
    private sessionKey: string,
  ) {
    this.run = { ...init, turns: 0, state: "running", startedAt: nowIso() };
    // The parent's ask_parent only refuses; this agent's own one pauses it. Keep the parent's
    // definition (and so its prompt cache) when it has one.
    const ask = this.askTool();
    const i = toolDefs.findIndex((t) => t.name === "ask_parent");
    if (i >= 0) this.toolDefs = toolDefs.map((t, j) => (j === i ? { ...ask, description: t.description, inputSchema: t.inputSchema } : t));
    else this.toolDefs = [...toolDefs, ask];
  }

  get active() {
    return !this.ended;
  }

  /** The tool the sub-agent uses to ask the parent; its result is the answer. */
  askTool(): ToolDef {
    return zodTool({
      name: "ask_parent",
      description:
        "Sub-agents only: ask the agent that started you one question and wait for its answer. Use it for decisions you cannot make yourself; the answer comes back as this tool's result.",
      schema: z.object({ question: z.string().min(1).describe("One clear question") }),
      preview: (i) => i.question,
      primaryArg: (i) => i.question,
      run: async (i) => {
        this.answer = deferred<string | null>();
        this.set({ state: "asking", question: i.question });
        this.emit({ kind: "question", question: i.question });
        const onAbort = () => this.answer?.resolve(null);
        this.abort.signal.addEventListener("abort", onAbort, { once: true });
        const a = await this.answer.promise;
        this.abort.signal.removeEventListener("abort", onAbort);
        this.answer = null;
        if (a === null) return { text: "Stopped before an answer came.", isError: true };
        this.set({ state: "running", question: undefined });
        return { text: a };
      },
    });
  }

  private set(patch: Partial<AgentRun>) {
    Object.assign(this.run, patch);
    this.onChange();
  }

  /** Hand an outcome to whoever waits for it, and arm the next one. */
  private emit(o: Outcome) {
    const d = this.outcome;
    this.outcome = deferred<Outcome>();
    d.resolve(o);
  }

  /** The next thing this agent has to say: a report, a question, an error or "stopped". */
  next(): Promise<Outcome> {
    return this.outcome.promise;
  }

  start() {
    void this.loop();
  }

  /** An answer while it asks, otherwise steering it reads before its next step. */
  message(text: string): "answered" | "queued" | "ended" {
    if (this.ended) return "ended";
    if (this.answer) {
      this.answer.resolve(text);
      return "answered";
    }
    this.steering.push(text);
    return "queued";
  }

  stop() {
    if (this.ended) return;
    this.abort.abort();
  }

  private finish(o: Outcome, state: AgentRun["state"]) {
    if (this.ended) return;
    this.ended = true;
    this.set({ state, question: undefined, endedAt: nowIso() });
    this.emit(o);
    this.host.release(this.sessionKey);
  }

  private async loop() {
    const tools = new Map(this.toolDefs.map((t) => [t.name, t]));
    const signal = this.abort.signal;
    try {
      for (;;) {
        if (signal.aborted) return this.finish({ kind: "stopped" }, "stopped");
        if (this.run.turns >= this.run.maxTurns) {
          return this.finish({ kind: "report", text: `${this.report || "(no report yet)"}\n\n[Stopped after ${this.run.maxTurns} turns, the limit for this task.]`, cutShort: true }, "done");
        }
        const result = await this.host.runTurn({ model: this.run.model, system: this.system, tools: this.toolDefs, messages: this.messages, signal, sessionId: this.sessionKey });
        this.set({ turns: this.run.turns + 1 });
        if (result.stopReason === "refusal") return this.finish({ kind: "error", text: result.notice ?? "The sub-agent's model declined the task." }, "error");
        if (result.stopReason === "max_tokens" && result.toolUses.length) return this.finish({ kind: "error", text: `${this.report}\n[the sub-agent hit its output limit mid tool call]`.trim() }, "error");
        this.messages.push({ role: "assistant", content: result.content });
        const text = result.content.flatMap((b) => (b.type === "text" ? [b.text] : [])).join("\n").trim();
        if (text) this.report = text;
        if (result.stopReason === "pause_turn") continue;
        if (!result.toolUses.length) {
          // Steering that arrived after its last tool call still gets read.
          if (this.steering.length) {
            this.messages.push({ role: "user", content: this.takeSteering() });
            continue;
          }
          return this.finish({ kind: "report", text: this.report || "(the sub-agent finished without a report)" }, "done");
        }
        const results = await this.host.runTools(result.toolUses, signal, tools);
        if (this.steering.length) results.push(...this.takeSteering());
        this.messages.push({ role: "user", content: results });
      }
    } catch (e) {
      if (signal.aborted) return this.finish({ kind: "stopped" }, "stopped");
      return this.finish({ kind: "error", text: `Sub-agent failed: ${e instanceof ProviderError ? e.message : errMsg(e)}` }, "error");
    }
  }

  private takeSteering(): ContentBlockParam[] {
    const msgs = this.steering.splice(0);
    return [{ type: "text", text: "Message from the agent that started you:" }, ...msgs.map((m) => ({ type: "text" as const, text: m }))];
  }

  /** What the parent sees as a tool result or notification. */
  describe(o: Outcome, description: string): string {
    const id = this.run.id;
    switch (o.kind) {
      case "report":
        return truncateMiddle(o.text, this.host.outputLimit);
      case "question":
        return `Agent ${id} ("${description}") is paused with a question:\n${o.question}\n\nAnswer with agent_message {"id": "${id}", "message": "…"}. If you need the user, ask them in your reply and answer the agent afterwards.`;
      case "error":
        return o.text;
      case "stopped":
        return `Agent ${id} was stopped.`;
    }
  }
}

/** A forked context: the parent's messages before the call, minus reasoning when the model changes, plus the brief. */
export function forkMessages(parent: MessageParam[], toolUseId: string, sameModel: boolean, brief: string): MessageParam[] {
  const at = parent.findIndex((m) => m.role === "assistant" && Array.isArray(m.content) && m.content.some((b) => b.type === "tool_use" && (b as { id: string }).id === toolUseId));
  const copy = structuredClone(at >= 0 ? parent.slice(0, at) : parent) as MessageParam[];
  if (!sameModel) {
    for (const m of copy) {
      if (m.role !== "assistant" || typeof m.content === "string") continue;
      m.content = m.content.filter((b) => b.type !== "thinking" && b.type !== "redacted_thinking");
      if (!m.content.length) m.content = [{ type: "text", text: "(reasoning omitted)" }];
    }
  }
  const last = copy.at(-1);
  if (last?.role === "user") {
    const blocks: ContentBlockParam[] = typeof last.content === "string" ? [{ type: "text", text: last.content }] : [...last.content];
    blocks.push({ type: "text", text: brief });
    last.content = blocks;
  } else copy.push({ role: "user", content: brief });
  return copy;
}

/** A tool a sub-agent may not use (it cannot start or manage other agents). */
export function refusedTool(def: ToolDef, why: string): ToolDef {
  return { ...def, run: async (): Promise<ToolOutput> => ({ text: why, isError: true }) };
}
