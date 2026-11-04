import { useEffect, useState } from "react";
import type { PersonaImportPreview } from "@ph/shared";
import { api } from "../api";
import { useStore } from "../store";
import { errorMessage } from "../util";
import { PaneHead } from "./Cards";
import { IconWarning } from "./icons";
import { Spinner } from "./ui";

const ID_RE = /^[a-z0-9][a-z0-9-]{0,62}$/;

/** Review a persona file before importing it: what it may reach, what it adds, and the choices that are yours. */
export function ImportPane({ onClose }: { onClose: () => void }) {
  const { state, actions } = useStore();
  const file = state.importFile;
  const [preview, setPreview] = useState<PersonaImportPreview | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [id, setId] = useState("");
  const [name, setName] = useState("");
  const [folders, setFolders] = useState<{ path: string; keep: boolean }[]>([]);
  const [tools, setTools] = useState<string[]>([]);
  const [skills, setSkills] = useState<string[]>([]);
  const [acceptTools, setAcceptTools] = useState(false);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (!file) return;
    setPreview(null);
    setError(null);
    api
      .previewImport(file.text)
      .then((p) => {
        setPreview(p);
        setId(p.id);
        setName(p.name);
        setFolders(p.folders.map((f) => ({ path: f.path, keep: true })));
        setTools([]); // sign-in tools run on this Mac: off until ticked
        setSkills(p.skills.filter((s) => !s.exists).map((s) => s.name));
      })
      .catch((e) => setError(errorMessage(e)));
  }, [file]);

  const taken = !!preview && state.personas.some((p) => p.id === id);
  const idError = !ID_RE.test(id) ? "Use lowercase letters, digits and dashes." : taken ? "A persona already has this id." : null;
  const folderError = folders.some((f) => f.keep && !f.path.trim()) ? "Enter a folder on this Mac, or leave it out." : null;

  const doImport = async () => {
    if (!file || !preview || idError || folderError || !name.trim()) return;
    setBusy(true);
    try {
      const r = await api.importPersona(file.text, { id, name: name.trim(), folders: folders.map((f) => (f.keep ? f.path.trim() : null)), commandConnections: tools, skills, acceptTools });
      const extra = [r.connectionsAdded.length && `connections ${r.connectionsAdded.join(", ")}`, r.skillsAdded.length && `skills ${r.skillsAdded.join(", ")}`].filter(Boolean);
      actions.toast("success", `${r.persona.name} imported${extra.length ? `, with ${extra.join(" and ")}` : ""}.`, "Import");
      actions.closeImport();
      actions.selectPersona(r.persona.id);
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="pane">
      <PaneHead title="Import persona" sub={file?.name} onClose={onClose} closeLabel="Close import" />
      <div className="pane-body">
        {error && (
          <p className="foot-error" role="alert">
            {preview ? "Not imported: " : ""}
            {error}
          </p>
        )}
        {!preview && !error && (
          <p className="muted">
            <Spinner size={12} /> Reading the file…
          </p>
        )}
        {preview && (
          <>
            <section className="swan-section">
              <h3>Persona</h3>
              <label className="field">
                <span className="field-label">Name</span>
                <input className="input" value={name} onChange={(e) => setName(e.target.value)} />
              </label>
              <label className="field">
                <span className="field-label">Id (its file name)</span>
                <input className="input mono" value={id} onChange={(e) => setId(e.target.value.toLowerCase())} aria-invalid={!!idError} />
                {idError && <span className="field-error">{idError}</span>}
              </label>
              {preview.description && <p className="small muted">{preview.description}</p>}
            </section>

            <section className="swan-section">
              <h3>What it may reach</h3>
              <Access preview={preview} />
            </section>

            {folders.length > 0 && (
              <section className="swan-section">
                <h3>Folders</h3>
                <p className="hint">These are the paths on the Mac it came from. Point each at a folder here, or leave it out.</p>
                {folders.map((f, i) => {
                  const orig = preview.folders[i]!;
                  return (
                    <div key={i} className="field">
                      <label className="check-row">
                        <input type="checkbox" checked={f.keep} onChange={(e) => setFolders((x) => x.map((y, j) => (j === i ? { ...y, keep: e.target.checked } : y)))} />
                        <span>
                          {orig.mount ?? `/workspace/${orig.path.split("/").filter(Boolean).pop() ?? ""}`} · {orig.mode === "rw" ? "can change" : "can read"}
                        </span>
                      </label>
                      {f.keep && (
                        <input
                          className="input mono"
                          aria-label={`Folder on this Mac for ${orig.mount ?? orig.path}`}
                          value={f.path}
                          onChange={(e) => setFolders((x) => x.map((y, j) => (j === i ? { ...y, path: e.target.value } : y)))}
                        />
                      )}
                    </div>
                  );
                })}
                {folderError && <span className="field-error">{folderError}</span>}
              </section>
            )}

            {preview.connections.length > 0 && (
              <section className="swan-section">
                <h3>Connections</h3>
                <ul className="plain-list small">
                  {preview.connections.map((c) => (
                    <li key={c.name}>
                      <span className="mono">{c.name}</span> · {c.hosts.join(", ") || "no hosts"} ·{" "}
                      {c.status === "same" ? "already set up" : c.status === "different" ? "you have your own; yours is kept" : c.type === "static" ? "added" : "new"}
                      {c.status === "new" && c.type === "command" && (
                        <>
                          <label className="check-row">
                            <input type="checkbox" checked={tools.includes(c.name)} onChange={(e) => setTools((t) => (e.target.checked ? [...t, c.name] : t.filter((x) => x !== c.name)))} />
                            <span>Add its sign-in tool</span>
                          </label>
                          <p className="hint">
                            It runs on your Mac: <span className="mono">{c.command?.join(" ")}</span>
                          </p>
                        </>
                      )}
                    </li>
                  ))}
                </ul>
                {preview.needs.values.length > 0 && (
                  <p className="hint">
                    Give these a value in Swan settings → Connections afterwards: <span className="mono">{preview.needs.values.join(", ")}</span>
                  </p>
                )}
              </section>
            )}

            {(preview.skills.length > 0 || preview.skillsNotIncluded.length > 0) && (
              <section className="swan-section">
                <h3>Skills</h3>
                {preview.skills.map((s) =>
                  s.exists ? (
                    <p key={s.name} className="small">
                      <span className="mono">{s.name}</span> · already installed; yours is kept
                    </p>
                  ) : (
                    <label key={s.name} className="check-row">
                      <input type="checkbox" checked={skills.includes(s.name)} onChange={(e) => setSkills((x) => (e.target.checked ? [...x, s.name] : x.filter((y) => y !== s.name)))} />
                      <span>
                        <span className="mono">{s.name}</span> · {s.files} files, added to ~/.swan/skills
                      </span>
                    </label>
                  ),
                )}
                {preview.skillsNotIncluded.length > 0 && (
                  <p className="hint">Not in the file, and not on this Mac: {preview.skillsNotIncluded.join(", ")}.</p>
                )}
              </section>
            )}

            {preview.access.tools && (
              <section className="swan-section">
                <h3>Sandbox tools</h3>
                <p className="small">Built into this persona's sandbox, as root, with open network access during the build. Read them before you add them.</p>
                {preview.access.tools.packages.length > 0 && (
                  <p className="small">
                    Packages: <span className="mono">{preview.access.tools.packages.join(", ")}</span>
                  </p>
                )}
                {preview.access.tools.install && <pre className="small">{preview.access.tools.install}</pre>}
                <label className="check-row">
                  <input type="checkbox" checked={acceptTools} onChange={(e) => setAcceptTools(e.target.checked)} />
                  <span>Add these tools</span>
                </label>
              </section>
            )}

            {(preview.needs.commands.length > 0 || preview.needs.sandboxTools) && (
              <section className="swan-section">
                <h3>Also needed</h3>
                {preview.needs.commands.length > 0 && (
                  <p className="small">
                    Sign-in tools on this Mac: <span className="mono">{preview.needs.commands.join(", ")}</span>
                  </p>
                )}
                {preview.needs.sandboxTools && <p className="small">The sandbox it came from had extra tools (sandboxTools in config.yaml); its tasks may need them.</p>}
              </section>
            )}

            <div className="row gap">
              <button type="button" className="btn primary" disabled={busy || !!idError || !!folderError || !name.trim()} onClick={() => void doImport()}>
                {busy && <Spinner size={10} />}
                Import
              </button>
              <button type="button" className="btn" onClick={onClose} disabled={busy}>
                Cancel
              </button>
            </div>
          </>
        )}
      </div>
    </div>
  );
}

