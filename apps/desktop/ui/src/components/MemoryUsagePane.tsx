import { useEffect, useRef, useState } from "react";
import type { Checkpoint, MemoryChange, MemoryRecord, MemoryType, PersonaSummary, ProviderAllowance, UsageReport, UsageTotals } from "@ph/shared";
import { api } from "../api";
import { DEFAULT_MEMORY_PANE, useSelectedPersona, useStore, type MemoryPaneState } from "../store";
import { clockTime, cls, errorMessage, fmtNumber, fmtTokens, fmtUsd, fullTime, isMissingEndpoint, relTime, useNow } from "../util";
import { PaneHead } from "./Cards";
import { IconChevronRight, IconExternal, IconLock, IconPin, IconPlus, IconRefresh, IconSearch } from "./icons";
import { Empty, Segmented, Spinner } from "./ui";

/** Scroll offsets per persona and view, kept for the session. */
const scrolls = new Map<string, number>();

/** Memory or Usage for the selected persona; both open from the overview and lead back to it. */
export function MemoryUsagePane({ mode, onBack }: { mode: "memory" | "usage"; onBack: () => void }) {
  const { state, actions } = useStore();
  const persona = useSelectedPersona();
  const bodyRef = useRef<HTMLDivElement>(null);
  const ps: MemoryPaneState = (persona && state.memoryPane[persona.id]) || DEFAULT_MEMORY_PANE;
  const scrollKey = persona ? `${persona.id}:${mode}:${mode === "memory" ? ps.sub : ""}` : "";
  const title = mode === "memory" ? "Memory" : "Usage";

  useEffect(() => {
    const el = bodyRef.current;
    if (!el) return;
    el.scrollTop = scrolls.get(scrollKey) ?? 0;
  }, [scrollKey]);

  const head = <PaneHead title={title} sub={persona?.name} onBack={onBack} backLabel="Back to overview" />;

  if (!persona) {
    return (
      <div className="pane">
        {head}
        <div className="pane-body">
          <Empty title="No persona selected" />
        </div>
      </div>
    );
  }
  const set = (patch: Partial<MemoryPaneState>) => actions.setMemoryPane(persona.id, patch);

  return (
    <div className="pane">
      {head}
      {mode === "memory" && (
        <div className="pane-tabs">
          <Segmented
            label="Memory view"
            variant="tabs"
            value={ps.sub}
            onChange={(sub) => set({ sub })}
            options={[
              { value: "saved", label: "Saved" },
              { value: "current", label: "Current work" },
              { value: "history", label: "History" },
            ]}
          />
        </div>
      )}
      <div className="pane-body" ref={bodyRef} onScroll={(e) => scrolls.set(scrollKey, e.currentTarget.scrollTop)}>
        {mode === "usage" ? (
          <UsageView persona={persona} ps={ps} set={set} />
        ) : ps.sub === "saved" ? (
          <SavedMemory persona={persona} ps={ps} set={set} />
        ) : ps.sub === "current" ? (
          <CurrentWork persona={persona} />
        ) : (
          <MemoryHistory persona={persona} />
        )}
      </div>
      {mode === "memory" && (
        <div className="pane-foot quiet">
          <IconLock size={14} />
          <span>Private to {persona.name}</span>
        </div>
      )}
    </div>
  );
}

/** Load something for the pane; refetch on deps; keep the previous value when a refresh fails. */
export function useLoad<T>(fn: () => Promise<T>, deps: unknown[]) {
  const [data, setData] = useState<T | undefined>(undefined);
  const [error, setError] = useState<string | null>(null);
  const [missing, setMissing] = useState(false);
  const [loading, setLoading] = useState(true);
  const [tick, setTick] = useState(0);
  useEffect(() => {
    let alive = true;
    setLoading(true);
    fn()
      .then((v) => {
        if (!alive) return;
        setData(v);
        setError(null);
        setMissing(false);
      })
      .catch((e) => {
        if (!alive) return;
        setMissing(isMissingEndpoint(e));
        setError(errorMessage(e));
      })
      .finally(() => alive && setLoading(false));
    return () => {
      alive = false;
    };
  }, [...deps, tick]); // eslint-disable-line react-hooks/exhaustive-deps
  return { data, setData, error, missing, loading, reload: () => setTick((t) => t + 1) };
}

