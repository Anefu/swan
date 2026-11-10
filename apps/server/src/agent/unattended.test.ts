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
