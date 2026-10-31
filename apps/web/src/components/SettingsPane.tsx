import { useEffect, useId, useRef, useState, type ReactNode } from "react";
import type { ConnectionStatus, CredentialRule, FolderMode, ModelOption, PermissionMode, PersonaConfigView, PersonaSummary, RuleApi, SubagentsConfig } from "@ph/shared";
import { api } from "../api";
import { conversationSession, NEW_PERSONA, useSelectedPersona, useStore, type SettingsDraft } from "../store";
import { allowanceLabel, CONNECTION_STATE, isCredentialAllowance, RULE_API_LABEL, RULE_APIS, RULE_PRESETS } from "../status";
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
    connections: {},
    permissions: { default: "ask", allow: ["read_file", "list_dir", "glob", "grep", "load_skill"], ask: ["bash", "write_file", "edit_file"], deny: [] },
    skills: [],
    mcpServers: {},
    memory: { autoBrief: true, briefTokens: 2000 },
    subagents: subagentDefaults(),
  };
}

function subagentDefaults(): SubagentsConfig {
  return { agents: [], maxBackground: 4, maxTurns: 200 };
}

/** A server from before sub-agents sends no `subagents`; edit the defaults instead. */
function withDefaults(v: PersonaConfigView): PersonaConfigView {
  return v.subagents ? v : { ...v, subagents: subagentDefaults() };
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
  x.subagents.agents = x.subagents.agents.map((a) => ({ name: a.name.trim(), model: a.model.trim() }));
  for (const pc of Object.values(x.connections))
    pc.rules = pc.rules.map((r) => ({
      ...r,
      credential: r.credential.trim(),
      allow: patterns(r.allow),
      ask: patterns(r.ask),
      deny: patterns(r.deny),
    }));
  return x;
}

function patterns(list: string[] | undefined): string[] {
  return (list ?? []).map((p) => p.trim()).filter(Boolean);
}

