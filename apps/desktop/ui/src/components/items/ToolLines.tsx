// A tool call's line and its details, groups of calls, and a sub-agent's line, which holds its own calls.
import { createContext, memo, useContext, useState } from "react";
import type { AgentRun, PersonaSummary } from "@ph/shared";
import { AGENT_CONTROL_TOOLS, agentLive, agentState, describeTool, str, summarizeTools, TOOL_STATUS_TEXT, type ToolItem } from "../../receipts";
import { modelLabel, useStore } from "../../store";
import { cls, EFFORT_LABEL, exitCode, fmtDuration, isRecord, useNow } from "../../util";
import { IconChevronRight } from "../icons";
import { Markdown } from "../Markdown";
import { CopyButton, Spinner } from "../ui";
import { Section, ToolInput } from "./ToolInput";
import { QuestionPrompt, ApprovalPrompt, NetworkPrompt, CredentialPrompt } from "./Prompts";

/** Sub-agent id -> its `agent` call's description, for lines that name an agent by id. */
export const AgentNames = createContext<ReadonlyMap<string, string>>(new Map());

function ToolGlyph({ item }: { item: ToolItem }) {
  switch (item.status) {
    case "running":
      return <Spinner size={11} />;
    case "pending_approval":
      return <span className="glyph tone-attention" aria-hidden="true">●</span>;
    case "error":
      return <span className="glyph tone-error" aria-hidden="true">✕</span>;
    case "denied":
      return <span className="glyph tone-error" aria-hidden="true">⊘</span>;
    case "interrupted":
      return <span className="glyph tone-muted" aria-hidden="true">◌</span>;
    default:
      return <span className={cls("glyph", item.isError ? "tone-error" : "tone-ok")} aria-hidden="true">●</span>;
  }
}

/** One quiet line per tool call; expanding shows input and output under a thin rule. */
export const ToolLine = memo(function ToolLine({
  item,
  sessionId,
  persona,
  promptOpen,
}: {
  item: ToolItem;
  sessionId: string;
  persona: PersonaSummary | null;
  /** The oldest waiting call shows its decision prompt without being expanded. */
  promptOpen: boolean;
}) {
  const [open, setOpen] = useState(false);
  const d = describeTool(item, useContext(AgentNames));
  const pending = item.status === "pending_approval";
  const isQuestion = item.name === "ask_user";
  const status = isQuestion && pending ? "Waiting for you" : TOOL_STATUS_TEXT[item.status];
  const isNet = item.name === "network_access";
  const isCred = item.name === "credential_use";
  // Network and credential asks are decisions, not commands: their output is a one-line outcome.
  const isAsk = isNet || isCred || isQuestion;
  const meta: string[] = [];
  if (isAsk && !isQuestion && item.output && !pending) meta.push(item.output);
  if (d.result) meta.push(d.result);
  if (item.durationMs !== undefined && !isAsk && !AGENT_CONTROL_TOOLS.has(item.name)) meta.push(fmtDuration(item.durationMs));
  const showPrompt = pending && (promptOpen || open);
  return (
    <div className={cls("line-item", pending && "is-pending")} id={`item-${item.id}`}>
      <button type="button" className="line" aria-expanded={open} onClick={() => setOpen(!open)}>
        <ToolGlyph item={item} />
        <span className="line-verb">{d.verb}</span>
        {d.target && !(isQuestion && showPrompt) && <span className={cls("line-target", !d.prose && "mono")}>{d.target}</span>}
        {meta.length > 0 && <span className="line-meta">· {meta.join(" · ")}</span>}
        {status && item.status !== "running" && (
          <span className={cls("line-status", pending ? "tone-attention" : item.status === "interrupted" ? "tone-muted" : "tone-error")}>
            {status}
          </span>
        )}
        <IconChevronRight className="chev" size={14} />
      </button>
      {open && !isAsk && (
        <div className="line-detail">
          <ToolInput item={item} />
          {item.output !== undefined && (
            <Section label={item.isError ? "Error output" : "Output"} copy={item.output}>
              <pre className={cls("code-plain", item.isError && "tone-error")}>{item.output || "(empty)"}</pre>
            </Section>
          )}
          <Facts item={item} />
        </div>
      )}
      {open && isAsk && !pending && (
        <div className="line-detail">
          {isQuestion ? <p className="small">{item.output}</p> : <Facts item={item} />}
        </div>
      )}
      {showPrompt &&
        (isQuestion ? (
          <QuestionPrompt item={item} sessionId={sessionId} />
        ) : isNet ? (
          <NetworkPrompt item={item} sessionId={sessionId} />
        ) : isCred ? (
          <CredentialPrompt item={item} sessionId={sessionId} />
        ) : (
          <ApprovalPrompt item={item} sessionId={sessionId} persona={persona} showInput={!open} />
        ))}
    </div>
  );
});

