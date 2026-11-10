import { spawn } from "node:child_process";
import os from "node:os";
import { promises as fs } from "node:fs";
import path from "node:path";
import type { FolderMount, RuntimeStatus } from "@ph/shared";
import type { CertAuthority } from "../proxy/ca.js";
import { paths, type Settings } from "../settings.js";
import { adoptFiles, adoptKey, buildArgs, hasTools, proxyEnv, buildFiles, buildKey } from "./image.js";
import { TypedEmitter, errMsg, log, randomId } from "../util.js";

export interface RunResult {
  code: number;
  stdout: string;
  stderr: string;
  timedOut: boolean;
  truncated: boolean;
}

interface RunOpts {
  input?: string;
  env?: Record<string, string>; // added to the environment
  timeoutMs?: number;
  signal?: AbortSignal;
  maxOutput?: number;
  onStdout?: (chunk: string) => void;
}

export interface SessionContainerSpec {
  sessionId: string;
  personaId: string;
  image?: string;
  folders: FolderMount[];
  skills: { name: string; hostPath: string }[];
  env: Record<string, string>;
  proxyUrl: string;
  workdir: string;
  cpus: number;
  memory: string;
  pidsLimit: number;
}

/**
 * Thin wrapper over the podman CLI. Everything the agent does goes through `podman exec`
 * into a per-session container that sits on an --internal network.
 */
export class PodmanRuntime extends TypedEmitter<{ status: [RuntimeStatus] }> {
  status: RuntimeStatus;
  private rt: Settings["runtime"];

  private buildKey: string | null = null; // set by ensureImage when mirrors or extra CAs are configured
  private adopting = new Map<string, Promise<string>>(); // persona images being built, by tag

  constructor(
    private settings: Settings,
    private ca: CertAuthority,
    private extraCas: string[] = [],
  ) {
    super();
    this.rt = settings.runtime;
    this.status = {
      runtime: path.basename(this.rt.binary),
      available: false,
      version: null,
      imageReady: false,
      imageTag: null,
      networkReady: false,
      relayRunning: false,
      proxyPort: settings.proxyPort,
      busy: null,
      errors: [],
      needs: null,
    };
  }

  get imageTag() {
    return `${this.rt.image}:ca-${this.ca.fingerprint}${this.buildKey ? `-${this.buildKey}` : ""}`;
  }

  private update(patch: Partial<RuntimeStatus>) {
    this.status = { ...this.status, ...patch };
    this.emit("status", this.status);
  }

  run(args: string[], opts: RunOpts = {}): Promise<RunResult> {
    const max = opts.maxOutput ?? 2_000_000;
    return new Promise((resolve) => {
      const child = spawn(this.rt.binary, args, { stdio: ["pipe", "pipe", "pipe"], ...(opts.env ? { env: { ...process.env, ...opts.env } } : {}) });
      let stdout = "";
      let stderr = "";
      let truncated = false;
      let timedOut = false;
      const append = (cur: string, chunk: Buffer) => {
        if (cur.length >= max) {
          truncated = true;
          return cur;
        }
        const s = chunk.toString("utf8");
        if (cur.length + s.length > max) truncated = true;
        return cur + s.slice(0, max - cur.length);
      };
      child.stdout.on("data", (c: Buffer) => {
        stdout = append(stdout, c);
        opts.onStdout?.(c.toString("utf8"));
      });
      child.stderr.on("data", (c: Buffer) => (stderr = append(stderr, c)));
      const timer = opts.timeoutMs
        ? setTimeout(() => {
            timedOut = true;
            child.kill("SIGKILL");
          }, opts.timeoutMs)
        : undefined;
      const onAbort = () => child.kill("SIGKILL");
      opts.signal?.addEventListener("abort", onAbort, { once: true });
      child.on("error", (e) => {
        clearTimeout(timer);
        resolve({ code: 127, stdout, stderr: stderr + errMsg(e), timedOut, truncated });
      });
      child.on("close", (code) => {
        clearTimeout(timer);
        opts.signal?.removeEventListener("abort", onAbort);
        resolve({ code: code ?? 137, stdout, stderr, timedOut, truncated });
      });
      child.stdin.on("error", () => {});
      if (opts.input !== undefined) child.stdin.end(opts.input);
      else child.stdin.end();
    });
  }

