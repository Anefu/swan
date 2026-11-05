import { EventEmitter } from "node:events";
import { promises as fs } from "node:fs";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import type { SessionSummary } from "@ph/shared";
import { conversationAsks, conversationTools } from "./conversation-tools.js";
import { paths } from "../settings.js";
import { SessionManager, type SessionDeps } from "./session.js";

function setup() {
  const broadcast = vi.fn();
  const other = { id: "q", folders: [], errors: [], config: { skills: [], model: undefined, connections: {}, permissions: { default: "ask", allow: [], ask: [], deny: [] } } };
  const persona = { id: "p", folders: [], errors: [], config: { skills: [], model: undefined, connections: {}, permissions: { default: "ask", allow: [], ask: [], deny: [] } } };
  const deps = {
    personas: { get: (id: string) => (id === "p" ? persona : id === "q" ? other : undefined) },
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
  return { m: new SessionManager(deps), broadcast, deps };
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

describe("the conversations tool", () => {
  const list = [
    { id: "mine", title: "Release work", personaId: "p" },
    { id: "other", title: "Other", personaId: "p" },
    { id: "run", title: "watcher w", personaId: "p", trigger: "watcher w" },
    { id: "run2", title: "watcher w", personaId: "p", trigger: "watcher w" },
  ] as SessionSummary[];
  const tool = (over: Partial<Parameters<typeof conversationTools>[0]> = {}) => {
    const access = { list: () => list, rename: vi.fn(), remove: vi.fn(async () => {}), deliver: vi.fn(async () => null) };
    const deleteSelfWhenDone = vi.fn();
    const t = conversationTools({ access, personaId: "p", selfId: "run", canSend: () => true, deleteSelfWhenDone, ...over })[0]!;
    return { run: (i: Record<string, unknown>) => t.run(i, {} as never), access, deleteSelfWhenDone };
  };

  it("asks before changing a conversation the user started, and nothing else", () => {
    expect(conversationAsks({ action: "delete", conversation: "mine" }, "run", list)).toBe(true);
    expect(conversationAsks({ action: "rename", conversation: "mine" }, "run", list)).toBe(true);
    expect(conversationAsks({ action: "delete" }, "mine", list)).toBe(true);
    expect(conversationAsks({ action: "rename" }, "mine", list)).toBe(false);
    expect(conversationAsks({ action: "delete" }, "run", list)).toBe(false);
    expect(conversationAsks({ action: "delete", conversation: "run2" }, "mine", list)).toBe(false);
    expect(conversationAsks({ action: "send", conversation: "mine" }, "run", list)).toBe(false);
    expect(conversationAsks({ action: "list" }, "run", list)).toBe(false);
  });

  it("sends by id or exact title, and refuses what it can't place", async () => {
    const { run, access } = tool();
    expect((await run({ action: "send", conversation: "Release work", text: "hi" })).isError).toBeFalsy();
    expect(access.deliver).toHaveBeenCalledWith("run", "mine", "hi");
    expect((await run({ action: "send", conversation: "watcher w", text: "hi" })).text).toContain("Several");
    expect((await run({ action: "send", conversation: "nope", text: "hi" })).isError).toBe(true);
    expect((await run({ action: "send", conversation: "run", text: "hi" })).isError).toBe(true);
    expect(access.deliver).toHaveBeenCalledTimes(1);
  });

  it("can't send from a turn another conversation started", async () => {
    const { run, access } = tool({ canSend: () => false });
    const r = await run({ action: "send", conversation: "mine", text: "hi" });
    expect(r.isError).toBe(true);
    expect(access.deliver).not.toHaveBeenCalled();
  });

  it("deletes itself only when the turn ends", async () => {
    const { run, access, deleteSelfWhenDone } = tool();
    await run({ action: "delete" });
    expect(deleteSelfWhenDone).toHaveBeenCalledOnce();
    expect(access.remove).not.toHaveBeenCalled();
    await run({ action: "delete", conversation: "other" });
    expect(access.remove).toHaveBeenCalledWith("other");
  });
});

describe("a message from another conversation", () => {
  // The turn itself is stubbed: these check what surrounds it.
  const stubbed = (s: object, during: (s: never) => void = () => {}) => {
    const x = s as Record<string, unknown>;
    for (const k of ["restartIfDue", "ensureStarted", "prepareEpoch", "placeFiles", "warnIfSharingFolders", "pushUser"]) x[k] = vi.fn(async () => {});
    x.agentTurns = vi.fn(async () => during(s as never));
    return x;
  };
  const idle = async (s: object) => {
    await vi.waitFor(() => expect((s as { loopRunning: boolean }).loopRunning).toBe(false));
  };

  it("stays inside the persona and within its turn limit", async () => {
    const { m, deps } = setup();
    const a = m.create("p", "A");
    const b = m.create("q", "B");
    const c = m.create("p", "C");
    const deliver = vi.spyOn(c, "deliver").mockImplementation(() => {});
    expect(await deps.conversations!.deliver(a.id, b.id, "hi")).toContain("isn't in this persona");
    m.spendTurn = async () => "Not sent: limit";
    expect(await deps.conversations!.deliver(a.id, c.id, "hi")).toBe("Not sent: limit");
    expect(deliver).not.toHaveBeenCalled();
    m.spendTurn = async () => null;
    expect(await deps.conversations!.deliver(a.id, c.id, "hi")).toBeNull();
    expect(deliver).toHaveBeenCalledOnce();
    for (const s of m.list()) await m.remove(s.id);
  });

  it("tells the agent it isn't from the user, and runs unattended without their allowances", async () => {
    const { m } = setup();
    const from = m.create("p", "morning", "schedule morning");
    const to = m.create("p", "Release work");
    (to as unknown as { summary: SessionSummary }).summary.allowances = ["bash(npm test *)", "net:example.com"];
    const seen: unknown[] = [];
    const x = stubbed(to, (s: { unattended: boolean; deliveredTurn: boolean; summary: SessionSummary }) => seen.push(s.unattended, s.deliveredTurn, s.summary.allowances.length));
    x.teardown = vi.fn(async () => {});
    to.deliver(from.summary, "the build failed");
    await idle(to);
    expect(seen).toEqual([true, true, 0]);
    const sent = String((x.pushUser as ReturnType<typeof vi.fn>).mock.calls[0]![0]);
    expect(sent).toMatch(/^\[Not from the user\./);
    expect(sent).toContain("conversations tool");
    expect(sent).toContain('"morning" (a run of schedule morning)');
    expect(sent.endsWith("the build failed")).toBe(true);
    const item = (to as unknown as { items: { kind: string; trigger?: string; text?: string }[] }).items.find((i) => i.kind === "user");
    expect(item).toMatchObject({ text: "the build failed", trigger: 'the conversations tool in "morning"' });
    expect((to as unknown as { unattended: boolean; deliveredTurn: boolean }).unattended).toBe(false);
    expect((to as unknown as { deliveredTurn: boolean }).deliveredTurn).toBe(false);
    for (const s of m.list()) await m.remove(s.id);
  });

  it("doesn't join the turn the user is in", async () => {
    const { m } = setup();
    const from = m.create("p", "from");
    const to = m.create("p", "to") as unknown as { deliver: (f: SessionSummary, t: string) => void; takeSteering: () => { text: string }[]; queue: { text: string; delivered?: boolean }[]; loopRunning: boolean };
    to.loopRunning = true; // a turn is running
    to.queue.push({ text: "from the user" });
    to.deliver(from.summary, "from elsewhere");
    expect(to.takeSteering().map((q) => q.text)).toEqual(["from the user"]);
    expect(to.queue).toHaveLength(1);
    expect(to.queue[0]!.delivered).toBe(true);
    to.queue = [];
    to.loopRunning = false;
    for (const s of m.list()) await m.remove(s.id);
  });

  it("stops a sandbox it started, and leaves one that was already running", async () => {
    const { m } = setup();
    const from = m.create("p", "from");
    const to = m.create("p", "to");
    stubbed(to);
    const stop = vi.spyOn(to, "stop").mockImplementation(async () => {});
    to.deliver(from.summary, "one");
    await idle(to);
    expect(stop).toHaveBeenCalledOnce();
    (to as unknown as { container: string | null }).container = "running";
    to.deliver(from.summary, "two");
    await idle(to);
    expect(stop).toHaveBeenCalledOnce();
    (to as unknown as { container: string | null }).container = null;
    stop.mockRestore();
    for (const s of m.list()) await m.remove(s.id);
  });

  it("deletes a conversation that deleted itself once its turn ends, and doesn't write it back", async () => {
    const { m } = setup();
    const run = m.create("p", "run", "watcher w");
    await run.persist();
    stubbed(run, (s: { deleteWhenDone: boolean }) => (s.deleteWhenDone = true));
    run.trigger("watcher w", "check");
    await idle(run);
    await vi.waitFor(() => expect(m.get(run.id)).toBeUndefined());
    await run.persist();
    await expect(fs.access(path.join(paths.sessions, `${run.id}.json`))).rejects.toThrow();
  });
});
