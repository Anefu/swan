// The sub-agents of one conversation: the tools that start and manage them, and how their
// reports, questions and failures reach the conversation.
import type { ChatItem, Effort } from "@ph/shared";
import { z } from "zod";
import type { ModelCatalog } from "../catalog.js";
import type { PersonaConfig } from "../personas.js";
import type { Settings } from "../settings.js";
import type { UsagePurpose } from "../usage.js";
import { randomId } from "../util.js";
import { ASK_USER } from "./ask-user.js";
import type { Epoch, FrozenTool } from "./context.js";
import { CONVERSATIONS } from "./conversation-tools.js";
import type { ContentBlockParam, ProviderRegistry, ToolUse, TurnResult } from "./providers.js";
import { PREAMBLE, SubAgent, forkMessages, refusedTool, type Outcome } from "./subagents.js";
import { zodTool, type ToolContext, type ToolDef, type ToolOutput } from "./tools.js";

const DEFAULT_SUBAGENT_TURNS = 60;
// Tools that manage sub-agents: allowed by default for the main agent, refused inside a sub-agent.
const AGENT_TOOLS = new Set(["agent", "agent_message", "agent_status", "agent_stop"]);
const SUB_AGENT = { rule: "sub-agent" }; // delegating is allowed by default: each call a sub-agent makes is checked on its own

/** Who a turn or a sub-agent works for: an unattended run keeps its rules after its turn ends. */
export interface Origin {
  unattended: boolean; // started by a schedule, a watcher or another conversation
  delivered: boolean; // started by another conversation, so it can't send further
}

interface AgentEntry {
  sub: SubAgent;
  toolUseId: string; // the `agent` call that started it
  description: string;
  origin: Origin;
}

/** A background agent's news, for the conversation's queue. */
export interface AgentReport {
  text: string;
  unattended: boolean;
  delivered: boolean;
}

export interface AgentsHost {
  id: string;
  settings: Settings;
  providers: ProviderRegistry;
  catalog: ModelCatalog;
  config(): PersonaConfig | undefined;
  epoch(): Epoch;
  /** The tool behind a name in the context: the live one, or one that says it isn't available. */
  toolFor(f: FrozenTool): ToolDef;
  /** The rules of the turn running now. */
  origin(): Origin;
  runTools(uses: ToolUse[], signal: AbortSignal, parentId: string, tools: Map<string, ToolDef>, origin: Origin): Promise<ContentBlockParam[]>;
  recordUsage(result: TurnResult, purpose: UsagePurpose, provider: string, model: string): void;
  items(): ChatItem[];
  updateItem(it: ChatItem): void;
  receipt(action: "agent", title: string, detail: string, status: "done" | "error"): void;
  report(r: AgentReport): void;
  persistSoon(): void;
  maxTokens(): number;
}

const fmtElapsed = (ms: number) => (ms < 60_000 ? `${Math.max(1, Math.round(ms / 1000))}s` : `${Math.floor(ms / 60_000)}m ${String(Math.round((ms % 60_000) / 1000)).padStart(2, "0")}s`);

export class SessionAgents {
  private entries = new Map<string, AgentEntry>();

  constructor(private host: AgentsHost) {}

  get active() {
    return [...this.entries.values()].some((a) => a.sub.active);
  }

  /** An unattended run's agent is at work, so the sandbox's requests get the unattended rules. */
  get unattendedActive() {
    return [...this.entries.values()].some((a) => a.sub.active && a.origin.unattended);
  }