function Unavailable({ what, error, missing, onRetry }: { what: string; error: string; missing: boolean; onRetry: () => void }) {
  return (
    <Empty
      title={missing ? `${what} is not available from this server yet` : `Could not load ${what.toLowerCase()}`}
      action={
        !missing && (
          <button type="button" className="btn sm" onClick={onRetry}>
            Try again
          </button>
        )
      }
    >
      {!missing && error}
    </Empty>
  );
}

// ---------- Saved ----------

const TYPES: MemoryType[] = ["preference", "decision", "observation", "procedure", "episode"];
const TYPE_LABEL: Record<MemoryType, string> = {
  preference: "Preference",
  decision: "Decision",
  observation: "Observation",
  procedure: "Procedure",
  episode: "Episode",
};
const ORIGIN_LABEL = { user: "You said it", observation: "Observed", inference: "Inferred" } as const;

function useDebounced<T>(v: T, ms: number): T {
  const [d, setD] = useState(v);
  useEffect(() => {
    const t = window.setTimeout(() => setD(v), ms);
    return () => window.clearTimeout(t);
  }, [v, ms]);
  return d;
}

function SavedMemory({ persona, ps, set }: { persona: PersonaSummary; ps: MemoryPaneState; set: (p: Partial<MemoryPaneState>) => void }) {
  const { state } = useStore();
  const [adding, setAdding] = useState(false);
  const query = useDebounced(ps.query, 250);
  const rev = state.memoryRev[persona.id] ?? 0;
  const { data, setData, error, missing, loading, reload } = useLoad(
    () => api.memory(persona.id, { query, type: ps.type, status: ps.status }),
    [persona.id, query, ps.type, ps.status, rev],
  );

  const replace = (r: MemoryRecord) => setData((list) => (list ? list.map((x) => (x.id === r.id ? r : x)) : list));

  return (
    <div className="mem">
      <label className="search-field">
        <IconSearch size={16} />
        <span className="sr-only">Search memory</span>
        <input placeholder="Search memory…" value={ps.query} onChange={(e) => set({ query: e.target.value })} />
      </label>
      <div className="row gap wrap mem-filters">
        <label className="mini-select">
          <span className="sr-only">Type</span>
          <select value={ps.type} onChange={(e) => set({ type: e.target.value })}>
            <option value="">All types</option>
            {TYPES.map((t) => (
              <option key={t} value={t}>
                {TYPE_LABEL[t]}
              </option>
            ))}
          </select>
        </label>
        <label className="mini-select">
          <span className="sr-only">Status</span>
          <select value={ps.status} onChange={(e) => set({ status: e.target.value })}>
            <option value="">Active and tentative</option>
            <option value="active">Active</option>
            <option value="tentative">Tentative</option>
            <option value="archived">Archived</option>
            <option value="forgotten">Forgotten</option>
          </select>
        </label>
        <span className="grow" />
        {!adding && (
          <button type="button" className="link-btn" onClick={() => setAdding(true)}>
            <IconPlus /> Add
          </button>
        )}
      </div>
      {adding && (
        <MemoryForm
          title="New memory"
          submitLabel="Save memory"
          showPin
          onCancel={() => setAdding(false)}
          onSubmit={async (content, type, pinned) => {
            const r = await api.addMemory(persona.id, { content, type, pinned });
            setData((list) => [r, ...(list ?? [])]);
            setAdding(false);
          }}
        />
      )}
      {loading && !data && (
        <div className="pane-state">
          <Spinner size={14} /> Loading memory…
        </div>
      )}
      {error && !data && <Unavailable what="Memory" error={error} missing={missing} onRetry={reload} />}
      {data && data.length === 0 && (
        <Empty title={ps.query || ps.type || ps.status ? "No memory matches" : "Nothing saved yet"}>
          {!ps.query && "Swan saves useful sourced observations and decisions as you work. Add one yourself with Add."}
        </Empty>
      )}
      {data && data.length > 0 && (
        <ul className="mem-list">
          {data.map((r) => (
            <RecordRow
              key={r.id}
              persona={persona}
              r={r}
              open={ps.expanded === r.id}
              onToggle={() => set({ expanded: ps.expanded === r.id ? null : r.id })}
              onChange={replace}
            />
          ))}
        </ul>
      )}
    </div>
  );
}

