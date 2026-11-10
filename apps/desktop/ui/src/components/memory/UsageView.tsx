// Tokens, cost and context for the persona, today or in all.
import { useState } from "react";
import type { PersonaSummary, ProviderAllowance, UsageReport, UsageTotals } from "@ph/shared";
import { api } from "../../api";
import { useStore, type MemoryPaneState } from "../../store";
import { fmtNumber, fmtTokens, fmtUsd, fullTime, relTime, useNow } from "../../util";
import { IconExternal, IconRefresh } from "../icons";
import { Segmented, Spinner } from "../ui";
import { useLoad } from "../../hooks";
import { Unavailable } from "./Unavailable";

export function UsageView({ persona, ps, set }: { persona: PersonaSummary; ps: MemoryPaneState; set: (p: Partial<MemoryPaneState>) => void }) {
  const { state } = useStore();
  const now = useNow(15_000);
  const rev = state.usageRev[persona.id] ?? 0;
  const usage = useLoad<UsageReport>(() => api.usage(persona.id, ps.period), [persona.id, ps.period, rev]);
  const provider = persona.model.provider;
  const allowance = useLoad<ProviderAllowance>(() => api.allowance(provider), [provider]);
  const [refreshedAt, setRefreshedAt] = useState(() => Date.now());

  const refresh = () => {
    usage.reload();
    allowance.reload();
    setRefreshedAt(Date.now());
  };

  const u = usage.data;
  const a = allowance.data;
  return (
    <div className="usage">
      <section className="usage-section">
        <h3>Context</h3>
        {u?.context ? (
          <ContextMeter c={u.context} />
        ) : u ? (
          <p className="muted">No active context yet.</p>
        ) : (
          <p className="muted">Unavailable</p>
        )}
      </section>

      <section className="usage-section">
        <div className="row gap">
          <h3 className="grow">Swan usage</h3>
          <Segmented
            label="Period"
            value={ps.period}
            onChange={(period) => set({ period })}
            options={[
              { value: "today", label: "Today" },
              { value: "all", label: "All time" },
            ]}
          />
        </div>
        {usage.loading && !u ? (
          <div className="pane-state">
            <Spinner size={12} /> Loading…
          </div>
        ) : !u ? (
          <Unavailable what="Usage" error={usage.error ?? ""} missing={usage.missing} onRetry={usage.reload} />
        ) : (
          <>
            <Totals t={u.total} />
            <p className="hint">Counted by Swan from provider responses; includes memory work. Not your account total.</p>
            {Object.keys(u.byPurpose).length > 0 && (
              <details className="breakdown">
                <summary>By purpose</summary>
                <div className="table-scroll">
                  <table className="mini-table">
                    <thead>
                      <tr>
                        <th scope="col">Purpose</th>
                        <th scope="col">Input</th>
                        <th scope="col">Output</th>
                        <th scope="col">Cost</th>
                      </tr>
                    </thead>
                    <tbody>
                      {Object.entries(u.byPurpose).map(([k, t]) => (
                        <tr key={k}>
                          <th scope="row">{PURPOSE_LABEL[k] ?? k[0].toUpperCase() + k.slice(1)}</th>
                          <td>{fmtTokens(t.inputTokens)}</td>
                          <td>{fmtTokens(t.outputTokens)}</td>
                          <td>{t.costUsd === null ? "Unavailable" : fmtUsd(t.costUsd)}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </details>
            )}
          </>
        )}
      </section>

      <section className="usage-section">
        <div className="row gap">
          <h3 className="grow">Provider allowance</h3>
          <span className="small muted">{provider}</span>
        </div>
        {allowance.loading && !a ? (
          <div className="pane-state">
            <Spinner size={12} /> Checking…
          </div>
        ) : a ? (
          <>
            <p>{a.available ? a.detail : a.detail || "Unavailable for this connection"}</p>
            <div className="row gap wrap small muted">
              <span title={fullTime(a.observedAt)}>{agoText(a.observedAt, now, "Checked")}</span>
              {allowance.error && <span className="tone-attention">Stale: {allowance.error}</span>}
              {a.usagePage && (
                <a href={a.usagePage} target="_blank" rel="noopener noreferrer">
                  Open provider usage <IconExternal size={12} />
                </a>
              )}
            </div>
          </>
        ) : (
          <p>Unavailable for this connection</p>
        )}
      </section>

      <div className="row gap usage-foot">
        <span className="grow small muted">
          {usage.error && u ? <span className="tone-attention">Could not refresh: {usage.error}. Showing the last report.</span> : agoText(u?.updatedAt ?? new Date(refreshedAt).toISOString(), now, "Updated")}
        </span>
        <button type="button" className="btn sm" onClick={refresh} disabled={usage.loading}>
          {usage.loading ? <Spinner size={10} /> : <IconRefresh />}
          Refresh
        </button>
      </div>
    </div>
  );
}

const PURPOSE_LABEL: Record<string, string> = {
  foreground: "Conversation",
  checkpoint: "Checkpoints",
  extraction: "Memory extraction",
  dream: "/dream",
  dreaming: "/dream",
  subagent: "Sub-agents",
};

function Totals({ t }: { t: UsageTotals }) {
  return (
    <dl className="totals">
      <dt>Input</dt>
      <dd title={fmtNumber(t.inputTokens)}>{fmtTokens(t.inputTokens)}</dd>
      <dt>Output</dt>
      <dd title={fmtNumber(t.outputTokens)}>{fmtTokens(t.outputTokens)}</dd>
      <dt>Cached input</dt>
      <dd title={fmtNumber(t.cacheReadTokens)}>{fmtTokens(t.cacheReadTokens)}</dd>
      <dt>Estimated cost</dt>
      <dd>{t.costUsd === null ? "Cost unavailable" : fmtUsd(t.costUsd)}</dd>
      {t.credits !== null && (
        <>
          <dt>AI credits</dt>
          <dd>{t.credits}</dd>
        </>
      )}
      <dt>Requests</dt>
      <dd>{fmtNumber(t.requests)}</dd>
    </dl>
  );
}

function ContextMeter({ c }: { c: NonNullable<UsageReport["context"]> }) {
  const pct = c.limitTokens > 0 ? Math.min(100, Math.round((c.usedTokens / c.limitTokens) * 100)) : 0;
  return (
    <div className="context">
      <div className="row gap small">
        <span className="grow">
          {fmtTokens(c.usedTokens)} / {fmtTokens(c.limitTokens)} tokens · {c.estimated ? "Estimated" : "Measured"}
        </span>
        <span className="muted">Context {c.epoch}</span>
      </div>
      <div
        className="meter"
        role="meter"
        aria-label="Context used"
        aria-valuemin={0}
        aria-valuemax={c.limitTokens}
        aria-valuenow={c.usedTokens}
        aria-valuetext={`${pct}% of the model's context`}
      >
        <span style={{ width: `${pct}%` }} />
      </div>
      <p className="hint">The context rolls over to a new checkpoint before it fills up. This is not your provider allowance.</p>
    </div>
  );
}

function agoText(iso: string, now: number, verb: string): string {
  const ago = relTime(iso, now);
  if (!ago) return "";
  if (ago === "now") return `${verb} just now`;
  return /^\d/.test(ago) ? `${verb} ${ago} ago` : `${verb} ${ago}`;
}
