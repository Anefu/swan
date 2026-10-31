import { type ChildProcess, spawn } from "node:child_process";
import { EventEmitter } from "node:events";
import { createWriteStream, promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import type { LauncherMessage } from "@ph/shared";

export interface ServerOptions {
  node: string; // the Node binary that runs the server
  entry: string; // the bundled server
  env: Record<string, string>;
  logFile: string;
  readyTimeoutMs?: number;
}

const LOG_ROTATE_BYTES = 10 * 1024 * 1024;
const TAIL_LINES = 40;

/** Keep the previous log once it grows past the limit, so the folder never fills up. */
export async function rotateLog(file: string, maxBytes = LOG_ROTATE_BYTES): Promise<void> {
  await fs.mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
  const st = await fs.stat(file).catch(() => null);
  if (st && st.size > maxBytes) await fs.rename(file, `${file}.1`);
}

function isLauncherMessage(m: unknown): m is LauncherMessage {
  const t = (m as { type?: unknown } | null)?.type;
  return t === "ready" || t === "home-in-use" || t === "fatal";
}

/**
 * The Swan server as a child process with an IPC channel. It reports ready (or why it cannot
 * start) over the channel, and shuts itself down if the channel closes, so it never outlives the app.
 */
export class ServerProcess extends EventEmitter<{ exit: [code: number | null, signal: NodeJS.Signals | null] }> {
  private child: ChildProcess | null = null;
  private stopping = false;
  private tail: string[] = [];

  constructor(private opts: ServerOptions) {
    super();
  }

  get running(): boolean {
    return this.child !== null;
  }

  /** The last lines the server printed, for error messages. */
  logTail(): string {
    return this.tail.join("\n");
  }

  /** Resolves with the server's first message, or a fatal one when it exits or stalls before sending one. */
  async start(): Promise<LauncherMessage> {
    if (this.child) throw new Error("the server is already running");
    await rotateLog(this.opts.logFile);
    const log = createWriteStream(this.opts.logFile, { flags: "a", mode: 0o600 });
    log.write(`\n--- ${new Date().toISOString()} starting Swan server ---\n`);
    this.stopping = false;
    this.tail = [];
    const child = spawn(this.opts.node, [this.opts.entry], {
      env: this.opts.env,
      cwd: os.homedir(),
      stdio: ["ignore", "pipe", "pipe", "ipc"],
    });
    this.child = child;
    const capture = (chunk: Buffer) => {
      log.write(chunk);
      this.tail.push(...chunk.toString("utf8").split("\n").filter(Boolean));
      this.tail.splice(0, Math.max(0, this.tail.length - TAIL_LINES));
    };
    child.stdout?.on("data", capture);
    child.stderr?.on("data", capture);

    return new Promise<LauncherMessage>((resolve) => {
      let settled = false;
      const settle = (m: LauncherMessage) => {
        if (settled) return;
        settled = true;
        if (m.type !== "ready") this.stopping = true; // it exits after saying why; that is not a crash
        clearTimeout(timer);
        resolve(m);
      };
      const timeoutMs = this.opts.readyTimeoutMs ?? 60_000;
      const timer = setTimeout(() => {
        settle({ type: "fatal", message: `The server did not start within ${timeoutMs / 1000} s.` });
        child.kill("SIGKILL");
      }, timeoutMs);
      child.on("message", (m) => {
        if (isLauncherMessage(m)) settle(m);
      });
      child.on("error", (e) => settle({ type: "fatal", message: `Could not start the server: ${e.message}` }));
      child.on("close", () => log.end()); // after stdout and stderr have drained
      child.on("exit", (code, signal) => {
        this.child = null;
        if (!settled) settle({ type: "fatal", message: `The server stopped before it was ready (${signal ?? `exit code ${code}`}).` });
        else if (!this.stopping) this.emit("exit", code, signal);
      });
    });
  }

  /** SIGTERM lets the server stop its session containers; SIGKILL if it takes longer than the limit. */
  async stop(timeoutMs = 20_000): Promise<void> {
    const child = this.child;
    if (!child) return;
    this.stopping = true;
    const exited = new Promise<void>((resolve) => child.once("exit", () => resolve()));
    child.kill("SIGTERM");
    const timer = setTimeout(() => child.kill("SIGKILL"), timeoutMs);
    await exited;
    clearTimeout(timer);
  }
}
