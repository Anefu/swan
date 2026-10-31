// Benchmark runner for Swan's memory management and cost per task.
//
//   pnpm bench run bench/campaigns/dry-run.yaml
//   pnpm bench run bench/campaigns/pilot.yaml --secrets ~/.persona-harness/secrets.yaml
//   pnpm bench report ~/.swan-bench/results/<campaign>-<time>
//
// Each run gets a fresh Swan home under --work (default ~/.swan-bench, inside $HOME so Podman can
// mount its workspace), on its own port, network and relay, apart from the user's Swan.
import { spawn } from "node:child_process";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { CapReached, runOne, type RunResult } from "./run.js";
import { writeReport } from "./report.js";
import { loadCampaign, type Case, type Variant } from "./schema.js";
import { cleanupPodman, pickSecrets, portFree, REPO, secretNames, sleep } from "./swan.js";

const FAKE_PORT = 8299;

function flag(args: string[], name: string): string | undefined {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
}

// pnpm runs the script in bench/; paths on the command line are relative to where it was typed.
const BASE = process.env.INIT_CWD ?? process.cwd();
const expand = (p: string) => (p.startsWith("~/") ? path.join(os.homedir(), p.slice(2)) : path.resolve(BASE, p));

function variantsOf(k: Case): Variant[] {
  const hasBreak = k.stages.some((s) => "break" in s);
  return hasBreak && k.variants.length ? k.variants : ["plain"];
}

/** The scripted model for dry runs, with every case's scripts added. */
async function startFakeModel(cases: Case[], dir: string) {
  if (!(await portFree(FAKE_PORT))) throw new Error(`port ${FAKE_PORT} (fake model) is in use`);
  const scripts = Object.assign({}, ...cases.map((k) => k.fake));
  const file = path.join(dir, "fake-scripts.json");
  await fs.writeFile(file, JSON.stringify(scripts, null, 2));
  const server = path.join(REPO, "apps/server");
  const p = spawn(path.join(server, "node_modules/.bin/tsx"), ["scripts/fake-model.ts"], {
    cwd: server,
    env: { ...process.env, FAKE_MODEL_PORT: String(FAKE_PORT), FAKE_MODEL_SCRIPTS: file },
    stdio: "ignore",
    detached: true,
  });
  for (let i = 0; i < 40 && (await portFree(FAKE_PORT)); i++) await sleep(250);
  return () => {
    try {
      if (p.pid) process.kill(-p.pid, "SIGTERM");
    } catch {}
  };
}

async function runCampaign(file: string, args: string[]) {
  const { campaign, cases: all } = await loadCampaign(file);
  const only = flag(args, "--only");
  const cases = only ? all.filter((k) => k.id === only) : all;
  if (!cases.length) throw new Error(`no case ${only}`);
  const variant = flag(args, "--variant");
  const work = expand(flag(args, "--work") ?? "~/.swan-bench");
  const secretsFile = flag(args, "--secrets") ? expand(flag(args, "--secrets")!) : undefined;
  for (const c of campaign.configs)
    if (campaign.cap === 0 && !c.allowUnpriced) throw new Error(`config ${c.id}: the cap is $0, so only unpriced (scripted or local) models may run`);

  const plan = campaign.configs.flatMap((config) =>
    cases.flatMap((kase) =>
      variantsOf(kase)
        .filter((v) => !variant || v === variant)
        .flatMap((v) => Array.from({ length: campaign.trials }, (_, i) => ({ config, kase, variant: v, trial: i + 1 }))),
    ),
  );
  if (!plan.length) throw new Error("nothing to run: check --only and --variant");
  const stamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
  const dir = path.join(work, "results", `${campaign.name}-${stamp}`);
  const caDir = path.join(work, ".state", "ca");
  await fs.mkdir(dir, { recursive: true });
  console.log(`${campaign.name}: ${plan.length} runs, cap $${campaign.cap}. Results: ${dir}`);

  const stopFake = campaign.fakeModel ? await startFakeModel(cases, dir) : () => {};
  const notes: string[] = [];
  let spent = 0;
  let n = 0;
  try {
    for (const p of plan) {
      n += 1;
      const label = `[${n}/${plan.length}] ${p.config.id} · ${p.kase.id} · ${p.variant} · trial ${p.trial}`;
      const secrets = await pickSecrets(secretsFile, secretNames(campaign, p.config));
      let r: RunResult;
      try {
        r = await runOne({
          campaign,
          config: p.config,
          kase: p.kase,
          variant: p.variant,
          trial: p.trial,
          dir: path.join(dir, p.config.id, p.kase.id, p.variant, `t${p.trial}`),
          caDir,
          secrets,
          spentBefore: spent,
        });
      } catch (e) {
        if (e instanceof CapReached) {
          notes.push(`Stopped at run ${n} of ${plan.length}: ${e.message}`);
          console.log(`${label}: stopped. ${e.message}`);
          break;
        }
        throw e;
      }
      spent += r.costUsd ?? 0;
      const failed = r.checks.filter((c) => !c.pass).map((c) => `${c.id} (${c.detail})`);
      console.log(
        `${label}: ${r.status}${r.error ? ` (${r.error})` : ""}${failed.length ? ` — failed ${failed.join(", ")}` : ""} · ${r.costUsd === null ? "cost unknown" : `$${r.costUsd.toFixed(3)}`} · ${Math.round(r.wallMs / 1000)}s · total $${spent.toFixed(2)}`,
      );
    }
  } finally {
    stopFake();
    await cleanupPodman(true);
  }
  console.log("\n" + (await writeReport(dir, campaign.name, notes)));
}

async function main() {
  const [cmd, target, ...args] = process.argv.slice(2);
  if (cmd === "run" && target) return runCampaign(expand(target), args);
  if (cmd === "report" && target) return void console.log(await writeReport(expand(target), path.basename(target)));
  console.log("usage: bench run <campaign.yaml> [--secrets <secrets.yaml>] [--work <dir>] [--only <case-id>] [--variant <name>]\n       bench report <results-dir>");
  process.exitCode = 1;
}

main().catch((e) => {
  console.error(e instanceof Error ? e.message : e);
  process.exitCode = 1;
});
