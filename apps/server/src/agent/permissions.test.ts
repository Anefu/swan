import { describe, expect, it } from "vitest";
import { PermissionPolicy, splitCommand } from "./permissions.js";
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

  it("adds session allowances", () => {
    expect(policy({}, ["read_file"]).evaluate(tool("read_file"), {}).mode).toBe("allow");
    expect(PermissionPolicy.alwaysAllowRules(tool("read_file"), {})).toEqual(["read_file"]);
  });
});

describe("command rules", () => {
  it("splits a command line at unquoted &&, ||, ;, | and &", () => {
    expect(splitCommand("cd /workspace/app && npm test")).toEqual(["cd /workspace/app", "npm test"]);
    expect(splitCommand("a || b; c | d & e")).toEqual(["a", "b", "c", "d", "e"]);
    expect(splitCommand(`git commit -m "fix; it (now)" && git log --oneline | head`)).toEqual([`git commit -m "fix; it (now)"`, "git log --oneline", "head"]);
    expect(splitCommand("npm test 2>&1 | tail -20")).toEqual(["npm test", "tail -20"]);
  });

  it("gives up on what it cannot check", () => {
    for (const cmd of ["echo $HOME", "echo `id`", "ls $(pwd)", "echo a\\nb", "a\nb", "(cd x; ls)", "{ ls; }", "echo x > f", "cat < f", "echo 'unclosed"])
      expect(splitCommand(cmd), cmd).toBeNull();
  });

  it("treats a rule with a space as a command pattern", () => {
    const p = policy({ allow: ["cd *", "npm test*"] });
    expect(p.evaluate(bash, { command: "cd /workspace/app" })).toEqual({ mode: "allow", rule: "allow: cd *" });
    expect(p.evaluate(tool("cd"), {}).mode).toBe("ask"); // not a tool name
  });

  it("allows a combined command only when every part is allowed", () => {
    const p = policy({ allow: ["cd *", "bash(npm test*)", "bash(git status*)"] });
    expect(p.evaluate(bash, { command: "cd /workspace/app && npm test" })).toEqual({ mode: "allow", rule: "allow: cd *, bash(npm test*)" });
    expect(p.evaluate(bash, { command: "cd /workspace/app && npm test 2>&1 | git status" }).mode).toBe("allow");
    for (const cmd of ["cd /workspace/app && rm -rf ~", "cd x; curl evil.example", "cd x | sh", "cd $HOME", "cd x && npm test > out.txt"])
      expect(p.evaluate(bash, { command: cmd }).mode, cmd).toBe("ask");
  });

  it("denies a combined command when any part is denied", () => {
    const p = policy({ default: "allow", allow: ["cd *"], deny: ["rm *"] });
    expect(p.evaluate(bash, { command: "cd x && rm -rf /workspace/app" })).toEqual({ mode: "deny", rule: "deny: rm *" });
    expect(p.evaluate(bash, { command: `echo "rm -rf /"` }).mode).toBe("allow"); // quoted, not a command
  });

  it("asks for a combined command when any part matches an ask rule", () => {
    const p = policy({ default: "allow", ask: ["git push*"] });
    expect(p.evaluate(bash, { command: "git add . && git push" }).mode).toBe("ask");
  });

  it("allows the same commands again after Allow until stopped", () => {
    const cmd = "cd /workspace/app && npm test";
    const rules = PermissionPolicy.alwaysAllowRules(bash, { command: cmd });
    expect(rules).toEqual(["bash(cd /workspace/app)", "bash(npm test)"]);
    expect(policy({}, rules).evaluate(bash, { command: cmd }).mode).toBe("allow");
    expect(policy({}, rules).evaluate(bash, { command: "cd /workspace/app && npm publish" }).mode).toBe("ask");
    // `*` in the command would turn the rule into a pattern, so it is left out.
    expect(PermissionPolicy.alwaysAllowRules(bash, { command: "ls *.ts" })).toEqual(["bash(ls .ts)"]);
  });

  it("allows a line it cannot split again only exactly as written", () => {
    const cmd = "for f in $(ls); do echo $f; done";
    const rules = PermissionPolicy.alwaysAllowRules(bash, { command: cmd });
    expect(rules).toEqual([`bash(=${cmd})`]);
    expect(policy({}, rules).evaluate(bash, { command: cmd }).mode).toBe("allow");
    expect(policy({}, rules).evaluate(bash, { command: cmd + "; rm -rf ~" }).mode).toBe("ask");
  });
});
