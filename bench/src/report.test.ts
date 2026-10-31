import { describe, expect, it } from "vitest";
import { summarize, wilson } from "./report.js";
import type { RunResult } from "./run.js";

const run = (status: RunResult["status"], costUsd: number | null, purpose: Record<string, number> = {}): RunResult => ({
  campaign: "c",
  caseId: "k",
  suite: "memory",
  tier: "easy",
  variant: "rollover",
  configId: "cfg",
  model: "anthropic/m",
  trial: 1,
  status,
  checks: [],
  costUsd,
  costByPurpose: purpose,
  tokens: { input: 10, output: 5, cacheRead: 80, cacheWrite: 5 },
  requests: 3,
  rollovers: 1,
  conversations: 1,
  deniedApprovals: 0,
  wallMs: 30_000,
});

describe("report", () => {
  it("gives a Wilson interval that stays inside 0..1", () => {
    expect(wilson(0, 0)).toBeNull();
    const [lo, hi] = wilson(3, 4)!;
    expect(lo).toBeGreaterThan(0.2);
    expect(hi).toBeLessThanOrEqual(1);
  });

  it("charges every run's cost, errors included, to the successes, and keeps errors out of the pass rate", () => {
    const [row] = summarize([run("pass", 1, { checkpoint: 0.2 }), run("fail", 1), run("error", 2)]);
    expect(row).toMatchObject({ runs: 3, pass: 1, fail: 1, error: 1, passRate: 0.5, costUsd: 4, costPerSuccess: 4 });
    expect(row.memoryShare).toBeCloseTo(0.05);
  });

  it("reports an unknown cost when any run has no price", () => {
    const [row] = summarize([run("pass", 1), run("pass", null)]);
    expect(row.costUsd).toBeNull();
    expect(row.costPerSuccess).toBeNull();
  });
});
