import { describe, expect, it } from "vitest";
import { systemPrompt } from "./session.js";

const base = { name: "P", instructions: "", folders: [], workdir: "/workspace", allow: [], credHosts: [], credentialLines: [], skills: [], epoch: 2 };

describe("systemPrompt", () => {
  it("points at history and memory tools and includes the brief when memory is on", () => {
    const p = systemPrompt({ ...base, brief: "- Use pnpm", memory: true });
    expect(p).toContain("history_search");
    expect(p).toContain("- Use pnpm");
  });

  it("mentions no memory or history tools, and no brief, for the no-memory baseline", () => {
    const p = systemPrompt({ ...base, brief: "- Use pnpm", memory: false });
    expect(p).not.toMatch(/history_search|memory_search|memory_propose|checkpoint/);
    expect(p).not.toContain("- Use pnpm");
    expect(p).toContain("oldest turns are dropped");
  });
});
