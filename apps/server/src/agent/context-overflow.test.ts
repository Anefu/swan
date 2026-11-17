import { EventEmitter } from "node:events";
import { describe, expect, it, vi } from "vitest";
import type { ChatItem } from "@ph/shared";
import { MemoryStore } from "../memory.js";
import { nowIso } from "../util.js";
import { isContextOverflow, messageChars } from "./context-size.js";
import { ProviderError, systemText, type ContentBlockParam, type MessageParam, type SystemPrompt } from "./providers.js";
import { Session, SessionManager, type SessionDeps } from "./session.js";

let personas = 0;
const OVERFLOW = "Anthropic rejected the request: 400 prompt is too long: 205000 tokens > 200000 maximum";

/** A session over a fake model. `answer` decides each conversation request; checkpoint requests always succeed. */
function setup(answer: (messages: MessageParam[]) => { error?: string; tokens?: number } = () => ({})) {
  const pid = `po${++personas}`;
  const persona = {
    id: pid,
    folders: [],
    errors: [],
    config: {
      name: "P",
      instructions: "",
      skills: [],
      model: undefined,
      connections: {},
      network: { allow: [] },
      memory: { autoBrief: false, briefTokens: 0, autoDream: false },
      permissions: { default: "ask", allow: [], ask: [], deny: [] },
    },
  };
  const requests: MessageParam[][] = [];
  const notices: string[] = [];
  const deps = {
    personas: { get: (id: string) => (id === pid ? persona : undefined), namedRefs: () => [] },
    skills: { get: () => undefined },
    settings: { defaultModel: { provider: "fake", id: "m" }, providers: {}, rolloverStrategy: "full", contextLimitTokens: 200_000, rolloverAt: 0.75 },
    memory: new MemoryStore(),
    usage: { record: vi.fn(), setContext: vi.fn() },
    proxy: { register: vi.fn(), unregister: vi.fn() },
    connections: Object.assign(new EventEmitter(), { usable: () => undefined }),
    broadcast: vi.fn((ev: { type: string; item?: ChatItem }) => {
      if (ev.item?.kind === "notice") notices.push(ev.item.text);
    }),
    onApprovalsChanged: vi.fn(),
    providers: {
      releaseSession: vi.fn(),
      runTurn: vi.fn(async (_provider: string, r: { system: SystemPrompt; messages: MessageParam[] }) => {
        const usage = (inputTokens: number) => ({ inputTokens, outputTokens: 1, cacheReadTokens: 0, cacheWriteTokens: 0 });
        if (systemText(r.system).includes("You write checkpoints")) {
          return { content: [{ type: "text", text: JSON.stringify({ objective: "the goal", nextAction: "go on", sources: [] }) }], toolUses: [], stopReason: "end_turn", usage: usage(1) };
        }
        requests.push(structuredClone(r.messages));
        const a = answer(r.messages);
        if (a.error) throw new ProviderError(a.error);
        return { content: [{ type: "text", text: "ok" }], toolUses: [], stopReason: "end_turn", usage: usage(a.tokens ?? 1_000) };
      }),
    },
    runtime: { stopSession: vi.fn(async () => {}) },
    diffs: { removeSession: vi.fn(async () => {}) },
    attachments: { removeSession: vi.fn(async () => {}) },
  } as unknown as SessionDeps;
  const m = new SessionManager(deps);
  const s = m.create(pid, "A");
  return {
    s,
    x: s as unknown as Internals,
    deps,
    requests,
    notices,
    done: async () => {
      for (const c of m.list(pid)) await m.remove(c.id);
    },
  };
}

type Internals = {
  openEpoch(): Promise<void>;
  pushUser(c: string | ContentBlockParam[]): void;
  agentTurns(message: string | ContentBlockParam[]): Promise<void>;
  rolloverReason(incoming?: number): string | null;
  addItem(it: ChatItem): void;
  epoch: { n: number; messages: MessageParam[]; contextTokens?: number; measuredAt?: number };
};

/** Sends a message the way the loop does, without a sandbox. */
async function send(x: Internals, text: string) {
  x.addItem({ kind: "user", id: `it_${Math.random().toString(36).slice(2)}`, ts: nowIso(), text });
  x.pushUser(text);
  await x.agentTurns(text);
}

