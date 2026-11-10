// The folders a persona's sandbox mounts.
import { useEffect, useId, useState } from "react";
import type { FolderMode, PersonaConfigView } from "@ph/shared";
import { IconPlus, IconTrash } from "../icons";
import { Field } from "../ui";
import type { Errors } from "./config";

type FolderView = PersonaConfigView["folders"][number];

const FOLDER_GROUPS: Array<{ mode: FolderMode; label: string }> = [
  { mode: "rw", label: "Can change" },
  { mode: "ro", label: "Can read" },
];

function folderBase(path: string): string {
  return path.trim().replace(/\/+$/, "").split("/").pop() || "name";
}

/** Where the sandbox sees the folder: its mount, or /workspace/<folder name> as the server defaults it. */
function mountPathOf(f: FolderView): string {
  return f.mount?.trim() || `/workspace/${folderBase(f.path)}`;
}

/**
 * Folders grouped by access. Each row opens an inline editor; a folder with an error keeps its editor
 * open so the error stays next to its field. The edited folder stays in its group until the editor
 * closes, so changing its access does not move it (and focus) mid-edit.
 */
export function Folders({
  folders,
  errors,
  update,
}: {
  folders: FolderView[];
  errors: Errors;
  update: (fn: (draft: PersonaConfigView) => void) => void;
}) {
  const [editing, setEditing] = useState<{ index: number; mode: FolderMode; isNew: boolean } | null>(null);
  const [focusId, setFocusId] = useState<string | null>(null);
  const baseId = useId();
  const rowId = (i: number) => `${baseId}-row-${i}`;
  const fieldId = (i: number, field: "path" | "mount") => `${baseId}-${field}-${i}`;
  const addId = `${baseId}-add`;
  const ed = editing && editing.index < folders.length ? editing : null;
  const newIndex = ed?.isNew ? ed.index : -1;

  useEffect(() => {
    if (!focusId) return;
    document.getElementById(focusId)?.focus();
    setFocusId(null);
  }, [focusId]);

  const errorOf = (i: number) => errors[`folder${i}`];
  const isEmpty = (f: FolderView) => !f.path.trim() && !f.mount?.trim();

  const open = (i: number) => {
    setEditing({ index: i, mode: folders[i].mode, isNew: false });
    setFocusId(fieldId(i, "path"));
  };

  const remove = (i: number) => {
    update((x) => void x.folders.splice(i, 1));
    setEditing((e) => (!e || e.index === i ? null : e.index > i ? { ...e, index: e.index - 1 } : e));
    setFocusId(addId);
  };

  const close = (i: number) => {
    const f = folders[i];
    if (ed?.index === i && ed.isNew && isEmpty(f)) return remove(i);
    if (errorOf(i)) return setFocusId(fieldId(i, f.path.trim() ? "mount" : "path"));
    if (ed?.index === i) setEditing(null);
    setFocusId(rowId(i));
  };

  const add = () => {
    if (ed?.isNew && isEmpty(folders[ed.index])) return setFocusId(fieldId(ed.index, "path"));
    const index = folders.length;
    update((x) => void x.folders.push({ path: "", mode: "ro" }));
    setEditing({ index, mode: "ro", isNew: true });
    setFocusId(fieldId(index, "path"));
  };

  const editor = (f: FolderView, i: number) => (
    <FolderEditor
      folder={f}
      label={i === newIndex ? "New folder" : `Folder ${mountPathOf(f)}`}
      error={errorOf(i)}
      pathId={fieldId(i, "path")}
      mountId={fieldId(i, "mount")}
      onChange={(fn) => update((x) => fn(x.folders[i]))}
      onFocus={() => {
        if (ed?.index !== i) setEditing({ index: i, mode: f.mode, isNew: false });
      }}
      onDone={() => close(i)}
      onRemove={() => remove(i)}
    />
  );

  return (
    <>
      {folders.length === 0 && <p className="hint">The sandbox sees only the folders added here.</p>}
      {FOLDER_GROUPS.map((g) => {
        const rows = folders
          .map((f, i) => ({ f, i }))
          .filter(({ f, i }) => i !== newIndex && (ed?.index === i ? ed.mode : f.mode) === g.mode);
        if (rows.length === 0) return null;
        const labelId = `${baseId}-${g.mode}`;
        return (
          <div key={g.mode} className="folder-group">
            <span id={labelId} className="small muted">
              {g.label}
            </span>
            <ul className="folder-list" aria-labelledby={labelId}>
              {rows.map(({ f, i }) =>
                ed?.index === i || errorOf(i) ? (
                  <li key={i}>{editor(f, i)}</li>
                ) : (
                  <FolderRow key={i} id={rowId(i)} folder={f} onOpen={() => open(i)} onRemove={() => remove(i)} />
                ),
              )}
            </ul>
          </div>
        );
      })}
      {newIndex >= 0 && editor(folders[newIndex], newIndex)}
      <button id={addId} type="button" className="link-btn" onClick={add}>
        <IconPlus /> Add folder
      </button>
    </>
  );
}