const RULE_CREDENTIAL_RE = /^[A-Za-z0-9_*?-]{1,64}$/;
const SUBAGENT_NAME_RE = /^[a-z0-9-]+$/;
const MODEL_REF_RE = /^[^/\s]+\/\S+$/;

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
  for (const [conn, pc] of Object.entries(d.connections))
    pc.rules.forEach((r, i) => {
      const c = r.credential.trim();
      if (!c) e[`rule-${conn}-${i}`] = "Choose a credential or enter a pattern.";
      else if (!RULE_CREDENTIAL_RE.test(c)) e[`rule-${conn}-${i}`] = "Use a credential name or a pattern with * and ?.";
    });
  const agentNames = new Set<string>();
  d.subagents.agents.forEach((a, i) => {
    const n = a.name.trim();
    const m = a.model.trim();
    if (!n) e[`sa-${i}`] = "Enter a name or remove the row.";
    else if (!SUBAGENT_NAME_RE.test(n) || n.length > 32) e[`sa-${i}`] = "Use lowercase letters, digits and dashes, at most 32.";
    else if (n.startsWith("-")) e[`sa-${i}`] = "Start the name with a letter or digit.";
    else if (n === "auto") e[`sa-${i}`] = "“auto” is reserved. Choose another name.";
    else if (agentNames.has(n)) e[`sa-${i}`] = "Another sub-agent has this name.";
    else if (m !== "auto" && !MODEL_REF_RE.test(m)) e[`sa-${i}`] = "Use provider/model, or auto.";
    agentNames.add(n);
  });
  const bg = d.subagents.maxBackground;
  if (!Number.isInteger(bg) || bg < 0 || bg > 32) e.maxBackground = "Use a whole number from 0 to 32.";
  const turns = d.subagents.maxTurns;
  if (!Number.isInteger(turns) || turns < 1 || turns > 1000) e.maxTurns = "Use a whole number from 1 to 1000.";
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
  reveal,
}: {
  id: string;
  title: string;
  summary?: string;
  children: ReactNode;
  invalid?: boolean;
  /** Changing this opens the section. */
  reveal?: number;
}) {
  const [open, setOpen] = useState(openSections.has(id) || !!invalid);
  const bodyId = useId();
  useEffect(() => {
    if (!reveal) return;
    openSections.add(id);
    setOpen(true);
  }, [reveal]); // eslint-disable-line react-hooks/exhaustive-deps
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
  const [hostBusy, setHostBusy] = useState<string | null>(null);
  const [mcpText, setMcpText] = useState<string | null>(null);
  const [mcpError, setMcpError] = useState<string | null>(null);
  const [newModel, setNewModel] = useState<{ provider: string; id: string }>({ provider: "", id: "" });

  const load = async () => {
    if (!persona) return;
    setLoading(true);
    setLoadError(null);
    try {
      const base = withDefaults(await api.config(persona.id));
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

  // "Add rule…" from a blocked-request notice: add the rule to the draft once it is loaded, then show it.
  const [reveal, setReveal] = useState<{ id: string; n: number } | null>(null);
  const focus = state.settingsFocus;
  useEffect(() => {
    if (!entry || !persona || !focus || focus.personaId !== persona.id) return;
    actions.clearSettingsFocus();
    if (!focus.rule) {
      setReveal({ id: "", n: focus.seq });
      return;
    }
    const { connection, rule } = focus.rule;
    const rules = entry.draft.connections[connection]?.rules ?? [];
    const wanted = rule.allow ?? [];
    let idx = rules.findIndex((r) => r.credential === rule.credential && r.api === rule.api && wanted.every((p) => (r.allow ?? []).includes(p)));
    if (idx < 0) {
      idx = rules.length;
      const draft = clone(entry.draft);
      (draft.connections[connection] ??= { rules: [] }).rules.push(clone(rule));
      actions.setDraft(draftKey, { ...entry, draft, result: null, error: null });
    }
    setReveal({ id: `rule-${connection}-${idx}`, n: focus.seq });
  }, [entry, focus]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => {
    if (!reveal?.id) return;
    const t = window.setTimeout(() => {
      const el = document.getElementById(reveal.id);
      if (!el) return;
      el.scrollIntoView({ block: "center", behavior: "smooth" });
      el.querySelector<HTMLElement>("textarea, select, input")?.focus({ preventScroll: true });
      el.classList.add("flash");
      window.setTimeout(() => el.classList.remove("flash"), 1600);
    }, 60);
    return () => window.clearTimeout(t);
  }, [reveal]);

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
  const netAllowances = (session?.allowances ?? []).filter((r) => r.startsWith("net:"));
  const credAllowances = (session?.allowances ?? []).filter(isCredentialAllowance);
  const toolAllowances = (session?.allowances ?? []).filter((r) => !r.startsWith("net:") && !isCredentialAllowance(r));

  /** Keep a host approved "until stopped": save it to the persona now, then drop the temporary allowance. */
  const keepHost = async (sessionId: string, rule: string) => {
    if (!persona) return;
    const host = rule.slice(4);
    setHostBusy(rule);
    try {
      if (!entry.base.networkAllow.includes(host)) {
        const nextBase = clone(entry.base);
        nextBase.networkAllow.push(host);
        const result = await actions.saveConfig(persona.id, nextBase);
        let base = nextBase;
        try {
          base = withDefaults(await api.config(persona.id));
        } catch {
          /* keep what we sent */
        }
        // Unsaved edits stay a draft; the kept host joins them.
        const draft = clone(entry.draft);
        if (!draft.networkAllow.includes(host)) draft.networkAllow.push(host);
        actions.setDraft(draftKey, { ...entry, base, draft, result, error: null });
      }
      await actions.removeAllowance(sessionId, rule);
    } catch (e) {
      actions.reportError(e, `Could not keep ${host}`);
    } finally {
      setHostBusy(null);
    }
  };

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
    actions.setDraft(draftKey, { base: entry.base, draft: clone(entry.base) });
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
          connections: d.connections,
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
          base = withDefaults(await api.config(persona.id));
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
          summary={
            d.networkAllow.length + netAllowances.length
              ? [d.networkAllow.length && plural(d.networkAllow.length, "host"), netAllowances.length && `${netAllowances.length} until stopped`]
                  .filter(Boolean)
                  .join(", ")
              : "None"
          }
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
          {netAllowances.length > 0 && session && (
            <div className="approved-hosts">
              <h4>Approved in the conversation</h4>
              <p className="hint">Allowed until the agent is stopped. Keep saves the host to this persona now.</p>
              <ul className="plain-list">
                {netAllowances.map((rule) => {
                  const host = rule.slice(4);
                  const busy = hostBusy === rule;
                  return (
                    <li key={rule} className="row gap">
                      <span className="grow">
                        <span className="mono">{host}</span> <span className="muted small">· until stopped</span>
                      </span>
                      {busy && <Spinner size={10} />}
                      <button type="button" className="btn sm" disabled={!!hostBusy} onClick={() => void keepHost(session.id, rule)}>
                        Keep
                      </button>
                      <button
                        type="button"
                        className="btn sm"
                        disabled={!!hostBusy}
                        onClick={async () => {
                          setHostBusy(rule);
                          await actions.removeAllowance(session.id, rule);
                          setHostBusy(null);
                        }}
                      >
                        Remove
                      </button>
                    </li>
                  );
                })}
              </ul>
            </div>
          )}
        </Section>

        <Section
          id="connections"
          title="Connections"
          summary={
            Object.keys(d.connections).length + credAllowances.length
              ? [
                  Object.keys(d.connections).length && plural(Object.keys(d.connections).length, "connection"),
                  credAllowances.length && `${credAllowances.length} until stopped`,
                ]
                  .filter(Boolean)
                  .join(", ")
              : "None"
          }
          invalid={Object.keys(errors).some((k) => k.startsWith("rule-"))}
          reveal={reveal?.n}
        >
          <p className="hint">
            Rules say what each credential may be used for. Checked deny, then ask, then allow; a request nothing allows goes out
            without the credential. Values are managed under Swan.
          </p>
          {Object.entries(d.connections).map(([conn, pc]) => (
            <ConnectionRules
              key={conn}
              name={conn}
              rules={pc.rules}
              status={state.connections.find((c) => c.name === conn)}
              errors={errors}
              onChange={(fn) => update((x) => fn(x.connections[conn].rules))}
              onRemove={() => update((x) => void delete x.connections[conn])}
            />
          ))}
          <AddConnection
            used={Object.keys(d.connections)}
            onAdd={(c) => update((x) => void (x.connections[c.name] = { rules: [newRule(c)] }))}
          />
          {credAllowances.length > 0 && session && (
            <div className="approved-hosts">
              <h4>Allowed in the conversation</h4>
              <p className="hint">From “Allow until stopped”. They end when the agent stops and never edit the persona.</p>
              <ul className="plain-list">
                {credAllowances.map((rule) => (
                  <li key={rule} className="row gap">
                    <span className="grow mono small">{allowanceLabel(rule)}</span>
                    <button type="button" className="btn sm" onClick={() => void actions.removeAllowance(session.id, rule)}>
                      Remove
                    </button>
                  </li>
                ))}
              </ul>
            </div>
          )}
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
              <p className="hint">
                From “Allow … until stopped”. They end when the agent stops or Swan restarts; they never edit the persona. Hosts and
                credential uses approved this way are listed under Allowed hosts and Connections.
              </p>
              {!session || toolAllowances.length === 0 ? (
                <p className="muted small">None active.</p>
              ) : (
                <>
                  <ul className="plain-list">
                    {toolAllowances.map((rule) => (
                      <li key={rule} className="row gap">
                        <span className="mono grow">{allowanceLabel(rule)}</span>
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
          id="subagents"
          title="Sub-agents"
          summary={`${d.subagents.agents.length ? plural(d.subagents.agents.length, "sub-agent") : "None"} · ${
            Number.isFinite(d.subagents.maxBackground) ? d.subagents.maxBackground : "?"
          } at once`}
          invalid={Object.keys(errors).some((k) => k.startsWith("sa-")) || !!errors.maxBackground || !!errors.maxTurns}
        >
          <div className="field">
            <span className="field-label">Sub-agents</span>
            {d.subagents.agents.map((a, i) => (
              <SubagentRow
                key={i}
                index={i}
                name={a.name}
                model={a.model}
                models={state.models}
                error={errors[`sa-${i}`]}
                onName={(v) => update((x) => void (x.subagents.agents[i].name = v))}
                onModel={(v) => update((x) => void (x.subagents.agents[i].model = v))}
                onRemove={() => update((x) => void x.subagents.agents.splice(i, 1))}
              />
            ))}
            <button type="button" className="link-btn" onClick={() => update((x) => void x.subagents.agents.push({ name: "", model: "auto" }))}>
              <IconPlus /> Add sub-agent
            </button>
            <p className="hint">Auto lets the agent choose the model and effort for each task.</p>
          </div>
          <Field label="Background agents at once" error={errors.maxBackground}>
            {(id) => (
              <input
                id={id}
                className="input short"
                type="number"
                min={0}
                max={32}
                value={Number.isFinite(d.subagents.maxBackground) ? d.subagents.maxBackground : ""}
                aria-invalid={!!errors.maxBackground}
                onChange={(e) => update((x) => void (x.subagents.maxBackground = e.target.value === "" ? Number.NaN : Number(e.target.value)))}
              />
            )}
          </Field>
          <Field label="Most turns per agent" error={errors.maxTurns}>
            {(id) => (
              <input
                id={id}
                className="input short"
                type="number"
                min={1}
                max={1000}
                value={Number.isFinite(d.subagents.maxTurns) ? d.subagents.maxTurns : ""}
                aria-invalid={!!errors.maxTurns}
                onChange={(e) => update((x) => void (x.subagents.maxTurns = e.target.value === "" ? Number.NaN : Number(e.target.value)))}
              />
            )}
          </Field>
          <p className="hint">
            The agent picks a sub-agent, its context and turns for each task, within these limits. Sub-agents can't start sub-agents.
          </p>
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

// ---------- Sub-agents ----------

function SubagentRow({
  index,
  name,
  model,
  models,
  error,
  onName,
  onModel,
  onRemove,
}: {
  index: number;
  name: string;
  model: string;
  models: ModelOption[] | null;
  error?: string;
  onName: (v: string) => void;
  onModel: (v: string) => void;
  onRemove: () => void;
}) {
  const nameId = useId();
  const modelId = useId();
  const label = name.trim() || `sub-agent ${index + 1}`;
  const listed = models?.some((m) => `${m.provider}/${m.id}` === model) ?? false;
  return (
    <div className="folder-row">
      <div className="row gap even">
        <label htmlFor={nameId} className="sr-only">
          Name of sub-agent {index + 1}
        </label>
        <input
          id={nameId}
          className="input mono"
          value={name}
          placeholder="researcher"
          maxLength={32}
          spellCheck={false}
          aria-invalid={!!error}
          onChange={(e) => onName(e.target.value.toLowerCase().replace(/[\s_]+/g, "-"))}
        />
        <label htmlFor={modelId} className="sr-only">
          Model for {label}
        </label>
        {models && models.length > 0 ? (
          <select id={modelId} className="input" value={model} onChange={(e) => onModel(e.target.value)}>
            <option value="auto">Auto</option>
            {!listed && model !== "auto" && <option value={model}>{model}</option>}
            {models.map((m) => (
              <option key={`${m.provider}/${m.id}`} value={`${m.provider}/${m.id}`}>
                {m.label} · {m.provider}
                {m.ready ? "" : " · needs key"}
              </option>
            ))}
          </select>
        ) : (
          <input
            id={modelId}
            className="input mono"
            value={model}
            placeholder="provider/model or auto"
            spellCheck={false}
            onChange={(e) => onModel(e.target.value)}
          />
        )}
        <button type="button" className="icon-btn" aria-label={`Remove sub-agent ${name.trim() || index + 1}`} onClick={onRemove}>
          <IconTrash />
        </button>
      </div>
      {error && <span className="field-error">{error}</span>}
    </div>
  );
}

// ---------- Connections ----------

const CUSTOM = "\u0001custom";

const PATTERN_HINT: Record<RuleApi, string> = {
  kubernetes: "verb resource[/sub] [in namespace], e.g. get pods in payments",
  aws: "service:Action, e.g. s3:GetObject or logs:Describe*",
  http: "METHOD /path, with * for one segment and ** for any, e.g. GET /repos/**",
};

function newRule(c: ConnectionStatus | undefined, credential?: string): CredentialRule {
  const name = credential ?? c?.credentials[0]?.name ?? "*";
  const kind = c?.credentials.find((x) => x.name === name)?.kind;
  return { credential: name, api: kind === "aws-sigv4" ? "aws" : "http", allow: [], ask: [], deny: [] };
}

function AddConnection({ used, onAdd }: { used: string[]; onAdd: (c: ConnectionStatus) => void }) {
  const { state } = useStore();
  const free = state.connections.filter((c) => !used.includes(c.name));
  if (state.connections.length === 0) return <p className="muted small">No connections yet. Add credentials under Swan.</p>;
  if (free.length === 0) return null;
  return (
    <label>
      <span className="sr-only">Add connection</span>
      <select
        className="input"
        value=""
        onChange={(e) => {
          const c = free.find((x) => x.name === e.target.value);
          if (c) onAdd(c);
        }}
      >
        <option value="">Add connection…</option>
        {free.map((c) => (
          <option key={c.name} value={c.name}>
            {c.name} · {c.type}
          </option>
        ))}
      </select>
    </label>
  );
}

function ConnectionRules({
  name,
  rules,
  status,
  errors,
  onChange,
  onRemove,
}: {
  name: string;
  rules: CredentialRule[];
  status: ConnectionStatus | undefined;
  errors: Errors;
  onChange: (fn: (rules: CredentialRule[]) => void) => void;
  onRemove: () => void;
}) {
  const st = status ? CONNECTION_STATE[status.state] : null;
  return (
    <div className="folder-row">
      <div className="row gap">
        <span className="grow">
          <span className="mono strong">{name}</span>
          {status && st && (
            <span className="muted small">
              {" "}
              · {status.type} · <span className={st.tone === "ok" ? undefined : `tone-${st.tone}`}>{st.label}</span>
            </span>
          )}
        </span>
        <button type="button" className="icon-btn" aria-label={`Remove connection ${name}`} onClick={onRemove}>
          <IconTrash />
        </button>
      </div>
      {!status && <span className="field-error">Not defined in config.yaml; these rules do nothing.</span>}
      {rules.length === 0 && <p className="muted small">No rules: requests go out without these credentials.</p>}
      {rules.map((r, i) => (
        <RuleEditor
          key={i}
          id={`rule-${name}-${i}`}
          rule={r}
          status={status}
          error={errors[`rule-${name}-${i}`]}
          onChange={(fn) => onChange((rs) => fn(rs[i]))}
          onRemove={() => onChange((rs) => void rs.splice(i, 1))}
        />
      ))}
      <button
        type="button"
        className="link-btn"
        onClick={() => {
          const next = status?.credentials.find((c) => !rules.some((r) => r.credential === c.name))?.name ?? "*";
          onChange((rs) => void rs.push(newRule(status, next)));
        }}
      >
        <IconPlus /> Add rule
      </button>
    </div>
  );
}

function RuleEditor({
  id,
  rule,
  status,
  error,
  onChange,
  onRemove,
}: {
  id: string;
  rule: CredentialRule;
  status: ConnectionStatus | undefined;
  error?: string;
  onChange: (fn: (r: CredentialRule) => void) => void;
  onRemove: () => void;
}) {
  const names = status?.credentials.map((c) => c.name) ?? [];
  const known = rule.credential === "*" || names.includes(rule.credential);
  const [custom, setCustom] = useState(!known);
  const showInput = custom || !known;
  const label = rule.credential || "new rule";
  const presets = RULE_PRESETS[rule.api];
  const inputRef = useRef<HTMLInputElement>(null);
  useEffect(() => {
    if (custom && known) inputRef.current?.focus();
  }, [custom]); // eslint-disable-line react-hooks/exhaustive-deps
  return (
    <div className="rule-edit" id={id}>
      <div className="row gap wrap">
        <label>
          <span className="sr-only">Credential for rule {label}</span>
          <select
            className="input"
            value={showInput ? CUSTOM : rule.credential}
            onChange={(e) => {
              const v = e.target.value;
              if (v === CUSTOM) setCustom(true);
              else {
                setCustom(false);
                onChange((r) => void (r.credential = v));
              }
            }}
          >
            {names.map((n) => (
              <option key={n} value={n}>
                {n}
              </option>
            ))}
            <option value="*">Every credential (*)</option>
            <option value={CUSTOM}>Name or pattern…</option>
          </select>
        </label>
        <label>
          <span className="sr-only">API for rule {label}</span>
          <select className="input" value={rule.api} onChange={(e) => onChange((r) => void (r.api = e.target.value as RuleApi))}>
            {RULE_APIS.map((a) => (
              <option key={a} value={a}>
                {RULE_API_LABEL[a]}
              </option>
            ))}
          </select>
        </label>
        <label>
          <span className="sr-only">Apply a preset to rule {label}</span>
          <select
            className="input"
            value=""
            onChange={(e) => {
              const p = presets[e.target.value];
              if (p) onChange((r) => Object.assign(r, clone(p)));
            }}
          >
            <option value="">Preset…</option>
            {Object.keys(presets).map((k) => (
              <option key={k} value={k}>
                {k}
              </option>
            ))}
          </select>
        </label>
      </div>
      {showInput && (
        <label>
          <span className="sr-only">Credential name or pattern for rule {label}</span>
          <input
            ref={inputRef}
            className="input mono sm"
            value={rule.credential}
            placeholder="name, or a pattern like prod-*"
            spellCheck={false}
            aria-invalid={!!error}
            onChange={(e) => onChange((r) => void (r.credential = e.target.value))}
          />
        </label>
      )}
      {error && <span className="field-error">{error}</span>}
      {(["allow", "ask", "deny"] as const).map((k) => {
        const list = rule[k] ?? [];
        return (
          <Field key={k} label={`${k[0].toUpperCase()}${k.slice(1)}`}>
            {(fid) => (
              <textarea
                id={fid}
                className="input mono"
                rows={Math.min(8, list.length + 1)}
                value={list.join("\n")}
                spellCheck={false}
                onChange={(e) => onChange((r) => void (r[k] = e.target.value.split("\n")))}
                onBlur={() => {
                  const clean = patterns(list);
                  if (!sameJson(clean, list)) onChange((r) => void (r[k] = clean));
                }}
              />
            )}
          </Field>
        );
      })}
      <div className="row gap">
        <p className="hint grow">One pattern per line: {PATTERN_HINT[rule.api]}.</p>
        <button type="button" className="link-btn line-action" aria-label={`Remove rule ${label}`} onClick={onRemove}>
          Remove rule
        </button>
      </div>
    </div>
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
