import { useEffect, useId, useMemo, useRef, useState, type KeyboardEvent, type ReactNode } from "react";
import { createPortal } from "react-dom";
import type { PermissionMode, SessionStatus } from "@ph/shared";
import { cls, copyText, SESSION_STATUS_LABEL } from "../util";
import { IconCheck, IconCopy, IconX } from "./icons";

export function Spinner({ size = 12 }: { size?: number }) {
  return <span className="spinner" style={{ width: size, height: size }} aria-hidden="true" />;
}

export function StatusDot({ status, title }: { status: SessionStatus; title?: string }) {
  return (
    <span
      className={cls("dot", `dot-${status}`)}
      title={title ?? SESSION_STATUS_LABEL[status]}
      aria-label={SESSION_STATUS_LABEL[status]}
      role="img"
    />
  );
}

export function PermissionChip({ mode }: { mode: PermissionMode }) {
  return <span className={cls("chip", `perm-${mode}`)}>{mode}</span>;
}

export function CopyButton({ text, label = "Copy", className }: { text: string; label?: string; className?: string }) {
  const [done, setDone] = useState(false);
  useEffect(() => {
    if (!done) return;
    const t = window.setTimeout(() => setDone(false), 1200);
    return () => window.clearTimeout(t);
  }, [done]);
  return (
    <button
      type="button"
      className={cls("icon-btn", "sm", className)}
      title={label}
      aria-label={label}
      onClick={async (e) => {
        e.stopPropagation();
        if (await copyText(text)) setDone(true);
      }}
    >
      {done ? <IconCheck /> : <IconCopy />}
    </button>
  );
}

const FOCUSABLE =
  'a[href], button:not([disabled]), input:not([disabled]), textarea:not([disabled]), select:not([disabled]), [tabindex]:not([tabindex="-1"])';

export function Modal({
  title,
  onClose,
  children,
  footer,
  size = "md",
}: {
  title: ReactNode;
  onClose: () => void;
  children: ReactNode;
  footer?: ReactNode;
  size?: "sm" | "md" | "lg" | "xl";
}) {
  const ref = useRef<HTMLDivElement>(null);
  const titleId = useId();
  const closeRef = useRef(onClose);
  closeRef.current = onClose;

  useEffect(() => {
    const prev = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const root = ref.current;
    const target =
      root?.querySelector<HTMLElement>("[data-autofocus]") ??
      root?.querySelector<HTMLElement>(".modal-body input, .modal-body textarea, .modal-body select") ??
      root?.querySelector<HTMLElement>(FOCUSABLE);
    target?.focus();
    return () => prev?.focus();
  }, []);

  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    if (e.key === "Escape") {
      e.stopPropagation();
      closeRef.current();
      return;
    }
    if (e.key === "Tab" && ref.current) {
      const els = Array.from(ref.current.querySelectorAll<HTMLElement>(FOCUSABLE)).filter((el) => el.offsetParent !== null);
      if (els.length === 0) return;
      const first = els[0];
      const last = els[els.length - 1];
      if (e.shiftKey && document.activeElement === first) {
        e.preventDefault();
        last.focus();
      } else if (!e.shiftKey && document.activeElement === last) {
        e.preventDefault();
        first.focus();
      }
    }
  };

  return createPortal(
    <div
      className="modal-backdrop"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) closeRef.current();
      }}
    >
      <div
        ref={ref}
        className={cls("modal", `modal-${size}`)}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        onKeyDown={onKeyDown}
      >
        <div className="modal-head">
          <h2 id={titleId}>{title}</h2>
          <button type="button" className="icon-btn" aria-label="Close" onClick={() => closeRef.current()}>
            <IconX />
          </button>
        </div>
        <div className="modal-body">{children}</div>
        {footer && <div className="modal-foot">{footer}</div>}
      </div>
    </div>,
    document.body,
  );
}