  private async ok(args: string[], what: string, timeoutMs = 120_000): Promise<string> {
    const r = await this.run(args, { timeoutMs });
    if (r.code !== 0) throw new Error(`${what} failed: ${(r.stderr || r.stdout).trim().slice(0, 800)}`);
    return r.stdout.trim();
  }

  private initializing: Promise<void> | null = null;

  /** Bring up network, image and relay. Safe to call repeatedly; concurrent calls share one run. */
  init(): Promise<void> {
    this.initializing ??= this.bringUp().finally(() => (this.initializing = null));
    return this.initializing;
  }

  private async bringUp(): Promise<void> {
    const errors: string[] = [];
    this.update({ needs: null });
    try {
      const v = await this.run(["version", "--format", "{{.Client.Version}}"], { timeoutMs: 15_000 });
      if (v.code === 127) {
        this.update({ available: false, needs: "install" });
        throw new Error("Podman is not installed. Install it with `brew install podman` or Podman Desktop, then check again.");
      }
      if (v.code !== 0) throw new Error((v.stderr || "podman not found").trim());
      this.update({ version: v.stdout.trim() });
      let info = await this.run(["info", "--format", "{{.Host.OS}}"], { timeoutMs: 30_000 });
      if (info.code !== 0) {
        if (process.platform !== "linux" && !(await this.hasMachine())) {
          this.update({ available: false, needs: "machine" });
          throw new Error("Podman has no machine yet. Set it up to run sandboxes (a one-time download of about 1 GB).");
        }
        log.info("runtime", "podman machine not reachable, trying `podman machine start`");
        this.update({ busy: "starting podman machine" });
        // Podman hands the proxy variables to the machine when it starts it: base images are pulled there.
        await this.run(["machine", "start"], { timeoutMs: 180_000, env: proxyEnv(this.settings.proxy) });
        info = await this.run(["info", "--format", "{{.Host.OS}}"], { timeoutMs: 30_000 });
        if (info.code !== 0) throw new Error(`podman is installed but not usable: ${info.stderr.trim()}`);
      }
      this.update({ available: true });
      await this.ensureNetwork();
      this.update({ networkReady: true });
      await this.ensureImage();
      this.update({ imageReady: true, imageTag: this.imageTag });
      await this.ensureRelay();
      this.update({ relayRunning: true });
    } catch (e) {
      errors.push(errMsg(e));
      log.error("runtime", errMsg(e));
    } finally {
      this.update({ busy: null, errors });
    }
  }

  private async hasMachine(): Promise<boolean> {
    const r = await this.run(["machine", "list", "--format", "{{.Name}}"], { timeoutMs: 15_000 });
    return r.code !== 0 || r.stdout.trim() !== ""; // unknown counts as present, so start is still tried
  }

  /** Create the default Podman machine (only on the user's request: it downloads a VM image), then bring everything up. */
  setupMachine(): Promise<void> {
    this.initializing ??= (async () => {
      if (!(await this.hasMachine())) {
        this.update({ busy: "setting up Podman (a one-time download of about 1 GB)", errors: [] });
        const r = await this.run(["machine", "init"], { timeoutMs: 20 * 60_000, env: proxyEnv(this.settings.proxy) });
        if (r.code !== 0) {
          const msg = `podman machine init failed: ${(r.stderr || r.stdout).trim().slice(-800)}`;
          log.error("runtime", msg);
          this.update({ busy: null, errors: [msg] });
          return;
        }
      }
      await this.bringUp();
    })().finally(() => (this.initializing = null));
    return this.initializing;
  }

  private async ensureNetwork() {
    const { network, subnet } = this.rt;
    const exists = await this.run(["network", "exists", network]);
    if (exists.code !== 0) {
      log.info("runtime", `creating internal network ${network} (${subnet})`);
      await this.ok(["network", "create", "--internal", "--disable-dns", "--subnet", subnet, network], "network create");
    }
    const internal = await this.ok(["network", "inspect", network, "--format", "{{.Internal}}"], "network inspect");
    if (internal !== "true") throw new Error(`network ${network} exists but is not --internal; remove it (podman network rm ${network}) and restart`);
  }

