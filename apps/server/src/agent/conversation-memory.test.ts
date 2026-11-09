import { EventEmitter } from "node:events";
import { promises as fs } from "node:fs";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import type { ChatItem, Checkpoint } from "@ph/shared";
import { MemoryStore } from "../memory.js";
import { paths } from "../settings.js";
import { nowIso } from "../util.js";
import { memoryTools } from "./memory-tools.js";
import { IDLE_DREAM_MS, Session, SessionManager, type SessionDeps } from "./session.js";
import type { ToolContext } from "./tools.js";

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

let personas = 0;

/** A SessionManager over one persona of its own, with a model that records every prompt. */
function setup(o: { autoDream?: boolean; autoBrief?: boolean } = {}) {
  const pid = `pc${++personas}`;
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
      memory: { autoBrief: !!o.autoBrief, briefTokens: o.autoBrief ? 1500 : 0, autoDream: !!o.autoDream },
      permissions: { default: "ask", allow: [], ask: [], deny: [] },
    },
  };
  const prompts: string[] = [];
  const systems: string[] = [];
  let reply: ((system: string, prompt: string) => string | undefined) | undefined;
  let n = 0;
  const deps = {
    personas: { get: (id: string) => (id === pid ? persona : undefined), namedRefs: () => [] },
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
      runTurn: vi.fn(async (_provider: string, r: { system: string; messages: { content: string }[] }) => {
        prompts.push(r.messages[0].content);
        systems.push(r.system);
        const text = reply?.(r.system, r.messages[0].content) ?? JSON.stringify({ objective: `goal ${++n}`, nextAction: "go on", sources: [] });
        return { content: [{ type: "text", text }], toolUses: [], stopReason: "end_turn", usage: { inputTokens: 1, outputTokens: 1, cacheReadTokens: 0, cacheWriteTokens: 0 } };
      }),
    },
    runtime: { stopSession: vi.fn(async () => {}) },
    diffs: { removeSession: vi.fn(async () => {}) },
    attachments: { removeSession: vi.fn(async () => {}) },
  } as unknown as SessionDeps;
  const m = new SessionManager(deps);
  return {
    m,
    deps,
    pid,
    prompts,
    systems,
    respond: (f: typeof reply) => void (reply = f),
    done: async () => {
      for (const s of m.list(pid)) await m.remove(s.id);
    },
  };
}

type Internals = {
  openEpoch(): Promise<void>;
  rollover(reason: string): Promise<void>;
  addItem(it: ChatItem): void;
  dreamIfQuiet(): Promise<void>;
  scheduleIdleDream(): void;
  epoch: { frozen: { system: string } };
};
const x = (s: Session) => s as unknown as Internals;
const say = (s: Session, text: string, id = `it_${text}`, ts = nowIso()) => x(s).addItem({ kind: "user", id, ts, text });
const roll = async (s: Session, text: string) => {
  await x(s).openEpoch();
  say(s, text);
  await x(s).rollover("test");
};
const isDream = (system: string) => system.includes("long-term memory");

describe("a rollover", () => {
  it("starts from its own conversation's checkpoint, not another conversation's", async () => {
    const { m, deps, pid, prompts, done } = setup();
    const a = m.create(pid, "A");
    const b = m.create(pid, "B");
    await roll(a, "task-a");
    await roll(b, "task-b");
    expect(prompts[1]).toContain("Previous checkpoint (may be null):\nnull");
    expect(prompts[1]).not.toContain("goal 1");
    expect(await deps.memory.latestCheckpoint(pid, b.id)).toMatchObject({ sessionId: b.id, objective: "goal 2" });
    await roll(a, "more-a");
    expect(prompts[2]).toContain('"objective":"goal 1"');
    await done();
  });

  it("runs /dream alongside the checkpoint, so the new context's brief has what it saved", async () => {
    const { m, pid, systems, respond, done } = setup({ autoDream: true, autoBrief: true });
    respond((sys) => (isDream(sys) ? JSON.stringify({ add: [{ type: "preference", content: "The user wants tabs, not spaces.", origin: "user", sources: ["it_tabs"] }] }) : undefined));
    const a = m.create(pid, "A");
    await roll(a, "tabs");
    expect(systems.filter(isDream)).toHaveLength(1);
    expect(x(a).epoch.frozen.system).toContain("The user wants tabs, not spaces.");
    await done();
  });

  it("doesn't run /dream when the persona turns it off", async () => {
    const { m, pid, systems, done } = setup({ autoDream: false });
    await roll(m.create(pid, "A"), "task");
    expect(systems.filter(isDream)).toHaveLength(0);
    await done();
  });
});

