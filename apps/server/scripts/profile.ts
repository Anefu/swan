// Memory profile of the server and sandboxes as personas and sub-agents are added. Needs Podman;
// uses the scripted model, so no API key. Never point it at your real home.
//
//   PH_HOME=$(mktemp -d) pnpm --filter @ph/server exec tsx scripts/profile.ts
//
// Optional: PROFILE_PORT (default 4617; the proxy uses +1, the fake model +2), PROFILE_NETWORK (ph-profile).
import { execFileSync, spawn, type ChildProcess } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";

const HOME = process.env.PH_HOME ?? "";
if (!HOME || !path.resolve(HOME).startsWith(path.resolve(os.tmpdir())) && !HOME.includes("/tmp/")) {
  console.error("Set PH_HOME to a temporary folder, e.g. PH_HOME=$(mktemp -d).");
  process.exit(2);
}
const PORT = Number(process.env.PROFILE_PORT ?? 4617);
const NET = process.env.PROFILE_NETWORK ?? "ph-profile";
const PERSONAS = ["prof-a", "prof-b", "prof-c"];
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const mb = (kb: number) => Math.round(kb / 1024);

function setup() {
  mkdirSync(path.join(HOME, "personas"), { recursive: true });
  writeFileSync(
    path.join(HOME, "config.yaml"),
    `port: ${PORT}\nproxyPort: ${PORT + 1}\nproviders:\n  fake: { type: openai, baseURL: http://127.0.0.1:${PORT + 2}/v1 }\ndefaultModel: { provider: fake, id: scripted }\n` +
      `runtime:\n  network: ${NET}\n  subnet: 10.233.0.0/24\n  relayIp: 10.233.0.2\n  relayName: ${NET}-relay\n`,
  );
  for (const id of PERSONAS)
    writeFileSync(path.join(HOME, "personas", `${id}.yaml`), `name: ${id}\nmodel: { provider: fake, id: scripted }\npermissions: { default: allow }\nsubagents: { maxBackground: 8 }\n`);
}

const procs: ChildProcess[] = [];
function start(cmd: string, args: string[], env: Record<string, string>) {
  const p = spawn(cmd, args, { cwd: path.resolve(import.meta.dirname, ".."), env: { ...process.env, ...env }, stdio: ["ignore", "ignore", "inherit"], detached: true }); // its own group, so cleanup reaches the server under npx
  procs.push(p);
  return p;
}

/** RSS of a process and everything it started (podman exec clients, wrappers), in KB. */
function treeRss(root: number): number {
  const rows = execFileSync("ps", ["-A", "-o", "pid=,ppid=,rss="], { encoding: "utf8" })
    .trim()
    .split("\n")
    .map((l) => l.trim().split(/\s+/).map(Number) as [number, number, number]);
  const kids = new Map<number, number[]>();
  for (const [pid, ppid] of rows) kids.set(ppid, [...(kids.get(ppid) ?? []), pid]);
  const rss = new Map(rows.map(([pid, , r]) => [pid, r]));
  let total = 0;
  const stack = [root];
  while (stack.length) {
    const p = stack.pop()!;
    total += rss.get(p) ?? 0;
    stack.push(...(kids.get(p) ?? []));
  }
  return total;
}

/** Memory of the containers on this profile's network, in MB, from podman stats. */
function containers(): { n: number; mb: number } {
  const names = execFileSync("podman", ["ps", "--filter", `network=${NET}`, "--format", "{{.Names}}"], { encoding: "utf8" }).trim().split("\n").filter(Boolean);
  if (!names.length) return { n: 0, mb: 0 };
  const out = execFileSync("podman", ["stats", "--no-stream", "--format", "{{.MemUsage}}", ...names], { encoding: "utf8" });
  const unit: Record<string, number> = { B: 1 / 1e6, kB: 1 / 1e3, KB: 1 / 1e3, MB: 1, GB: 1e3, KiB: 1 / 1024, MiB: 1, GiB: 1024 };
  const total = out
    .trim()
    .split("\n")
    .map((l) => /([\d.]+)\s*([kKMG]?i?B)/.exec(l))
    .reduce((s, m) => s + (m ? Number(m[1]) * (unit[m[2]!] ?? 0) : 0), 0);
  return { n: names.length, mb: Math.round(total) };
}

