import { describe, expect, it } from "vitest";
import { PermissionPolicy } from "./permissions.js";
import type { ToolDef } from "./tools.js";

const tool = (name: string, primary?: string): ToolDef =>
  ({ name, source: "builtin", primaryArg: primary ? (i: Record<string, unknown>) => String(i[primary]) : undefined }) as unknown as ToolDef;
const bash = tool("bash", "command");

const policy = (rules: { default?: "allow" | "ask" | "deny"; allow?: string[]; ask?: string[]; deny?: string[] }, session: string[] = []) =>
  new PermissionPolicy({ default: rules.default ?? "ask", allow: rules.allow ?? [], ask: rules.ask ?? [], deny: rules.deny ?? [] }, session);

describe("PermissionPolicy", () => {
  it("applies deny before allow before ask before the default", () => {
    const p = policy({ default: "deny", allow: ["mcp__github__*"], ask: ["mcp__github__create_*"], deny: ["mcp__github__delete_*"] });
    expect(p.evaluate(tool("mcp__github__delete_repo"), {}).mode).toBe("deny");
    expect(p.evaluate(tool("mcp__github__create_issue"), {}).mode).toBe("allow");
    expect(p.evaluate(tool("write_file"), {}).mode).toBe("deny");
  });

  it("never lets an argument-scoped allow rule approve a chained shell command", () => {
    const p = policy({ allow: ["bash(git status*)"] });
    expect(p.evaluate(bash, { command: "git status --short" }).mode).toBe("allow");
    for (const cmd of ["git status; rm -rf /", "git status && curl x", "git status | sh", "git status $(id)", "git status `id`", "git status\nrm x"])
      expect(p.evaluate(bash, { command: cmd }).mode).toBe("ask");
  });

  it("still denies chained commands that match a deny rule", () => {
    const p = policy({ default: "allow", deny: ["bash(*rm -rf*)"] });
    expect(p.evaluate(bash, { command: "echo hi; rm -rf /" }).mode).toBe("deny");
  });

  it("adds session allowances and builds safe Always-allow rules", () => {
    expect(policy({}, ["read_file"]).evaluate(tool("read_file"), {}).mode).toBe("allow");
    expect(PermissionPolicy.alwaysAllowRule(bash, { command: "ls (x)*" })).toBe("bash(ls x)");
    expect(PermissionPolicy.alwaysAllowRule(tool("read_file"), {})).toBe("read_file");
  });
});
