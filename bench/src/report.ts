import { promises as fs } from "node:fs";
import path from "node:path";
import type { RunResult } from "./run.js";

export interface Row {
  suite: string;
  group: string; // variant for memory runs, tier for cost runs
  config: string;
  model: string;
  runs: number;
  pass: number;
  fail: number;
  error: number;
  passRate: number | null;
  ci95: [number, number] | null;
  costUsd: number | null;
  costPerSuccess: number | null;
  memoryShare: number | null; // checkpoint + dream spend over all spend
  observed: number | null; // share of informational checks that held, e.g. "saved to memory"
  meanTokens: number;
  meanRollovers: number;
  meanWallS: number;
}

/** Wilson score interval for a pass rate. */
export function wilson(pass: number, n: number, z = 1.96): [number, number] | null {
  if (n === 0) return null;
  const p = pass / n;
  const d = 1 + (z * z) / n;
  const c = p + (z * z) / (2 * n);
  const m = z * Math.sqrt((p * (1 - p)) / n + (z * z) / (4 * n * n));
  return [Math.max(0, (c - m) / d), Math.min(1, (c + m) / d)];
}

const sum = (xs: number[]) => xs.reduce((a, b) => a + b, 0);
const mean = (xs: number[]) => (xs.length ? sum(xs) / xs.length : 0);

export function summarize(results: RunResult[]): Row[] {
  const groups = new Map<string, RunResult[]>();
  for (const r of results) {
    const key = [r.suite, r.suite === "cost" ? r.tier : r.variant, r.configId].join("\u0000");
    groups.set(key, [...(groups.get(key) ?? []), r]);
  }
  return [...groups.entries()].map(([key, rs]) => {
    const [suite, group, config] = key.split("\u0000");
    const pass = rs.filter((r) => r.status === "pass").length;
    const fail = rs.filter((r) => r.status === "fail").length;
    // Cost per success counts every run's spend, errors included.
    const costs = rs.map((r) => r.costUsd);
    const costUsd = costs.some((c) => c === null) ? null : sum(costs as number[]);
    const memory = rs.map((r) => (r.costByPurpose.checkpoint ?? 0) + (r.costByPurpose.dream ?? 0));
    const info = rs.flatMap((r) => r.checks.filter((c) => c.informational));
    return {
      suite,
      group,
      config,
      model: rs[0].model,
      runs: rs.length,
      pass,
      fail,
      error: rs.length - pass - fail,
      passRate: pass + fail ? pass / (pass + fail) : null,
      ci95: wilson(pass, pass + fail),
      costUsd,
      costPerSuccess: costUsd === null || pass === 0 ? null : costUsd / pass,
      memoryShare: costUsd ? sum(memory) / costUsd : null,
      observed: info.length ? info.filter((c) => c.pass).length / info.length : null,
      meanTokens: mean(rs.map((r) => r.tokens.input + r.tokens.cacheRead + r.tokens.cacheWrite + r.tokens.output)),
      meanRollovers: mean(rs.map((r) => r.rollovers)),
      meanWallS: mean(rs.map((r) => r.wallMs / 1000)),
    };
  });
}

const pct = (x: number | null) => (x === null ? "–" : `${Math.round(x * 100)}%`);
const usd = (x: number | null) => (x === null ? "unknown" : `$${x.toFixed(x < 1 ? 3 : 2)}`);

export function markdown(campaign: string, rows: Row[], notes: string[]): string {
  const lines = [`# ${campaign}`, ""];
  for (const suite of ["memory", "cost"]) {
    const rs = rows.filter((r) => r.suite === suite);
    if (!rs.length) continue;
    lines.push(
      `## ${suite === "memory" ? "Memory" : "Cost per task"}`,
      "",
      `| ${suite === "memory" ? "Variant" : "Tier"} | Config | Model | Pass | 95% CI | Errors | Observed | Cost | Per success | Memory share | Tokens/run | Rollovers | Time/run |`,
      "|---|---|---|---|---|---|---|---|---|---|---|---|---|",
      ...rs.map(
        (r) =>
          `| ${r.group} | ${r.config} | ${r.model} | ${r.pass}/${r.pass + r.fail} (${pct(r.passRate)}) | ${r.ci95 ? `${pct(r.ci95[0])}–${pct(r.ci95[1])}` : "–"} | ${r.error} | ${pct(r.observed)} | ${usd(r.costUsd)} | ${r.pass === 0 ? "no passes" : usd(r.costPerSuccess)} | ${pct(r.memoryShare)} | ${Math.round(r.meanTokens).toLocaleString("en-US")} | ${r.meanRollovers.toFixed(1)} | ${Math.round(r.meanWallS)}s |`,
      ),
      "",
    );
  }
  lines.push("Observed: the share of informational checks that held (for example, a fact saved to memory). They are reported, not counted in Pass.", "");
  if (notes.length) lines.push("## Notes", "", ...notes.map((n) => `- ${n}`), "");
  return lines.join("\n");
}

/** Every result.json under a results directory. */
export async function collect(dir: string): Promise<RunResult[]> {
  const out: RunResult[] = [];
  for (const e of await fs.readdir(dir, { withFileTypes: true, recursive: true })) {
    if (e.isFile() && e.name === "result.json") out.push(JSON.parse(await fs.readFile(path.join(e.parentPath, e.name), "utf8")));
  }
  return out;
}

export async function writeReport(dir: string, campaign: string, notes: string[] = []): Promise<string> {
  const results = await collect(dir);
  const rows = summarize(results);
  if (results.some((r) => r.variant === "rollover"))
    notes = [...notes, "Rollover runs use the config's small contextTokens to force a rollover (a local variant); other variants use the model's real context window."];
  const md = markdown(campaign, rows, notes);
  await fs.writeFile(path.join(dir, "summary.json"), JSON.stringify(rows, null, 2));
  await fs.writeFile(path.join(dir, "summary.md"), md);
  return md;
}
