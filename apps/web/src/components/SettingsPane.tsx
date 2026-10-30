import { useEffect, useId, useState, type ReactNode } from "react";
import type { FolderMode, PermissionMode, PersonaConfigView, PersonaSummary } from "@ph/shared";
import { api } from "../api";
import { conversationSession, NEW_PERSONA, useSelectedPersona, useStore, type SettingsDraft } from "../store";
import { clone, cls, errorMessage, isMissingEndpoint, sameJson } from "../util";
import { toYaml } from "../yaml";
import { DecisionsShortcut } from "./Composer";
import { IconChevronRight, IconPlus, IconTrash, IconX } from "./icons";
import { SwanSettings } from "./SwanSettings";
import { Empty, Segmented, Spinner } from "./ui";

export function SettingsPane({ onClose }: { onClose: () => void }) {
  const { state, actions } = useStore();
  const persona = useSelectedPersona();
  const scopeLabel = state.settingsNew ? "New persona" : (persona?.name ?? "Persona");
  return (
    <div className="pane">
      <div className="pane-head">
        <h2>Settings</h2>
        <DecisionsShortcut className="compact" />
        <button type="button" className="icon-btn" aria-label="Close settings" onClick={onClose}>
          <IconX size={18} />
        </button>
      </div>
      <div className="pane-tabs">
        <Segmented
          label="Settings scope"
          value={state.settingsScope}
          onChange={(v) => actions.setSettingsScope(v)}
          options={[
            { value: "persona", label: scopeLabel },
            { value: "swan", label: "Swan" },
          ]}
        />
      </div>
      {state.settingsScope === "swan" ? (
        <SwanSettings />
      ) : state.settingsNew ? (
        <PersonaSettings key={NEW_PERSONA} draftKey={NEW_PERSONA} persona={null} />
      ) : persona ? (
        <PersonaSettings key={persona.id} draftKey={persona.id} persona={persona} />
      ) : (
        <div className="pane-body">
          <Empty
            title="No persona yet"
            action={
              <button type="button" className="btn primary" onClick={() => actions.openSettings("persona", { isNew: true })}>
                Create a persona
              </button>
            }
          >
            A persona sets the folders, hosts, credentials and rules the agent works with.
          </Empty>
        </div>
      )}
    </div>
  );
}

// ---------- Persona scope ----------

function blankConfig(): PersonaConfigView {
  return {
    name: "",
    description: "",
    instructions: "",
    folders: [],
    networkAllow: [],
    credentials: [],
    permissions: { default: "ask", allow: ["read_file", "list_dir", "glob", "grep", "load_skill"], ask: ["bash", "write_file", "edit_file"], deny: [] },
    skills: [],
    mcpServers: {},
    memory: { autoBrief: true, briefTokens: 2000 },
  };
}

const ID_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const HOST_RE = /^(\*\.)?[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)*(:\d{1,5})?$/i;

type Errors = Record<string, string>;

function cleaned(v: PersonaConfigView): PersonaConfigView {
  const x = clone(v);
  x.name = x.name.trim();
  x.networkAllow = x.networkAllow.map((h) => h.trim()).filter(Boolean);
  for (const k of ["allow", "ask", "deny"] as const) x.permissions[k] = x.permissions[k].map((r) => r.trim()).filter(Boolean);
  x.folders = x.folders.map((f) => ({ ...f, path: f.path.trim(), ...(f.mount ? { mount: f.mount.trim() } : {}) }));
  return x;
}

