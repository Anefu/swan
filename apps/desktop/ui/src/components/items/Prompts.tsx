// Decisions the agent waits on: approvals, questions, network and credential requests.
import { useEffect, useRef, useState } from "react";
import type { ApprovalDecision, PersonaSummary } from "@ph/shared";
import { allowScopeLabel, consequence, mountFor, str, type ToolItem } from "../../receipts";
import { useStore } from "../../store";
import { basename, cls, isEditableTarget, toolDisplayName } from "../../util";
import { Fold, Kbd, Spinner } from "../ui";
import { ToolInput } from "./ToolInput";

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

/** The agent's question, inline: one click answers, or toggle several and Send. The message box takes any other answer. */
export function QuestionPrompt({ item, sessionId }: { item: ToolItem; sessionId: string }) {
  const { actions } = useStore();
  const input = item.input as { question?: string; options?: { label: string; description?: string }[]; multiple?: boolean };
  const options = input.options ?? [];
  const [selected, setSelected] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  const [described, setDescribed] = useState<string | null>(null);
  const ref = useRef<HTMLDivElement>(null);
  useAutoFocus(ref);

  const send = async (chosen: string[]) => {
    if (busy) return;
    setBusy(true);
    const ok = await actions.approve(sessionId, item.id, { decision: "allow", answer: { selected: chosen } });
    if (!ok) setBusy(false);
  };
  const choose = (label: string) => {
    if (input.multiple) setSelected((s) => (s.includes(label) ? s.filter((x) => x !== label) : [...s, label]));
    else void send([label]);
  };
  const onKeyDown = (e: React.KeyboardEvent) => {
    const o = options[Number(e.key) - 1];
    if (!o || isEditableTarget(e.target) || e.metaKey || e.ctrlKey || e.altKey) return;
    e.preventDefault();
    choose(o.label);
  };

  return (
    <div ref={ref} id={`approval-${item.id}`} className="question" tabIndex={0} role="group" aria-label={`Question: ${input.question ?? ""}`} onKeyDown={onKeyDown}>
      <p className="question-q">{input.question}</p>
      <div className="row gap wrap">
        {options.map((o) => {
          const on = selected.includes(o.label);
          return (
            <button
              key={o.label}
              type="button"
              className={cls("btn sm", on && "is-on")}
              aria-pressed={input.multiple ? on : undefined}
              aria-description={o.description}
              disabled={busy}
              onClick={() => choose(o.label)}
              onMouseEnter={() => setDescribed(o.description ?? null)}
              onMouseLeave={() => setDescribed(null)}
              onFocus={() => setDescribed(o.description ?? null)}
              onBlur={() => setDescribed(null)}
            >
              {o.label}
            </button>
          );
        })}
        {input.multiple && selected.length > 0 && (
          <button type="button" className="btn sm primary" disabled={busy} onClick={() => void send(selected)}>
            {busy && <Spinner size={10} />}
            Send
          </button>
        )}
        <button type="button" className="link-btn" disabled={busy} onClick={() => document.getElementById("composer-input")?.focus()}>
          Other
        </button>
        <button type="button" className="link-btn" disabled={busy} onClick={() => void send([])}>
          Skip
        </button>
      </div>
      {/* Room is kept for it only when there is one to show, so the options don't jump. */}
      {options.some((o) => o.description) && <p className="question-desc small muted">{described ?? "\u00a0"}</p>}
    </div>
  );
}

export function ApprovalPrompt({
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
      {item.reason && <p className="small">Why: {item.reason}</p>}
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
export function NetworkPrompt({ item, sessionId }: { item: ToolItem; sessionId: string }) {
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
      {item.reason && <p className="small">{item.reason}</p>}
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
export function CredentialPrompt({ item, sessionId }: { item: ToolItem; sessionId: string }) {
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