describe("/dream", () => {
  it("reads its own conversation's events since its own last run", async () => {
    const { m, pid, prompts, done } = setup();
    const a = m.create(pid, "A");
    const b = m.create(pid, "B");
    say(b, "task-b", "it_task-b", "2026-01-01T00:00:00.000Z"); // written before /dream runs in A
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
    await done();
  });

  it("keeps its place across a restart", async () => {
    const { m, deps, pid, prompts, done } = setup();
    await fs.mkdir(paths.sessions, { recursive: true }); // made at startup
    const a = m.create(pid, "A");
    say(a, "before-restart");
    await a.dream();
    const reopened = await Session.load(deps, path.join(paths.sessions, `${a.id}.json`));
    say(reopened, "after-restart");
    await reopened.dream();
    expect(prompts[1]).toContain("after-restart");
    expect(prompts[1]).not.toContain("before-restart");
    await done();
  });

  it("starts a conversation from before the per-conversation bookmark after its own last /dream", async () => {
    const { m, pid, prompts, done } = setup();
    const a = m.create(pid, "A");
    say(a, "old-a");
    x(a).addItem({ kind: "receipt", id: "it_dreamt", ts: nowIso(), action: "dream", title: "/dream", detail: "Consolidated memory", status: "done" });
    say(a, "new-a");
    await a.dream();
    expect(prompts[0]).toContain("new-a");
    expect(prompts[0]).not.toContain("old-a");
    await done();
  });

  it("reads the oldest events first and leaves the rest for the next run", async () => {
    const { m, pid, prompts, done } = setup();
    const a = m.create(pid, "A");
    say(a, `first ${"x".repeat(50_000)}`, "it_first");
    say(a, `second ${"y".repeat(50_000)}`, "it_second");
    await a.dream();
    expect(prompts[0]).toContain("[it_first]");
    expect(prompts[0]).not.toContain("[it_second]");
    expect(a.items.findLast((it) => it.kind === "receipt")).toMatchObject({ status: "done", detail: expect.stringContaining("newer events next time") });
    await a.dream();
    expect(prompts[1]).toContain("[it_second]");
    expect(prompts[1]).not.toContain("[it_first]");
    await done();
  });

  it("rereads saved memories against their events, in any of the persona's conversations, and corrects them", async () => {
    const { m, deps, pid, prompts, respond, done } = setup();
    const a = m.create(pid, "A");
    const b = m.create(pid, "B");
    say(a, "We use npm here, not pnpm.", "it_npm");
    const rec = await deps.memory.add(pid, { content: "The project uses pnpm.", type: "preference", origin: "user", sources: ["it_npm"], by: "agent" });
    respond((sys) => (isDream(sys) ? JSON.stringify({ revise: [{ id: rec.id, content: "The project uses npm, not pnpm.", reason: "the user said npm", sources: ["it_npm"] }] }) : undefined));
    say(b, "hello");
    await b.dream();
    expect(prompts[0]).toContain("Records to recheck");
    expect(prompts[0]).toContain("We use npm here, not pnpm.");
    const after = await deps.memory.get(pid, rec.id);
    expect(after).toMatchObject({ content: "The project uses npm, not pnpm.", version: 2, status: "active", origin: "user" });
    expect(after?.checkedAt).toBeTruthy();
    expect((await deps.memory.history(pid))[0]).toMatchObject({ action: "edited", by: "dream", summary: "Corrected: the user said npm" });
    await done();
  });

  it("says the user said something only when it cites a message the user wrote", async () => {
    const { m, deps, pid, prompts, respond, done } = setup();
    const a = m.create(pid, "A");
    say(a, "Always run the linter before committing.", "it_lint");
    say(a, "Start commit messages with a verb.", "it_verbs");
    x(a).addItem({ kind: "user", id: "it_watch", ts: nowIso(), text: "Disk usage is at 91%.", trigger: "watcher disk" });
    const old = await deps.memory.add(pid, { content: "Commit messages start with a verb.", type: "preference", origin: "user", sources: ["it_verbs"], by: "agent" });
    respond((sys) =>
      isDream(sys)
        ? JSON.stringify({
            add: [
              { type: "preference", content: "Run the linter before committing.", origin: "user", sources: ["it_lint"] },
              { type: "preference", content: "Keep disk usage under 90%.", origin: "user", sources: ["it_watch"] },
              { type: "decision", content: "Ship on Fridays.", origin: "user", sources: [] },
            ],
            revise: [{ id: old.id, content: "Commit messages start with an imperative verb.", reason: "more precise", origin: "user" }],
          })
        : undefined,
    );
    await a.dream();
    expect(prompts[0]).toContain("[it_lint] User: Always run the linter before committing.");
    expect(prompts[0]).toContain("[it_watch] Sent by watcher disk, not the user: Disk usage is at 91%.");
    const recs = await deps.memory.list(pid);
    const rec = (content: string) => recs.find((r) => r.content === content);
    expect(rec("Run the linter before committing.")).toMatchObject({ origin: "user", status: "active" });
    expect(rec("Keep disk usage under 90%.")).toMatchObject({ origin: "inference", status: "tentative" });
    expect(rec("Ship on Fridays.")).toMatchObject({ origin: "inference", status: "tentative" });
    expect(rec("Commit messages start with an imperative verb.")).toMatchObject({ origin: "user", status: "active" }); // its earlier source is the user's
    await done();
  });
});

