// What the UI can do: requests to the server, and the state changes they lead to.
import type { Dispatch, MutableRefObject } from "react";
import type { ApprovalBody, ChatItem, ConnectionStatus, CredentialRule, CredentialUpsert, Effort, PendingApproval, PersonaConfigView, PersonaSummary, SaveResult, SessionSummary } from "@ph/shared";
import { api, ApiError, uploadAttachment, type ConnectionAction } from "../api";
import { errorMessage, isMissingEndpoint } from "../util";
import { EventSocket } from "../ws";
import { type ToastKind, type DockMode, type MemoryPaneState, type SettingsDraft, type DraftAttachment, MAX_ATTACHMENT_BYTES, MAX_ATTACHMENTS, attachmentPreviews, type NetworkFilters, type State } from "./state";
import type { Action } from "./reducer";
import { pendingApprovals } from "./selectors";

let attachSeq = 0;
/** Never reused, so each "Add rule…" reopens the section even after the previous focus was cleared. */
let focusSeq = 0;
const uploads = new Map<string, () => void>();

function readBase64(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => {
      const url = String(r.result ?? "");
      resolve(url.slice(url.indexOf(",") + 1));
    };
    r.onerror = () => reject(new Error("Could not read the file"));
    r.readAsDataURL(file);
  });
}

export interface Actions {
  getState(): State;
  toast(kind: ToastKind, text: string, title?: string): void;
  dismissToast(id: number): void;
  reportError(e: unknown, context?: string): void;
  retryConnection(): void;

  selectPersona(id: string): void;
  toggleDock(mode: DockMode): void;
  openDock(mode: DockMode | null): void;
  setDockWidth(mode: DockMode, width: number): void;
  /** The selected persona's settings, or the new-persona draft; `section` opens one section instead of the list. */
  openSettings(opts?: { isNew?: boolean; section?: string }): void;
  setSettingsSection(section: string | null): void;
  /** Swan's own settings: providers, connections and the sandbox. */
  openSwanSettings(): void;
  /** Read a persona file and open the import pane on it. */
  startImport(file: File): Promise<void>;
  closeImport(): void;
  /** Open this persona's Connections settings with `rule` added to the draft. */
  addRuleInSettings(personaId: string, connection: string, rule: CredentialRule): void;
  clearSettingsFocus(): void;
  setDraft(key: string, draft: SettingsDraft | null): void;
  setMemoryPane(personaId: string, patch: Partial<MemoryPaneState>): void;
  openUsage(): void;
  setComposer(personaId: string, text: string): void;
  setNetwork(patch: Partial<NetworkFilters>): void;
  openPersonaMenu(): void;
  jumpToApproval(a?: PendingApproval): void;
  jumpToItem(personaId: string, itemId: string, sessionId?: string): void;

  loadConversation(personaId: string): Promise<void>;
  openConversation(personaId: string, sessionId: string): Promise<void>;
  /** Opens an empty conversation of the persona, starting one only if it has none. */
  newConversation(personaId: string): Promise<void>;
  renameConversation(sessionId: string, title: string): Promise<boolean>;
  /** A copy of the conversation to take in another direction; it opens once made. */
  forkConversation(personaId: string, sessionId: string): Promise<boolean>;
  /** Removes it; the persona's latest conversation opens instead. */
  deleteConversation(personaId: string, sessionId: string): Promise<boolean>;
  refreshEgress(): Promise<void>;
  refreshProviders(): Promise<void>;
  refreshModels(): Promise<void>;

  sendMessage(sessionId: string, text: string, attachmentIds?: string[]): Promise<boolean>;
  addAttachments(personaId: string, files: File[]): void;
  removeAttachment(personaId: string, key: string): void;
  clearAttachments(personaId: string, keys: string[]): void;
  interrupt(sessionId: string): Promise<void>;
  /** agentId "all" stops every sub-agent of the session; false when the request failed. */
  stopAgent(sessionId: string, agentId: string): Promise<boolean>;
  approve(sessionId: string, toolUseId: string, body: ApprovalBody): Promise<boolean>;
  removeAllowance(sessionId: string, rule: string): Promise<void>;
  resetAllowances(sessionId: string): Promise<void>;
  setModel(personaId: string, body: { provider: string; id: string; effort?: Effort }): Promise<void>;