/** The persona's reach, with what deserves a second look marked. */
function Access({ preview }: { preview: PersonaImportPreview }) {
  const a = preview.access;
  const list = (xs: string[]) => (xs.length ? <span className="mono">{xs.join(", ")}</span> : <span className="muted">none</span>);
  return (
    <dl className="facts small">
      <dt>Allowed hosts</dt>
      <dd>{list(a.networkAllow)}</dd>
      <dt>Company network</dt>
      <dd>{list(a.networkInternal)}</dd>
      {a.otherCredentials.length > 0 && (
        <>
          <dt>Other credentials</dt>
          <dd className="tone-attention">{list(a.otherCredentials)}</dd>
        </>
      )}
      <dt>Commands</dt>
      <dd className={a.allowsAllCommands ? "tone-attention" : undefined}>
        {a.allowsAllCommands && <IconWarning size={12} />} {a.allowsAllCommands ? "every command runs without asking" : `default ${a.permissions.default}; allows ${a.permissions.allow.join(", ") || "nothing"}`}
      </dd>
      {a.credentialRules.map((r, i) => (
        <span key={i} style={{ display: "contents" }}>
          <dt className="mono">
            {r.connection}/{r.credential}
          </dt>
          <dd>
            {r.api}: allow {r.allow.join(", ") || "nothing"}
            {r.ask.length > 0 && ` · ask ${r.ask.join(", ")}`}
            {r.deny.length > 0 && ` · deny ${r.deny.join(", ")}`}
          </dd>
        </span>
      ))}
      {a.mcpServers.length > 0 && (
        <>
          <dt>MCP servers</dt>
          <dd>
            {a.mcpServers.map((m) => (
              <div key={m.name}>
                <span className="mono">{m.name}</span> · {m.kind === "http" ? `called from your Mac: ${m.target}` : `in the sandbox: ${m.target}`}
              </div>
            ))}
          </dd>
        </>
      )}
      {a.image && (
        <>
          <dt>Sandbox image</dt>
          <dd className="mono">{a.image}</dd>
        </>
      )}
      {a.envNames.length > 0 && (
        <>
          <dt>Environment</dt>
          <dd>{list(a.envNames)}</dd>
        </>
      )}
    </dl>
  );
}
