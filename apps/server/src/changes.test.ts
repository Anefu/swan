import { execFileSync } from "node:child_process";
import { existsSync, promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ChangeTracker, findGit, parsePatch } from "./changes.js";

let dir: string;
let t: ChangeTracker;
const SID = "changes-test";
const read = (scope: "conversation" | "turn" = "conversation") => t.diff(SID, [{ hostPath: dir, name: "work" }], scope);

beforeEach(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), "swan-changes-"));
  t = new ChangeTracker();
  await t.removeSession(SID);
});
afterEach(async () => {
  await t.removeSession(SID);
  await fs.rm(dir, { recursive: true, force: true });
});

describe("what the agent changed in a folder", () => {
  it("finds edits, new and deleted files in a folder that isn't a repository", async () => {
    await fs.writeFile(path.join(dir, "a.txt"), "one\ntwo\nthree\n");
    await fs.writeFile(path.join(dir, "gone.txt"), "bye\n");
    await t.snapshot(SID, [dir]);
    expect((await read()).files).toEqual([]);

    await fs.writeFile(path.join(dir, "a.txt"), "one\nTWO\nthree\n");
    await fs.writeFile(path.join(dir, "b file.txt"), "new\n");
    await fs.rm(path.join(dir, "gone.txt"));
    const r = await read();
    expect(r.files.map((f) => [f.path, f.status, f.additions, f.deletions])).toEqual([
      ["a.txt", "modified", 1, 1],
      ["b file.txt", "added", 1, 0],
      ["gone.txt", "deleted", 0, 1],
    ]);
    expect(r).toMatchObject({ additions: 2, deletions: 2, problems: [] });
    expect(r.files[0]!.hunks[0]!.lines).toEqual([
      { kind: "ctx", old: 1, new: 1, text: "one" },
      { kind: "del", old: 2, text: "two" },
      { kind: "add", new: 2, text: "TWO" },
      { kind: "ctx", old: 3, new: 3, text: "three" },
    ]);
  });

  it("compares with the last turn or the whole conversation", async () => {
    await fs.writeFile(path.join(dir, "a.txt"), "1\n");
    await t.snapshot(SID, [dir]);
    await fs.writeFile(path.join(dir, "a.txt"), "2\n");
    await t.snapshot(SID, [dir]);
    await fs.writeFile(path.join(dir, "b.txt"), "x\n");
    expect((await read("conversation")).files.map((f) => f.path)).toEqual(["a.txt", "b.txt"]);
    expect((await read("turn")).files.map((f) => f.path)).toEqual(["b.txt"]);
  });

  it("honours .gitignore, skips node_modules, and leaves the folder alone", async () => {
    await fs.writeFile(path.join(dir, ".gitignore"), "*.log\n");
    await t.snapshot(SID, [dir]);
    await fs.writeFile(path.join(dir, "x.log"), "noise\n");
    await fs.mkdir(path.join(dir, "node_modules"));
    await fs.writeFile(path.join(dir, "node_modules", "m.js"), "x\n");
    await fs.writeFile(path.join(dir, "real.txt"), "y\n");
    expect((await read()).files.map((f) => f.path)).toEqual(["real.txt"]);
    expect(existsSync(path.join(dir, ".git"))).toBe(false);
  });

  it("reports binary files without their content, and cuts very long diffs but keeps the counts", async () => {
    await t.snapshot(SID, [dir]);
    await fs.writeFile(path.join(dir, "b.bin"), Buffer.from([0, 1, 2, 0, 255]));
    await fs.writeFile(path.join(dir, "long.txt"), "x\n".repeat(3000));
    const r = await read();
    expect(r.files.find((f) => f.path === "b.bin")).toMatchObject({ binary: true, hunks: [] });
    const long = r.files.find((f) => f.path === "long.txt")!;
    expect(long).toMatchObject({ additions: 3000, truncated: true });
    expect(long.hunks[0]!.lines).toHaveLength(2000);
  });
});

