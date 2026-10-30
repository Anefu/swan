import { useState } from "react";
import type { CredentialStatus, ProviderStatus } from "@ph/shared";
import { useStore } from "../store";
import { providerKeyNames } from "../status";
import { cls, errorMessage, parseList, relTime, runtimeLevel, runtimeProblems, useNow } from "../util";
import { IconPlus } from "./icons";
import { Spinner } from "./ui";

export function SwanSettings() {
  return (
    <div className="pane-body">
      <Providers />
      <Credentials />
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
            await actions.putCredential(secret, { value });
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
                  await actions.deleteCredential(secret);
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

// ---------- Credentials ----------

function Credentials() {
  const { state } = useStore();
  const providerKeys = providerKeyNames(state.providers);
  const creds = state.credentials.filter((c) => !providerKeys.has(c.name));
  const now = useNow(5000);
  const [adding, setAdding] = useState(false);
  const flash = Object.entries(state.credentialFlash)
    .filter(([n]) => !providerKeys.has(n))
    .sort((a, b) => b[1] - a[1])[0];
  return (
    <section className="swan-section">
      <div className="row gap">
        <h3 className="grow">Credentials</h3>
        {!adding && (
          <button type="button" className="link-btn" onClick={() => setAdding(true)}>
            <IconPlus /> Add
          </button>
        )}
      </div>
      <p className="hint">Secrets the agent's requests can use. Values are never shown. Edits apply on the next request. Model keys live under Model providers.</p>
      {adding && <AddCredential onDone={() => setAdding(false)} />}
      {creds.length === 0 && !adding && <p className="muted small">No credentials yet.</p>}
      <ul className="plain-list cred-list">
        {creds.map((c) => (
          <CredentialRow key={c.name} c={c} />
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

function CredentialRow({ c }: { c: CredentialStatus }) {
  const { actions } = useStore();
  const [mode, setMode] = useState<null | "rotate" | "hosts" | "delete" | "details">(null);
  const [hosts, setHosts] = useState(c.hosts.join(", "));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const run = async (fn: () => Promise<unknown>) => {
    setBusy(true);
    setError(null);
    try {
      await fn();
      setMode(null);
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <li className="cred-row">
      <div className="cred-line">
        <button
          type="button"
          className="cred-name mono"
          aria-expanded={mode === "details"}
          onClick={() => setMode(mode === "details" ? null : "details")}
        >
          {c.name}
        </button>
        {c.present ? (
          <span className="mono small muted" title="First 8 hex characters of the value's SHA-256">
            {c.fingerprint ?? "set"}
          </span>
        ) : (
          <span className="status-text tone-attention small">Missing</span>
        )}
        <button type="button" className="link-btn" onClick={() => setMode(mode === "rotate" ? null : "rotate")}>
          {c.present ? "Rotate" : "Set"}
        </button>
      </div>
      <div className="small muted">
        {c.hosts.length ? `Sent to ${c.hosts.join(", ")}` : "Host-side only"}
        {c.injects && " · header added by the proxy"}
        {c.updatedAt && ` · changed ${relTime(c.updatedAt)} ago`.replace(" now ago", " just now")}
        {c.usedBy.length > 0 && ` · used by ${c.usedBy.join(", ")}`}
      </div>
      {mode === "details" && (
        <div className="row gap wrap">
          <button type="button" className="btn sm" onClick={() => setMode("hosts")}>
            Edit hosts
          </button>
          <button type="button" className="btn sm danger" onClick={() => setMode("delete")}>
            Delete
          </button>
          <span className="small muted">Source: {c.source ?? "none"}</span>
        </div>
      )}
      {mode === "rotate" && (
        <SecretForm
          label={c.present ? `New value for ${c.name}` : `Value for ${c.name}`}
          submitLabel={c.present ? "Rotate" : "Save"}
          onCancel={() => setMode(null)}
          onSave={async (value) => {
            await actions.putCredential(c.name, { value });
            setMode(null);
          }}
        />
      )}
      {mode === "hosts" && (
        <form
          className="inline-form"
          onSubmit={(e) => {
            e.preventDefault();
            void run(() => actions.putCredential(c.name, { hosts: parseList(hosts) }));
          }}
        >
          <label className="field">
            <span className="field-label">Hosts this value may be sent to (comma separated; empty = host-side only)</span>
            <input className="input mono" value={hosts} onChange={(e) => setHosts(e.target.value)} autoFocus />
          </label>
          {error && <span className="field-error">{error}</span>}
          <div className="row gap end">
            <button type="button" className="btn sm" onClick={() => setMode(null)} disabled={busy}>
              Cancel
            </button>
            <button type="submit" className="btn primary sm" disabled={busy}>
              Save hosts
            </button>
          </div>
        </form>
      )}
      {mode === "delete" && (
        <div className="inline-form" role="group" aria-label={`Delete ${c.name}`}>
          <p className="small">
            Delete <span className="mono">{c.name}</span>?
            {c.usedBy.length > 0 ? ` ${c.usedBy.join(", ")} will lose access on the next request.` : " No persona uses it."}
          </p>
          {error && <span className="field-error">{error}</span>}
          <div className="row gap end">
            <button type="button" className="btn sm" onClick={() => setMode(null)} disabled={busy}>
              Cancel
            </button>
            <button type="button" className="btn sm danger" disabled={busy} onClick={() => void run(() => actions.deleteCredential(c.name))}>
              Delete credential
            </button>
          </div>
        </div>
      )}
    </li>
  );
}

const NAME_RE = /^[A-Z][A-Z0-9_]*$/;

function AddCredential({ onDone }: { onDone: () => void }) {
  const { state, actions } = useStore();
  const [name, setName] = useState("");
  const [value, setValue] = useState("");
  const [hosts, setHosts] = useState("");
  const [inject, setInject] = useState(false);
  const [header, setHeader] = useState("Authorization");
  const [format, setFormat] = useState("Bearer {value}");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const providerKeys = providerKeyNames(state.providers);
  const nameError = !name
    ? null
    : !NAME_RE.test(name)
      ? "Use UPPER_SNAKE_CASE."
      : providerKeys.has(name)
        ? "This is a model key. Add it under Model providers."
        : state.credentials.some((c) => c.name === name)
          ? "Already exists; use Rotate."
          : null;
  const hostList = parseList(hosts);
  return (
    <form
      className="inline-form"
      onSubmit={async (e) => {
        e.preventDefault();
        if (!name || nameError || !value) return;
        setBusy(true);
        setError(null);
        try {
          await actions.putCredential(name, {
            value,
            hosts: hostList,
            ...(inject && hostList.length ? { inject: { header, format } } : {}),
          });
          onDone();
        } catch (err) {
          setError(errorMessage(err));
          setBusy(false);
        }
      }}
    >
      <label className="field">
        <span className="field-label">Name</span>
        <input
          className="input mono"
          value={name}
          autoFocus
          placeholder="GITHUB_TOKEN"
          onChange={(e) => setName(e.target.value.toUpperCase().replace(/[\s-]+/g, "_"))}
          aria-invalid={!!nameError}
        />
        {nameError && <span className="field-error">{nameError}</span>}
      </label>
      <label className="field">
        <span className="field-label">Value</span>
        <input className="input mono" type="password" autoComplete="off" value={value} onChange={(e) => setValue(e.target.value)} />
      </label>
      <label className="field">
        <span className="field-label">Hosts it may be sent to (comma separated; empty = host-side only)</span>
        <input className="input mono" value={hosts} placeholder="api.github.com" onChange={(e) => setHosts(e.target.value)} />
      </label>
      <label className="check-row">
        <input type="checkbox" checked={inject} disabled={hostList.length === 0} onChange={(e) => setInject(e.target.checked)} />
        <span>Proxy adds an auth header on those hosts</span>
      </label>
      {inject && hostList.length > 0 && (
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
      {error && <span className="field-error">{error}</span>}
      <div className="row gap end">
        <button
          type="button"
          className="btn sm"
          onClick={onDone}
          disabled={busy}
        >
          Cancel
        </button>
        <button type="submit" className="btn primary sm" disabled={busy || !name || !!nameError || !value}>
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
