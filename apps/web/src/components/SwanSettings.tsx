import { Fragment, useState } from "react";
import type { ConnectionCredentialStatus, ConnectionStatus, ProviderStatus } from "@ph/shared";
import type { ConnectionAction } from "../api";
import { useStore } from "../store";
import { CONNECTION_STATE } from "../status";
import { cls, errorMessage, parseList, relTime, runtimeLevel, runtimeProblems, useNow } from "../util";
import { DeviceCodePanel, minutesLeft } from "./DeviceCode";
import { IconPlus } from "./icons";
import { Spinner } from "./ui";

export function SwanSettings() {
  return (
    <div className="pane-body">
      <Providers />
      <Connections />
      <Sandbox />
    </div>
  );
}

// ---------- Providers ----------

function Providers() {
  const { state } = useStore();
  return (
    <section className="swan-section">
      <h3>Model providers</h3>
      {state.providers.length === 0 && <p className="muted small">No providers configured.</p>}
      <ul className="plain-list">
        {state.providers.map((p) => (
          <ProviderRow key={p.name} p={p} />
        ))}
      </ul>
    </section>
  );
}

function providerLabel(p: ProviderStatus): string {
  if (p.type === "copilot") return "GitHub Copilot";
  if (p.name.toLowerCase() === p.type) return p.type === "openai" ? "OpenAI" : "Anthropic";
  return p.name.charAt(0).toUpperCase() + p.name.slice(1);
}