// The folders are writable from the sandbox, and git runs on the host: nothing in them may run there.
describe("a folder the agent has tampered with", () => {
  it("runs nothing from the repository's config, hooks or attributes", async () => {
    const marker = path.join(os.tmpdir(), `swan-pwned-${process.pid}`);
    await fs.rm(marker, { force: true });
    execFileSync("git", ["init", "-q"], { cwd: dir });
    const evil = path.join(dir, "evil.sh");
    await fs.writeFile(evil, `#!/bin/sh\ntouch ${marker}\ncat\n`, { mode: 0o755 });
    await fs.appendFile(
      path.join(dir, ".git", "config"),
      `[core]\n  fsmonitor = ${evil}\n  hooksPath = ${dir}\n[filter "evil"]\n  clean = ${evil}\n  smudge = ${evil}\n[diff "evil"]\n  textconv = ${evil}\n  command = ${evil}\n[diff]\n  external = ${evil}\n`,
    );
    await fs.writeFile(path.join(dir, ".gitattributes"), "* filter=evil diff=evil\n");
    await t.snapshot(SID, [dir]);
    await fs.writeFile(path.join(dir, "a.txt"), "changed\n");
    const r = await read();
    expect(r.files.map((f) => f.path)).toContain("a.txt");
    expect(existsSync(marker)).toBe(false);
  });

  it("ignores the user's global git config, which may name real filters", async () => {
    const marker = path.join(os.tmpdir(), `swan-pwned-global-${process.pid}`);
    await fs.rm(marker, { force: true });
    const home = await fs.mkdtemp(path.join(os.tmpdir(), "swan-home-"));
    await fs.writeFile(path.join(home, ".gitconfig"), `[filter "lfs"]\n  clean = touch ${marker}\n  required = true\n`);
    const before = process.env.HOME;
    process.env.HOME = home;
    try {
      await fs.writeFile(path.join(dir, ".gitattributes"), "* filter=lfs\n");
      await t.snapshot(SID, [dir]);
      await fs.writeFile(path.join(dir, "a.txt"), "x\n");
      expect((await read()).problems).toEqual([]);
      expect(existsSync(marker)).toBe(false);
    } finally {
      process.env.HOME = before;
      await fs.rm(home, { recursive: true, force: true });
    }
  });

  it("shows a symlink as a link, never what it points at", async () => {
    const outside = path.join(os.tmpdir(), `swan-outside-${process.pid}.txt`);
    await fs.writeFile(outside, "THE-HOST-SECRET\n");
    await t.snapshot(SID, [dir]);
    await fs.symlink(outside, path.join(dir, "link"));
    const r = await read();
    expect(JSON.stringify(r)).not.toContain("THE-HOST-SECRET");
    expect(r.files[0]!.hunks[0]!.lines[0]!.text).toBe(outside);
    await fs.rm(outside);
  });

  it("gives git no secrets from Swan's environment", async () => {
    process.env.SWAN_TEST_SECRET = "s3cret";
    const seen = path.join(os.tmpdir(), `swan-env-${process.pid}.txt`);
    const wrapper = path.join(os.tmpdir(), `swan-git-${process.pid}.sh`);
    await fs.writeFile(wrapper, `#!/bin/sh\nenv >> ${seen}\nexec ${findGit()} "$@"\n`, { mode: 0o755 });
    try {
      await new ChangeTracker(wrapper).snapshot(SID, [dir]);
      const env = await fs.readFile(seen, "utf8");
      expect(env).toContain("GIT_CONFIG_GLOBAL=/dev/null");
      expect(env).not.toContain("s3cret");
    } finally {
      delete process.env.SWAN_TEST_SECRET;
      await fs.rm(seen, { force: true });
      await fs.rm(wrapper, { force: true });
    }
  });
});

describe("reading a patch", () => {
  it("handles renames and quoted names", () => {
    const files = parsePatch(
      'diff --git a/old.txt b/new.txt\nsimilarity index 90%\nrename from old.txt\nrename to new.txt\ndiff --git "a/caf\\303\\251.txt" "b/caf\\303\\251.txt"\n--- "a/caf\\303\\251.txt"\n+++ "b/caf\\303\\251.txt"\n@@ -1 +1 @@\n-a\n+b\n',
      "work",
    );
    expect(files[0]).toMatchObject({ path: "new.txt", oldPath: "old.txt", status: "renamed" });
    expect(files[1]).toMatchObject({ path: "café.txt", additions: 1, deletions: 1 });
  });
});
