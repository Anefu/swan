import { useState } from "react";
import type { TrackerItem, TrackStatus, WatcherTestResult } from "@ph/shared";
import { api } from "../api";
import { useSelectedPersona, useStore } from "../store";
import { errorMessage, relTime, useNow } from "../util";
import { PaneHead } from "./Cards";
import { IconPlus, IconWarning } from "./icons";
import { useLoad } from "./MemoryUsagePane";
import { Empty, Fold, Spinner } from "./ui";

const GROUPS: { status: TrackStatus; label: string }[] = [
  { status: "in_progress", label: "In progress" },
  { status: "waiting", label: "Waiting" },
  { status: "done", label: "Done" },
  { status: "dropped", label: "Dropped" },
];

/** The persona's tracked work: what the agent registered, by status. */
export function TrackerPane({ onBack }: { onBack: () => void }) {
  const persona = useSelectedPersona();
  const { state, actions } = useStore();
  const id = persona?.id ?? "";
  const rev = state.trackerRev[id] ?? 0;
  const { data, error } = useLoad(() => api.tracker(id), [id, rev]);
  const [adding, setAdding] = useState(false);
  // Open work shows by default; done and dropped fold away. Every group can be folded.
  const [shown, setShown] = useState<Record<string, boolean>>({ in_progress: true, waiting: true });
  const now = useNow();

  const act = (p: Promise<unknown>) => p.catch((e) => actions.reportError(e, "Could not change the tracker"));
  const items = data ?? [];

  return (
    <div className="pane">
      <PaneHead title="Tracker" sub={persona?.name} onBack={onBack} backLabel="Back to overview">
        {!adding && (
          <button type="button" className="link-btn" onClick={() => setAdding(true)}>
            <IconPlus /> Add
          </button>
        )}
      </PaneHead>
      <div className="pane-body">
        {adding && <AddItem personaId={id} onDone={() => setAdding(false)} />}
        {error && <p className="foot-error">{error}</p>}
        {!data && !error && <Spinner />}
        {data && items.length === 0 && !adding && (
          <Empty title="Nothing tracked yet">
            <p className="small muted">The agent adds the merge requests, tickets and docs it creates or follows. You can add one too.</p>
          </Empty>
        )}
        {GROUPS.map((g) => {
          const list = items.filter((i) => i.status === g.status);
          if (!list.length) return null;
          const open = !!shown[g.status];
          return (
            <section key={g.status} className="swan-section">
              <div className="row">
                <h3 className="grow">
                  {g.label} <span className="muted">{list.length}</span>
                </h3>
                <button type="button" className="link-btn" aria-expanded={open} aria-label={`${open ? "Hide" : "Show"} ${g.label.toLowerCase()} items`} onClick={() => setShown((s) => ({ ...s, [g.status]: !s[g.status] }))}>
                  {open ? "Hide" : "Show"}
                </button>
              </div>
              {open && (
                <ul className="plain-list">
                  {list.map((it) => (
                    <Item key={it.url} it={it} now={now} onStatus={(s) => act(api.track(id, { url: it.url, status: s }))} onRemove={() => act(api.untrack(id, it.url))} />
                  ))}
                </ul>
              )}
            </section>
          );
        })}
      </div>
    </div>
  );
}

function Item({ it, now, onStatus, onRemove }: { it: TrackerItem; now: number; onStatus: (s: TrackStatus) => void; onRemove: () => void }) {
  return (
    <li>
      <div className="row gap">
        <span className="small muted mono">{it.kind}</span>
        <a className="grow" href={it.url} target="_blank" rel="noreferrer">
          {it.title}
        </a>
        <span className="small muted">{relTime(it.updated, now)}</span>
      </div>
      {it.note && <p className="small muted">{it.note}</p>}
      <div className="row gap">
        <label className="mini-select">
          <span className="sr-only">Status of {it.title}</span>
          <select value={it.status} onChange={(e) => onStatus(e.target.value as TrackStatus)}>
            {GROUPS.map((g) => (
              <option key={g.status} value={g.status}>
                {g.label}
              </option>
            ))}
          </select>
        </label>
        {it.itemId && (
          <button type="button" className="link-btn" onClick={() => document.getElementById(`item-${it.itemId}`)?.scrollIntoView({ block: "center" })}>
            Show in conversation
          </button>
        )}
        <span className="grow" />
        <button type="button" className="link-btn" onClick={onRemove} aria-label={`Remove ${it.title} from the tracker`}>
          Remove
        </button>
      </div>
    </li>
  );
}