function ProviderRow({ p }: { p: ProviderStatus }) {
  const { actions } = useStore();
  const [editing, setEditing] = useState(false);
  const [confirm, setConfirm] = useState(false);
  const [busy, setBusy] = useState(false);
  const now = useNow(30_000);
  const secret = p.apiKeySecret;

  let connection: React.ReactNode;
  let connected = true;
  if (!p.keyRequired) connection = "No key needed";
  else if (p.keySource === "secrets")
    connection = (
      <>
        Connected{p.fingerprint && <> · key <span className="mono">{p.fingerprint}</span></>}
        {p.keyUpdatedAt && ` · changed ${agoWords(p.keyUpdatedAt, now)}`}
      </>
    );
  else if (p.keySource === "env") connection = "Connected via environment variable";
  else if (p.keySource === "login") connection = "Using GitHub CLI login";
  else {
    connection = "Not connected";
    connected = false;
  }
  const canEdit = !!secret && p.keyRequired && p.keySource !== "env" && p.keySource !== "login";

  return (
    <li className="prov-row">
      <div className="row gap wrap">
        <span className="grow">
          <strong>{providerLabel(p)}</strong>
          {p.type === "copilot" && <span className="muted"> · Preview</span>}
          {p.baseURL && <span className="muted small mono"> · {p.baseURL.replace(/^https?:\/\//, "")}</span>}
        </span>
      </div>
      <div className="row gap wrap small">
        <span className={cls("grow", connected ? "tone-muted" : "tone-attention")}>
          {connected && <span className="dot ok" aria-hidden="true" />} {connection}
        </span>
        {canEdit && !editing && !confirm && (
          <>
            <button type="button" className="link-btn" onClick={() => setEditing(true)}>
              {p.keySource === "secrets" ? "Replace key" : "Add key"}
            </button>
            {p.keySource === "secrets" && (
              <button type="button" className="link-btn" onClick={() => setConfirm(true)}>
                Disconnect
              </button>
            )}
          </>
        )}
      </div>
      {(!connected || p.type === "copilot") && p.detail && <p className="hint">{p.detail}</p>}
      {editing && secret && (
        <SecretForm
          label={`${providerLabel(p)} key (stored as ${secret})`}
          onCancel={() => setEditing(false)}
          onSave={async (value) => {
            await actions.setProviderKey(p.name, value);
            setEditing(false);
          }}
        />
      )}
      {confirm && secret && (
        <div className="inline-form" role="group" aria-label={`Disconnect ${providerLabel(p)}`}>
          <p className="small">
            Remove the {providerLabel(p)} key from Swan? Personas using this provider stop working until a key is added again.
          </p>
          <div className="row gap end">
            <button type="button" className="btn sm" onClick={() => setConfirm(false)} disabled={busy}>
              Cancel
            </button>
            <button
              type="button"
              className="btn sm danger"
              disabled={busy}
              onClick={async () => {
                setBusy(true);
                try {
                  await actions.removeProviderKey(p.name);
                  setConfirm(false);
                } catch (e) {
                  actions.reportError(e, "Could not disconnect");
                } finally {
                  setBusy(false);
                }
              }}
            >
              Disconnect
            </button>
          </div>
        </div>
      )}
    </li>
  );
}

function agoWords(iso: string, now: number): string {
  const r = relTime(iso, now);
  if (r === "now") return "just now";
  return /^\d/.test(r) ? `${r.replace(/m$/, " min").replace(/h$/, " h").replace(/d$/, " d")} ago` : `on ${r}`;
}

/** A value field. Values go to the server once and are never shown again. */
function SecretForm({
  label,
  onSave,
  onCancel,
  submitLabel = "Save",
}: {
  label: string;
  onSave: (value: string) => Promise<void>;
  onCancel: () => void;
  submitLabel?: string;
}) {
  const [value, setValue] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  return (
    <form
      className="inline-form"
      onSubmit={async (e) => {
        e.preventDefault();
        if (!value) return;
        setBusy(true);
        setError(null);
        try {
          await onSave(value);
        } catch (err) {
          setError(errorMessage(err));
          setBusy(false);
        }
      }}
    >
      <label className="field">
        <span className="field-label">{label}</span>
        <input
          className="input mono"
          type="password"
          autoComplete="off"
          value={value}
          autoFocus
          onChange={(e) => setValue(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Escape") {
              e.stopPropagation();
              onCancel();
            }
          }}
        />
      </label>
      {error && <span className="field-error">{error}</span>}
      <div className="row gap end">
        <button type="button" className="btn sm" onClick={onCancel} disabled={busy}>
          Cancel
        </button>
        <button type="submit" className="btn primary sm" disabled={busy || !value}>
          {busy && <Spinner size={10} />}
          {submitLabel}
        </button>
      </div>
    </form>
  );
}

// ---------- Connections ----------

function Connections() {
  const { state } = useStore();
  const now = useNow(5000);
  const [adding, setAdding] = useState(false);
  const flash = Object.entries(state.credentialFlash).sort((a, b) => b[1] - a[1])[0];
  const hasCommand = state.connections.some((c) => c.type === "command");
  return (
    <section className="swan-section">
      <div className="row gap">
        <h3 className="grow">Connections</h3>
        {!adding && (
          <button type="button" className="link-btn" onClick={() => setAdding(true)}>
            <IconPlus /> Add credential
          </button>
        )}
      </div>
      {state.migration && <MigrationNoteView />}
      <p className="hint">Where the agent's credentials come from. Values are never shown. Model keys live under Model providers.</p>
      {!hasCommand && <p className="hint">Command connections (sign-in with a code) are defined in config.yaml.</p>}
      {adding && <AddCredential onDone={() => setAdding(false)} />}
      {state.connections.length === 0 && !adding && <p className="muted small">No connections yet.</p>}
      <ul className="plain-list cred-list">
        {state.connections.map((c) => (
          <ConnectionRow key={c.name} c={c} />
        ))}
      </ul>
      {flash && now - flash[1] < 120_000 && (
        <p className="hint" role="status">
          <span className="mono">{flash[0]}</span> reloaded {Math.max(1, Math.round((now - flash[1]) / 1000))} s ago, no restart.
        </p>
      )}
    </section>
  );
}

function MigrationNoteView() {
  const { state, actions } = useStore();
  const note = state.migration;
  if (!note) return null;
  const lines: Array<[string, string[]]> = [
    ["Moved", note.moved],
    ["Personas updated", note.personas],
    ["Kept in secrets.yaml (no hosts)", note.kept],
    ["Problems", note.problems],
  ];
  return (
    <div className="inline-form" role="status">
      <p className="small">
        <strong>Credentials are now connections.</strong> Swan converted the earlier secrets format.
      </p>
      <dl className="facts small">
        {lines
          .filter(([, v]) => v.length > 0)
          .map(([k, v]) => (
            <Fragment key={k}>
              <dt>{k}</dt>
              <dd className={cls(k === "Moved" || k.startsWith("Kept") ? "mono" : undefined, k === "Problems" && "tone-attention")}>
                {k === "Personas updated" ? v.join(", ") : v.map((x) => <div key={x}>{x}</div>)}
              </dd>
            </Fragment>
          ))}
      </dl>
      <div className="row end">
        <button type="button" className="btn sm" onClick={() => void actions.dismissMigration()}>
          Dismiss
        </button>
      </div>
    </div>
  );
}

function inWords(iso: string, now: number): string {
  const m = minutesLeft(iso, now) ?? 0;
  if (m <= 0) return m === 0 ? "expires now" : `expired ${agoWords(iso, now)}`;
  return m < 90 ? `expires in ${m} min` : m < 48 * 60 ? `expires in ${Math.round(m / 60)} h` : `expires in ${Math.round(m / 1440)} d`;
}

function ConnectionRow({ c }: { c: ConnectionStatus }) {
  const now = useNow(30_000);
  const st = CONNECTION_STATE[c.state];
  const meta: string[] = [];
  if (c.expiresAt) meta.push(inWords(c.expiresAt, now));
  if (c.lastRenewedAt) meta.push(`renewed ${agoWords(c.lastRenewedAt, now)}`);
  if (c.usedBy.length) meta.push(`used by ${c.usedBy.join(", ")}`);
  const metaText = meta.join(" · ");
  return (
    <li className="prov-row cred-row">
      <div className="row gap wrap">
        <span className="grow">
          <strong className="mono">{c.name}</strong> <span className="muted small">· {c.type}</span>
        </span>
        <span className={cls("status-text small", `tone-${st.tone === "ok" ? "muted" : st.tone}`)}>
          {c.state === "signing_in" && <Spinner size={10} />}
          {c.state === "ready" && <span className="dot ok" aria-hidden="true" />}
          {st.label}
        </span>
      </div>
      {metaText && <div className="small muted">{metaText.charAt(0).toUpperCase() + metaText.slice(1)}</div>}
      {c.message && <p className="hint">{c.message}</p>}
      {c.credentials.length > 0 && (
        <ul className="plain-list">
          {c.credentials.map((cr) => (
            <CredentialRow key={cr.name} conn={c} c={cr} />
          ))}
        </ul>
      )}
      {c.type === "command" && c.credentials.length === 0 && c.state !== "ready" && (
        <p className="small muted">Credentials appear here after a sign-in.</p>
      )}
      {c.type === "command" && <CommandControls c={c} />}
    </li>
  );
}

function credentialMeta(c: ConnectionCredentialStatus): string {
  const parts: string[] = [c.kind];
  if (c.hosts.length) parts.push(c.hosts.join(", "));
  if (c.env && c.env !== c.name) parts.push(`$${c.env}`);
  return parts.join(" · ");
}

function CredentialRow({ conn, c }: { conn: ConnectionStatus; c: ConnectionCredentialStatus }) {
  const { actions } = useStore();
  const [mode, setMode] = useState<null | "replace" | "remove">(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const editable = conn.type === "static";
  const last = conn.credentials.length === 1;
  return (
    <li className="cred-row">
      <div className="row gap wrap small">
        <span className="grow">
          <span className="mono">{c.name}</span> <span className="muted">· {credentialMeta(c)}</span>
          {c.present && c.fingerprint && (
            <span className="muted mono" title="First 8 hex characters of the value's SHA-256">
              {" "}
              · {c.fingerprint}
            </span>
          )}
        </span>
        {!c.present && <span className="status-text tone-attention small">{editable ? "Missing" : "Not usable"}</span>}
        {editable && mode === null && (
          <>
            <button type="button" className="link-btn" onClick={() => setMode("replace")} aria-label={`${c.present ? "Replace value of" : "Set value of"} ${c.ref}`}>
              {c.present ? "Replace value" : "Set value"}
            </button>
            <button type="button" className="link-btn" onClick={() => setMode("remove")} aria-label={`Remove ${c.ref}`}>
              Remove
            </button>
          </>
        )}
      </div>
      {mode === "replace" && (
        <SecretForm
          label={c.present ? `New value for ${c.ref}` : `Value for ${c.ref}`}
          submitLabel={c.present ? "Replace" : "Save"}
          onCancel={() => setMode(null)}
          onSave={async (value) => {
            await actions.putCredential(conn.name, c.name, { value });
            setMode(null);
          }}
        />
      )}
      {mode === "remove" && (
        <div className="inline-form" role="group" aria-label={`Remove ${c.ref}`}>
          <p className="small">
            Remove <span className="mono">{c.ref}</span> and its value from Swan?
            {c.usedBy.length > 0 ? ` ${c.usedBy.join(", ")} lose access on the next request.` : " No persona uses it."}
            {last && ` The ${conn.name} connection goes with it.`}
          </p>
          {error && <span className="field-error">{error}</span>}
          <div className="row gap end">
            <button type="button" className="btn sm" onClick={() => setMode(null)} disabled={busy}>
              Cancel
            </button>
            <button
              type="button"
              className="btn sm danger"
              disabled={busy}
              onClick={async () => {
                setBusy(true);
                setError(null);
                try {
                  await actions.deleteCredential(conn.name, c.name);
                } catch (e) {
                  setError(errorMessage(e));
                  setBusy(false);
                }
              }}
            >
              {busy && <Spinner size={10} />}
              Remove
            </button>
          </div>
        </div>
      )}
    </li>
  );
}

function CommandControls({ c }: { c: ConnectionStatus }) {
  const { actions } = useStore();
  const [busy, setBusy] = useState<ConnectionAction | null>(null);
  const run = async (a: ConnectionAction) => {
    setBusy(a);
    await actions.connectionAction(c.name, a);
    setBusy(null);
  };
  if (c.signIn || c.state === "signing_in") {
    return <DeviceCodePanel code={c.signIn} busy={busy === "cancel"} onCancel={() => void run("cancel")} />;
  }
  const signedIn = c.state === "ready" || c.credentials.length > 0;
  return (
    <div className="row gap wrap">
      {c.state !== "ready" && (
        <button type="button" className="btn sm" disabled={!!busy} onClick={() => void run("login")}>
          {busy === "login" && <Spinner size={10} />}
          Sign in
        </button>
      )}
      {c.state === "ready" && (
        <button type="button" className="btn sm" disabled={!!busy} onClick={() => void run("renew")}>
          {busy === "renew" && <Spinner size={10} />}
          Renew now
        </button>
      )}
      {signedIn && (
        <button type="button" className="btn sm" disabled={!!busy} onClick={() => void run("logout")}>
          {busy === "logout" && <Spinner size={10} />}
          Sign out
        </button>
      )}
    </div>
  );
}

const CONN_RE = /^[a-z0-9-]{1,32}$/;
const CRED_RE = /^[A-Za-z0-9_-]{1,64}$/;
const ENV_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;
const HEADER_RE = /^[A-Za-z0-9-]+$/;

function AddCredential({ onDone }: { onDone: () => void }) {
  const { state, actions } = useStore();
  const statics = state.connections.filter((c) => c.type === "static");
  const [conn, setConn] = useState(statics.length === 1 ? statics[0].name : "");
  const [name, setName] = useState("");
  const [value, setValue] = useState("");
  const [hosts, setHosts] = useState("");
  const [inject, setInject] = useState(false);
  const [header, setHeader] = useState("Authorization");
  const [format, setFormat] = useState("Bearer {value}");
  const [env, setEnv] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const existing = state.connections.find((c) => c.name === conn);
  const connError = !conn
    ? null
    : !CONN_RE.test(conn)
      ? "Use lowercase letters, digits and dashes."
      : existing?.type === "command"
        ? `${conn} is a command connection; its credentials come from its wrapper.`
        : null;
  const nameError = !name
    ? null
    : !CRED_RE.test(name)
      ? "Use letters, digits, _ and -."
      : existing?.credentials.some((c) => c.name === name)
        ? "Already exists; use Replace value."
        : null;
  const envError = env && !ENV_RE.test(env) ? "Use letters, digits and _, not starting with a digit." : null;
  const injectError = inject && (!HEADER_RE.test(header) || !format.includes("{value}")) ? "Use a header name, and a format that contains {value}." : null;
  const hostList = parseList(hosts);
  const ready = !!conn && !!name && !!value && hostList.length > 0 && !connError && !nameError && !envError && !injectError;
  const listId = "static-connections";
  return (
    <form
      className="inline-form"
      onSubmit={async (e) => {
        e.preventDefault();
        if (!ready) return;
        setBusy(true);
        setError(null);
        try {
          await actions.putCredential(conn, name, {
            value,
            hosts: hostList,
            ...(inject ? { inject: { header, format } } : {}),
            ...(env ? { env } : {}),
          });
          onDone();
        } catch (err) {
          setError(errorMessage(err));
          setBusy(false);
        }
      }}
    >
      <div className="row gap wrap">
        <label className="field grow">
          <span className="field-label">Connection</span>
          <input
            className="input mono"
            value={conn}
            autoFocus
            placeholder="github"
            list={listId}
            spellCheck={false}
            aria-invalid={!!connError}
            onChange={(e) => setConn(e.target.value.toLowerCase().replace(/[\s_]+/g, "-"))}
          />
          <datalist id={listId}>
            {statics.map((c) => (
              <option key={c.name} value={c.name} />
            ))}
          </datalist>
        </label>
        <label className="field grow">
          <span className="field-label">Credential name</span>
          <input
            className="input mono"
            value={name}
            placeholder="GITHUB_TOKEN"
            spellCheck={false}
            aria-invalid={!!nameError}
            onChange={(e) => setName(e.target.value.replace(/\s+/g, "_"))}
          />
        </label>
      </div>
      {connError && <span className="field-error">{connError}</span>}
      {nameError && <span className="field-error">{nameError}</span>}
      <label className="field">
        <span className="field-label">Value</span>
        <input className="input mono" type="password" autoComplete="off" value={value} onChange={(e) => setValue(e.target.value)} />
      </label>
      <label className="field">
        <span className="field-label">Hosts it may be sent to (comma separated)</span>
        <input className="input mono" value={hosts} placeholder="api.github.com" spellCheck={false} onChange={(e) => setHosts(e.target.value)} />
      </label>
      <label className="field">
        <span className="field-label">Sandbox variable (optional)</span>
        <input
          className="input mono"
          value={env}
          placeholder={name || "GITHUB_TOKEN"}
          spellCheck={false}
          aria-invalid={!!envError}
          onChange={(e) => setEnv(e.target.value)}
        />
        {envError ? <span className="field-error">{envError}</span> : <span className="hint">Holds a placeholder; defaults to the credential name.</span>}
      </label>
      <label className="check-row">
        <input type="checkbox" checked={inject} onChange={(e) => setInject(e.target.checked)} />
        <span>Proxy adds an auth header on those hosts</span>
      </label>
      {inject && (
        <div className="row gap">
          <label className="field grow">
            <span className="field-label">Header</span>
            <input className="input mono" value={header} onChange={(e) => setHeader(e.target.value)} />
          </label>
          <label className="field grow">
            <span className="field-label">Format</span>
            <input className="input mono" value={format} onChange={(e) => setFormat(e.target.value)} />
          </label>
        </div>
      )}
      {injectError && <span className="field-error">{injectError}</span>}
      {error && <span className="field-error">{error}</span>}
      <div className="row gap end">
        <button type="button" className="btn sm" onClick={onDone} disabled={busy}>
          Cancel
        </button>
        <button type="submit" className="btn primary sm" disabled={busy || !ready}>
          {busy && <Spinner size={10} />}
          Add credential
        </button>
      </div>
    </form>
  );
}

// ---------- Sandbox ----------

function Sandbox() {
  const { state, actions } = useStore();
  const [busy, setBusy] = useState(false);
  const r = state.runtime;
  const level = runtimeLevel(r);
  const label = !r ? "Unknown" : r.busy ? `${r.busy}…` : level === "ok" ? "Ready" : "Not ready";
  return (
    <section className="swan-section">
      <h3>Sandbox</h3>
      <div className="row gap">
        <span className="grow">
          {r ? `${r.runtime[0]?.toUpperCase() ?? ""}${r.runtime.slice(1)}${r.version ? ` ${r.version}` : ""}` : "Runtime"}
        </span>
        <span className={cls("status-text", level === "error" ? "tone-attention" : "tone-muted")}>
          {r?.busy && <Spinner size={10} />}
          {label}
        </span>
      </div>
      {r?.imageTag && <p className="small muted mono">{r.imageTag}</p>}
      {r && level === "error" && (
        <ul className="small plain-list">
          {[...runtimeProblems(r), ...r.errors].map((p) => (
            <li key={p}>{p}</li>
          ))}
        </ul>
      )}
      <div>
        <button
          type="button"
          className="btn sm"
          disabled={!r || !!r.busy || !r.available || busy}
          onClick={async () => {
            setBusy(true);
            await actions.rebuildRuntime();
            setBusy(false);
          }}
        >
          {busy && <Spinner size={10} />}
          Rebuild sandbox image
        </button>
      </div>
    </section>
  );
}
