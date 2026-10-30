import { memo, useEffect, useRef, useState, type ReactNode } from "react";
import type { ApprovalDecision, ChatItem, PersonaSummary } from "@ph/shared";
import { allowScopeLabel, consequence, describeTool, mountFor, str, TOOL_STATUS_TEXT, type ReceiptText, type ToolItem } from "../receipts";
import { useStore } from "../store";
import { basename, cls, exitCode, fmtDuration, isEditableTarget, isRecord, prettyJson, toolDisplayName } from "../util";
import {
  IconAlert,
  IconChevronRight,
  IconCornerDown,
  IconFile,
  IconInfo,
  IconPencil,
  IconPlug,
  IconRepeat,
  IconSearch,
  IconSlash,
  IconSparkles,
  IconTerminal,
  IconWarning,
  IconWrench,
} from "./icons";
import { Markdown } from "./Markdown";
import { CopyButton, Fold, Kbd, Spinner } from "./ui";

// ---------- Messages ----------

export function UserMessage({ item }: { item: Extract<ChatItem, { kind: "user" }> }) {
  return (
    <div className="msg msg-user" id={`item-${item.id}`}>
      <span className="msg-who">You</span>
      <div className="bubble bubble-user">{item.text}</div>
    </div>
  );
}

export function AssistantMessage({
  item,
  persona,
  showHeader,
}: {
  item: Extract<ChatItem, { kind: "assistant_text" }>;
  persona: PersonaSummary | null;
  showHeader: boolean;
}) {
  const name = persona?.name ?? "Agent";
  return (
    <div className={cls("msg msg-model", !showHeader && "cont")} id={`item-${item.id}`}>
      <span className="avatar" aria-hidden="true">
        {showHeader ? initialsOf(name) : ""}
      </span>
      <div className="msg-model-main">
        {showHeader && <span className="msg-who">{name}</span>}
        <div className="bubble bubble-model">
          <Markdown text={item.text} streaming={item.streaming} />
        </div>
      </div>
    </div>
  );
}

function initialsOf(name: string): string {
  const parts = name.trim().split(/\s+/);
  return ((parts[0]?.[0] ?? "") + (parts[1]?.[0] ?? parts[0]?.[1] ?? "")).toUpperCase();
}

export function Thinking({ item }: { item: Extract<ChatItem, { kind: "thinking" }> }) {
  return (
    <div className="thinking" id={`item-${item.id}`}>
      <Fold
        summary={
          <span>
            {item.streaming ? "Thinking…" : "Thinking"}
            {item.streaming && <Spinner size={10} />}
          </span>
        }
      >
        <div className="thinking-text">{item.text}</div>
      </Fold>
    </div>
  );
}

// ---------- Notices and harness receipts ----------

export function NoticeLine({ item }: { item: Extract<ChatItem, { kind: "notice" }> }) {
  const [open, setOpen] = useState(false);
  const lines = item.text.split("\n");
  const long = lines.length > 1 || item.text.length > 160;
  const Icon = item.level === "error" ? IconAlert : item.level === "warn" ? IconWarning : IconInfo;
  const label = item.level === "error" ? "Error" : item.level === "warn" ? "Warning" : "Notice";
  const head = (
    <>
      <Icon size={16} className={`tone-${item.level === "info" ? "muted" : item.level === "warn" ? "attention" : "error"}`} />
      <span className="notice-label">{label}</span>
      <span className="notice-text">{long && !open ? lines[0].slice(0, 160) : lines[0]}</span>
    </>
  );
  return (
    <div className={cls("notice", `notice-${item.level}`)} id={`item-${item.id}`} role={item.level === "error" ? "alert" : undefined}>
      {long ? (
        <button type="button" className="notice-head" aria-expanded={open} onClick={() => setOpen(!open)}>
          {head}
          <IconChevronRight className={cls("chev", open && "open")} />
        </button>
      ) : (
        <div className="notice-head">{head}</div>
      )}
      {open && <pre className="notice-more">{item.text}</pre>}
    </div>
  );
}

const RECEIPT_STATUS: Record<"running" | "done" | "error", string | null> = { running: "Running", done: null, error: "Failed" };

