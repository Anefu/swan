import { memo, useEffect, useRef, useState, type ReactNode } from "react";
import type { ApprovalDecision, ChatItem } from "@ph/shared";
import { useStore } from "../store";
import { cls, fmtDuration, isRecord, prettyJson, TOOL_STATUS_LABEL, toolDisplayName } from "../util";
import { IconChevronRight, IconPlug, IconShield, IconSparkles, IconTerminal, IconWrench } from "./icons";
import { CopyButton, Spinner } from "./ui";

type ToolItem = Extract<ChatItem, { kind: "tool_call" }>;

export function SourceIcon({ source, name }: { source: ToolItem["source"]; name?: string }) {
  if (source === "mcp") return <IconPlug className="src-icon src-mcp" />;
  if (source === "skill") return <IconSparkles className="src-icon src-skill" />;
  if (name === "bash") return <IconTerminal className="src-icon src-builtin" />;
  return <IconWrench className="src-icon src-builtin" />;
}

export function ToolName({ name }: { name: string }) {
  const n = toolDisplayName(name);
  return (
    <span className="tool-name">
      {n.server && (
        <>
          <span className="tool-server">{n.server}</span>
          <span className="tool-sep">›</span>
        </>
      )}
      {n.tool}
    </span>
  );
}

export const ToolCard = memo(function ToolCard({ item, sessionId }: { item: ToolItem; sessionId: string }) {
  const pending = item.status === "pending_approval";
  const [open, setOpen] = useState(pending);
  useEffect(() => {
    if (pending) setOpen(true);
  }, [pending]);

  return (
    <div className={cls("tool", `tool-${item.status}`, item.isError && "tool-iserror")} id={`tool-${item.id}`}>
      <button type="button" className="tool-head" onClick={() => setOpen((o) => !o)} aria-expanded={open}>
        <IconChevronRight className={cls("chev", open && "open")} />
        <SourceIcon source={item.source} name={item.name} />
        <ToolName name={item.name} />
        <span className="tool-preview" title={item.inputPreview}>
          {item.inputPreview}
        </span>
        <span className="tool-meta">
          {item.durationMs !== undefined && <span className="tool-dur">{fmtDuration(item.durationMs)}</span>}
          <span className={cls("chip", `ts-${item.status}`)}>
            {item.status === "running" && <Spinner size={9} />}
            {TOOL_STATUS_LABEL[item.status]}
          </span>
        </span>
      </button>
      {pending && <ApprovalBar item={item} sessionId={sessionId} />}
      {open && (
        <div className="tool-body">
          <ToolInput name={item.name} input={item.input} />
          {item.denyReason && (
            <div className="tool-section">
              <div className="tool-section-label">Deny reason</div>
              <div className="tool-deny">{item.denyReason}</div>
            </div>
          )}
          {item.output !== undefined && (
            <Section label={item.isError ? "Error output" : "Output"} copy={item.output}>
              <pre className={cls("tool-output", item.isError && "is-error")}>{item.output || "(empty)"}</pre>
            </Section>
          )}
        </div>
      )}
    </div>
  );
});

function Section({ label, copy, children }: { label: string; copy?: string; children: ReactNode }) {
  return (
    <div className="tool-section">
      <div className="tool-section-label">
        <span>{label}</span>
        {copy !== undefined && copy !== "" && <CopyButton text={copy} label={`Copy ${label.toLowerCase()}`} />}
      </div>
      {children}
    </div>
  );
}

function pick(obj: Record<string, unknown>, keys: string[]): [string, string] | null {
  for (const k of keys) if (typeof obj[k] === "string") return [k, obj[k] as string];
  return null;
}

function rest(obj: Record<string, unknown>, omit: Array<string | undefined>): Record<string, unknown> | null {
  const out: Record<string, unknown> = {};
  let any = false;
  for (const [k, v] of Object.entries(obj)) {
    if (omit.includes(k)) continue;
    out[k] = v;
    any = true;
  }
  return any ? out : null;
}

