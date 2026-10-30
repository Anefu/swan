import { Fragment, useEffect, useLayoutEffect, useMemo, useRef } from "react";
import type { EgressDecision, EgressEvent } from "@ph/shared";
import { useSelectedPersona, useStore } from "../store";
import { clockTime, cls, fmtBytes, fmtDuration, fullTime } from "../util";
import { DecisionsShortcut } from "./Composer";
import { IconArrowLeft, IconArrowRight, IconChevronRight, IconSearch } from "./icons";
import { CopyButton, Empty } from "./ui";

const DECISION: Record<EgressDecision, { label: string; explain: string }> = {
  injected: { label: "Injected", explain: "Inspected by the proxy, which added credentials on the way out." },
  inspected: { label: "Inspected", explain: "Inspected by the proxy; no credentials were added." },
  tunneled: { label: "Tunneled", explain: "Passed through without TLS interception. Only the host and size are known." },
  blocked: { label: "Blocked", explain: "Stopped by the proxy." },
};

const RANGE_LABEL = { hour: "Last hour", today: "Today", all: "Everything loaded" } as const;

export function NetworkView() {
  const { state, actions } = useStore();
  const persona = useSelectedPersona();
  const f = state.network;
  const scrollRef = useRef<HTMLDivElement>(null);
  const backRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    void actions.refreshEgress();
    backRef.current?.focus({ preventScroll: true });
  }, [actions]);

  const personaSessions = useMemo(() => {
    const s = new Set<string>();
    if (!persona) return s;
    for (const x of Object.values(state.sessions)) if (x.personaId === persona.id) s.add(x.id);
    return s;
  }, [state.sessions, persona]);

  const rows = useMemo(() => {
    const now = Date.now();
    const startOfDay = new Date();
    startOfDay.setHours(0, 0, 0, 0);
    const since = f.range === "hour" ? now - 3_600_000 : f.range === "today" ? startOfDay.getTime() : 0;
    const q = f.query.trim().toLowerCase();
    const out: EgressEvent[] = [];
    for (let i = state.egress.length - 1; i >= 0; i--) {
      const e = state.egress[i];
      if (persona && e.personaId !== persona.id && !(e.sessionId && personaSessions.has(e.sessionId))) continue;
      if (f.onlyBlocked && e.decision !== "blocked") continue;
      if (since && Date.parse(e.ts) < since) continue;
      if (q && !`${e.host}:${e.port}${e.path ?? ""}`.toLowerCase().includes(q)) continue;
      out.push(e);
    }
    return out;
  }, [state.egress, persona, personaSessions, f.range, f.query, f.onlyBlocked]);

  // Live rows arrive at the top: keep the reader's place unless they are at the top.
  const prevHeight = useRef(0);
  useLayoutEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    const delta = el.scrollHeight - prevHeight.current;
    if (prevHeight.current && el.scrollTop > 0 && delta > 0) el.scrollTop += delta;
    prevHeight.current = el.scrollHeight;
  }, [rows]);

  return (
    <div className="network" ref={scrollRef}>
      <div className="column wide">
        <button ref={backRef} type="button" className="back-link" onClick={() => actions.showView("conversation")}>
          <IconArrowLeft size={16} /> Conversation
        </button>
        <h1 className="convo-title">Network activity</h1>
        <p className="muted net-sub">
          {persona?.name ?? "All personas"} · {RANGE_LABEL[f.range]}
        </p>
        <DecisionsShortcut />
        <div className="net-filters">
          <label className="search-field grow">
            <IconSearch size={16} />
            <span className="sr-only">Filter by host or path</span>
            <input placeholder="Filter by host or path…" value={f.query} onChange={(e) => actions.setNetwork({ query: e.target.value })} />
          </label>
          <label className="mini-select tall">
            <span className="sr-only">Time range</span>
            <select value={f.range} onChange={(e) => actions.setNetwork({ range: e.target.value as typeof f.range })}>
              <option value="hour">Last hour</option>
              <option value="today">Today</option>
              <option value="all">Everything loaded</option>
            </select>
          </label>
          <label className="check-row">
            <input type="checkbox" checked={f.onlyBlocked} onChange={(e) => actions.setNetwork({ onlyBlocked: e.target.checked })} />
            <span>Only blocked</span>
          </label>
        </div>
        {rows.length === 0 ? (
          <Empty title={state.egress.length === 0 ? "No network activity yet" : "No requests match"}>
            Every request from the sandbox goes through the proxy and shows up here.
          </Empty>
        ) : (
          <div className="table-scroll">
            <table className="net-table">
              <caption className="sr-only">Requests from {persona?.name ?? "all personas"}, newest first</caption>
              <thead>
                <tr>
                  <th scope="col">Time</th>
                  <th scope="col">Method</th>
                  <th scope="col">Host and path</th>
                  <th scope="col">Status</th>
                  <th scope="col">Decision</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((e) => {
                  const open = f.expanded === e.id;
                  return (
                    <Fragment key={e.id}>
                      <tr
                        className={cls("net-row", open && "is-open", e.decision === "blocked" && "blocked")}
                        onClick={() => actions.setNetwork({ expanded: open ? null : e.id })}
                      >
                        <td className="mono" title={fullTime(e.ts)}>
                          {clockTime(e.ts)}
                        </td>
                        <td className="mono">{e.method}</td>
                        <td className="host-cell">
                          <button
                            type="button"
                            className="row-toggle mono"
                            aria-expanded={open}
                            onClick={(ev) => {
                              ev.stopPropagation();
                              actions.setNetwork({ expanded: open ? null : e.id });
                            }}
                          >
                            <IconChevronRight className="chev" size={14} />
                            {hostLabel(e)}
                          </button>
                        </td>
                        <td className="mono">{e.status ?? "—"}</td>
                        <td>
                          <span className={cls("decision", `d-${e.decision}`)}>
                            <span className="dot" aria-hidden="true" />
                            {DECISION[e.decision].label}
                          </span>
                        </td>
                      </tr>
                      {open && (
                        <tr className="net-detail">
                          <td colSpan={5}>
                            <EventDetail e={e} />
                          </td>
                        </tr>
                      )}
                    </Fragment>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
        <p className="small muted net-foot">Bodies, query strings and secret values are not logged.</p>
      </div>
    </div>
  );
}

function hostLabel(e: EgressEvent): string {
  const port = e.port === 443 || e.port === 80 ? "" : `:${e.port}`;
  if (e.path) return `${e.host}${port}${e.path}`;
  return `${e.host}:${e.port}`;
}

function EventDetail({ e }: { e: EgressEvent }) {
  const { actions } = useStore();
  const d = DECISION[e.decision];
  return (
    <div className="event-detail">
      <h3 className="mono">{hostLabel(e)}</h3>
      <p>
        <strong>{d.label}:</strong> {e.decision === "blocked" ? (e.reason ?? "no reason recorded") : d.explain}
      </p>
      <p>{e.credentials.length ? <>Credentials used: <span className="mono">{e.credentials.join(", ")}</span> (names only)</> : "No credentials were sent."}</p>
      <dl className="facts">
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
            <dd className="mono small">session {e.sessionId}</dd>
          </>
        )}
      </dl>
      <div className="row gap wrap">
        {e.decision === "blocked" && (
          <button type="button" className="btn accent-outline" onClick={() => actions.openSettings("persona")}>
            Open Settings <IconArrowRight size={14} />
          </button>
        )}
        <CopyButton text={JSON.stringify(e, null, 2)} label="Copy event" showLabel />
      </div>
      {e.decision === "blocked" && <p className="hint">Viewing a block never adds the host to the allowlist.</p>}
    </div>
  );
}
