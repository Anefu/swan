import path from "node:path";
import { Ajv, type ValidateFunction } from "ajv";
import { z } from "zod";
import type { ChatItem } from "@ph/shared";
import type { PodmanRuntime } from "../sandbox/podman.js";
import type { SkillRegistry } from "../skills.js";
import { truncateMiddle } from "../util.js";

export interface ToolOutput {
  text: string;
  isError?: boolean;
  images?: { mediaType: string; data: string }[];
  /** Applied to the tool's chat item last (e.g. an agent call that keeps running in the background). */
  itemPatch?: Partial<Extract<ChatItem, { kind: "tool_call" }>>;
}

export interface ToolContext {
  runtime: PodmanRuntime;
  container: string;
  workdir: string;
  signal: AbortSignal;
  outputLimit: number;
  bashTimeoutMs: number;
  skills: SkillRegistry;
  personaSkills: string[];
  toolUseId: string;
}

export interface ToolDef {
  name: string;
  source: "builtin" | "mcp" | "skill";
  server?: string;
  description: string;
  inputSchema: Record<string, unknown>;
  validate(input: unknown): { ok: true; value: Record<string, unknown> } | { ok: false; error: string };
  preview(input: Record<string, unknown>): string;
  /** The argument permission patterns like `bash(git *)` match against. */
  primaryArg?(input: Record<string, unknown>): string | undefined;
  run(input: Record<string, unknown>, ctx: ToolContext): Promise<ToolOutput>;
}

const oneLine = (s: unknown, n = 120) => {
  const t = String(s ?? "").replace(/\s+/g, " ").trim();
  return t.length > n ? t.slice(0, n - 1) + "…" : t;
};

export function zodTool<S extends z.ZodObject>(def: {
  name: string;
  description: string;
  schema: S;
  source?: "builtin" | "skill";
  preview: (i: z.infer<S>) => string;
  primaryArg?: (i: z.infer<S>) => string | undefined;
  run: (i: z.infer<S>, ctx: ToolContext) => Promise<ToolOutput>;
}): ToolDef {
  const { $schema: _s, ...inputSchema } = z.toJSONSchema(def.schema) as Record<string, unknown>;
  return {
    name: def.name,
    source: def.source ?? "builtin",
    description: def.description,
    inputSchema,
    validate(input) {
      const r = def.schema.safeParse(input);
      return r.success
        ? { ok: true, value: r.data as Record<string, unknown> }
        : { ok: false, error: r.error.issues.map((i) => `${i.path.join(".") || "input"}: ${i.message}`).join("; ") };
    },
    preview: (i) => def.preview(i as z.infer<S>),
    primaryArg: def.primaryArg ? (i) => def.primaryArg!(i as z.infer<S>) : undefined,
    run: (i, ctx) => def.run(i as z.infer<S>, ctx),
  };
}

const abs = (p: string, ctx: ToolContext) => path.posix.resolve(ctx.workdir, p);

const IMAGE_EXT: Record<string, string> = { ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".gif": "image/gif", ".webp": "image/webp" };

async function readText(ctx: ToolContext, file: string): Promise<{ ok: true; text: string } | { ok: false; error: string }> {
  const r = await ctx.runtime.exec(ctx.container, ["cat", "--", file], { timeoutMs: 30_000, maxOutput: 10_000_000, signal: ctx.signal });
  if (r.code !== 0) return { ok: false, error: r.stderr.trim() || `cat exited ${r.code}` };
  if (r.truncated) return { ok: false, error: "file larger than 10 MB; use bash (head/sed) to read parts of it" };
  return { ok: true, text: r.stdout };
}

async function writeText(ctx: ToolContext, file: string, content: string): Promise<string | null> {
  const r = await ctx.runtime.exec(ctx.container, ["sh", "-c", 'mkdir -p -- "$(dirname -- "$1")" && cat > "$1"', "sh", file], {
    input: content,
    timeoutMs: 30_000,
    signal: ctx.signal,
  });
  return r.code === 0 ? null : r.stderr.trim() || `write exited ${r.code}`;
}

