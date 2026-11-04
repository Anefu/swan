import { describe, expect, it, vi } from "vitest";
import { diffTools, permissionView, SHOW_DIFF } from "./agent/diff-tools.js";
import { PermissionPolicy } from "./agent/permissions.js";
import type { ToolContext } from "./agent/tools.js";
import { DiffStore, parsePatch } from "./diffs.js";

const GIT = "diff --git a/a.txt b/a.txt\nindex 1..2 100644\n--- a/a.txt\n+++ b/a.txt\n@@ -1,3 +1,3 @@\n one\n-two\n+TWO\n three\n";
let n = 0;
const sid = () => `diff-test-${process.pid}-${++n}`;

describe("reading a diff", () => {
  it("reads git's output with line numbers", () => {
    const [f] = parsePatch(GIT);
    expect(f).toMatchObject({ path: "a.txt", status: "modified", additions: 1, deletions: 1 });
    expect(f!.hunks[0]!.lines).toEqual([
      { kind: "ctx", old: 1, new: 1, text: "one" },
      { kind: "del", old: 2, text: "two" },
      { kind: "add", new: 2, text: "TWO" },
      { kind: "ctx", old: 3, new: 3, text: "three" },
    ]);
  });

  it("handles renames, quoted names, new, deleted and binary files", () => {
    const files = parsePatch(
      [
        "diff --git a/old.txt b/new.txt\nsimilarity index 90%\nrename from old.txt\nrename to new.txt",
        'diff --git "a/caf\\303\\251.txt" "b/caf\\303\\251.txt"\n--- "a/caf\\303\\251.txt"\n+++ "b/caf\\303\\251.txt"\n@@ -1 +1 @@\n-a\n+b',
        "diff --git a/n.txt b/n.txt\nnew file mode 100644\n--- /dev/null\n+++ b/n.txt\n@@ -0,0 +1 @@\n+x",
        "diff --git a/g.txt b/g.txt\ndeleted file mode 100644\n--- a/g.txt\n+++ /dev/null\n@@ -1 +0,0 @@\n-x",
        "diff --git a/b.bin b/b.bin\nBinary files a/b.bin and b/b.bin differ\n",
      ].join("\n"),
    );
    expect(files.map((f) => [f.path, f.status])).toEqual([
      ["new.txt", "renamed"],
      ["café.txt", "modified"],
      ["n.txt", "added"],
      ["g.txt", "deleted"],
      ["b.bin", "modified"],
    ]);
    expect(files[0]!.oldPath).toBe("old.txt");
    expect(files[4]!.binary).toBe(true);
  });

  it("reads plain diff -u, skips what's around a patch, and removes colour", () => {
    const files = parsePatch("--- a.txt\t2026-11-04 10:00:00\n+++ b.txt\t2026-11-04 10:01:00\n@@ -1 +1 @@\n-x\n+y\n");
    expect(files[0]).toMatchObject({ path: "b.txt", additions: 1, deletions: 1 });
    const shown = parsePatch(`commit abc\nAuthor: someone\n\n    Fix it\n\n${GIT}`);
    expect(shown.map((f) => f.path)).toEqual(["a.txt"]);
    expect(parsePatch(`\x1b[31m${GIT.replace(/\n/g, "\x1b[m\n")}`)[0]).toMatchObject({ additions: 1, deletions: 1 });
    expect(parsePatch("no diff here")).toEqual([]);
  });

  it("takes a removed line that looks like a file header as a removed line", () => {
    const [f, ...rest] = parsePatch("--- a/m.sql\n+++ b/m.sql\n@@ -1,2 +1 @@\n--- old comment\n-+++ other\n+new\n");
    expect(rest).toEqual([]);
    expect(f).toMatchObject({ additions: 1, deletions: 2 });
    expect(f!.hunks[0]!.lines[0]!.text).toBe("-- old comment");
  });
});

