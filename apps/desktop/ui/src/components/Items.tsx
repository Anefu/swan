import { createContext, memo, useContext, useEffect, useRef, useState, type ReactNode } from "react";
import type { AgentRun, ApprovalDecision, ChatItem, PersonaSummary } from "@ph/shared";
import {
  AGENT_CONTROL_TOOLS,
  agentLive,
  agentState,
  allowScopeLabel,
  consequence,
  describeTool,
  mountFor,
  str,
  summarizeTools,
  TOOL_STATUS_TEXT,
  type ToolItem,
} from "../receipts";
import { attachmentFileUrl } from "../api";
import { attachmentPreviews, modelLabel, useStore } from "../store";
import { basename, cls, EFFORT_LABEL, exitCode, fmtBytes, fmtDuration, isEditableTarget, isRecord, prettyJson, toolDisplayName, useNow } from "../util";
import { DeviceCodePanel } from "./DeviceCode";
import { IconChevronRight, IconFile } from "./icons";
import { Markdown } from "./Markdown";
import { CopyButton, Fold, Kbd, Spinner } from "./ui";

// ---------- Messages ----------

export function UserMessage({ item, sessionId }: { item: Extract<ChatItem, { kind: "user" }>; sessionId?: string }) {
  const atts = item.attachments ?? [];
  const [preview, setPreview] = useState<{ url: string; name: string; trigger: HTMLElement | null } | null>(null);
  // If the server cannot serve an image, fall back to this session's local copy, then to a file chip.
  const [broken, setBroken] = useState<Set<string>>(() => new Set());
  return (
    <div className="msg-user" id={`item-${item.id}`}>
      <span className="sr-only">You said:</span>
      <div className="user-col">
        {atts.length > 0 && (
          <ul className="att-row" aria-label="Attachments">
            {atts.map((a) => {
              const remote = a.kind === "image" && sessionId && !broken.has(a.id) ? attachmentFileUrl(sessionId, a.id) : undefined;
              const url = a.kind === "image" ? (remote ?? attachmentPreviews.get(a.id)) : undefined;
              return (
                <li key={a.id}>
                  {url ? (
                    <button
                      type="button"
                      className="att-thumb-btn"
                      aria-label={`Preview ${a.name}`}
                      title={`${a.name} · ${fmtBytes(a.size)} · ${a.sandboxPath}`}
                      onClick={(e) => setPreview({ url, name: a.name, trigger: e.currentTarget })}
                    >
                      <img
                        src={url}
                        alt={a.name}
                        onError={() => remote && setBroken((b) => new Set(b).add(a.id))}
                      />
                    </button>
                  ) : (
                    <span className="att-chip sent" tabIndex={0} title={`In the sandbox at ${a.sandboxPath}`}>
                      <IconFile size={14} className="att-icon" />
                      <span className="att-text">
                        <span className="att-name">{a.name}</span>
                        <span className="att-meta">
                          {a.kind === "image" ? "Image" : a.kind === "pdf" ? "PDF" : "File"} · {fmtBytes(a.size)}
                        </span>
                      </span>
                      <span className="sr-only">, in the sandbox at {a.sandboxPath}</span>
                    </span>
                  )}
                </li>
              );
            })}
          </ul>
        )}
        {item.text && <div className="user-block">{item.text}</div>}
      </div>
      {preview && (
        <ImagePreview
          url={preview.url}
          name={preview.name}
          onClose={() => {
            const t = preview.trigger;
            setPreview(null);
            t?.focus();
          }}
        />
      )}
    </div>
  );
}

function ImagePreview({ url, name, onClose }: { url: string; name: string; onClose: () => void }) {
  const ref = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    ref.current?.focus();
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        e.stopPropagation();
        onClose();
      }
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [onClose]);
  return (
    <div className="preview-overlay" role="dialog" aria-modal="true" aria-label={`Preview of ${name}`} onClick={onClose}>
      <img src={url} alt={name} onClick={(e) => e.stopPropagation()} />
      <div className="preview-bar">
        <span>{name}</span>
        <button ref={ref} type="button" className="btn sm" onClick={onClose}>
          Close
        </button>
      </div>
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
  const agent = item.action === "agent";
  const glyph = item.action === "dream" ? "✦" : item.action === "rollover" ? "↻" : item.action === "steer" ? "↳" : agent ? "●" : "/";
  // Background-agent receipts look like the agent line they report on; a question needs attention.
  const tone =
    item.status === "error"
      ? "tone-error"
      : item.action === "dream"
        ? "tone-accent"
        : agent
          ? /question/i.test(item.title)
            ? "tone-attention"
            : "tone-ok"
          : "tone-muted";
  return (
    <div className="line-item" id={`item-${item.id}`}>
      <div className="line static">
        {item.status === "running" ? (
          <Spinner size={11} />
        ) : (
          <span className={cls("glyph", tone)} aria-hidden="true">
            {glyph}
          </span>
        )}
        <span className="line-verb">{item.title}</span>
        {item.detail && <span className="line-meta">{item.detail}</span>}
        {item.status === "error" && !agent && <span className="line-status tone-error">Failed</span>}
      </div>
    </div>
  );
}

