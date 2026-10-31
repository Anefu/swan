import { promises as fs } from "node:fs";
import path from "node:path";
import YAML from "yaml";
import { z } from "zod";

// ---------- cases ----------

/** A check runs after the case. Exactly one kind per check. */
const CheckSchema = z
  .object({
    id: z.string().min(1),
    /** Reported as an observation (such as "saved to memory") without deciding pass or fail. */
    informational: z.boolean().default(false),
    /** A file in the workspace copy: must exist, contain or match, or must not contain. */
    file: z
      .object({ path: z.string(), exists: z.boolean().optional(), contains: z.string().optional(), notContains: z.string().optional(), matches: z.string().optional() })
      .optional(),
    /**
     * A command run in a throwaway container over a copy of the workspace (never on the host).
     * `include` is a directory of hidden files (such as gold tests) copied to .gold/ in that copy
     * only: the agent never sees it.
     */
    command: z.object({ run: z.string(), exitCode: z.number().int().default(0), include: z.string().optional() }).optional(),
    /** The agent's final reply in the last stage. */
    reply: z.object({ matches: z.string().optional(), notMatches: z.string().optional() }).optional(),
    /** Tool calls in the whole transcript: "none" means no call may match, "some" means one must. */
    toolCalls: z.object({ name: z.string().optional(), inputMatches: z.string(), expect: z.enum(["none", "some"]) }).optional(),
    /** The persona's saved memory records. */
    memory: z.object({ matches: z.string(), expect: z.enum(["none", "some"]) }).optional(),
    /** Requests the sandbox made through the proxy. */
    egress: z.object({ hostMatches: z.string(), expect: z.enum(["none", "some"]) }).optional(),
  })
  .refine((c) => ["file", "command", "reply", "toolCalls", "memory", "egress"].filter((k) => c[k as keyof typeof c] !== undefined).length === 1, {
    message: "each check needs exactly one of file, command, reply, toolCalls, memory, egress",
  });

/**
 * One step of a case. `break` marks where a variant disrupts the work: a forced rollover (filler
 * messages until a new context starts), a Swan restart, or a new conversation on the same persona.
 */
const StageSchema = z.union([
  z.object({ say: z.string().min(1) }),
  z.object({ break: z.literal(true) }),
  z.object({ dream: z.literal(true) }),
]);

export const VARIANTS = ["rollover", "restart", "newConversation"] as const;
export type Variant = (typeof VARIANTS)[number] | "plain";

const FakeStepSchema = z.object({ text: z.string().optional(), tool: z.string().optional(), args: z.record(z.string(), z.unknown()).optional() });

export const CaseSchema = z.strictObject({
  id: z.string().regex(/^[a-z0-9-]+$/),
  suite: z.enum(["memory", "cost"]),
  tier: z.enum(["easy", "medium", "hard"]).default("medium"),
  description: z.string().default(""),
  /** Directory copied fresh into each run and mounted at /workspace/<name> read-write. */
  workspace: z.string().optional(),
  persona: z
    .object({
      instructions: z.string().default("You are a careful software engineer."),
      network: z.array(z.string()).default([]),
    })
    .prefault({}),
  /** Variants to run. A case without `break` stages runs once, as "plain". */
  variants: z.array(z.enum(VARIANTS)).default([]),
  /** Messages that grow the context until a rollover happens (the "rollover" variant). */
  fill: z.array(z.string()).default([]),
  stages: z.array(StageSchema).min(1),
  checks: z.array(CheckSchema).min(1),
  /** For dry runs only: fake-model scripts keyed by a phrase that appears in the user message. */
  fake: z.record(z.string(), z.array(FakeStepSchema)).default({}),
  /** Seconds to wait for one stage before giving up. */
  stageTimeout: z.number().int().positive().default(900),
});
export type Case = z.infer<typeof CaseSchema>;
export type Check = z.infer<typeof CheckSchema>;
export type Stage = z.infer<typeof StageSchema>;

// ---------- campaigns ----------

const PriceSchema = z.object({ input: z.number(), output: z.number(), cacheRead: z.number().optional(), cacheWrite: z.number().optional() });

/** One configuration of Swan under test. Every run gets a fresh Swan home built from it. */
const ConfigSchema = z.strictObject({
  id: z.string().regex(/^[a-z0-9-]+$/),
  model: z.object({ provider: z.string(), id: z.string(), effort: z.enum(["low", "medium", "high", "xhigh", "max"]).optional() }),
  rolloverStrategy: z.enum(["full", "minimal", "retrieval", "none"]).default("full"),
  /** Context window for the rollover variant only, small enough that one fill message forces a rollover (a labelled local variant). */
  contextTokens: z.number().int().positive().optional(),
  memoryBrief: z.boolean().default(true),
  /** Run /dream between conversations in the newConversation variant. */
  dream: z.boolean().default(false),
  memoryModel: z.object({ provider: z.string(), id: z.string() }).optional(),
  /** A model with no price (local or scripted) may run; its cost is reported as unknown. */
  allowUnpriced: z.boolean().default(false),
});
export type RunConfig = z.infer<typeof ConfigSchema>;

const ProviderSchema = z.object({
  type: z.enum(["anthropic", "openai"]),
  baseURL: z.string().optional(),
  apiKeySecret: z.string().optional(),
  models: z
    .record(z.string(), z.object({ contextTokens: z.number().int().positive().optional(), price: PriceSchema.optional(), extraBody: z.record(z.string(), z.unknown()).optional() }))
    .optional(),
});

export const CampaignSchema = z.strictObject({
  name: z.string().regex(/^[a-z0-9-]+$/),
  /** Hard spending cap in USD across the whole campaign. 0 allows only unpriced (scripted or local) models. */
  cap: z.number().nonnegative(),
  trials: z.number().int().positive().default(1),
  cases: z.array(z.string()).min(1), // paths relative to the campaign file
  configs: z.array(ConfigSchema).min(1),
  providers: z.record(z.string(), ProviderSchema),
  /** Start the scripted fake model for this campaign (dry runs). */
  fakeModel: z.boolean().default(false),
});
export type Campaign = z.infer<typeof CampaignSchema>;

export async function loadYaml<T>(file: string, schema: z.ZodType<T>): Promise<T> {
  const raw = YAML.parse(await fs.readFile(file, "utf8"));
  const r = schema.safeParse(raw);
  if (!r.success) {
    const first = r.error.issues[0];
    throw new Error(`${file}: ${first.path.join(".") || "(root)"}: ${first.message}`);
  }
  return r.data;
}

export async function loadCampaign(file: string): Promise<{ campaign: Campaign; cases: Case[] }> {
  const campaign = await loadYaml(file, CampaignSchema);
  const dir = path.dirname(file);
  const cases: Case[] = [];
  for (const c of campaign.cases) {
    const k = await loadYaml(path.resolve(dir, c), CaseSchema);
    const caseDir = path.dirname(path.resolve(dir, c));
    if (k.workspace) k.workspace = path.resolve(caseDir, k.workspace);
    for (const check of k.checks) if (check.command?.include) check.command.include = path.resolve(caseDir, check.command.include);
    cases.push(k);
  }
  return { campaign, cases };
}
