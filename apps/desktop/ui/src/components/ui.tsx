import { useEffect, useId, useState, type ReactNode } from "react";
import { cls, copyText } from "../util";
import { IconCheck, IconChevronRight, IconCopy } from "./icons";

export const isMac = typeof navigator !== "undefined" && /Mac|iPhone|iPad/.test(navigator.platform || navigator.userAgent);
export const MOD = isMac ? "⌘" : "Ctrl";

export function Spinner({ size = 12, label }: { size?: number; label?: string }) {
  return (
    <span
      className="spinner"
      style={{ width: size, height: size }}
      role={label ? "status" : undefined}
      aria-label={label}
      aria-hidden={label ? undefined : true}
    />
  );
}

export function Kbd({ children }: { children: ReactNode }) {
  return <kbd className="kbd">{children}</kbd>;
}

export function CopyButton({ text, label = "Copy", showLabel = false }: { text: string; label?: string; showLabel?: boolean }) {
  const [done, setDone] = useState(false);
  useEffect(() => {
    if (!done) return;
    const t = window.setTimeout(() => setDone(false), 1200);
    return () => window.clearTimeout(t);
  }, [done]);
  return (
    <button
      type="button"
      className={cls(showLabel ? "btn sm" : "icon-btn sm")}
      aria-label={showLabel ? undefined : label}
      title={label}
      onClick={async () => setDone(await copyText(text))}
    >
      {done ? <IconCheck /> : <IconCopy />}
      {showLabel && <span>{done ? "Copied" : label}</span>}
    </button>
  );
}

/** A disclosure: a real button with aria-expanded and a region it controls. */
export function Fold({
  summary,
  children,
  open: openProp,
  onToggle,
  defaultOpen = false,
  className,
  headClassName,
}: {
  summary: ReactNode;
  children: ReactNode;
  open?: boolean;
  onToggle?: (open: boolean) => void;
  defaultOpen?: boolean;
  className?: string;
  headClassName?: string;
}) {
  const [inner, setInner] = useState(defaultOpen);
  const open = openProp ?? inner;
  const id = useId();
  return (
    <div className={cls("fold", open && "is-open", className)}>
      <button
        type="button"
        className={cls("fold-head", headClassName)}
        aria-expanded={open}
        aria-controls={id}
        onClick={() => {
          setInner(!open);
          onToggle?.(!open);
        }}
      >
        <IconChevronRight className="chev" />
        {summary}
      </button>
      {open && (
        <div className="fold-body" id={id}>
          {children}
        </div>
      )}
    </div>
  );
}

/** Empty / error states inside panes. */
export function Empty({ title, children, action }: { title: string; children?: ReactNode; action?: ReactNode }) {
  return (
    <div className="empty">
      <div className="empty-title">{title}</div>
      {children && <div className="empty-body">{children}</div>}
      {action && <div className="empty-action">{action}</div>}
    </div>
  );
}

/** Two or more segmented choices (tabs or a scope switch). */
export function Segmented<T extends string>({
  label,
  value,
  options,
  onChange,
  variant = "switch",
}: {
  label: string;
  value: T;
  options: Array<{ value: T; label: ReactNode; id?: string }>;
  onChange: (v: T) => void;
  variant?: "switch" | "tabs";
}) {
  const onKey = (e: React.KeyboardEvent) => {
    if (e.key !== "ArrowRight" && e.key !== "ArrowLeft") return;
    e.preventDefault();
    const i = options.findIndex((o) => o.value === value);
    const n = (i + (e.key === "ArrowRight" ? 1 : -1) + options.length) % options.length;
    onChange(options[n].value);
    const btn = (e.currentTarget as HTMLElement).querySelectorAll<HTMLButtonElement>("[role=tab]")[n];
    btn?.focus();
  };
  return (
    <div className={cls("seg", `seg-${variant}`)} role="tablist" aria-label={label} onKeyDown={onKey}>
      {options.map((o) => (
        <button
          key={o.value}
          type="button"
          role="tab"
          id={o.id}
          aria-selected={o.value === value}
          tabIndex={o.value === value ? 0 : -1}
          className={cls("seg-btn", o.value === value && "is-on")}
          onClick={() => onChange(o.value)}
        >
          {o.label}
        </button>
      ))}
    </div>
  );
}
