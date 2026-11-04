import { execFile, execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, promises as fs } from "node:fs";
import path from "node:path";
import type { ChangedFile, ChangeLine, ChangesReport, ChangeScope } from "@ph/shared";
import { paths } from "./settings.js";
import { errMsg } from "./util.js";

const MAX_OUTPUT = 8_000_000;
const FILE_LINES = 2000; // lines shown per file
const TOTAL_LINES = 20_000;
const SNAPSHOT_MS = 120_000;
const EXCLUDE = "node_modules/\n.venv/\nvenv/\n__pycache__/\n.DS_Store\n";

/** Git on this Mac, without touching /usr/bin/git's stub, which opens an install dialog when the tools are missing. */
export function findGit(): string | null {
  if (process.platform !== "darwin") return "git";
  for (const p of ["/opt/homebrew/bin/git", "/usr/local/bin/git"]) if (existsSync(p)) return p;
  try {
    execFileSync("/usr/bin/xcode-select", ["-p"], { stdio: "ignore" });
    return "/usr/bin/git";
  } catch {
    return null;
  }
}

/**
 * What the agent changed in a persona's read-write folders, from snapshots Swan keeps itself, on the
 * host. The folders hold whatever the agent wrote, so git runs with Swan's own git dir and no
 * config from anywhere else: a repository's .git (config, hooks, fsmonitor) is never read, and
 * filters and diff drivers named in .gitattributes have nothing to run. Its environment is built
 * here, so no secret reaches it. Symlinks are stored as links and not followed.
 */
export class ChangeTracker {
  private chains = new Map<string, Promise<unknown>>();
  private counts = new Map<string, number>();

  constructor(private git: string | null = findGit()) {}

  private root(sessionId: string) {
    return path.join(paths.home, "changes", sessionId);
  }

  private dir(sessionId: string, folder: string) {
    return path.join(this.root(sessionId), createHash("sha256").update(folder).digest("hex").slice(0, 16));
  }

  private run(gitDir: string, folder: string, args: string[], timeout = SNAPSHOT_MS): Promise<string> {
    const env = {
      PATH: "/usr/bin:/bin",
      HOME: gitDir,
      GIT_DIR: gitDir,
      GIT_WORK_TREE: folder,
      GIT_CONFIG_NOSYSTEM: "1",
      GIT_CONFIG_GLOBAL: "/dev/null",
      GIT_OPTIONAL_LOCKS: "0",
      GIT_TERMINAL_PROMPT: "0",
    };
    const safe = ["-c", "core.quotepath=false", "-c", "core.autocrlf=false", "-c", "core.safecrlf=false", "-c", "core.fsmonitor=false", "-c", "core.hooksPath=/dev/null", "-c", "gc.auto=0", "-c", "advice.addEmbeddedRepo=false"];
    return new Promise((resolve, reject) => {
      execFile(this.git!, [...safe, ...args], { cwd: folder, env, timeout, maxBuffer: MAX_OUTPUT, killSignal: "SIGKILL" }, (e, stdout, stderr) => {
        if (e) reject(new Error((stderr || e.message).trim().slice(0, 400)));
        else resolve(stdout);
      });
    });
  }

  /** One at a time per session: they share an index. */
  private serial<T>(sessionId: string, fn: () => Promise<T>): Promise<T> {
    const run = (this.chains.get(sessionId) ?? Promise.resolve()).then(fn, fn);
    this.chains.set(sessionId, run.catch(() => {}));
    return run;
  }

  /** The folder's current state as a tree in Swan's git dir. */
  private async tree(gitDir: string, folder: string): Promise<string> {
    if (!existsSync(path.join(gitDir, "HEAD"))) {
      await fs.mkdir(gitDir, { recursive: true });
      await this.run(gitDir, folder, ["init", "-q", "--template="]);
      await fs.mkdir(path.join(gitDir, "info"), { recursive: true });
      await fs.writeFile(path.join(gitDir, "info", "exclude"), EXCLUDE);
    }
    await this.run(gitDir, folder, ["add", "-A", "--", "."]);
    return (await this.run(gitDir, folder, ["write-tree"])).trim();
  }

  /** Record the start of a turn, and of the conversation if this is its first. A folder that fails is simply not tracked for it. */
  snapshot(sessionId: string, folders: string[]): Promise<void> {
    if (!this.git) return Promise.resolve();
    return this.serial(sessionId, async () => {
      for (const folder of folders) {
        const gitDir = this.dir(sessionId, folder);
        try {
          const tree = await this.tree(gitDir, folder);
          await this.run(gitDir, folder, ["update-ref", "refs/swan/turn", tree]);
          const hasStart = await this.run(gitDir, folder, ["rev-parse", "-q", "--verify", "refs/swan/conversation"]).then(() => true, () => false);
          if (!hasStart) await this.run(gitDir, folder, ["update-ref", "refs/swan/conversation", tree]);
        } catch {
          // Reported when the changes are read.
        }
      }
      // The previous turns' snapshots are unreferenced now: clear them now and then.
      const n = (this.counts.get(sessionId) ?? 0) + 1;
      this.counts.set(sessionId, n);
      if (n % 25 === 0) for (const folder of folders) await this.run(this.dir(sessionId, folder), folder, ["gc", "-q", "--prune=now"]).catch(() => {});
    });
  }