export function ConfirmDialog({
  title,
  children,
  confirmLabel,
  danger,
  onConfirm,
  onCancel,
}: {
  title: string;
  children: ReactNode;
  confirmLabel: string;
  danger?: boolean;
  onConfirm: () => Promise<unknown> | void;
  onCancel: () => void;
}) {
  const [busy, setBusy] = useState(false);
  return (
    <Modal
      title={title}
      onClose={onCancel}
      size="sm"
      footer={
        <>
          <button type="button" className="btn" onClick={onCancel} data-autofocus={danger ? true : undefined}>
            Cancel
          </button>
          <button
            type="button"
            className={cls("btn", danger ? "danger" : "primary")}
            disabled={busy}
            data-autofocus={danger ? undefined : true}
            onClick={async () => {
              setBusy(true);
              try {
                await onConfirm();
              } finally {
                setBusy(false);
              }
            }}
          >
            {busy && <Spinner />}
            {confirmLabel}
          </button>
        </>
      }
    >
      {children}
    </Modal>
  );
}

/** Monospace textarea with a line-number gutter. Tab inserts two spaces; Cmd/Ctrl+S calls onSave. */
export function CodeEditor({
  value,
  onChange,
  onSave,
  errorLines,
  ariaLabel,
  readOnly,
  className,
}: {
  value: string;
  onChange: (v: string) => void;
  onSave?: () => void;
  errorLines?: Set<number>;
  ariaLabel: string;
  readOnly?: boolean;
  className?: string;
}) {
  const taRef = useRef<HTMLTextAreaElement>(null);
  const gutterRef = useRef<HTMLDivElement>(null);
  const lineCount = useMemo(() => value.split("\n").length, [value]);

  const onKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "s") {
      e.preventDefault();
      onSave?.();
      return;
    }
    if (e.key === "Tab" && !e.shiftKey && !e.metaKey && !e.ctrlKey && !e.altKey && !readOnly) {
      e.preventDefault();
      const ta = e.currentTarget;
      // execCommand keeps the native undo stack; fall back to setRangeText.
      if (!document.execCommand("insertText", false, "  ")) {
        ta.setRangeText("  ", ta.selectionStart, ta.selectionEnd, "end");
        onChange(ta.value);
      }
      return;
    }
    if (e.key === "Escape") {
      // First Escape leaves the editor (so Tab navigation works again); a second one closes dialogs.
      e.stopPropagation();
      e.currentTarget.blur();
    }
  };

  return (
    <div className={cls("code-editor", className)}>
      <div className="code-gutter" ref={gutterRef} aria-hidden="true">
        {Array.from({ length: lineCount }, (_, i) => (
          <div key={i} className={errorLines?.has(i + 1) ? "err" : undefined}>
            {i + 1}
          </div>
        ))}
      </div>
      <textarea
        ref={taRef}
        className="code-textarea"
        value={value}
        readOnly={readOnly}
        aria-label={ariaLabel}
        spellCheck={false}
        autoCapitalize="off"
        autoComplete="off"
        autoCorrect="off"
        wrap="off"
        onChange={(e) => onChange(e.target.value)}
        onKeyDown={onKeyDown}
        onScroll={(e) => {
          if (gutterRef.current) gutterRef.current.scrollTop = e.currentTarget.scrollTop;
        }}
      />
    </div>
  );
}

export function EmptyState({
  icon,
  title,
  children,
  actions,
}: {
  icon?: ReactNode;
  title: string;
  children?: ReactNode;
  actions?: ReactNode;
}) {
  return (
    <div className="empty">
      {icon && <div className="empty-icon">{icon}</div>}
      <h3>{title}</h3>
      {children && <div className="empty-body">{children}</div>}
      {actions && <div className="empty-actions">{actions}</div>}
    </div>
  );
}

export function Kbd({ children }: { children: ReactNode }) {
  return <kbd className="kbd">{children}</kbd>;
}

export const isMac = typeof navigator !== "undefined" && /Mac|iPhone|iPad/.test(navigator.platform || navigator.userAgent);
export const MOD = isMac ? "⌘" : "Ctrl";
