// The persona's saved memories: search, add, edit, pin, archive and forget.
import { useEffect, useState } from "react";
import type { MemoryRecord, MemoryType, PersonaSummary } from "@ph/shared";
import { api } from "../../api";
import { useStore, type MemoryPaneState } from "../../store";
import { cls, errorMessage, fullTime, relTime } from "../../util";
import { IconChevronRight, IconExternal, IconPin, IconPlus, IconSearch } from "../icons";
import { Confirm, Empty, Spinner } from "../ui";
import { useLoad } from "../../hooks";
import { Unavailable } from "./Unavailable";

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

export function SavedMemory({ persona, ps, set }: { persona: PersonaSummary; ps: MemoryPaneState; set: (p: Partial<MemoryPaneState>) => void }) {
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
        <button type="submit" className="btn primary sm" disabled={busy || !content.trim()}>
          {busy && <Spinner size={10} />}
          {submitLabel}
        </button>
        <button type="button" className="btn sm" onClick={onCancel} disabled={busy}>
          Cancel
        </button>
      </div>
    </form>
  );
}

export function SourceLinks({ persona, sources }: { persona: PersonaSummary; sources: string[] }) {
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
            <Confirm label="Forget this memory" action="Forget" onConfirm={() => act("forget")} onCancel={() => setMode(null)}>
              Forgetting removes this memory from search and from future briefs at the next safe point. It does not erase the original
              conversation.
            </Confirm>
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
