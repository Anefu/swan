import type { ChildProcess } from "node:child_process";
import { EventEmitter } from "node:events";
import { promises as fs } from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { PassThrough } from "node:stream";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  type ExecFn,
  SshTunnel,
  backoffDelay,
  freePort,
  loadChoice,
  parseRemote,
  readRemoteToken,
  saveChoice,
  sshProblem,
  tokenArgs,
  tunnelArgs,
  validToken,
  waitForServer,
} from "./remote.js";
import { connectPage, readConnectUrl } from "./remote-page.js";

const R = { host: "coder.myworkspace", port: 4317, home: "~/.swan" };
const TOKEN = "a".repeat(48);

describe("parseRemote", () => {
  it("fills in the defaults and trims", () => {
    expect(parseRemote({ host: " coder.ws ", port: "", home: "" })).toEqual({ remote: { host: "coder.ws", port: 4317, home: "~/.swan" } });
    expect(parseRemote({ host: "me@box-1", port: "4517", home: "/srv/swan/" })).toEqual({ remote: { host: "me@box-1", port: 4517, home: "/srv/swan" } });
  });

  it("refuses hosts that ssh would read as options, and homes the remote shell would interpret", () => {
    for (const host of ["", "-oProxyCommand=touch /tmp/x", "a b", "host;rm", "$(id)", "a\nb"]) expect(parseRemote({ host })).toHaveProperty("error");
    for (const port of ["0", "65536", "12.5", "1e3", "x"]) expect(parseRemote({ host: "h", port })).toHaveProperty("error");
    for (const home of ["~/a b", "~/$(id)", "~/x;rm -rf ~", "`id`", "rel/path", "~other/.swan", "~/a'b"]) expect(parseRemote({ host: "h", home })).toHaveProperty("error");
  });
});

describe("ssh argv", () => {
  it("forwards a loopback port to the remote's loopback, without prompting or sharing a connection", () => {
    const a = tunnelArgs(R, 51234);
    expect(a[0]).toBe("-N");
    expect(a.at(-1)).toBe("coder.myworkspace");
    expect(a.join(" ")).toContain("-L 127.0.0.1:51234:127.0.0.1:4317");
    for (const o of ["BatchMode=yes", "ExitOnForwardFailure=yes", "ServerAliveInterval=15", "ServerAliveCountMax=3", "ControlPath=none"]) {
      expect(a[a.indexOf(o) - 1]).toBe("-o");
    }
  });

  it("reads the token with cat, the host as its own argument", () => {
    const a = tokenArgs(R);
    expect(a.slice(-2)).toEqual(["coder.myworkspace", "cat ~/.swan/api-token"]);
    expect(a).toContain("BatchMode=yes");
  });
});

describe("tokens", () => {
  it("accepts what the server writes and nothing else", () => {
    expect(validToken(`${"0f".repeat(24)}\n`)).toBe("0f".repeat(24));
    for (const t of ["", "short", "a".repeat(31), `${"a".repeat(40)} x`, `<html>${"a".repeat(40)}`]) expect(validToken(t)).toBeNull();
  });

  it("reads it over ssh and explains failures without the token in them", async () => {
    const run = (r: Awaited<ReturnType<ExecFn>>): ExecFn => async () => r;
    expect(await readRemoteToken(R, "ssh", run({ code: 0, stdout: `${TOKEN}\n`, stderr: "" }))).toEqual({ token: TOKEN });
    expect(await readRemoteToken(R, "ssh", run({ code: 1, stdout: "", stderr: "cat: /home/me/.swan/api-token: No such file or directory" }))).toMatchObject({
      error: expect.stringContaining("swan-server"),
    });
    expect(await readRemoteToken(R, "ssh", run({ code: 255, stdout: "", stderr: "ssh: Could not resolve hostname coder.myworkspace" }))).toMatchObject({
      error: expect.stringContaining("coder config-ssh"),
    });
    expect(await readRemoteToken(R, "ssh", run({ code: 255, stdout: "", stderr: "me@h: Permission denied (publickey)." }))).toMatchObject({
      error: expect.stringContaining("refused the SSH login"),
    });
    expect(await readRemoteToken(R, "ssh", run({ code: "ENOENT", stdout: "", stderr: "" }))).toMatchObject({ error: expect.stringContaining("ssh") });
    const bad = await readRemoteToken(R, "ssh", run({ code: 0, stdout: "not a token at all", stderr: "" }));
    expect(bad).toMatchObject({ error: expect.stringContaining("doesn't hold") });
    expect(JSON.stringify(bad)).not.toContain("not a token");
  });

  it("names the usual ssh failures", () => {
    expect(sshProblem("channel 2: open failed: connect failed: Connection refused", "h")).toBe("Swan isn't running on h: start it with `swan-server`.");
    expect(sshProblem("Host key verification failed.", "h")).toContain("host key");
    expect(sshProblem("ssh: connect to host h port 22: Operation timed out", "h")).toContain("Can't reach h");
  });
});

