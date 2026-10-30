import { useEffect, useMemo, useState } from "react";
import type { EgressEvent, SessionSummary } from "@ph/shared";
import { api } from "../api";
import { MAX_EGRESS, useStore } from "../store";
import { clockTime, cls, fmtBytes, fmtDuration, fullTime } from "../util";
import { IconKey } from "./icons";

function hostLabel(e: EgressEvent): string {
  return e.port && e.port !== 443 && e.port !== 80 ? `${e.host}:${e.port}` : e.host;
}

function statusClass(s: number | undefined): string {
  if (!s) return "";
  if (s < 300) return "st-2xx";
  if (s < 400) return "st-3xx";
  if (s < 500) return "st-4xx";
  return "st-5xx";
}

export function NetworkTab({ session }: { session: SessionSummary | null }) {
  const { state, actions } = useStore();
  const [blockedOnly, setBlockedOnly] = useState(false);
  const sessionOnly = state.ui.egressSessionOnly && !!session;

  // When filtering to one session, pull that session's recent history too.
  useEffect(() => {
    if (!sessionOnly || !session) return;
    let alive = true;
    api
      .egress({ sessionId: session.id, limit: 200 })
      .then((events) => alive && actions.mergeEgress(events))
      .catch(() => {});
    return () => {
      alive = false;
    };
  }, [sessionOnly, session?.id, actions]);

  const rows = useMemo(() => {
    const out: EgressEvent[] = [];
    for (let i = state.egress.length - 1; i >= 0; i--) {
      const e = state.egress[i];
      if (sessionOnly && e.sessionId !== session?.id) continue;
      if (blockedOnly && e.decision !== "blocked") continue;
      out.push(e);
    }
    return out;
  }, [state.egress, sessionOnly, session?.id, blockedOnly]);

  const blockedCount = useMemo(() => state.egress.filter((e) => e.decision === "blocked").length, [state.egress]);

  return (
    <div className="tab-pane network">
      <div className="panel-toolbar">
        <label className={cls("toggle", !session && "disabled")} title={session ? undefined : "Open a session to filter by it"}>
          <input
            type="checkbox"
            checked={sessionOnly}
            disabled={!session}
            onChange={(e) => actions.setUi({ egressSessionOnly: e.target.checked })}
          />
          This session only
        </label>
        <label className="toggle">
          <input type="checkbox" checked={blockedOnly} onChange={(e) => setBlockedOnly(e.target.checked)} />
          Blocked only{blockedCount > 0 && <span className="badge error">{blockedCount}</span>}
        </label>
        <span className="spacer" />
        <span className="muted small">
          {rows.length}
          {rows.length !== state.egress.length && ` / ${state.egress.length}`}
          {state.egress.length >= MAX_EGRESS && " (latest)"}
        </span>
        <button type="button" className="btn ghost sm" onClick={actions.clearEgress} disabled={state.egress.length === 0}>
          Clear
        </button>
      </div>
      <div className="egress-wrap">
        {rows.length === 0 ? (
          <p className="muted small egress-empty">
            {state.egress.length === 0
              ? "No outbound requests yet. Everything the sandbox sends goes through the egress proxy and shows up here."
              : "No requests match the filters."}
          </p>
        ) : (
          <table className="egress">
            <thead>
              <tr>
                <th>Time</th>
                <th>Method</th>
                <th>Host</th>
                <th>Path</th>
                <th>Status</th>
                <th>Decision</th>
                <th>Credentials</th>
                <th>Reason</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((e) => (
                <tr
                  key={e.id}
                  className={cls(e.decision === "blocked" && "blocked", e.decision === "injected" && "injected")}
                  title={[
                    fullTime(e.ts),
                    e.durationMs !== undefined ? `duration ${fmtDuration(e.durationMs)}` : "",
                    e.bytesUp !== undefined ? `up ${fmtBytes(e.bytesUp)}` : "",
                    e.bytesDown !== undefined ? `down ${fmtBytes(e.bytesDown)}` : "",
                    e.sessionId ? `session ${e.sessionId}` : "",
                    e.personaId ? `persona ${e.personaId}` : "",
                  ]
                    .filter(Boolean)
                    .join("\n")}
                >
                  <td className="mono muted">{clockTime(e.ts)}</td>
                  <td className="mono">{e.method}</td>
                  <td className="mono host">{hostLabel(e)}</td>
                  <td className="mono path">{e.path ?? <span className="faint">—</span>}</td>
                  <td className={cls("mono", statusClass(e.status))}>{e.status ?? <span className="faint">—</span>}</td>
                  <td>
                    <span className={cls("chip", `dec-${e.decision}`)}>{e.decision}</span>
                  </td>
                  <td>
                    {e.credentials.length > 0 ? (
                      <span className="egress-creds" title={`Injected by the proxy: ${e.credentials.join(", ")}`}>
                        <IconKey size={11} />
                        <span className="mono">{e.credentials.join(", ")}</span>
                      </span>
                    ) : (
                      <span className="faint">—</span>
                    )}
                  </td>
                  <td className="reason">{e.reason ?? ""}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </div>
  );
}
