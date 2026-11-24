import { spawn } from "node:child_process";
import { promises as fs } from "node:fs";
import path from "node:path";
import type { RuntimeStatus } from "@ph/shared";
import type { CertAuthority } from "../proxy/ca.js";
import { paths, type Settings } from "../settings.js";
import { TypedEmitter, errMsg, log } from "../util.js";
import { agentHome } from "./layout.js";
import type { RunResult, SessionContainerSpec } from "./podman.js";
import type { ExecOpts, SandboxRuntime, ShellOpts } from "./runtime.js";

/** Variables from Swan's own environment that commands get as well. */
const PASS_ALWAYS = ["PATH", "HOME", "USER", "LOGNAME", "SHELL", "LANG", "TERM", "TZ", "TMPDIR"];
/** Never passed on, whatever passEnv says: Swan's environment may hold the workspace's own tokens. */
const SECRET_NAME = /TOKEN|SECRET|PASSWORD|PASSWD|CREDENTIAL|API_?KEY|PRIVATE|_KEY$|^AWS_|^GITHUB_|^GH_|^COPILOT_|^ANTHROPIC_|^OPENAI_/i;

/** CA bundles of common Linux distributions, to which Swan adds its own CA for commands. */
const SYSTEM_BUNDLES = ["/etc/ssl/certs/ca-certificates.crt", "/etc/pki/tls/certs/ca-bundle.crt", "/etc/ssl/ca-bundle.pem", "/etc/ssl/cert.pem"];

type Running = { env: Record<string, string>; workdir: string; procs: Set<number> };

/** Variables of `from` that commands may see: the always-passed ones, LC_*, and passEnv, none named like a secret. */
export function passedEnv(from: NodeJS.ProcessEnv, passEnv: string[]): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(from)) {
    if (v === undefined || SECRET_NAME.test(k)) continue;
    if (PASS_ALWAYS.includes(k) || k.startsWith("LC_") || passEnv.includes(k)) out[k] = v;
  }
  return out;
}

/**
 * `runtime.type: workspace`: commands run directly on this machine, for a cloud workspace that is
 * already the sandbox (its own network rules and credentials). Swan keeps everything else: commands
 * go out through Swan's proxy (website approvals, connections, swan-tool), which forwards to
 * config.yaml's `proxy`, and each conversation gets a home of its own under PH_HOME.
 *
 * Nothing here stops a command from ignoring HTTPS_PROXY or reading Swan's files: the workspace's
 * own network policy and the absence of secrets in Swan are the boundary.
 */
export class WorkspaceRuntime extends TypedEmitter<{ status: [RuntimeStatus] }> implements SandboxRuntime {
  status: RuntimeStatus;
  private sessions = new Map<string, Running>();
  private bundle: string | null = null;

  constructor(
    private settings: Settings,
    private ca: CertAuthority,
    private extraCas: string[] = [],
    private shell = "bash",
  ) {
    super();
    this.status = {
      runtime: "workspace",
      available: false,
      version: null,
      imageReady: true,
      imageTag: null,
      networkReady: true,
      relayRunning: true,
      proxyPort: settings.proxyPort,
      busy: "checking the workspace",
      errors: [],
      needs: null,
    };
  }

  private update(patch: Partial<RuntimeStatus>) {
    this.status = { ...this.status, ...patch };
    this.emit("status", this.status);
  }

  async init(): Promise<void> {
    const r = await this.run([this.shell, "-c", "echo $BASH_VERSION"], { timeoutMs: 15_000 });
    const errors = r.code === 0 ? [] : [`Commands need ${this.shell} on this machine: ${r.stderr.trim() || `exit ${r.code}`}`];
    try {
      this.bundle = await this.writeBundle();
    } catch (e) {
      errors.push(`Could not write the certificate bundle for commands: ${errMsg(e)}`);
    }
    this.update({ available: !errors.length, version: r.stdout.trim() || null, proxyPort: this.settings.proxyPort, busy: null, errors });
  }

  /** The system's CAs plus Swan's (and config.yaml's caFiles), so commands trust Swan's proxy. */
  private async writeBundle(): Promise<string> {
    let system = "";
    for (const f of SYSTEM_BUNDLES) {
      system = await fs.readFile(f, "utf8").catch(() => "");
      if (system) break;
    }
    if (!system) log.warn("runtime", "no system CA bundle found; commands will trust only Swan's CA");
    const file = path.join(paths.home, "ca-bundle.pem");
    await fs.mkdir(paths.home, { recursive: true, mode: 0o700 });
    await fs.writeFile(file, [system.trim(), this.ca.certPem.trim(), ...this.extraCas.map((c) => c.trim())].filter(Boolean).join("\n") + "\n", { mode: 0o644 });
    return file;
  }

  async setupMachine(): Promise<void> {}

  async rebuild(): Promise<void> {
    await this.init();
  }

  async sessionImage(): Promise<string> {
    return "";
  }

  proxyUrl(sessionId: string, token: string) {
    return `http://${sessionId}:${token}@127.0.0.1:${this.settings.proxyPort}`;
  }

