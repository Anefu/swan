import { spawn } from "node:child_process";
import type { DeviceCode } from "@ph/shared";
import { expandHome } from "../util.js";
import { WrapperLine, type ResultLine } from "./config.js";

export type Verb = "status" | "login" | "renew";

export interface RunOptions {
  connection: string;
  command: string[];
  verb: Verb;
  cwd: string;
  env: NodeJS.ProcessEnv;
  timeoutMs: number;
  onDeviceCode?: (code: DeviceCode) => void;
  signal?: AbortSignal;
}

export interface RunOutcome {
  result: ResultLine; // an `error` result when the wrapper failed in any way
  stderr: string; // not yet redacted
  exitCode: number | null;
}

const MAX_STDOUT = 1_000_000;
const MAX_STDERR = 64_000;

/**
 * Run a connection wrapper once: argv without a shell, the verb appended, `{"protocol":1,...}` on
 * stdin, JSON Lines on stdout. Never throws; every failure comes back as an `error` result.
 */
export function runWrapper(o: RunOptions): Promise<RunOutcome> {
  return new Promise((resolve) => {
    const [bin, ...args] = o.command;
    let stdout = "";
    let stdoutBytes = 0;
    let stderr = "";
    let result: ResultLine | null = null;
    let problem: string | null = null;
    let settled = false;
    let lineNo = 0;

    const child = spawn(expandHome(bin), [...args, o.verb], { cwd: o.cwd, env: o.env, stdio: ["pipe", "pipe", "pipe"], shell: false });
    const fail = (msg: string) => {
      problem ??= msg;
      child.kill("SIGTERM");
      setTimeout(() => child.kill("SIGKILL"), 3000).unref();
    };
    const timer = setTimeout(() => fail(`timed out after ${Math.round(o.timeoutMs / 1000)}s`), o.timeoutMs);
    const onAbort = () => fail("cancelled");
    o.signal?.addEventListener("abort", onAbort, { once: true });

    const handleLine = (line: string) => {
      lineNo++;
      if (!line.trim()) return;
      let json: unknown;
      try {
        json = JSON.parse(line);
      } catch {
        return fail(`output line ${lineNo} is not JSON`);
      }
      const parsed = WrapperLine.safeParse(json);
      if (!parsed.success) {
        const i = parsed.error.issues[0];
        return fail(`output line ${lineNo} does not match protocol v1: ${i?.path.join(".") || "(line)"}: ${i?.message}`);
      }
      const v = parsed.data;
      if (v.type === "device_code") {
        if (o.verb !== "login") return fail("device_code is only valid during login");
        if (result) return fail("device_code after the result");
        o.onDeviceCode?.({ verificationUri: v.verificationUri, userCode: v.userCode, verificationUriComplete: v.verificationUriComplete, expiresAt: v.expiresAt });
      } else {
        if (result) return fail("more than one result line");
        result = v;
      }
    };

    child.stdout.on("data", (d: Buffer) => {
      stdoutBytes += d.length;
      if (stdoutBytes > MAX_STDOUT) return fail("output is larger than 1 MB");
      stdout += d.toString("utf8");
      let i: number;
      while ((i = stdout.indexOf("\n")) !== -1) {
        const line = stdout.slice(0, i);
        stdout = stdout.slice(i + 1);
        handleLine(line);
      }
    });
    child.stderr.on("data", (d: Buffer) => {
      stderr = (stderr + d.toString("utf8")).slice(-MAX_STDERR);
    });
    child.stdin.on("error", () => {});
    child.stdin.end(JSON.stringify({ protocol: 1, connection: o.connection }));

    const finish = (code: number | null, spawnError?: Error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      o.signal?.removeEventListener("abort", onAbort);
      if (stdout.trim() && !problem) handleLine(stdout);
      const error = (message: string): ResultLine => ({ type: "result", state: "error", message });
      let out: ResultLine;
      if (spawnError) out = error(`could not run ${bin}: ${spawnError.message}`);
      else if (problem) out = error(`wrapper ${problem}`);
      else if (!result) out = error(`wrapper exited with code ${code} without a result`);
      else if (code !== 0) out = error((result as ResultLine).message ?? `wrapper exited with code ${code}`);
      else out = result;
      resolve({ result: out, stderr, exitCode: code });
    };
    child.on("error", (e) => finish(null, e));
    child.on("close", (code) => finish(code));
  });
}