function ToolInput({ name, input }: { name: string; input: unknown }) {
  const tool = toolDisplayName(name).tool;
  if (isRecord(input)) {
    if (tool === "bash") {
      const cmd = pick(input, ["command", "cmd", "script"]);
      if (cmd) {
        const other = rest(input, [cmd[0]]);
        return (
          <>
            <Section label="Command" copy={cmd[1]}>
              <pre className="code-block bash">
                <span className="prompt">$ </span>
                {cmd[1]}
              </pre>
            </Section>
            {other && <JsonSection label="Options" value={other} />}
          </>
        );
      }
    }
    if (tool === "edit_file") {
      const path = pick(input, ["path", "file_path", "filePath", "file"]);
      const oldS = pick(input, ["old_string", "old_str", "oldString", "old_text", "old"]);
      const newS = pick(input, ["new_string", "new_str", "newString", "new_text", "new"]);
      if (oldS || newS) {
        const other = rest(input, [path?.[0], oldS?.[0], newS?.[0]]);
        return (
          <>
            {path && <div className="tool-path mono">{path[1]}</div>}
            {oldS && (
              <Section label="Old" copy={oldS[1]}>
                <pre className="code-block diff-old">{oldS[1]}</pre>
              </Section>
            )}
            {newS && (
              <Section label="New" copy={newS[1]}>
                <pre className="code-block diff-new">{newS[1]}</pre>
              </Section>
            )}
            {other && <JsonSection label="Options" value={other} />}
          </>
        );
      }
    }
    if (tool === "write_file") {
      const path = pick(input, ["path", "file_path", "filePath", "file"]);
      const content = pick(input, ["content", "contents", "text", "data"]);
      if (content) {
        const other = rest(input, [path?.[0], content[0]]);
        return (
          <>
            {path && <div className="tool-path mono">{path[1]}</div>}
            <Section label="Content" copy={content[1]}>
              <pre className="code-block diff-new">{content[1]}</pre>
            </Section>
            {other && <JsonSection label="Options" value={other} />}
          </>
        );
      }
    }
  }
  return <JsonSection label="Input" value={input} />;
}

function JsonSection({ label, value }: { label: string; value: unknown }) {
  const text = prettyJson(value);
  return (
    <Section label={label} copy={text}>
      <pre className="code-block">{text || "(none)"}</pre>
    </Section>
  );
}

function ApprovalBar({ item, sessionId }: { item: ToolItem; sessionId: string }) {
  const { actions } = useStore();
  const [busy, setBusy] = useState<ApprovalDecision | null>(null);
  const [denying, setDenying] = useState(false);
  const [reason, setReason] = useState("");
  const reasonRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (denying) reasonRef.current?.focus();
  }, [denying]);

  const decide = async (decision: ApprovalDecision) => {
    setBusy(decision);
    const body = decision === "deny" && reason.trim() ? { decision, reason: reason.trim() } : { decision };
    const ok = await actions.approve(sessionId, item.id, body);
    if (!ok) setBusy(null);
  };

  return (
    <div className="approval" role="group" aria-label={`Approval for ${item.name}`}>
      <div className="approval-reason">
        <IconShield />
        <span>{item.approvalReason || "This tool call needs your approval."}</span>
      </div>
      {!denying ? (
        <div className="approval-actions">
          <button
            type="button"
            className="btn primary sm"
            data-approve-first
            disabled={busy !== null}
            onClick={() => void decide("allow")}
          >
            {busy === "allow" && <Spinner size={10} />}
            Allow once
          </button>
          <button
            type="button"
            className="btn sm"
            disabled={busy !== null}
            onClick={() => void decide("allow_always")}
            title="Allow now and stop asking for this tool"
          >
            {busy === "allow_always" && <Spinner size={10} />}
            Always allow
          </button>
          <button type="button" className="btn danger-ghost sm" disabled={busy !== null} onClick={() => setDenying(true)}>
            Deny…
          </button>
        </div>
      ) : (
        <form
          className="approval-deny"
          onSubmit={(e) => {
            e.preventDefault();
            void decide("deny");
          }}
        >
          <input
            ref={reasonRef}
            className="input sm"
            placeholder="Reason (optional, shown to the agent)"
            value={reason}
            onChange={(e) => setReason(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Escape") {
                e.stopPropagation();
                setDenying(false);
              }
            }}
            disabled={busy !== null}
          />
          <button type="submit" className="btn danger sm" disabled={busy !== null}>
            {busy === "deny" && <Spinner size={10} />}
            Deny
          </button>
          <button type="button" className="btn ghost sm" onClick={() => setDenying(false)} disabled={busy !== null}>
            Cancel
          </button>
        </form>
      )}
    </div>
  );
}
