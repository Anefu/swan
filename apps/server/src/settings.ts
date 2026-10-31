import { promises as fs } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import YAML from "yaml";
import { z } from "zod";
import { exists, expandHome, writeFileAtomic } from "./util.js";

export const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");

export const PH_HOME = path.resolve(expandHome(process.env.PH_HOME ?? "~/.persona-harness"));

export const paths = {
  home: PH_HOME,
  config: path.join(PH_HOME, "config.yaml"),
  secretsYaml: path.join(PH_HOME, "secrets.yaml"),
  secretsEnv: path.join(PH_HOME, "secrets.env"),
  personas: path.join(PH_HOME, "personas"),
  skills: path.join(PH_HOME, "skills"),
  sessions: path.join(PH_HOME, "sessions"),
  ca: path.join(PH_HOME, "ca"),
  build: path.join(PH_HOME, "build"),
  audit: path.join(PH_HOME, "audit"),
  copilotRuntime: path.join(PH_HOME, "copilot-runtime"),
  memory: path.join(PH_HOME, "memory"),
  connections: path.join(PH_HOME, "connections"), // per-connection wrapper state and logs
  migrationNote: path.join(PH_HOME, "connections-migration.json"),
  apiToken: path.join(PH_HOME, "api-token"),
  webDist: path.join(REPO_ROOT, "apps/web/dist"),
  containerfile: path.join(REPO_ROOT, "sandbox/Containerfile"),
  examples: path.join(REPO_ROOT, "examples"),
};

/** USD per million tokens. Estimates for reports, not invoices; cached rates default to the input rate. */
const PriceSchema = z.object({
  input: z.number().nonnegative(),
  output: z.number().nonnegative(),
  cacheRead: z.number().nonnegative().optional(),
  cacheWrite: z.number().nonnegative().optional(),
});

const ModelSettingsSchema = z.object({
  contextTokens: z.number().int().positive().optional(), // the model's context window; default contextLimitTokens
  price: PriceSchema.optional(), // overrides the built-in Anthropic rates; required for a dollar estimate elsewhere
  // openai providers only: extra fields sent with every request for this model (e.g. OpenRouter's
  // `provider: { order: [...], allow_fallbacks: false }` to pin the host). Never overrides model, messages or tools.
  extraBody: z.record(z.string(), z.unknown()).optional(),
});

const ProviderSchema = z.object({
  type: z.enum(["anthropic", "openai", "copilot"]),
  baseURL: z.string().optional(),
  apiKeySecret: z.string().optional(), // name in the secrets store
  // copilot only: fall back to the host's `copilot login` when no token is in the secrets store
  useLoggedInUser: z.boolean().optional(),
  models: z.record(z.string(), ModelSettingsSchema).optional(), // per-model settings, keyed by model id
});

const SettingsSchema = z.object({
  port: z.number().int().default(4317),
  proxyPort: z.number().int().default(4318),
  runtime: z
    .object({
      binary: z.string().default("podman"),
      image: z.string().default("localhost/persona-harness-sandbox"),
      network: z.string().default("ph-internal"),
      subnet: z.string().default("10.213.0.0/24"),
      relayIp: z.string().default("10.213.0.2"),
      relayName: z.string().default("ph-relay"),
    })
    .prefault({}),
  providers: z.record(z.string(), ProviderSchema).default({
    anthropic: { type: "anthropic", apiKeySecret: "ANTHROPIC_API_KEY" },
    openai: { type: "openai", baseURL: "https://api.openai.com/v1", apiKeySecret: "OPENAI_API_KEY" },
    local: { type: "openai", baseURL: "http://127.0.0.1:8080/v1" },
    copilot: { type: "copilot", apiKeySecret: "COPILOT_GITHUB_TOKEN" },
  }),
  defaultModel: z
    .object({ provider: z.string(), id: z.string() })
    .default({ provider: "anthropic", id: "claude-opus-5-5" }),
  skillDirs: z.array(z.string()).default([]), // extra skill roots, e.g. ~/.claude/skills
  connections: z.unknown().optional(), // validated and hot-reloaded by the ConnectionManager
  toolOutputLimit: z.number().int().default(30_000),
  bashTimeoutMs: z.number().int().default(120_000),
  contextLimitTokens: z.number().int().default(200_000), // assumed model context when the provider does not say
  rolloverAt: z.number().min(0.3).max(0.95).default(0.75), // share of the context that triggers a new epoch
  // What opens a new epoch: "full" structured checkpoint + recent events, "minimal" continuity
  // checkpoint + short tail, or "retrieval" (a continuation pointer only; the agent pulls history).
  // "none" is the no-memory baseline for benchmarks: no memory or history tools, no brief, and a
  // new epoch carries only the most recent events.
  rolloverStrategy: z.enum(["full", "minimal", "retrieval", "none"]).default("full"),
  // Model for checkpoints and /dream; default: the conversation's own model.
  memoryModel: z.object({ provider: z.string(), id: z.string() }).optional(),
});

