import { EventEmitter } from "node:events";
import { describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { SessionManager, type SessionDeps } from "./session.js";
import { zodTool } from "./tools.js";

// Unattended runs: nobody can answer, so anything that would ask is refused, and that has to hold
// for the run's background agents and their reports too, after the turn that started them ends.
function setup() {
  const persona = {
    id: "p",
    folders: [],
    errors: [],
    config: { skills: [], model: undefined, connections: {}, permissions: { default: "ask", allow: [], ask: [], deny: [] }, unattended: { allow: [], credentials: {}, maxTurnsPerDay: 30 } },
  };
  const deps = {
    personas: { get: (id: string) => (id === "p" ? persona : undefined) },
    settings: { defaultModel: { provider: "fake", id: "m" }, toolOutputLimit: 10_000 },
    proxy: { register: vi.fn(), unregister: vi.fn() },
    connections: new EventEmitter(),
    broadcast: vi.fn(),
    onApprovalsChanged: vi.fn(),
    providers: { releaseSession: vi.fn() },
    runtime: { stopSession: vi.fn(async () => {}) },
    diffs: { removeSession: vi.fn(async () => {}) },
    attachments: { removeSession: vi.fn(async () => {}) },
    presence: { away: false },
  } as unknown as SessionDeps;
  const m = new SessionManager(deps);
  const s = m.create("p") as unknown as Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any
  return { m, s };
}

const ran = vi.fn();
const asks = zodTool({ name: "deploy", description: "d", schema: z.object({}), preview: () => "deploy", run: async () => (ran(), { text: "deployed" }) });
const call = (s: Record<string, any>, origin?: { unattended: boolean; delivered: boolean }) => // eslint-disable-line @typescript-eslint/no-explicit-any
  s.runTools([{ id: `tu_${Math.random()}`, name: "deploy", input: {} }], new AbortController().signal, origin ? "parent" : undefined, new Map([["deploy", asks]]), origin);
const text = (r: unknown) => JSON.stringify(r);

describe("unattended runs", () => {
  it("refuse a tool that would ask, unless unattended.allow lists it, without a card", async () => {
    const { m, s } = setup();
    s.unattended = true;
    expect(text(await call(s))).toContain("Not allowed in an unattended run");
    expect(s.pendingApprovals()).toEqual([]);
    expect(ran).not.toHaveBeenCalled();
    s.deps.personas.get("p").config.unattended.allow = ["deploy"];
    await call(s);
    expect(ran).toHaveBeenCalledOnce();
    ran.mockClear();
    s.unattended = false;
    for (const x of m.list()) await m.remove(x.id);
  });

  it("don't use what the user allowed until stopped", async () => {
    const { m, s } = setup();
    s.summary.allowances = ["deploy"];
    s.unattended = true;
    expect(text(await call(s))).toContain("Not allowed in an unattended run");
    expect(ran).not.toHaveBeenCalled();
    s.unattended = false;
    for (const x of m.list()) await m.remove(x.id);
  });

  it("keep their rules for a background agent after the turn that started it ends", async () => {
    const { m, s } = setup();
    s.unattended = false; // the run's turn is over; the user may be here now
    expect(text(await call(s, { unattended: true, delivered: false }))).toContain("Not allowed in an unattended run");
    expect(s.pendingApprovals()).toEqual([]);
    expect(ran).not.toHaveBeenCalled();
    for (const x of m.list()) await m.remove(x.id);
  });

  it("refuse new hosts and asking credentials while a run's agent is at work", async () => {
    const { m, s } = setup();
    s.notice = vi.fn();
    s.agents.set("ag_1", { sub: { active: true }, origin: { unattended: true, delivered: false } });
    expect(await s.requestNetwork("example.com", 443)).toBe(false);
    expect(await s.requestCredentialUse("c/tok", { rule: "get *", op: { description: "get pods" } })).toBe(false);
    expect(s.pendingApprovals()).toEqual([]);
    s.agents.clear();
    for (const x of m.list()) await m.remove(x.id);
  });

  it("report a run's background agent in an unattended turn of its own, which can't send further", async () => {
    const { m, s } = setup();
    s.runLoop = vi.fn();
    s.receipt = vi.fn();
    s.onAgentOutcome = vi.fn();
    const sub = { run: { id: "ag_1", startedAt: new Date().toISOString() }, next: async () => ({ kind: "report" }), describe: () => "done" };
    await s.watchBackground({ sub, toolUseId: "t", description: "check", origin: { unattended: true, delivered: true } });
    expect(s.queue).toEqual([expect.objectContaining({ fromAgent: true, trigger: "background agent", delivered: true })]);
    // It doesn't join a turn the user is in.
    s.queue.unshift({ text: "from the user" });
    expect(s.takeSteering().map((q: { text: string }) => q.text)).toEqual(["from the user"]);
    expect(s.queue).toHaveLength(1);
    s.queue = [];
    for (const x of m.list()) await m.remove(x.id);
  });
});

describe("what every unattended run may do", () => {
  const stand = (name: string) => zodTool({ name, description: "d", schema: z.object({ action: z.string() }), preview: () => name, primaryArg: (i) => i.action, run: async () => ({ text: "" }) });
  it("manages watchers and sends to other conversations, but doesn't rename or delete them", () => {
    const { s } = setup();
    const p = s.unattendedPolicy();
    expect(p.evaluate(stand("watch"), { action: "add" }).mode).toBe("allow");
    expect(p.evaluate(stand("conversations"), { action: "send" }).mode).toBe("allow");
    expect(p.evaluate(stand("conversations"), { action: "delete" }).mode).not.toBe("allow");
    expect(p.evaluate(stand("conversations"), { action: "rename" }).mode).not.toBe("allow");
  });
});

describe("a chain of conversations", () => {
  it("lets a delivered turn reply, and stops after the last send it may make", async () => {
    const { m, s } = setup();
    s.runLoop = vi.fn();
    const from = m.create("p", "from");
    s.deliver(from.summary, "first", undefined, 1);
    expect(s.queue.at(-1)).toMatchObject({ delivered: true, hops: 1 });
    expect(s.queue.at(-1).text).toContain(`To reply, send to conversation ${from.id}`);
    s.deliver(from.summary, "last", undefined, 3);
    expect(s.queue.at(-1).text).toContain("can't send to other conversations");
    s.queue = [];
    vi.spyOn(from, "deliver").mockImplementation(() => {});
    s.deps.personas.list = () => [];
    const [tool] = s.conversationTools();
    for (const [hops, ok] of [[0, true], [2, true], [3, false]] as const) {
      s.turnHops = hops;
      expect((await tool.run({ action: "send", conversation: from.id, text: "hi" })).isError ?? false).toBe(!ok);
    }
    s.turnHops = 0;
    for (const x of m.list()) await m.remove(x.id);
  });

  it("counts each send: a turn started at hop n sends at hop n + 1", async () => {
    const { m } = setup();
    const deps = (m as unknown as { deps: SessionDeps }).deps;
    m.spendTurn = async () => null;
    const a = m.create("p", "A");
    const b = m.create("p", "B");
    const toB = vi.spyOn(b, "deliver").mockImplementation(() => {});
    (a as unknown as { turnHops: number }).turnHops = 2;
    expect(await deps.conversations!.deliver(a.id, { id: b.id }, "reply")).toBeNull();
    expect(toB).toHaveBeenCalledWith(a.summary, "reply", undefined, 3);
    for (const x of m.list()) await m.remove(x.id);
  });
});

describe("when the user is away (no Swan window connected)", () => {
  it("follows the unattended rules for what would ask", async () => {
    const { m, s } = setup();
    m.setAway(true);
    expect(text(await call(s))).toContain("Not allowed in an unattended run");
    expect(s.pendingApprovals()).toEqual([]);
    expect(await s.requestNetwork("example.com", 443)).toBe(false);
    s.deps.personas.get("p").config.unattended.allow = ["deploy"];
    await call(s);
    expect(ran).toHaveBeenCalledOnce();
    ran.mockClear();
    s.deps.personas.get("p").config.unattended.allow = [];
    m.setAway(false);
    for (const x of m.list()) await m.remove(x.id);
  });

  it("decides what was already waiting when the user leaves", async () => {
    const { m, s } = setup();
    s.notice = vi.fn();
    const refused = call(s);
    await vi.waitFor(() => expect(s.pendingApprovals()).toHaveLength(1));
    m.setAway(true);
    expect(text(await refused)).toContain("left Swan before approving");
    expect(ran).not.toHaveBeenCalled();
    m.setAway(false);

    s.deps.personas.get("p").config.unattended.allow = ["deploy"];
    const allowed = call(s);
    await vi.waitFor(() => expect(s.pendingApprovals()).toHaveLength(1));
    m.setAway(true);
    expect(text(await allowed)).toContain("deployed");
    expect(s.pendingApprovals()).toEqual([]);
    ran.mockClear();
    s.deps.personas.get("p").config.unattended.allow = [];
    m.setAway(false);
    for (const x of m.list()) await m.remove(x.id);
  });

  it("asks the user again once a window is back", async () => {
    const { m, s } = setup();
    m.setAway(true);
    m.setAway(false);
    const waiting = call(s);
    await vi.waitFor(() => expect(s.pendingApprovals()).toHaveLength(1));
    for (const a of s.approvals.values()) a.resolve({ decision: "deny" });
    expect(text(await waiting)).toContain("The user denied");
    for (const x of m.list()) await m.remove(x.id);
  });
});

describe("sub-agent handoff", () => {
  const fake = () => {
    let emit!: (o: unknown) => void;
    const run = { id: "ag_9", state: "running", background: false, startedAt: new Date().toISOString() };
    const sub = {
      run,
      active: true,
      next: () => new Promise((r) => (emit = r)),
      toBackground: () => (run.background ? false : ((run.background = true), true)),
      describe: (o: { text: string }) => o.text,
      stop: () => {},
    };
    return { sub, run, emit: (o: unknown) => emit(o), entry: { sub, toolUseId: "tu_agent", description: "long job", origin: { unattended: false, delivered: false } } };
  };

  it("returns a quick agent's report as the call's result", async () => {
    const { m, s } = setup();
    const f = fake();
    s.agents.set("ag_9", f.entry);
    s.handoffMs = 1_000;
    const waiting = s.waitForeground(f.entry);
    f.emit({ kind: "report", text: "quick answer" });
    expect((await waiting).text).toBe("quick answer");
    expect(f.run.background).toBe(false);
    for (const x of m.list()) await m.remove(x.id);
  });

  it("hands a slow agent off to the background, and its report still reaches the conversation", async () => {
    const { m, s } = setup();
    const f = fake();
    s.agents.set("ag_9", f.entry);
    s.runLoop = vi.fn(async () => {});
    s.handoffMs = 20;
    expect((await s.waitForeground(f.entry)).text).toContain("handed off to the background");
    expect(f.run.background).toBe(true);
    f.emit({ kind: "report", text: "all done" });
    await vi.waitFor(() => expect(JSON.stringify(s.queue)).toContain("all done"));
    for (const x of m.list()) await m.remove(x.id);
  });
});
