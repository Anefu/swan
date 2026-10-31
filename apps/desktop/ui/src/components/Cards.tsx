import type { ReactNode } from "react";
import { cls } from "../util";
import { DecisionsShortcut } from "./Composer";
import { IconChevronDown, IconChevronLeft, IconChevronRight, IconX } from "./icons";

/** A pane's title row: an optional way back, the title with its subject beside it, and an optional close. */
export function PaneHead({
  title,
  sub,
  onBack,
  backLabel = "Back",
  onClose,
  closeLabel = "Close",
  children,
}: {
  title: ReactNode;
  sub?: ReactNode;
  onBack?: () => void;
  backLabel?: string;
  onClose?: () => void;
  closeLabel?: string;
  children?: ReactNode;
}) {
  return (
    <div className="pane-head">
      {onBack && (
        <button type="button" className="icon-btn" aria-label={backLabel} onClick={onBack}>
          <IconChevronLeft size={18} />
        </button>
      )}
      <h2>
        {title}
        {sub && (
          <span className="pane-sub">
            <span className="sr-only">, </span>
            {sub}
          </span>
        )}
      </h2>
      {children}
      <DecisionsShortcut className="compact" />
      {onClose && (
        <button type="button" className="icon-btn" aria-label={closeLabel} onClick={onClose}>
          <IconX size={18} />
        </button>
      )}
    </div>
  );
}

/** After a screen changes inside the dock, put focus on its first header button (its way back or close). */
export function focusPaneHead() {
  window.setTimeout(() => document.querySelector<HTMLElement>(".dock .pane-head .icon-btn")?.focus(), 0);
}

/** A hairline card. `line` cards are a single row that opens something, so the whole card is the button. */
export function Card({ line, className, children }: { line?: boolean; className?: string; children: ReactNode }) {
  return <section className={cls("rcard", line && "rcard-line", className)}>{children}</section>;
}

/**
 * A card's title row. With `onOpen` it leads somewhere else (›); with `onToggle` it folds the card (˅ when open).
 * The summary sits at the right.
 */
export function CardHead({
  id,
  title,
  summary,
  open,
  onOpen,
  onToggle,
  controls,
  label,
}: {
  id?: string;
  title: ReactNode;
  summary?: ReactNode;
  open?: boolean;
  onOpen?: () => void;
  onToggle?: () => void;
  controls?: string;
  /** Spoken name when the visible text is not enough. */
  label?: string;
}) {
  const folds = !onOpen && !!onToggle;
  return (
    <button
      id={id}
      type="button"
      className="rcard-head"
      aria-expanded={folds ? !!open : undefined}
      aria-controls={folds ? controls : undefined}
      aria-label={label}
      onClick={onOpen ?? onToggle}
    >
      <span className="rcard-title">{title}</span>
      {folds && open ? <IconChevronDown size={14} /> : <IconChevronRight size={14} />}
      {summary !== undefined && <span className="rcard-sum">{summary}</span>}
    </button>
  );
}

/** A small meter for the end of a card row. */
export function MeterSm({ pct, label }: { pct: number; label: string }) {
  const v = Math.max(0, Math.min(100, Math.round(pct)));
  return (
    <span className="meter-sm" role="meter" aria-label={label} aria-valuemin={0} aria-valuemax={100} aria-valuenow={v}>
      <span style={{ width: `${v}%` }} />
    </span>
  );
}