export function HarnessReceipt({ item }: { item: Extract<ChatItem, { kind: "receipt" }> }) {
  const Icon = item.action === "dream" ? IconSparkles : item.action === "rollover" ? IconRepeat : item.action === "steer" ? IconCornerDown : IconSlash;
  const status = RECEIPT_STATUS[item.status];
  return (
    <div className={cls("receipt receipt-harness", `rs-${item.status}`)} id={`item-${item.id}`}>
      <div className="receipt-head static">
        <Icon size={18} className={item.action === "dream" ? "tone-accent" : "tone-muted"} />
        <span className="receipt-verb">{item.title}</span>
        {item.detail && <span className="receipt-result">{item.detail}</span>}
        <span className="grow" />
        {item.status === "running" && <Spinner size={12} />}
        {status && <span className={cls("status-text", item.status === "error" ? "tone-error" : "tone-muted")}>{status}</span>}
      </div>
    </div>
  );
}

// ---------- Tool receipts ----------

function ToolIcon({ icon, className }: { icon: ReceiptText["icon"]; className?: string }) {
  const props = { size: 18, className };
  switch (icon) {
    case "file":
      return <IconFile {...props} />;
    case "search":
      return <IconSearch {...props} />;
    case "terminal":
      return <IconTerminal {...props} />;
    case "pencil":
      return <IconPencil {...props} />;
    case "plug":
      return <IconPlug {...props} />;
    case "sparkles":
      return <IconSparkles {...props} />;
    default:
      return <IconWrench {...props} />;
  }
}

/** Full-width one-line receipt; expansion shows input, output, duration, exit status and the matched rule. */
export const ToolReceipt = memo(function ToolReceipt({
  item,
  sessionId,
  persona,
}: {
  item: ToolItem;
  sessionId: string;
  persona: PersonaSummary | null;
}) {
  const [open, setOpen] = useState(false);
  const d = describeTool(item);
  const status = TOOL_STATUS_TEXT[item.status];
  const pending = item.status === "pending_approval";
  const tone =
    item.status === "pending_approval" ? "attention" : item.status === "error" || item.isError ? "error" : "muted";
  const code = item.name === "bash" ? exitCode(item.output) : null;
  return (
    <div
      className={cls("receipt", `ts-${item.status}`, pending && "is-pending")}
      id={pending ? `approval-${item.id}` : `item-${item.id}`}
      tabIndex={pending ? -1 : undefined}
    >
      <button type="button" className="receipt-head" aria-expanded={open} onClick={() => setOpen(!open)}>
        <ToolIcon icon={d.icon} className={pending ? "tone-attention" : "tone-muted"} />
        <span className="receipt-verb">
          {d.verb} <span className="mono">{d.target}</span>
        </span>
        {d.result && <span className="receipt-result">· {d.result}</span>}
        <span className="grow" />
        {item.status === "running" && <Spinner size={12} />}
        {status && (
          <span className={cls("status-text", `tone-${tone}`)}>
            {pending && <span className="dot attention" aria-hidden="true" />}
            {status}
          </span>
        )}
        {item.durationMs !== undefined && <span className="receipt-dur">{fmtDuration(item.durationMs)}</span>}
        <IconChevronRight className={cls("chev", open && "open")} size={16} />
      </button>
      {open && (
        <div className="receipt-body">
          <ToolInput item={item} />
          {item.output !== undefined && (
            <Section label={item.isError ? "Error output" : "Output"} copy={item.output}>
              <pre className={cls("code", item.isError && "is-error")}>{item.output || "(empty)"}</pre>
            </Section>
          )}
          <dl className="facts">
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
          </dl>
          {pending && <ApprovalActions item={item} sessionId={sessionId} persona={persona} />}
        </div>
      )}
    </div>
  );
});

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
              <span className="prompt" aria-hidden="true">
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
      if (c !== null) return <WritePreview path={path} content={c} />;
    }
  }
  const text = prettyJson(input);
  return (
    <Section label="Input" copy={text}>
      <pre className="code">{text || "(none)"}</pre>
    </Section>
  );
}

