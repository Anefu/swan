// Lines of the conversation: what the user and the agent said, and the agent's thinking.
import { memo, useEffect, useRef, useState } from "react";
import type { ChatItem } from "@ph/shared";
import { attachmentFileUrl } from "../../api";
import { attachmentPreviews } from "../../store";
import { cls, fmtBytes } from "../../util";
import { IconChevronRight, IconFile, IconRepeat } from "../icons";
import { Markdown } from "../Markdown";

/** A turn a schedule or watcher started: a line like a tool call, its prompt behind it. */
function TriggerLine({ item }: { item: Extract<ChatItem, { kind: "user" }> }) {
  const [open, setOpen] = useState(false);
  return (
    <div className="line-item" id={`item-${item.id}`}>
      <button type="button" className="line" aria-expanded={open} onClick={() => setOpen(!open)}>
        <span className="glyph" aria-hidden="true">
          <IconRepeat size={12} />
        </span>
        <span className="line-muted">Started by {item.trigger} · unattended</span>
        <IconChevronRight className="chev" size={14} />
      </button>
      {open && <div className="line-detail thinking-text">{item.text}</div>}
    </div>
  );
}

export function UserMessage({ item, sessionId }: { item: Extract<ChatItem, { kind: "user" }>; sessionId?: string }) {
  if (item.trigger) return <TriggerLine item={item} />;
  return <SentMessage item={item} sessionId={sessionId} />;
}

function SentMessage({ item, sessionId }: { item: Extract<ChatItem, { kind: "user" }>; sessionId?: string }) {
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
