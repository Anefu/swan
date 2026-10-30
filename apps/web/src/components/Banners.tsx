import { useEffect, useState } from "react";
import { useStore } from "../store";
import { cls, runtimeLevel, runtimeProblems } from "../util";
import { IconAlert, IconBox, IconCheck, IconInfo, IconKey, IconRefresh, IconUnplug, IconWarning, IconX } from "./icons";
import { Spinner } from "./ui";

function useCountdown(target: number | null): number | null {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!target) return;
    const t = window.setInterval(() => setNow(Date.now()), 500);
    return () => window.clearInterval(t);
  }, [target]);
  return target ? Math.max(0, Math.ceil((target - now) / 1000)) : null;
}

export function RuntimeBanner() {
  const { state, actions } = useStore();
  const [rebuilding, setRebuilding] = useState(false);
  const r = state.runtime;
  const level = runtimeLevel(r);
  if (!r || level === "ok" || level === "unknown") return null;

  const problems = runtimeProblems(r);
  const title = r.busy ? `${r.busy}…` : !r.available ? `${r.runtime || "Container runtime"} is not available` : "Sandbox is not ready";

  return (
    <div className={cls("banner", r.busy ? "banner-busy" : "banner-error")} role="status">
      <div className="banner-icon">{r.busy ? <Spinner size={14} /> : <IconBox size={16} />}</div>
      <div className="banner-main">
        <div className="banner-title">{title}</div>
        {(problems.length > 0 || r.errors.length > 0) && (
          <ul className="banner-list">
            {!r.busy && problems.map((p) => <li key={p}>{p}</li>)}
            {r.errors.map((e, i) => (
              <li key={`e${i}`} className="mono">
                {e}
              </li>
            ))}
          </ul>
        )}
        {r.busy && <div className="banner-sub">Sessions can start once this finishes.</div>}
      </div>
      <button
        type="button"
        className="btn sm"
        disabled={!!r.busy || rebuilding || !r.available}
        title={!r.available ? `${r.runtime} must be installed and running first` : undefined}
        onClick={async () => {
          setRebuilding(true);
          await actions.rebuildRuntime();
          setRebuilding(false);
        }}
      >
        {rebuilding ? <Spinner size={10} /> : <IconRefresh />} Rebuild sandbox image
      </button>
    </div>
  );
}

/** Shown once the app has loaded but live updates (WebSocket) dropped. */
export function ConnectionBanner() {
  const { state, actions } = useStore();
  const secs = useCountdown(state.ws.status === "closed" ? state.ws.nextRetryAt : null);
  if (!state.loaded) return null;
  if (state.ws.status === "open") return null;
  if (state.ws.status === "connecting" && state.ws.attempt === 0) return null;
  return (
    <div className="banner banner-warn" role="status">
      <div className="banner-icon">
        <IconUnplug size={16} />
      </div>
      <div className="banner-main">
        <div className="banner-title">
          {state.server === "unreachable" ? "Cannot reach the harness server" : "Live updates disconnected"}
        </div>
        <div className="banner-sub">
          {state.ws.status === "connecting" ? "Reconnecting…" : secs !== null ? `Retrying in ${secs}s` : "Retrying…"} Data shown may
          be out of date.
        </div>
      </div>
      <button type="button" className="btn sm" onClick={actions.retryConnection} disabled={state.ws.status === "connecting"}>
        Retry now
      </button>
    </div>
  );
}

/** Full-screen states before the app can work at all. */
export function ServerGate() {
  const { state, actions } = useStore();
  const secs = useCountdown(state.ws.status === "closed" ? state.ws.nextRetryAt : null);

  if (state.server === "no-token") {
    return (
      <div className="gate">
        <div className="gate-card">
          <IconKey size={22} />
          <h1>Server not running or API token missing</h1>
          <p>
            The UI could not find the API token. Start the harness server (for example <code>pnpm dev</code> at the repo
            root) so it writes <code>$PH_HOME/api-token</code> (default <code>~/.persona-harness/api-token</code>).
          </p>
          <p className="muted">
            <Spinner size={10} /> Waiting for the server — this page reloads automatically.
          </p>
          <button type="button" className="btn primary" onClick={() => window.location.reload()}>
            Reload now
          </button>
        </div>
      </div>
    );
  }
  if (state.server === "unauthorized") {
    return (
      <div className="gate">
        <div className="gate-card">
          <IconAlert size={22} />
          <h1>API token rejected</h1>
          <p>The server did not accept this page's token. It probably restarted with a new one. Reload to pick it up.</p>
          <button type="button" className="btn primary" onClick={() => window.location.reload()}>
            Reload
          </button>
        </div>
      </div>
    );
  }
  return (
    <div className="gate">
      <div className="gate-card">
        {state.server === "unreachable" ? <IconUnplug size={22} /> : <Spinner size={18} />}
        <h1>{state.server === "unreachable" ? "Cannot reach the harness server" : "Connecting…"}</h1>
        {state.server === "unreachable" && (
          <>
            <p>
              Nothing is answering on <code>/api</code>. Make sure the server is running (it listens on{" "}
              <code>127.0.0.1:4317</code>).
            </p>
            <p className="muted">
              {state.ws.status === "connecting" ? "Trying again…" : secs !== null ? `Retrying in ${secs}s…` : "Retrying…"}
            </p>
            <button type="button" className="btn primary" onClick={actions.retryConnection}>
              Retry now
            </button>
          </>
        )}
      </div>
    </div>
  );
}

export function Toasts() {
  const { state, actions } = useStore();
  return (
    <div className="toasts" aria-live="polite">
      {state.toasts.map((t) => (
        <ToastView key={t.id} id={t.id} kind={t.kind} title={t.title} text={t.text} icon={t.icon} onDismiss={actions.dismissToast} />
      ))}
    </div>
  );
}

function ToastView({
  id,
  kind,
  title,
  text,
  icon,
  onDismiss,
}: {
  id: number;
  kind: "info" | "success" | "warn" | "error";
  title?: string;
  text: string;
  icon?: "key";
  onDismiss: (id: number) => void;
}) {
  const [hover, setHover] = useState(false);
  useEffect(() => {
    if (hover) return;
    const t = window.setTimeout(() => onDismiss(id), kind === "error" ? 8000 : 4500);
    return () => window.clearTimeout(t);
  }, [hover, id, kind, onDismiss]);
  const Icon =
    icon === "key" ? IconKey : kind === "success" ? IconCheck : kind === "error" ? IconAlert : kind === "warn" ? IconWarning : IconInfo;
  return (
    <div
      className={cls("toast", `toast-${kind}`)}
      role={kind === "error" ? "alert" : "status"}
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => setHover(false)}
    >
      <Icon className="toast-icon" />
      <div className="toast-body">
        {title && <div className="toast-title">{title}</div>}
        <div className={cls("toast-text", icon === "key" && "mono")}>{text}</div>
      </div>
      <button type="button" className="icon-btn sm" aria-label="Dismiss" onClick={() => onDismiss(id)}>
        <IconX />
      </button>
    </div>
  );
}
