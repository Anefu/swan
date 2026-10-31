import { promises as fs } from "node:fs";
import path from "node:path";
import type { ChatItem, EgressEvent, MemoryRecord, PendingApproval, SessionSummary } from "@ph/shared";
import { runCheck, type CheckResult, type Evidence } from "./checks.js";
import type { Campaign, Case, RunConfig, Variant } from "./schema.js";
import { BENCH, cleanupPodman, prepareHome, sleep, Swan } from "./swan.js";

export class CapReached extends Error {}

export interface UsageLine {
  purpose: string;
  provider: string;
  model: string;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  costUsd: number | null;
}

export interface RunResult {
  campaign: string;
  caseId: string;
  suite: Case["suite"];
  tier: Case["tier"];
  variant: Variant;
  configId: string;
  model: string;
  trial: number;
  /** pass/fail are the agent's; error is the harness or environment, reported apart. */
  status: "pass" | "fail" | "error";
  error?: string;
  checks: CheckResult[];
  costUsd: number | null;
  costByPurpose: Record<string, number | null>;
  tokens: { input: number; output: number; cacheRead: number; cacheWrite: number };
  requests: number;
  rollovers: number;
  conversations: number;
  deniedApprovals: number;
  wallMs: number;
}

/** Usage the run's Swan recorded, from its audit log. */
export async function readUsage(home: string): Promise<UsageLine[]> {
  const dir = path.join(home, "audit");
  const files = (await fs.readdir(dir).catch(() => [] as string[])).filter((f) => f.startsWith("usage-"));
  const out: UsageLine[] = [];
  for (const f of files)
    for (const line of (await fs.readFile(path.join(dir, f), "utf8")).split("\n")) {
      if (!line.trim()) continue;
      try {
        out.push(JSON.parse(line));
      } catch {}
    }
  return out;
}

/** Spend so far; unknown when a request has no price. */
export function spend(lines: UsageLine[]): { usd: number; unpriced: UsageLine[] } {
  let usd = 0;
  const unpriced: UsageLine[] = [];
  for (const l of lines) {
    if (l.costUsd === null) unpriced.push(l);
    else usd += l.costUsd;
  }
  return { usd, unpriced };
}

type SessionView = { session: SessionSummary; items: ChatItem[] };

interface Ctx {
  swan: Swan;
  home: string;
  kase: Case;
  config: RunConfig;
  cap: number;
  spentBefore: number;
  denied: number;
}

/** Stops the run when the campaign cap is reached, or when a model has no price and may not run unpriced. */
async function guard(ctx: Ctx, sid: string) {
  const s = spend(await readUsage(ctx.home));
  if (s.unpriced.length && !ctx.config.allowUnpriced) {
    await ctx.swan.api("POST", `/api/sessions/${sid}/interrupt`).catch(() => {});
    const u = s.unpriced[0];
    throw new CapReached(`no price for ${u.provider}/${u.model}: add one under the campaign's providers, or set allowUnpriced`);
  }
  if (ctx.spentBefore + s.usd >= ctx.cap && s.usd > 0) {
    await ctx.swan.api("POST", `/api/sessions/${sid}/interrupt`).catch(() => {});
    throw new CapReached(`spending cap of $${ctx.cap} reached ($${(ctx.spentBefore + s.usd).toFixed(2)} spent)`);
  }
}

/**
 * Send a message and wait for the turn to finish: something after the message, then an idle
 * session. Approvals are scripted: anything that asks (an unlisted host) is refused.
 */
async function say(ctx: Ctx, sid: string, text: string): Promise<SessionView> {
  const before = (await ctx.swan.api<SessionView>("GET", `/api/sessions/${sid}`)).items.length;
  await ctx.swan.api("POST", `/api/sessions/${sid}/messages`, { text });
  const started = Date.now();
  const isDream = text.trim() === "/dream";
  for (;;) {
    await sleep(1000);
    const view = await ctx.swan.api<SessionView>("GET", `/api/sessions/${sid}`);
    const after = view.items.slice(before);
    if (view.session.status === "awaiting_approval") {
      const pending = (await ctx.swan.api<PendingApproval[]>("GET", "/api/approvals")).filter((a) => a.sessionId === sid);
      for (const a of pending) {
        await ctx.swan.api("POST", `/api/sessions/${sid}/approvals/${encodeURIComponent(a.toolUseId)}`, { decision: "deny", reason: "Not allowed in this benchmark run." });
        ctx.denied += 1;
      }
    }
    const idle = ["idle", "stopped", "error"].includes(view.session.status) && view.session.queued === 0;
    const answered = isDream
      ? after.some((it) => it.kind === "receipt" && it.action === "dream" && it.status !== "running")
      : after.some((it) => it.kind === "assistant_text" || (it.kind === "notice" && it.level === "error"));
    if (idle && answered) return view;
    await guard(ctx, sid);
    if (Date.now() - started > ctx.kase.stageTimeout * 1000) {
      await ctx.swan.api("POST", `/api/sessions/${sid}/interrupt`).catch(() => {});
      throw new Error(`a stage took longer than ${ctx.kase.stageTimeout}s`);
    }
  }
}

async function conversation(ctx: Ctx): Promise<string> {
  return (await ctx.swan.api<SessionView>("GET", `/api/personas/${BENCH.persona}/conversation`)).session.id;
}