function validate(d: PersonaConfigView, isNew: boolean, newId: string, taken: boolean, mcpError: string | null): Errors {
  const e: Errors = {};
  if (isNew) {
    if (!newId) e.id = "Choose a file name for the persona.";
    else if (!ID_RE.test(newId)) e.id = "Use lowercase letters, digits and single dashes.";
    else if (taken) e.id = "A persona with this file name already exists.";
  }
  if (!d.name.trim()) e.name = "Name is required.";
  d.folders.forEach((f, i) => {
    if (!f.path.trim()) e[`folder${i}`] = "Enter a folder path on this Mac.";
    else if (f.mount && !/^\/workspace\/[^/]+$/.test(f.mount)) e[`folder${i}`] = "Mount must look like /workspace/<name>.";
  });
  d.networkAllow.forEach((h, i) => {
    if (!h.trim()) e[`host${i}`] = "Enter a host or remove the row.";
    else if (!HOST_RE.test(h.trim())) e[`host${i}`] = "Use a hostname, *.domain or host:port.";
  });
  if (!Number.isInteger(d.memory.briefTokens) || d.memory.briefTokens < 0) e.briefTokens = "Use a whole number of tokens.";
  if (mcpError) e.mcp = mcpError;
  return e;
}

/** Remembered open sections, shared across personas. */
const openSections = new Set<string>(["name"]);

function Section({
  id,
  title,
  summary,
  children,
  invalid,
}: {
  id: string;
  title: string;
  summary?: string;
  children: ReactNode;
  invalid?: boolean;
}) {
  const [open, setOpen] = useState(openSections.has(id) || !!invalid);
  const bodyId = useId();
  return (
    <section className={cls("set-section", open && "is-open")}>
      <button
        type="button"
        className="set-head"
        aria-expanded={open}
        aria-controls={bodyId}
        onClick={() => {
          if (open) openSections.delete(id);
          else openSections.add(id);
          setOpen(!open);
        }}
      >
        <IconChevronRight className="chev" size={16} />
        <span className="set-title">{title}</span>
        {invalid && <span className="status-text tone-error">Needs attention</span>}
        {!open && summary && !invalid && <span className="set-summary">{summary}</span>}
      </button>
      {open && (
        <div className="set-body" id={bodyId}>
          {children}
        </div>
      )}
    </section>
  );
}

function plural(n: number, w: string) {
  return `${n} ${w}${n === 1 ? "" : "s"}`;
}