describe("server choice", () => {
  it("round-trips, and falls back to this Mac for anything unreadable", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "swan-remote-"));
    const file = path.join(dir, "server.json");
    expect(await loadChoice(file)).toEqual({ use: "local" });
    await saveChoice(file, { use: "remote", remote: R });
    expect(await loadChoice(file)).toEqual({ use: "remote", remote: R });
    await fs.writeFile(file, JSON.stringify({ use: "remote", remote: { host: "-oProxyCommand=x" } }));
    expect(await loadChoice(file)).toEqual({ use: "local" });
    await fs.writeFile(file, "{");
    expect(await loadChoice(file)).toEqual({ use: "local" });
    await fs.rm(dir, { recursive: true });
  });
});

/** A stand-in ssh child: exits when killed or when the test says so. */
class FakeSsh extends EventEmitter {
  stderr = new PassThrough();
  killed = false;
  kill() {
    this.killed = true;
    setImmediate(() => this.emit("exit", null, "SIGTERM"));
    return true;
  }
  die(message = "") {
    if (message) this.stderr.write(message);
    setImmediate(() => this.emit("exit", 255, null));
  }
}

function fakeSpawner() {
  const children: FakeSsh[] = [];
  const calls: string[][] = [];
  const spawn = (_cmd: string, args: string[]) => {
    calls.push(args);
    const c = new FakeSsh();
    children.push(c);
    return c as unknown as ChildProcess;
  };
  return { children, calls, spawn };
}

const tick = () => new Promise((r) => setImmediate(r));

describe("SshTunnel", () => {
  afterEach(() => vi.useRealTimers());

  it("backs off 1, 2, 4 … 30 s", () => {
    expect([0, 1, 2, 3, 4, 5, 6, 20].map(backoffDelay)).toEqual([1000, 2000, 4000, 8000, 16000, 30000, 30000, 30000]);
  });

  it("restarts ssh with backoff and the same arguments (so the same local port) after it exits", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
    const f = fakeSpawner();
    const t = new SshTunnel({ args: tunnelArgs(R, 50001), spawn: f.spawn, stableMs: 60_000 });
    const exits: string[] = [];
    t.on("exit", (e) => exits.push(e));
    t.start();
    expect(f.children).toHaveLength(1);

    f.children[0]!.die("Connection reset by peer\n");
    await tick();
    await tick();
    expect(exits).toEqual(["Connection reset by peer\n"]);
    expect(t.running).toBe(false);
    await vi.advanceTimersByTimeAsync(999);
    expect(f.children).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(f.children).toHaveLength(2);

    f.children[1]!.die();
    await tick();
    await vi.advanceTimersByTimeAsync(1999);
    expect(f.children).toHaveLength(2);
    await vi.advanceTimersByTimeAsync(1);
    expect(f.children).toHaveLength(3);
    expect(new Set(f.calls.map((a) => a.join(" "))).size).toBe(1);
    t.stop();
  });

  it("starts the backoff over once a tunnel stayed up", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
    const f = fakeSpawner();
    const t = new SshTunnel({ args: ["x"], spawn: f.spawn, stableMs: 10_000 });
    t.start();
    f.children[0]!.die();
    await tick();
    await vi.advanceTimersByTimeAsync(1000); // second ssh
    f.children[1]!.die();
    await tick();
    await vi.advanceTimersByTimeAsync(2000); // third ssh, after 2 s
    expect(f.children).toHaveLength(3);
    await vi.advanceTimersByTimeAsync(60_000); // stays up a minute
    f.children[2]!.die();
    await tick();
    await vi.advanceTimersByTimeAsync(1000); // back to 1 s
    expect(f.children).toHaveLength(4);
    t.stop();
  });

  it("reconnects at once on wake, whether waiting or connected", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
    const f = fakeSpawner();
    const t = new SshTunnel({ args: ["x"], spawn: f.spawn });
    t.start();
    t.wake(); // connected: kill it and start a new one straight away
    expect(f.children[0]!.killed).toBe(true);
    await tick();
    expect(f.children).toHaveLength(2);
    f.children[1]!.die();
    await tick();
    expect(f.children).toHaveLength(2); // waiting 1 s
    t.wake();
    expect(f.children).toHaveLength(3);
    t.stop();
  });

  it("stops for good: kills ssh and schedules nothing", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
    const f = fakeSpawner();
    const t = new SshTunnel({ args: ["x"], spawn: f.spawn });
    t.start();
    t.stop();
    expect(f.children[0]!.killed).toBe(true);
    await tick();
    await vi.advanceTimersByTimeAsync(120_000);
    expect(f.children).toHaveLength(1);
    expect(t.running).toBe(false);
  });

  it("treats an ssh that cannot be started like one that exited", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
    const f = fakeSpawner();
    const t = new SshTunnel({ args: ["x"], spawn: f.spawn });
    t.start();
    f.children[0]!.emit("error", new Error("spawn ssh ENOENT"));
    f.children[0]!.emit("exit", -2, null);
    expect(t.exits).toBe(1);
    expect(t.stderr).toContain("ENOENT");
    t.stop();
  });
});

