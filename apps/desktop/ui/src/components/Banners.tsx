import { useEffect, useState } from "react";
import type { RuntimeStatus } from "@ph/shared";
import { useStore } from "../store";
import { cls, runtimeLevel, runtimeProblems } from "../util";
import { IconAlert, IconCheck, IconInfo, IconUnplug, IconWarning, IconX } from "./icons";
import { CopyButton, Spinner } from "./ui";

function useCountdown(target: number | null): number | null {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!target) return;
    const t = window.setInterval(() => setNow(Date.now()), 500);
    return () => window.clearInterval(t);
  }, [target]);
  return target ? Math.max(0, Math.ceil((target - now) / 1000)) : null;
}

/** One quiet line when live updates dropped. A reconnect never replays a tool or approval action. */
export function ConnectionLine() {
  const { state, actions } = useStore();
  const secs = useCountdown(state.ws.status === "closed" ? state.ws.nextRetryAt : null);
  if (!state.loaded || state.ws.status === "open") return null;
  if (state.ws.status === "connecting" && state.ws.attempt === 0) return null;
  return (
    <div className="line-banner warn" role="status">
      <IconUnplug size={16} />
      <span>
        <strong>{state.server === "unreachable" ? "Cannot reach the Swan server." : "Reconnecting."}</strong>{" "}
        {state.ws.status === "connecting" ? "Trying now…" : secs !== null ? `Next try in ${secs} s.` : ""} What you see may be out of
        date; nothing is replayed automatically.
      </span>
      <button type="button" className="btn sm" onClick={actions.retryConnection} disabled={state.ws.status === "connecting"}>
        Retry now
      </button>
    </div>
  );
}

type PodmanNeed = NonNullable<RuntimeStatus["needs"]>;

export function PodmanNeedText({ needs }: { needs: PodmanNeed }) {
  return needs === "install" ? (
    <>
      Podman is not installed. Install it with <code>brew install podman</code> or{" "}
      <a href="https://podman-desktop.io" target="_blank" rel="noopener noreferrer">
        Podman Desktop
      </a>
      , then check again.
    </>
  ) : (
    <>Podman has no machine yet. Setting one up downloads about 1 GB, once.</>
  );
}

export function PodmanActions({ needs }: { needs: PodmanNeed }) {
  const { actions } = useStore();
  return needs === "install" ? (
    <>
      <CopyButton text="brew install podman" label="Copy command" showLabel />
      <button type="button" className="btn sm" onClick={() => void actions.prepareRuntime("retry")}>
        Check again
      </button>
    </>
  ) : (
    <button type="button" className="btn sm primary" onClick={() => void actions.prepareRuntime("setup")}>
      Set up Podman
    </button>
  );
}

export function RuntimeLine() {
  const { state, actions } = useStore();
  const r = state.runtime;
  const level = runtimeLevel(r);
  if (!r || level === "ok" || level === "unknown") return null;
  if (r.needs && !r.busy) {
    // Before the first persona, the first-run card shows this as its first step.
    if (state.personas.length === 0) return null;
    return (
      <div className="line-banner warn" role="status">
        <IconWarning size={16} />
        <span>
          <PodmanNeedText needs={r.needs} />
        </span>
        <PodmanActions needs={r.needs} />
      </div>
    );
  }
  const text = r.busy
    ? `Sandbox: ${r.busy}…`
    : !r.available
      ? `${r.runtime || "Container runtime"} is not available.`
      : `Sandbox not ready: ${runtimeProblems(r).join(", ") || r.errors[0] || "unknown problem"}.`;
  return (
    <div className={cls("line-banner", r.busy ? "info" : "warn")} role="status">
      {r.busy ? <Spinner size={14} /> : <IconWarning size={16} />}
      <span>{text}</span>
      <button type="button" className="btn sm" onClick={actions.openSwanSettings}>
        Open Swan settings
      </button>
    </div>
  );
}

/** Full-screen states before the app can work at all. */
export function ServerGate() {
  const { state, actions } = useStore();
  const secs = useCountdown(state.ws.status === "closed" ? state.ws.nextRetryAt : null);
  let title: string;
  let body: React.ReactNode = null;
  if (state.server === "no-token") {
    title = "Swan server not running";
    body = (
      <>
        <p>
          The page has no API token yet. The server writes it to <code>~/.swan/api-token</code> when it starts (in development:{" "}
          <code>pnpm dev</code> at the repository root).
        </p>
        <p className="muted">
          <Spinner size={10} /> Waiting for the server. This page reloads by itself.
        </p>
        <button type="button" className="btn primary" onClick={() => window.location.reload()}>
          Reload now
        </button>
      </>
    );
  } else if (state.server === "unauthorized") {
    title = "API token rejected";
    body = (
      <>
        <p>The server did not accept this page's token. It probably restarted with a new one.</p>
        <button type="button" className="btn primary" onClick={() => window.location.reload()}>
          Reload
        </button>
      </>
    );
  } else if (state.server === "unreachable") {
    title = "Cannot reach the Swan server";
    body = (
      <>
        <p>Nothing answers on <code>/api</code>. Swan restarts its server if it stopped; Help → Show Server Log says why.</p>
        <p className="muted">{state.ws.status === "connecting" ? "Trying again…" : secs !== null ? `Next try in ${secs} s.` : ""}</p>
        <button type="button" className="btn primary" onClick={actions.retryConnection}>
          Retry now
        </button>
      </>
    );
  } else {
    title = "Connecting…";
  }
  return (
    <div className="gate">
      <div className="wordmark gate-mark">Swan</div>
      <div className="card gate-card" role="status">
        <h1>
          {state.server === "loading" && <Spinner size={14} />} {title}
        </h1>
        {body}
      </div>
    </div>
  );
}

export function Toasts() {
  const { state, actions } = useStore();
  return (
    <div className="toasts" aria-live="polite">
      {state.toasts.map((t) => (
        <ToastView key={t.id} {...t} onDismiss={actions.dismissToast} />
      ))}
    </div>
  );
}

function ToastView({
  id,
  kind,
  title,
  text,
  onDismiss,
}: {
  id: number;
  kind: "info" | "success" | "warn" | "error";
  title?: string;
  text: string;
  onDismiss: (id: number) => void;
}) {
  const [hover, setHover] = useState(false);
  useEffect(() => {
    if (hover) return;
    const t = window.setTimeout(() => onDismiss(id), kind === "error" ? 9000 : 5000);
    return () => window.clearTimeout(t);
  }, [hover, id, kind, onDismiss]);
  const Icon = kind === "success" ? IconCheck : kind === "error" ? IconAlert : kind === "warn" ? IconWarning : IconInfo;
  const prefix = kind === "error" ? "Error" : kind === "warn" ? "Warning" : null;
  return (
    <div
      className={cls("toast", `toast-${kind}`)}
      role={kind === "error" ? "alert" : "status"}
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => setHover(false)}
      onFocus={() => setHover(true)}
      onBlur={() => setHover(false)}
    >
      <Icon className="toast-icon" size={16} />
      <div className="toast-body">
        {(title ?? prefix) && <div className="toast-title">{title ?? prefix}</div>}
        <div className="toast-text">{text}</div>
      </div>
      <button type="button" className="icon-btn sm" aria-label="Dismiss" onClick={() => onDismiss(id)}>
        <IconX />
      </button>
    </div>
  );
}
