// Notices and Swan's own receipts, in one line style.
import { useState } from "react";
import type { ChatItem } from "@ph/shared";
import { cls } from "../../util";
import { IconChevronRight } from "../icons";
import { Spinner } from "../ui";

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