  async ensureImage(force = false): Promise<void> {
    const containerfile = await fs.readFile(paths.containerfile, "utf8");
    const mirrors = this.settings.mirrors;
    const files = buildFiles(mirrors, this.extraCas);
    this.buildKey = buildKey(containerfile, mirrors, files);
    if (!force && (await this.run(["image", "exists", this.imageTag])).code === 0) return;
    this.update({ busy: "building sandbox image (first run takes a few minutes)", imageReady: false });
    log.info("runtime", `building ${this.imageTag}${mirrors.baseImage ? ` from ${mirrors.baseImage}` : ""}`);
    await this.build(this.imageTag, containerfile, files, buildArgs(mirrors, this.settings.proxy), "sandbox");
    log.info("runtime", "sandbox image ready");
  }

  /**
   * The image a session runs: Swan's, or a layer (Containerfile.base) over the persona's sandbox.image
   * or Swan's image with its sandbox.tools, built on first use and again when the image, the layer or
   * the tools change. The relay always runs Swan's image. config.yaml's sandboxTools stand in for
   * tools a persona doesn't set.
   */
  async sessionImage(sandbox: { image?: string; tools?: Settings["sandboxTools"] }): Promise<string> {
    const tools = sandbox.tools ?? this.settings.sandboxTools;
    if (!sandbox.image && !hasTools(tools)) return this.imageTag;
    const base = sandbox.image ?? this.imageTag;
    const containerfile = await fs.readFile(paths.containerfileBase, "utf8");
    const files = adoptFiles(this.extraCas, tools, this.settings.mirrors);
    const tag = `${this.rt.image}-own:ca-${this.ca.fingerprint}-${adoptKey(containerfile, base, files)}`;
    let p = this.adopting.get(tag);
    if (!p) {
      p = (async () => {
        if ((await this.run(["image", "exists", tag])).code === 0) return tag;
        this.update({ busy: sandbox.image ? `building the sandbox from ${base}` : "adding this persona's tools to the sandbox" });
        try {
          log.info("runtime", `building ${tag} from ${base}`);
          await this.build(tag, containerfile, files, buildArgs({ ...this.settings.mirrors, baseImage: base }, this.settings.proxy), `own-${tag.slice(-12)}`);
          log.info("runtime", `${tag} ready`);
          return tag;
        } finally {
          this.update({ busy: null });
        }
      })().finally(() => this.adopting.delete(tag));
      this.adopting.set(tag, p);
    }
    return p;
  }

