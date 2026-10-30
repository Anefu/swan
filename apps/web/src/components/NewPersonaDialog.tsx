import { useState } from "react";
import { useStore } from "../store";
import { errorLines, errorMessage } from "../util";
import { CodeEditor, Kbd, MOD, Modal, Spinner } from "./ui";

export const PERSONA_TEMPLATE = `name: My Persona
description: What this persona is for
model:
  provider: anthropic
  id: claude-opus-5-5
  effort: high
instructions: |
  You are a careful software engineer.
folders:
  - path: ~/Documents/some-project
    mode: rw
skills: []
mcpServers: {}
credentials: []
network:
  allow: []
permissions:
  default: ask
  allow: [read_file, list_dir, glob, grep, load_skill]
  ask: [bash, write_file, edit_file]
  deny: []
`;

const ID_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

export function NewPersonaDialog() {
  const { state, actions } = useStore();
  const [id, setId] = useState("");
  const [yaml, setYaml] = useState(PERSONA_TEMPLATE);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const close = () => actions.openDialog(null);

  const idInvalid = id.length > 0 && !ID_RE.test(id);
  const idTaken = state.personas.some((p) => p.id === id);
  const canCreate = id.length > 0 && !idInvalid && !idTaken && yaml.trim().length > 0 && !saving;

  const create = async () => {
    if (!canCreate) return;
    setSaving(true);
    setError(null);
    try {
      const persona = await actions.createPersona(id, yaml);
      close();
      actions.openRightTab("persona");
      if (persona.errors.length > 0) {
        actions.toast("warn", `Created ${persona.id} with ${persona.errors.length} validation error(s). Fix them in the Persona tab.`);
      } else {
        actions.toast("success", `Created persona ${persona.id}`);
      }
    } catch (e) {
      setError(errorMessage(e));
      actions.reportError(e, "Create persona failed");
    } finally {
      setSaving(false);
    }
  };

  return (
    <Modal
      title="New persona"
      size="lg"
      onClose={close}
      footer={
        <>
          <span className="muted small foot-hint">
            <Kbd>{MOD}</Kbd>+<Kbd>Enter</Kbd> create
          </span>
          <button type="button" className="btn" onClick={close}>
            Cancel
          </button>
          <button type="button" className="btn primary" disabled={!canCreate} onClick={() => void create()}>
            {saving && <Spinner />}
            Create persona
          </button>
        </>
      }
    >
      <div
        className="form"
        onKeyDown={(e) => {
          if ((e.metaKey || e.ctrlKey) && e.key === "Enter") {
            e.preventDefault();
            void create();
          }
        }}
      >
        <label className="field">
          <span className="field-label">ID</span>
          <div className="input-affix">
            <span className="affix mono">personas/</span>
            <input
              className="input mono"
              value={id}
              onChange={(e) => setId(e.target.value.toLowerCase().replace(/[\s_]+/g, "-"))}
              placeholder="my-persona"
              spellCheck={false}
              data-autofocus
              aria-invalid={idInvalid || idTaken}
            />
            <span className="affix mono">.yaml</span>
          </div>
          {idInvalid && <span className="field-error">Use kebab-case: lowercase letters, digits and single dashes.</span>}
          {idTaken && <span className="field-error">A persona with this ID already exists.</span>}
        </label>
        <div className="field">
          <span className="field-label">Definition</span>
          <CodeEditor
            className="new-persona-editor"
            value={yaml}
            onChange={setYaml}
            onSave={() => void create()}
            errorLines={errorLines([error])}
            ariaLabel="Persona YAML"
          />
        </div>
        {error && (
          <div className="form-error" role="alert">
            {error}
          </div>
        )}
      </div>
    </Modal>
  );
}