  async startSession(spec: SessionContainerSpec): Promise<string> {
    if (!this.status.available) throw new Error(`the workspace runtime isn't ready: ${this.status.errors.join("; ") || "still checking"}`);
    const home = agentHome(spec.sessionId);
    await fs.mkdir(home, { recursive: true, mode: 0o700 });
    for (const f of spec.folders) {
      const st = await fs.stat(f.hostPath).catch(() => null);
      if (!st?.isDirectory()) throw new Error(`folder ${f.hostPath} doesn't exist on this machine`);
    }
    const ca: Record<string, string> = this.bundle ? { SSL_CERT_FILE: this.bundle, REQUESTS_CA_BUNDLE: this.bundle, CURL_CA_BUNDLE: this.bundle, GIT_SSL_CAINFO: this.bundle, NODE_EXTRA_CA_CERTS: this.bundle, AWS_CA_BUNDLE: this.bundle } : {};
    const noProxy = "localhost,127.0.0.1,::1";
    const env: Record<string, string> = {
      ...passedEnv(process.env, this.settings.runtime.passEnv),
      ...ca,
      ...spec.env,
      HTTP_PROXY: spec.proxyUrl,
      HTTPS_PROXY: spec.proxyUrl,
      http_proxy: spec.proxyUrl,
      https_proxy: spec.proxyUrl,
      NO_PROXY: noProxy,
      no_proxy: noProxy,
      PH_SESSION: spec.sessionId,
      SWAN_AGENT_HOME: home,
    };
    this.sessions.set(spec.sessionId, { env, workdir: spec.workdir, procs: this.sessions.get(spec.sessionId)?.procs ?? new Set() });
    return spec.sessionId;
  }

  /** Ends the commands still running; what they started in the background keeps going, as in a container's own processes until it stops. */
  async stopSession(sessionId: string): Promise<void> {
    const s = this.sessions.get(sessionId);
    this.sessions.delete(sessionId);
    for (const pid of s?.procs ?? []) killGroup(pid);
  }

  async removeOrphans(): Promise<void> {}

  private session(container: string): Running {
    const s = this.sessions.get(container);
    if (!s) throw new Error("this conversation's commands aren't running; start it again");
    return s;
  }

  exec(container: string, argv: string[], opts: ExecOpts = {}): Promise<RunResult> {
    const s = this.session(container);
    return this.run(argv, { ...opts, env: { ...s.env, ...opts.env }, cwd: opts.cwd ?? s.workdir, procs: s.procs, replaceEnv: true });
  }

  async execShell(container: string, command: string, opts: ShellOpts) {
    const s = this.session(container);
    // A login shell, as in the sandbox; its own process group, so a timeout or Stop ends everything it started.
    const r = await this.run([this.shell, "-lc", command], {
      env: { ...s.env, ...opts.env },
      cwd: opts.cwd ?? s.workdir,
      timeoutMs: opts.timeoutMs,
      signal: opts.signal,
      maxOutput: opts.maxOutput,
      procs: s.procs,
      replaceEnv: true,
    });
    // Match the sandbox: a timed-out command reports exit code 124.
    return { ...r, code: r.timedOut ? 124 : r.code };
  }

  stdioCommand(container: string, argv: string[], opts: { env?: Record<string, string>; cwd?: string }) {
    const s = this.session(container);
    return { command: argv[0]!, args: argv.slice(1), env: { ...s.env, ...opts.env }, cwd: opts.cwd ?? s.workdir };
  }

  /** Run argv (never through a shell of Swan's) in a new process group; a timeout or abort kills the group. */
  private run(argv: string[], opts: ExecOpts & { procs?: Set<number>; replaceEnv?: boolean } = {}): Promise<RunResult> {
    const max = opts.maxOutput ?? 2_000_000;
    return new Promise((resolve) => {
      const env = opts.replaceEnv ? opts.env : { ...process.env, ...opts.env };
      const child = spawn(argv[0]!, argv.slice(1), { cwd: opts.cwd, env, stdio: ["pipe", "pipe", "pipe"], detached: true });
      const pid = child.pid;
      if (pid) opts.procs?.add(pid);
      let stdout = "";
      let stderr = "";
      let truncated = false;
      let timedOut = false;
      const append = (cur: string, chunk: Buffer) => {
        if (cur.length >= max) {
          truncated = true;
          return cur;
        }
        const t = chunk.toString("utf8");
        if (cur.length + t.length > max) truncated = true;
        return cur + t.slice(0, max - cur.length);
      };
      child.stdout.on("data", (c: Buffer) => {
        stdout = append(stdout, c);
        opts.onStdout?.(c.toString("utf8"));
      });
      child.stderr.on("data", (c: Buffer) => (stderr = append(stderr, c)));
      const kill = () => pid && killGroup(pid);
      const timer = opts.timeoutMs
        ? setTimeout(() => {
            timedOut = true;
            kill();
          }, opts.timeoutMs)
        : undefined;
      opts.signal?.addEventListener("abort", kill, { once: true });
      const done = (code: number, extra = "") => {
        clearTimeout(timer);
        opts.signal?.removeEventListener("abort", kill);
        if (pid) opts.procs?.delete(pid);
        resolve({ code, stdout, stderr: stderr + extra, timedOut, truncated });
      };
      child.on("error", (e) => done(127, errMsg(e)));
      child.on("close", (code, signal) => done(code ?? (signal ? 137 : 1)));
      child.stdin.on("error", () => {});
      if (opts.input !== undefined) child.stdin.end(opts.input);
      else child.stdin.end();
    });
  }
}

function killGroup(pid: number) {
  try {
    process.kill(-pid, "SIGKILL");
  } catch {
    // already gone
  }
}