function Facts({ item }: { item: ToolItem }) {
  const code = item.name === "bash" ? exitCode(item.output) : null;
  return (
    <dl className="facts small">
      <dt>Tool</dt>
      <dd className="mono">{item.name}</dd>
      {item.durationMs !== undefined && (
        <>
          <dt>Duration</dt>
          <dd>{fmtDuration(item.durationMs)}</dd>
        </>
      )}
      {code !== null && (
        <>
          <dt>Exit status</dt>
          <dd>{code}</dd>
        </>
      )}
      {item.approvalReason && (
        <>
          <dt>Matched rule</dt>
          <dd className="mono">{item.approvalReason}</dd>
        </>
      )}
      {item.denyReason && (
        <>
          <dt>Deny reason</dt>
          <dd>{item.denyReason}</dd>
        </>
      )}
      {(item.name === "network_access" || item.name === "credential_use") && item.output && (
        <>
          <dt>Outcome</dt>
          <dd>{item.output}</dd>
        </>
      )}
    </dl>
  );
}

/** Consecutive finished tool calls fold into one summary line. */
export function ToolGroup({
  items,
  sessionId,
  persona,
  childrenOf,
}: {
  items: ToolItem[];
  sessionId: string;
  persona: PersonaSummary | null;
  childrenOf: Map<string, ToolItem[]>;
}) {
  const [open, setOpen] = useState(false);
  const failed = items.filter((i) => i.status === "error" || i.isError || i.status === "denied").length;
  const ms = items.reduce((a, i) => a + (i.durationMs ?? 0), 0);
  // ms sums sequential and parallel calls alike; it is busy time, not wall time.
  return (
    <div className="line-item group" id={`item-${items[0].id}`}>
      <button type="button" className="line" aria-expanded={open} onClick={() => setOpen(!open)}>
        <span className={cls("glyph", failed ? "tone-error" : "tone-ok")} aria-hidden="true">
          ●
        </span>
        <span className="line-verb">{summarizeTools(items)}</span>
        <span className="line-meta">
          {failed > 0 && `· ${failed} failed `}
          {ms > 0 && `· ${fmtDuration(ms)}`}
        </span>
        <IconChevronRight className="chev" size={14} />
      </button>
      {open && (
        <div className="group-body">
          {items.map((it) =>
            it.name === "agent" ? (
              <AgentLine key={it.id} item={it} sessionId={sessionId} persona={persona} subItems={childrenOf.get(it.id) ?? []} oldestPendingId={null} />
            ) : (
              <ToolLine key={it.id} item={it} sessionId={sessionId} persona={persona} promptOpen={false} />
            ),
          )}
        </div>
      )}
    </div>
  );
}

