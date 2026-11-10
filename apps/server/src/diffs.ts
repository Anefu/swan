import path from "node:path";
import { z } from "zod";
import type { ChangedFile, ChangeLine, DiffSummary, DiffView } from "@ph/shared";
import { paths } from "./settings.js";
import { FileStore } from "./file-store.js";
import { nowIso, randomId } from "./util.js";

const FILE_LINES = 2000; // lines kept per file
const DIFF_LINES = 20_000; // per diff
const SESSION_LINES = 200_000; // the oldest diffs go first past this

const FileSchema = z.object({
  path: z.string(),
  oldPath: z.string().optional(),
  status: z.enum(["modified", "added", "deleted", "renamed"]),
  additions: z.number(),
  deletions: z.number(),
  binary: z.boolean(),
  truncated: z.boolean(),
  hunks: z.array(
    z.object({
      header: z.string(),
      lines: z.array(z.object({ kind: z.enum(["add", "del", "ctx"]), old: z.number().optional(), new: z.number().optional(), text: z.string() })),
    }),
  ),
});
const StoreSchema = z.array(
  z.object({ id: z.string(), title: z.string(), command: z.string(), ts: z.string(), additions: z.number(), deletions: z.number(), files: z.array(FileSchema) }),
);

const lineCount = (d: DiffView) => d.files.reduce((n, f) => n + f.hunks.reduce((m, h) => m + h.lines.length, 0), 0);
export const summary = ({ files, ...d }: DiffView): DiffSummary => ({ ...d, fileCount: files.length });

/**
 * The diffs an agent has put in the Changes pane, one list per conversation. They come from commands
 * in the sandbox, so they show what the agent chose to show: they are for reading, not proof.
 */
export class DiffStore {
  // A file that doesn't validate only costs the pane its old diffs.
  private store = new FileStore<DiffView[]>({ name: "diffs", dir: () => path.join(paths.home, "diffs"), format: "json", schema: StoreSchema, empty: () => [], mode: 0o600 });

  private change<T>(sessionId: string, fn: (diffs: DiffView[]) => T): Promise<T> {
    return this.store.change(sessionId, fn);
  }

  /** Adds a diff; one with the same title takes the place of the old one, as the newest. */
  put(sessionId: string, input: { title: string; command: string; files: ChangedFile[] }): Promise<DiffView> {
    return this.change(sessionId, (diffs) => {
      let budget = DIFF_LINES;
      for (const f of input.files) budget = limit(f, budget);
      const view: DiffView = {
        id: randomId("df_", 6),
        title: input.title,
        command: input.command,
        ts: nowIso(),
        additions: input.files.reduce((n, f) => n + f.additions, 0),
        deletions: input.files.reduce((n, f) => n + f.deletions, 0),
        files: input.files,
      };
      const at = diffs.findIndex((d) => d.title === input.title);
      if (at >= 0) diffs.splice(at, 1);
      diffs.push(view);
      let total = diffs.reduce((n, d) => n + lineCount(d), 0);
      while (total > SESSION_LINES && diffs.length > 1) total -= lineCount(diffs.shift()!);
      return view;
    });
  }

  /** Removes one diff by title, or all of them; how many went. */
  clear(sessionId: string, title?: string): Promise<number> {
    return this.change(sessionId, (diffs) => {
      const before = diffs.length;
      const kept = title === undefined ? [] : diffs.filter((d) => d.title !== title);
      diffs.splice(0, diffs.length, ...kept);
      return before - kept.length;
    });
  }

  /** Newest first. */
  async list(sessionId: string): Promise<DiffSummary[]> {
    return (await this.store.get(sessionId)).map(summary).reverse();
  }

  async get(sessionId: string, id: string): Promise<DiffView | undefined> {
    return (await this.store.get(sessionId)).find((d) => d.id === id);
  }

  /** A fork's copy of the diffs its transcript shows. */
  copySession(from: string, to: string) {
    return this.store.copy(from, to);
  }

