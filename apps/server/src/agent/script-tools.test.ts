import { EventEmitter } from "node:events";
import { describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { PermissionPolicy } from "./permissions.js";
import { SessionManager, type SessionDeps } from "./session.js";
import { SWAN_TOOL_SCRIPT, toolList } from "./script-tools.js";
import { zodTool } from "./tools.js";

// swan-tool: a command calling Swan's tools, under the rules of the bash call it runs in.
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
    proxy: { register: vi.fn(), unregister: vi.fn() } as Record<string, unknown>,
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
  const ran: unknown[] = [];
  const lookup = zodTool({ name: "lookup", description: "Look something up. More detail here.", schema: z.object({ q: z.string() }), preview: (i) => i.q, run: async (i) => (ran.push(i), { text: `found ${i.q}` }) });
  const fails = zodTool({ name: "fails", description: "Always fails.", schema: z.object({}), preview: () => "fails", run: async () => ({ text: "it broke", isError: true }) });
  const bash = zodTool({ name: "bash", description: "Shell.", schema: z.object({ command: z.string() }), preview: (i) => i.command, run: async () => ({ text: "" }) });
  s.liveTools = new Map([lookup, fails, bash].map((t) => [t.name, t]));
  const allowAll = new PermissionPolicy({ default: "allow", allow: [], ask: [], deny: [] }, []);
  /** A bash call that is running now, with these rules. */
  const running = (id: string, o: { policy?: PermissionPolicy; unattended?: boolean; parentId?: string } = {}) =>
    s.scriptCalls.set(id, { signal: new AbortController().signal, policy: o.policy ?? allowAll, unattended: !!o.unattended, parentId: o.parentId });
  const call = (callId: string, method: string, path: string, body = "") => s.callFromSandbox({ method, path, callId, body }) as Promise<{ status: number; body: string }>;
  return { m, s, deps, ran, running, call, done: async () => { for (const x of m.list()) await m.remove(x.id); } };
}

describe("swan-tool", () => {
  it("runs a tool for a running bash call and gives the result to the command, not the model", async () => {
    const { s, ran, running, call, done } = setup();
    running("tu_bash");
    const r = await call("tu_bash", "POST", "/call/lookup", '{"q":"x"}');
    expect(r).toEqual({ status: 200, body: "found x\n" });
    expect(ran).toEqual([{ q: "x" }]);
    const item = s.items.find((it: { name?: string }) => it.name === "lookup");
    expect(item).toMatchObject({ kind: "tool_call", status: "done", via: "tu_bash" });
    await done();
  });

  it("says when the tool reports an error, and refuses bad input", async () => {
    const { running, call, done } = setup();
    running("b");
    expect(await call("b", "POST", "/call/fails", "{}")).toEqual({ status: 422, body: "it broke\n" });
    expect((await call("b", "POST", "/call/lookup", "not json")).status).toBe(400);
    expect((await call("b", "POST", "/call/lookup", "[1]")).status).toBe(400);
    await done();
  });

  it("works only while the bash call is running", async () => {
    const { ran, call, done } = setup();
    const r = await call("tu_old", "POST", "/call/lookup", '{"q":"x"}');
    expect(r.status).toBe(403);
    expect(ran).toEqual([]);
    await done();
  });

  it("checks each call like a direct one: refused in an unattended run when it would ask", async () => {
    const { s, ran, running, call, done } = setup();
    running("b", { policy: new PermissionPolicy({ default: "ask", allow: [], ask: [], deny: [] }, []), unattended: true });
    const r = await call("b", "POST", "/call/lookup", '{"q":"x"}');
    expect(r.status).toBe(403);
    expect(r.body).toContain("Not allowed in an unattended run");
    expect(ran).toEqual([]);
    expect(s.pendingApprovals()).toEqual([]);
    await done();
  });

  it("ends a call waiting for approval when the command that made it ends", async () => {
    const { s, ran, call, done } = setup();
    let finishCommand!: () => void;
    const bash = { ...s.liveTools.get("bash"), run: () => new Promise((r) => (finishCommand = () => r({ text: "[exit code 124]", isError: true }))) };
    s.liveTools.set("bash", bash);
    s.container = "c";
    const ask = new PermissionPolicy({ default: "ask", allow: ["bash"], ask: [], deny: [] }, []);
    const outer = s.runOne({ id: "tu_bash", name: "bash", input: { command: "x" } }, ask, new AbortController().signal, false);
    await vi.waitFor(() => expect(s.scriptCalls.has("tu_bash")).toBe(true));
    const inner = call("tu_bash", "POST", "/call/lookup", '{"q":"x"}');
    await vi.waitFor(() => expect(s.pendingApprovals()).toHaveLength(1));
    finishCommand();
    await outer;
    expect((await inner).status).toBe(403);
    expect(s.pendingApprovals()).toEqual([]);
    expect(ran).toEqual([]);
    await done();
  });

  it("keeps a sub-agent's calls under its agent", async () => {
    const { s, running, call, done } = setup();
    running("b", { parentId: "tu_agent" });
    await call("b", "POST", "/call/lookup", '{"q":"y"}');
    expect(s.items.find((it: { name?: string }) => it.name === "lookup")).toMatchObject({ parentId: "tu_agent", via: "b" });
    await done();
  });

  it("lists and explains the tools a command may call, without bash", async () => {
    const { running, call, done } = setup();
    running("b");
    const list = await call("b", "GET", "/tools");
    expect(list.body).toBe("lookup: Look something up.\nfails: Always fails.\n");
    expect((await call("b", "GET", "/tools/lookup")).body).toContain('"q"');
    expect((await call("b", "POST", "/call/bash", '{"command":"ls"}')).status).toBe(404);
    await done();
  });

  it("is reached through the proxy, by the session the proxy authenticated", async () => {
    const { s, deps, running, done } = setup();
    running("b");
    const caller = (deps.proxy as unknown as { toolCaller: (ps: { sessionId: string }, r: object) => Promise<{ status: number }> }).toolCaller;
    expect((await caller({ sessionId: s.id }, { method: "POST", path: "/call/lookup", callId: "b", body: '{"q":"z"}' })).status).toBe(200);
    expect((await caller({ sessionId: "someone-else" }, { method: "POST", path: "/call/lookup", callId: "b", body: '{"q":"z"}' })).status).toBe(404);
    await done();
  });
});

describe("the swan-tool script", () => {
  it("is plain sh that sends the call id", () => {
    expect(SWAN_TOOL_SCRIPT.startsWith("#!/bin/sh\n")).toBe(true);
    expect(SWAN_TOOL_SCRIPT).toContain('-H "x-swan-call: $SWAN_CALL"');
    expect(SWAN_TOOL_SCRIPT).toContain("http://tools.swan.internal");
  });
  it("lists a description's first sentence", () => {
    expect(toolList([{ name: "a", description: "One. Two." } as never])).toBe("a: One.\n");
  });
});
