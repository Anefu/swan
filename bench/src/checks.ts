import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import type { ChatItem, EgressEvent, MemoryRecord } from "@ph/shared";
import type { Check } from "./schema.js";
import { run } from "./swan.js";

export interface Evidence {
  workspace: string | null;
  /** Every conversation of the run, oldest first. */
  transcripts: ChatItem[][];
  memory: MemoryRecord[];
  egress: EgressEvent[];
  imageTag: string;
}

export interface CheckResult {
  id: string;
  pass: boolean;
  detail: string;
}

const re = (s: string) => new RegExp(s, "i");

/** The agent's last reply after the last user message of the last conversation. */
export function finalReply(transcripts: ChatItem[][]): string {
  const items = transcripts.at(-1) ?? [];
  const lastUser = items.map((it) => it.kind).lastIndexOf("user");
  return items
    .slice(lastUser + 1)
    .filter((it): it is Extract<ChatItem, { kind: "assistant_text" }> => it.kind === "assistant_text")
    .map((it) => it.text)
    .join("\n");
}

function expectCount(n: number, expect: "none" | "some", what: string): { pass: boolean; detail: string } {
  return expect === "none" ? { pass: n === 0, detail: n ? `${n} ${what} found` : `no ${what}` } : { pass: n > 0, detail: n ? `${n} ${what}` : `no ${what} found` };
}

export async function runCheck(c: Check, ev: Evidence): Promise<CheckResult> {
  const r = await evaluate(c, ev).catch((e: unknown) => ({ pass: false, detail: `check failed to run: ${e instanceof Error ? e.message : String(e)}` }));
  return { id: c.id, ...r };
}

async function evaluate(c: Check, ev: Evidence): Promise<{ pass: boolean; detail: string }> {
  if (c.file) {
    if (!ev.workspace) return { pass: false, detail: "the case has no workspace" };
    const file = path.resolve(ev.workspace, c.file.path);
    if (!file.startsWith(ev.workspace + path.sep)) return { pass: false, detail: "path leaves the workspace" };
    const text = await fs.readFile(file, "utf8").catch(() => null);
    if (c.file.exists === false) return { pass: text === null, detail: text === null ? "absent" : "exists" };
    if (text === null) return { pass: false, detail: `${c.file.path} does not exist` };
    if (c.file.contains !== undefined && !text.includes(c.file.contains)) return { pass: false, detail: `does not contain ${JSON.stringify(c.file.contains)}` };
    if (c.file.notContains !== undefined && text.includes(c.file.notContains)) return { pass: false, detail: `contains ${JSON.stringify(c.file.notContains)}` };
    if (c.file.matches !== undefined && !re(c.file.matches).test(text)) return { pass: false, detail: `does not match /${c.file.matches}/` };
    return { pass: true, detail: "ok" };
  }
  if (c.command) {
    if (!ev.workspace) return { pass: false, detail: "the case has no workspace" };
    // Agent-written code never runs on the host: the check runs in a throwaway container with no network.
    const copy = await fs.mkdtemp(path.join(os.homedir(), ".swan-bench", "check-"));
    try {
      await fs.cp(ev.workspace, copy, { recursive: true });
      const r = await run(
        "podman",
        ["run", "--rm", "--network", "none", "--cap-drop", "ALL", "--security-opt", "no-new-privileges", "--memory", "1g", "--pids-limit", "256", "-v", `${copy}:/w`, "-w", "/w", ev.imageTag, "sh", "-c", c.command.run],
        { timeoutMs: 5 * 60_000 },
      );
      const tail = r.out.trim().split("\n").slice(-5).join(" | ");
      return { pass: r.code === c.command.exitCode, detail: `exit ${r.code}${tail ? `: ${tail}` : ""}` };
    } finally {
      await fs.rm(copy, { recursive: true, force: true });
    }
  }
  if (c.reply) {
    const text = finalReply(ev.transcripts);
    if (c.reply.matches !== undefined && !re(c.reply.matches).test(text)) return { pass: false, detail: `reply does not match /${c.reply.matches}/` };
    if (c.reply.notMatches !== undefined && re(c.reply.notMatches).test(text)) return { pass: false, detail: `reply matches /${c.reply.notMatches}/` };
    return { pass: true, detail: "ok" };
  }
  if (c.toolCalls) {
    const t = c.toolCalls;
    const calls = ev.transcripts.flat().filter((it) => it.kind === "tool_call" && (!t.name || it.name === t.name) && re(t.inputMatches).test(JSON.stringify(it.input ?? {})));
    return expectCount(calls.length, t.expect, `matching ${t.name ?? "tool"} calls`);
  }
  if (c.memory) {
    const hits = ev.memory.filter((m) => m.status !== "archived" && re(c.memory!.matches).test(m.content));
    return expectCount(hits.length, c.memory.expect, "matching memories");
  }
  if (c.egress) {
    const hits = ev.egress.filter((e) => re(c.egress!.hostMatches).test(e.host));
    return expectCount(hits.length, c.egress.expect, "matching requests");
  }
  return { pass: false, detail: "unknown check" };
}
