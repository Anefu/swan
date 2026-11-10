import { describe, expect, it } from "vitest";
import { commandPrefix, PermissionPolicy, splitCommand } from "./permissions.js";
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

describe("what an approval card offers for a command", () => {
  it("allows a program with any arguments, keeping the subcommand where there is one", () => {
    expect(commandPrefix("ls -la src")).toBe("ls");
    expect(commandPrefix("ls")).toBe("ls");
    expect(commandPrefix("npm test -- --watch")).toBe("npm test");
    expect(commandPrefix("git status --short")).toBe("git status");
    expect(commandPrefix("kubectl get pods -A")).toBe("kubectl get");
  });

  it("never offers any arguments for what can run any command, or a broad git *", () => {
    for (const part of ["bash -c 'rm -rf ~'", "sh x.sh", "python3 run.py", "node -e 1", "env X=1 rm f", "sudo ls", "xargs rm", "find . -delete", "awk 1 f", "sed -n 1p f", "npx foo", "make test"])
      expect(commandPrefix(part), part).toBeNull();
    for (const part of ["./run.sh", "/usr/bin/ls", "FOO=1 npm test", "git -c core.pager=sh log", "git", "kubectl --context x get pods"])
      expect(commandPrefix(part), part).toBeNull();
  });

  it("names the parts of a line no rule covers, and what would cover them", () => {
    const p = policy({ allow: ["cd *"] });
    expect(p.evaluate(bash, { command: "cd /workspace/app && npm test && ls -la" })).toEqual({
      mode: "ask",
      rule: "default: ask",
      uncovered: ["npm test", "ls -la"],
      prefixes: ["npm test", "ls"],
    });
    // One command: nothing to point at, but still something to allow.
    expect(p.evaluate(bash, { command: "ls -la" })).toEqual({ mode: "ask", rule: "default: ask", prefixes: ["ls"] });
    // Through an ask rule too.
    expect(policy({ ask: ["bash"] }).evaluate(bash, { command: "git status" })).toMatchObject({ mode: "ask", prefixes: ["git status"] });
  });

  it("offers no pattern when one uncovered part cannot have one, or the line cannot be checked", () => {
    const p = policy({ allow: ["cd *"] });
    expect(p.evaluate(bash, { command: "cd x && python3 run.py" })).toEqual({ mode: "ask", rule: "default: ask", uncovered: ["python3 run.py"] });
    expect(p.evaluate(bash, { command: "ls $HOME" })).toEqual({ mode: "ask", rule: "default: ask" });
    expect(policy({ default: "deny" }).evaluate(bash, { command: "ls" })).toEqual({ mode: "deny", rule: "default: deny" });
  });

  it("allows the program with any arguments, on its own, and nothing else", () => {
    const rules = PermissionPolicy.prefixRules(["npm test", "ls"]);
    expect(rules).toEqual(["npm test *", "bash(npm test)", "ls *", "bash(ls)"]);
    const p = policy({ allow: ["cd *"] }, rules);
    for (const cmd of ["ls", "ls src", "npm test", "npm test -- --watch", "cd app && npm test && ls -la"]) expect(p.evaluate(bash, { command: cmd }).mode, cmd).toBe("allow");
    for (const cmd of ["npm install x", "lsof -i", "ls && rm -rf ~", "ls $(rm -rf ~)"]) expect(p.evaluate(bash, { command: cmd }).mode, cmd).toBe("ask");
    expect(policy({ deny: ["ls *"] }, rules).evaluate(bash, { command: "ls src" }).mode).toBe("deny");
  });
});

describe("a tool's own default", () => {
  const read = { ...tool("memory_read"), defaultAllow: { rule: "memory read" } } as ToolDef;
  const send = { ...tool("conversations"), defaultAllow: { rule: "conversations", unless: (i: Record<string, unknown>) => i.persona !== undefined } } as ToolDef;

  it("allows it when no rule matches, and only then", () => {
    expect(policy({}).check(read, {})).toEqual({ mode: "allow", rule: "memory read" });
    expect(policy({ ask: ["memory_read"] }).check(read, {}).mode).toBe("ask");
    expect(policy({ deny: ["memory_*"] }).check(read, {}).mode).toBe("deny");
    expect(policy({}).check(tool("bash"), {}).mode).toBe("ask");
  });

  it("asks after all when the tool says the input needs it", () => {
    expect(policy({}).check(send, {}).mode).toBe("allow");
    expect(policy({}).check(send, { persona: "other" }).mode).toBe("ask");
  });

  it("shows as allowed in the tools panel unless a rule denies it", () => {
    expect(policy({}).view(read)).toBe("allow");
    expect(policy({ deny: ["memory_read"] }).view(read)).toBe("deny");
    expect(policy({}).view(tool("bash"))).toBe("ask");
  });

  it("is matched under the name the tool asks to be gated as", () => {
    const diff = { ...tool("show_diff", "command"), permissionAs: "bash" } as ToolDef;
    expect(policy({ allow: ["bash(git diff*)"] }).check(diff, { command: "git diff" }).mode).toBe("allow");
    expect(policy({ deny: ["bash(rm *)"] }).check(diff, { command: "rm -rf x" }).mode).toBe("deny");
  });
});
