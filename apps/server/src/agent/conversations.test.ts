import { EventEmitter } from "node:events";
import { promises as fs } from "node:fs";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import type { ChatItem, SessionSummary } from "@ph/shared";
import { conversationAsks, conversationTools } from "./conversation-tools.js";
import { paths } from "../settings.js";
import { SessionManager } from "./session-manager.js";
import type { SessionDeps } from "./session.js";

function setup() {
  const broadcast = vi.fn();
  const other = { id: "q", folders: [], errors: [], config: { name: "Q", skills: [], model: undefined, connections: {}, memory: { autoBrief: false, briefTokens: 0, autoDream: false }, permissions: { default: "ask", allow: [], ask: [], deny: [] } } };
  const persona = { id: "p", folders: [], errors: [], config: { name: "P", skills: [], model: undefined, connections: {}, memory: { autoBrief: false, briefTokens: 0, autoDream: false }, permissions: { default: "ask", allow: [], ask: [], deny: [] } } };
  const deps = {
    personas: { get: (id: string) => (id === "p" ? persona : id === "q" ? other : undefined), list: () => [persona, other] },
    memory: { latestCheckpoint: vi.fn(async () => null), addCheckpoint: vi.fn(async () => {}) },
    settings: { defaultModel: { provider: "fake", id: "m" } },
    proxy: { register: vi.fn(), unregister: vi.fn() },
    connections: new EventEmitter(),
    broadcast,
    onApprovalsChanged: vi.fn(),
    providers: { releaseSession: vi.fn() },
    runtime: { stopSession: vi.fn(async () => {}) },
    diffs: { removeSession: vi.fn(async () => {}), copySession: vi.fn(async () => {}) },
    attachments: { removeSession: vi.fn(async () => {}), copySession: vi.fn(async () => {}) },
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
  const others = [{ id: "theirs", title: "Pull requests", personaId: "gh" }] as SessionSummary[];
  const personas = [
    { id: "p", name: "Coder" },
    { id: "gh", name: "GitHub helper" },
  ];
  const asks = (input: Record<string, unknown>, selfId: string) => conversationAsks(input, { selfId, personaId: "p", all: list, personas });
  const tool = (over: Partial<Parameters<typeof conversationTools>[0]> = {}) => {
    const access = { list: (pid: string) => (pid === "p" ? list : others), personas: () => personas, rename: vi.fn(), remove: vi.fn(async () => {}), deliver: vi.fn(async () => null) };
    const deleteSelfWhenDone = vi.fn();
    const t = conversationTools({ access, personaId: "p", selfId: "run", canSend: () => true, deleteSelfWhenDone, ...over })[0]!;
    return { run: (i: Record<string, unknown>) => t.run(i, {} as never), access, deleteSelfWhenDone };
  };

  it("asks before changing a conversation the user started, and nothing else", () => {
    expect(asks({ action: "delete", conversation: "mine" }, "run")).toBe(true);
    expect(asks({ action: "rename", conversation: "mine" }, "run")).toBe(true);
    expect(asks({ action: "delete" }, "mine")).toBe(true);
    expect(asks({ action: "rename" }, "mine")).toBe(false);
    expect(asks({ action: "delete" }, "run")).toBe(false);
    expect(asks({ action: "delete", conversation: "run2" }, "mine")).toBe(false);
    expect(asks({ action: "send", conversation: "mine" }, "run")).toBe(false);
    expect(asks({ action: "list" }, "run")).toBe(false);
  });

  it("asks before sending to another persona, by id or name, but not to this one", () => {
    expect(asks({ action: "send", persona: "gh", text: "hi" }, "run")).toBe(true);
    expect(asks({ action: "send", persona: "github helper", conversation: "Pull requests", text: "hi" }, "run")).toBe(true);
    expect(asks({ action: "send", persona: "Coder", conversation: "mine", text: "hi" }, "run")).toBe(false);
    expect(asks({ action: "list", persona: "gh" }, "run")).toBe(false);
  });

  it("sends to another persona's conversation, or starts one there, and lists its conversations", async () => {
    const { run, access } = tool();
    expect((await run({ action: "list", persona: "GitHub helper" })).text).toContain("theirs");
    expect((await run({ action: "send", persona: "gh", conversation: "Pull requests", text: "open the PR" })).isError).toBeFalsy();
    expect(access.deliver).toHaveBeenLastCalledWith("run", { id: "theirs" }, "open the PR");
    const started = await run({ action: "send", persona: "gh", text: "review this" });
    expect(started.text).toContain("new conversation in GitHub helper");
    expect(access.deliver).toHaveBeenLastCalledWith("run", { personaId: "gh" }, "review this");
    expect((await run({ action: "send", persona: "gh", conversation: "Release work", text: "hi" })).text).toContain("No conversation");
    expect((await run({ action: "send", persona: "nobody", text: "hi" })).text).toContain("No persona");
    expect((await run({ action: "delete", persona: "gh", conversation: "theirs" })).isError).toBe(true);
    expect(access.remove).not.toHaveBeenCalled();
  });

  it("sends by id or exact title, and refuses what it can't place", async () => {
    const { run, access } = tool();
    expect((await run({ action: "send", conversation: "Release work", text: "hi" })).isError).toBeFalsy();
    expect(access.deliver).toHaveBeenCalledWith("run", { id: "mine" }, "hi");
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
    const x = s as unknown as { sandbox: Record<string, unknown>; context: Record<string, unknown>; warnIfSharingFolders: unknown; agentTurns: unknown };
    for (const k of ["restartIfDue", "ensureStarted", "placeFiles", "teardown"]) x.sandbox[k] = vi.fn(async () => {});
    for (const k of ["prepare", "pushUser"]) x.context[k] = vi.fn(async () => {});
    x.warnIfSharingFolders = vi.fn();
    x.agentTurns = vi.fn(async () => during(s as never));
    return x;
  };
  const idle = async (s: object) => {
    await vi.waitFor(() => expect((s as { loopRunning: boolean }).loopRunning).toBe(false));
  };

  it("stays within the receiving persona's turn limit", async () => {
    const { m, deps } = setup();
    const a = m.create("p", "A");
    const c = m.create("p", "C");
    const deliver = vi.spyOn(c, "deliver").mockImplementation(() => {});
    const spent: string[] = [];
    m.spendTurn = async (pid) => (spent.push(pid), "Not sent: limit");
    expect(await deps.conversations!.deliver(a.id, { id: c.id }, "hi")).toBe("Not sent: limit");
    expect(deliver).not.toHaveBeenCalled();
    m.spendTurn = async () => null;
    expect(await deps.conversations!.deliver(a.id, { id: c.id }, "hi")).toBeNull();
    expect(deliver).toHaveBeenCalledWith(a.summary, "hi", undefined);
    expect(spent).toEqual(["p"]);
    for (const s of m.list()) await m.remove(s.id);
  });

  it("reaches another persona's conversation, or a new one there, saying which persona sent it", async () => {
    const { m, deps } = setup();
    const a = m.create("p", "A");
    const b = m.create("q", "B");
    const spent: string[] = [];
    m.spendTurn = async (pid) => (spent.push(pid), null);
    const toB = vi.spyOn(b, "deliver").mockImplementation(() => {});
    expect(await deps.conversations!.deliver(a.id, { id: b.id }, "hi")).toBeNull();
    expect(toB).toHaveBeenCalledWith(a.summary, "hi", "P");
    const proto = vi.spyOn(Object.getPrototypeOf(b), "deliver").mockImplementation(() => {});
    expect(await deps.conversations!.deliver(a.id, { personaId: "q" }, "review this")).toBeNull();
    const made = m.list("q").find((s) => s.id !== b.id)!;
    expect(made).toMatchObject({ title: "From P: A", trigger: "a message from P" });
    expect(proto).toHaveBeenLastCalledWith(a.summary, "review this", "P");
    expect(spent).toEqual(["q", "q"]);
    expect(await deps.conversations!.deliver(a.id, { personaId: "nobody" }, "hi")).toContain("can't run");
    proto.mockRestore();
    for (const s of m.list()) await m.remove(s.id);
  });

  it("tells the agent which persona sent it", async () => {
    const { m } = setup();
    const from = m.create("p", "Release work");
    const to = m.create("q", "Pull requests");
    const x = stubbed(to);
    to.deliver(from.summary, "open the PR", "P");
    await idle(to);
    const sent = String((x.context.pushUser as ReturnType<typeof vi.fn>).mock.calls[0]![0]);
    expect(sent).toContain('A conversation of another persona, "P", called "Release work"');
    const item = (to as unknown as { items: { kind: string; trigger?: string }[] }).items.find((i) => i.kind === "user");
    expect(item?.trigger).toBe('the conversations tool in "P" · "Release work"');
    for (const s of m.list()) await m.remove(s.id);
  });

  it("tells the agent it isn't from the user, and runs unattended without their allowances", async () => {
    const { m } = setup();
    const from = m.create("p", "morning", "schedule morning");
    const to = m.create("p", "Release work");
    (to as unknown as { summary: SessionSummary }).summary.allowances = ["bash(npm test *)", "net:example.com"];
    const seen: unknown[] = [];
    const x = stubbed(to, (s: { unattended: boolean; deliveredTurn: boolean; summary: SessionSummary }) => seen.push(s.unattended, s.deliveredTurn, s.summary.allowances.length));
    to.deliver(from.summary, "the build failed");
    await idle(to);
    expect(seen).toEqual([true, true, 0]);
    const sent = String((x.context.pushUser as ReturnType<typeof vi.fn>).mock.calls[0]![0]);
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
    (to as unknown as { sandbox: { container: string | null } }).sandbox.container = "running";
    to.deliver(from.summary, "two");
    await idle(to);
    expect(stop).toHaveBeenCalledOnce();
    (to as unknown as { sandbox: { container: string | null } }).sandbox.container = null;
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

describe("forking a conversation", () => {
  type Parts = { items: ChatItem[]; context: { epochs: { n: number; messages: unknown[] }[]; carry: string | null }; placeholders: Record<string, string>; proxyToken: string; dreams: { dreamedThrough: string | null } };
  /** What a fork copies, wherever in the conversation it lives. */
  const inside = (s: object) => {
    const i = s as unknown as Parts;
    return {
      items: i.items,
      epochs: i.context.epochs,
      proxyToken: i.proxyToken,
      get carry() {
        return i.context.carry;
      },
      set carry(v) {
        i.context.carry = v;
      },
      get placeholders() {
        return i.placeholders;
      },
      set placeholders(v) {
        i.placeholders = v;
      },
      get dreamedThrough() {
        return i.dreams.dreamedThrough;
      },
      set dreamedThrough(v) {
        i.dreams.dreamedThrough = v;
      },
    };
  };

  it("copies the events with their ids and the model context, as a stopped conversation of the user's", async () => {
    await fs.mkdir(paths.sessions, { recursive: true }); // the app makes it at startup
    const { m, deps, broadcast } = setup();
    const src = m.create("p", "Release work", "schedule nightly");
    const x = inside(src);
    x.items.push(
      { kind: "user", id: "it_a", ts: "2026-11-10T00:00:00.000Z", text: "ship it" },
      { kind: "tool_call", id: "toolu_1", ts: "2026-11-10T00:00:01.000Z", name: "bash", source: "builtin", input: {}, inputPreview: "make", status: "running" },
    );
    x.epochs.push({ n: 1, model: { provider: "fake", id: "m" }, frozen: { system: ["fixed", "brief"], tools: [] }, messages: [{ role: "user", content: "ship it" }], startedAt: "2026-11-10T00:00:00.000Z" } as never);
    x.carry = "checkpoint text";
    x.placeholders = { "github.token": "ph_token_1" };
    x.dreamedThrough = "it_a";
    src.summary.usage.inputTokens = 500;
    src.summary.allowances = ["bash(make *)"];
    (deps.memory.latestCheckpoint as ReturnType<typeof vi.fn>).mockResolvedValueOnce({ sessionId: src.id, epoch: 1, objective: "ship", sources: ["it_a"] });
    broadcast.mockClear();

    const fork = await m.fork(src.id);
    const f = inside(fork);
    expect(fork.id).not.toBe(src.id);
    expect(fork.summary).toMatchObject({ personaId: "p", title: "Release work (fork)", status: "stopped", allowances: [], epoch: 1 });
    expect(fork.summary.trigger).toBeUndefined();
    expect(fork.summary.usage.inputTokens).toBe(0);
    expect(f.items.map((i) => i.id)).toEqual(["it_a", "toolu_1"]);
    expect(f.items[1]).toMatchObject({ status: "interrupted" });
    expect((x.items[1] as { status: string }).status).toBe("running"); // the original is untouched
    expect(f.epochs[0]!.messages[0]).toEqual({ role: "user", content: "ship it" });
    expect(f.epochs).not.toBe(x.epochs);
    expect(f.carry).toBe("checkpoint text");
    expect(f.placeholders).toEqual({ "github.token": "ph_token_1" });
    expect(f.proxyToken).not.toBe(x.proxyToken);
    expect(f.dreamedThrough).toBe("it_a");
    expect(deps.attachments.copySession).toHaveBeenCalledWith(src.id, fork.id);
    expect(deps.diffs.copySession).toHaveBeenCalledWith(src.id, fork.id);
    expect(deps.memory.addCheckpoint).toHaveBeenCalledWith("p", expect.objectContaining({ sessionId: fork.id, objective: "ship" }));
    expect(broadcast).toHaveBeenCalledWith(expect.objectContaining({ type: "session.updated", session: expect.objectContaining({ id: fork.id }) }));
    await expect(fs.access(path.join(paths.sessions, `${fork.id}.json`))).resolves.toBeUndefined();
    for (const s of m.list()) await m.remove(s.id);
  });

  it("keeps a long title within the limit", async () => {
    const { m } = setup();
    const src = m.create("p", "x".repeat(120));
    const fork = await m.fork(src.id);
    expect(fork.summary.title.length).toBeLessThanOrEqual(120);
    expect(fork.summary.title.endsWith(" (fork)")).toBe(true);
    for (const s of m.list()) await m.remove(s.id);
  });
});
