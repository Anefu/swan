import { describe, expect, it } from "vitest";
import type { ContentBlockParam, MessageParam, ToolUse, TurnResult } from "./providers.js";
import { SubAgent, forkMessages, type SubAgentHost } from "./subagents.js";
import type { ToolContext, ToolDef } from "./tools.js";

type Step = { text?: string; tool?: { name: string; input: Record<string, unknown> } } | "hang";

/** A host whose model plays `steps` in order and whose tools run directly (no sandbox). */
function host(steps: Step[], seen: MessageParam[][] = []): SubAgentHost {
  let n = 0;
  return {
    runTurn: async (r) => {
      seen.push(structuredClone(r.messages));
      const step = steps[Math.min(n++, steps.length - 1)];
      if (step === "hang") return new Promise<TurnResult>((_, reject) => r.signal.addEventListener("abort", () => reject(new Error("aborted"))));
      const content: ContentBlockParam[] = [];
      const toolUses: ToolUse[] = [];
      if (step.text) content.push({ type: "text", text: step.text });
      if (step.tool) {
        const id = `tu_${n}`;
        content.push({ type: "tool_use", id, name: step.tool.name, input: step.tool.input });
        toolUses.push({ id, name: step.tool.name, input: step.tool.input });
      }
      return { content, toolUses, stopReason: toolUses.length ? "tool_use" : "end_turn", usage: { inputTokens: 1, outputTokens: 1, cacheReadTokens: 0, cacheWriteTokens: 0 } };
    },
    runTools: async (uses, signal, tools) =>
      Promise.all(
        uses.map(async (u) => {
          const out = await tools.get(u.name)!.run(u.input as Record<string, unknown>, { signal, toolUseId: u.id } as ToolContext);
          return { type: "tool_result" as const, tool_use_id: u.id, content: out.text, is_error: out.isError || undefined };
        }),
      ),
    release: () => {},
    outputLimit: 10_000,
  };
}

const echo: ToolDef = {
  name: "echo",
  source: "builtin",
  description: "",
  inputSchema: {},
  validate: (i) => ({ ok: true, value: i as Record<string, unknown> }),
  preview: () => "",
  run: async (i) => ({ text: `echo ${JSON.stringify(i)}` }),
};

const make = (h: SubAgentHost, opts: { maxTurns?: number; background?: boolean } = {}) =>
  new SubAgent(
    { id: "ag_1", name: "auto", model: { provider: "p", id: "m" }, context: "brief", background: !!opts.background, maxTurns: opts.maxTurns ?? 10, brief: "do it" },
    h,
    "system",
    [echo, { ...echo, name: "ask_parent" }],
    [{ role: "user", content: "do it" }],
    "s:sub:ag_1",
  );

describe("SubAgent", () => {
  it("runs tools, then returns its last text as the report", async () => {
    const a = make(host([{ tool: { name: "echo", input: { x: 1 } } }, { text: "Found it." }]));
    a.start();
    expect(await a.next()).toEqual({ kind: "report", text: "Found it." });
    expect(a.run).toMatchObject({ state: "done", turns: 2 });
    expect(a.active).toBe(false);
  });

  it("stops at the turn limit the parent set and says so", async () => {
    const a = make(host([{ text: "working", tool: { name: "echo", input: {} } }]), { maxTurns: 3 });
    a.start();
    const o = await a.next();
    expect(o).toMatchObject({ kind: "report", cutShort: true });
    expect(o.kind === "report" && o.text).toMatch(/working\n\n\[Stopped after 3 turns/);
    expect(a.run.turns).toBe(3);
  });

  it("pauses on ask_parent and resumes with the answer as the tool result", async () => {
    const seen: MessageParam[][] = [];
    const a = make(host([{ tool: { name: "ask_parent", input: { question: "Hidden files too?" } } }, { text: "Counted 12, hidden included." }], seen));
    a.start();
    expect(await a.next()).toEqual({ kind: "question", question: "Hidden files too?" });
    expect(a.run).toMatchObject({ state: "asking", question: "Hidden files too?" });
    expect(a.message("Yes")).toBe("answered");
    expect(await a.next()).toEqual({ kind: "report", text: "Counted 12, hidden included." });
    const toolResult = (seen[1].at(-1)!.content as ContentBlockParam[])[0];
    expect(toolResult).toMatchObject({ type: "tool_result", content: "Yes" });
    expect(a.run.question).toBeUndefined();
  });

  it("reads steering messages before its next step", async () => {
    const seen: MessageParam[][] = [];
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const h = host([{ tool: { name: "echo", input: {} } }, { text: "done" }], seen);
    const runTools = h.runTools;
    h.runTools = async (...args) => {
      await gate;
      return runTools(...args);
    };
    const a = make(h, { background: true });
    a.start();
    await new Promise((r) => setTimeout(r, 10));
    expect(a.message("Also check dev-alice.")).toBe("queued");
    release();
    expect(await a.next()).toMatchObject({ kind: "report" });
    expect(JSON.stringify(seen[1].at(-1))).toContain("Also check dev-alice.");
  });

  it("can be stopped mid-turn and while waiting for an answer", async () => {
    const busy = make(host(["hang"]));
    busy.start();
    const o = busy.next();
    busy.stop();
    expect(await o).toEqual({ kind: "stopped" });
    expect(busy.run.state).toBe("stopped");

    const asking = make(host([{ tool: { name: "ask_parent", input: { question: "?" } } }, { text: "never" }]));
    asking.start();
    await asking.next();
    const after = asking.next();
    asking.stop();
    expect(await after).toEqual({ kind: "stopped" });
    expect(asking.message("late")).toBe("ended");
  });
});

describe("forkMessages", () => {
  const parent: MessageParam[] = [
    { role: "user", content: "hello" },
    { role: "assistant", content: [{ type: "thinking", thinking: "hmm", signature: "sig" }, { type: "text", text: "Hi" }, { type: "tool_use", id: "t1", name: "bash", input: {} }] },
    { role: "user", content: [{ type: "tool_result", tool_use_id: "t1", content: "ok" }] },
    { role: "assistant", content: [{ type: "tool_use", id: "t2", name: "agent", input: {} }] },
  ];

  it("takes the conversation before the agent call and adds the brief to the last user turn", () => {
    const f = forkMessages(parent, "t2", true, "BRIEF");
    expect(f).toHaveLength(3);
    expect(f[2].content).toEqual([{ type: "tool_result", tool_use_id: "t1", content: "ok" }, { type: "text", text: "BRIEF" }]);
    expect((f[1].content as ContentBlockParam[])[0].type).toBe("thinking");
    expect((parent[2].content as ContentBlockParam[]).length).toBe(1); // the parent is untouched
  });

  it("drops reasoning blocks when the sub-agent runs on another model", () => {
    const f = forkMessages(parent, "t2", false, "BRIEF");
    expect((f[1].content as ContentBlockParam[]).map((b) => b.type)).toEqual(["text", "tool_use"]);
  });
});
