import { promises as fs } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

// The Compact-Bench port of Swan's checkpoint must match Swan's own rollover, or the benchmark
// measures something Swan does not do.
const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const read = (p: string) => fs.readFile(path.join(repo, p), "utf8");

/** A single-quoted Python string literal, unescaped. */
function pyString(src: string, key: string): string {
  const m = new RegExp(`"${key}": '((?:[^'\\\\]|\\\\.)*)'`).exec(src);
  if (!m) throw new Error(`no ${key} in swan_checkpoint.py`);
  return m[1].replace(/\\'/g, "'").replace(/\\\\/g, "\\");
}

describe("Compact-Bench port of Swan's checkpoint", () => {
  it("uses Swan's checkpoint prompts verbatim", async () => {
    const ts = await read("apps/server/src/agent/session.ts");
    const py = await read("bench/compact-bench/swan_checkpoint.py");
    const system = /"(You write checkpoints[^"]+)"/.exec(ts)![1];
    expect(py).toContain(`SYSTEM = "${system}"`);
    const [minimal, full] = [...ts.slice(ts.indexOf('strategy === "minimal"\n        ? `')).matchAll(/`([^`]+)`/g)].slice(0, 2).map((m) => m[1]);
    expect(pyString(py, "swan-minimal")).toBe(minimal);
    expect(pyString(py, "swan-full")).toBe(full);
  });

  it("uses Swan's limits for the transcript, tool output and carried events", async () => {
    const ts = await read("apps/server/src/agent/session.ts");
    const py = await read("bench/compact-bench/swan_checkpoint.py");
    expect(ts).toContain("map(itemLine).filter(Boolean).join(\"\\n\\n\"), 150_000)");
    expect(py).toContain("TRANSCRIPT_CAP = 150_000");
    expect(ts).toContain("truncateMiddle(it.output, 1200)");
    expect(py).toContain("truncate_middle(out, 1200)");
    expect(ts).toContain('strategy === "full" ? 16_000 : 4_000');
    expect(ts).toContain('strategy === "full" ? -24 : -6');
    expect(py).toContain('TAIL = {"swan-full": (24, 16_000), "swan-minimal": (6, 4_000)}');
    expect(ts).toContain('effort: "low"');
    expect(py).toContain('"effort": "low"');
  });
});
