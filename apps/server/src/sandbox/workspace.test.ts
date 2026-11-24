import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import type { CertAuthority } from "../proxy/ca.js";
import { paths, type Settings } from "../settings.js";
import { agentHome, defaultMount, skillPath, useWorkspaceLayout } from "./layout.js";
import { WorkspaceRuntime, passedEnv } from "./workspace.js";

const CA = "-----BEGIN CERTIFICATE-----\nU1dBTi1URVNU\n-----END CERTIFICATE-----";
let dir: string;

function runtime() {
  const settings = { proxyPort: 4999, runtime: { passEnv: ["MY_TOOL_HOME"] } } as unknown as Settings;
  return new WorkspaceRuntime(settings, { certPem: CA } as CertAuthority);
}

async function started(id = "s1") {
  const rt = runtime();
  await rt.init();
  await rt.startSession({ sessionId: id, personaId: "p", folders: [{ hostPath: dir, mountPath: dir, mode: "rw" }], skills: [], env: { PERSONA_VAR: "x" }, proxyUrl: rt.proxyUrl(id, "tok"), workdir: dir, cpus: 1, memory: "1g", pidsLimit: 100 });
  return rt;
}

beforeAll(async () => {
  useWorkspaceLayout(true);
  dir = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "swan-ws-")));
});
afterAll(async () => {
  useWorkspaceLayout(false);
  await fs.rm(dir, { recursive: true, force: true });
});

describe("the workspace layout", () => {
  afterEach(() => useWorkspaceLayout(true));
  it("puts folders and skills at their real paths and each conversation's home under PH_HOME", () => {
    expect(defaultMount("/work/repo")).toBe("/work/repo");
    expect(skillPath("tour", "/x/skills/tour")).toBe("/x/skills/tour");
    expect(agentHome("s9")).toBe(path.join(paths.home, "agents", "s9"));
    useWorkspaceLayout(false);
    expect(defaultMount("/Users/me/repo")).toBe("/workspace/repo");
    expect(skillPath("tour", "/x")).toBe("/skills/tour");
    expect(agentHome("s9")).toBe("/home/agent");
  });
});

describe("variables commands get from Swan's environment", () => {
  it("passes the basics and passEnv, never anything named like a secret", () => {
    const env = passedEnv(
      { PATH: "/bin", HOME: "/h", LC_ALL: "C", MY_TOOL_HOME: "/t", OTHER: "no", GITHUB_TOKEN: "s", CODER_AGENT_TOKEN: "s", MY_API_KEY: "s", ANTHROPIC_API_KEY: "s" },
      ["MY_TOOL_HOME", "GITHUB_TOKEN"],
    );
    expect(env).toEqual({ PATH: "/bin", HOME: "/h", LC_ALL: "C", MY_TOOL_HOME: "/t" });
  });
});

describe("commands in the workspace", () => {
  it("run in the folder, through Swan's proxy, trusting Swan's CA", async () => {
    const rt = await started();
    const r = await rt.execShell("s1", 'pwd; echo "$HTTPS_PROXY"; echo "$PERSONA_VAR"; echo "$SWAN_AGENT_HOME"; grep -c U1dBTi1URVNU "$SSL_CERT_FILE"', { timeoutMs: 10_000 });
    expect(r.code).toBe(0);
    expect(r.stdout.trim().split("\n")).toEqual([dir, "http://s1:tok@127.0.0.1:4999", "x", agentHome("s1"), "1"]);
    expect((await fs.stat(agentHome("s1"))).isDirectory()).toBe(true);
    await rt.stopSession("s1");
  });

  it("report a timeout as exit 124 and end what the command started", async () => {
    const rt = await started();
    const marker = path.join(dir, "late");
    const t0 = Date.now();
    const r = await rt.execShell("s1", `(sleep 2; touch ${marker}) & sleep 30`, { timeoutMs: 500 });
    expect(r.code).toBe(124);
    expect(Date.now() - t0).toBeLessThan(5_000);
    await new Promise((res) => setTimeout(res, 2_500));
    await expect(fs.stat(marker)).rejects.toThrow();
    await rt.stopSession("s1");
  });

  it("stop when the turn is interrupted", async () => {
    const rt = await started();
    const ac = new AbortController();
    const p = rt.execShell("s1", "sleep 30", { timeoutMs: 60_000, signal: ac.signal });
    setTimeout(() => ac.abort(), 200);
    expect((await p).code).not.toBe(0);
    await rt.stopSession("s1");
  });

  it("pass argv as is, with input, and refuse a conversation that isn't started", async () => {
    const rt = await started();
    const r = await rt.exec("s1", ["sh", "-c", 'cat; printf "%s" "$1"', "sh", "a b; rm -rf /"], { input: "in:" });
    expect(r.stdout).toBe("in:a b; rm -rf /");
    expect(() => rt.exec("nope", ["true"])).toThrow(/aren't running/);
    await rt.stopSession("s1");
    expect(() => rt.exec("s1", ["true"])).toThrow(/aren't running/);
  });

  it("refuse a folder that doesn't exist on this machine", async () => {
    const rt = runtime();
    await rt.init();
    await expect(
      rt.startSession({ sessionId: "s2", personaId: "p", folders: [{ hostPath: "/no/such/folder", mountPath: "/no/such/folder", mode: "rw" }], skills: [], env: {}, proxyUrl: "", workdir: "/", cpus: 1, memory: "1g", pidsLimit: 1 }),
    ).rejects.toThrow(/doesn't exist/);
  });
});