// ---------- Connections ----------

/** A command connection needs a sign-in. The code is for the user; the agent never sees it. */
export function SignInCard({ item }: { item: Extract<ChatItem, { kind: "sign_in" }> }) {
  const { actions } = useStore();
  const [busy, setBusy] = useState(false);
  const active = item.state === "starting" || item.state === "waiting";
  if (!active) {
    const failed = item.state === "failed";
    const text =
      item.state === "done"
        ? `Signed in to ${item.connection}`
        : item.state === "cancelled"
          ? `Sign-in to ${item.connection} cancelled`
          : `Sign-in to ${item.connection} failed${item.message ? `: ${item.message}` : ""}`;
    return (
      <div className="line-item" id={`item-${item.id}`}>
        <div className="line static">
          <span className={cls("glyph", failed ? "tone-error" : item.state === "done" ? "tone-ok" : "tone-muted")} aria-hidden="true">
            {failed ? "!" : item.state === "done" ? "●" : "◌"}
          </span>
          <span className="line-target plain">{text}</span>
        </div>
      </div>
    );
  }
  return (
    <div className="line-item is-pending" id={`item-${item.id}`}>
      <div className="line static">
        <span className="glyph tone-attention" aria-hidden="true">
          ●
        </span>
        <span className="line-verb">Sign in to {item.connection}</span>
      </div>
      <div className="prompt" role="group" aria-label={`Sign in to ${item.connection}`}>
        <DeviceCodePanel
          code={item.state === "waiting" ? (item.code ?? null) : null}
          busy={busy}
          onCancel={async () => {
            setBusy(true);
            await actions.connectionAction(item.connection, "cancel");
            setBusy(false);
          }}
        />
      </div>
    </div>
  );
}

