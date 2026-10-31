import { spawn, type ChildProcess } from "node:child_process";
import { createWriteStream, promises as fs } from "node:fs";
import net from "node:net";
import path from "node:path";
import { fileURLToPath } from "node:url";
import YAML from "yaml";
import type { Campaign, Case, RunConfig } from "./schema.js";

export const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");

/** Fixed names for the benchmark's own Swan, apart from the user's (4317, ph-internal) and test instances. */
export const BENCH = {
  port: 4617,
  proxyPort: 4618,
  network: "ph-bench",
  subnet: "10.215.0.0/24",
  relayIp: "10.215.0.2",
  relayName: "ph-relay-bench",
  persona: "bench",
};

export const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export function portFree(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const s = net.createServer();
    s.once("error", () => resolve(false));
    s.listen(port, "127.0.0.1", () => s.close(() => resolve(true)));
  });
}

/** Run a command (argv, no shell) and collect its output. */
export function run(cmd: string, args: string[], opts: { cwd?: string; timeoutMs?: number } = {}): Promise<{ code: number; out: string }> {
  return new Promise((resolve) => {
    const p = spawn(cmd, args, { cwd: opts.cwd, stdio: ["ignore", "pipe", "pipe"] });
    let out = "";
    p.stdout.on("data", (d) => (out += d));
    p.stderr.on("data", (d) => (out += d));
    const t = opts.timeoutMs ? setTimeout(() => p.kill("SIGKILL"), opts.timeoutMs) : null;
    p.on("close", (code) => {
      if (t) clearTimeout(t);
      resolve({ code: code ?? -1, out });
    });
    p.on("error", (e) => resolve({ code: -1, out: String(e) }));
  });
}

/** Provider keys a run needs, copied by name from the user's secrets file. Values are never logged. */
export async function pickSecrets(file: string | undefined, names: string[]): Promise<Record<string, string>> {
  if (!names.length) return {};
  if (!file) throw new Error(`this run needs ${names.join(", ")}: pass --secrets <secrets.yaml>`);
  const all = (YAML.parse(await fs.readFile(file, "utf8")) ?? {}) as Record<string, unknown>;
  const out: Record<string, string> = {};
  for (const n of names) {
    const v = all[n];
    if (typeof v !== "string" || !v) throw new Error(`${file} has no value for ${n}`);
    out[n] = v;
  }
  return out;
}

/** The keys the run's model, and its memory model, need. */
export function secretNames(campaign: Campaign, config: RunConfig): string[] {
  const providers = [config.model.provider, config.memoryModel?.provider].filter((p): p is string => !!p);
  return [...new Set(providers.flatMap((p) => (campaign.providers[p]?.apiKeySecret ? [campaign.providers[p].apiKeySecret!] : [])))];
}

/**
 * A fresh Swan home for one run: config, the bench persona, a copy of the case's workspace and the
 * shared benchmark CA (so the sandbox image is built once, not per run).
 */
export async function prepareHome(o: {
  dir: string;
  campaign: Campaign;
  config: RunConfig;
  kase: Case;
  secrets: Record<string, string>;
  caDir: string;
}): Promise<{ home: string; workspace: string | null }> {
  const home = path.join(o.dir, "home");
  await fs.mkdir(path.join(home, "personas"), { recursive: true, mode: 0o700 });
  const providers = structuredClone(o.campaign.providers);
  if (o.config.contextTokens) {
    const p = (providers[o.config.model.provider] ??= { type: "openai" });
    const models = (p.models ??= {});
    models[o.config.model.id] = { ...models[o.config.model.id], contextTokens: o.config.contextTokens };
  }
  const settings = {
    port: BENCH.port,
    proxyPort: BENCH.proxyPort,
    runtime: { network: BENCH.network, subnet: BENCH.subnet, relayIp: BENCH.relayIp, relayName: BENCH.relayName },
    providers,
    defaultModel: { provider: o.config.model.provider, id: o.config.model.id },
    skillDirs: [],
    connections: {},
    rolloverStrategy: o.config.rolloverStrategy,
    ...(o.config.memoryModel ? { memoryModel: o.config.memoryModel } : {}),
  };
  await fs.writeFile(path.join(home, "config.yaml"), YAML.stringify(settings), { mode: 0o600 });
  await fs.writeFile(path.join(home, "secrets.yaml"), Object.keys(o.secrets).length ? YAML.stringify(o.secrets) : "{}\n", { mode: 0o600 });
  try {
    await fs.cp(o.caDir, path.join(home, "ca"), { recursive: true });
  } catch {
    /* first run: Swan creates the CA, and the runner keeps it */
  }

  let workspace: string | null = null;
  const folders: { path: string; mount: string; mode: string }[] = [];
  if (o.kase.workspace) {
    workspace = path.join(o.dir, "workspace", path.basename(o.kase.workspace));
    await fs.cp(o.kase.workspace, workspace, { recursive: true });
    folders.push({ path: workspace, mount: `/workspace/${path.basename(o.kase.workspace)}`, mode: "rw" });
  }
  const persona = {
    name: "Bench",
    description: `Benchmark run of ${o.kase.id}`,
    model: o.config.model,
    instructions: o.kase.persona.instructions,
    folders,
    skills: [],
    mcpServers: {},
    network: { allow: o.kase.persona.network },
    // Approval outcomes are scripted: every tool call runs; unlisted hosts are refused by the runner.
    permissions: { default: "allow", allow: [], ask: [], deny: [] },
    memory: { autoBrief: o.config.memoryBrief, briefTokens: 1500 },
  };
  await fs.writeFile(path.join(home, "personas", `${BENCH.persona}.yaml`), YAML.stringify(persona), { mode: 0o600 });
  return { home, workspace };
}