function FolderRow({ id, folder, onOpen, onRemove }: { id: string; folder: FolderView; onOpen: () => void; onRemove: () => void }) {
  const mount = mountPathOf(folder);
  return (
    <li className="folder-item">
      <button
        id={id}
        type="button"
        className="folder-open"
        title={`${folder.path} → ${mount}`}
        aria-label={`Edit folder ${mount}, ${folder.path}`}
        onClick={onOpen}
      >
        <span className="folder-name mono">{mount.replace(/^\/workspace\//, "")}</span>
        <span className="folder-path small muted mono">{folder.path}</span>
      </button>
      <button type="button" className="icon-btn folder-remove" aria-label={`Remove folder ${mount}`} onClick={onRemove}>
        <IconTrash />
      </button>
    </li>
  );
}

function FolderEditor({
  folder,
  label,
  error,
  pathId,
  mountId,
  onChange,
  onFocus,
  onDone,
  onRemove,
}: {
  folder: FolderView;
  label: string;
  error?: string;
  pathId: string;
  mountId: string;
  onChange: (fn: (f: FolderView) => void) => void;
  onFocus: () => void;
  onDone: () => void;
  onRemove: () => void;
}) {
  // validate() reports one error per folder: the path when it is empty, otherwise the mount.
  const pathError = error && !folder.path.trim() ? error : undefined;
  const mountError = error && !pathError ? error : undefined;
  return (
    <div
      className="inline-form folder-edit"
      role="group"
      aria-label={label}
      onFocus={onFocus}
      onKeyDown={(e) => {
        if (e.key !== "Escape") return;
        e.preventDefault();
        e.stopPropagation();
        onDone();
      }}
    >
      <Field label="Path on this Mac" id={pathId} error={pathError}>
        {(f) => (
          <input
            {...f}
            className="input mono"
            value={folder.path}
            placeholder="~/code/project"
            spellCheck={false}
            aria-invalid={!!pathError}
            onChange={(e) => onChange((f) => void (f.path = e.target.value))}
          />
        )}
      </Field>
      <Field label="Mounted at" id={mountId} error={mountError}>
        {(f) => (
          <input
            {...f}
            className="input mono"
            value={folder.mount ?? ""}
            placeholder={`/workspace/${folderBase(folder.path)}`}
            spellCheck={false}
            aria-invalid={!!mountError}
            onChange={(e) => onChange((f) => void (f.mount = e.target.value || undefined))}
          />
        )}
      </Field>
      <Field label="Access">
        {(f) => (
          <select {...f} className="input" value={folder.mode} onChange={(e) => onChange((f) => void (f.mode = e.target.value as FolderMode))}>
            <option value="ro">Read-only</option>
            <option value="rw">Read-write</option>
          </select>
        )}
      </Field>
      <p className="hint">After saving, the sandbox restarts between turns to apply it.</p>
      <div className="row gap">
        <button type="button" className="btn sm" onClick={onDone}>
          Done
        </button>
        <span className="grow" />
        <button type="button" className="btn sm danger" onClick={onRemove}>
          Remove
        </button>
      </div>
    </div>
  );
}