  /** agent, agent_message, agent_status, agent_stop and ask_parent (which only a sub-agent can use). */
  async tools(): Promise<ToolDef[]> {
    const sub = this.host.config()?.subagents;
    const named = (sub?.agents ?? []).map((a) => `${a.name} (${a.model === "auto" ? "auto: you choose model and effort" : a.model})`);
    const models = (await this.host.catalog.list().catch(() => []))
      .filter((m) => m.ready)
      .slice(0, 24)
      .map((m) => `${m.provider}/${m.id}`);
    const efforts = ["low", "medium", "high", "xhigh", "max"] as const;
    return [
      zodTool({
        name: "agent",
        description: [
          "Start a sub-agent for one self-contained task and get back its report. It has your tools, sandbox, network and permission rules. Call it several times in one response to run independent tasks in parallel.",
          named.length ? `This persona's sub-agents: ${named.join("; ")}.` : "",
          `With agent "auto" (the default) you may pick the model ("provider/model") and effort; ready models: ${models.join(", ") || "your own"}.`,
          'context "brief" (default) gives it only your prompt, so the prompt must contain everything it needs; "fork" gives it this conversation as well.',
          "background: true returns at once; you get a message when it finishes or asks something, and can keep working. A sub-agent may pause with a question: answer it with agent_message.",
        ]
          .filter(Boolean)
          .join(" "),
        schema: z.object({
          description: z.string().min(1).max(80).describe("3-6 word label shown to the user"),
          prompt: z.string().min(1).describe("The task: goal, relevant paths and facts, and what to report back"),
          agent: z.string().optional().describe('A sub-agent of this persona, or "auto" (default)'),
          model: z.string().optional().describe('Auto only: "provider/model"; default: your own model'),
          effort: z.enum(efforts).optional().describe("Auto only; default: your own effort"),
          context: z.enum(["brief", "fork"]).optional().describe('"brief" (default) or "fork"'),
          max_turns: z.number().int().min(1).max(1000).optional().describe(`Most model turns for this task (default ${DEFAULT_SUBAGENT_TURNS})`),
          background: z.boolean().optional().describe("Run in the background and return at once"),
        }),
        preview: (i) => i.description,
        primaryArg: (i) => i.description,
        defaultAllow: SUB_AGENT,
        run: (i, ctx) => this.start(i, ctx),
      }),
      zodTool({
        name: "agent_message",
        description:
          "Answer a sub-agent's question, or send a running background agent new instructions. For an agent you did not start in the background, its next report or question comes back as this tool's result.",
        schema: z.object({ id: z.string().describe("Agent id, e.g. ag_3f9c1a"), message: z.string().min(1) }),
        preview: (i) => i.message,
        primaryArg: (i) => i.id,
        defaultAllow: SUB_AGENT,
        run: (i, ctx) => this.message(i.id, i.message, ctx.signal),
      }),
      zodTool({
        name: "agent_status",
        description: "List the sub-agents of this conversation: state, model, turns used and any open question.",
        schema: z.object({}),
        preview: () => "agents",
        defaultAllow: SUB_AGENT,
        run: async () => ({ text: this.status() }),
      }),
      zodTool({
        name: "agent_stop",
        description: "Stop a sub-agent.",
        schema: z.object({ id: z.string() }),
        preview: (i) => i.id,
        primaryArg: (i) => i.id,
        defaultAllow: SUB_AGENT,
        run: async (i) => {
          const a = this.entries.get(i.id);
          if (!a) return { text: `No agent ${i.id} in this conversation.`, isError: true };
          if (!a.sub.active) return { text: `Agent ${i.id} already ended (${a.sub.run.state}).` };
          this.stop(i.id);
          return { text: `Stopped agent ${i.id}.` };
        },
      }),
      zodTool({
        name: "ask_parent",
        description: "Sub-agents only: ask the agent that started you one question and wait for its answer.",
        schema: z.object({ question: z.string().min(1) }),
        preview: (i) => i.question,
        defaultAllow: SUB_AGENT,
        run: async () => ({ text: "You are the main agent and have no parent: ask the user in your reply instead.", isError: true }),
      }),
    ];
  }