function PersonaSettings({ draftKey, persona }: { draftKey: string; persona: PersonaSummary | null }) {
  const { state, actions } = useStore();
  const isNew = draftKey === NEW_PERSONA;
  const entry: SettingsDraft | undefined = state.drafts[draftKey];
  const [loading, setLoading] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [mcpText, setMcpText] = useState<string | null>(null);
  const [mcpError, setMcpError] = useState<string | null>(null);
  const [newModel, setNewModel] = useState<{ provider: string; id: string }>({ provider: "", id: "" });

  const load = async () => {
    if (!persona) return;
    setLoading(true);
    setLoadError(null);
    try {
      const base = await api.config(persona.id);
      actions.setDraft(draftKey, { base, draft: clone(base) });
    } catch (e) {
      setLoadError(isMissingEndpoint(e) ? "This server does not offer persona settings yet." : errorMessage(e));
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    if (entry) return;
    if (isNew) {
      const base = blankConfig();
      actions.setDraft(draftKey, { base, draft: clone(base), newId: "" });
    } else void load();
  }, [draftKey]); // eslint-disable-line react-hooks/exhaustive-deps

  // Model-provider keys are Swan's own; a persona never gets them. Untick any that the loaded config lists.
  const providerKeys = new Set<string>();
  for (const p of state.providers) {
    if (p.apiKeySecret) providerKeys.add(p.apiKeySecret);
    if (p.type === "copilot") providerKeys.add("COPILOT_GITHUB_TOKEN");
  }
  const providerKeyList = [...providerKeys].sort().join(",");
  useEffect(() => {
    if (!entry || providerKeys.size === 0) return;
    const bad = entry.draft.credentials.filter((c) => providerKeys.has(c));
    if (bad.length === 0) return;
    actions.setDraft(draftKey, {
      ...entry,
      draft: { ...entry.draft, credentials: entry.draft.credentials.filter((c) => !providerKeys.has(c)) },
      removedKeys: Array.from(new Set([...(entry.removedKeys ?? []), ...bad])),
    });
  }, [entry, providerKeyList]); // eslint-disable-line react-hooks/exhaustive-deps

  // Default model for a new persona: the first model whose provider is ready.
  useEffect(() => {
    if (!isNew || newModel.id) return;
    const m = state.models?.find((x) => x.ready) ?? state.models?.[0];
    if (m) setNewModel({ provider: m.provider, id: m.id });
  }, [isNew, state.models, newModel.id]);

  if (!entry) {
    return (
      <div className="pane-body">
        {loading || !loadError ? (
          <div className="pane-state">
            <Spinner size={14} /> Loading settings…
          </div>
        ) : (
          <Empty
            title="Settings unavailable"
            action={
              <button type="button" className="btn" onClick={() => void load()}>
                Try again
              </button>
            }
          >
            {loadError}
          </Empty>
        )}
      </div>
    );
  }

  const d = entry.draft;
  const newId = entry.newId ?? "";
  const dirty = isNew || !sameJson(entry.base, entry.draft);
  const errors = validate(d, isNew, newId, state.personas.some((p) => p.id === newId), mcpError);
  const errorCount = Object.keys(errors).length;
  const session = persona ? conversationSession(state, persona.id) : null;

  const update = (fn: (draft: PersonaConfigView) => void) => {
    const next = clone(d);
    fn(next);
    actions.setDraft(draftKey, { ...entry, draft: next, result: null, error: null });
  };

  const discard = () => {
    setMcpText(null);
    setMcpError(null);
    if (isNew) {
      actions.setDraft(draftKey, null);
      actions.setSettingsScope("persona");
      return;
    }
    actions.setDraft(draftKey, { base: entry.base, draft: clone(entry.base), removedKeys: entry.removedKeys });
  };

  const save = async () => {
    if (errorCount > 0 || saving) return;
    setSaving(true);
    const d = cleaned(entry.draft);
    try {
      if (isNew) {
        if (!newModel.provider || !newModel.id) throw new Error("Choose a model for the persona.");
        const yaml = toYaml({
          name: d.name.trim(),
          description: d.description,
          model: { provider: newModel.provider, id: newModel.id },
          instructions: d.instructions,
          folders: d.folders.map((f) => ({ path: f.path.trim(), ...(f.mount ? { mount: f.mount } : {}), mode: f.mode })),
          skills: d.skills,
          mcpServers: d.mcpServers,
          credentials: d.credentials,
          network: { allow: d.networkAllow.map((h) => h.trim()) },
          permissions: d.permissions,
        });
        const created = await actions.createPersona(newId, yaml);
        // Memory settings live outside the YAML template; apply them through the config view when available.
        try {
          await api.saveConfig(created.id, d);
        } catch {
          /* older server: defaults apply */
        }
        actions.setDraft(draftKey, null);
        actions.setSettingsScope("persona");
        actions.toast(
          created.errors.length ? "warn" : "success",
          created.errors.length ? `${created.name} was created but has problems: ${created.errors[0]}` : `${created.name} is ready.`,
          "Persona created",
        );
      } else if (persona) {
        const result = await actions.saveConfig(persona.id, d);
        let base = clone(d);
        try {
          base = await api.config(persona.id);
        } catch {
          /* keep what we sent */
        }
        setMcpText(null);
        actions.setDraft(draftKey, { base, draft: clone(base), result, error: null });
      }
    } catch (e) {
      actions.setDraft(draftKey, { ...entry, error: errorMessage(e) });
    } finally {
      setSaving(false);
    }
  };

  const allCreds = Array.from(new Set([...state.credentials.map((c) => c.name), ...d.credentials]))
    .filter((n) => !providerKeys.has(n))
    .sort();
  const allSkills = Array.from(new Set([...state.skills.map((s) => s.name), ...d.skills])).sort();
  const mcpValue = mcpText ?? JSON.stringify(d.mcpServers, null, 2);

  return (
    <>
      <div className="pane-body">
        <Section id="name" title="Name and instructions" summary={d.name} invalid={!!(errors.name || errors.id)}>
          {isNew && (
            <Field label="File name" error={errors.id} hint={`Saved as personas/${newId || "<name>"}.yaml`}>
              {(id) => (
                <input
                  id={id}
                  className="input mono"
                  value={newId}
                  placeholder="backend-dev"
                  spellCheck={false}
                  onChange={(e) =>
                    actions.setDraft(draftKey, { ...entry, newId: e.target.value.toLowerCase().replace(/[\s_]+/g, "-") })
                  }
                />
              )}
            </Field>
          )}
          <Field label="Name" error={errors.name}>
            {(id) => <input id={id} className="input" value={d.name} onChange={(e) => update((x) => void (x.name = e.target.value))} />}
          </Field>
          <Field label="Description">
            {(id) => (
              <input id={id} className="input" value={d.description} onChange={(e) => update((x) => void (x.description = e.target.value))} />
            )}
          </Field>
          <Field label="Instructions">
            {(id) => (
              <textarea
                id={id}
                className="input"
                rows={6}
                value={d.instructions}
                onChange={(e) => update((x) => void (x.instructions = e.target.value))}
              />
            )}
          </Field>
          {isNew && (
            <Field label="Model" hint="Change it later under the composer.">
              {(id) =>
                state.models && state.models.length > 0 ? (
                  <select
                    id={id}
                    className="input"
                    value={`${newModel.provider}\u0001${newModel.id}`}
                    onChange={(e) => {
                      const [provider, mid] = e.target.value.split("\u0001");
                      setNewModel({ provider, id: mid });
                    }}
                  >
                    {state.models.map((m) => (
                      <option key={`${m.provider}/${m.id}`} value={`${m.provider}\u0001${m.id}`}>
                        {m.label} · {m.provider}
                        {m.ready ? "" : " · needs key"}
                      </option>
                    ))}
                  </select>
                ) : (
                  <div className="row gap">
                    <input
                      id={id}
                      className="input"
                      placeholder="provider"
                      aria-label="Provider"
                      value={newModel.provider}
                      onChange={(e) => setNewModel({ ...newModel, provider: e.target.value })}
                    />
                    <input
                      className="input mono"
                      placeholder="model id"
                      aria-label="Model id"
                      value={newModel.id}
                      onChange={(e) => setNewModel({ ...newModel, id: e.target.value })}
                    />
                  </div>
                )
              }
            </Field>
          )}
        </Section>

        <Section
          id="folders"
          title="Folders"
          summary={d.folders.length ? plural(d.folders.length, "folder") : "None"}
          invalid={d.folders.some((_, i) => errors[`folder${i}`])}
        >
          <p className="hint">Only these folders are visible in the sandbox. Changes apply at the next container start.</p>
          {d.folders.map((f, i) => (
            <div key={i} className="folder-row">
              <div className="row gap">
                <label className="grow">
                  <span className="sr-only">Folder {i + 1} path on this Mac</span>
                  <input
                    className="input mono"
                    value={f.path}
                    placeholder="~/code/project"
                    aria-invalid={!!errors[`folder${i}`]}
                    onChange={(e) => update((x) => void (x.folders[i].path = e.target.value))}
                  />
                </label>
                <label>
                  <span className="sr-only">Access for folder {i + 1}</span>
                  <select
                    className="input"
                    value={f.mode}
                    onChange={(e) => update((x) => void (x.folders[i].mode = e.target.value as FolderMode))}
                  >
                    <option value="ro">Read-only</option>
                    <option value="rw">Read-write</option>
                  </select>
                </label>
                <button
                  type="button"
                  className="icon-btn"
                  aria-label={`Remove folder ${f.path || i + 1}`}
                  onClick={() => update((x) => void x.folders.splice(i, 1))}
                >
                  <IconTrash />
                </button>
              </div>
              <label className="row gap small">
                <span className="muted">Mounted at</span>
                <input
                  className="input mono sm grow"
                  value={f.mount ?? ""}
                  placeholder={`/workspace/${(f.path.split("/").filter(Boolean).pop() ?? "name").toLowerCase()}`}
                  onChange={(e) => update((x) => void (x.folders[i].mount = e.target.value || undefined))}
                />
              </label>
              {errors[`folder${i}`] && <span className="field-error">{errors[`folder${i}`]}</span>}
            </div>
          ))}
          <button type="button" className="link-btn" onClick={() => update((x) => void x.folders.push({ path: "", mode: "ro" }))}>
            <IconPlus /> Add folder
          </button>
          {persona && persona.folders.length > 0 && (
            <details className="mapping">
              <summary>Mac to sandbox mapping (saved)</summary>
              <ul>
                {persona.folders.map((f) => (
                  <li key={f.mountPath} className="mono small">
                    {f.hostPath} → {f.mountPath} · {f.mode === "rw" ? "read-write" : "read-only"}
                  </li>
                ))}
              </ul>
            </details>
          )}
        </Section>

        <Section
          id="hosts"
          title="Allowed hosts"
          summary={d.networkAllow.length ? plural(d.networkAllow.length, "host") : "None"}
          invalid={d.networkAllow.some((_, i) => errors[`host${i}`])}
        >
          <p className="hint">
            Hostnames or <span className="mono">*.domain</span>. <span className="mono">host:port</span> is always tunnelled and never
            gets credentials. Applies to the next request.
          </p>
          {d.networkAllow.map((h, i) => (
            <div key={i}>
              <div className="row gap">
                <label className="grow">
                  <span className="sr-only">Host {i + 1}</span>
                  <input
                    className="input mono"
                    value={h}
                    placeholder="api.github.com"
                    aria-invalid={!!errors[`host${i}`]}
                    onChange={(e) => update((x) => void (x.networkAllow[i] = e.target.value))}
                  />
                </label>
                <button
                  type="button"
                  className="icon-btn"
                  aria-label={`Remove host ${h || i + 1}`}
                  onClick={() => update((x) => void x.networkAllow.splice(i, 1))}
                >
                  <IconTrash />
                </button>
              </div>
              {errors[`host${i}`] && <span className="field-error">{errors[`host${i}`]}</span>}
            </div>
          ))}
          <button type="button" className="link-btn" onClick={() => update((x) => void x.networkAllow.push(""))}>
            <IconPlus /> Add host
          </button>
        </Section>

        <Section id="credentials" title="Credentials" summary={d.credentials.length ? plural(d.credentials.length, "credential") : "None"}>
          <p className="hint">The agent gets placeholders. Values are managed under Swan.</p>
          {(entry.removedKeys ?? []).map((k) => (
            <p key={k} className="hint">
              <span className="mono">{k}</span> is Swan's own model key; the agent never needs it.
            </p>
          ))}
          {allCreds.length === 0 && <p className="muted small">No credentials defined yet.</p>}
          {allCreds.map((name) => {
            const c = state.credentials.find((x) => x.name === name);
            const where = !c ? "not defined" : c.hosts.length ? c.hosts.join(", ") : "host-side only";
            return (
              <label key={name} className="check-row">
                <input
                  type="checkbox"
                  checked={d.credentials.includes(name)}
                  onChange={(e) =>
                    update((x) => {
                      x.credentials = e.target.checked ? [...x.credentials, name] : x.credentials.filter((n) => n !== name);
                    })
                  }
                />
                <span className="mono">{name}</span>
                <span className="muted small">· {where}</span>
                {c && !c.present && <span className="status-text tone-attention small">Missing value</span>}
              </label>
            );
          })}
        </Section>

        <Section id="permissions" title="Permissions" summary={`Default: ${d.permissions.default}`}>
          <p className="hint">
            Checked in order: deny, allow, ask, then the default. Rules look like <span className="mono">read_file</span>,{" "}
            <span className="mono">mcp__github__*</span> or <span className="mono">bash(git status*)</span>. Applies to the next call.
          </p>
          <Field label="Default for anything unmatched">
            {(id) => (
              <select
                id={id}
                className="input"
                value={d.permissions.default}
                onChange={(e) => update((x) => void (x.permissions.default = e.target.value as PermissionMode))}
              >
                <option value="allow">Allow</option>
                <option value="ask">Ask</option>
                <option value="deny">Deny</option>
              </select>
            )}
          </Field>
          {(["allow", "ask", "deny"] as const).map((k) => (
            <Field key={k} label={`${k[0].toUpperCase()}${k.slice(1)} (one rule per line)`}>
              {(id) => (
                <textarea
                  id={id}
                  className="input mono"
                  rows={Math.max(2, d.permissions[k].length + 1)}
                  value={d.permissions[k].join("\n")}
                  onChange={(e) =>
                    update((x) => void (x.permissions[k] = e.target.value.split("\n")))
                  }
                  onBlur={() => {
                    const clean = d.permissions[k].map((r) => r.trim()).filter(Boolean);
                    if (!sameJson(clean, d.permissions[k])) update((x) => void (x.permissions[k] = clean));
                  }}
                />
              )}
            </Field>
          ))}
          {persona && (
            <div className="allowances">
              <h4>Temporary allowances</h4>
              <p className="hint">From “Allow … until stopped”. They end when the agent stops or Swan restarts; they never edit the persona.</p>
              {!session || session.allowances.length === 0 ? (
                <p className="muted small">None active.</p>
              ) : (
                <>
                  <ul className="plain-list">
                    {session.allowances.map((rule) => (
                      <li key={rule} className="row gap">
                        {rule.startsWith("net:") ? (
                          <span className="grow">
                            Network: <span className="mono">{rule.slice(4)}</span>
                          </span>
                        ) : (
                          <span className="mono grow">{rule}</span>
                        )}
                        <button type="button" className="btn sm" onClick={() => void actions.removeAllowance(session.id, rule)}>
                          Remove
                        </button>
                      </li>
                    ))}
                  </ul>
                  <button type="button" className="btn sm" onClick={() => void actions.resetAllowances(session.id)}>
                    Reset temporary allowances
                  </button>
                </>
              )}
            </div>
          )}
        </Section>

        <Section
          id="tools"
          title="MCP servers and skills"
          summary={`${plural(Object.keys(d.mcpServers).length, "server")}, ${plural(d.skills.length, "skill")}`}
          invalid={!!errors.mcp}
        >
          <h4>Skills</h4>
          {allSkills.length === 0 && <p className="muted small">No skills installed.</p>}
          {allSkills.map((name) => {
            const s = state.skills.find((x) => x.name === name);
            return (
              <label key={name} className="check-row">
                <input
                  type="checkbox"
                  checked={d.skills.includes(name)}
                  onChange={(e) =>
                    update((x) => {
                      x.skills = e.target.checked ? [...x.skills, name] : x.skills.filter((n) => n !== name);
                    })
                  }
                />
                <span className="mono">{name}</span>
                <span className="muted small">· {s ? s.description : "not installed"}</span>
              </label>
            );
          })}
          <Field
            label="MCP servers (JSON)"
            error={errors.mcp}
            hint="stdio servers run in the sandbox and see placeholders; http servers run on the host."
          >
            {(id) => (
              <textarea
                id={id}
                className="input mono"
                rows={Math.min(14, Math.max(3, mcpValue.split("\n").length))}
                value={mcpValue}
                spellCheck={false}
                onChange={(e) => {
                  setMcpText(e.target.value);
                  try {
                    const v = JSON.parse(e.target.value || "{}") as unknown;
                    if (typeof v !== "object" || v === null || Array.isArray(v)) throw new Error("Use an object keyed by server name.");
                    setMcpError(null);
                    update((x) => void (x.mcpServers = v as Record<string, unknown>));
                  } catch (err) {
                    setMcpError(err instanceof SyntaxError ? "Not valid JSON yet." : errorMessage(err));
                  }
                }}
              />
            )}
          </Field>
        </Section>

        <Section id="memory" title="Memory" summary={d.memory.autoBrief ? "Brief on" : "Brief off"} invalid={!!errors.briefTokens}>
          <label className="check-row">
            <input type="checkbox" checked={d.memory.autoBrief} onChange={(e) => update((x) => void (x.memory.autoBrief = e.target.checked))} />
            <span>Load a memory brief at the start of each context</span>
          </label>
          <Field label="Brief size (tokens)" error={errors.briefTokens}>
            {(id) => (
              <input
                id={id}
                className="input"
                type="number"
                min={0}
                step={100}
                value={Number.isFinite(d.memory.briefTokens) ? d.memory.briefTokens : ""}
                onChange={(e) => update((x) => void (x.memory.briefTokens = e.target.value === "" ? Number.NaN : Number(e.target.value)))}
              />
            )}
          </Field>
          <p className="hint">Memory is private to this persona. Review it in Memory &amp; Usage.</p>
        </Section>
      </div>

      <div className="pane-foot" aria-live="polite">
        {entry.error && (
          <p className="foot-error" role="alert">
            Not saved: {entry.error}
          </p>
        )}
        {!dirty && entry.result && <SaveSummary result={entry.result} />}
        {dirty && (
          <div className="row gap">
            <span className="grow tone-attention">
              {errorCount > 0 ? `Fix ${plural(errorCount, "field")} to save` : isNew ? "New persona, not saved" : "Unsaved changes"}
            </span>
            <button type="button" className="btn" onClick={discard} disabled={saving}>
              Discard
            </button>
            <button type="button" className="btn primary" onClick={() => void save()} disabled={saving || errorCount > 0}>
              {saving && <Spinner size={12} />}
              {isNew ? "Create persona" : "Save changes"}
            </button>
          </div>
        )}
        {!dirty && !entry.result && <span className="muted small">All changes saved.</span>}
      </div>
    </>
  );
}