describe("waitForServer", () => {
  let srv: http.Server | null = null;
  afterEach(() => new Promise<void>((r) => (srv ? srv.close(() => r()) : r())));

  async function serve(status: number): Promise<string> {
    srv = http.createServer((req, res) => {
      res.statusCode = req.headers["x-ph-token"] === TOKEN ? status : 401;
      res.end();
    });
    await new Promise<void>((r) => srv!.listen(0, "127.0.0.1", r));
    return `http://127.0.0.1:${(srv.address() as { port: number }).port}`;
  }

  it("resolves once the API answers through the tunnel", async () => {
    const f = fakeSpawner();
    const t = new SshTunnel({ args: ["x"], spawn: f.spawn });
    t.start();
    expect(await waitForServer({ origin: await serve(200), token: TOKEN, tunnel: t, host: "h" })).toBeNull();
    t.stop();
  });

  it("says when the token belongs to another Swan", async () => {
    const f = fakeSpawner();
    const t = new SshTunnel({ args: ["x"], spawn: f.spawn });
    t.start();
    expect(await waitForServer({ origin: await serve(200), token: "b".repeat(48), tunnel: t, host: "h" })).toMatchObject({ error: expect.stringContaining("token") });
    t.stop();
  });

  it("reports ssh giving up, and a remote with nothing on the port", async () => {
    const port = await freePort(); // nothing listens here
    const f = fakeSpawner();
    const t = new SshTunnel({ args: ["x"], spawn: f.spawn, delay: () => 60_000 });
    t.start();
    f.children[0]!.die("me@h: Permission denied (publickey).\n");
    expect(await waitForServer({ origin: `http://127.0.0.1:${port}`, token: TOKEN, tunnel: t, host: "h", intervalMs: 10 })).toMatchObject({
      error: expect.stringContaining("refused the SSH login"),
    });
    t.stop();

    const t2 = new SshTunnel({ args: ["x"], spawn: f.spawn });
    t2.start();
    f.children.at(-1)!.stderr.write("channel 2: open failed: connect failed: Connection refused\n");
    expect(await waitForServer({ origin: `http://127.0.0.1:${port}`, token: TOKEN, tunnel: t2, host: "h", intervalMs: 10 })).toMatchObject({
      error: "Swan isn't running on h: start it with `swan-server`.",
    });
    t2.stop();
  });
});

describe("connect form", () => {
  it("reads what was submitted, and only from its own URL", () => {
    expect(readConnectUrl("swan://connect/?host=coder.ws&port=4317&home=%7E%2F.swan&use=remote")).toEqual({
      use: "remote",
      remote: { host: "coder.ws", port: 4317, home: "~/.swan" },
    });
    expect(readConnectUrl("swan://connect/?host=&use=local")).toEqual({ use: "local" });
    expect(readConnectUrl("swan://connect/?use=cancel")).toEqual({ use: "cancel" });
    expect(readConnectUrl("swan://connect/?host=-oProxyCommand%3Dx&use=remote")).toMatchObject({ use: "invalid", error: expect.stringContaining("SSH host") });
    expect(readConnectUrl("swan://app/?use=remote&host=h")).toBeNull();
  });

  it("escapes what it shows and runs no script", () => {
    const html = connectPage({ use: "local" }, `<img src=x onerror=alert(1)>`, { host: `"><script>x</script>`, port: "1", home: "~" });
    expect(html).not.toContain("<script>");
    expect(html).not.toContain("<img");
    expect(html).toContain("default-src 'none'");
    expect(html.indexOf('value="remote"')).toBeLessThan(html.indexOf('value="local"')); // Enter connects
  });
});