/** One Swan server process for a run's home. */
export class Swan {
  private proc: ChildProcess | null = null;
  private token = "";

  constructor(
    readonly home: string,
    private logFile: string,
  ) {}

  async start(): Promise<void> {
    if (!(await portFree(BENCH.port)) || !(await portFree(BENCH.proxyPort)))
      throw new Error(`ports ${BENCH.port}/${BENCH.proxyPort} are in use: is another benchmark running?`);
    const log = createWriteStream(this.logFile, { flags: "a" });
    const server = path.join(REPO, "apps/server");
    this.proc = spawn(path.join(server, "node_modules/.bin/tsx"), ["src/index.ts"], {
      cwd: server,
      env: { ...process.env, PH_HOME: this.home },
      stdio: ["ignore", "pipe", "pipe"],
      detached: true, // its own process group, so stop() reaches tsx's child too
    });
    this.proc.stdout?.pipe(log);
    this.proc.stderr?.pipe(log);
    const started = Date.now();
    while (Date.now() - started < 120_000) {
      if (this.proc.exitCode !== null) throw new Error(`Swan exited during start; see ${this.logFile}`);
      try {
        this.token = (await fs.readFile(path.join(this.home, "api-token"), "utf8")).trim();
        await this.api("GET", "/api/runtime");
        return;
      } catch {
        await sleep(500);
      }
    }
    throw new Error(`Swan did not start within 2 minutes; see ${this.logFile}`);
  }

  /** Wait until the sandbox image, network and relay are ready (the first run may build the image). */
  async waitRuntime(timeoutMs = 20 * 60_000): Promise<{ imageTag: string }> {
    const started = Date.now();
    for (;;) {
      const r = await this.api<{ available: boolean; imageReady: boolean; networkReady: boolean; relayRunning: boolean; imageTag: string | null; errors?: string[] }>("GET", "/api/runtime");
      if (r.imageReady && r.networkReady && r.relayRunning && r.imageTag) return { imageTag: r.imageTag };
      // Swan starts with available: false until its first probe; only a probe that failed is final.
      if (r.available === false && r.errors?.length) throw new Error(`Podman is not available: ${r.errors.join("; ")}`);
      if (Date.now() - started > timeoutMs) throw new Error("the sandbox runtime did not become ready");
      await sleep(2000);
    }
  }

  async stop(): Promise<void> {
    const p = this.proc;
    this.proc = null;
    if (!p || p.exitCode !== null || !p.pid) return;
    const exited = new Promise<void>((r) => p.once("exit", () => r()));
    process.kill(-p.pid, "SIGTERM");
    const timer = sleep(20_000).then(() => "timeout" as const);
    if ((await Promise.race([exited.then(() => "exited" as const), timer])) === "timeout") {
      try {
        process.kill(-p.pid, "SIGKILL");
      } catch {}
      await exited;
    }
  }

  async api<T = unknown>(method: string, url: string, body?: unknown): Promise<T> {
    const res = await fetch(`http://127.0.0.1:${BENCH.port}${url}`, {
      method,
      headers: { "x-ph-token": this.token, ...(body === undefined ? {} : { "content-type": "application/json" }) },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const text = await res.text();
    if (!res.ok) throw new Error(`${method} ${url}: ${res.status} ${text.slice(0, 300)}`);
    return (text ? JSON.parse(text) : null) as T;
  }
}

/** Remove the benchmark's session containers; with `all`, also its relay and network. */
export async function cleanupPodman(all = false): Promise<void> {
  const ids = (await run("podman", ["ps", "-aq", "--filter", `network=${BENCH.network}`])).out.split(/\s+/).filter(Boolean);
  const keep = all ? [] : (await run("podman", ["ps", "-aq", "--filter", `name=^${BENCH.relayName}$`])).out.split(/\s+/).filter(Boolean);
  const remove = ids.filter((id) => !keep.some((k) => k.startsWith(id) || id.startsWith(k)));
  if (remove.length) await run("podman", ["rm", "-f", ...remove]);
  if (all) {
    await run("podman", ["rm", "-f", BENCH.relayName]);
    await run("podman", ["network", "rm", BENCH.network]);
  }
}