function SaveSummary({ result }: { result: NonNullable<SettingsDraft["result"]> }) {
  const { state } = useStore();
  // Use the live persona, so a problem fixed since the save is not shown.
  const live = state.personas.find((p) => p.id === result.persona.id) ?? result.persona;
  return (
    <div className="save-summary">
      <p>
        <strong>Saved.</strong>
        {result.appliedNow.length > 0 && ` Applied now: ${result.appliedNow.join(", ")}.`}
        {result.nextStart.length > 0 && ` At the next safe start: ${result.nextStart.join(", ")}.`}
      </p>
      {(result.notes ?? []).map((n, i) => (
        <p key={i} className="muted">
          {n}
        </p>
      ))}
      {live.errors.length > 0 && (
        <p className="tone-attention">
          Still to fix before {live.name} can start: {live.errors.join("; ")}
        </p>
      )}
    </div>
  );
}

function Field({
  label,
  hint,
  error,
  children,
}: {
  label: string;
  hint?: string;
  error?: string;
  children: (id: string) => ReactNode;
}) {
  const id = useId();
  return (
    <div className="field">
      <label className="field-label" htmlFor={id}>
        {label}
      </label>
      {children(id)}
      {hint && !error && <span className="hint">{hint}</span>}
      {error && <span className="field-error">{error}</span>}
    </div>
  );
}
