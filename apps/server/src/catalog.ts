import type { Effort, ModelOption, ProviderAllowance } from "@ph/shared";
import type { ProviderRegistry } from "./agent/providers.js";
import type { SecretStore } from "./secrets.js";
import type { Settings } from "./settings.js";
import { errMsg, log, nowIso } from "./util.js";

const ALL: Effort[] = ["low", "medium", "high", "xhigh", "max"];

// Current Claude models (no live listing needed; ids are stable).
const ANTHROPIC: { id: string; label: string }[] = [
  { id: "claude-opus-5-5", label: "Claude Opus 5.5" },
  { id: "claude-sonnet-5-5", label: "Claude Sonnet 5.5" },
  { id: "claude-haiku-5-5", label: "Claude Haiku 5.5" },
  { id: "claude-fable-5-1", label: "Claude Fable 5.1" },
];

const USAGE_PAGES: Record<string, string> = {
  anthropic: "https://console.anthropic.com/usage",
  openai: "https://platform.openai.com/usage",
  copilot: "https://github.com/settings/copilot",
};

/** Every provider's selectable models for the composer's model selector. Listing never bills. */
export class ModelCatalog {
  private cache: { at: number; models: ModelOption[] } | null = null;

  constructor(
    private settings: Settings,
    private secrets: SecretStore,
    private providers: ProviderRegistry,
  ) {}

  invalidate() {
    this.cache = null;
  }

  async list(): Promise<ModelOption[]> {
    if (this.cache && Date.now() - this.cache.at < 5 * 60_000) return this.cache.models;
    const status = new Map(this.providers.status().map((p) => [p.name, p.ready]));
    const out: ModelOption[] = [];
    await Promise.all(
      Object.entries(this.settings.providers).map(async ([name, cfg]) => {
        const ready = status.get(name) ?? false;
        try {
          if (cfg.type === "anthropic") {
            for (const m of ANTHROPIC) out.push({ provider: name, providerType: "anthropic", id: m.id, label: m.label, efforts: ALL, ready });
          } else if (cfg.type === "copilot") {
            if (!ready) return;
            for (const m of await this.providers.listModels(name)) {
              if (!m.enabled) continue;
              out.push({ provider: name, providerType: "copilot", id: m.id, label: m.name, efforts: m.reasoningEfforts, preview: true, ready });
            }
          } else {
            // OpenAI-compatible: ask the server's /models (local servers answer instantly; listing is free).
            const key = cfg.apiKeySecret ? (this.secrets.value(cfg.apiKeySecret) ?? process.env[cfg.apiKeySecret]) : undefined;
            if (cfg.apiKeySecret && !key) return;
            const res = await fetch(`${cfg.baseURL?.replace(/\/$/, "")}/models`, { headers: key ? { authorization: `Bearer ${key}` } : {}, signal: AbortSignal.timeout(3000) });
            if (!res.ok) return;
            const data = ((await res.json()) as { data?: { id: string }[] }).data ?? [];
            const ids = data.map((d) => d.id).filter((id) => !cfg.baseURL?.includes("api.openai.com") || /^(gpt|o\d)/.test(id));
            for (const id of ids.slice(0, 40)) out.push({ provider: name, providerType: "openai", id, label: id, efforts: [], ready: true });
          }
        } catch (e) {
          log.info("catalog", `${name}: ${errMsg(e)}`);
        }
      }),
    );
    out.sort((a, b) => a.provider.localeCompare(b.provider) || a.label.localeCompare(b.label));
    this.cache = { at: Date.now(), models: out };
    return out;
  }

  /**
   * Account allowance. No provider here exposes a verified read-only quota endpoint for these
   * connections yet, so this says so instead of estimating.
   */
  allowance(name: string): ProviderAllowance {
    const cfg = this.settings.providers[name];
    if (!cfg) throw new Error(`unknown provider "${name}"`);
    return {
      provider: name,
      available: false,
      detail: cfg.type === "copilot" ? "Per-request AI credits are counted in Swan usage; the remaining allowance is not reported to apps." : "Unavailable for this connection",
      usagePage: cfg.baseURL && !cfg.baseURL.includes("openai.com") ? undefined : USAGE_PAGES[cfg.type],
      observedAt: nowIso(),
    };
  }
}