/** One case, in one variant, under one configuration. Always stops its Swan and removes its containers. */
export async function runOne(o: {
  campaign: Campaign;
  config: RunConfig;
  kase: Case;
  variant: Variant;
  trial: number;
  dir: string;
  caDir: string;
  secrets: Record<string, string>;
  spentBefore: number;
}): Promise<RunResult> {
  const started = Date.now();
  await fs.mkdir(o.dir, { recursive: true });
  const { home, workspace } = await prepareHome({ dir: o.dir, campaign: o.campaign, config: o.config, kase: o.kase, secrets: o.secrets, caDir: o.caDir });
  const swan = new Swan(home, path.join(o.dir, "swan.log"));
  const ctx: Ctx = { swan, home, kase: o.kase, config: o.config, cap: o.campaign.cap, spentBefore: o.spentBefore, denied: 0 };
  const sessions: string[] = [];
  const result: RunResult = {
    campaign: o.campaign.name,
    caseId: o.kase.id,
    suite: o.kase.suite,
    tier: o.kase.tier,
    variant: o.variant,
    configId: o.config.id,
    model: `${o.config.model.provider}/${o.config.model.id}`,
    trial: o.trial,
    status: "error",
    checks: [],
    costUsd: null,
    costByPurpose: {},
    tokens: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    requests: 0,
    rollovers: 0,
    conversations: 0,
    deniedApprovals: 0,
    wallMs: 0,
  };
  let capError: CapReached | null = null;
  let imageTag = "";
  try {
    await swan.start();
    imageTag = (await swan.waitRuntime()).imageTag;
    // Keep the CA so later runs reuse the sandbox image instead of rebuilding it.
    await fs.cp(path.join(home, "ca"), o.caDir, { recursive: true, force: false, errorOnExist: false }).catch(() => {});
    let sid = await conversation(ctx);
    sessions.push(sid);
    for (const stage of o.kase.stages) {
      if ("say" in stage) await say(ctx, sid, stage.say);
      else if ("dream" in stage) await say(ctx, sid, "/dream");
      else if (o.variant === "rollover") {
        const epoch = (await swan.api<SessionView>("GET", `/api/sessions/${sid}`)).session.epoch;
        let rolled = false;
        for (const f of o.kase.fill) {
          const v = await say(ctx, sid, f);
          if (v.session.epoch > epoch) {
            rolled = true;
            break;
          }
        }
        if (!rolled) throw new Error("the fill messages did not start a new context: lower contextTokens or add fill");
      } else if (o.variant === "restart") {
        await swan.stop();
        await swan.start();
        await swan.waitRuntime();
      } else if (o.variant === "newConversation") {
        if (o.config.dream) await say(ctx, sid, "/dream");
        sid = (await swan.api<SessionSummary>("POST", "/api/sessions", { personaId: BENCH.persona })).id;
        sessions.push(sid);
      }
    }
  } catch (e) {
    if (e instanceof CapReached) capError = e;
    result.error = e instanceof Error ? e.message : String(e);
  }

  // Evidence and checks, even after an error, so a failed run can be diagnosed.
  try {
    const views = await Promise.all(sessions.map((id) => swan.api<SessionView>("GET", `/api/sessions/${id}`)));
    const memory = await swan.api<MemoryRecord[]>("GET", `/api/personas/${BENCH.persona}/memory?status=`).catch(() => [] as MemoryRecord[]);
    const egress = await swan.api<EgressEvent[]>("GET", "/api/egress?limit=2000").catch(() => [] as EgressEvent[]);
    const transcripts = views.map((v) => v.items);
    result.conversations = views.length;
    result.rollovers = transcripts.flat().filter((it) => it.kind === "receipt" && it.action === "rollover" && it.status !== "running").length;
    await fs.writeFile(path.join(o.dir, "transcripts.json"), JSON.stringify(transcripts, null, 2));
    await fs.writeFile(path.join(o.dir, "memory.json"), JSON.stringify(memory, null, 2));
    await fs.writeFile(path.join(o.dir, "egress.json"), JSON.stringify(egress, null, 2));
    if (!result.error) {
      const ev: Evidence = { workspace, transcripts, memory, egress, imageTag };
      for (const c of o.kase.checks) result.checks.push(await runCheck(c, ev));
      result.status = result.checks.every((c) => c.pass) ? "pass" : "fail";
    }
  } catch (e) {
    result.error ??= `collecting results: ${e instanceof Error ? e.message : String(e)}`;
    result.status = "error";
  } finally {
    await swan.stop();
    await cleanupPodman();
  }

  const usage = await readUsage(home);
  const s = spend(usage);
  result.costUsd = s.unpriced.length ? null : s.usd;
  for (const l of usage) {
    const cur = result.costByPurpose[l.purpose];
    result.costByPurpose[l.purpose] = cur === null || l.costUsd === null ? null : (cur ?? 0) + l.costUsd;
    result.tokens.input += l.inputTokens;
    result.tokens.output += l.outputTokens;
    result.tokens.cacheRead += l.cacheReadTokens;
    result.tokens.cacheWrite += l.cacheWriteTokens;
  }
  result.requests = usage.length;
  result.deniedApprovals = ctx.denied;
  result.wallMs = Date.now() - started;
  await fs.writeFile(path.join(o.dir, "usage.json"), JSON.stringify({ spentUsd: s.usd, lines: usage }, null, 2));
  await fs.writeFile(path.join(o.dir, "result.json"), JSON.stringify(result, null, 2));
  if (capError) throw Object.assign(capError, { result });
  return result;
}
