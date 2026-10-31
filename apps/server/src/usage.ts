import { promises as fs } from "node:fs";
import path from "node:path";
import type { UsageReport, UsageTotals } from "@ph/shared";
import { paths, type ModelPrice } from "./settings.js";
import { TypedEmitter, nowIso, randomId } from "./util.js";

export type UsagePurpose = "foreground" | "subagent" | "checkpoint" | "dream";

export interface UsageEvent {
  id: string;
  ts: string;
  personaId: string;
  sessionId: string;
  epoch: number;
  provider: string;
  providerType: string;
  model: string;
  purpose: UsagePurpose;
  inputTokens: number; // uncached input (OpenAI-style prompt_tokens minus cached_tokens)
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  credits?: number; // Copilot AI credits, when reported
  costUsd: number | null; // estimate from the rate table; null = unavailable
}

// USD per million tokens: input, output, cache read, cache write (5-minute). Estimates, not invoices.
const RATES_VERSION = "2026-10";
const RATES: Record<string, [number, number, number, number]> = {
  "claude-fable-5-1": [10, 50, 0.25, 12.5],
  "claude-opus-5-5": [4, 20, 0.2, 5],
  "claude-sonnet-5-5": [2, 10, 0.2, 2.5],
  "claude-haiku-5-5": [0.1, 0.5, 0.01, 0.125],
};

/**
 * Estimated USD for one request. `inputTokens` is uncached input for every provider. A price from
 * config.yaml wins; otherwise only Anthropic models have built-in rates, and subscriptions and local
 * models without a configured price have none.
 */
export function estimateCost(
  e: Pick<UsageEvent, "providerType" | "model" | "inputTokens" | "outputTokens" | "cacheReadTokens" | "cacheWriteTokens">,
  price?: ModelPrice,
): number | null {
  const r: [number, number, number, number] | undefined = price
    ? [price.input, price.output, price.cacheRead ?? price.input, price.cacheWrite ?? price.input]
    : e.providerType === "anthropic"
      ? RATES[e.model]
      : undefined;
  if (!r) return null;
  return (e.inputTokens * r[0] + e.outputTokens * r[1] + e.cacheReadTokens * r[2] + e.cacheWriteTokens * r[3]) / 1e6;
}

const empty = (): UsageTotals => ({ inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, costUsd: 0, credits: null, requests: 0 });

function add(t: UsageTotals, e: UsageEvent) {
  t.inputTokens += e.inputTokens;
  t.outputTokens += e.outputTokens;
  t.cacheReadTokens += e.cacheReadTokens;
  t.requests += 1;
  // A request with neither a price nor reported credits makes the dollar total unknown, not lower.
  if (e.costUsd !== null) t.costUsd = t.costUsd === null ? null : t.costUsd + e.costUsd;
  else if (e.credits === undefined) t.costUsd = null;
  if (e.credits !== undefined) t.credits = (t.credits ?? 0) + e.credits;
}

/** Local usage ledger: one redacted line per model request in audit/usage-YYYY-MM-DD.jsonl. */
export class UsageLedger extends TypedEmitter<{ recorded: [UsageEvent] }> {
  private events: UsageEvent[] = [];

  /** `priceFor` returns a model's configured price, if config.yaml sets one. */
  constructor(private priceFor: (provider: string, model: string) => ModelPrice | undefined = () => undefined) {
    super();
  }
  private context = new Map<string, { usedTokens: number; limitTokens: number; estimated: boolean; epoch: number }>();

  async load() {
    try {
      const files = (await fs.readdir(paths.audit)).filter((f) => f.startsWith("usage-")).sort().slice(-31);
      for (const f of files) {
        for (const line of (await fs.readFile(path.join(paths.audit, f), "utf8")).split("\n")) {
          if (!line.trim()) continue;
          try {
            this.events.push(JSON.parse(line));
          } catch {}
        }
      }
    } catch {}
  }

  record(e: Omit<UsageEvent, "id" | "ts" | "costUsd">): UsageEvent {
    const ev: UsageEvent = { id: randomId("u_", 6), ts: nowIso(), ...e, costUsd: estimateCost(e, this.priceFor(e.provider, e.model)) };
    this.events.push(ev);
    const file = path.join(paths.audit, `usage-${ev.ts.slice(0, 10)}.jsonl`);
    void fs.appendFile(file, JSON.stringify({ ...ev, ratesVersion: RATES_VERSION }) + "\n", { mode: 0o600 }).catch(() => {});
    this.emit("recorded", ev);
    return ev;
  }

  setContext(personaId: string, c: { usedTokens: number; limitTokens: number; estimated: boolean; epoch: number }) {
    this.context.set(personaId, c);
  }

  report(personaId: string, period: "today" | "all"): UsageReport {
    const today = new Date().toLocaleDateString("en-CA"); // local calendar day, YYYY-MM-DD
    const evs = this.events.filter(
      (e) => e.personaId === personaId && (period === "all" || new Date(e.ts).toLocaleDateString("en-CA") === today),
    );
    const total = empty();
    const byPurpose: Record<string, UsageTotals> = {};
    for (const e of evs) {
      add(total, e);
      add((byPurpose[e.purpose] ??= empty()), e);
    }
    return { personaId, period, total, byPurpose, context: this.context.get(personaId) ?? null, updatedAt: nowIso() };
  }
}