  /** These throw so forms can show the error inline. */
  saveConfig(personaId: string, view: PersonaConfigView): Promise<SaveResult>;
  createPersona(id: string, yaml: string): Promise<PersonaSummary>;
  putCredential(conn: string, name: string, body: CredentialUpsert): Promise<ConnectionStatus>;
  deleteCredential(conn: string, name: string): Promise<void>;
  setProviderKey(provider: string, value: string): Promise<void>;
  removeProviderKey(provider: string): Promise<void>;
  /** Reports errors itself; false when the action failed. */
  connectionAction(conn: string, action: ConnectionAction): Promise<boolean>;
  dismissMigration(): Promise<void>;
  rebuildRuntime(): Promise<void>;
  /** Deletes the persona with its conversation and memory, and closes its settings. Throws on failure. */
  deletePersona(id: string): Promise<void>;
  /** "retry" checks Podman again; "setup" creates its machine. */
  prepareRuntime(kind: "retry" | "setup"): Promise<void>;
}

/** Everything the UI can ask the store to do, built once over the store's dispatch and refs. */
export function createActions({
  dispatch,
  stateRef,
  socketRef,
  toastSeq,
  loadFailed,
}: {
  dispatch: Dispatch<Action>;
  stateRef: MutableRefObject<State>;
  socketRef: MutableRefObject<EventSocket | null>;
  toastSeq: MutableRefObject<number>;
  loadFailed: MutableRefObject<boolean>;
}): { actions: Actions; loadAll: () => Promise<void> } {
  const toast: Actions["toast"] = (kind, text, title) => {
    toastSeq.current += 1;
    dispatch({ type: "toast.add", toast: { id: toastSeq.current, kind, text, title } });
  };

  const reportError: Actions["reportError"] = (e, context) => {
    if (e instanceof ApiError && e.unreachable) {
      toast("error", "Cannot reach the Swan server");
      return;
    }
    if (e instanceof ApiError && (e.status === 401 || e.status === 403)) return;
    const msg = errorMessage(e);
    toast("error", context ? `${context}: ${msg}` : msg);
  };

  const refreshProviders = async () => {
    try {
      dispatch({ type: "providers", providers: await api.providers() });
    } catch {
      /* non-critical */
    }
  };

  const refreshModels = async () => {
    try {
      dispatch({ type: "models", models: await api.models() });
    } catch {
      dispatch({ type: "models", models: null });
    }
  };

  const refreshApprovals = async () => {
    try {
      dispatch({ type: "approvals", approvals: await api.approvals() });
    } catch (e) {
      if (isMissingEndpoint(e)) dispatch({ type: "approvals", approvals: null });
    }
  };

  const refreshEgress = async () => {
    try {
      dispatch({ type: "egress.merge", events: await api.egress({ limit: 1000 }) });
    } catch (e) {
      if (!(e instanceof ApiError && e.unreachable)) reportError(e, "Loading network activity");
    }
  };

  const openConversation = async (personaId: string, sessionId: string): Promise<void> => {
    try {
      const res = await api.session(sessionId);
      dispatch({ type: "conversation", personaId, session: res.session, items: res.items });
    } catch (e) {
      if (!(e instanceof ApiError && e.unreachable)) dispatch({ type: "conversation.error", personaId, error: errorMessage(e) });
    }
  };

  const inflight = new Map<string, Promise<void>>();
  /** The conversation to open for a persona: ask the server; older servers fall back to the newest session. */
  const loadConversation = (personaId: string): Promise<void> => {
    const existing = inflight.get(personaId);
    if (existing) return existing;
    const p = (async () => {
      try {
        let res: { session: SessionSummary; items: ChatItem[] };
        try {
          res = await api.conversation(personaId);
        } catch (e) {
          if (!isMissingEndpoint(e)) throw e;
          const list = await api.sessions(personaId);
          const session = list[0] ?? (await api.createSession(personaId));
          res = await api.session(session.id);
        }
        dispatch({ type: "conversation", personaId, session: res.session, items: res.items });
      } catch (e) {
        if (e instanceof ApiError && e.unreachable) return;
        dispatch({ type: "conversation.error", personaId, error: errorMessage(e) });
      } finally {
        inflight.delete(personaId);
      }
    })();
    inflight.set(personaId, p);
    return p;
  };

  const loadAll = async () => {
    const [runtime, providers, personas, connections, egress, sessions, skills, migration, secrets] = await Promise.allSettled([
      api.runtime(),
      api.providers(),
      api.personas(),
      api.connections(),
      api.egress({ limit: 1000 }),
      api.sessions(),
      api.skills(),
      api.migrationNote(),
      api.secretsStatus(),
    ]);
    if (runtime.status === "fulfilled") dispatch({ type: "runtime", runtime: runtime.value });
    if (providers.status === "fulfilled") dispatch({ type: "providers", providers: providers.value });
    if (connections.status === "fulfilled") dispatch({ type: "connections", connections: connections.value });
    if (migration.status === "fulfilled") dispatch({ type: "migration", note: migration.value ?? null });
    if (secrets.status === "fulfilled") dispatch({ type: "secrets", error: secrets.value.error });
    if (egress.status === "fulfilled") dispatch({ type: "egress.merge", events: egress.value });
    if (sessions.status === "fulfilled") dispatch({ type: "sessions", sessions: sessions.value });
    if (skills.status === "fulfilled") dispatch({ type: "skills", skills: skills.value });
    void refreshModels();
    void refreshApprovals();
    if (personas.status === "fulfilled") {
      dispatch({ type: "personas", personas: personas.value });
      dispatch({ type: "loaded" });
      loadFailed.current = false;
      const pid = stateRef.current.selectedPersonaId;
      if (pid) void loadConversation(pid);
    } else {
      loadFailed.current = true;
      const r = personas.reason;
      if (r instanceof ApiError && !r.unreachable && r.status !== 401 && r.status !== 403) {
        dispatch({ type: "loaded" });
        reportError(r, "Loading personas");
      }
    }
  };

  const conversationOf = (personaId: string) => stateRef.current.conversations[personaId];

  const actions: Actions = {
    getState: () => stateRef.current,
    toast,
    dismissToast: (id) => dispatch({ type: "toast.remove", id }),
    reportError,
    retryConnection: () => {
      socketRef.current?.retryNow();
      void loadAll();
    },

    selectPersona: (id) => {
      dispatch({ type: "select.persona", id });
      if (!conversationOf(id)) void loadConversation(id);
    },
    toggleDock: (mode) => {
      const s = stateRef.current;
      dispatch({ type: "dock", dock: s.ui.dock === mode ? null : mode });
    },
    openDock: (dock) => dispatch({ type: "dock", dock }),
    setDockWidth: (mode, width) => dispatch({ type: "dock.width", mode, width }),
    openSettings: (opts) => {
      dispatch({ type: "settings.new", isNew: opts?.isNew ?? false });
      dispatch({ type: "settings.section", section: opts?.section ?? null });
      dispatch({ type: "dock", dock: "settings" });
    },
    setSettingsSection: (section) => dispatch({ type: "settings.section", section }),
    openSwanSettings: () => dispatch({ type: "dock", dock: "swan" }),
    startImport: async (file) => {
      if (file.size > 20 * 1024 * 1024) return toast("error", `${file.name} is larger than 20 MB; a persona file is much smaller.`, "Import");
      dispatch({ type: "import.file", file: { name: file.name, text: await file.text() } });
      dispatch({ type: "dock", dock: "import" });
    },
    closeImport: () => {
      dispatch({ type: "import.file", file: null });
      dispatch({ type: "dock", dock: null });
    },
    addRuleInSettings: (personaId, connection, rule) => {
      const s = stateRef.current;
      if (personaId !== s.selectedPersonaId) {
        dispatch({ type: "select.persona", id: personaId });
        if (!conversationOf(personaId)) void loadConversation(personaId);
      }
      focusSeq += 1;
      dispatch({ type: "settings.focus", focus: { personaId, section: "connections", rule: { connection, rule }, seq: focusSeq } });
      dispatch({ type: "settings.new", isNew: false });
      dispatch({ type: "settings.section", section: "connections" });
      dispatch({ type: "dock", dock: "settings" });
    },
    clearSettingsFocus: () => dispatch({ type: "settings.focus", focus: null }),
    setDraft: (key, draft) => dispatch({ type: "draft.set", key, draft }),
    setMemoryPane: (personaId, patch) => dispatch({ type: "memoryPane", personaId, patch }),
    openUsage: () => dispatch({ type: "dock", dock: "usage" }),
    setComposer: (personaId, text) => dispatch({ type: "composer", personaId, text }),
    setNetwork: (patch) => dispatch({ type: "network", patch }),
    addAttachments: (personaId, files) => {
      const sessionId = stateRef.current.conversations[personaId];
      const existing = (stateRef.current.attachments[personaId] ?? []).length;
      files.forEach((file, i) => {
        attachSeq += 1;
        const key = `a${attachSeq}`;
        const mediaType = file.type || "application/octet-stream";
        const previewUrl = mediaType.startsWith("image/") ? URL.createObjectURL(file) : undefined;
        const base: DraftAttachment = { key, name: file.name || "pasted file", size: file.size, mediaType, status: "uploading", progress: 0, previewUrl };
        const fail = (error: string) => dispatch({ type: "att.add", personaId, att: { ...base, status: "error", error } });
        if (existing + i >= MAX_ATTACHMENTS) return fail(`Only ${MAX_ATTACHMENTS} attachments per message`);
        if (file.size > MAX_ATTACHMENT_BYTES) return fail("Larger than 20 MB");
        if (!sessionId) return fail("The conversation is still opening");
        dispatch({ type: "att.add", personaId, att: base });
        const update = (patch: Partial<DraftAttachment>) => dispatch({ type: "att.update", personaId, key, patch });
        void (async () => {
          try {
            const data = await readBase64(file);
            const up = uploadAttachment(sessionId, { name: base.name, mediaType, data }, (f) => update({ progress: f }));
            uploads.set(key, up.abort);
            const meta = await up.promise;
            if (previewUrl) attachmentPreviews.set(meta.id, previewUrl);
            update({ status: "done", progress: 1, meta });
          } catch (e) {
            update({ status: "error", error: errorMessage(e) });
          } finally {
            uploads.delete(key);
          }
        })();
      });
    },
    removeAttachment: (personaId, key) => {
      const att = (stateRef.current.attachments[personaId] ?? []).find((x) => x.key === key);
      uploads.get(key)?.();
      if (att?.previewUrl && !(att.meta && attachmentPreviews.has(att.meta.id))) URL.revokeObjectURL(att.previewUrl);
      if (att?.meta) {
        const url = attachmentPreviews.get(att.meta.id);
        if (url) URL.revokeObjectURL(url);
        attachmentPreviews.delete(att.meta.id);
      }
      dispatch({ type: "att.remove", personaId, key });
    },
    clearAttachments: (personaId, keys) => dispatch({ type: "att.clear", personaId, keys }),
    openPersonaMenu: () => dispatch({ type: "personaMenu.open" }),
    jumpToApproval: (target) => {
      const s = stateRef.current;
      const a = target ?? pendingApprovals(s)[0];
      if (!a) return;
      if (a.personaId && a.personaId !== s.selectedPersonaId) {
        dispatch({ type: "select.persona", id: a.personaId });
      }
      // It may be waiting in another conversation; focus once that one is on screen.
      const focus = () => dispatch({ type: "focus.approval", sessionId: a.sessionId, toolUseId: a.toolUseId });
      if (a.personaId && s.conversations[a.personaId] !== a.sessionId) void openConversation(a.personaId, a.sessionId).then(focus);
      else focus();
    },
    jumpToItem: (personaId, itemId, sessionId) => {
      const s = stateRef.current;
      if (personaId !== s.selectedPersonaId) dispatch({ type: "select.persona", id: personaId });
      const sid = sessionId ?? s.conversations[personaId];
      if (!sid) return;
      const focus = () => dispatch({ type: "focus.item", sessionId: sid, itemId });
      if (s.conversations[personaId] !== sid) void openConversation(personaId, sid).then(focus);
      else focus();
    },

    loadConversation,
    openConversation,
    newConversation: async (personaId) => {
      const s = stateRef.current;
      const empty = Object.values(s.sessions).find((x) => x.personaId === personaId && x.title === "New conversation");
      try {
        await openConversation(personaId, empty?.id ?? (await api.createSession(personaId)).id);
      } catch (e) {
        toast("error", errorMessage(e), "Conversation");
      }
    },
    forkConversation: async (personaId, sessionId) => {
      try {
        const fork = await api.forkSession(sessionId);
        dispatch({ type: "session.upsert", session: fork });
        await openConversation(personaId, fork.id);
        return true;
      } catch (e) {
        toast("error", errorMessage(e), "Conversation");
        return false;
      }
    },
    renameConversation: async (sessionId, title) => {
      try {
        dispatch({ type: "session.upsert", session: await api.renameSession(sessionId, title) });
        return true;
      } catch (e) {
        toast("error", errorMessage(e), "Conversation");
        return false;
      }
    },
    deleteConversation: async (personaId, sessionId) => {
      try {
        await api.deleteSession(sessionId);
        dispatch({ type: "session.remove", id: sessionId });
        await loadConversation(personaId);
        return true;
      } catch (e) {
        toast("error", errorMessage(e), "Conversation");
        return false;
      }
    },
    refreshEgress,
    refreshProviders,
    refreshModels,

    sendMessage: async (sessionId, text, attachmentIds) => {
      try {
        await api.sendMessage(sessionId, text, attachmentIds);
        return true;
      } catch (e) {
        reportError(e, "Message not sent");
        return false;
      }
    },
    interrupt: async (sessionId) => {
      try {
        await api.interrupt(sessionId);
      } catch (e) {
        reportError(e, "Stop failed");
      }
    },
    stopAgent: async (sessionId, agentId) => {
      try {
        await api.stopAgent(sessionId, agentId);
        return true;
      } catch (e) {
        reportError(e, agentId === "all" ? "Could not stop the agents" : "Could not stop the agent");
        return false;
      }
    },
    approve: async (sessionId, toolUseId, body) => {
      try {
        await api.approve(sessionId, toolUseId, body);
        return true;
      } catch (e) {
        reportError(e, "Decision not recorded");
        return false;
      }
    },
    removeAllowance: async (sessionId, rule) => {
      try {
        dispatch({ type: "session.upsert", session: await api.removeAllowance(sessionId, rule) });
      } catch (e) {
        reportError(e, "Could not remove allowance");
      }
    },
    resetAllowances: async (sessionId) => {
      try {
        dispatch({ type: "session.upsert", session: await api.resetAllowances(sessionId) });
      } catch (e) {
        reportError(e, "Could not reset allowances");
      }
    },
    setModel: async (personaId, body) => {
      try {
        dispatch({ type: "persona.upsert", persona: await api.setModel(personaId, body) });
      } catch (e) {
        reportError(e, "Model not changed");
      }
    },

    saveConfig: async (personaId, view) => {
      const result = await api.saveConfig(personaId, view);
      dispatch({ type: "persona.upsert", persona: result.persona });
      return result;
    },
    createPersona: async (id, yaml) => {
      const persona = await api.createPersona(id, yaml);
      dispatch({ type: "persona.upsert", persona });
      dispatch({ type: "select.persona", id: persona.id });
      void loadConversation(persona.id);
      return persona;
    },
    putCredential: async (conn, name, body) => {
      const connection = await api.putCredential(conn, name, body);
      dispatch({ type: "connection.upsert", connection, changed: `${conn}/${name}` });
      return connection;
    },
    deleteCredential: async (conn, name) => {
      const res = await api.deleteCredential(conn, name);
      if ("name" in res) dispatch({ type: "connection.upsert", connection: res });
      else dispatch({ type: "connection.remove", name: conn });
    },
    setProviderKey: async (provider, value) => {
      await api.setProviderKey(provider, value);
      await refreshProviders();
      void refreshModels();
    },
    removeProviderKey: async (provider) => {
      await api.removeProviderKey(provider);
      await refreshProviders();
      void refreshModels();
    },
    connectionAction: async (conn, action) => {
      try {
        dispatch({ type: "connection.upsert", connection: await api.connectionAction(conn, action) });
        return true;
      } catch (e) {
        const what = { login: "Sign-in did not start", renew: "Renewal failed", cancel: "Could not cancel the sign-in", logout: "Sign-out failed" }[action];
        reportError(e, what);
        return false;
      }
    },
    dismissMigration: async () => {
      try {
        await api.dismissMigrationNote();
        dispatch({ type: "migration", note: null });
      } catch (e) {
        reportError(e, "Could not dismiss the note");
      }
    },
    rebuildRuntime: async () => {
      try {
        dispatch({ type: "runtime", runtime: await api.rebuildRuntime() });
      } catch (e) {
        reportError(e, "Rebuild failed");
      }
    },
    deletePersona: async (id) => {
      await api.deletePersona(id);
      dispatch({ type: "dock", dock: null });
      dispatch({ type: "personas", personas: await api.personas() });
    },
    prepareRuntime: async (kind) => {
      try {
        dispatch({ type: "runtime", runtime: await (kind === "setup" ? api.setupRuntime() : api.retryRuntime()) });
      } catch (e) {
        reportError(e, kind === "setup" ? "Could not set up Podman" : "Could not check Podman");
      }
    },
  };
  return { actions, loadAll };
}