  /** podman build in a fresh context under PH_HOME/build/<dir>; on failure, the cause first and where the full log is. */
  private async build(tag: string, containerfile: string, files: Record<string, string>, args: string[], dir: string) {
    const ctx = path.join(paths.build, dir);
    await fs.rm(ctx, { recursive: true, force: true });
    await fs.mkdir(path.join(ctx, "swan", "ca"), { recursive: true });
    await fs.writeFile(path.join(ctx, "Containerfile"), containerfile);
    await fs.writeFile(path.join(ctx, "harness-ca.crt"), this.ca.certPem);
    for (const [name, content] of Object.entries(files)) await fs.writeFile(path.join(ctx, name), content);
    const r = await this.run(["build", ...args, "-t", tag, "-f", path.join(ctx, "Containerfile"), ctx], {
      timeoutMs: 20 * 60_000,
      onStdout: (s) => {
        const line = s.trim().split("\n").pop();
        if (line?.startsWith("STEP")) this.update({ busy: `building sandbox image: ${line.slice(0, 80)}` });
      },
    });
    // The whole output stays in a file; the error carries the end of it.
    const logFile = path.join(paths.build, `${dir}-build.log`);
    await fs.writeFile(logFile, `${r.stdout}\n${r.stderr}`, { mode: 0o600 }).catch(() => {});
    if (r.code !== 0) {
      // The cause first: the failing command's own output (apt's "Failed to fetch…") is on stdout. Podman's
      // summary on stderr repeats the whole RUN command; drop that.
      const tail = r.stdout.trim().split("\n").slice(-15).join("\n").slice(-1500);
      const summary = r.stderr.trim().replace(/STEP "(?:[^"\\]|\\.)*"/g, "a step").slice(-400);
      throw new Error(`image build failed:\n${tail}\n\n${summary}\n${aptHint(`${r.stdout}\n${r.stderr}`, this.settings.mirrors)}Full output: ${logFile.replace(os.homedir(), "~")}`);
    }
  }

  async rebuild(): Promise<void> {
    try {
      await this.ensureImage(true);
      await this.run(["rm", "-f", this.rt.relayName]);
      await this.ensureRelay();
      this.update({ imageReady: true, imageTag: this.imageTag, relayRunning: true, errors: [] });
    } catch (e) {
      this.update({ errors: [errMsg(e)] });
    } finally {
      this.update({ busy: null });
    }
  }

  /** The relay is the only thing on both networks; it forwards :3128 to the host proxy and holds nothing. */
  private async ensureRelay() {
    const { relayName, network, relayIp } = this.rt;
    const want = `${this.imageTag}|${this.settings.proxyPort}`;
    const inspect = await this.run(["inspect", relayName, "--format", '{{.State.Running}}|{{index .Config.Labels "ph.relay"}}']);
    if (inspect.code === 0) {
      const out = inspect.stdout.trim();
      const sep = out.indexOf("|"); // the label itself contains "|"
      if (out.slice(0, sep) === "true" && out.slice(sep + 1) === want) return;
      await this.run(["rm", "-f", relayName]);
    }
    log.info("runtime", `starting relay ${relayName} -> host:${this.settings.proxyPort}`);
    await this.ok(
      [
        "run", "-d", "--name", relayName, "--label", `ph.relay=${want}`, "--restart", "always",
        "--network", "podman", "--network", `${network}:ip=${relayIp}`,
        "--cap-drop", "ALL", "--security-opt", "no-new-privileges", "--memory", "128m", "--pids-limit", "256",
        this.imageTag,
        "socat", "TCP-LISTEN:3128,fork,reuseaddr", `TCP:host.containers.internal:${this.settings.proxyPort}`,
      ],
      "relay start",
    );
  }

  proxyUrl(sessionId: string, token: string) {
    return `http://${sessionId}:${token}@${this.rt.relayIp}:3128`;
  }

  containerName(sessionId: string) {
    return `ph-${sessionId}`;
  }

  async startSession(spec: SessionContainerSpec): Promise<string> {
    if (!this.status.available || !this.status.imageReady || !this.status.relayRunning)
      throw new Error(`sandbox runtime not ready: ${this.status.busy ?? this.status.errors.join("; ") ?? "initialising"}`);
    const name = this.containerName(spec.sessionId);
    await this.run(["rm", "-f", name]);
    const env: Record<string, string> = {
      ...spec.env,
      HTTP_PROXY: spec.proxyUrl,
      HTTPS_PROXY: spec.proxyUrl,
      http_proxy: spec.proxyUrl,
      https_proxy: spec.proxyUrl,
      NO_PROXY: "localhost,127.0.0.1",
      no_proxy: "localhost,127.0.0.1",
      PH_SESSION: spec.sessionId,
    };
    const args = [
      "run", "-d", "--init", "--name", name,
      "--label", `ph.session=${spec.sessionId}`, "--label", `ph.persona=${spec.personaId}`,
      "--hostname", spec.personaId.slice(0, 63),
      "--network", this.rt.network,
      "--userns", "keep-id:uid=1000,gid=1000", "--user", "1000:1000",
      "--cap-drop", "ALL", "--security-opt", "no-new-privileges",
      "--pids-limit", String(spec.pidsLimit), "--memory", spec.memory, "--cpus", String(spec.cpus),
      "-w", spec.workdir,
    ];
    for (const [k, v] of Object.entries(env)) args.push("-e", `${k}=${v}`);
    for (const f of spec.folders) args.push("-v", `${f.hostPath}:${f.mountPath}:${f.mode}`);
    for (const s of spec.skills) args.push("-v", `${s.hostPath}:/skills/${s.name}:ro`);
    args.push(spec.image ?? this.imageTag, "sleep", "infinity");
    await this.ok(args, "container start", 60_000);
    // A container that ends at once (an image built for another architecture, or one Swan cannot run)
    // would only show up later as failing commands: say so now, with what it printed.
    await new Promise((r) => setTimeout(r, 500));
    const state = await this.run(["inspect", name, "--format", "{{.State.Running}}|{{.State.ExitCode}}"]);
    if (state.code === 0 && state.stdout.trim().startsWith("false")) {
      const logs = await this.run(["logs", "--tail", "15", name]);
      await this.run(["rm", "-f", name]);
      const out = `${logs.stdout}${logs.stderr}`.trim().slice(-1500);
      throw new Error(`the sandbox container stopped right away (exit code ${state.stdout.trim().split("|")[1]})${out ? `:\n${out}` : "."} Check that ${spec.image ?? this.imageTag} runs on this Mac (arm64).`);
    }
    return name;
  }

  async stopSession(sessionId: string): Promise<void> {
    await this.run(["rm", "-f", "-t", "2", this.containerName(sessionId)], { timeoutMs: 30_000 });
  }

  /**
   * Remove session containers left over from a previous run of this instance. Only containers on
   * this instance's network: another Swan (a second PH_HOME, a test run) has its own and keeps them.
   */
  async removeOrphans(keep: Set<string> = new Set()): Promise<void> {
    const r = await this.run(["ps", "-a", "--filter", "label=ph.session", "--filter", `network=${this.rt.network}`, "--format", "{{.Names}}"]);
    if (r.code !== 0) return;
    for (const n of r.stdout.split("\n").map((s) => s.trim()).filter(Boolean)) {
      if (!keep.has(n)) await this.run(["rm", "-f", "-t", "1", n]);
    }
  }

  /** Args for `podman exec` used by stdio MCP transports. */
  execArgs(container: string, argv: string[], opts: { env?: Record<string, string>; cwd?: string; interactive?: boolean } = {}) {
    const args = ["exec"];
    if (opts.interactive) args.push("-i");
    if (opts.cwd) args.push("-w", opts.cwd);
    for (const [k, v] of Object.entries(opts.env ?? {})) args.push("-e", `${k}=${v}`);
    args.push(container, ...argv);
    return args;
  }

  /** Run argv in the session container. Arguments are passed as argv, never through a host shell. */
  exec(container: string, argv: string[], opts: RunOpts & { cwd?: string; env?: Record<string, string> } = {}) {
    return this.run(this.execArgs(container, argv, { env: opts.env, cwd: opts.cwd, interactive: opts.input !== undefined }), opts);
  }

  /**
   * Run a shell command so it can be killed as a unit: setsid makes it a session leader that
   * records its pid; `timeout` bounds it inside the container; abort kills the whole session.
   */
  async execShell(container: string, command: string, opts: { cwd?: string; timeoutMs: number; signal?: AbortSignal; maxOutput?: number }) {
    const id = randomId("", 6);
    const pidFile = `/tmp/.ph-exec-${id}.pid`;
    const secs = Math.max(1, Math.ceil(opts.timeoutMs / 1000));
    // -w: setsid forks when already a group leader; wait so output and exit status come back.
    const argv = ["setsid", "-w", "bash", "-c", `echo $$ > ${pidFile}; exec timeout -k 5 ${secs} bash -lc "$1"`, "ph", command];
    const kill = () => void this.exec(container, ["sh", "-c", `p=$(cat ${pidFile} 2>/dev/null) && pkill -KILL -s "$p"; rm -f ${pidFile}`]);
    opts.signal?.addEventListener("abort", kill, { once: true });
    try {
      const r = await this.exec(container, argv, { cwd: opts.cwd, timeoutMs: opts.timeoutMs + 15_000, maxOutput: opts.maxOutput });
      return { ...r, timedOut: r.timedOut || r.code === 124 };
    } finally {
      opts.signal?.removeEventListener("abort", kill);
      void this.exec(container, ["rm", "-f", pidFile]);
    }
  }
}

/** When the build could not reach Debian or Ubuntu's servers, say which sources still need a mirror. */
export function aptHint(output: string, mirrors: Settings["mirrors"]): string {
  if (!/Failed to fetch|Could not resolve|Unable to connect|Temporary failure resolving|Connection failed/i.test(output)) return "";
  const missing = [...new Set(output.match(/https?:\/\/(?:deb\.debian\.org\/debian(?:-security)?|security\.debian\.org(?:\/debian-security)?|(?:[a-z]+\.)?archive\.ubuntu\.com\/ubuntu|security\.ubuntu\.com\/ubuntu)/g) ?? [])].filter(
    (u) => !Object.keys(mirrors.apt).some((k) => k.replace(/\/$/, "") === u),
  );
  if (!missing.length) return "";
  return `The build couldn't reach ${missing.join(" and ")}. If your network only reaches internal mirrors, map each to its mirror in config.yaml:\nmirrors:\n  apt:\n${missing.map((u) => `    ${u}: https://mirror.example.com/${u.includes("security") ? "debian-security" : u.includes("ubuntu") ? "ubuntu" : "debian"}-remote`).join("\n")}\n`;
}

