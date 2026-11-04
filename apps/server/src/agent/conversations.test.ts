import { EventEmitter } from "node:events";
import { describe, expect, it, vi } from "vitest";
import { SessionManager, type SessionDeps } from "./session.js";

function setup() {
  const broadcast = vi.fn();
  const persona = { id: "p", folders: [], errors: [], config: { skills: [], model: undefined, connections: {}, permissions: { default: "ask", allow: [], ask: [], deny: [] } } };
  const deps = {
    personas: { get: (id: string) => (id === "p" ? persona : undefined) },
    settings: { defaultModel: { provider: "fake", id: "m" } },
    proxy: { register: vi.fn(), unregister: vi.fn() },
    connections: new EventEmitter(),
    broadcast,
    onApprovalsChanged: vi.fn(),
    providers: { releaseSession: vi.fn() },
    runtime: { stopSession: vi.fn(async () => {}) },
    diffs: { removeSession: vi.fn(async () => {}) },
    attachments: { removeSession: vi.fn(async () => {}) },
  } as unknown as SessionDeps;
  return { m: new SessionManager(deps), broadcast };
}

describe("several conversations per persona", () => {
  it("opens the latest one the user started, not a scheduled run", async () => {
    const { m } = setup();
    const mine = m.create("p", "Mine");
    expect(m.conversation("p").id).toBe(mine.id);
    const run = m.create("p", "schedule morning", "schedule morning");
    expect(run.summary.trigger).toBe("schedule morning");
    run.rename("schedule morning"); // now the most recently updated
    expect(m.conversation("p").id).toBe(mine.id);
    expect(m.list("p")).toHaveLength(2);
    for (const s of m.list("p")) await m.remove(s.id);
  });

  it("creates a conversation only when the persona has none of the user's", async () => {
    const { m } = setup();
    const run = m.create("p", "watcher w", "watcher w");
    const first = m.conversation("p");
    expect(first.id).not.toBe(run.id);
    expect(m.conversation("p").id).toBe(first.id);
    for (const s of m.list("p")) await m.remove(s.id);
  });

  it("gives each scheduled run a conversation of its own", async () => {
    const { m } = setup();
    const trigger = vi.spyOn(Object.getPrototypeOf(m.create("p")), "trigger").mockImplementation(() => {});
    const t = m.triggerTarget("p");
    t.trigger("schedule a", "do a");
    t.trigger("schedule a", "do a again");
    expect(trigger).toHaveBeenCalledTimes(2);
    const runs = m.list("p").filter((s) => s.trigger);
    expect(runs.map((s) => s.title)).toEqual(["schedule a", "schedule a"]);
    expect(new Set(runs.map((s) => s.id)).size).toBe(2);
    trigger.mockRestore();
    for (const s of m.list("p")) await m.remove(s.id);
  });

  it("renames, and tells the app", async () => {
    const { m, broadcast } = setup();
    const s = m.create("p");
    broadcast.mockClear();
    s.rename("Certificates");
    expect(s.summary.title).toBe("Certificates");
    expect(broadcast).toHaveBeenCalledWith(expect.objectContaining({ type: "session.updated", session: expect.objectContaining({ title: "Certificates" }) }));
    await m.remove(s.id);
  });
});