describe("automatic /dream when a conversation goes quiet", () => {
  it("runs when the user wrote something new, and not for a scheduled run alone", async () => {
    const { m, pid, prompts, done } = setup({ autoDream: true });
    const a = m.create(pid, "A");
    x(a).addItem({ kind: "user", id: "it_sched", ts: nowIso(), text: "check the queue", trigger: "schedule nightly" });
    await x(a).dreamIfQuiet();
    expect(prompts).toHaveLength(0);
    say(a, "I review pull requests on Mondays.");
    await x(a).dreamIfQuiet();
    expect(prompts).toHaveLength(1);
    await x(a).dreamIfQuiet();
    expect(prompts).toHaveLength(1); // nothing new since
    await done();
  });

  it("waits until the conversation has been quiet long enough", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    try {
      const { m, pid, prompts, done } = setup({ autoDream: true });
      const a = m.create(pid, "A");
      say(a, "hello");
      x(a).scheduleIdleDream();
      await vi.advanceTimersByTimeAsync(IDLE_DREAM_MS - 1000);
      expect(prompts).toHaveLength(0);
      await vi.advanceTimersByTimeAsync(1000);
      await vi.waitFor(() => expect(prompts).toHaveLength(1));
      await done();
    } finally {
      vi.useRealTimers();
    }
  });

  it("doesn't run when the persona turns it off", async () => {
    const { m, pid, prompts, done } = setup({ autoDream: false });
    const a = m.create(pid, "A");
    say(a, "hello");
    await x(a).dreamIfQuiet();
    expect(prompts).toHaveLength(0);
    await done();
  });
});