  private async start(
    i: { description: string; prompt: string; agent?: string; model?: string; effort?: Effort; context?: "brief" | "fork"; max_turns?: number; background?: boolean },
    ctx: ToolContext,
  ): Promise<ToolOutput> {
    const h = this.host;
    const cfg = h.config();
    const limits = cfg?.subagents ?? { agents: [], maxBackground: 4, maxTurns: 200 };
    const e = h.epoch();
    const fail = (text: string): ToolOutput => ({ text, isError: true });

    const name = i.agent ?? "auto";
    const named = name === "auto" ? undefined : limits.agents.find((a) => a.name === name);
    if (name !== "auto" && !named) return fail(`No sub-agent named "${name}". This persona has ${limits.agents.map((a) => a.name).join(", ") || "none"}; use "auto" to choose a model yourself.`);
    const fixed = named && named.model !== "auto" ? named.model : undefined;
    if (fixed && (i.model || i.effort)) return fail(`"${name}" always runs on ${fixed}. Leave model and effort out, or use an auto sub-agent.`);
    const spec = fixed ?? i.model;
    let model = { provider: e.model.provider, id: e.model.id };
    if (spec) {
      const slash = spec.indexOf("/");
      if (slash <= 0 || slash === spec.length - 1) return fail(`model must be "provider/model", e.g. "${e.model.provider}/${e.model.id}".`);
      model = { provider: spec.slice(0, slash), id: spec.slice(slash + 1) };
    }
    if (!h.settings.providers[model.provider]) return fail(`Provider "${model.provider}" is not defined in config.yaml.`);
    if (!h.providers.status().find((p) => p.name === model.provider)?.ready) return fail(`Provider "${model.provider}" has no key, so it cannot run a sub-agent.`);
    let effort = fixed ? cfg?.model?.effort : (i.effort ?? cfg?.model?.effort);
    const option = (await h.catalog.list().catch(() => [])).find((m) => m.provider === model.provider && m.id === model.id);
    if (option && effort && !option.efforts.includes(effort)) effort = undefined; // the model takes no such setting
    const maxTurns = Math.min(i.max_turns ?? DEFAULT_SUBAGENT_TURNS, limits.maxTurns);
    if (i.background) {
      const running = [...this.entries.values()].filter((a) => a.sub.active && a.sub.run.background).length;
      if (running >= limits.maxBackground) return fail(`${running} background agents are already running (this persona's limit is ${limits.maxBackground}). Wait for one, stop one, or run this one in the foreground.`);
    }

    const id = randomId("ag_", 3);
    // The sub-agent keeps the rules of the turn that started it, also after that turn ends.
    const origin = h.origin();
    // A context opened before agent_message existed cannot answer, so its sub-agents get no ask_parent.
    const canAsk = e.frozen.tools.some((t) => t.name === "agent_message");
    const brief = `${PREAMBLE(!!i.background, canAsk)}\n\n# Your task\n${i.prompt}`;
    const sameModel = model.provider === e.model.provider && model.id === e.model.id;
    const messages = i.context === "fork" ? forkMessages(e.messages, ctx.toolUseId, sameModel, brief) : [{ role: "user" as const, content: brief }];
    // The parent's exact tool list and system prompt, so a same-model sub-agent shares its prompt cache.
    const defs: ToolDef[] = e.frozen.tools.map((f) => {
      const def = h.toolFor(f);
      if (f.name === ASK_USER) return refusedTool(def, "Only the main agent can ask the user: use ask_parent.");
      if (f.name === CONVERSATIONS) return refusedTool(def, "Only the main agent can manage conversations: report back with ask_parent or your result.");
      return AGENT_TOOLS.has(f.name) ? refusedTool(def, "Only the main agent can start or manage sub-agents.") : def;
    });
    const maxTokens = h.maxTokens();
    const noop = { onBlockStart: () => {}, onDelta: () => {}, onBlockStop: () => {} };
    const sub = new SubAgent(
      { id, name, model: { ...model, ...(effort ? { effort } : {}) }, auto: !fixed, context: i.context ?? "brief", background: !!i.background, maxTurns, brief: i.prompt },
      {
        runTurn: async (r) => {
          const res = await h.providers.runTurn(r.model.provider, { model: r.model.id, system: r.system, tools: r.tools, messages: r.messages, maxTokens, effort: r.model.effort, signal: r.signal, sessionId: r.sessionId }, noop);
          h.recordUsage(res, "subagent", r.model.provider, r.model.id);
          h.persistSoon();
          return res;
        },
        runTools: (uses, signal, tools) => h.runTools(uses, signal, ctx.toolUseId, tools, origin),
        release: (key) => h.providers.releaseSession(key),
        outputLimit: h.settings.toolOutputLimit,
      },
      e.frozen.system,
      defs,
      messages,
      `${h.id}:sub:${id}`,
      canAsk,
    );
    const entry: AgentEntry = { sub, toolUseId: ctx.toolUseId, description: i.description, origin };
    this.entries.set(id, entry);
    sub.onChange = () => this.patchItem(entry, { agent: { ...sub.run } });
    sub.start();

    if (i.background) {
      void this.watchBackground(entry);
      return {
        text: `Started background agent ${id} ("${i.description}") on ${model.id}. You'll get a message when it finishes or asks something; carry on meanwhile. agent_status lists agents, agent_message sends one instructions, agent_stop stops one.`,
        // The call returned at once; the line's duration is the agent's, filled in when it ends.
        itemPatch: { status: "running", agent: { ...sub.run }, durationMs: undefined },
      };
    }
    const o = await sub.next();
    this.onOutcome(entry, o);
    return this.outcomeOutput(entry, o);
  }

  /** The tool result for an outcome; the `agent` item itself stays running while its agent waits for an answer. */
  private outcomeOutput(entry: AgentEntry, o: Outcome): ToolOutput {
    const text = entry.sub.describe(o, entry.description);
    const agent = { ...entry.sub.run };
    if (o.kind === "question") return { text, itemPatch: { status: "running", agent, durationMs: undefined } };
    if (o.kind === "report") return { text, itemPatch: { agent } };
    return { text, isError: true, itemPatch: { agent, status: o.kind === "stopped" ? "interrupted" : "error" } };
  }