  /** The changes since a snapshot. */
  diff(sessionId: string, folders: { hostPath: string; name: string }[], scope: ChangeScope): Promise<ChangesReport> {
    const empty: ChangesReport = { scope, files: [], additions: 0, deletions: 0, problems: [] };
    if (!this.git) return Promise.resolve({ ...empty, problems: ["Showing changes needs git on your Mac. Install it with: xcode-select --install"] });
    return this.serial(sessionId, async () => {
      const report = { ...empty, files: [] as ChangedFile[], problems: [] as string[] };
      let budget = TOTAL_LINES;
      for (const f of folders) {
        const gitDir = this.dir(sessionId, f.hostPath);
        if (!existsSync(path.join(gitDir, "HEAD"))) continue; // nothing recorded yet
        try {
          const base = (await this.run(gitDir, f.hostPath, ["rev-parse", "-q", "--verify", `refs/swan/${scope}`])).trim();
          const now = await this.tree(gitDir, f.hostPath);
          if (base === now) continue;
          const patch = await this.run(gitDir, f.hostPath, ["diff-tree", "-r", "-p", "-M", "-U3", "--no-color", "--no-ext-diff", "--no-textconv", "--ignore-submodules=all", base, now]);
          for (const file of parsePatch(patch, f.name)) {
            budget = limit(file, budget);
            report.files.push(file);
            report.additions += file.additions;
            report.deletions += file.deletions;
          }
        } catch (e) {
          report.problems.push(`Couldn't read the changes in ${f.name}: ${errMsg(e)}`);
        }
      }
      return report;
    });
  }

  async removeSession(sessionId: string) {
    await fs.rm(this.root(sessionId), { recursive: true, force: true });
    this.chains.delete(sessionId);
    this.counts.delete(sessionId);
  }
}

/** Keep counts whole, and cut the lines sent to the app. */
function limit(file: ChangedFile, budget: number): number {
  const room = Math.min(budget, FILE_LINES);
  let used = 0;
  const hunks: ChangedFile["hunks"] = [];
  for (const h of file.hunks) {
    if (used >= room) {
      file.truncated = true;
      break;
    }
    const lines = h.lines.slice(0, room - used);
    if (lines.length < h.lines.length) file.truncated = true;
    used += lines.length;
    hunks.push({ ...h, lines });
  }
  file.hunks = hunks;
  return budget - used;
}

/** Git quotes unusual names; decode those it did. */
function unquote(p: string): string {
  const s = p.replace(/\t$/, "");
  if (!s.startsWith('"')) return s;
  const body = s.slice(1, -1);
  const bytes: number[] = [];
  for (let i = 0; i < body.length; i++) {
    if (body[i] !== "\\") {
      bytes.push(...Buffer.from(body[i]!));
      continue;
    }
    const n = body[++i]!;
    if (/[0-7]/.test(n)) {
      bytes.push(parseInt(body.slice(i, i + 3), 8));
      i += 2;
    } else bytes.push(({ t: 9, n: 10, r: 13 } as Record<string, number>)[n] ?? n.charCodeAt(0));
  }
  return Buffer.from(bytes).toString("utf8");
}

export function parsePatch(patch: string, folder: string): ChangedFile[] {
  const files: ChangedFile[] = [];
  let f: ChangedFile | null = null;
  let oldNo = 0;
  let newNo = 0;
  for (const line of patch.split("\n")) {
    if (line.startsWith("diff --git ")) {
      // The names are only sure in the lines that follow; this one covers a file with no content lines.
      const m = /^diff --git (?:"?a\/)(.*?)"? (?:"?b\/)(.*)$/.exec(line);
      const name = m ? unquote(m[2]!.startsWith('"') ? m[2]! : m[2]!.replace(/"$/, "")) : "";
      f = { folder, path: name, status: "modified", additions: 0, deletions: 0, binary: false, truncated: false, hunks: [] };
      files.push(f);
      continue;
    }
    if (!f) continue;
    const hunk = f.hunks[f.hunks.length - 1];
    if (line.startsWith("@@ ")) {
      const m = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(line);
      oldNo = Number(m?.[1] ?? 0);
      newNo = Number(m?.[2] ?? 0);
      f.hunks.push({ header: line, lines: [] });
    } else if (hunk) {
      const c = line[0];
      let l: ChangeLine | null = null;
      if (c === "+") {
        f.additions++;
        l = { kind: "add", new: newNo++, text: line.slice(1) };
      } else if (c === "-") {
        f.deletions++;
        l = { kind: "del", old: oldNo++, text: line.slice(1) };
      } else if (c === " ") l = { kind: "ctx", old: oldNo++, new: newNo++, text: line.slice(1) };
      if (l) hunk.lines.push(l);
    } else if (line.startsWith("new file")) f.status = "added";
    else if (line.startsWith("deleted file")) f.status = "deleted";
    else if (line.startsWith("rename from ")) {
      f.status = "renamed";
      f.oldPath = unquote(line.slice(12));
    } else if (line.startsWith("rename to ")) f.path = unquote(line.slice(10));
    else if (line.startsWith("--- ") && f.status === "deleted") f.path = unquote(line.slice(4)).replace(/^a\//, "");
    else if (line.startsWith("+++ ") && !line.startsWith("+++ /dev/null")) f.path = unquote(line.slice(4)).replace(/^b\//, "");
    else if (line.startsWith("Binary files ")) f.binary = true;
  }
  return files;
}