function MemoryForm({
  title,
  initial,
  initialType = "preference",
  submitLabel,
  showPin,
  onSubmit,
  onCancel,
}: {
  title: string;
  initial?: string;
  initialType?: MemoryType;
  submitLabel: string;
  showPin?: boolean;
  onSubmit: (content: string, type: MemoryType, pinned: boolean) => Promise<void>;
  onCancel: () => void;
}) {
  const [content, setContent] = useState(initial ?? "");
  const [type, setType] = useState<MemoryType>(initialType);
  const [pinned, setPinned] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  return (
    <form
      className="inline-form"
      aria-label={title}
      onSubmit={async (e) => {
        e.preventDefault();
        if (!content.trim()) return;
        setBusy(true);
        setError(null);
        try {
          await onSubmit(content.trim(), type, pinned);
        } catch (err) {
          setError(errorMessage(err));
          setBusy(false);
        }
      }}
    >
      <label className="field">
        <span className="field-label">{title}</span>
        <textarea
          className="input"
          rows={3}
          value={content}
          autoFocus
          onChange={(e) => setContent(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Escape") {
              e.stopPropagation();
              onCancel();
            }
          }}
        />
      </label>
      <div className="row gap wrap">
        <label className="mini-select">
          <span className="sr-only">Type</span>
          <select value={type} onChange={(e) => setType(e.target.value as MemoryType)}>
            {TYPES.map((t) => (
              <option key={t} value={t}>
                {TYPE_LABEL[t]}
              </option>
            ))}
          </select>
        </label>
        {showPin && (
          <label className="check-row">
            <input type="checkbox" checked={pinned} onChange={(e) => setPinned(e.target.checked)} />
            <span>Pin (always in the brief)</span>
          </label>
        )}
      </div>
      {error && <span className="field-error">{error}</span>}
      <div className="row gap end">
        <button type="button" className="btn sm" onClick={onCancel} disabled={busy}>
          Cancel
        </button>
        <button type="submit" className="btn primary sm" disabled={busy || !content.trim()}>
          {busy && <Spinner size={10} />}
          {submitLabel}
        </button>
      </div>
    </form>
  );
}

function SourceLinks({ persona, sources }: { persona: PersonaSummary; sources: string[] }) {
  const { actions } = useStore();
  if (sources.length === 0) return <span className="muted">None recorded</span>;
  return (
    <span className="source-links">
      {sources.map((s, i) =>
        s === "user" ? (
          <span key={i}>Your statement</span>
        ) : (
          <button key={i} type="button" className="link-btn inline" onClick={() => actions.jumpToItem(persona.id, s)}>
            Conversation event {i + 1}
            <IconExternal size={12} />
          </button>
        ),
      )}
    </span>
  );
}

