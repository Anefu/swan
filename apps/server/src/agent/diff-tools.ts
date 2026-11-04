import path from "node:path";
import { z } from "zod";
import { parsePatch, type DiffStore } from "../diffs.js";
import { zodTool, type ToolDef } from "./tools.js";

export const SHOW_DIFF = "show_diff";
export const CLEAR_DIFFS = "clear_diffs";
const MAX_OUTPUT = 8_000_000;

/**
 * show_diff runs a command, so a persona's rules for commands decide it: `bash(git diff *)` allows
 * it and `deny: bash(...)` stops it, as if the agent had typed the command itself.
 */
export function permissionView(tool: ToolDef): ToolDef {
  return tool.name === SHOW_DIFF ? { ...tool, name: "bash" } : tool;
}

export function diffTools(o: { diffs: DiffStore; sessionId: string; changed: () => void }): ToolDef[] {
  const { diffs, sessionId, changed } = o;
  return [
    zodTool({
      name: SHOW_DIFF,
      description: [
        "Show the user a diff in the Changes pane beside the conversation, so they can review it. Use it after changing files, and for any diff worth reading: call it as many times as there are things to review.",
        "Give a command that prints a unified diff, run in the sandbox like bash: `git diff`, `git diff main...HEAD`, `git show <commit>`, `diff -u a b`.",
        "The output goes to the pane, not back to you. `git diff` leaves out new files: run `git add -N .` first to include them, as in `git add -N . && git diff`.",
        "A title you've used before replaces that diff.",
      ].join(" "),
      schema: z.object({
        title: z.string().min(1).max(120).describe("What this diff is, short: 'Renewal window', 'Tests'"),
        command: z.string().min(1).describe("The command that prints the diff"),
        cwd: z.string().optional().describe("Working directory (default: the persona's working directory)"),
      }),
      preview: (i) => `${i.title} · ${i.command.replace(/\s+/g, " ").trim().slice(0, 100)}`,
      primaryArg: (i) => i.command,
      async run(i, ctx) {
        const r = await ctx.runtime.execShell(ctx.container, i.command, {
          cwd: i.cwd ? path.posix.resolve(ctx.workdir, i.cwd) : ctx.workdir,
          timeoutMs: ctx.bashTimeoutMs,
          signal: ctx.signal,
          maxOutput: MAX_OUTPUT,
        });
        // `diff -u` exits 1 when there are differences, so the output decides, not the exit code.
        const files = parsePatch(r.stdout);
        if (!files.length) {
          if (r.code === 0 && !r.stdout.trim()) return { text: "No differences, so nothing was added to the Changes pane." };
          const why = r.stderr.trim() || (r.stdout.trim() ? "Its output isn't a unified diff." : `It exited with code ${r.code}.`);
          return { text: `Nothing was added to the Changes pane. ${why.slice(0, 1000)}`, isError: true };
        }
        const view = await diffs.put(sessionId, { title: i.title, command: i.command, files });
        changed();
        const cut = files.some((f) => f.truncated) ? " Some of it was too long to show in full." : "";
        const n = files.length;
        return {
          text: `Showing "${view.title}" in the Changes pane: ${n} ${n === 1 ? "file" : "files"}, +${view.additions} -${view.deletions}.${cut}`,
          itemPatch: { inputPreview: `${view.title} · ${n} ${n === 1 ? "file" : "files"} +${view.additions} −${view.deletions}` },
        };
      },
    }),
    zodTool({
      name: CLEAR_DIFFS,
      description: "Remove diffs from the Changes pane once they're no longer worth reviewing: one by its title, or all of them.",
      schema: z.object({ title: z.string().optional().describe("The diff to remove; leave out to remove them all") }),
      preview: (i) => i.title ?? "all diffs",
      async run(i) {
        const n = await diffs.clear(sessionId, i.title);
        changed();
        return { text: n ? `Removed ${n} ${n === 1 ? "diff" : "diffs"} from the Changes pane.` : "There was nothing to remove." };
      },
    }),
  ];
}