export type Settings = z.infer<typeof SettingsSchema>;
export type ProviderConfig = z.infer<typeof ProviderSchema>;
export type ModelPrice = z.infer<typeof PriceSchema>;

/** A model's settings from its provider's `models` map, if any. */
export function modelSettings(s: Settings, provider: string, model: string) {
  return s.providers[provider]?.models?.[model];
}

/** The context window to plan rollovers against: the model's own, else the configured default. */
export function contextLimit(s: Settings, provider: string, model: string): number {
  return modelSettings(s, provider, model)?.contextTokens ?? s.contextLimitTokens;
}

const DEFAULT_CONFIG = `# persona-harness settings. Restart the server after editing this file
# (except connections, which apply immediately).
port: 4317          # web UI + API (127.0.0.1 only)
proxyPort: 4318     # egress proxy the sandbox reaches through the relay
providers:
  anthropic: { type: anthropic, apiKeySecret: ANTHROPIC_API_KEY }
  openai: { type: openai, baseURL: https://api.openai.com/v1, apiKeySecret: OPENAI_API_KEY }
  # Any OpenAI-compatible server (mlx_lm.server, Ollama, vLLM, LM Studio...)
  local: { type: openai, baseURL: http://127.0.0.1:8080/v1 }
  # GitHub Copilot subscription, through the official Copilot SDK. COPILOT_GITHUB_TOKEN is a
  # fine-grained PAT (personal account, "Copilot Requests" permission); classic ghp_ tokens fail.
  copilot: { type: copilot, apiKeySecret: COPILOT_GITHUB_TOKEN }
defaultModel: { provider: anthropic, id: claude-opus-5-5 }
# Extra directories to load skills from (each child dir with a SKILL.md is a skill)
skillDirs: []
# Where agents' credentials come from. Values live in secrets.yaml as connection/NAME.
connections:
  github:
    type: static
    credentials:
      GITHUB_TOKEN: { hosts: [api.github.com] }
  # A wrapper around your own sign-in tool that speaks Swan's connection protocol, e.g.:
  # corp-aws:
  #   type: command
  #   command: [~/bin/corp-swan, --role, ReadOnly]
  #   hosts: ["*.amazonaws.com"]
`;

export async function ensureHome(): Promise<void> {
  for (const d of [paths.home, paths.personas, paths.skills, paths.sessions, paths.ca, paths.build, paths.audit, paths.memory, paths.connections]) {
    await fs.mkdir(d, { recursive: true, mode: 0o700 });
  }
  await fs.chmod(paths.home, 0o700);
  if (!(await exists(paths.config))) await writeFileAtomic(paths.config, DEFAULT_CONFIG, 0o600);

  // First run: seed example personas, skills and a secrets template.
  const personaFiles = await fs.readdir(paths.personas);
  if (personaFiles.length === 0) {
    for (const f of await fs.readdir(path.join(paths.examples, "personas"))) {
      await fs.copyFile(path.join(paths.examples, "personas", f), path.join(paths.personas, f));
    }
  }
  const skillDirs = await fs.readdir(paths.skills);
  if (skillDirs.length === 0) {
    await fs.cp(path.join(paths.examples, "skills"), paths.skills, { recursive: true });
  }
  if (!(await exists(paths.secretsYaml)) && !(await exists(paths.secretsEnv))) {
    const tmpl = await fs.readFile(path.join(paths.examples, "secrets.example.yaml"), "utf8");
    await writeFileAtomic(paths.secretsYaml, tmpl, 0o600);
  }
}

export async function loadSettings(): Promise<Settings> {
  const raw = YAML.parse(await fs.readFile(paths.config, "utf8")) ?? {};
  return SettingsSchema.parse(raw);
}
