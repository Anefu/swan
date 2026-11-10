// Sharing and deleting a persona.
import { useState } from "react";
import type { PersonaSummary } from "@ph/shared";
import { personaExportUrl } from "../../api";
import { useStore } from "../../store";
import { Confirm } from "../ui";

/** A file to share the persona: its settings, the connections it uses (never values) and, if chosen, its skills. */
export function ExportPersona({ persona }: { persona: PersonaSummary }) {
  const [open, setOpen] = useState(false);
  const [skills, setSkills] = useState<string[]>(persona.skills);
  if (!open)
    return (
      <div>
        <button type="button" className="btn sm" onClick={() => setOpen(true)}>
          Export…
        </button>
      </div>
    );
  return (
    <div className="inline-form" role="group" aria-label={`Export ${persona.name}`}>
      <p className="small">
        A file to share {persona.name}: its settings and the connections it uses, without any secret values. Check its instructions and
        environment variables before sharing.
      </p>
      {persona.hasSandboxTools && <p className="small">It includes the persona's sandbox tools and install script, so check those for internal addresses too.</p>}
      {persona.skills.length > 0 && (
        <div role="group" aria-label="Include skills">
          <p className="small muted">Include skills</p>
          {persona.skills.map((name) => (
            <label key={name} className="check-row">
              <input
                type="checkbox"
                checked={skills.includes(name)}
                onChange={(e) => setSkills((s) => (e.target.checked ? [...s, name] : s.filter((x) => x !== name)))}
              />
              <span className="mono">{name}</span>
            </label>
          ))}
        </div>
      )}
      <div className="row gap end">
        <a className="btn sm primary" href={personaExportUrl(persona.id, skills)} download={`${persona.id}.swan-persona.yaml`} onClick={() => setOpen(false)}>
          Download
        </a>
        <button type="button" className="btn sm" onClick={() => setOpen(false)}>
          Cancel
        </button>
      </div>
    </div>
  );
}

/** Removes the persona with its conversation, memory and attachments, after a confirmation. */
export function DeletePersona({ persona }: { persona: PersonaSummary }) {
  const { actions } = useStore();
  const [confirm, setConfirm] = useState(false);
  if (!confirm)
    return (
      <div>
        <button type="button" className="btn sm danger" onClick={() => setConfirm(true)}>
          Delete persona…
        </button>
      </div>
    );
  return (
    <Confirm
      label={`Delete ${persona.name}`}
      action="Delete"
      onConfirm={() => actions.deletePersona(persona.id)}
      onCancel={() => setConfirm(false)}
      onError={(e) => actions.reportError(e, "Could not delete the persona")}
    >
      Delete {persona.name}? Its conversation, memory and attachments are deleted too. The folders it used are not touched.
    </Confirm>
  );
}
