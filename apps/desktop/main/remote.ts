import { type ChildProcess, execFile, spawn } from "node:child_process";
import { EventEmitter } from "node:events";
import { promises as fs } from "node:fs";
import net from "node:net";

/** A Swan server on another machine, reached with the system `ssh`. */
export interface RemoteServer {
  host: string; // an ssh destination or ~/.ssh/config alias (coder.myworkspace)
  port: number; // where that server listens on the remote's 127.0.0.1
  home: string; // its PH_HOME, for the API token
}

/** Which server the app uses; kept in the app's own settings, not in the server's config. */
export interface ServerChoice {
  use: "local" | "remote";
  remote?: RemoteServer; // also kept while on this Mac, to fill in the form next time
}

export const DEFAULT_REMOTE = { port: 4317, home: "~/.swan" } as const;

// The host and home end up on ssh's command line and in the remote shell: no option-looking
// host, nothing the remote shell would interpret in the home.
const HOST_RE = /^[A-Za-z0-9_][A-Za-z0-9_.@-]{0,252}$/;
const HOME_RE = /^(~|~\/[A-Za-z0-9._/-]*|\/[A-Za-z0-9._/-]*)$/;
const TOKEN_RE = /^[A-Za-z0-9_-]{32,256}$/;

/** A validated remote server, or what is wrong with the input. */
export function parseRemote(input: { host?: unknown; port?: unknown; home?: unknown }): { remote: RemoteServer } | { error: string } {
  const host = typeof input.host === "string" ? input.host.trim() : "";
  if (!HOST_RE.test(host)) return { error: "Enter an SSH host, such as coder.myworkspace or user@server." };
  const rawPort = typeof input.port === "number" ? String(input.port) : typeof input.port === "string" ? input.port.trim() : "";
  const port = rawPort === "" ? DEFAULT_REMOTE.port : Number(rawPort);
  if ((rawPort !== "" && !/^\d+$/.test(rawPort)) || port < 1 || port > 65535) return { error: "The port must be a number from 1 to 65535." };
  let home = typeof input.home === "string" ? input.home.trim() : "";
  if (home === "") home = DEFAULT_REMOTE.home;
  if (home.length > 1) home = home.replace(/\/+$/, "");
  if (!HOME_RE.test(home)) return { error: "Swan's home must be a path such as ~/.swan, with letters, digits, . _ - and / only." };
  return { remote: { host, port, home } };
}

export async function loadChoice(file: string): Promise<ServerChoice> {
  try {
    const raw = JSON.parse(await fs.readFile(file, "utf8")) as { use?: unknown; remote?: Record<string, unknown> };
    const parsed = raw.remote ? parseRemote(raw.remote) : null;
    const remote = parsed && "remote" in parsed ? parsed.remote : undefined;
    return { use: raw.use === "remote" && remote ? "remote" : "local", ...(remote ? { remote } : {}) };
  } catch {
    return { use: "local" };
  }
}

export async function saveChoice(file: string, choice: ServerChoice): Promise<void> {
  await fs.writeFile(file, JSON.stringify(choice, null, 2), { mode: 0o600 });
}

// Never ask for a password or a host key (there is no terminal), and give up on a dead host.
// No connection sharing: a forward made through a ControlMaster outlives the ssh we started.
const SSH_OPTIONS = ["-o", "BatchMode=yes", "-o", "ConnectTimeout=15", "-o", "ControlMaster=no", "-o", "ControlPath=none"];

export function tunnelArgs(r: RemoteServer, localPort: number): string[] {
  return [
    "-N",
    ...SSH_OPTIONS,
    "-o", "ExitOnForwardFailure=yes",
    "-o", "ServerAliveInterval=15",
    "-o", "ServerAliveCountMax=3",
    "-L", `127.0.0.1:${localPort}:127.0.0.1:${r.port}`,
    r.host,
  ]; // prettier-ignore
}

/** `home` is checked by parseRemote, so the remote shell only expands its leading ~. */
export function tokenArgs(r: RemoteServer): string[] {
  return [...SSH_OPTIONS, r.host, `cat ${r.home}/api-token`];
}