  private patchItem(entry: AgentEntry, patch: Partial<Extract<ChatItem, { kind: "tool_call" }>>) {
    const it = this.host.items().find((x) => x.kind === "tool_call" && x.id === entry.toolUseId);
    if (it?.kind !== "tool_call") return;
    Object.assign(it, patch);
    this.host.updateItem(it);
  }

  /** Keep the `agent` line in step with how its agent ended (or that it waits for an answer). */
  private onOutcome(entry: AgentEntry, o: Outcome) {
    const agent = { ...entry.sub.run };
    const durationMs = Date.now() - Date.parse(agent.startedAt);
    if (o.kind === "question") this.patchItem(entry, { status: "running", agent });
    else if (o.kind === "report") this.patchItem(entry, { status: "done", isError: false, output: o.text, agent, durationMs });
    else this.patchItem(entry, { status: o.kind === "stopped" ? "interrupted" : "error", isError: true, ...(o.kind === "error" ? { output: o.text } : {}), agent, durationMs });
  }

  /** A background agent's reports, questions and failures reach the conversation as messages. */
  private async watchBackground(entry: AgentEntry) {
    for (;;) {
      const o = await entry.sub.next();
      this.onOutcome(entry, o);
      if (o.kind === "stopped") return;
      const run = entry.sub.run;
      const uses = this.host.items().filter((x) => x.kind === "tool_call" && x.parentId === entry.toolUseId && x.name !== "ask_parent").length;
      const title = o.kind === "report" ? "Background agent finished" : o.kind === "question" ? "Background agent asked a question" : "Background agent failed";
      const detail = `${entry.description} · ${fmtElapsed(Date.now() - Date.parse(run.startedAt))} · ${uses} tool ${uses === 1 ? "use" : "uses"}`;
      this.host.receipt("agent", title, detail, o.kind === "error" ? "error" : "done");
      const state = o.kind === "report" ? "finished" : o.kind === "question" ? "asked a question" : "failed";
      this.host.report({ text: `[Background agent ${run.id} ("${entry.description}") ${state}]\n${entry.sub.describe(o, entry.description)}`, ...entry.origin });
      if (o.kind !== "question") return;
    }
  }

  private async message(id: string, message: string, signal: AbortSignal): Promise<ToolOutput> {
    const a = this.entries.get(id);
    if (!a) return { text: `No agent ${id} in this conversation. agent_status lists them.`, isError: true };
    const asking = a.sub.run.state === "asking";
    const next = a.sub.next();
    const r = a.sub.message(message);
    if (r === "ended") return { text: `Agent ${id} already ended (${a.sub.run.state}).`, isError: true };
    if (a.sub.run.background) return { text: r === "answered" ? "Answer sent; the agent continues in the background." : "Sent; it reads it before its next step." };
    if (!asking) return { text: "Sent; it reads it before its next step." };
    // A foreground agent was waiting on this answer: its next report or question is this call's result.
    const aborted = new Promise<null>((res) => signal.addEventListener("abort", () => res(null), { once: true }));
    const o = await Promise.race([next, aborted]);
    if (!o) return { text: "Interrupted while waiting for the agent.", isError: true };
    this.onOutcome(a, o);
    return { text: a.sub.describe(o, a.description), isError: o.kind === "error" || o.kind === "stopped" };
  }

  private status(): string {
    if (!this.entries.size) return "No sub-agents in this conversation yet.";
    return [...this.entries.values()]
      .map(({ sub, description }) => {
        const r = sub.run;
        return `${r.id} "${description}": ${r.state}${r.question ? ` (asks: ${r.question})` : ""} · ${r.name} · ${r.model.provider}/${r.model.id}${r.model.effort ? ` ${r.model.effort}` : ""} · ${r.background ? "background" : "foreground"} · ${r.turns}/${r.maxTurns} turns`;
      })
      .join("\n");
  }

  /** Stop one sub-agent, or all of them (Stop, interrupt, the UI's Stop all). */
  stop(id?: string) {
    for (const [key, a] of this.entries) {
      if (id && key !== id) continue;
      if (!a.sub.active) continue;
      // Nobody may be waiting on a paused foreground agent: settle its line here.
      void a.sub.next().then((o) => this.onOutcome(a, o));
      a.sub.stop();
    }
  }
}
