import { EventEmitter } from "node:events";
import { describe, expect, it, vi } from "vitest";
import type { ChatItem, Checkpoint } from "@ph/shared";
import { MemoryStore } from "../memory.js";
import { nowIso } from "../util.js";
import { Session, SessionManager, type SessionDeps } from "./session.js";

const cp = (objective: string, extra: Partial<Checkpoint> = {}): Checkpoint => ({
  epoch: 1,
  createdAt: nowIso(),
  objective,
  constraints: [],
  decisions: [],
  completed: [],
  failures: [],
  openQuestions: [],
  nextAction: "next",
  sources: [],
  ...extra,
});

describe("checkpoints per conversation", () => {
  it("finds a conversation's latest checkpoint, never another's", async () => {
    const m = new MemoryStore();
    await m.addCheckpoint("p1", cp("a1", { sessionId: "sa" }));
    await m.addCheckpoint("p1", cp("a2", { sessionId: "sa" }));
    await m.addCheckpoint("p1", cp("b1", { sessionId: "sb" }));
    expect((await m.latestCheckpoint("p1", "sa"))?.objective).toBe("a2");
    expect((await m.latestCheckpoint("p1", "sb"))?.objective).toBe("b1");
    expect(await m.latestCheckpoint("p1", "sc")).toBeNull();
    expect((await m.latestCheckpoint("p1"))?.objective).toBe("b1"); // the persona's latest, without a conversation
  });

  it("gives a checkpoint from before conversations to the one that holds its sources", async () => {
    const m = new MemoryStore();
    await m.addCheckpoint("p2", cp("old", { sources: ["it_old1"] }));
    await m.addCheckpoint("p2", cp("unsourced"));
    const inA = (id: string) => id === "it_old1";
    expect((await m.latestCheckpoint("p2", "sa", inA))?.objective).toBe("old");
    expect(await m.latestCheckpoint("p2", "sb", () => false)).toBeNull();
    expect(await m.latestCheckpoint("p2", "sb")).toBeNull();
    await m.addCheckpoint("p2", cp("new", { sessionId: "sa" }));
    expect((await m.latestCheckpoint("p2", "sa", inA))?.objective).toBe("new");
  });
});

describe("a rollover", () => {
  function setup() {
    const persona = {
      id: "p3",
      folders: [],
      errors: [],
      config: {
        name: "P",
        instructions: "",
        skills: [],
        model: undefined,
        connections: {},
        network: { allow: [] },
        memory: { autoBrief: false, briefTokens: 0 },
        permissions: { default: "ask", allow: [], ask: [], deny: [] },
      },
    };
    const prompts: string[] = [];
    let n = 0;
    const deps = {
      personas: { get: (id: string) => (id === "p3" ? persona : undefined), namedRefs: () => [] },
      skills: { get: () => undefined },
      settings: { defaultModel: { provider: "fake", id: "m" }, providers: {}, rolloverStrategy: "full", contextLimitTokens: 200_000 },
      memory: new MemoryStore(),
      usage: { record: vi.fn(), setContext: vi.fn() },
      proxy: { register: vi.fn(), unregister: vi.fn() },
      connections: Object.assign(new EventEmitter(), { usable: () => undefined }),
      broadcast: vi.fn(),
      onApprovalsChanged: vi.fn(),
      providers: {
        releaseSession: vi.fn(),
        runTurn: vi.fn(async (_provider: string, r: { messages: { content: string }[] }) => {
          prompts.push(r.messages[0].content);
          const text = JSON.stringify({ objective: `goal ${++n}`, nextAction: "go on", sources: [] });
          return { content: [{ type: "text", text }], toolUses: [], stopReason: "end_turn", usage: { inputTokens: 1, outputTokens: 1, cacheReadTokens: 0, cacheWriteTokens: 0 } };
        }),
      },
      runtime: { stopSession: vi.fn(async () => {}) },
      diffs: { removeSession: vi.fn(async () => {}) },
      attachments: { removeSession: vi.fn(async () => {}) },
    } as unknown as SessionDeps;
    return { m: new SessionManager(deps), deps, prompts };
  }

  type Internals = { openEpoch(): Promise<void>; rollover(reason: string): Promise<void>; addItem(it: ChatItem): void };
  const roll = async (s: Session, text: string) => {
    const x = s as unknown as Internals;
    await x.openEpoch();
    x.addItem({ kind: "user", id: `it_${text}`, ts: nowIso(), text });
    await x.rollover("test");
  };

  it("starts from its own conversation's checkpoint, not another conversation's", async () => {
    const { m, deps, prompts } = setup();
    const a = m.create("p3", "A");
    const b = m.create("p3", "B");
    await roll(a, "task-a");
    await roll(b, "task-b");
    expect(prompts[1]).toContain("Previous checkpoint (may be null):\nnull");
    expect(prompts[1]).not.toContain("goal 1");
    expect(await deps.memory.latestCheckpoint("p3", b.id)).toMatchObject({ sessionId: b.id, objective: "goal 2" });
    await roll(a, "more-a");
    expect(prompts[2]).toContain('"objective":"goal 1"');
    for (const s of m.list("p3")) await m.remove(s.id);
  });
});