describe("correcting memories", () => {
  it("revises a record, says why, and keeps its status in step with its origin", async () => {
    const m = new MemoryStore();
    const r = await m.add("pr1", { content: "Deploys run on Fridays.", type: "observation", origin: "inference", sources: ["it_a"], by: "agent" });
    expect(r.status).toBe("tentative");
    const v = await m.revise("pr1", r.id, { content: "Deploys run on Thursdays.", origin: "observation", sources: ["it_b"], reason: "the deploy log says Thursday" }, "agent");
    expect(v).toMatchObject({ content: "Deploys run on Thursdays.", origin: "observation", status: "active", version: 2, sources: ["it_a", "it_b"] });
    expect((await m.history("pr1"))[0]).toMatchObject({ action: "edited", by: "agent", summary: "Corrected: the deploy log says Thursday", before: "Deploys run on Fridays." });
    await m.act("pr1", r.id, "archive");
    await expect(m.revise("pr1", r.id, { content: "x" }, "agent")).rejects.toThrow();
  });

  it("rechecks tentative memories first, then the longest unchecked, and only those that cite events", async () => {
    const m = new MemoryStore();
    const old = await m.add("pr2", { content: "old", type: "observation", origin: "observation", sources: ["it_1"], by: "agent" });
    await m.add("pr2", { content: "guess", type: "observation", origin: "inference", sources: ["it_2"], by: "agent" });
    await m.add("pr2", { content: "typed by the user", type: "preference", origin: "user", sources: ["user"], by: "user" });
    await m.add("pr2", { content: "fresh", type: "observation", origin: "observation", sources: ["it_3"], by: "agent" });
    await m.applyDream("pr2", { add: [], merge: [], archive: [], checked: [old.id] });
    expect((await m.dueForRecheck("pr2", 10)).map((r) => r.content)).toEqual(["guess", "fresh", "old"]);
  });
});

describe("the agent's memory tools", () => {
  const memory = new MemoryStore();
  const tool = (name: string) => memoryTools({ memory, personaId: "pt", items: () => [] }).find((t) => t.name === name)!;
  const run = (name: string, input: Record<string, unknown>) => tool(name).run(input, {} as ToolContext);

  it("update a saved memory instead of adding a second one", async () => {
    const r = await memory.add("pt", { content: "Tests run with jest.", type: "procedure", origin: "observation", sources: ["it_1"], by: "agent" });
    const out = await run("memory_update", { id: r.id, content: "Tests run with vitest.", origin: "observation", sources: ["it_2"], reason: "package.json moved to vitest" });
    expect(out.text).toContain(`Updated ${r.id}`);
    expect(await memory.get("pt", r.id)).toMatchObject({ content: "Tests run with vitest.", version: 2 });
    expect((await memory.list("pt")).filter((x) => x.status === "active")).toHaveLength(1);
  });

  it("archive the agent's own memories, but not what the user said or pinned", async () => {
    const mine = await memory.add("pt", { content: "The staging API is slow.", type: "observation", origin: "observation", sources: [], by: "agent" });
    const said = await memory.add("pt", { content: "Use British spelling.", type: "preference", origin: "user", sources: [], by: "agent" });
    const pinned = await memory.add("pt", { content: "Deploy needs approval.", type: "decision", origin: "observation", sources: [], pinned: true, by: "user" });
    expect((await run("memory_archive", { id: mine.id, reason: "fixed last week" })).text).toBe(`Archived ${mine.id}.`);
    expect((await memory.get("pt", mine.id))?.status).toBe("archived");
    expect((await memory.history("pt"))[0].summary).toContain("fixed last week");
    expect((await run("memory_archive", { id: said.id, reason: "x" })).isError).toBe(true);
    expect((await run("memory_archive", { id: pinned.id, reason: "x" })).isError).toBe(true);
    expect((await run("memory_update", { id: mine.id, content: "x", origin: "observation", sources: [] })).isError).toBe(true); // archived
  });
});
