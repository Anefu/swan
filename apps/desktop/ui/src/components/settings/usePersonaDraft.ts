import { useEffect, useRef, useState } from "react";
import type { PersonaConfigView, PersonaSummary } from "@ph/shared";
import { api } from "../../api";
import { NEW_PERSONA, useStore, type SettingsDraft } from "../../store";
import { clone, errorMessage, isMissingEndpoint, sameJson } from "../../util";
import { toYaml } from "../../yaml";
import { blankConfig, cleaned, validate, withDefaults } from "./config";

/**
 * A persona's settings form: the draft (kept in the store, so it survives switching panes), loaded
 * and followed while the file changes elsewhere, and saved or discarded.
 */
export function usePersonaDraft(draftKey: string, persona: PersonaSummary | null) {
  const { state, actions } = useStore();
  const isNew = draftKey === NEW_PERSONA;
  const entry: SettingsDraft | undefined = state.drafts[draftKey];
  const [loading, setLoading] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [mcpText, setMcpText] = useState<string | null>(null);
  const [mcpError, setMcpError] = useState<string | null>(null);
  const [newModel, setNewModel] = useState<{ provider: string; id: string }>({ provider: "", id: "" });
  /** Bumped when the draft is replaced (discard, save), so open folder editors close. */
  const [foldersSeq, setFoldersSeq] = useState(0);

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

  // The persona file also changes outside this form: "Always allow" on a request adds a host, and an
  // editor or the Copilot model menu can change it. Follow it, and never let a stale form overwrite it.
  const entryRef = useRef(entry);
  entryRef.current = entry;
  const refresh = async () => {
    if (!persona || isNew) return;
    let fresh: PersonaConfigView;
    try {
      fresh = withDefaults(await api.config(persona.id));
    } catch {
      return;
    }
    const cur = entryRef.current;
    if (!cur || sameJson(cur.base, fresh)) return;
    if (sameJson(cur.base, cur.draft)) {
      actions.setDraft(draftKey, { base: fresh, draft: clone(fresh) });
      setFoldersSeq((n) => n + 1);
    } else actions.setDraft(draftKey, { ...cur, base: fresh, outdated: true });
  };

  useEffect(() => {
    if (entry) {
      void refresh(); // a form kept from earlier may be out of date
      return;
    }
    if (isNew) {
      const base = blankConfig();
      actions.setDraft(draftKey, { base, draft: clone(base), newId: "" });
    } else void load();
  }, [draftKey]); // eslint-disable-line react-hooks/exhaustive-deps

  const summaryKey = persona ? JSON.stringify(persona) : "";
  useEffect(() => {
    if (entryRef.current) void refresh();
  }, [summaryKey]); // eslint-disable-line react-hooks/exhaustive-deps

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


  const newId = entry?.newId ?? "";
  const dirty = isNew || (!!entry && !sameJson(entry.base, entry.draft));
  const errors = entry ? validate(entry.draft, isNew, newId, state.personas.some((p) => p.id === newId), mcpError) : {};
  const errorCount = Object.keys(errors).length;

  /** Keep a host approved "until stopped": save it to the persona now, then drop the temporary allowance. */
  const keepHost = async (sessionId: string, rule: string) => {
    if (!persona || !entry) return;
    const host = rule.slice(4);
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
    }
  };

  const update = (fn: (draft: PersonaConfigView) => void) => {
    if (!entry) return;
    const next = clone(entry.draft);
    fn(next);
    actions.setDraft(draftKey, { ...entry, draft: next, result: null, error: null });
  };

  const discard = () => {
    if (!entry) return;
    setMcpText(null);
    setMcpError(null);
    setFoldersSeq((n) => n + 1);
    if (isNew) {
      actions.setDraft(draftKey, null);
      actions.openSettings();
      return;
    }
    actions.setDraft(draftKey, { base: entry.base, draft: clone(entry.base) });
  };

  const save = async () => {
    if (!entry || errorCount > 0 || saving) return;
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
          network: { allow: d.networkAllow.map((h) => h.trim()), ...(d.networkInternal.length ? { internal: d.networkInternal.map((h) => h.trim()) } : {}), ...(d.networkOtherCredentials?.length ? { otherCredentials: d.networkOtherCredentials.map((h) => h.trim()) } : {}) },
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
        actions.openSettings();
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
        setFoldersSeq((n) => n + 1);
        actions.setDraft(draftKey, { base, draft: clone(base), result, error: null });
      }
    } catch (e) {
      actions.setDraft(draftKey, { ...entry, error: errorMessage(e) });
    } finally {
      setSaving(false);
    }
  };


  return {
    entry,
    isNew,
    loading,
    loadError,
    load,
    saving,
    save,
    discard,
    update,
    keepHost,
    errors,
    errorCount,
    dirty,
    newId,
    setNewId: (id: string) => entry && actions.setDraft(draftKey, { ...entry, newId: id }),
    newModel,
    setNewModel,
    mcp: { text: mcpText, setText: setMcpText, setError: setMcpError },
    foldersSeq,
    reveal: reveal?.n,
  };
}
