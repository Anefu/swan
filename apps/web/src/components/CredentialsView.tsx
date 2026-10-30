import { useState, type FormEvent } from "react";
import type { CredentialStatus, CredentialUpsert } from "@ph/shared";
import { useStore } from "../store";
import { cls, errorMessage, fullTime, parseList, relTime, useNow } from "../util";
import { IconKey, IconPlus, IconRefresh, IconShield, IconTrash } from "./icons";
import { ConfirmDialog, EmptyState, Modal, Spinner } from "./ui";

type EditorState = { mode: "new" } | { mode: "value" | "edit"; cred: CredentialStatus } | null;

const FLASH_MS = 4000;

export function CredentialsView() {
  const { state, actions } = useStore();
  const now = useNow(1000);
  const [editor, setEditor] = useState<EditorState>(null);
  const [deleting, setDeleting] = useState<CredentialStatus | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  const creds = state.credentials;

  return (
    <div className="page">
      <header className="page-head">
        <div>
          <h1>
            <IconKey size={16} /> Credentials
          </h1>
          <p className="muted">
            Secrets never enter the sandbox. The egress proxy injects them into requests to the listed hosts, and this UI only
            ever shows fingerprints. Changes to the secrets file are hot-reloaded.
          </p>
        </div>
        <div className="page-actions">
          <button
            type="button"
            className="btn"
            disabled={refreshing}
            onClick={async () => {
              setRefreshing(true);
              await actions.loadAll();
              setRefreshing(false);
            }}
          >
            {refreshing ? <Spinner /> : <IconRefresh />} Refresh
          </button>
          <button type="button" className="btn primary" onClick={() => setEditor({ mode: "new" })}>
            <IconPlus /> Add credential
          </button>
        </div>
      </header>

      {creds.length === 0 ? (
        <EmptyState
          icon={<IconShield size={28} />}
          title="No credentials yet"
          actions={
            <button type="button" className="btn primary" onClick={() => setEditor({ mode: "new" })}>
              <IconPlus /> Add credential
            </button>
          }
        >
          Add API keys and tokens here; personas reference them by name.
        </EmptyState>
      ) : (
        <div className="table-wrap">
          <table className="table creds">
            <thead>
              <tr>
                <th>Name</th>
                <th>Status</th>
                <th>Source</th>
                <th>Hosts</th>
                <th>Injects</th>
                <th>Fingerprint</th>
                <th>Updated</th>
                <th>Used by</th>
                <th className="actions-col">
                  <span className="sr-only">Actions</span>
                </th>
              </tr>
            </thead>
            <tbody>
              {creds.map((c) => {
                const flashAt = state.credentialFlash[c.name];
                const flashing = flashAt !== undefined && now - flashAt < FLASH_MS;
                return (
                  <tr key={`${c.name}:${flashAt ?? 0}`} className={cls(flashing && "flash", !c.present && "missing")}>
                    <td className="mono strong">{c.name}</td>
                    <td>
                      {c.present ? (
                        <span className="state ok">
                          <span className="sdot" /> Set
                        </span>
                      ) : (
                        <span className="state warn">
                          <span className="sdot" /> Missing
                        </span>
                      )}
                      {flashing && <span className="chip reloaded">reloaded</span>}
                    </td>
                    <td>{c.source ? <span className="chip">{c.source}</span> : <span className="faint">—</span>}</td>
                    <td>
                      {c.hosts.length ? (
                        <div className="chips">
                          {c.hosts.map((h) => (
                            <span key={h} className="chip mono">
                              {h}
                            </span>
                          ))}
                        </div>
                      ) : (
                        <span className="faint" title="Not sent anywhere by the proxy; used on the host only (e.g. a provider API key)">
                          host-side only
                        </span>
                      )}
                    </td>
                    <td>{c.injects ? <span className="chip dec-injected">header</span> : <span className="faint">—</span>}</td>
                    <td className="mono">{c.fingerprint ?? <span className="faint">—</span>}</td>
                    <td title={fullTime(c.updatedAt)}>{c.updatedAt ? relTime(c.updatedAt, now) : <span className="faint">—</span>}</td>
                    <td>
                      {c.usedBy.length ? (
                        <div className="chips">
                          {c.usedBy.map((p) => (
                            <button key={p} type="button" className="chip link" onClick={() => actions.selectPersona(p)}>
                              {p}
                            </button>
                          ))}
                        </div>
                      ) : (
                        <span className="faint">unused</span>
                      )}
                    </td>
                    <td className="actions-col">
                      <div className="row-actions">
                        <button type="button" className="btn sm" onClick={() => setEditor({ mode: "value", cred: c })}>
                          {c.present ? "Rotate" : "Set value"}
                        </button>
                        <button type="button" className="btn ghost sm" onClick={() => setEditor({ mode: "edit", cred: c })}>
                          Edit
                        </button>
                        <button
                          type="button"
                          className="icon-btn sm danger"
                          title={`Delete ${c.name}`}
                          aria-label={`Delete ${c.name}`}
                          onClick={() => setDeleting(c)}
                        >
                          <IconTrash />
                        </button>
                      </div>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}

      {editor && (
        <CredentialEditor
          key={editor.mode === "new" ? "new" : editor.cred.name}
          state={editor}
          existing={creds}
          onClose={() => setEditor(null)}
        />
      )}
      {deleting && (
        <ConfirmDialog
          title={`Delete ${deleting.name}?`}
          confirmLabel="Delete credential"
          danger
          onCancel={() => setDeleting(null)}
          onConfirm={async () => {
            if (await actions.deleteCredential(deleting.name)) setDeleting(null);
          }}
        >
          <p>The stored value and host rules for this credential will be removed.</p>
          {deleting.usedBy.length > 0 && (
            <p className="notice notice-warn">
              Still declared by: <span className="mono">{deleting.usedBy.join(", ")}</span>. Those personas will report it
              as missing.
            </p>
          )}
          {deleting.source === "env" && (
            <p className="muted small">This value comes from an environment variable, which this UI cannot unset.</p>
          )}
        </ConfirmDialog>
      )}
    </div>
  );
}

type InjectMode = "none" | "keep" | "header";

function CredentialEditor({
  state,
  existing,
  onClose,
}: {
  state: NonNullable<EditorState>;
  existing: CredentialStatus[];
  onClose: () => void;
}) {
  const { actions } = useStore();
  const cred = state.mode === "new" ? null : state.cred;
  const [name, setName] = useState(cred?.name ?? "");
  const [value, setValue] = useState("");
  const [hosts, setHosts] = useState((cred?.hosts ?? []).join("\n"));
  const [injectMode, setInjectMode] = useState<InjectMode>(cred?.injects ? "keep" : "none");
  const [header, setHeader] = useState("Authorization");
  const [format, setFormat] = useState("Bearer {value}");
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  const nameInvalid = state.mode === "new" && name.length > 0 && !/^[A-Za-z_][A-Za-z0-9_]*$/.test(name);
  const nameTaken = state.mode === "new" && existing.some((c) => c.name === name);
  const formatInvalid = injectMode === "header" && (!header.trim() || !format.includes("{value}"));

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (!name || nameInvalid || nameTaken || formatInvalid || saving) return;
    const body: CredentialUpsert = { hosts: parseList(hosts) };
    if (value) body.value = value;
    if (injectMode === "none") body.inject = null;
    else if (injectMode === "header") body.inject = { header: header.trim(), format };
    setSaving(true);
    setError(null);
    try {
      await actions.putCredential(name, body);
      setValue("");
      onClose();
    } catch (err) {
      setError(errorMessage(err));
      actions.reportError(err, `Saving ${name}`);
    } finally {
      setSaving(false);
    }
  };

  const title =
    state.mode === "new" ? "Add credential" : state.mode === "value" ? `${cred?.present ? "Rotate" : "Set"} ${name}` : `Edit ${name}`;

  return (
    <Modal
      title={title}
      onClose={onClose}
      footer={
        <>
          <button type="button" className="btn" onClick={onClose}>
            Cancel
          </button>
          <button
            type="submit"
            form="cred-form"
            className="btn primary"
            disabled={!name || nameInvalid || nameTaken || formatInvalid || saving}
          >
            {saving && <Spinner />}
            Save
          </button>
        </>
      }
    >
      <form id="cred-form" className="form" onSubmit={submit} autoComplete="off">
        <label className="field">
          <span className="field-label">Name</span>
          {state.mode === "new" ? (
            <input
              className="input mono"
              value={name}
              onChange={(e) => setName(e.target.value.toUpperCase())}
              placeholder="GITHUB_TOKEN"
              spellCheck={false}
              data-autofocus
              aria-invalid={nameInvalid || nameTaken}
            />
          ) : (
            <input className="input mono" value={name} readOnly disabled />
          )}
          {nameInvalid && <span className="field-error">Use letters, digits and underscores; don't start with a digit.</span>}
          {nameTaken && <span className="field-error">A credential with this name already exists.</span>}
        </label>

        <label className="field">
          <span className="field-label">
            Value
            {cred?.fingerprint && <span className="muted"> · current fingerprint <span className="mono">{cred.fingerprint}</span></span>}
          </span>
          <input
            className="input mono"
            type="password"
            value={value}
            onChange={(e) => setValue(e.target.value)}
            placeholder={cred?.present ? "Leave empty to keep the current value" : "Paste the secret value"}
            autoComplete="new-password"
            spellCheck={false}
            data-1p-ignore
            data-lpignore="true"
            data-autofocus={state.mode === "value" ? true : undefined}
          />
          <span className="field-hint">Write-only. The current value is never shown.</span>
        </label>

        <label className="field">
          <span className="field-label">Hosts</span>
          <textarea
            className="input mono"
            rows={3}
            value={hosts}
            onChange={(e) => setHosts(e.target.value)}
            placeholder={"api.github.com\n*.githubusercontent.com"}
            spellCheck={false}
            data-autofocus={state.mode === "edit" ? true : undefined}
          />
          <span className="field-hint">
            Comma or newline separated. The proxy only sends this secret to these hosts. Leave empty for host-side use only.
          </span>
        </label>

        <fieldset className="field">
          <legend className="field-label">Header injection</legend>
          <div className="radio-row">
            <label className="radio">
              <input type="radio" name="inject" checked={injectMode === "none"} onChange={() => setInjectMode("none")} />
              None
            </label>
            {cred?.injects && (
              <label className="radio">
                <input type="radio" name="inject" checked={injectMode === "keep"} onChange={() => setInjectMode("keep")} />
                Keep current
              </label>
            )}
            <label className="radio">
              <input type="radio" name="inject" checked={injectMode === "header"} onChange={() => setInjectMode("header")} />
              {cred?.injects ? "Replace with…" : "Inject header"}
            </label>
          </div>
          {injectMode === "header" && (
            <div className="inject-grid">
              <input
                className="input mono"
                value={header}
                onChange={(e) => setHeader(e.target.value)}
                placeholder="Authorization"
                aria-label="Header name"
                spellCheck={false}
              />
              <input
                className="input mono"
                value={format}
                onChange={(e) => setFormat(e.target.value)}
                placeholder="Bearer {value}"
                aria-label="Header value format"
                spellCheck={false}
                aria-invalid={formatInvalid}
              />
            </div>
          )}
          {formatInvalid && <span className="field-error">The format must contain {"{value}"}.</span>}
          <span className="field-hint">
            When set, the proxy adds this header to requests for the hosts above, e.g. <span className="mono">Authorization: Bearer {"{value}"}</span>.
          </span>
        </fieldset>

        {error && (
          <div className="form-error" role="alert">
            {error}
          </div>
        )}
      </form>
    </Modal>
  );
}