function RecordRow({
  persona,
  r,
  open,
  onToggle,
  onChange,
}: {
  persona: PersonaSummary;
  r: MemoryRecord;
  open: boolean;
  onToggle: () => void;
  onChange: (r: MemoryRecord) => void;
}) {
  const { actions } = useStore();
  const [mode, setMode] = useState<null | "edit" | "forget">(null);
  const [busy, setBusy] = useState<string | null>(null);
  const first = r.content.split("\n")[0];
  const tentative = r.status === "tentative" || r.origin === "inference";

  const act = async (action: "pin" | "unpin" | "archive" | "forget") => {
    setBusy(action);
    try {
      onChange(await api.memoryAction(persona.id, r.id, action));
      setMode(null);
    } catch (e) {
      actions.reportError(e, "Memory not changed");
    } finally {
      setBusy(null);
    }
  };

  return (
    <li className={cls("mem-row", open && "is-open", r.pinned && "pinned", (r.status === "archived" || r.status === "forgotten") && "dim")}>
      <button type="button" className="mem-head" aria-expanded={open} onClick={onToggle}>
        <span className="mem-pin" aria-hidden="true">
          {r.pinned && <IconPin size={14} />}
        </span>
        <span className="mem-main">
          <span className="mem-text">{first}</span>
          <span className="mem-meta">
            {TYPE_LABEL[r.type]}
            {r.pinned && " · Pinned"}
            {tentative && r.status !== "archived" && r.status !== "forgotten" && " · Tentative"}
            {r.status === "archived" && " · Archived"}
            {r.status === "forgotten" && " · Forgotten"}
          </span>
        </span>
        <IconChevronRight className="chev" size={16} />
      </button>
      {open && (
        <div className="mem-body">
          {mode === "edit" ? (
            <MemoryForm
              title="Edit memory (saves a new version)"
              initial={r.content}
              initialType={r.type}
              submitLabel="Save version"
              onCancel={() => setMode(null)}
              onSubmit={async (content, type) => {
                onChange(await api.editMemory(persona.id, r.id, { content, type }));
                setMode(null);
              }}
            />
          ) : (
            <p className="mem-content">{r.content}</p>
          )}
          <dl className="facts">
            <dt>Origin</dt>
            <dd>{ORIGIN_LABEL[r.origin]}</dd>
            <dt>Sources</dt>
            <dd>
              <SourceLinks persona={persona} sources={r.sources} />
            </dd>
            <dt>Version</dt>
            <dd>
              {r.version} · updated <span title={fullTime(r.updatedAt)}>{relTime(r.updatedAt)}</span>
            </dd>
            <dt>Scope</dt>
            <dd>{persona.name} only</dd>
          </dl>
          {mode === "forget" ? (
            <div className="inline-form" role="group" aria-label="Forget this memory">
              <p className="small">
                Forgetting removes this memory from search and from future briefs at the next safe point. It does not erase the original
                conversation.
              </p>
              <div className="row gap end">
                <button type="button" className="btn sm" onClick={() => setMode(null)}>
                  Cancel
                </button>
                <button type="button" className="btn sm danger" disabled={!!busy} onClick={() => void act("forget")}>
                  {busy === "forget" && <Spinner size={10} />}
                  Forget
                </button>
              </div>
            </div>
          ) : (
            mode !== "edit" &&
            r.status !== "forgotten" && (
              <div className="row gap wrap">
                <button type="button" className="btn sm" onClick={() => setMode("edit")}>
                  Edit
                </button>
                <button type="button" className="btn sm" disabled={!!busy} onClick={() => void act(r.pinned ? "unpin" : "pin")}>
                  {(busy === "pin" || busy === "unpin") && <Spinner size={10} />}
                  {r.pinned ? "Unpin" : "Pin"}
                </button>
                {r.status !== "archived" && (
                  <button type="button" className="btn sm" disabled={!!busy} onClick={() => void act("archive")}>
                    {busy === "archive" && <Spinner size={10} />}
                    Archive
                  </button>
                )}
                <button type="button" className="btn sm" onClick={() => setMode("forget")}>
                  Forget…
                </button>
              </div>
            )
          )}
        </div>
      )}
    </li>
  );
}

// ---------- Current work ----------

function CurrentWork({ persona }: { persona: PersonaSummary }) {
  const { state } = useStore();
  const rev = state.memoryRev[persona.id] ?? 0;
  const { data, error, missing, loading, reload } = useLoad<Checkpoint | null>(() => api.checkpoint(persona.id), [persona.id, rev]);
  if (loading && data === undefined)
    return (
      <div className="pane-state">
        <Spinner size={14} /> Loading current work…
      </div>
    );
  if (error && data === undefined) return <Unavailable what="Current work" error={error} missing={missing} onRetry={reload} />;
  if (!data)
    return (
      <Empty title="No checkpoint yet">
        Swan saves a checkpoint of the task when the context rolls over: objective, constraints, progress and the next action.
      </Empty>
    );
  const list = (title: string, items: string[], tone?: string) =>
    items.length > 0 && (
      <section className="cp-section">
        <h4>{title}</h4>
        <ul className={cls("cp-list", tone)}>
          {items.map((x, i) => (
            <li key={i}>{x}</li>
          ))}
        </ul>
      </section>
    );
  return (
    <div className="checkpoint">
      <div className="row gap">
        <h3 className="grow">Current work</h3>
        <span className="small muted" title={fullTime(data.createdAt)}>
          Checkpoint saved · {clockTime(data.createdAt).slice(0, 5)} · context {data.epoch}
        </span>
      </div>
      <section className="cp-section">
        <h4>Objective</h4>
        <p>{data.objective || "Not recorded"}</p>
      </section>
      {list("Constraints", data.constraints)}
      {list("Decisions", data.decisions)}
      {list("Completed", data.completed, "done")}
      {list("Failures", data.failures)}
      {list("Open questions", data.openQuestions, "attention")}
      <section className="cp-section">
        <h4>Next action</h4>
        <p>{data.nextAction || "Not recorded"}</p>
      </section>
      <section className="cp-section">
        <h4>Sources</h4>
        <SourceLinks persona={persona} sources={data.sources} />
      </section>
    </div>
  );
}

