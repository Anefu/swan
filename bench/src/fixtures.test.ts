import { spawnSync } from "node:child_process";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, describe, expect, it } from "vitest";

// Oracle checks for fixtures with hidden checks: the shipped workspace must fail them and the
// reference solution must pass, so a failure in a run is the agent's, not the environment's.
const bench = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const tmp: string[] = [];
afterAll(() => Promise.all(tmp.map((d) => fs.rm(d, { recursive: true, force: true }))));

async function workspace(fixture: string, gold: string, solved: boolean) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "bench-oracle-"));
  tmp.push(dir);
  await fs.cp(path.join(bench, "fixtures", fixture), dir, { recursive: true });
  await fs.cp(path.join(bench, "gold", gold), path.join(dir, ".gold"), { recursive: true });
  if (solved) await fs.cp(path.join(bench, "gold", gold, "solution"), dir, { recursive: true });
  return dir;
}
const node = (cwd: string, ...args: string[]) => spawnSync(process.execPath, args, { cwd, encoding: "utf8" });

describe("ledger-lib oracle", () => {
  it("the shipped library fails the hidden checks but passes its own tests", async () => {
    const dir = await workspace("ledger-lib", "ledger-lib", false);
    const r = node(dir, ".gold/check.cjs");
    expect(r.status).toBe(1);
    expect(r.stdout).toContain("fixed 0/12; broke 0/12");
    expect(node(dir, "--test").status).toBe(0);
    expect(node(dir, ".gold/legacy-unchanged.cjs").status).toBe(0);
  });

  it("the reference fix passes every hidden check and keeps legacy untouched", async () => {
    const dir = await workspace("ledger-lib", "ledger-lib", true);
    const r = node(dir, ".gold/check.cjs");
    expect(r.stdout).toContain("fixed 12/12; broke 0/12");
    expect(r.status).toBe(0);
    expect(node(dir, "--test").status).toBe(0);
    expect(node(dir, ".gold/legacy-unchanged.cjs").status).toBe(0);
  });

  it("notices an edit under src/legacy", async () => {
    const dir = await workspace("ledger-lib", "ledger-lib", true);
    await fs.appendFile(path.join(dir, "src/legacy/billing-v1.js"), "\n// touched\n");
    expect(node(dir, ".gold/legacy-unchanged.cjs").status).toBe(1);
  });
});
