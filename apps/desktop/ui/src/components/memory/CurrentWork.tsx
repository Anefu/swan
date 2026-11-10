// The checkpoint of the work in hand, from the conversation's last new context.
import type { ReactNode } from "react";
import type { Checkpoint, PersonaSummary } from "@ph/shared";
import { api } from "../../api";
import { useStore } from "../../store";
import { clockTime, cls, fullTime } from "../../util";
import { Empty, Fold, Spinner } from "../ui";
import { useLoad } from "../../hooks";
import { SourceLinks } from "./SavedMemory";
import { Unavailable } from "./Unavailable";

export function CurrentWork({ persona }: { persona: PersonaSummary }) {
  const { state } = useStore();
  const rev = state.memoryRev[persona.id] ?? 0;
  // The conversation on screen: each conversation has its own checkpoint.
  const sessionId = state.conversations[persona.id];
  const { data, error, missing, loading, reload } = useLoad<Checkpoint | null>(() => api.checkpoint(persona.id, sessionId), [persona.id, sessionId, rev]);
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
        Swan saves a checkpoint of the task when this conversation's context rolls over: objective, constraints, progress and the next action.
      </Empty>
    );
  // Each part folds; what to act on starts open.
  const list = (title: string, items: string[], tone?: string, open = false) =>
    items.length > 0 && (
      <section className="cp-section">
        <Fold summary={`${title} · ${items.length}`} defaultOpen={open}>
          <ul className={cls("cp-list", tone)}>
            {items.map((x, i) => (
              <li key={i}>{x}</li>
            ))}
          </ul>
        </Fold>
      </section>
    );
  const text = (title: string, body: ReactNode, open: boolean) => (
    <section className="cp-section">
      <Fold summary={title} defaultOpen={open}>
        {body}
      </Fold>
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
      {text("Objective", <p>{data.objective || "Not recorded"}</p>, true)}
      {list("Constraints", data.constraints)}
      {list("Decisions", data.decisions)}
      {list("Completed", data.completed, "done")}
      {list("Failures", data.failures)}
      {list("Open questions", data.openQuestions, "attention", true)}
      {text("Next action", <p>{data.nextAction || "Not recorded"}</p>, true)}
      {text(`Sources · ${data.sources.length}`, <SourceLinks persona={persona} sources={data.sources} />, false)}
    </div>
  );
}