// ---------- History ----------

const ACTION_LABEL: Record<MemoryChange["action"], string> = {
  added: "Memory added",
  edited: "Memory corrected",
  pinned: "Pinned",
  unpinned: "Unpinned",
  archived: "Archived",
  forgotten: "Forgotten",
  merged: "Merged",
  dream: "Consolidated by /dream",
};
const BY_LABEL = { user: "You", agent: "Agent", dream: "/dream" } as const;

function MemoryHistory({ persona }: { persona: PersonaSummary }) {
  const { state } = useStore();
  const rev = state.memoryRev[persona.id] ?? 0;
  const [by, setBy] = useState<"" | MemoryChange["by"]>("");
  const [open, setOpen] = useState<string | null>(null);
  const { data, error, missing, loading, reload } = useLoad(() => api.memoryHistory(persona.id), [persona.id, rev]);
  const rows = (data ?? []).filter((c) => !by || c.by === by);
  return (
    <div className="history">
      <div className="row gap">
        <h3 className="grow">History</h3>
        <label className="mini-select">
          <span className="sr-only">Show changes by</span>
          <select value={by} onChange={(e) => setBy(e.target.value as typeof by)}>
            <option value="">All changes</option>
            <option value="user">By you</option>
            <option value="agent">By the agent</option>
            <option value="dream">By /dream</option>
          </select>
        </label>
      </div>
      {loading && !data && (
        <div className="pane-state">
          <Spinner size={14} /> Loading history…
        </div>
      )}
      {error && !data && <Unavailable what="Memory history" error={error} missing={missing} onRetry={reload} />}
      {data && rows.length === 0 && <Empty title="No changes yet" />}
      <ol className="timeline">
        {rows.map((c) => {
          const isOpen = open === c.id;
          return (
            <li key={c.id} className={cls("tl-row", isOpen && "is-open")}>
              <button type="button" className="tl-head" aria-expanded={isOpen} onClick={() => setOpen(isOpen ? null : c.id)}>
                <span className="tl-dot" aria-hidden="true" />
                <span className="tl-time" title={fullTime(c.ts)}>
                  {clockTime(c.ts).slice(0, 5)}
                </span>
                <span className="tl-main">
                  <span className="tl-title">{ACTION_LABEL[c.action]}</span>
                  <span className="tl-sum">{c.summary}</span>
                </span>
                <IconChevronRight className="chev" size={16} />
              </button>
              {isOpen && (
                <dl className="facts tl-body">
                  {c.before !== undefined && (
                    <>
                      <dt>Before</dt>
                      <dd>{c.before}</dd>
                    </>
                  )}
                  {c.after !== undefined && (
                    <>
                      <dt>After</dt>
                      <dd>{c.after}</dd>
                    </>
                  )}
                  <dt>Changed by</dt>
                  <dd>{BY_LABEL[c.by]}</dd>
                  <dt>When</dt>
                  <dd>{fullTime(c.ts)}</dd>
                  <dt>Record</dt>
                  <dd className="mono small">{c.recordId}</dd>
                </dl>
              )}
            </li>
          );
        })}
      </ol>
    </div>
  );
}

// ---------- Usage ----------

function UsageView({ persona, ps, set }: { persona: PersonaSummary; ps: MemoryPaneState; set: (p: Partial<MemoryPaneState>) => void }) {
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