/** The parent-facing reply to a background start or a question; not a report. */
function isHandoff(output: string): boolean {
  return /^\s*\{\s*"status"\s*:\s*"(running|question)"/.test(output);
}

function agentGlyph(item: ToolItem, state: AgentRun["state"] | null, live: boolean, attention: boolean): ToolItem["status"] {
  if (attention || item.status === "pending_approval") return "pending_approval";
  if (live) return "running";
  if (state === "stopped") return "interrupted";
  if (state === "error") return "error";
  return item.status === "running" ? "done" : item.status;
}

function agentStatus(item: ToolItem, state: AgentRun["state"] | null, live: boolean): { text: string; tone: string } | null {
  if (state === "asking") return { text: "Asked a question", tone: "tone-attention" };
  if (live) return null;
  if (state === "stopped") return { text: item.status === "interrupted" ? "Interrupted" : "Stopped", tone: "tone-muted" };
  if (state === "error" || item.status === "error") return { text: "Failed", tone: "tone-error" };
  const t = item.status === "running" ? null : TOOL_STATUS_TEXT[item.status];
  return t ? { text: t, tone: item.status === "interrupted" ? "tone-muted" : "tone-error" } : null;
}

/** An `agent` call: one line; its own tool calls and its report show indented when expanded. */
export function AgentLine({
  item,
  sessionId,
  persona,
  subItems,
  oldestPendingId,
}: {
  item: ToolItem;
  sessionId: string;
  persona: PersonaSummary | null;
  subItems: ToolItem[];
  oldestPendingId: string | null;
}) {
  const { state, actions } = useStore();
  const [open, setOpen] = useState(false);
  const [stopping, setStopping] = useState(false);
  const now = useNow(1000);
  const d = describeTool(item);
  const run = item.agent;
  const st = agentState(item);
  const live = agentLive(item);
  const asking = st === "asking";
  const pendingChild = subItems.some((c) => c.status === "pending_approval");
  const expanded = open || pendingChild;
  const started = Date.parse(run?.startedAt ?? item.ts);
  const ms = run?.endedAt
    ? Date.parse(run.endedAt) - started
    : (item.durationMs ?? (live || item.status === "pending_approval" ? Math.max(0, now - started) : undefined));
  const uses = subItems.filter((c) => c.name !== "ask_parent").length;
  const meta: string[] = [];
  if (run?.background) meta.push("background");
  if (run && run.name !== "auto") meta.push(run.name);
  if (run) meta.push(modelLabel(state, run.model));
  if (run?.context === "fork") meta.push("forked");
  meta.push(`${uses} tool ${uses === 1 ? "use" : "uses"}`);
  // A paused agent's clock says nothing useful; the status says it is waiting.
  if (!asking && ms !== undefined && Number.isFinite(ms) && ms >= 0) meta.push(fmtDuration(ms));
  const status =
    pendingChild || item.status === "pending_approval" ? { text: "Decision needed", tone: "tone-attention" } : agentStatus(item, st, live);
  const lastChild = subItems[subItems.length - 1];
  const lastAsk = [...subItems].reverse().find((c) => c.name === "ask_parent");
  const peek = asking
    ? `Asked: ${run?.question ?? (lastAsk ? describeTool(lastAsk).target : "")}`
    : lastChild
      ? `${describeTool(lastChild).verb} ${describeTool(lastChild).target}`
      : null;
  const report = !live && item.output !== undefined && !isHandoff(item.output) ? item.output : undefined;
  const canStop = !!run?.background && live;

  const line = (
    <button type="button" className={cls("line", canStop && "grow")} aria-expanded={expanded} onClick={() => setOpen(!open)}>
      <ToolGlyph item={{ ...item, status: agentGlyph(item, st, live, pendingChild || asking) }} />
      <span className="line-verb">Agent</span>
      <span className="line-target">{d.target}</span>
      <span className="line-meta">· {meta.join(" · ")}</span>
      {status && <span className={cls("line-status", status.tone)}>{status.text}</span>}
      <IconChevronRight className="chev" size={14} />
    </button>
  );
  return (
    <div className={cls("line-item agent", pendingChild && "is-pending")} id={`item-${item.id}`}>
      {canStop && run ? (
        <div className="row gap">
          {line}
          <button
            type="button"
            className="link-btn line-action"
            aria-label={`Stop the agent ${d.target}`}
            disabled={stopping}
            onClick={async () => {
              setStopping(true);
              await actions.stopAgent(sessionId, run.id);
              setStopping(false);
            }}
          >
            {stopping ? "Stopping…" : "Stop"}
          </button>
        </div>
      ) : (
        line
      )}
      {!expanded && live && peek && <div className="agent-peek line-meta">⎿ {peek}</div>}
      {expanded && (
        <div className="group-body agent-body">
          {run && <AgentFacts item={item} run={run} persona={persona} />}
          {subItems.length === 0 && live && <p className="line-meta">No tool calls yet.</p>}
          {subItems.map((c) =>
            c.name === "ask_parent" ? (
              <AskParentLines key={c.id} item={c} />
            ) : (
              <ToolLine key={c.id} item={c} sessionId={sessionId} persona={persona} promptOpen={c.id === oldestPendingId} />
            ),
          )}
          {report !== undefined && open && (
            <div className="agent-report">
              <div className="section-label">
                <span>Report</span>
                <CopyButton text={report} label="Copy report" />
              </div>
              <div className="msg-model">
                <Markdown text={report || "(empty)"} />
              </div>
            </div>
          )}
        </div>
      )}
      {item.status === "pending_approval" && (
        <ApprovalPrompt item={item} sessionId={sessionId} persona={persona} showInput={!open} />
      )}
    </div>
  );
}

function AgentFacts({ item, run, persona }: { item: ToolItem; run: AgentRun; persona: PersonaSummary | null }) {
  const { state } = useStore();
  // AgentRun does not say whether the parent chose the model. It did for "auto", for a sub-agent
  // configured as auto (known once Settings has loaded the persona), and when it passed a model.
  const configured = persona ? state.drafts[persona.id]?.base.subagents?.agents.find((a) => a.name === run.name) : undefined;
  // Older transcripts have no `auto`: fall back to what the call and the persona say.
  const byParent =
    run.auto ??
    (run.name === "auto" || configured?.model === "auto" || (isRecord(item.input) && (typeof item.input.model === "string" || typeof item.input.effort === "string")));
  const model = [modelLabel(state, run.model), run.model.effort && `${EFFORT_LABEL[run.model.effort].toLowerCase()} effort`].filter(Boolean).join(" · ");
  return (
    <dl className="facts small agent-facts">
      <dt>Sub-agent</dt>
      <dd>{run.name === "auto" ? "Auto" : byParent ? `${run.name} (Auto)` : run.name}</dd>
      <dt>Model</dt>
      <dd>
        {model}
        {byParent && ", chosen by the parent"}
      </dd>
      <dt>Context</dt>
      <dd>{run.context === "fork" ? "Forked from this conversation" : "Brief only"}</dd>
      <dt>Turns</dt>
      <dd>
        {run.turns} of {run.maxTurns}
      </dd>
      <dt>Brief</dt>
      <dd className="agent-brief">{run.brief}</dd>
    </dl>
  );
}

/** A sub-agent's `ask_parent` call: the question, then the answer once the parent replies. */
function AskParentLines({ item }: { item: ToolItem }) {
  const question = str(item.input, ["question"]) ?? item.inputPreview;
  const answered = item.status === "done" && !item.isError && item.output !== undefined;
  return (
    <>
      <div className="line-item" id={`item-${item.id}`}>
        <div className="line static">
          <span className="glyph tone-attention" aria-hidden="true">
            ?
          </span>
          <span className="line-verb">Asked the parent</span>
          <span className="line-target plain">{question}</span>
          {!answered && item.status !== "running" && <span className="line-status tone-muted">Not answered</span>}
        </div>
      </div>
      {answered && (
        <div className="line-item">
          <div className="line static">
            <span className="glyph tone-muted" aria-hidden="true">
              ↳
            </span>
            <span className="line-verb">Answer</span>
            <span className="line-target plain">{item.output}</span>
          </div>
        </div>
      )}
    </>
  );
}