export function builtinTools(): ToolDef[] {
  return [
    zodTool({
      name: "bash",
      description:
        "Run a shell command (bash -lc) inside the sandbox container and return stdout, stderr and the exit code. " +
        "Use for builds, tests, git, package managers and anything without a dedicated tool. Network goes through the " +
        "egress proxy and only allowlisted hosts are reachable. Commands are killed after the timeout.",
      schema: z.object({
        command: z.string().min(1).describe("The command to run"),
        cwd: z.string().optional().describe("Working directory (default: the persona's working directory)"),
        timeout_ms: z.number().int().min(1000).max(600_000).optional().describe("Timeout in ms (default 120000)"),
      }),
      preview: (i) => oneLine(i.command),
      primaryArg: (i) => i.command,
      async run(i, ctx) {
        const timeoutMs = i.timeout_ms ?? ctx.bashTimeoutMs;
        const r = await ctx.runtime.execShell(ctx.container, i.command, {
          cwd: i.cwd ? abs(i.cwd, ctx) : ctx.workdir,
          timeoutMs,
          signal: ctx.signal,
          maxOutput: ctx.outputLimit * 4,
        });
        const parts: string[] = [];
        if (r.stdout) parts.push(r.stdout.trimEnd());
        if (r.stderr) parts.push(`[stderr]\n${r.stderr.trimEnd()}`);
        if (r.code === 124) parts.push(`[timed out after ${timeoutMs} ms]`);
        parts.push(`[exit code ${r.code}]`);
        return { text: truncateMiddle(parts.join("\n"), ctx.outputLimit), isError: r.code !== 0 };
      },
    }),
    zodTool({
      name: "read_file",
      description:
        "Read a text file (with line numbers) or an image from the sandbox. Use offset/limit for large files. " +
        "Prefer this over cat for reading files.",
      schema: z.object({
        path: z.string().min(1).describe("Absolute path, or relative to the working directory"),
        offset: z.number().int().min(1).optional().describe("1-based line to start at"),
        limit: z.number().int().min(1).max(5000).optional().describe("Max lines (default 2000)"),
      }),
      preview: (i) => i.path + (i.offset ? `:${i.offset}` : ""),
      primaryArg: (i) => i.path,
      async run(i, ctx) {
        const file = abs(i.path, ctx);
        const mediaType = IMAGE_EXT[path.posix.extname(file).toLowerCase()];
        if (mediaType) {
          const r = await ctx.runtime.exec(ctx.container, ["base64", "-w0", "--", file], { timeoutMs: 30_000, maxOutput: 8_000_000, signal: ctx.signal });
          if (r.code !== 0) return { text: r.stderr.trim(), isError: true };
          if (r.truncated) return { text: "image larger than ~6 MB", isError: true };
          return { text: `Image ${file}`, images: [{ mediaType, data: r.stdout.trim() }] };
        }
        const res = await readText(ctx, file);
        if (!res.ok) return { text: res.error, isError: true };
        if (res.text.includes("\u0000")) return { text: `${file} looks binary (${res.text.length} bytes); inspect it with bash (file, xxd, …)`, isError: true };
        const lines = res.text.split("\n");
        if (lines.at(-1) === "") lines.pop();
        const start = (i.offset ?? 1) - 1;
        const slice = lines.slice(start, start + (i.limit ?? 2000));
        const width = String(start + slice.length).length;
        let out = slice.map((l, n) => `${String(start + n + 1).padStart(width)}\t${l.length > 2000 ? l.slice(0, 2000) + "…" : l}`).join("\n");
        if (start + slice.length < lines.length) out += `\n… (${lines.length - start - slice.length} more lines; use offset to continue)`;
        if (lines.length === 0) out = "(empty file)";
        return { text: truncateMiddle(out, ctx.outputLimit * 3) };
      },
    }),
    zodTool({
      name: "write_file",
      description: "Create or overwrite a file in the sandbox with the given content. Parent directories are created. Fails on read-only mounts.",
      schema: z.object({
        path: z.string().min(1),
        content: z.string().describe("Full file content"),
      }),
      preview: (i) => `${i.path} (${i.content.length} chars)`,
      primaryArg: (i) => i.path,
      async run(i, ctx) {
        const file = abs(i.path, ctx);
        const err = await writeText(ctx, file, i.content);
        return err ? { text: err, isError: true } : { text: `Wrote ${i.content.split("\n").length} lines to ${file}` };
      },
    }),
    zodTool({
      name: "edit_file",
      description:
        "Replace an exact string in a file. old_string must match exactly (including whitespace) and be unique " +
        "unless replace_all is true. Read the file first.",
      schema: z.object({
        path: z.string().min(1),
        old_string: z.string().min(1),
        new_string: z.string(),
        replace_all: z.boolean().optional(),
      }),
      preview: (i) => `${i.path}: ${oneLine(i.old_string, 50)} → ${oneLine(i.new_string, 50)}`,
      primaryArg: (i) => i.path,
      async run(i, ctx) {
        const file = abs(i.path, ctx);
        const res = await readText(ctx, file);
        if (!res.ok) return { text: res.error, isError: true };
        const count = res.text.split(i.old_string).length - 1;
        if (count === 0) return { text: "old_string not found in file", isError: true };
        if (count > 1 && !i.replace_all) return { text: `old_string appears ${count} times; add context to make it unique or set replace_all`, isError: true };
        const firstLine = res.text.slice(0, res.text.indexOf(i.old_string)).split("\n").length;
        const next = i.replace_all ? res.text.split(i.old_string).join(i.new_string) : res.text.replace(i.old_string, () => i.new_string);
        const err = await writeText(ctx, file, next);
        return err ? { text: err, isError: true } : { text: `Edited ${file}: ${count} replacement(s), first at line ${firstLine}` };
      },
    }),
    zodTool({
      name: "list_dir",
      description: "List a directory in the sandbox (like ls -la).",
      schema: z.object({ path: z.string().optional().describe("Directory (default: working directory)") }),
      preview: (i) => i.path ?? ".",
      primaryArg: (i) => i.path,
      async run(i, ctx) {
        const r = await ctx.runtime.exec(ctx.container, ["ls", "-la", "--group-directories-first", "--", abs(i.path ?? ".", ctx)], { timeoutMs: 20_000, signal: ctx.signal });
        return { text: truncateMiddle((r.stdout || r.stderr).trimEnd(), ctx.outputLimit), isError: r.code !== 0 };
      },
    }),
    zodTool({
      name: "glob",
      description: "Find files by glob pattern (ripgrep --files -g), e.g. '**/*.ts'. Respects .gitignore. Returns up to 500 paths.",
      schema: z.object({ pattern: z.string().min(1), path: z.string().optional() }),
      preview: (i) => `${i.pattern}${i.path ? ` in ${i.path}` : ""}`,
      primaryArg: (i) => i.path,
      async run(i, ctx) {
        const r = await ctx.runtime.exec(ctx.container, ["rg", "--files", "--hidden", "-g", "!.git", "-g", i.pattern, "--", abs(i.path ?? ".", ctx)], { timeoutMs: 30_000, signal: ctx.signal });
        if (r.code > 1) return { text: r.stderr.trim(), isError: true };
        const files = r.stdout.split("\n").filter(Boolean);
        const shown = files.slice(0, 500).join("\n");
        return { text: files.length === 0 ? "No files matched" : files.length > 500 ? `${shown}\n… ${files.length - 500} more` : shown };
      },
    }),
    zodTool({
      name: "grep",
      description: "Search file contents with ripgrep (regex). Returns matching lines with paths and line numbers.",
      schema: z.object({
        pattern: z.string().min(1).describe("Rust regex"),
        path: z.string().optional(),
        glob: z.string().optional().describe("Only search files matching this glob"),
        ignore_case: z.boolean().optional(),
        context: z.number().int().min(0).max(10).optional(),
        files_only: z.boolean().optional().describe("Only list matching file paths"),
      }),
      preview: (i) => `/${i.pattern}/${i.glob ? ` ${i.glob}` : ""}${i.path ? ` in ${i.path}` : ""}`,
      primaryArg: (i) => i.path,
      async run(i, ctx) {
        const argv = ["rg", "-n", "--no-heading", "--color", "never", "--hidden", "-g", "!.git", "-M", "400"];
        if (i.ignore_case) argv.push("-i");
        if (i.context) argv.push("-C", String(i.context));
        if (i.glob) argv.push("-g", i.glob);
        if (i.files_only) argv.push("-l");
        argv.push("--", i.pattern, abs(i.path ?? ".", ctx));
        const r = await ctx.runtime.exec(ctx.container, argv, { timeoutMs: 60_000, signal: ctx.signal, maxOutput: ctx.outputLimit * 4 });
        if (r.code === 1) return { text: "No matches" };
        if (r.code !== 0) return { text: r.stderr.trim(), isError: true };
        return { text: truncateMiddle(r.stdout.trimEnd(), ctx.outputLimit) };
      },
    }),
  ];
}

