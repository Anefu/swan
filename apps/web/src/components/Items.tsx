import { memo, useEffect, useRef, useState, type ReactNode } from "react";
import type { ApprovalDecision, ChatItem, PersonaSummary } from "@ph/shared";
import {
  allowScopeLabel,
  consequence,
  describeTool,
  mountFor,
  str,
  summarizeTools,
  TOOL_STATUS_TEXT,
  type ToolItem,
} from "../receipts";
import { useStore } from "../store";
import { basename, cls, exitCode, fmtDuration, isEditableTarget, isRecord, prettyJson, toolDisplayName } from "../util";
import { IconChevronRight } from "./icons";
import { Markdown } from "./Markdown";
import { CopyButton, Fold, Kbd, Spinner } from "./ui";

// ---------- Messages ----------

export function UserMessage({ item }: { item: Extract<ChatItem, { kind: "user" }> }) {
  return (
    <div className="msg-user" id={`item-${item.id}`}>
      <span className="sr-only">You said:</span>
      <div className="user-block">{item.text}</div>
    </div>
  );
}

/** Assistant prose flows as plain markdown at full column width. */
export const AssistantText = memo(function AssistantText({ item }: { item: Extract<ChatItem, { kind: "assistant_text" }> }) {
  return (
    <div className="msg-model" id={`item-${item.id}`}>
      <Markdown text={item.text} streaming={item.streaming} />
    </div>
  );
});

function seconds(fromIso: string, toIso: string | null): number | null {
  if (!toIso) return null;
  const s = Math.round((Date.parse(toIso) - Date.parse(fromIso)) / 1000);
  return Number.isFinite(s) && s >= 0 ? s : null;
}

export function Thinking({ item, endTs }: { item: Extract<ChatItem, { kind: "thinking" }>; endTs: string | null }) {
  const [open, setOpen] = useState(false);
  const secs = item.streaming ? null : seconds(item.ts, endTs);
  const label = item.streaming ? "Thinking" : secs !== null && secs > 0 ? `Thought for ${secs}s` : "Thought";
  return (
    <div className="line-item" id={`item-${item.id}`}>
      <button type="button" className="line" aria-expanded={open} onClick={() => setOpen(!open)}>
        <span className="glyph" aria-hidden="true">
          ∴
        </span>
        <span className={cls("line-muted", item.streaming && "shimmer")}>
          {label}
          {item.streaming && <Dots />}
        </span>
        <IconChevronRight className="chev" size={14} />
      </button>
      {open && <div className="line-detail thinking-text">{item.text || "…"}</div>}
    </div>
  );
}

export function Dots() {
  return (
    <span className="dots" aria-hidden="true">
      <span>.</span>
      <span>.</span>
      <span>.</span>
    </span>
  );
}

// ---------- Notices and harness receipts (same line style) ----------

export function NoticeLine({ item }: { item: Extract<ChatItem, { kind: "notice" }> }) {
  const [open, setOpen] = useState(false);
  const lines = item.text.split("\n");
  const long = lines.length > 1 || item.text.length > 140;
  const label = item.level === "error" ? "Error" : item.level === "warn" ? "Warning" : "Notice";
  const tone = item.level === "error" ? "tone-error" : item.level === "warn" ? "tone-attention" : "tone-muted";
  const body = (
    <>
      <span className={cls("glyph", tone)} aria-hidden="true">
        {item.level === "info" ? "i" : "!"}
      </span>
      <span className={cls("line-verb", item.level !== "info" && tone)}>{label}</span>
      <span className="line-target plain">{long && !open ? `${lines[0].slice(0, 140)}${lines[0].length > 140 ? "…" : ""}` : lines[0]}</span>
    </>
  );
  return (
    <div className="line-item" id={`item-${item.id}`} role={item.level === "error" ? "alert" : undefined}>
      {long ? (
        <button type="button" className="line" aria-expanded={open} onClick={() => setOpen(!open)}>
          {body}
          <IconChevronRight className="chev" size={14} />
        </button>
      ) : (
        <div className="line static">{body}</div>
      )}
      {open && <pre className="line-detail code-plain">{item.text}</pre>}
    </div>
  );
}