export function validToken(text: string): string | null {
  const t = text.trim();
  return TOKEN_RE.test(t) ? t : null;
}

export const notRunning = (host: string) => `Swan isn't running on ${host}: start it with \`swan-server\`.`;

/** What ssh's stderr means, in words the user can act on. */
export function sshProblem(stderr: string, host: string): string {
  const s = stderr;
  if (/Could not resolve hostname|nodename nor servname|Name or service not known/i.test(s))
    return `Can't find ${host}. Check the name (for Coder, run \`coder config-ssh\` first).`;
  if (/Host key verification failed|REMOTE HOST IDENTIFICATION HAS CHANGED/i.test(s))
    return `${host}'s host key isn't known or has changed. Run \`ssh ${host}\` in Terminal once to check it.`;
  if (/Permission denied|Too many authentication failures|no such identity/i.test(s))
    return `${host} refused the SSH login. Check that \`ssh ${host}\` works in Terminal without a password prompt.`;
  if (/open failed|connect failed/i.test(s)) return notRunning(host);
  if (/Address already in use|cannot listen to port|forwarding failed/i.test(s)) return "Couldn't open the local end of the tunnel. Try again.";
  if (/Connection refused|timed out|No route to host|Network is unreachable|Connection closed|Connection reset/i.test(s))
    return `Can't reach ${host} over SSH. Check the network, and that the workspace is started.`;
  return `ssh ${host} failed.`;
}

/** The last lines of ssh's output, to show under the explanation. */
export const stderrTail = (s: string) => s.trim().split("\n").slice(-6).join("\n");

type ExecResult = { code: number | string | null; stdout: string; stderr: string };
export type ExecFn = (cmd: string, args: string[]) => Promise<ExecResult>;

const execSsh: ExecFn = (cmd, args) =>
  new Promise((resolve) => {
    execFile(cmd, args, { timeout: 45_000, maxBuffer: 64 * 1024, encoding: "utf8" }, (err, stdout, stderr) => {
      const e = err as (NodeJS.ErrnoException & { code?: number | string }) | null;
      resolve({ code: e ? (e.code ?? "killed") : 0, stdout, stderr: stderr || (e && !stderr ? e.message : "") });
    });
  });

/** The remote server's API token, read with a separate ssh. Never logged. */
export async function readRemoteToken(r: RemoteServer, ssh = "ssh", exec: ExecFn = execSsh): Promise<{ token: string } | { error: string; detail: string }> {
  const res = await exec(ssh, tokenArgs(r));
  if (res.code === "ENOENT") return { error: "Couldn't run ssh: it isn't installed or isn't on the PATH.", detail: "" };
  if (res.code === 255 || res.code === "killed" || res.code === "ETIMEDOUT") return { error: sshProblem(res.stderr, r.host), detail: stderrTail(res.stderr) };
  if (res.code !== 0)
    return /No such file/i.test(res.stderr)
      ? { error: `No Swan at ${r.home} on ${r.host}: start it with \`swan-server\` (or set Swan's home if it uses another folder).`, detail: stderrTail(res.stderr) }
      : { error: `Couldn't read ${r.home}/api-token on ${r.host}.`, detail: stderrTail(res.stderr) };
  const token = validToken(res.stdout);
  return token ? { token } : { error: `${r.home}/api-token on ${r.host} doesn't hold a Swan API token.`, detail: "" };
}

/** A free port on this Mac's loopback, kept for the tunnel's lifetime so reconnects reuse it. */
export function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.once("error", reject);
    srv.listen(0, "127.0.0.1", () => {
      const port = (srv.address() as net.AddressInfo).port;
      srv.close(() => resolve(port));
    });
  });
}

/** 1 s, 2 s, 4 s … up to 30 s between attempts. */
export const backoffDelay = (attempt: number) => Math.min(30_000, 1000 * 2 ** Math.min(attempt, 15));

export type SpawnFn = (cmd: string, args: string[]) => ChildProcess;
const spawnSsh: SpawnFn = (cmd, args) => spawn(cmd, args, { stdio: ["ignore", "ignore", "pipe"] });

