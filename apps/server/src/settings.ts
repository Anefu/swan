import { promises as fs } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import YAML from "yaml";
import { z } from "zod";
import { exists, expandHome, writeFileAtomic } from "./util.js";

export const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");

// Swan's home was ~/.persona-harness; the default one moves to ~/.swan on first start (home.ts).
export const HOME_FROM_ENV = !!process.env.PH_HOME;
export const PH_HOME = path.resolve(expandHome(process.env.PH_HOME ?? "~/.swan"));
export const LEGACY_HOME = path.resolve(expandHome("~/.persona-harness"));

// The desktop app ships the Containerfile and examples outside the repository layout.
const RESOURCES = process.env.PH_RESOURCES ? path.resolve(process.env.PH_RESOURCES) : null;

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
  extraCa: path.join(PH_HOME, "ca", "extra-roots.pem"), // caFiles combined, for programs Swan starts
  serverLock: path.join(PH_HOME, "server.json"), // the server running for this home
  containerfile: path.join(RESOURCES ?? REPO_ROOT, "sandbox/Containerfile"),
  containerfileBase: path.join(RESOURCES ?? REPO_ROOT, "sandbox/Containerfile.base"), // over an image of your own
  examples: path.join(RESOURCES ?? REPO_ROOT, "examples"),
};

const ProviderSchema = z.object({
  type: z.enum(["anthropic", "openai", "copilot"]),
  baseURL: z.string().optional(),
  apiKeySecret: z.string().optional(), // name in the secrets store
  // copilot only: fall back to the host's `copilot login` when no token is in the secrets store
  useLoggedInUser: z.boolean().optional(),
});

// URLs and image references end up in the sandbox image's setup script: nothing that could break out of it.
const HttpUrl = z.string().regex(/^https?:\/\/[^\s'"#\\`$]+$/, "expected an http(s) URL without spaces, quotes, # or $");
const ImageRef = z.string().regex(/^[a-z0-9][a-z0-9._\-/:@]*$/i, "expected an image reference such as registry.example.com/library/node:22-bookworm-slim");

export const SettingsSchema = z.object({
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
  // For networks that reach the internet only through a proxy and internal mirrors.
  proxy: z
    .object({
      // Model calls, http MCP servers, the Copilot runtime, connection wrappers, the image build and agents' traffic use it.
      url: HttpUrl.refine((u) => !/^https?:\/\/[^/]*@/.test(u), "a proxy that needs a username and password is not supported (config.yaml is not for secrets)"),
      noProxy: z.array(z.string().regex(/^[^\s,]+$/, "expected a host or .domain")).default([]), // reached directly; localhost always is
    })
    .optional(),
  caFiles: z.array(z.string()).default([]), // extra root certificates (PEM), trusted by Swan and inside the sandbox
  mirrors: z
    .object({
      baseImage: ImageRef.optional(), // instead of docker.io/library/node:22-bookworm-slim
      apt: z.record(HttpUrl, HttpUrl).default({}), // Debian source URL -> mirror URL
      pypi: HttpUrl.optional(), // pip and uv index
      npm: HttpUrl.optional(), // npm registry
    })
    .prefault({}),
  // Extra tools in the sandbox image for every persona (kubectl, the AWS CLI…). Changing it rebuilds the image.
  sandboxTools: z
    .object({
      packages: z.array(z.string().regex(/^[a-z0-9][a-z0-9+.-]*(=[A-Za-z0-9.+:~-]+)?$/, "expected a Debian package name, or name=version")).default([]),
      install: z.string().max(20_000).optional(), // shell script, run as root while the image builds
    })
    .prefault({}),
  connections: z.unknown().optional(), // validated and hot-reloaded by the ConnectionManager
  toolOutputLimit: z.number().int().default(30_000),
  bashTimeoutMs: z.number().int().default(120_000),
  contextLimitTokens: z.number().int().default(200_000), // assumed model context when the provider does not say
  rolloverAt: z.number().min(0.3).max(0.95).default(0.75), // share of the context that triggers a new epoch
  // What opens a new epoch: "full" structured checkpoint + recent events, "minimal" continuity
  // checkpoint + short tail, or "retrieval" (a continuation pointer only; the agent pulls history).
  rolloverStrategy: z.enum(["full", "minimal", "retrieval"]).default("full"),
});

export type Settings = z.infer<typeof SettingsSchema>;
export type ProviderConfig = z.infer<typeof ProviderSchema>;

const DEFAULT_CONFIG = `# Swan settings. Restart the server after editing this file
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
# Behind a proxy or internal mirrors (e.g. an Artifactory), uncomment and adjust (docs/DESKTOP.md):
# proxy: { url: http://proxy.example.com:8080, noProxy: [.example.com] }
# caFiles: [~/certs/company-root.pem]
# mirrors:
#   baseImage: artifactory.example.com/docker-remote/library/node:22-bookworm-slim
#   pypi: https://artifactory.example.com/artifactory/api/pypi/pypi-remote/simple
# Extra tools in the sandbox (Debian packages, and a script run as root while the image builds):
# sandboxTools:
#   packages: [postgresql-client]
#   install: |
#     curl -fsSLo /usr/local/bin/kubectl "https://dl.k8s.io/release/v1.31.2/bin/linux/$(dpkg --print-architecture)/kubectl"
#     chmod +x /usr/local/bin/kubectl
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
