import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { CertAuthority } from "../proxy/ca.js";
import type { Settings } from "../settings.js";
import { PodmanRuntime } from "./podman.js";

const HOME = "/Users/me/.swan";
const OTHER = "/private/tmp/swan-test";

let dir: string;

/** A stand-in podman: answers from state.json and records every call in calls.jsonl. */
const FAKE = (d: string) => `#!/usr/bin/env node
const fs = require("node:fs");
const dir = ${JSON.stringify(d)};
const args = process.argv.slice(2);
fs.appendFileSync(dir + "/calls.jsonl", JSON.stringify(args) + "\\n");
const state = JSON.parse(fs.readFileSync(dir + "/state.json", "utf8"));
const is = (...p) => p.every((x, i) => args[i] === x);
const out = (v) => process.stdout.write((typeof v === "string" ? v : JSON.stringify(v)) + "\\n");
if (is("version")) out("5.0.0");
else if (is("info")) out("linux");
else if (is("network", "inspect")) out("true");
else if (is("container", "inspect")) state.relay ? out([state.relay]) : process.exit(125);
else if (is("ps")) out(state.sessions ?? []);
`;

beforeEach(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), "ph-podman-"));
  await fs.writeFile(path.join(dir, "podman"), FAKE(dir), { mode: 0o755 });
});
afterEach(async () => {
  await fs.rm(dir, { recursive: true, force: true });
});

async function runtime(state: { relay?: unknown; sessions?: unknown[] }) {
  await fs.writeFile(path.join(dir, "state.json"), JSON.stringify(state));
  const runtime = { binary: path.join(dir, "podman"), image: "localhost/sandbox", network: "ph-internal", subnet: "10.213.0.0/24", relayIp: "10.213.0.2", relayName: "ph-relay" };
  return new PodmanRuntime({ proxyPort: 4318, runtime } as Settings, { fingerprint: "abc" } as CertAuthority, HOME);
}

async function calls(): Promise<string[][]> {
  const text = await fs.readFile(path.join(dir, "calls.jsonl"), "utf8").catch(() => "");
  return text.trim().split("\n").filter(Boolean).map((l) => JSON.parse(l) as string[]);
}
const changes = async () => (await calls()).filter((a) => ["rm", "run", "build"].includes(a[0]!) || (a[0] === "network" && a[1] === "create"));
const relayWith = (running: boolean, labels: Record<string, string>) => ({ State: { Running: running }, Config: { Labels: labels } });

describe("PodmanRuntime with another Swan on the same names", () => {
  it("leaves the other home's relay alone and says whose it is", async () => {
    const rt = await runtime({ relay: relayWith(true, { "ph.relay": "localhost/sandbox:ca-9f00|4518", "ph.home": OTHER }) });
    await rt.init();
    expect(rt.status.relayRunning).toBe(false);
    expect(rt.status.errors[0]).toContain(`Swan for ${OTHER}`);
    await rt.rebuild();
    expect(rt.status.errors[0]).toContain(`Swan for ${OTHER}`);
    expect(await changes()).toEqual([]); // no rm, no relay, not even an image build
  });

  it("labels its relay with its home, replacing an unlabelled one from an older version", async () => {
    const rt = await runtime({ relay: relayWith(true, { "ph.relay": "localhost/sandbox:ca-abc|4318" }) });
    await rt.init();
    expect(rt.status.errors).toEqual([]);
    const [rm, run] = await changes();
    expect(rm).toEqual(["rm", "-f", "ph-relay"]);
    expect(run).toEqual(expect.arrayContaining(["--name", "ph-relay", "--label", "ph.relay=localhost/sandbox:ca-abc|4318", "--label", `ph.home=${HOME}`]));
  });

  it("labels session containers with its home", async () => {
    const rt = await runtime({ relay: relayWith(true, { "ph.relay": "localhost/sandbox:ca-abc|4318", "ph.home": HOME }) });
    await rt.init();
    await rt.startSession({ sessionId: "s1", personaId: "p", folders: [], skills: [], env: {}, proxyUrl: "http://x", workdir: "/w", cpus: 1, memory: "1g", pidsLimit: 64 });
    const run = (await changes()).find((a) => a[0] === "run");
    expect(run).toEqual(expect.arrayContaining(["--name", "ph-s1", "--label", `ph.home=${HOME}`]));
  });

  it("removes only its own and unlabelled leftover sessions", async () => {
    const s = (name: string, labels: Record<string, string>, net = "ph-internal") => ({ Names: [name], Labels: { "ph.session": name, ...labels }, Networks: [net] });
    const rt = await runtime({ sessions: [s("ph-mine", { "ph.home": HOME }), s("ph-theirs", { "ph.home": OTHER }), s("ph-old", {}), s("ph-elsewhere", {}, "swan-test")] });
    await rt.removeOrphans();
    expect((await changes()).map((a) => a.at(-1))).toEqual(["ph-mine", "ph-old"]);
  });
});