/** Requests that went out without a credential because no rule allowed them. */
export function CredentialBlockedLine({
  item,
  persona,
}: {
  item: Extract<ChatItem, { kind: "credential_blocked" }>;
  persona: PersonaSummary | null;
}) {
  const { actions } = useStore();
  const [open, setOpen] = useState(false);
  const latest = item.operations[item.operations.length - 1] ?? "";
  const others = item.operations.slice(0, -1).reverse();
  const slash = item.credential.indexOf("/");
  const connection = item.credential.slice(0, slash);
  const name = item.credential.slice(slash + 1);
  const body = (
    <>
      <span className="glyph tone-attention" aria-hidden="true">
        ⊘
      </span>
      <span className="line-verb">Blocked</span>
      <span className="line-target mono">{latest}</span>
      <span className="line-meta">
        with {item.credential}: {item.rule ? `rule "${item.rule}"` : "no rule"}
        {item.count > 1 && ` · ×${item.count}`}
      </span>
    </>
  );
  return (
    <div className="line-item" id={`item-${item.id}`}>
      <div className="row gap">
        {others.length > 0 ? (
          <button type="button" className="line grow" aria-expanded={open} onClick={() => setOpen(!open)}>
            {body}
            <IconChevronRight className="chev" size={14} />
          </button>
        ) : (
          <div className="line static grow">{body}</div>
        )}
        {persona && (
          <button
            type="button"
            className="link-btn line-action"
            title={`Opens Settings with an allow rule for ${item.suggestion}`}
            aria-label={`Add rule allowing ${item.suggestion} with ${item.credential}`}
            onClick={() =>
              actions.addRuleInSettings(persona.id, connection, { credential: name, api: item.api, allow: [item.suggestion], ask: [], deny: [] })
            }
          >
            Add rule…
          </button>
        )}
      </div>
      {open && (
        <div className="line-detail">
          <span className="small muted">Also sent without the credential:</span>
          <ul className="plain-list small mono">
            {others.map((o) => (
              <li key={o}>{o}</li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}

// ---------- Tool lines ----------

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
  const status = TOOL_STATUS_TEXT[item.status];
  const isNet = item.name === "network_access";
  const isCred = item.name === "credential_use";
  // Network and credential asks are decisions, not commands: their output is a one-line outcome.
  const isAsk = isNet || isCred;
  const meta: string[] = [];
  if (isAsk && item.output && !pending) meta.push(item.output);
  if (d.result) meta.push(d.result);
  if (item.durationMs !== undefined && !isAsk && !AGENT_CONTROL_TOOLS.has(item.name)) meta.push(fmtDuration(item.durationMs));
  const showPrompt = pending && (promptOpen || open);
  return (
    <div className={cls("line-item", pending && "is-pending")} id={`item-${item.id}`}>
      <button type="button" className="line" aria-expanded={open} onClick={() => setOpen(!open)}>
        <ToolGlyph item={item} />
        <span className="line-verb">{d.verb}</span>
        {d.target && <span className={cls("line-target", !d.prose && "mono")}>{d.target}</span>}
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
          <Facts item={item} />
        </div>
      )}
      {showPrompt &&
        (isNet ? (
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
    if (tool === "agent_message") {
      const m = str(input, ["message"]);
      if (m !== null)
        return (
          <Section label="Message" copy={m}>
            <pre className="code-plain">{m}</pre>
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

/** A / ⇧A / D while focus is inside the prompt. ⇧A is always "until stopped". */
function useDecisionKeys(handle: React.MutableRefObject<DecideHandle | null>, untilStopped: ApprovalDecision = "allow_always") {
  return (e: React.KeyboardEvent) => {
    if (e.metaKey || e.ctrlKey || e.altKey || isEditableTarget(e.target)) return;
    const k = e.key.toLowerCase();
    if (k === "a") {
      e.preventDefault();
      handle.current?.decide(e.shiftKey ? untilStopped : "allow");
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
  const onKeyDown = useDecisionKeys(handle, "allow_session");
  useAutoFocus(ref);
  const path = str(item.input, ["path", "file_path"]);
  const folder = path ? mountFor(path, persona) : null;
  const tool = toolDisplayName(item.name).tool;
  const what = tool === "edit_file" || tool === "write_file" ? `${tool === "edit_file" ? "Edit" : "Write"} ${path ? basename(path) : "file"}` : null;
  // "npm test *": the commands this line needs, with any arguments (none for shells and interpreters).
  const patterns = item.allowPatterns ?? [];
  const listed = patterns.map((p) => `“${p}”`).join(", ");
  const quoted = patterns.length > 2 ? `these ${patterns.length} commands` : patterns.map((p) => `“${p}”`).join(" and ");
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
      {item.uncoveredCommands && (
        <p className="small muted">
          No allow rule covers{" "}
          {item.uncoveredCommands.map((c, i) => (
            <span key={i}>
              {i > 0 && ", "}
              <span className="mono">{c}</span>
            </span>
          ))}
          ; every part of the line needs one.
        </p>
      )}
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
            Adds a temporary rule for{" "}
            {patterns.length ? `${listed}, with any arguments` : item.name === "bash" ? "this exact command" : <span className="mono">{item.name}</span>}.
            It ends when the agent is stopped or interrupted, or Swan restarts, and never edits the persona.
          </dd>
          {patterns.length > 0 && (
            <>
              <dt>Always allow</dt>
              <dd>Adds {listed} to this persona's allow rules.</dd>
            </>
          )}
        </dl>
      </Fold>
      <DecisionButtons
        item={item}
        sessionId={sessionId}
        handleRef={handle}
        labels={{
          allow: "Allow once",
          session: patterns.length ? `Allow ${quoted} until stopped` : allowScopeLabel(item),
          ...(patterns.length ? { always: `Always allow ${quoted}` } : {}),
        }}
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

/** A credential ask: an `ask` rule matched and the request waits. */
function CredentialPrompt({ item, sessionId }: { item: ToolItem; sessionId: string }) {
  const ref = useRef<HTMLDivElement>(null);
  const handle = useRef<DecideHandle | null>(null);
  const onKeyDown = useDecisionKeys(handle, "allow_session");
  useAutoFocus(ref);
  const credential = str(item.input, ["credential"]) ?? "";
  const operation = str(item.input, ["operation"]) ?? item.inputPreview;
  const rule = str(item.input, ["rule"]);
  return (
    <div
      ref={ref}
      id={`approval-${item.id}`}
      className="prompt"
      tabIndex={0}
      role="group"
      aria-label={`Use of ${credential}: decision needed`}
      onKeyDown={onKeyDown}
    >
      <p className="prompt-q">
        Allow <strong className="mono">{operation}</strong> with <span className="mono">{credential}</span>?{" "}
        <span className="muted">The request is paused{rule ? `; it matches the ask rule “${rule}”` : ""}.</span>
      </p>
      <DecisionButtons
        item={item}
        sessionId={sessionId}
        handleRef={handle}
        labels={{ allow: "Allow once", session: "Allow until stopped", always: "Always allow" }}
      />
      <p className="prompt-keys">
        “Always allow” makes {rule ? `“${rule}”` : "the rule"} an allow rule for this persona. <Kbd>A</Kbd> once · <Kbd>⇧A</Kbd> until
        stopped · <Kbd>D</Kbd> deny
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
  /** `session` adds an "allow_session" button between allow and always; without `always`, no "allow_always" button. */
  labels: { allow: string; session?: string; always?: string };
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
          <button type="submit" className="btn sm danger" disabled={busy !== null}>
            {busy === "deny" && <Spinner size={10} />}
            Deny
          </button>
          <button type="button" className="btn sm" onClick={() => setDenying(false)} disabled={busy !== null}>
            Cancel
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
      {labels.session && (
        <button type="button" className="btn sm" disabled={busy !== null} onClick={() => void decide("allow_session")}>
          {busy === "allow_session" && <Spinner size={10} />}
          {labels.session}
        </button>
      )}
      {labels.always && (
        <button type="button" className="btn sm" disabled={busy !== null} onClick={() => void decide("allow_always")}>
          {busy === "allow_always" && <Spinner size={10} />}
          {labels.always}
        </button>
      )}
      <button type="button" className="btn sm" disabled={busy !== null} onClick={() => setDenying(true)}>
        Deny
      </button>
    </div>
  );
}

// ---------- Sub-agents ----------

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
