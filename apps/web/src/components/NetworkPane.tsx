import { useEffect, useLayoutEffect, useMemo, useRef } from "react";
import type { EgressDecision, EgressEvent } from "@ph/shared";
import { useSelectedPersona, useStore } from "../store";
import { clockTime, cls, fmtBytes, fmtDuration, fullTime } from "../util";
import { DecisionsShortcut } from "./Composer";
import { IconArrowRight, IconChevronRight, IconSearch, IconX } from "./icons";
import { CopyButton, Empty } from "./ui";

const DECISION: Record<EgressDecision, { label: string; explain: string }> = {
  injected: { label: "Injected", explain: "Inspected by the proxy, which added credentials on the way out." },
  inspected: { label: "Inspected", explain: "Inspected by the proxy; no credentials were added." },
  tunneled: { label: "Tunneled", explain: "Passed through without TLS interception. Only the host and size are known." },
  blocked: { label: "Blocked", explain: "Stopped by the proxy." },
};

function hostLabel(e: EgressEvent): string {
  const port = e.port === 443 || e.port === 80 ? "" : `:${e.port}`;
  if (e.path) return `${e.host}${port}${e.path}`;
  return `${e.host}:${e.port}`;
}

/** Network activity for the selected persona, as a right-dock pane. */
export function NetworkPane({ onClose }: { onClose: () => void }) {
  const { state, actions } = useStore();
  const persona = useSelectedPersona();
  const f = state.network;
  const listRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    void actions.refreshEgress();
  }, [actions]);

  const personaSessions = useMemo(() => {
    const s = new Set<string>();
    if (!persona) return s;
    for (const x of Object.values(state.sessions)) if (x.personaId === persona.id) s.add(x.id);
    return s;
  }, [state.sessions, persona]);

  const rows = useMemo(() => {
    const q = f.query.trim().toLowerCase();
    const out: EgressEvent[] = [];
    for (let i = state.egress.length - 1; i >= 0; i--) {
      const e = state.egress[i];
      if (persona && e.personaId !== persona.id && !(e.sessionId && personaSessions.has(e.sessionId))) continue;
      if (f.onlyBlocked && e.decision !== "blocked") continue;
      if (q && !`${e.host}:${e.port}${e.path ?? ""}`.toLowerCase().includes(q)) continue;
      out.push(e);
    }
    return out;
  }, [state.egress, persona, personaSessions, f.query, f.onlyBlocked]);

  // New rows arrive at the top: keep the reader's place unless they are at the top.
  const prevHeight = useRef(0);
  useLayoutEffect(() => {
    const el = listRef.current;
    if (!el) return;
    const delta = el.scrollHeight - prevHeight.current;
    if (prevHeight.current && el.scrollTop > 0 && delta > 0) el.scrollTop += delta;
    prevHeight.current = el.scrollHeight;
  }, [rows]);

  return (
    <div className="pane">
      <div className="pane-head">
        <h2>Network activity</h2>
        <DecisionsShortcut className="compact" />
        <button type="button" className="icon-btn" aria-label="Close network activity" onClick={onClose}>
          <IconX size={18} />
        </button>
      </div>
      <div className="pane-tabs net-filters">
        <label className="search-field">
          <IconSearch size={16} />
          <span className="sr-only">Filter by host or path</span>
          <input placeholder="Filter by host or path…" value={f.query} onChange={(e) => actions.setNetwork({ query: e.target.value })} />
        </label>
        <div className="row gap">
          <label className="check-row grow">
            <input type="checkbox" checked={f.onlyBlocked} onChange={(e) => actions.setNetwork({ onlyBlocked: e.target.checked })} />
            <span>Only blocked</span>
          </label>
          <span className="small muted">{persona?.name ?? "All personas"}</span>
        </div>
      </div>
      <div className="pane-body flush" ref={listRef}>
        {rows.length === 0 ? (
          <Empty title={state.egress.length === 0 ? "No network activity yet" : "No requests match"}>
            Every request from the sandbox goes through the proxy and shows up here.
          </Empty>
        ) : (
          <ul className="net-list" aria-label={`Requests from ${persona?.name ?? "all personas"}, newest first`}>
            {rows.map((e) => {
              const open = f.expanded === e.id;
              return (
                <li key={e.id} className={cls("net-item", open && "is-open")}>
                  <button
                    type="button"
                    className="net-line"
                    aria-expanded={open}
                    onClick={() => actions.setNetwork({ expanded: open ? null : e.id })}
                  >
                    <span className="net-time mono" title={fullTime(e.ts)}>
                      {clockTime(e.ts)}
                    </span>
                    <span className="net-main">
                      <span className="net-host mono">
                        <span className="muted">{e.method}</span> {hostLabel(e)}
                      </span>
                    </span>
                    <span className="net-status mono">{e.status ?? "—"}</span>
                    <span className={cls("net-decision", e.decision === "blocked" ? "tone-error" : e.decision === "injected" ? "tone-accent" : "tone-muted")}>
                      {DECISION[e.decision].label}
                    </span>
                    <IconChevronRight className="chev" size={14} />
                  </button>
                  {open && <EventDetail e={e} />}
                </li>
              );
            })}
          </ul>
        )}
      </div>
      <div className="pane-foot quiet small">Bodies, query strings and secret values are not logged.</div>
    </div>
  );
}

function EventDetail({ e }: { e: EgressEvent }) {
  const { actions } = useStore();
  const d = DECISION[e.decision];
  return (
    <div className="net-detail">
      <p>
        <strong>{d.label}.</strong> {e.decision === "blocked" ? (e.reason ?? "No reason recorded.") : d.explain}
      </p>
      <p>
        {e.credentials.length ? (
          <>
            Credentials used: <span className="mono">{e.credentials.join(", ")}</span> (names only)
          </>
        ) : (
          "No credentials were sent."
        )}
      </p>
      <dl className="facts small">
        <dt>Time</dt>
        <dd>{fullTime(e.ts)}</dd>
        {e.durationMs !== undefined && (
          <>
            <dt>Duration</dt>
            <dd>{fmtDuration(e.durationMs)}</dd>
          </>
        )}
        {(e.bytesUp !== undefined || e.bytesDown !== undefined) && (
          <>
            <dt>Bytes</dt>
            <dd>
              {fmtBytes(e.bytesUp ?? 0)} up · {fmtBytes(e.bytesDown ?? 0)} down
            </dd>
          </>
        )}
        {e.sessionId && (
          <>
            <dt>Source</dt>
            <dd className="mono">session {e.sessionId}</dd>
          </>
        )}
      </dl>
      <div className="row gap wrap">
        <button type="button" className="link-btn" onClick={() => actions.openSettings("persona")}>
          Allowed hosts in Settings <IconArrowRight size={13} />
        </button>
        <CopyButton text={JSON.stringify(e, null, 2)} label="Copy event" showLabel />
      </div>
    </div>
  );
}