export interface TunnelOptions {
  ssh?: string;
  args: string[];
  spawn?: SpawnFn;
  /** A tunnel that stayed up this long starts the backoff over when it drops. */
  stableMs?: number;
  delay?: (attempt: number) => number;
}

/**
 * `ssh -N -L …` kept alive: when it exits (sleep, a network change, the workspace restarting) it
 * is started again with backoff, on the same local port, so the UI's WebSocket reconnects to it.
 */
export class SshTunnel extends EventEmitter<{ exit: [stderr: string]; spawn: [] }> {
  private child: ChildProcess | null = null;
  private timer: NodeJS.Timeout | null = null;
  private attempt = 0;
  private stopped = true;
  private restartNow = false;
  private startedAt = 0;
  private err = "";
  /** How many times ssh has exited since start(). */
  exits = 0;

  constructor(private opts: TunnelOptions) {
    super();
  }

  get running(): boolean {
    return this.child !== null;
  }

  /** What the current (or last) ssh printed. */
  get stderr(): string {
    return this.err;
  }

  start(): void {
    this.stopped = false;
    this.exits = 0;
    this.attempt = 0;
    if (!this.child) this.spawnNow();
  }

  /** The Mac woke up: the old connection is probably dead, so reconnect now rather than after the keepalives fail. */
  wake(): void {
    if (this.stopped) return;
    this.attempt = 0;
    if (this.child) {
      this.restartNow = true;
      this.child.kill("SIGTERM");
    } else this.spawnNow();
  }

  stop(): void {
    this.stopped = true;
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    this.child?.kill("SIGTERM");
  }

  private spawnNow() {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    this.err = "";
    this.startedAt = Date.now();
    const child = (this.opts.spawn ?? spawnSsh)(this.opts.ssh ?? "ssh", this.opts.args);
    this.child = child;
    child.stderr?.on("data", (c: Buffer) => {
      this.err = (this.err + c.toString("utf8")).slice(-8000);
    });
    // A spawn failure emits "error" and maybe "exit": handle whichever comes first, once.
    child.once("error", (e) => {
      this.err += `${e.message}\n`;
      this.gone(child);
    });
    child.once("exit", () => this.gone(child));
    this.emit("spawn");
  }

  private gone(child: ChildProcess) {
    if (this.child !== child) return;
    this.child = null;
    this.exits++;
    if (Date.now() - this.startedAt >= (this.opts.stableMs ?? 30_000)) this.attempt = 0;
    this.emit("exit", this.err);
    if (this.stopped) return;
    if (this.restartNow) {
      this.restartNow = false;
      return this.spawnNow();
    }
    const delay = (this.opts.delay ?? backoffDelay)(this.attempt++);
    this.timer = setTimeout(() => this.spawnNow(), delay);
  }
}

/**
 * Wait until the server answers through the tunnel. null when it does, or what went wrong: ssh
 * gave up, the remote has nothing on that port, or the token belongs to another Swan.
 */
export async function waitForServer(o: {
  origin: string;
  token: string;
  tunnel: SshTunnel;
  host: string;
  timeoutMs?: number;
  intervalMs?: number;
}): Promise<{ error: string; detail: string } | null> {
  const deadline = Date.now() + (o.timeoutMs ?? 30_000);
  const exitsBefore = o.tunnel.exits;
  for (;;) {
    if (o.tunnel.exits > exitsBefore) return { error: sshProblem(o.tunnel.stderr, o.host), detail: stderrTail(o.tunnel.stderr) };
    if (/open failed|connect failed/i.test(o.tunnel.stderr)) return { error: notRunning(o.host), detail: stderrTail(o.tunnel.stderr) };
    const status = await fetch(`${o.origin}/api/runtime`, { headers: { "x-ph-token": o.token }, signal: AbortSignal.timeout(5000) }).then(
      (r) => r.status,
      () => 0,
    );
    if (status === 200) return null;
    if (status === 401) return { error: `The Swan on ${o.host} uses a different token: check Swan's home.`, detail: "" };
    if (Date.now() > deadline) return { error: notRunning(o.host), detail: stderrTail(o.tunnel.stderr) };
    await new Promise((r) => setTimeout(r, o.intervalMs ?? 300));
  }
}