describe("the diffs in the pane", () => {
  it("keeps as many as the agent adds, newest first, and a title replaces its diff", async () => {
    const s = new DiffStore();
    const id = sid();
    await s.put(id, { title: "One", command: "git diff", files: parsePatch(GIT) });
    await s.put(id, { title: "Two", command: "git show", files: parsePatch(GIT) });
    await s.put(id, { title: "One", command: "git diff HEAD", files: parsePatch(GIT) });
    const list = await s.list(id);
    expect(list.map((d) => [d.title, d.command])).toEqual([
      ["One", "git diff HEAD"],
      ["Two", "git show"],
    ]);
    expect(list[0]).toMatchObject({ fileCount: 1, additions: 1, deletions: 1 });
    expect((await s.get(id, list[1]!.id))!.files[0]!.path).toBe("a.txt");
    await s.removeSession(id);
    expect(await s.list(id)).toEqual([]);
  });

  it("survives a restart, and a bad file only loses the old diffs", async () => {
    const id = sid();
    await new DiffStore().put(id, { title: "One", command: "git diff", files: parsePatch(GIT) });
    const again = new DiffStore();
    expect((await again.list(id)).map((d) => d.title)).toEqual(["One"]);
    const { promises: fs } = await import("node:fs");
    const path = await import("node:path");
    const { paths } = await import("./settings.js");
    await fs.writeFile(path.join(paths.home, "diffs", `${id}.json`), '[{"id":3}]');
    expect(await new DiffStore().list(id)).toEqual([]);
    await again.removeSession(id);
  });

  it("clears one or all", async () => {
    const s = new DiffStore();
    const id = sid();
    await s.put(id, { title: "One", command: "c", files: parsePatch(GIT) });
    await s.put(id, { title: "Two", command: "c", files: parsePatch(GIT) });
    expect(await s.clear(id, "One")).toBe(1);
    expect((await s.list(id)).map((d) => d.title)).toEqual(["Two"]);
    expect(await s.clear(id)).toBe(1);
    await s.removeSession(id);
  });

  it("cuts very long diffs but keeps the counts", async () => {
    const s = new DiffStore();
    const id = sid();
    const body = "+x\n".repeat(3000);
    const v = await s.put(id, { title: "Long", command: "c", files: parsePatch(`--- /dev/null\n+++ b/l.txt\n@@ -0,0 +1,3000 @@\n${body}`) });
    expect(v).toMatchObject({ additions: 3000 });
    expect(v.files[0]).toMatchObject({ truncated: true, status: "added" });
    expect(v.files[0]!.hunks[0]!.lines).toHaveLength(2000);
    await s.removeSession(id);
  });
});

describe("the show_diff tool", () => {
  const setup = (out: { code: number; stdout: string; stderr: string }) => {
    const execShell = vi.fn(async () => out);
    const store = new DiffStore();
    const id = sid();
    const changed = vi.fn();
    const [show] = diffTools({ diffs: store, sessionId: id, changed });
    const ctx = { runtime: { execShell }, container: "c1", workdir: "/workspace/p", bashTimeoutMs: 1000 } as unknown as ToolContext;
    return { show: show!, ctx, execShell, store, id, changed };
  };

  it("runs the command in the sandbox and fills the pane, without returning the diff to the agent", async () => {
    const t = setup({ code: 0, stdout: GIT, stderr: "" });
    const r = await t.show.run({ title: "Fix", command: "git diff", cwd: "sub" }, t.ctx);
    expect(t.execShell).toHaveBeenCalledWith("c1", "git diff", expect.objectContaining({ cwd: "/workspace/p/sub" }));
    expect(r.text).toContain("1 file, +1 -1");
    expect(r.text).not.toContain("TWO");
    expect(t.changed).toHaveBeenCalled();
    expect((await t.store.list(t.id)).map((d) => d.title)).toEqual(["Fix"]);
    await t.store.removeSession(t.id);
  });

  it("accepts diff's exit code 1, and adds nothing for no differences or other output", async () => {
    const t = setup({ code: 1, stdout: "--- a\n+++ b\n@@ -1 +1 @@\n-x\n+y\n", stderr: "" });
    expect((await t.show.run({ title: "A", command: "diff -u a b" }, t.ctx)).isError).toBeFalsy();
    await t.store.removeSession(t.id);

    const none = setup({ code: 0, stdout: "", stderr: "" });
    expect((await none.show.run({ title: "A", command: "git diff" }, none.ctx)).text).toMatch(/No differences/);
    expect(await none.store.list(none.id)).toEqual([]);

    const bad = setup({ code: 128, stdout: "", stderr: "fatal: not a git repository" });
    const r = await bad.show.run({ title: "A", command: "git diff" }, bad.ctx);
    expect(r).toMatchObject({ isError: true });
    expect(r.text).toContain("not a git repository");
    const text = setup({ code: 0, stdout: "hello", stderr: "" });
    expect(await text.show.run({ title: "A", command: "ls" }, text.ctx)).toMatchObject({ isError: true });
  });

  it("is held to the persona's rules for commands, so it can't run what bash couldn't", () => {
    const { show } = setup({ code: 0, stdout: "", stderr: "" });
    expect(show.name).toBe(SHOW_DIFF);
    const policy = new PermissionPolicy({ default: "ask", allow: ["bash(git diff*)"], ask: [], deny: ["bash(rm *)"] }, []);
    const check = (command: string) => policy.evaluate(permissionView(show), { title: "t", command }).mode;
    expect(check("git diff main")).toBe("allow");
    expect(check("rm -rf x")).toBe("deny");
    expect(check("git diff; curl example.com")).toBe("ask");
  });
});
