// Every change to the persona's memory, newest first.
import { useState } from "react";
import type { MemoryChange, PersonaSummary } from "@ph/shared";
import { api } from "../../api";
import { useStore } from "../../store";
import { clockTime, cls, fullTime } from "../../util";
import { IconChevronRight } from "../icons";
import { Empty, Spinner } from "../ui";
import { useLoad } from "../../hooks";
import { Unavailable } from "./Unavailable";

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

export function MemoryHistory({ persona }: { persona: PersonaSummary }) {
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
