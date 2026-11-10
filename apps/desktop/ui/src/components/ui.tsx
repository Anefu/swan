import { useEffect, useId, useState, type ReactNode } from "react";
import { cls, copyText, errorMessage } from "../util";
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

/**
 * An inline confirmation for something that can't be undone: what will happen, then the action and
 * Cancel. A failure shows under the text unless `onError` takes it (a toast, say).
 */
export function Confirm({
  label,
  action,
  children,
  onConfirm,
  onCancel,
  onError,
}: {
  label: string;
  action: string;
  children: ReactNode;
  onConfirm: () => Promise<unknown>;
  onCancel: () => void;
  onError?: (e: unknown) => void;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const run = async () => {
    setBusy(true);
    setError(null);
    try {
      await onConfirm();
    } catch (e) {
      if (onError) onError(e);
      else setError(errorMessage(e));
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="inline-form" role="group" aria-label={label}>
      <p className="small">{children}</p>
      {error && <span className="field-error">{error}</span>}
      <div className="row gap end">
        <button type="button" className="btn sm danger" disabled={busy} onClick={() => void run()}>
          {busy && <Spinner size={10} />}
          {action}
        </button>
        <button type="button" className="btn sm" onClick={onCancel} disabled={busy}>
          Cancel
        </button>
      </div>
    </div>
  );
}

/** What a Field gives its control: its id, and the hint or error that describes it. */
export interface FieldProps {
  id: string;
  "aria-describedby"?: string;
  "aria-invalid"?: true;
}

/** A labelled control with an optional hint, or an error in its place. */
export function Field({
  label,
  hint,
  error,
  id: fixedId,
  children,
}: {
  label: string;
  hint?: string;
  error?: string;
  /** For a field that is focused from elsewhere. */
  id?: string;
  children: (f: FieldProps) => ReactNode;
}) {
  const autoId = useId();
  const id = fixedId ?? autoId;
  const note = error || hint ? `${id}-note` : undefined;
  return (
    <div className="field">
      <label className="field-label" htmlFor={id}>
        {label}
      </label>
      {children({ id, ...(note ? { "aria-describedby": note } : {}), ...(error ? { "aria-invalid": true } : {}) })}
      {hint && !error && (
        <span className="hint" id={note}>
          {hint}
        </span>
      )}
      {error && (
        <span className="field-error" id={note}>
          {error}
        </span>
      )}
    </div>
  );
}
