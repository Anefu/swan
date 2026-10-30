import { useCallback, useEffect, useRef, useState } from "react";
import type { PersonaSummary } from "@ph/shared";
import { api } from "../api";
import { useStore } from "../store";
import { errorLines, errorMessage } from "../util";
import { IconAlert, IconTrash, IconWarning } from "./icons";
import { CodeEditor, ConfirmDialog, Kbd, MOD, Spinner } from "./ui";

export function PersonaTab({ persona }: { persona: PersonaSummary }) {
  const { actions } = useStore();
  const [base, setBase] = useState<string | null>(null); // last source loaded from / saved to the server
  const [draft, setDraft] = useState("");
  const [loadError, setLoadError] = useState<string | null>(null);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [externalChange, setExternalChange] = useState<string | null>(null);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const dirty = base !== null && draft !== base;
  const dirtyRef = useRef(dirty);
  dirtyRef.current = dirty;
  const baseRef = useRef(base);
  baseRef.current = base;

  const load = useCallback(async () => {
    try {
      const src = await api.personaSource(persona.id);
      setLoadError(null);
      if (dirtyRef.current) {
        // Someone edited the file on disk while we have unsaved edits.
        if (src.yaml !== baseRef.current) setExternalChange(src.yaml);
        return;
      }
      setBase(src.yaml);
      setDraft(src.yaml);
      setExternalChange(null);
    } catch (e) {
      setLoadError(errorMessage(e));
    }
  }, [persona.id]);

  // Initial load, and reload whenever the server reports a new summary (hot reload from disk).
  useEffect(() => {
    void load();
  }, [load, persona]);

  const save = async () => {
    if (saving || base === null) return;
    setSaving(true);
    setSaveError(null);
    try {
      const summary = await actions.savePersona(persona.id, draft);
      setBase(draft);
      setExternalChange(null);
      if (summary.errors.length > 0) actions.toast("warn", `Saved with ${summary.errors.length} validation error(s)`);
      else actions.toast("success", `Saved ${persona.id}.yaml`);
    } catch (e) {
      setSaveError(errorMessage(e));
      actions.reportError(e, "Save failed");
    } finally {
      setSaving(false);
    }
  };

  const lines = errorLines([saveError, ...persona.errors]);

  return (
    <div className="tab-pane persona-tab">
      <div className="panel-toolbar">
        <span className="mono small">personas/{persona.id}.yaml</span>
        {dirty && <span className="chip dirty">unsaved</span>}
        <span className="spacer" />
        <button type="button" className="btn ghost sm" disabled={!dirty || saving} onClick={() => base !== null && setDraft(base)}>
          Revert
        </button>
        <button
          type="button"
          className="btn primary sm"
          disabled={!dirty || saving}
          onClick={() => void save()}
          title={`Save (${MOD}+S)`}
        >
          {saving && <Spinner size={10} />}
          Save
        </button>
      </div>

      {loadError && <div className="form-error">Could not load the persona source: {loadError}</div>}

      {externalChange !== null && (
        <div className="notice notice-warn">
          <IconWarning />
          <span className="notice-text">This file changed on disk while you were editing.</span>
          <button
            type="button"
            className="btn sm"
            onClick={() => {
              setBase(externalChange);
              setDraft(externalChange);
              setExternalChange(null);
            }}
          >
            Load disk version
          </button>
        </div>
      )}

      {saveError && (
        <div className="form-error" role="alert">
          <IconAlert /> {saveError}
        </div>
      )}

      {persona.errors.length > 0 && (
        <div className="form-error" role="alert">
          <strong>Validation errors</strong>
          <ul>
            {persona.errors.map((e, i) => (
              <li key={i}>{e}</li>
            ))}
          </ul>
        </div>
      )}

      {persona.missingCredentials.length > 0 && (
        <div className="notice notice-warn">
          <IconWarning />
          <span className="notice-text">
            Missing credentials: <span className="mono">{persona.missingCredentials.join(", ")}</span>
          </span>
          <button type="button" className="btn sm" onClick={() => actions.showView("credentials")}>
            Credentials
          </button>
        </div>
      )}

      {base === null && !loadError ? (
        <div className="muted small">
          <Spinner size={10} /> Loading…
        </div>
      ) : (
        <CodeEditor
          className="persona-editor"
          value={draft}
          onChange={setDraft}
          onSave={() => void save()}
          errorLines={lines}
          ariaLabel={`YAML source of ${persona.id}`}
        />
      )}

      <div className="panel-foot">
        <span className="muted small">
          <Kbd>{MOD}</Kbd>+<Kbd>S</Kbd> save · <Kbd>Tab</Kbd> indents · <Kbd>Esc</Kbd> leaves the editor
        </span>
        <button type="button" className="btn danger-ghost sm" onClick={() => setConfirmDelete(true)}>
          <IconTrash /> Delete persona
        </button>
      </div>

      {confirmDelete && (
        <ConfirmDialog
          title={`Delete persona “${persona.name || persona.id}”?`}
          confirmLabel="Delete persona"
          danger
          onCancel={() => setConfirmDelete(false)}
          onConfirm={async () => {
            if (await actions.deletePersona(persona.id)) setConfirmDelete(false);
          }}
        >
          <p>
            This deletes the persona definition <span className="mono">personas/{persona.id}.yaml</span>. Files in its
            mounted folders are not touched.
          </p>
        </ConfirmDialog>
      )}
    </div>
  );
}
