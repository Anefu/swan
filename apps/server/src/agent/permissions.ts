import type { PermissionMode } from "@ph/shared";
import type { PersonaConfig } from "../personas.js";
import { wildcardMatch } from "../util.js";
import type { ToolDef } from "./tools.js";

// What Swan cannot check in a command line, anywhere: substitution ($, `), escapes and line breaks.
const UNCHECKABLE_ANYWHERE = /[$`\\\n\r]/;
// ...and outside quotes: grouping and redirection to files.
const UNCHECKABLE_UNQUOTED = new Set(["(", ")", "{", "}", "<", ">"]);

/**
 * The simple commands in a shell command line, split at unquoted `&&`, `||`, `;`, `|` and `&`.
 * Null when Swan cannot check the line: substitution, escapes, line breaks, grouping, redirection
 * (except the harmless `2>&1`) or unbalanced quotes. Allow rules never match such a line.
 */
export function splitCommand(command: string): string[] | null {
  if (UNCHECKABLE_ANYWHERE.test(command)) return null;
  const line = command.replace(/(^|\s)2>&1(?=$|[\s;&|])/g, "$1"); // stderr into stdout writes no file
  const parts: string[] = [];
  let cur = "";
  let quote: string | null = null;
  for (let i = 0; i < line.length; i++) {
    const c = line[i]!;
    if (quote) {
      if (c === quote) quote = null;
      cur += c;
    } else if (c === "'" || c === '"') {
      quote = c;
      cur += c;
    } else if (UNCHECKABLE_UNQUOTED.has(c)) {
      return null;
    } else if (c === ";" || c === "|" || c === "&") {
      if ((c === "&" || c === "|") && line[i + 1] === c) i++; // && and ||
      parts.push(cur);
      cur = "";
    } else cur += c;
  }
  if (quote) return null;
  parts.push(cur);
  return parts.map((p) => p.trim()).filter(Boolean);
}

// Programs whose arguments can make them run any other command (shells, interpreters, wrappers and
// a few with exec options): an approval card never offers "with any arguments" for them. Best
// effort; the sandbox, not this list, is the boundary.
const RUNS_ANYTHING = new Set([
  ...["sh", "bash", "zsh", "dash", "ksh", "fish", "csh", "tcsh", "env", "sudo", "su", "doas", "xargs", "exec", "eval", "source", "command"],
  ...["nohup", "timeout", "nice", "ionice", "time", "watch", "stdbuf", "setsid", "chroot", "unbuffer", "ssh", "scp", "rsync"],
  ...["python", "python2", "python3", "node", "nodejs", "deno", "bun", "ruby", "perl", "php", "lua", "Rscript", "osascript"],
  ...["npx", "pnpx", "bunx", "uvx", "pipx", "find", "awk", "gawk", "sed", "tar", "make"],
]);
// Programs whose first argument is a subcommand: the pattern keeps it ("git status *", not "git *").
const SUBCOMMANDS = new Set([
  ...["git", "npm", "pnpm", "yarn", "cargo", "go", "kubectl", "helm", "docker", "podman", "terraform"],
  ...["aws", "gh", "gcloud", "az", "pip", "pip3", "uv", "poetry", "brew", "apt", "apt-get", "dotnet", "mvn", "gradle"],
]);

/** The prefix an approval card can allow with any arguments ("ls", "npm test"), or null. */
export function commandPrefix(part: string): string | null {
  const [program, sub] = part.trim().split(/\s+/);
  if (!program || !/^[A-Za-z0-9_][A-Za-z0-9._+-]*$/.test(program) || RUNS_ANYTHING.has(program)) return null;
  if (!SUBCOMMANDS.has(program)) return program;
  return sub && /^[a-z][a-z0-9:-]*$/.test(sub) ? `${program} ${sub}` : null; // never "git *"
}

export interface Evaluation {
  mode: PermissionMode;
  rule: string;
  uncovered?: string[]; // parts of a command line no allow rule covers
  prefixes?: string[]; // "npm test": allowing "npm test *" would cover them
}

interface Rule {
  raw: string;
  name: string;
  arg?: string;
  exact?: boolean; // matches the whole argument as written, no wildcards
}

const EXACT = "=";

function parseRule(raw: string): Rule {
  const m = /^([^()]+)\((.*)\)$/s.exec(raw.trim());
  if (m) {
    const arg = m[2]!;
    return arg.startsWith(EXACT) ? { raw, name: m[1]!.trim(), arg: arg.slice(EXACT.length), exact: true } : { raw, name: m[1]!.trim(), arg };
  }
  // Tool names have no spaces: "cd *" or "npm test*" is a command pattern, as bash(cd *).
  if (/\s/.test(raw.trim())) return { raw, name: "bash", arg: raw.trim() };
  return { raw, name: raw.trim() };
}

/**
 * Rules: deny > allow > ask > default. A rule is a tool-name glob (`mcp__github__*`),
 * `tool(argGlob)` matched against the tool's primary argument, e.g. `bash(git status*)`, or a
 * command pattern on its own (`cd *`). A command line that joins several commands is allowed only
 * when every part matches an allow rule, and denied when any part matches a deny rule. Allow rules
 * never match a line Swan cannot split safely (see splitCommand).
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

  /** A rule with an argument against one value (the whole argument, or one part of a command). */
  private static argMatches(rule: Rule, value: string): boolean {
    return rule.exact ? value === rule.arg : wildcardMatch(value, rule.arg!);
  }

  /** deny and ask: the whole argument or, for a command line, any part of it. */
  private hits(rule: Rule, tool: ToolDef, arg: string | undefined, parts: string[] | null): boolean {
    if (!wildcardMatch(tool.name, rule.name)) return false;
    if (rule.arg === undefined) return true;
    if (arg === undefined) return false;
    return PermissionPolicy.argMatches(rule, arg) || (!!parts && parts.some((p) => PermissionPolicy.argMatches(rule, p)));
  }

  /** allow: rules covering the call, or null. A command line needs a rule for every part. */
  private allowedBy(tool: ToolDef, arg: string | undefined, parts: string[] | null): Rule[] | null {
    const named = this.allow.filter((r) => wildcardMatch(tool.name, r.name));
    const whole = named.find((r) => r.arg === undefined);
    if (whole) return [whole];
    if (arg === undefined) return null;
    if (tool.name !== "bash") {
      const r = named.find((x) => PermissionPolicy.argMatches(x, arg));
      return r ? [r] : null;
    }
    const exact = named.find((r) => r.exact && r.arg === arg); // "until stopped" on a line Swan cannot split
    if (exact) return [exact];
    if (!parts?.length) return null;
    const used: Rule[] = [];
    for (const p of parts) {
      const r = named.find((x) => !x.exact && PermissionPolicy.argMatches(x, p));
      if (!r) return null;
      if (!used.includes(r)) used.push(r);
    }
    return used;
  }

  evaluate(tool: ToolDef, input: Record<string, unknown> | null): Evaluation {
    const arg = input ? tool.primaryArg?.(input) : undefined;
    const parts = tool.name === "bash" && arg !== undefined ? splitCommand(arg) : null;
    for (const r of this.deny) if (this.hits(r, tool, arg, parts)) return { mode: "deny", rule: `deny: ${r.raw}` };
    const allowed = this.allowedBy(tool, arg, parts);
    if (allowed) return { mode: "allow", rule: `allow: ${allowed.map((r) => r.raw).join(", ")}` };
    for (const r of this.ask) if (this.hits(r, tool, arg, parts)) return { mode: "ask", rule: `ask: ${r.raw}`, ...this.commandHelp(parts) };
    return { mode: this.cfg.default, rule: `default: ${this.cfg.default}`, ...(this.cfg.default === "ask" ? this.commandHelp(parts) : {}) };
  }

  /**
   * For an approval card on a command line: the parts no allow rule covers (when there are several
   * parts), and the prefixes that would cover them with any arguments, offered only when every
   * uncovered part has one.
   */
  private commandHelp(parts: string[] | null): Pick<Evaluation, "uncovered" | "prefixes"> {
    if (!parts?.length) return {};
    const rules = this.allow.filter((r) => r.arg !== undefined && !r.exact && wildcardMatch("bash", r.name));
    const uncovered = parts.filter((p) => !rules.some((r) => PermissionPolicy.argMatches(r, p)));
    const prefixes = uncovered.map(commandPrefix);
    return {
      ...(parts.length > 1 && uncovered.length ? { uncovered } : {}),
      ...(uncovered.length && prefixes.every((p) => p !== null) ? { prefixes: [...new Set(prefixes as string[])] } : {}),
    };
  }

  /** The rules for prefixes: the prefix with any arguments, and on its own ("ls *" does not match "ls"). */
  static prefixRules(prefixes: string[]): string[] {
    return prefixes.flatMap((p) => [`${p} *`, `bash(${p})`]);
  }

  /** Static view for the tools panel (no input available). */
  describe(tool: ToolDef): PermissionMode {
    for (const r of this.deny) if (r.arg === undefined && wildcardMatch(tool.name, r.name)) return "deny";
    for (const r of this.allow) if (r.arg === undefined && wildcardMatch(tool.name, r.name)) return "allow";
    for (const r of this.ask) if (wildcardMatch(tool.name, r.name)) return "ask";
    // An arg-scoped allow rule means "sometimes allowed": show it as ask.
    return this.cfg.default;
  }

  /**
   * The rules "Allow … until stopped" adds: for a command line, one per part (without `*`, which
   * would make it a pattern), so the same commands run again without asking; a line Swan cannot
   * split is allowed again only exactly as written.
   */
  static alwaysAllowRules(tool: ToolDef, input: Record<string, unknown>): string[] {
    if (tool.name !== "bash") return [tool.name];
    const cmd = tool.primaryArg?.(input) ?? "";
    const parts = splitCommand(cmd);
    if (!parts) return [`bash(${EXACT}${cmd})`];
    return [...new Set(parts.map((p) => `bash(${p.replace(/\*/g, "")})`))];
  }
}