const textOf = (m: MessageParam) => (typeof m.content === "string" ? m.content : m.content.map((b) => (b.type === "text" ? b.text : "")).join(""));

describe("the size of the next request", () => {
  it("counts what was added since the last measured request, so one large tool output rolls over", async () => {
    const { x, done } = setup();
    await x.openEpoch();
    await send(x, "read the log");
    expect(x.epoch.measuredAt).toBe(1);
    expect(x.rolloverReason()).toBeNull();
    // A reply and a tool result of ~700k characters: far past the window, though the last request was small.
    x.epoch.messages.push({ role: "assistant", content: [{ type: "tool_use", id: "t1", name: "read", input: {} }] });
    x.epoch.messages.push({ role: "user", content: [{ type: "tool_result", tool_use_id: "t1", content: "x".repeat(700_000) }] });
    expect(x.rolloverReason()).toMatch(/next request would be/);
    await done();
  });

  it("counts a long incoming message before it is added", async () => {
    const { x, done } = setup();
    await x.openEpoch();
    await send(x, "hello");
    expect(x.rolloverReason(800_000)).toMatch(/next request would be/);
    expect(x.rolloverReason(1_000)).toBeNull();
    await done();
  });

  it("doesn't roll over a context that has no reply yet: a new one would carry the same", async () => {
    const { x, done } = setup();
    await x.openEpoch();
    x.pushUser("x".repeat(800_000));
    expect(x.rolloverReason()).toBeNull();
    await done();
  });

  it("counts an image as about 1,600 tokens, not its base64 length", () => {
    const image: MessageParam = { role: "user", content: [{ type: "image", source: { type: "base64", media_type: "image/png", data: "A".repeat(4_000_000) } }] };
    expect(messageChars([image]) / 3.5).toBeCloseTo(1_600, -1);
  });
});

describe("a request the provider refuses as too long", () => {
  it("starts a new context and sends the user's message again", async () => {
    let calls = 0;
    const { x, requests, notices, done } = setup(() => (++calls === 2 ? { error: OVERFLOW } : {}));
    await x.openEpoch();
    await send(x, "first");
    await send(x, "the message that overflowed");
    expect(x.epoch.n).toBe(2);
    const retry = requests[2];
    expect(textOf(retry[0])).toContain("## Checkpoint");
    expect(textOf(retry[0])).toContain("the message that overflowed");
    expect(x.epoch.messages.at(-1)).toMatchObject({ role: "assistant" });
    expect(notices.some((n) => n.includes("started a new context"))).toBe(true);
    await done();
  });

  it("un-sticks a conversation whose earlier requests kept failing", async () => {
    let calls = 0;
    const { x, requests, done } = setup(() => (++calls >= 2 && calls <= 3 ? { error: OVERFLOW } : {}));
    await x.openEpoch();
    await send(x, "first");
    await expect(send(x, "stuck")).rejects.toThrow(/fresh context/); // the retry fails too
    await send(x, "try again");
    expect(textOf(requests.at(-1)!.at(-1)!)).toContain("try again");
    await done();
  });

  it("says the message itself is too large when a fresh context can't hold it", async () => {
    const { x, done } = setup(() => ({ error: OVERFLOW }));
    await x.openEpoch();
    await expect(send(x, "huge")).rejects.toThrow(/latest message or tool output alone is too large/);
    expect(x.epoch.n).toBe(1);
    await done();
  });

  it("doesn't treat other errors as overflow", () => {
    expect(isContextOverflow(new Error(OVERFLOW))).toBe(true);
    expect(isContextOverflow(new Error("400 This model's maximum context length is 128000 tokens. However, your messages resulted in 130000 tokens."))).toBe(true);
    expect(isContextOverflow(new Error("prompt token count of 210000 exceeds the limit of 200000"))).toBe(true);
    expect(isContextOverflow(new Error("Rate limited after retries: 429"))).toBe(false);
    expect(isContextOverflow(new Error("Anthropic rejected the request: invalid tool_use id"))).toBe(false);
  });
});
