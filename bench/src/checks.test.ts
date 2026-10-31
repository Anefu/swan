import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import type { ChatItem, MemoryRecord } from "@ph/shared";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { finalReply, runCheck, type Evidence } from "./checks.js";

const ts = "2026-10-31T00:00:00.000Z";
const user = (text: string): ChatItem => ({ kind: "user", id: `u${text}`, ts, text });
const reply = (text: string): ChatItem => ({ kind: "assistant_text", id: `a${text}`, ts, text });
const bash = (command: string): ChatItem => ({ kind: "tool_call", id: `t${command}`, ts, name: "bash", source: "builtin", input: { command }, inputPreview: command, status: "done" });
const memory = (content: string, status = "active"): MemoryRecord =>
  ({ id: content, version: 1, type: "preference", content, origin: "user", status, pinned: false, sources: [], createdAt: ts, updatedAt: ts }) as MemoryRecord;

describe("checks", () => {
  let ev: Evidence;
  beforeAll(async () => {
    const ws = await fs.mkdtemp(path.join(os.tmpdir(), "bench-ws-"));
    await fs.writeFile(path.join(ws, "package.json"), '{ "scripts": { "test": "node test.js" } }');
    ev = {
      workspace: ws,
      transcripts: [[user("rule"), reply("noted")], [user("first"), reply("old"), user("which command?"), bash("pnpm install"), reply("Use pnpm install.")]],
      memory: [memory("Use pnpm, never npm."), memory("Old note about yarn", "archived")],
      egress: [{ id: "e", ts, sessionId: null, personaId: null, method: "CONNECT", host: "registry.npmjs.org", port: 443, decision: "tunneled", credentials: [] }],
      imageTag: "unused",
    };
  });
  afterAll(() => fs.rm(ev.workspace!, { recursive: true, force: true }));

  it("reads the final reply after the last user message of the last conversation", () => {
    expect(finalReply(ev.transcripts)).toBe("Use pnpm install.");
  });

  it("checks files inside the workspace only", async () => {
    expect(await runCheck({ id: "a", file: { path: "package.json", matches: '"test"\\s*:\\s*"node test\\.js"' } }, ev)).toMatchObject({ pass: true });
    expect(await runCheck({ id: "b", file: { path: "missing.js" } }, ev)).toMatchObject({ pass: false });
    expect(await runCheck({ id: "c", file: { path: "missing.js", exists: false } }, ev)).toMatchObject({ pass: true });
    expect(await runCheck({ id: "d", file: { path: "../outside.txt", exists: false } }, ev)).toMatchObject({ pass: false, detail: "path leaves the workspace" });
  });

  it("checks the reply, tool calls, memory and egress", async () => {
    expect(await runCheck({ id: "r", reply: { matches: "pnpm (i|install)", notMatches: "(^|[^p])npm install" } }, ev)).toMatchObject({ pass: true });
    expect(await runCheck({ id: "t", toolCalls: { name: "bash", inputMatches: "(^|[^p])npm install", expect: "none" } }, ev)).toMatchObject({ pass: true });
    expect(await runCheck({ id: "t2", toolCalls: { name: "bash", inputMatches: "pnpm", expect: "none" } }, ev)).toMatchObject({ pass: false });
    expect(await runCheck({ id: "m", memory: { matches: "pnpm", expect: "some" } }, ev)).toMatchObject({ pass: true });
    expect(await runCheck({ id: "m2", memory: { matches: "yarn", expect: "some" } }, ev)).toMatchObject({ pass: false });
    expect(await runCheck({ id: "e", egress: { hostMatches: "npmjs", expect: "some" } }, ev)).toMatchObject({ pass: true });
  });
});
