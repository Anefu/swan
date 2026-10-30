import type { PersonaSummary } from "@ph/shared";
import { sessionsForPersona, useStore } from "../store";
import { cls, fullTime, relTime, runtimeLevel, runtimeProblems, SESSION_STATUS_LABEL, useNow } from "../util";
import { IconBox, IconKey, IconPlus, IconWarning } from "./icons";
import { StatusDot } from "./ui";

export function Sidebar() {
  const { state, actions } = useStore();
  const missing = state.credentials.filter((c) => !c.present && c.usedBy.length > 0).length;

  return (
    <aside className="sidebar" aria-label="Personas and sessions">
      <div className="sidebar-head">
        <div className="brand">
          <span className="brand-mark" aria-hidden="true">
            P
          </span>
          persona-harness
        </div>
        <ConnectionPill />
      </div>

      <div className="sidebar-section-head">
        <span>Personas</span>
        <button
          type="button"
          className="icon-btn sm"
          title="New persona"
          aria-label="New persona"
          onClick={() => actions.openDialog({ kind: "new-persona" })}
        >
          <IconPlus />
        </button>
      </div>

      <nav className="sidebar-scroll">
        {state.personas.map((p) => (
          <PersonaEntry key={p.id} persona={p} />
        ))}
        {state.loaded && state.personas.length === 0 && (
          <div className="sidebar-empty">
            No personas yet.
            <button type="button" className="link-btn" onClick={() => actions.openDialog({ kind: "new-persona" })}>
              Create one
            </button>
          </div>
        )}
      </nav>

      <div className="sidebar-foot">
        <button
          type="button"
          className={cls("nav-item", state.view === "credentials" && "active")}
          onClick={() => actions.showView(state.view === "credentials" ? "chat" : "credentials")}
          aria-pressed={state.view === "credentials"}
        >
          <IconKey />
          <span>Credentials</span>
          {missing > 0 && (
            <span className="badge warn" title={`${missing} declared credential(s) have no value`}>
              {missing} missing
            </span>
          )}
        </button>
        <RuntimeIndicator />
        <ProviderHint />
      </div>
    </aside>
  );
}

function PersonaEntry({ persona }: { persona: PersonaSummary }) {
  const { state, actions } = useStore();
  const now = useNow(30_000);
  const selected = state.selectedPersonaId === persona.id;
  const warn = persona.errors.length > 0 || persona.missingCredentials.length > 0;
  const warnText = [
    ...persona.errors.map((e) => `Error: ${e}`),
    ...(persona.missingCredentials.length ? [`Missing credentials: ${persona.missingCredentials.join(", ")}`] : []),
  ].join("\n");
  const sessions = selected ? sessionsForPersona(state, persona.id) : [];

  return (
    <div className={cls("persona", selected && "selected")}>
      <button
        type="button"
        className={cls("persona-row", selected && state.view === "chat" && !state.selectedSessionId && "active")}
        onClick={() => {
          if (selected) actions.selectSession(null);
          actions.selectPersona(persona.id);
        }}
        aria-expanded={selected}
        title={persona.description || persona.name}
      >
        <span className="persona-text">
          <span className="persona-name">{persona.name || persona.id}</span>
          {persona.description && <span className="persona-desc">{persona.description}</span>}
        </span>
        {warn && (
          <span
            className={cls("warn-badge", persona.errors.length > 0 && "error")}
            title={warnText}
            aria-label={persona.errors.length > 0 ? "Persona has errors" : "Persona is missing credentials"}
          >
            <IconWarning size={12} />
          </span>
        )}
      </button>

      {selected && (
        <ul className="session-list" role="list">
          <li>
            <button
              type="button"
              className="session-new"
              disabled={persona.errors.length > 0}
              title={persona.errors.length > 0 ? "Fix the persona errors before starting a session" : "New session (Alt+N)"}
              onClick={() => void actions.createSession(persona.id)}
            >
              <IconPlus size={12} /> New session
            </button>
          </li>
          {sessions.map((s) => (
            <li key={s.id}>
              <button
                type="button"
                className={cls("session-row", state.selectedSessionId === s.id && state.view === "chat" && "active")}
                onClick={() => actions.selectSession(s.id)}
                title={`${s.title || "Untitled"}\n${SESSION_STATUS_LABEL[s.status]}${s.statusDetail ? ` — ${s.statusDetail}` : ""}\nUpdated ${fullTime(s.updatedAt)}`}
                aria-current={state.selectedSessionId === s.id ? "page" : undefined}
              >
                <StatusDot status={s.status} />
                <span className="session-title">{s.title || "Untitled session"}</span>
                <span className="session-time">{relTime(s.updatedAt, now)}</span>
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

function ConnectionPill() {
  const { state } = useStore();
  const { status } = state.ws;
  const label = status === "open" ? "Live" : status === "connecting" ? "Connecting" : "Offline";
  return (
    <span className={cls("conn-pill", `conn-${status}`)} title={`Live updates: ${label.toLowerCase()}`}>
      <span className="conn-dot" />
      {label}
    </span>
  );
}

function RuntimeIndicator() {
  const { state, actions } = useStore();
  const r = state.runtime;
  const level = runtimeLevel(r);
  let text = "Sandbox status unknown";
  let detail = "";
  if (r) {
    if (level === "busy") text = r.busy ?? "Working";
    else if (level === "ok") text = "Sandbox ready";
    else text = r.errors[0] ?? runtimeProblems(r)[0] ?? "Sandbox not ready";
    detail = [
      `${r.runtime}${r.version ? ` ${r.version}` : ""}: ${r.available ? "available" : "unavailable"}`,
      `image: ${r.imageReady ? (r.imageTag ?? "ready") : "missing"}`,
      `network: ${r.networkReady ? "ready" : "not ready"}`,
      `egress relay: ${r.relayRunning ? `running (proxy :${r.proxyPort})` : "stopped"}`,
      ...r.errors.map((e) => `error: ${e}`),
    ].join("\n");
  }
  return (
    <button
      type="button"
      className={cls("runtime-ind", `rt-${level}`)}
      title={detail || text}
      onClick={() => actions.toast("info", detail || text, { title: "Sandbox runtime" })}
    >
      <IconBox />
      <span className={cls("rt-dot", `rt-dot-${level}`)} />
      <span className="ellipsis">{text}</span>
    </button>
  );
}

function ProviderHint() {
  const { state } = useStore();
  if (state.providers.length === 0) return null;
  return (
    <div className="provider-hint" aria-label="Model providers">
      {state.providers.map((p) => (
        <span
          key={p.name}
          className={cls("provider", p.ready ? "ready" : "not-ready")}
          title={
            p.ready
              ? `${p.name} (${p.type}) ready${p.baseURL ? ` — ${p.baseURL}` : ""}`
              : `${p.name} (${p.type}) not ready${p.apiKeySecret ? ` — set credential ${p.apiKeySecret}` : ""}`
          }
        >
          <span className="provider-dot" />
          {p.name}
        </span>
      ))}
    </div>
  );
}