export function skillTool(): ToolDef {
  return zodTool({
    name: "load_skill",
    source: "skill",
    description:
      "Load a skill's full instructions (SKILL.md) and list its files. Call this as soon as a task matches a skill " +
      "description from the system prompt, before doing the task. Skill files live read-only at /skills/<name>.",
    schema: z.object({ name: z.string().min(1) }),
    preview: (i) => i.name,
    primaryArg: (i) => i.name,
    async run(i, ctx) {
      const skill = ctx.personaSkills.includes(i.name) ? ctx.skills.get(i.name) : undefined;
      if (!skill) return { text: `Unknown skill "${i.name}". Available: ${ctx.personaSkills.join(", ") || "none"}`, isError: true };
      const r = await ctx.runtime.exec(ctx.container, ["find", `/skills/${i.name}`, "-maxdepth", "3", "-type", "f"], { timeoutMs: 15_000, signal: ctx.signal });
      const files = r.stdout.split("\n").filter(Boolean).slice(0, 100).join("\n");
      return { text: `# Skill: ${skill.name}\nLocation: /skills/${skill.name}\n\n${skill.body.trim()}\n\n## Files\n${files}` };
    },
  });
}

const ajv = new Ajv({ strict: false, allErrors: false, validateFormats: false });

/** Wrap an MCP tool. Inputs are checked against the server's JSON Schema before the call. */
export function mcpTool(def: {
  server: string;
  tool: string;
  qualifiedName: string;
  description: string;
  inputSchema: Record<string, unknown>;
  call: (args: Record<string, unknown>, signal: AbortSignal) => Promise<ToolOutput>;
}): ToolDef {
  let validator: ValidateFunction | null = null;
  try {
    validator = ajv.compile(def.inputSchema);
  } catch {
    validator = null; // unusual schema; let the server validate
  }
  const schema = def.inputSchema.type === "object" ? def.inputSchema : { type: "object", properties: {} };
  return {
    name: def.qualifiedName,
    source: "mcp",
    server: def.server,
    description: `[MCP ${def.server}] ${def.description}`.slice(0, 4000),
    inputSchema: schema,
    validate(input) {
      if (typeof input !== "object" || input === null || Array.isArray(input)) return { ok: false, error: "input must be an object" };
      if (validator && !validator(input)) return { ok: false, error: ajv.errorsText(validator.errors) };
      return { ok: true, value: input as Record<string, unknown> };
    },
    preview: (i) => oneLine(JSON.stringify(i), 120),
    primaryArg: (i) => {
      const first = Object.values(i).find((v) => typeof v === "string");
      return typeof first === "string" ? first : undefined;
    },
    run: (i, ctx) => def.call(i, ctx.signal),
  };
}