let token = "";
async function api<T>(method: string, p: string, body?: unknown): Promise<T> {
  const r = await fetch(`http://127.0.0.1:${PORT}${p}`, {
    method,
    headers: { "x-ph-token": token, ...(body ? { "content-type": "application/json" } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  if (!r.ok) throw new Error(`${method} ${p}: ${r.status} ${await r.text()}`);
  return (await r.json()) as T;
}
const sessionOf = async (persona: string) => (await api<{ session: { id: string; status: string } }>("GET", `/api/personas/${persona}/conversation`)).session;
async function say(persona: string, text: string) {
  const s = await sessionOf(persona);
  await api("POST", `/api/sessions/${s.id}/messages`, { text });
  return s.id;
}
async function idle(persona: string, maxMs = 600_000) {
  const t0 = Date.now();
  while (Date.now() - t0 < maxMs) {
    const s = await sessionOf(persona);
    if (s.status === "idle" || s.status === "error") return s.status;
    await sleep(1000);
  }
  return "timeout";
}

const rows: string[][] = [];
let server: ChildProcess;
function sample(label: string) {
  const c = containers();
  const srv = mb(treeRss(server.pid!));
  rows.push([label, String(srv), String(c.n), String(c.mb), String(srv + c.mb)]);
  console.log(`${label.padEnd(44)} server ${srv} MB · ${c.n} containers ${c.mb} MB`);
}

async function main() {
  setup();
  start("npx", ["tsx", "scripts/fake-model.ts"], { FAKE_MODEL_PORT: String(PORT + 2) });
  server = start("npx", ["tsx", "src/index.ts"], { PH_HOME: HOME });
  const tokenFile = path.join(HOME, "api-token");
  for (let i = 0; i < 60 && !existsSync(tokenFile); i++) await sleep(500);
  token = readFileSync(tokenFile, "utf8").trim();
  for (let i = 0; i < 60; i++) {
    try {
      await api("GET", "/api/personas");
      break;
    } catch {
      await sleep(500);
    }
  }
  await sleep(5000);
  sample("server idle, no conversation");

  console.log("starting the first conversation (may build the sandbox image)…");
  await say("prof-a", "hello");
  console.log(`  ${await idle("prof-a", 1_800_000)}`);
  sample("1 persona, sandbox running, idle");

  for (const n of [1, 4, 8]) {
    await say("prof-a", `fanout-${n}x`);
    await sleep(20_000);
    sample(`1 persona, ${n} background agent${n > 1 ? "s" : ""} working`);
    await idle("prof-a"); // the parent's turn
    await sleep(100_000); // the agents' commands finish
    sample(`1 persona, after ${n} agent${n > 1 ? "s" : ""} finished`);
  }

  await say("prof-b", "hello");
  await say("prof-c", "hello");
  await Promise.all(["prof-b", "prof-c"].map((p) => idle(p)));
  sample("3 personas, idle");
  for (const p of PERSONAS) await say(p, "fanout-4x");
  await sleep(25_000);
  sample("3 personas, 4 background agents each");

  console.log("\n| Step | Server and its processes (MB) | Containers | Containers (MB) | Total (MB) |\n|---|---|---|---|---|");
  for (const r of rows) console.log(`| ${r.join(" | ")} |`);
}

const cleanup = () => {
  for (const p of procs) {
    try {
      process.kill(-p.pid!, "SIGTERM"); // the server removes its containers on SIGTERM
    } catch {
      // already gone
    }
  }
};
process.on("SIGINT", () => {
  cleanup();
  process.exit(1);
});
main()
  .catch((e) => console.error(e instanceof Error ? e.message : e))
  .finally(async () => {
    cleanup();
    await sleep(10_000);
  });