function WritePreview({ path, content }: { path: string | null; content: string }) {
  const lines = content.split("\n");
  const shown = lines.slice(0, 200);
  return (
    <Section label={path ?? "New content"} copy={content}>
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

// ---------- Approval ----------

function approvalTitle(item: ToolItem): string {
  const { server, tool } = toolDisplayName(item.name);
  if (server) return `Call ${server} › ${tool}`;
  const path = str(item.input, ["path", "file_path"]);
  switch (tool) {
    case "edit_file":
      return `Edit ${path ? basename(path) : "file"}`;
    case "write_file":
      return `Write ${path ? basename(path) : "file"}`;
    case "bash":
      return "Run a command";
    case "read_file":
      return `Read ${path ? basename(path) : "file"}`;
    default:
      return `Use ${tool}`;
  }
}

/** The oldest waiting call, open inline at full column width. */
export function ApprovalCard({
  item,
  sessionId,
  persona,
}: {
  item: ToolItem;
  sessionId: string;
  persona: PersonaSummary | null;
}) {
  const ref = useRef<HTMLElement>(null);
  const actionsRef = useRef<ApprovalHandle | null>(null);
  const title = approvalTitle(item);
  const d = describeTool(item);
  const path = str(item.input, ["path", "file_path"]);
  const folder = path ? mountFor(path, persona) : null;

  // When the previous card was decided, keep keyboard users on the next decision.
  useEffect(() => {
    const ae = document.activeElement;
    if (!ae || ae === document.body) ref.current?.focus({ preventScroll: true });
  }, []);

  const onKeyDown = (e: React.KeyboardEvent) => {
    if (e.metaKey || e.ctrlKey || e.altKey || isEditableTarget(e.target)) return;
    const k = e.key.toLowerCase();
    if (k === "a") {
      e.preventDefault();
      actionsRef.current?.decide(e.shiftKey ? "allow_always" : "allow");
    } else if (k === "d") {
      e.preventDefault();
      actionsRef.current?.startDeny();
    }
  };

  return (
    <section
      ref={ref}
      id={`approval-${item.id}`}
      className="approval"
      tabIndex={0}
      aria-label={`${title}, decision needed`}
      onKeyDown={onKeyDown}
    >
      <div className="approval-head">
        <ToolIcon icon={d.icon} className="tone-attention" />
        <h2>{title}</h2>
        <span className="grow" />
        <span className="status-text tone-attention">
          <span className="dot attention" aria-hidden="true" />
          Decision needed
        </span>
      </div>
      <ToolInput item={item} />
      <div className="approval-meta">
        <span>{consequence(item, persona)}</span>
      </div>
      <Fold summary="Why approval is required" className="approval-why">
        <dl className="facts">
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
            Adds a temporary rule for {item.name === "bash" ? "this exact command" : <span className="mono">{item.name}</span>}. It
            ends when the agent is stopped or interrupted, or Swan restarts, and never edits the persona.
          </dd>
        </dl>
      </Fold>
      <ApprovalActions item={item} sessionId={sessionId} persona={persona} handleRef={actionsRef} large />
      <p className="approval-keys">
        <Kbd>A</Kbd> allow once · <Kbd>⇧A</Kbd> allow until stopped · <Kbd>D</Kbd> deny
      </p>
    </section>
  );
}

interface ApprovalHandle {
  decide(d: ApprovalDecision): void;
  startDeny(): void;
}

function ApprovalActions({
  item,
  sessionId,
  handleRef,
  large,
}: {
  item: ToolItem;
  sessionId: string;
  persona: PersonaSummary | null;
  handleRef?: React.MutableRefObject<ApprovalHandle | null>;
  large?: boolean;
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

  if (handleRef) handleRef.current = { decide: (d) => void decide(d), startDeny: () => setDenying(true) };

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
            placeholder="e.g. Don't touch the public API"
          />
        </label>
        <div className="deny-actions">
          <button type="button" className="btn" onClick={() => setDenying(false)} disabled={busy !== null}>
            Cancel
          </button>
          <button type="submit" className="btn danger" disabled={busy !== null}>
            {busy === "deny" && <Spinner size={12} />}
            Deny
          </button>
        </div>
      </form>
    );
  }

  return (
    <div className={cls("approval-actions", large && "large")}>
      <button type="button" className="btn primary" disabled={busy !== null} onClick={() => void decide("allow")}>
        {busy === "allow" && <Spinner size={12} />}
        Allow once
      </button>
      <button type="button" className="btn" disabled={busy !== null} onClick={() => void decide("allow_always")}>
        {busy === "allow_always" && <Spinner size={12} />}
        {allowScopeLabel(item)}
      </button>
      <button type="button" className="btn" disabled={busy !== null} onClick={() => setDenying(true)}>
        Deny
      </button>
    </div>
  );
}
