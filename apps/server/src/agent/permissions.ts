import type { PermissionMode } from "@ph/shared";
import type { PersonaConfig } from "../personas.js";
import { wildcardMatch } from "../util.js";
import type { ToolDef } from "./tools.js";

// Shell metacharacters that could chain a second command after an allowed prefix.
const SHELL_CHAIN = /[;&|`$<>(){}\n\\]/;

interface Rule {
  raw: string;
  name: string;
  arg?: string;
}

function parseRule(raw: string): Rule {
  const m = /^([^()]+)\((.*)\)$/s.exec(raw.trim());
  return m ? { raw, name: m[1].trim(), arg: m[2] } : { raw, name: raw.trim() };
}

/**
 * Rules: deny > allow > ask > default. A rule is a tool-name glob (`mcp__github__*`) or
 * `tool(argGlob)` matched against the tool's primary argument, e.g. `bash(git status*)`.
 * Arg-scoped *allow* rules never match shell commands that chain or substitute.
 */
export class PermissionPolicy {
  private deny: Rule[];
  private allow: Rule[];
  private ask: Rule[];

  constructor(
    private cfg: PersonaConfig["permissions"],
    sessionAllow: string[],
  ) {
    this.deny = cfg.deny.map(parseRule);
    this.allow = [...cfg.allow, ...sessionAllow].map(parseRule);
    this.ask = cfg.ask.map(parseRule);
  }

  private matches(rule: Rule, tool: ToolDef, input: Record<string, unknown> | null, forAllow: boolean): boolean {
    if (!wildcardMatch(tool.name, rule.name)) return false;
    if (rule.arg === undefined) return true;
    const arg = input ? tool.primaryArg?.(input) : undefined;
    if (arg === undefined) return false;
    if (forAllow && tool.name === "bash" && SHELL_CHAIN.test(arg)) return false;
    return wildcardMatch(arg, rule.arg);
  }

  evaluate(tool: ToolDef, input: Record<string, unknown> | null): { mode: PermissionMode; rule: string } {
    for (const r of this.deny) if (this.matches(r, tool, input, false)) return { mode: "deny", rule: `deny: ${r.raw}` };
    for (const r of this.allow) if (this.matches(r, tool, input, true)) return { mode: "allow", rule: `allow: ${r.raw}` };
    for (const r of this.ask) if (this.matches(r, tool, input, false)) return { mode: "ask", rule: `ask: ${r.raw}` };
    return { mode: this.cfg.default, rule: `default: ${this.cfg.default}` };
  }

  /** Static view for the tools panel (no input available). */
  describe(tool: ToolDef): PermissionMode {
    for (const r of this.deny) if (r.arg === undefined && wildcardMatch(tool.name, r.name)) return "deny";
    for (const r of this.allow) if (r.arg === undefined && wildcardMatch(tool.name, r.name)) return "allow";
    for (const r of this.ask) if (wildcardMatch(tool.name, r.name)) return "ask";
    // An arg-scoped allow rule means "sometimes allowed": show it as ask.
    return this.cfg.default;
  }

  /** The rule "Always allow" adds for the rest of the session. */
  static alwaysAllowRule(tool: ToolDef, input: Record<string, unknown>): string {
    if (tool.name === "bash") {
      const cmd = tool.primaryArg?.(input) ?? "";
      return `bash(${cmd.replace(/[()*]/g, "")})`;
    }
    return tool.name;
  }
}