function AddItem({ personaId, onDone }: { personaId: string; onDone: () => void }) {
  const [url, setUrl] = useState("");
  const [title, setTitle] = useState("");
  const [kind, setKind] = useState("");
  const [error, setError] = useState<string | null>(null);
  const save = async () => {
    try {
      await api.track(personaId, { url: url.trim(), title: title.trim() || undefined, kind: kind.trim() || undefined });
      onDone();
    } catch (e) {
      setError(errorMessage(e));
    }
  };
  return (
    <form
      className="inline-form"
      onSubmit={(e) => {
        e.preventDefault();
        void save();
      }}
    >
      <input className="input" aria-label="URL" placeholder="https://gitlab.example.com/team/app/-/merge_requests/12" value={url} onChange={(e) => setUrl(e.target.value)} autoFocus />
      <input className="input" aria-label="Title" placeholder="Title" value={title} onChange={(e) => setTitle(e.target.value)} />
      <input className="input" aria-label="Kind" placeholder="mr, ticket, doc…" value={kind} onChange={(e) => setKind(e.target.value)} />
      {error && <span className="field-error">{error}</span>}
      <div className="row gap end">
        <button type="submit" className="btn sm primary">
          Add
        </button>
        <button type="button" className="btn sm" onClick={onDone}>
          Cancel
        </button>
      </div>
    </form>
  );
}

/** The persona's schedules and watchers: when they run, what went wrong, and a way to pause them. */
export function TriggersPane({ onBack }: { onBack: () => void }) {
  const persona = useSelectedPersona();
  const { state, actions } = useStore();
  const id = persona?.id ?? "";
  const rev = state.triggersRev[id] ?? 0;
  const { data, error, setData } = useLoad(() => api.triggers(id), [id, rev]);
  const [busy, setBusy] = useState<string | null>(null);
  const [test, setTest] = useState<{ name: string; r?: WatcherTestResult; error?: string } | null>(null);
  const now = useNow();

  const run = async (name: string) => {
    setBusy(name);
    try {
      setData(await api.runTrigger(id, name));
    } catch (e) {
      actions.reportError(e, `Could not run ${name}`);
    } finally {
      setBusy(null);
    }
  };
  const doTest = async (name: string) => {
    setBusy(name);
    setTest({ name });
    try {
      setTest({ name, r: await api.testWatcher(id, name) });
    } catch (e) {
      setTest({ name, error: errorMessage(e) });
    } finally {
      setBusy(null);
    }
  };

  return (
    <div className="pane">
      <PaneHead title="Triggers" sub={persona?.name} onBack={onBack} backLabel="Back to overview" />
      <div className="pane-body">
        {error && <p className="foot-error">{error}</p>}
        {!data && !error && <Spinner />}
        {data && data.triggers.length === 0 && (
          <Empty title="No schedules or watchers">
            <p className="small muted">Add schedules and watchers to the persona's YAML. See “Schedules and watchers” in the README.</p>
          </Empty>
        )}
        {data && data.triggers.length > 0 && (
          <>
            <label className="check-row">
              <input type="checkbox" checked={!data.paused} onChange={(e) => void api.pauseTriggers(id, !e.target.checked).then(setData)} />
              <span>Run schedules and watchers</span>
            </label>
            <p className="hint">
              {data.turnsToday} of {data.maxTurnsPerDay} triggered turns used today. Triggered turns run unattended: anything that would ask you is refused.
            </p>
            <ul className="plain-list">
              {data.triggers.map((t) => (
                <li key={t.name} className="conn-card">
                  <div className="row gap">
                    <span className="grow">
                      <span className="mono strong">{t.name}</span> <span className="muted small">· {t.summary}</span>
                    </span>
                    {t.lastError ? (
                      <span className="small tone-attention">
                        <IconWarning size={12} /> {t.failures > 0 ? "failing" : "note"}
                      </span>
                    ) : (
                      t.nextRun && !data.paused && <span className="small muted">next {new Date(t.nextRun).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}</span>
                    )}
                  </div>
                  <Fold summary="Details" defaultOpen={test?.name === t.name}>
                  <div className="row gap">
                    <span className="grow small muted">
                      {t.type}
                      {t.lastRun && ` · last ${relTime(t.lastRun, now)}`}
                      {t.firedToday > 0 && ` · ${t.firedToday} today`}
                    </span>
                    {t.type === "watcher" && (
                      <button type="button" className="link-btn" disabled={busy === t.name} onClick={() => void doTest(t.name)}>
                        Test
                      </button>
                    )}
                    <button type="button" className="link-btn" disabled={busy === t.name} onClick={() => void run(t.name)}>
                      {t.type === "watcher" ? "Check now" : "Run now"}
                    </button>
                  </div>
                  {t.lastError && (
                    <p className="small tone-attention">
                      <IconWarning size={12} /> {t.lastError}
                    </p>
                  )}
                  {test?.name === t.name && (
                    <div className="inline-form" role="status">
                      {!test.r && !test.error && <Spinner />}
                      {test.error && <p className="small tone-attention">{test.error}</p>}
                      {test.r && (
                        <>
                          <p className="small">
                            {test.r.checked} {test.r.checked === 1 ? "request" : "requests"}, {test.r.items} items. A real check would send{" "}
                            {test.r.matching.length ? "these, if they were new:" : "nothing."}
                          </p>
                          {test.r.matching.map((m) => (
                            <p key={m.label} className="small muted mono">
                              {m.text}
                            </p>
                          ))}
                          {test.r.errors.map((e) => (
                            <p key={e} className="small tone-attention">
                              {e}
                            </p>
                          ))}
                          <p className="hint">The first real check only records what's there.</p>
                        </>
                      )}
                    </div>
                  )}
                  </Fold>
                </li>
              ))}
            </ul>
          </>
        )}
      </div>
    </div>
  );
}
