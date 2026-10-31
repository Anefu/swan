import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ServerProcess, rotateLog } from "./server.js";

let dir: string;
beforeEach(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), "swan-server-"));
});
afterEach(async () => {
  await fs.rm(dir, { recursive: true, force: true });
});

/** A stand-in server: `behaviour` decides what it does after starting. */
async function fakeServer(behaviour: string): Promise<ServerProcess> {
  const entry = path.join(dir, "server.mjs");
  await fs.writeFile(
    entry,
    `console.log("starting");
const mode = ${JSON.stringify(behaviour)};
const send = (m) => process.send(m);
if (mode === "ready") {
  send({ type: "ready", url: "http://127.0.0.1:1234/", port: 1234, proxyPort: 1235, home: "/h", version: "t" });
  process.on("SIGTERM", () => { console.log("stopping"); setTimeout(() => process.exit(0), 50); });
  process.on("disconnect", () => process.exit(0));
  setInterval(() => {}, 1000);
} else if (mode === "in-use") {
  send({ type: "home-in-use", home: "/h", url: "http://127.0.0.1:4317/", pid: 42 }, () => process.exit(3));
} else if (mode === "crash-early") {
  console.error("boom");
  process.exit(1);
} else if (mode === "stubborn") {
  send({ type: "ready", url: "http://127.0.0.1:1234/", port: 1234, proxyPort: 1235, home: "/h", version: "t" });
  process.on("SIGTERM", () => {});
  setInterval(() => {}, 1000);
} else if (mode === "silent") {
  setInterval(() => {}, 1000);
}
`,
  );
  return new ServerProcess({ node: process.execPath, entry, env: { PATH: process.env.PATH ?? "" }, logFile: path.join(dir, "logs", "server.log"), readyTimeoutMs: 2000 });
}

describe("ServerProcess", () => {
  it("resolves with ready, logs output, and stops on SIGTERM without reporting a crash", async () => {
    const s = await fakeServer("ready");
    let crashed = false;
    s.on("exit", () => (crashed = true));
    expect(await s.start()).toMatchObject({ type: "ready", port: 1234 });
    expect(s.running).toBe(true);
    await s.stop();
    expect(s.running).toBe(false);
    expect(crashed).toBe(false);
    const log = await fs.readFile(path.join(dir, "logs", "server.log"), "utf8");
    expect(log).toContain("starting");
    expect(log).toContain("stopping");
    expect((await fs.stat(path.join(dir, "logs", "server.log"))).mode & 0o777).toBe(0o600);
  });

  it("reports a crash after ready", async () => {
    const s = await fakeServer("ready");
    await s.start();
    const exit = new Promise((r) => s.on("exit", (code, signal) => r(signal ?? code)));
    process.kill((s as unknown as { child: { pid: number } }).child.pid, "SIGKILL");
    expect(await exit).toBe("SIGKILL");
  });

  it("passes on why the server will not start, and its exit is not a crash", async () => {
    const s = await fakeServer("in-use");
    let crashed = false;
    s.on("exit", () => (crashed = true));
    expect(await s.start()).toEqual({ type: "home-in-use", home: "/h", url: "http://127.0.0.1:4317/", pid: 42 });
    await new Promise((r) => setTimeout(r, 300));
    expect(crashed).toBe(false);
  });

  it("turns an exit before any message into a fatal one, with the output kept", async () => {
    const s = await fakeServer("crash-early");
    const msg = await s.start();
    expect(msg).toMatchObject({ type: "fatal" });
    expect((msg as { message: string }).message).toContain("exit code 1");
    expect(s.logTail()).toContain("boom");
  });

  it("gives up on a server that never reports", async () => {
    const s = await fakeServer("silent");
    expect(await s.start()).toMatchObject({ type: "fatal", message: expect.stringContaining("did not start") });
  });

  it("kills a server that ignores SIGTERM", async () => {
    const s = await fakeServer("stubborn");
    await s.start();
    const started = Date.now();
    await s.stop(300);
    expect(s.running).toBe(false);
    expect(Date.now() - started).toBeLessThan(3000);
  });
});

describe("rotateLog", () => {
  it("keeps one previous log once the current one is too large", async () => {
    const file = path.join(dir, "server.log");
    await fs.writeFile(file, "x".repeat(20));
    await rotateLog(file, 10);
    expect(await fs.readFile(`${file}.1`, "utf8")).toBe("x".repeat(20));
    await expect(fs.stat(file)).rejects.toThrow();
    await fs.writeFile(file, "small");
    await rotateLog(file, 10);
    expect(await fs.readFile(file, "utf8")).toBe("small");
  });
});