export function HarnessReceipt({ item }: { item: Extract<ChatItem, { kind: "receipt" }> }) {
  const glyph = item.action === "dream" ? "✦" : item.action === "rollover" ? "↻" : item.action === "steer" ? "↳" : "/";
  return (
    <div className="line-item" id={`item-${item.id}`}>
      <div className="line static">
        {item.status === "running" ? (
          <Spinner size={11} />
        ) : (
          <span className={cls("glyph", item.status === "error" ? "tone-error" : item.action === "dream" ? "tone-accent" : "tone-muted")} aria-hidden="true">
            {glyph}
          </span>
        )}
        <span className="line-verb">{item.title}</span>
        {item.detail && <span className="line-meta">{item.detail}</span>}
        {item.status === "error" && <span className="line-status tone-error">Failed</span>}
      </div>
    </div>
  );
}

// ---------- Tool lines ----------

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
  const d = describeTool(item);
  const pending = item.status === "pending_approval";
  const status = TOOL_STATUS_TEXT[item.status];
  const isNet = item.name === "network_access";
  const meta: string[] = [];
  if (isNet && item.output && !pending) meta.push(item.output);
  if (d.result) meta.push(d.result);
  if (item.durationMs !== undefined && !isNet) meta.push(fmtDuration(item.durationMs));
  const showPrompt = pending && (promptOpen || open);
  return (
    <div className={cls("line-item", pending && "is-pending")} id={`item-${item.id}`}>
      <button type="button" className="line" aria-expanded={open} onClick={() => setOpen(!open)}>
        <ToolGlyph item={item} />
        <span className="line-verb">{d.verb}</span>
        <span className="line-target mono">{d.target}</span>
        {meta.length > 0 && <span className="line-meta">· {meta.join(" · ")}</span>}
        {status && item.status !== "running" && (
          <span className={cls("line-status", pending ? "tone-attention" : item.status === "interrupted" ? "tone-muted" : "tone-error")}>
            {status}
          </span>
        )}
        <IconChevronRight className="chev" size={14} />
      </button>
      {open && !isNet && (
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
      {open && isNet && !pending && (
        <div className="line-detail">
          <Facts item={item} />
        </div>
      )}
      {showPrompt &&
        (isNet ? (
          <NetworkPrompt item={item} sessionId={sessionId} />
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
      {item.name === "network_access" && item.output && (
        <>
          <dt>Outcome</dt>
          <dd>{item.output}</dd>
        </>
      )}
    </dl>
  );
}

/** Consecutive finished tool calls fold into one summary line. */
export function ToolGroup({ items, sessionId, persona }: { items: ToolItem[]; sessionId: string; persona: PersonaSummary | null }) {
  const [open, setOpen] = useState(false);
  const failed = items.filter((i) => i.status === "error" || i.isError || i.status === "denied").length;
  const ms = items.reduce((a, i) => a + (i.durationMs ?? 0), 0);
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
          {items.map((it) => (
            <ToolLine key={it.id} item={it} sessionId={sessionId} persona={persona} promptOpen={false} />
          ))}
        </div>
      )}
    </div>
  );
}

function Section({ label, copy, children }: { label: string; copy?: string; children: ReactNode }) {
  return (
    <div className="section">
      <div className="section-label">
        <span>{label}</span>
        {copy ? <CopyButton text={copy} label={`Copy ${label.toLowerCase()}`} /> : null}
      </div>
      {children}
    </div>
  );
}

/** Line diff: common leading/trailing lines become context. */
export function DiffView({ oldText, newText }: { oldText: string; newText: string }) {
  const a = oldText.split("\n");
  const b = newText.split("\n");
  let pre = 0;
  while (pre < a.length && pre < b.length && a[pre] === b[pre]) pre++;
  let suf = 0;
  while (suf < a.length - pre && suf < b.length - pre && a[a.length - 1 - suf] === b[b.length - 1 - suf]) suf++;
  const rows: Array<{ sign: " " | "-" | "+"; text: string }> = [];
  for (let i = Math.max(0, pre - 2); i < pre; i++) rows.push({ sign: " ", text: a[i] });
  for (let i = pre; i < a.length - suf; i++) rows.push({ sign: "-", text: a[i] });
  for (let i = pre; i < b.length - suf; i++) rows.push({ sign: "+", text: b[i] });
  for (let i = a.length - suf; i < Math.min(a.length, a.length - suf + 2); i++) rows.push({ sign: " ", text: a[i] });
  return (
    <pre className="code diff" aria-label="Proposed change">
      {rows.map((r, i) => (
        <span key={i} className={cls("diff-line", r.sign === "-" ? "del" : r.sign === "+" ? "add" : "ctx")}>
          <span className="diff-sign" aria-label={r.sign === "-" ? "removed" : r.sign === "+" ? "added" : undefined}>
            {r.sign}
          </span>
          {r.text || " "}
          {"\n"}
        </span>
      ))}
    </pre>
  );
}

function ToolInput({ item }: { item: ToolItem }) {
  const tool = toolDisplayName(item.name).tool;
  const input = item.input;
  if (isRecord(input) && !toolDisplayName(item.name).server) {
    const path = str(input, ["path", "file_path", "filePath", "file"]);
    if (tool === "bash") {
      const cmd = str(input, ["command", "cmd"]);
      if (cmd)
        return (
          <Section label="Command" copy={cmd}>
            <pre className="code">
              <span className="sh-prompt" aria-hidden="true">
                ${" "}
              </span>
              {cmd}
            </pre>
          </Section>
        );
    }
    if (tool === "edit_file") {
      const o = str(input, ["old_string"]);
      const n = str(input, ["new_string"]);
      if (o !== null || n !== null)
        return (
          <Section label={path ?? "Change"}>
            <DiffView oldText={o ?? ""} newText={n ?? ""} />
          </Section>
        );
    }
    if (tool === "write_file") {
      const c = str(input, ["content"]);
      if (c !== null) {
        const lines = c.split("\n");
        const shown = lines.slice(0, 200);
        return (
          <Section label={path ?? "New content"} copy={c}>
            <pre className="code diff">
              {shown.map((l, i) => (
                <span key={i} className="diff-line add">
                  <span className="diff-sign">+</span>
                  {l || " "}
                  {"\n"}
                </span>
              ))}
            </pre>
            {lines.length > shown.length && <p className="muted small">{lines.length - shown.length} more lines not shown.</p>}
          </Section>
        );
      }
    }
  }
  const text = prettyJson(input);
  return (
    <Section label="Input" copy={text}>
      <pre className="code">{text || "(none)"}</pre>
    </Section>
  );
}

// ---------- Approval prompts ----------

interface DecideHandle {
  decide(d: ApprovalDecision): void;
  startDeny(): void;
}

/** A / ⇧A / D while focus is inside the prompt. */
function useDecisionKeys(handle: React.MutableRefObject<DecideHandle | null>) {
  return (e: React.KeyboardEvent) => {
    if (e.metaKey || e.ctrlKey || e.altKey || isEditableTarget(e.target)) return;
    const k = e.key.toLowerCase();
    if (k === "a") {
      e.preventDefault();
      handle.current?.decide(e.shiftKey ? "allow_always" : "allow");
    } else if (k === "d") {
      e.preventDefault();
      handle.current?.startDeny();
    }
  };
}

function useAutoFocus(ref: React.RefObject<HTMLElement | null>) {
  useEffect(() => {
    const ae = document.activeElement;
    if (!ae || ae === document.body) ref.current?.focus({ preventScroll: true });
  }, []); // eslint-disable-line react-hooks/exhaustive-deps
}

function ApprovalPrompt({
  item,
  sessionId,
  persona,
  showInput,
}: {
  item: ToolItem;
  sessionId: string;
  persona: PersonaSummary | null;
  showInput: boolean;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const handle = useRef<DecideHandle | null>(null);
  const onKeyDown = useDecisionKeys(handle);
  useAutoFocus(ref);
  const path = str(item.input, ["path", "file_path"]);
  const folder = path ? mountFor(path, persona) : null;
  const tool = toolDisplayName(item.name).tool;
  const what = tool === "edit_file" || tool === "write_file" ? `${tool === "edit_file" ? "Edit" : "Write"} ${path ? basename(path) : "file"}` : null;
  return (
    <div
      ref={ref}
      id={`approval-${item.id}`}
      className="prompt"
      tabIndex={0}
      role="group"
      aria-label={`${what ?? item.name}: decision needed`}
      onKeyDown={onKeyDown}
    >
      <p className="prompt-q">
        <strong>{what ?? `Allow ${item.name}?`}</strong> <span className="muted">· {consequence(item, persona)}</span>
      </p>
      {showInput && <ToolInput item={item} />}
      <Fold summary="Why approval is required">
        <dl className="facts small">
          <dt>Matched rule</dt>
          <dd className="mono">{item.approvalReason || `${item.name} resolves to “ask” for this persona`}</dd>
          {folder && (
            <>
              <dt>Path mapping</dt>
              <dd className="mono">
                {folder.mountPath} → {folder.hostPath} ({folder.mode === "rw" ? "read-write" : "read-only"})
              </dd>
            </>
          )}
          <dt>Allow until stopped</dt>
          <dd>
            Adds a temporary rule for {item.name === "bash" ? "this exact command" : <span className="mono">{item.name}</span>}. It ends when
            the agent is stopped or interrupted, or Swan restarts, and never edits the persona.
          </dd>
        </dl>
      </Fold>
      <DecisionButtons
        item={item}
        sessionId={sessionId}
        handleRef={handle}
        labels={{ allow: "Allow once", always: allowScopeLabel(item) }}
      />
      <p className="prompt-keys">
        <Kbd>A</Kbd> allow once · <Kbd>⇧A</Kbd> until stopped · <Kbd>D</Kbd> deny
      </p>
    </div>
  );
}

/** The sandbox asked for a host that is not on the allowlist; the request waits. */
function NetworkPrompt({ item, sessionId }: { item: ToolItem; sessionId: string }) {
  const ref = useRef<HTMLDivElement>(null);
  const handle = useRef<DecideHandle | null>(null);
  const onKeyDown = useDecisionKeys(handle);
  useAutoFocus(ref);
  const host = str(item.input, ["host"]) ?? item.inputPreview;
  return (
    <div
      ref={ref}
      id={`approval-${item.id}`}
      className="prompt"
      tabIndex={0}
      role="group"
      aria-label={`Network access to ${host}: decision needed`}
      onKeyDown={onKeyDown}
    >
      <p className="prompt-q">
        Allow network access to <strong className="mono">{item.inputPreview || host}</strong>?{" "}
        <span className="muted">The request is paused; it is {item.approvalReason ?? "not on the allowlist"}.</span>
      </p>
      <DecisionButtons
        item={item}
        sessionId={sessionId}
        handleRef={handle}
        labels={{ allow: "Allow until stopped", always: `Always allow ${host}` }}
      />
      <p className="prompt-keys">
        “Always allow” adds {host} to this persona's allowed hosts. Deny blocks it until the agent is stopped. <Kbd>A</Kbd> ·{" "}
        <Kbd>⇧A</Kbd> · <Kbd>D</Kbd>
      </p>
    </div>
  );
}

function DecisionButtons({
  item,
  sessionId,
  handleRef,
  labels,
}: {
  item: ToolItem;
  sessionId: string;
  handleRef: React.MutableRefObject<DecideHandle | null>;
  labels: { allow: string; always: string };
}) {
  const { actions } = useStore();
  const [busy, setBusy] = useState<ApprovalDecision | null>(null);
  const [denying, setDenying] = useState(false);
  const [reason, setReason] = useState("");
  const reasonRef = useRef<HTMLInputElement>(null);

  const decide = async (decision: ApprovalDecision) => {
    if (busy) return;
    setBusy(decision);
    const body = decision === "deny" && reason.trim() ? { decision, reason: reason.trim() } : { decision };
    const ok = await actions.approve(sessionId, item.id, body);
    if (!ok) setBusy(null);
  };
  handleRef.current = { decide: (d) => void decide(d), startDeny: () => setDenying(true) };

  useEffect(() => {
    if (denying) reasonRef.current?.focus();
  }, [denying]);

  if (denying) {
    return (
      <form
        className="deny-form"
        onSubmit={(e) => {
          e.preventDefault();
          void decide("deny");
        }}
      >
        <label className="field grow">
          <span className="field-label">Reason for the agent (optional)</span>
          <input
            ref={reasonRef}
            className="input"
            value={reason}
            onChange={(e) => setReason(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Escape") {
                e.preventDefault();
                e.stopPropagation();
                setDenying(false);
              }
            }}
            disabled={busy !== null}
          />
        </label>
        <div className="deny-actions">
          <button type="button" className="btn sm" onClick={() => setDenying(false)} disabled={busy !== null}>
            Cancel
          </button>
          <button type="submit" className="btn sm danger" disabled={busy !== null}>
            {busy === "deny" && <Spinner size={10} />}
            Deny
          </button>
        </div>
      </form>
    );
  }
  return (
    <div className="prompt-actions">
      <button type="button" className="btn sm primary" disabled={busy !== null} onClick={() => void decide("allow")}>
        {busy === "allow" && <Spinner size={10} />}
        {labels.allow}
      </button>
      <button type="button" className="btn sm" disabled={busy !== null} onClick={() => void decide("allow_always")}>
        {busy === "allow_always" && <Spinner size={10} />}
        {labels.always}
      </button>
      <button type="button" className="btn sm" disabled={busy !== null} onClick={() => setDenying(true)}>
        Deny
      </button>
    </div>
  );
}
