import { EventEmitter } from "node:events";
import { promises as fs } from "node:fs";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import type { ChatItem, Checkpoint } from "@ph/shared";
import { MemoryStore } from "../memory.js";
import { paths } from "../settings.js";
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
const say = (s: Session, text: string, ts = nowIso()) => (s as unknown as Internals).addItem({ kind: "user", id: `it_${text}`, ts, text });

describe("a rollover", () => {
  const roll = async (s: Session, text: string) => {
    await (s as unknown as Internals).openEpoch();
    say(s, text);
    await (s as unknown as Internals).rollover("test");
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

describe("/dream", () => {
  it("reads its own conversation's events since its own last run", async () => {
    const { m, prompts } = setup();
    const a = m.create("p3", "A");
    const b = m.create("p3", "B");
    say(b, "task-b", "2026-01-01T00:00:00.000Z"); // written before /dream runs in A
    say(a, "task-a");
    await a.dream();
    expect(prompts[0]).toContain("task-a");
    expect(prompts[0]).not.toContain("task-b");
    await b.dream();
    expect(prompts[1]).toContain("task-b");
    expect(prompts[1]).not.toContain("task-a");
    say(a, "more-a");
    await a.dream();
    expect(prompts[2]).toContain("more-a");
    expect(prompts[2]).not.toContain("task-a");
    for (const s of m.list("p3")) await m.remove(s.id);
  });

  it("keeps its place across a restart", async () => {
    const { m, deps, prompts } = setup();
    await fs.mkdir(paths.sessions, { recursive: true }); // made at startup
    const a = m.create("p3", "A");
    say(a, "before-restart");
    await a.dream();
    const reopened = await Session.load(deps, path.join(paths.sessions, `${a.id}.json`));
    say(reopened, "after-restart");
    await reopened.dream();
    expect(prompts[1]).toContain("after-restart");
    expect(prompts[1]).not.toContain("before-restart");
    await m.remove(a.id);
  });

  it("starts a conversation from before the per-conversation bookmark after its own last /dream", async () => {
    const { m, prompts } = setup();
    const a = m.create("p3", "A");
    say(a, "old-a");
    (a as unknown as Internals).addItem({ kind: "receipt", id: "it_dreamt", ts: nowIso(), action: "dream", title: "/dream", detail: "Consolidated memory", status: "done" });
    say(a, "new-a");
    await a.dream();
    expect(prompts[0]).toContain("new-a");
    expect(prompts[0]).not.toContain("old-a");
    await m.remove(a.id);
  });
});