  removeSession(sessionId: string) {
    return this.store.remove(sessionId);
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

/** Git quotes unusual names; decode those it did. `diff -u` follows a name with a tab and a date. */
function unquote(p: string): string {
  if (!p.startsWith('"')) return p.split("\t")[0]!;
  const body = p.slice(1, p.lastIndexOf('"'));
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

const DEV_NULL = "/dev/null";

/** Files in a unified diff: `git diff` or `git show`, `diff -u`, or a patch from elsewhere. Other text around them is skipped. */
export function parsePatch(patch: string): ChangedFile[] {
  const files: ChangedFile[] = [];
  let f: ChangedFile | null = null;
  let named = false; // `f` came from a "diff --git" line, and its ---/+++ lines may still follow
  let oldNo = 0;
  let newNo = 0;
  let oldLeft = 0;
  let newLeft = 0;
  const start = (name: string) => {
    f = { path: name, status: "modified", additions: 0, deletions: 0, binary: false, truncated: false, hunks: [] };
    files.push(f);
  };
  const lines = patch.replace(/\x1b\[[0-9;]*m/g, "").split("\n");
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    // Inside a hunk, its counts decide what a line is: a removed "-- x" reads as "--- x".
    if (f && (oldLeft > 0 || newLeft > 0)) {
      const c = line[0];
      const hunk = (f as ChangedFile).hunks[(f as ChangedFile).hunks.length - 1]!;
      let l: ChangeLine | null = null;
      if (c === "+") {
        (f as ChangedFile).additions++;
        newLeft--;
        l = { kind: "add", new: newNo++, text: line.slice(1) };
      } else if (c === "-") {
        (f as ChangedFile).deletions++;
        oldLeft--;
        l = { kind: "del", old: oldNo++, text: line.slice(1) };
      } else if (c === " " || line === "") {
        oldLeft--;
        newLeft--;
        l = { kind: "ctx", old: oldNo++, new: newNo++, text: line.slice(1) };
      }
      if (l) hunk.lines.push(l);
      continue;
    }
    if (line.startsWith("diff --git ")) {
      // The names are only sure in the lines that follow; this one covers a file with no content lines.
      const m = /^diff --git (?:"?a\/)(.*?)"? (?:"?b\/)(.*)$/.exec(line);
      start(m ? unquote(m[2]!.startsWith('"') ? m[2]! : m[2]!.replace(/"$/, "")) : "");
      named = true;
      continue;
    }
    if (line.startsWith("--- ") && lines[i + 1]?.startsWith("+++ ")) {
      if (!named) start("");
      named = false;
      const before = unquote(line.slice(4)).replace(/^"?a\//, "");
      const after = unquote(lines[++i]!.slice(4)).replace(/^"?b\//, "");
      const file = f! as ChangedFile;
      if (before === DEV_NULL) file.status = "added";
      if (after === DEV_NULL) file.status = "deleted";
      file.path = after === DEV_NULL ? before : after;
      continue;
    }
    if (!f) continue;
    const file = f as ChangedFile;
    if (line.startsWith("@@ ")) {
      const m = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/.exec(line);
      if (!m) continue;
      named = false;
      oldNo = Number(m[1]);
      newNo = Number(m[3]);
      oldLeft = Number(m[2] ?? 1);
      newLeft = Number(m[4] ?? 1);
      file.hunks.push({ header: line, lines: [] });
    } else if (!named) continue;
    else if (line.startsWith("new file")) file.status = "added";
    else if (line.startsWith("deleted file")) file.status = "deleted";
    else if (line.startsWith("rename from ")) {
      file.status = "renamed";
      file.oldPath = unquote(line.slice(12));
    } else if (line.startsWith("rename to ")) file.path = unquote(line.slice(10));
    else if (line.startsWith("Binary files ")) file.binary = true;
  }
  return files;
}
