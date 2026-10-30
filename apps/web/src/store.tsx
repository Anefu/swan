import { createContext, useContext, useEffect, useMemo, useReducer, useRef, type ReactNode } from "react";
import type {
  ApprovalBody,
  ChatItem,
  CredentialStatus,
  CredentialUpsert,
  Effort,
  EgressEvent,
  ModelOption,
  PendingApproval,
  PersonaConfigView,
  PersonaSummary,
  ProviderStatus,
  RuntimeStatus,
  SaveResult,
  ServerEvent,
  SessionSummary,
  SkillSummary,
} from "@ph/shared";
import { api, ApiError, configureApi, probeToken, readToken, type ApiHealth } from "./api";
import { errorMessage, isMissingEndpoint, loadPref, savePref } from "./util";
import { EventSocket, wsUrl, type WsState } from "./ws";

// ---------- State ----------

export type ServerState = "loading" | "ok" | "unreachable" | "unauthorized" | "no-token";
export type ToastKind = "info" | "success" | "warn" | "error";
export type DockMode = "settings" | "memory";
export type MainView = "conversation" | "network";
export const NEW_PERSONA = "__new__";

export interface Toast {
  id: number;
  kind: ToastKind;
  text: string;
  title?: string;
}

export interface Transcript {
  items: ChatItem[];
  /** ws = live snapshot; rest = fetched over HTTP; stale = no longer live. */
  source: "ws" | "rest" | "stale";
}

export interface UiPrefs {
  dock: DockMode | null;
  widths: Record<DockMode, number>;
}

export interface MemoryPaneState {
  tab: "memory" | "usage";
  sub: "saved" | "current" | "history";
  query: string;
  type: string;
  status: string;
  expanded: string | null;
  period: "today" | "all";
}

export const DEFAULT_MEMORY_PANE: MemoryPaneState = {
  tab: "memory",
  sub: "saved",
  query: "",
  type: "",
  status: "",
  expanded: null,
  period: "today",
};

export interface SettingsDraft {
  base: PersonaConfigView;
  draft: PersonaConfigView;
  /** Only for a new persona. */
  newId?: string;
  result?: SaveResult | null;
  error?: string | null;
}

export interface NetworkFilters {
  query: string;
  range: "hour" | "today" | "all";
  onlyBlocked: boolean;
  expanded: string | null;
}

export interface State {
  token: string | null;
  server: ServerState;
  ws: WsState;
  loaded: boolean;
  runtime: RuntimeStatus | null;
  providers: ProviderStatus[];
  personas: PersonaSummary[];
  credentials: CredentialStatus[];
  credentialFlash: Record<string, number>;
  skills: SkillSummary[];
  /** null = not loaded or the server has no /api/models. */
  models: ModelOption[] | null;
  /** null = the server has no /api/approvals; pending calls are derived from loaded transcripts. */
  approvals: PendingApproval[] | null;
  /** personaId -> sessionId of its one conversation */
  conversations: Record<string, string>;
  conversationError: Record<string, string>;
  sessions: Record<string, SessionSummary>;
  transcripts: Record<string, Transcript>;
  egress: EgressEvent[];
  selectedPersonaId: string | null;
  view: MainView;
  dockBeforeNetwork: DockMode | null;
  settingsScope: "persona" | "swan";
  /** Settings persona scope shows the new-persona draft instead of the selected persona. */
  settingsNew: boolean;
  drafts: Record<string, SettingsDraft>;
  memoryPane: Record<string, MemoryPaneState>;
  composer: Record<string, string>;
  network: NetworkFilters;
  focusApproval: { sessionId: string; toolUseId: string; seq: number } | null;
  focusItem: { sessionId: string; itemId: string; seq: number } | null;
  personaMenuSeq: number;
  usageRev: Record<string, number>;
  memoryRev: Record<string, number>;
  toasts: Toast[];
  ui: UiPrefs;
}

const PREFS_KEY = "swan.ui.v1";
const SELECTION_KEY = "swan.persona.v1";
const COMPOSER_KEY = "swan.composer.v1";
const MAX_EGRESS = 2000;

const DEFAULT_UI: UiPrefs = { dock: null, widths: { settings: 400, memory: 400 } };

function initState(): State {
  const token = readToken();
  const ui = loadPref(PREFS_KEY, DEFAULT_UI);
  return {
    token,
    server: token ? "loading" : "no-token",
    ws: { status: "connecting", attempt: 0, nextRetryAt: null },
    loaded: false,
    runtime: null,
    providers: [],
    personas: [],
    credentials: [],
    credentialFlash: {},
    skills: [],
    models: null,
    approvals: null,
    conversations: {},
    conversationError: {},
    sessions: {},
    transcripts: {},
    egress: [],
    selectedPersonaId: loadPref<{ id: string | null }>(SELECTION_KEY, { id: null }).id,
    view: "conversation",
    dockBeforeNetwork: null,
    settingsScope: "persona",
    settingsNew: false,
    drafts: {},
    memoryPane: {},
    composer: loadPref<Record<string, string>>(COMPOSER_KEY, {}),
    network: { query: "", range: "today", onlyBlocked: false, expanded: null },
    focusApproval: null,
    focusItem: null,
    personaMenuSeq: 0,
    usageRev: {},
    memoryRev: {},
    toasts: [],
    ui: { ...DEFAULT_UI, ...ui, widths: { ...DEFAULT_UI.widths, ...ui.widths } },
  };
}

// ---------- Reducer ----------

type Action =
  | { type: "server"; server: ServerState }
  | { type: "ws"; ws: WsState }
  | { type: "loaded" }
  | { type: "runtime"; runtime: RuntimeStatus }
  | { type: "providers"; providers: ProviderStatus[] }
  | { type: "personas"; personas: PersonaSummary[] }
  | { type: "persona.upsert"; persona: PersonaSummary }
  | { type: "credentials"; credentials: CredentialStatus[]; changed?: string[] }
  | { type: "credential.upsert"; credential: CredentialStatus }
  | { type: "credential.remove"; name: string }
  | { type: "skills"; skills: SkillSummary[] }
  | { type: "models"; models: ModelOption[] | null }
  | { type: "approvals"; approvals: PendingApproval[] | null }
  | { type: "sessions"; sessions: SessionSummary[] }
  | { type: "session.upsert"; session: SessionSummary }
  | { type: "session.remove"; id: string }
  | { type: "conversation"; personaId: string; session: SessionSummary; items: ChatItem[] }
  | { type: "conversation.error"; personaId: string; error: string | null }
  | { type: "transcript.set"; sessionId: string; items: ChatItem[]; source: "ws" | "rest" }
  | { type: "transcripts.stale" }
  | { type: "item.put"; sessionId: string; item: ChatItem }
  | { type: "item.delta"; sessionId: string; itemId: string; delta: string }
  | { type: "egress.merge"; events: EgressEvent[] }
  | { type: "egress.add"; event: EgressEvent }
  | { type: "select.persona"; id: string | null }
  | { type: "view"; view: MainView }
  | { type: "dock"; dock: DockMode | null }
  | { type: "dock.width"; mode: DockMode; width: number }
  | { type: "settings.scope"; scope: "persona" | "swan"; isNew?: boolean }
  | { type: "draft.set"; key: string; draft: SettingsDraft | null }
  | { type: "memoryPane"; personaId: string; patch: Partial<MemoryPaneState> }
  | { type: "composer"; personaId: string; text: string }
  | { type: "network"; patch: Partial<NetworkFilters> }
  | { type: "focus.approval"; sessionId: string; toolUseId: string }
  | { type: "focus.item"; sessionId: string; itemId: string }
  | { type: "personaMenu.open" }
  | { type: "rev"; which: "usageRev" | "memoryRev"; personaId: string }
  | { type: "toast.add"; toast: Toast }
  | { type: "toast.remove"; id: number };

function lastIndexById(items: ChatItem[], id: string): number {
  for (let i = items.length - 1; i >= 0; i--) if (items[i].id === id) return i;
  return -1;
}

function putItem(items: ChatItem[], item: ChatItem): ChatItem[] {
  const idx = lastIndexById(items, item.id);
  if (idx === -1) return [...items, item];
  const next = items.slice();
  next[idx] = item;
  return next;
}

function appendDelta(items: ChatItem[], itemId: string, delta: string): ChatItem[] {
  const idx = lastIndexById(items, itemId);
  if (idx === -1) return items;
  const it = items[idx];
  if (!("text" in it)) return items;
  const next = items.slice();
  next[idx] = { ...it, text: it.text + delta } as ChatItem;
  return next;
}

function mergeEgress(existing: EgressEvent[], incoming: EgressEvent[]): EgressEvent[] {
  if (incoming.length === 0) return existing;
  const map = new Map<string, EgressEvent>();
  for (const e of existing) map.set(e.id, e);
  for (const e of incoming) map.set(e.id, e);
  const all = [...map.values()].sort((a, b) => (a.ts < b.ts ? -1 : a.ts > b.ts ? 1 : 0));
  return all.length > MAX_EGRESS ? all.slice(all.length - MAX_EGRESS) : all;
}

function reducer(state: State, a: Action): State {
  switch (a.type) {
    case "server":
      return state.server === a.server ? state : { ...state, server: a.server };
    case "ws":
      return { ...state, ws: a.ws };
    case "loaded":
      return state.loaded ? state : { ...state, loaded: true };
    case "runtime":
      return { ...state, runtime: a.runtime };
    case "providers":
      return { ...state, providers: a.providers };
    case "personas": {
      let selectedPersonaId = state.selectedPersonaId;
      if (selectedPersonaId && !a.personas.some((p) => p.id === selectedPersonaId)) selectedPersonaId = null;
      if (!selectedPersonaId && a.personas.length > 0) selectedPersonaId = a.personas[0].id;
      return { ...state, personas: a.personas, selectedPersonaId };
    }
    case "persona.upsert": {
      const exists = state.personas.some((p) => p.id === a.persona.id);
      const personas = exists
        ? state.personas.map((p) => (p.id === a.persona.id ? a.persona : p))
        : [...state.personas, a.persona];
      return { ...state, personas };
    }
    case "credentials": {
      let flash = state.credentialFlash;
      if (a.changed && a.changed.length > 0) {
        const now = Date.now();
        flash = { ...flash };
        for (const n of a.changed) flash[n] = now;
      }
      return { ...state, credentials: a.credentials, credentialFlash: flash };
    }
    case "credential.upsert": {
      const exists = state.credentials.some((c) => c.name === a.credential.name);
      const credentials = exists
        ? state.credentials.map((c) => (c.name === a.credential.name ? a.credential : c))
        : [...state.credentials, a.credential].sort((x, y) => x.name.localeCompare(y.name));
      return { ...state, credentials, credentialFlash: { ...state.credentialFlash, [a.credential.name]: Date.now() } };
    }
    case "credential.remove":
      return { ...state, credentials: state.credentials.filter((c) => c.name !== a.name) };
    case "skills":
      return { ...state, skills: a.skills };
    case "models":
      return { ...state, models: a.models };
    case "approvals":
      return { ...state, approvals: a.approvals };
    case "sessions": {
      const sessions = { ...state.sessions };
      for (const s of a.sessions) sessions[s.id] = s;
      return { ...state, sessions };
    }
    case "session.upsert":
      return { ...state, sessions: { ...state.sessions, [a.session.id]: a.session } };
    case "session.remove": {
      if (!state.sessions[a.id]) return state;
      const sessions = { ...state.sessions };
      delete sessions[a.id];
      const transcripts = { ...state.transcripts };
      delete transcripts[a.id];
      const conversations = { ...state.conversations };
      for (const [pid, sid] of Object.entries(conversations)) if (sid === a.id) delete conversations[pid];
      return { ...state, sessions, transcripts, conversations };
    }
    case "conversation": {
      const cur = state.transcripts[a.session.id];
      const transcripts =
        cur?.source === "ws"
          ? state.transcripts
          : { ...state.transcripts, [a.session.id]: { items: a.items, source: "rest" as const } };
      const conversationError = { ...state.conversationError };
      delete conversationError[a.personaId];
      return {
        ...state,
        conversations: { ...state.conversations, [a.personaId]: a.session.id },
        sessions: { ...state.sessions, [a.session.id]: a.session },
        transcripts,
        conversationError,
      };
    }
    case "conversation.error": {
      const conversationError = { ...state.conversationError };
      if (a.error) conversationError[a.personaId] = a.error;
      else delete conversationError[a.personaId];
      return { ...state, conversationError };
    }
    case "transcript.set": {
      const cur = state.transcripts[a.sessionId];
      if (a.source === "rest" && cur?.source === "ws") return state;
      return { ...state, transcripts: { ...state.transcripts, [a.sessionId]: { items: a.items, source: a.source } } };
    }
    case "transcripts.stale": {
      const transcripts: Record<string, Transcript> = {};
      for (const [k, t] of Object.entries(state.transcripts)) transcripts[k] = t.source === "ws" ? { ...t, source: "stale" } : t;
      return { ...state, transcripts };
    }
    case "item.put": {
      const cur = state.transcripts[a.sessionId];
      if (!cur) return state;
      return { ...state, transcripts: { ...state.transcripts, [a.sessionId]: { ...cur, items: putItem(cur.items, a.item) } } };
    }
    case "item.delta": {
      const cur = state.transcripts[a.sessionId];
      if (!cur) return state;
      const items = appendDelta(cur.items, a.itemId, a.delta);
      if (items === cur.items) return state;
      return { ...state, transcripts: { ...state.transcripts, [a.sessionId]: { ...cur, items } } };
    }
    case "egress.merge":
      return { ...state, egress: mergeEgress(state.egress, a.events) };
    case "egress.add": {
      const list = state.egress;
      const last = list[list.length - 1];
      if (!last || (last.ts <= a.event.ts && !list.some((e) => e.id === a.event.id))) {
        const egress = list.length >= MAX_EGRESS ? [...list.slice(list.length - MAX_EGRESS + 1), a.event] : [...list, a.event];
        return { ...state, egress };
      }
      return { ...state, egress: mergeEgress(list, [a.event]) };
    }
    case "select.persona":
      if (a.id === state.selectedPersonaId) return { ...state, settingsNew: false };
      return { ...state, selectedPersonaId: a.id, settingsNew: false };
    case "view": {
      if (a.view === state.view) return state;
      if (a.view === "network") {
        // Network activity opens with the dock closed; the previous dock state comes back on return.
        return { ...state, view: a.view, dockBeforeNetwork: state.ui.dock, ui: { ...state.ui, dock: null } };
      }
      return {
        ...state,
        view: a.view,
        ui: { ...state.ui, dock: state.ui.dock ?? state.dockBeforeNetwork },
        dockBeforeNetwork: null,
      };
    }
    case "dock":
      return { ...state, ui: { ...state.ui, dock: a.dock } };
    case "dock.width":
      return { ...state, ui: { ...state.ui, widths: { ...state.ui.widths, [a.mode]: a.width } } };
    case "settings.scope":
      return {
        ...state,
        settingsScope: a.scope,
        settingsNew: a.isNew ?? (a.scope === "persona" ? false : state.settingsNew),
      };
    case "draft.set": {
      const drafts = { ...state.drafts };
      if (a.draft) drafts[a.key] = a.draft;
      else delete drafts[a.key];
      return { ...state, drafts };
    }
    case "memoryPane": {
      const cur = state.memoryPane[a.personaId] ?? DEFAULT_MEMORY_PANE;
      return { ...state, memoryPane: { ...state.memoryPane, [a.personaId]: { ...cur, ...a.patch } } };
    }
    case "composer":
      return { ...state, composer: { ...state.composer, [a.personaId]: a.text } };
    case "network":
      return { ...state, network: { ...state.network, ...a.patch } };
    case "focus.approval":
      return {
        ...state,
        focusApproval: { sessionId: a.sessionId, toolUseId: a.toolUseId, seq: (state.focusApproval?.seq ?? 0) + 1 },
      };
    case "focus.item":
      return { ...state, focusItem: { sessionId: a.sessionId, itemId: a.itemId, seq: (state.focusItem?.seq ?? 0) + 1 } };
    case "personaMenu.open":
      return { ...state, personaMenuSeq: state.personaMenuSeq + 1 };
    case "rev":
      return { ...state, [a.which]: { ...state[a.which], [a.personaId]: (state[a.which][a.personaId] ?? 0) + 1 } };
    case "toast.add": {
      const dupe = state.toasts.find((t) => t.text === a.toast.text && t.kind === a.toast.kind);
      const toasts = dupe ? state.toasts.filter((t) => t !== dupe) : state.toasts;
      return { ...state, toasts: [...toasts.slice(-4), a.toast] };
    }
    case "toast.remove":
      return { ...state, toasts: state.toasts.filter((t) => t.id !== a.id) };
  }
}

// ---------- Actions ----------

export interface Actions {
  getState(): State;
  toast(kind: ToastKind, text: string, title?: string): void;
  dismissToast(id: number): void;
  reportError(e: unknown, context?: string): void;
  retryConnection(): void;

  selectPersona(id: string): void;
  showView(view: MainView): void;
  toggleDock(mode: DockMode): void;
  openDock(mode: DockMode | null): void;
  setDockWidth(mode: DockMode, width: number): void;
  openSettings(scope: "persona" | "swan", opts?: { isNew?: boolean }): void;
  setSettingsScope(scope: "persona" | "swan"): void;
  setDraft(key: string, draft: SettingsDraft | null): void;
  setMemoryPane(personaId: string, patch: Partial<MemoryPaneState>): void;
  openUsage(personaId: string): void;
  setComposer(personaId: string, text: string): void;
  setNetwork(patch: Partial<NetworkFilters>): void;
  openPersonaMenu(): void;
  jumpToApproval(a?: PendingApproval): void;
  jumpToItem(personaId: string, itemId: string): void;

  loadConversation(personaId: string): Promise<void>;
  refreshEgress(): Promise<void>;
  refreshProviders(): Promise<void>;
  refreshModels(): Promise<void>;

  sendMessage(sessionId: string, text: string): Promise<boolean>;
  interrupt(sessionId: string): Promise<void>;
  approve(sessionId: string, toolUseId: string, body: ApprovalBody): Promise<boolean>;
  removeAllowance(sessionId: string, rule: string): Promise<void>;
  resetAllowances(sessionId: string): Promise<void>;
  setModel(personaId: string, body: { provider: string; id: string; effort?: Effort }): Promise<void>;

  /** These throw so forms can show the error inline. */
  saveConfig(personaId: string, view: PersonaConfigView): Promise<SaveResult>;
  createPersona(id: string, yaml: string): Promise<PersonaSummary>;
  putCredential(name: string, body: CredentialUpsert): Promise<CredentialStatus>;
  deleteCredential(name: string): Promise<void>;
  rebuildRuntime(): Promise<void>;
}

interface Store {
  state: State;
  actions: Actions;
}

const StoreContext = createContext<Store | null>(null);

export function useStore(): Store {
  const s = useContext(StoreContext);
  if (!s) throw new Error("useStore outside StoreProvider");
  return s;
}

export function StoreProvider({ children }: { children: ReactNode }) {
  const [state, dispatch] = useReducer(reducer, undefined, initState);
  const stateRef = useRef(state);
  stateRef.current = state;
  const socketRef = useRef<EventSocket | null>(null);
  const toastSeq = useRef(0);
  const loadFailed = useRef(false);

  const { actions, loadAll } = useMemo<{ actions: Actions; loadAll: () => Promise<void> }>(() => {
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

    const inflight = new Map<string, Promise<void>>();
    /** One conversation per persona: ask the server for it; older servers fall back to the newest session. */
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
      const [runtime, providers, personas, credentials, egress, sessions, skills] = await Promise.allSettled([
        api.runtime(),
        api.providers(),
        api.personas(),
        api.credentials(),
        api.egress({ limit: 1000 }),
        api.sessions(),
        api.skills(),
      ]);
      if (runtime.status === "fulfilled") dispatch({ type: "runtime", runtime: runtime.value });
      if (providers.status === "fulfilled") dispatch({ type: "providers", providers: providers.value });
      if (credentials.status === "fulfilled") dispatch({ type: "credentials", credentials: credentials.value });
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
      showView: (view) => dispatch({ type: "view", view }),
      toggleDock: (mode) => {
        const s = stateRef.current;
        dispatch({ type: "dock", dock: s.ui.dock === mode ? null : mode });
      },
      openDock: (dock) => dispatch({ type: "dock", dock }),
      setDockWidth: (mode, width) => dispatch({ type: "dock.width", mode, width }),
      openSettings: (scope, opts) => {
        dispatch({ type: "settings.scope", scope, isNew: opts?.isNew ?? false });
        dispatch({ type: "dock", dock: "settings" });
      },
      setSettingsScope: (scope) => dispatch({ type: "settings.scope", scope }),
      setDraft: (key, draft) => dispatch({ type: "draft.set", key, draft }),
      setMemoryPane: (personaId, patch) => dispatch({ type: "memoryPane", personaId, patch }),
      openUsage: (personaId) => {
        dispatch({ type: "memoryPane", personaId, patch: { tab: "usage" } });
        dispatch({ type: "dock", dock: "memory" });
      },
      setComposer: (personaId, text) => dispatch({ type: "composer", personaId, text }),
      setNetwork: (patch) => dispatch({ type: "network", patch }),
      openPersonaMenu: () => dispatch({ type: "personaMenu.open" }),
      jumpToApproval: (target) => {
        const s = stateRef.current;
        const a = target ?? pendingApprovals(s)[0];
        if (!a) return;
        if (a.personaId && a.personaId !== s.selectedPersonaId) {
          dispatch({ type: "select.persona", id: a.personaId });
          if (!conversationOf(a.personaId)) void loadConversation(a.personaId);
        }
        dispatch({ type: "view", view: "conversation" });
        dispatch({ type: "focus.approval", sessionId: a.sessionId, toolUseId: a.toolUseId });
      },
      jumpToItem: (personaId, itemId) => {
        const s = stateRef.current;
        if (personaId !== s.selectedPersonaId) dispatch({ type: "select.persona", id: personaId });
        dispatch({ type: "view", view: "conversation" });
        const sid = s.conversations[personaId];
        if (sid) dispatch({ type: "focus.item", sessionId: sid, itemId });
      },

      loadConversation,
      refreshEgress,
      refreshProviders,
      refreshModels,

      sendMessage: async (sessionId, text) => {
        try {
          await api.sendMessage(sessionId, text);
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
      putCredential: async (name, body) => {
        const credential = await api.putCredential(name, body);
        dispatch({ type: "credential.upsert", credential });
        void refreshProviders();
        void refreshModels();
        return credential;
      },
      deleteCredential: async (name) => {
        await api.deleteCredential(name);
        dispatch({ type: "credential.remove", name });
        void refreshProviders();
      },
      rebuildRuntime: async () => {
        try {
          dispatch({ type: "runtime", runtime: await api.rebuildRuntime() });
        } catch (e) {
          reportError(e, "Rebuild failed");
        }
      },
    };
    return { actions, loadAll };
  }, []);

  const onEvent = useRef<(ev: ServerEvent) => void>(() => {});
  onEvent.current = (ev: ServerEvent) => {
    switch (ev.type) {
      case "hello":
      case "runtime.status":
        dispatch({ type: "runtime", runtime: ev.runtime });
        break;
      case "personas.updated":
        dispatch({ type: "personas", personas: ev.personas });
        break;
      case "credentials.updated":
        dispatch({ type: "credentials", credentials: ev.credentials, changed: ev.changed });
        if (ev.changed.length > 0) actions.toast("success", `${ev.changed.join(", ")} reloaded, no restart`, "Credentials");
        void actions.refreshProviders();
        void actions.refreshModels();
        break;
      case "session.updated":
        dispatch({ type: "session.upsert", session: ev.session });
        break;
      case "session.deleted":
        dispatch({ type: "session.remove", id: ev.sessionId });
        break;
      case "session.snapshot":
        dispatch({ type: "session.upsert", session: ev.session });
        dispatch({ type: "transcript.set", sessionId: ev.session.id, items: ev.items, source: "ws" });
        break;
      case "item.added":
      case "item.updated":
        dispatch({ type: "item.put", sessionId: ev.sessionId, item: ev.item });
        break;
      case "item.delta":
        dispatch({ type: "item.delta", sessionId: ev.sessionId, itemId: ev.itemId, delta: ev.delta });
        break;
      case "egress":
        dispatch({ type: "egress.add", event: ev.event });
        break;
      case "approvals.updated":
        dispatch({ type: "approvals", approvals: ev.approvals });
        break;
      case "usage.updated":
        dispatch({ type: "rev", which: "usageRev", personaId: ev.personaId });
        break;
      case "memory.updated":
        dispatch({ type: "rev", which: "memoryRev", personaId: ev.personaId });
        break;
    }
  };

  // Connection lifecycle
  useEffect(() => {
    const token = state.token;
    if (!token) {
      const t = window.setInterval(async () => {
        if (await probeToken()) window.location.reload();
      }, 3000);
      return () => window.clearInterval(t);
    }
    configureApi(token, (h: ApiHealth) => dispatch({ type: "server", server: h }));
    const socket = new EventSocket(wsUrl(token), {
      onEvent: (ev) => onEvent.current(ev),
      onState: (ws) => {
        dispatch({ type: "ws", ws });
        if (ws.status === "closed") dispatch({ type: "transcripts.stale" });
      },
      onOpen: (reconnect) => {
        dispatch({ type: "server", server: "ok" });
        if (reconnect || loadFailed.current) void loadAll();
      },
    });
    socketRef.current = socket;
    const pid = stateRef.current.selectedPersonaId;
    socket.setSubscription(pid ? (stateRef.current.conversations[pid] ?? null) : null);
    socket.start();
    void loadAll();
    return () => {
      socket.stop();
      socketRef.current = null;
    };
  }, [state.token, actions, loadAll]);

  // Subscribe to the selected persona's conversation.
  const currentSessionId = state.selectedPersonaId ? (state.conversations[state.selectedPersonaId] ?? null) : null;
  useEffect(() => {
    socketRef.current?.setSubscription(currentSessionId);
  }, [currentSessionId]);

  // Make sure the selected persona's conversation is loaded (also after personas arrive).
  useEffect(() => {
    const pid = state.selectedPersonaId;
    if (state.loaded && pid && !state.conversations[pid] && !state.conversationError[pid]) void actions.loadConversation(pid);
  }, [state.loaded, state.selectedPersonaId, state.conversations, state.conversationError, actions]);

  useEffect(() => savePref(SELECTION_KEY, { id: state.selectedPersonaId }), [state.selectedPersonaId]);
  useEffect(() => savePref(PREFS_KEY, state.ui), [state.ui]);
  useEffect(() => {
    const t = window.setTimeout(() => savePref(COMPOSER_KEY, state.composer), 400);
    return () => window.clearTimeout(t);
  }, [state.composer]);

  const value = useMemo(() => ({ state, actions }), [state, actions]);
  return <StoreContext.Provider value={value}>{children}</StoreContext.Provider>;
}

// ---------- Selectors ----------

export function useSelectedPersona(): PersonaSummary | null {
  const { state } = useStore();
  return state.personas.find((p) => p.id === state.selectedPersonaId) ?? null;
}

export function conversationSession(state: State, personaId: string | null): SessionSummary | null {
  if (!personaId) return null;
  const sid = state.conversations[personaId];
  if (sid && state.sessions[sid]) return state.sessions[sid];
  // Before the conversation loads, use the newest known session for status hints.
  let best: SessionSummary | null = null;
  for (const s of Object.values(state.sessions)) {
    if (s.personaId === personaId && (!best || s.updatedAt > best.updatedAt)) best = s;
  }
  return best;
}

/** Every waiting tool call, oldest first. Derived from loaded transcripts when the server has no approvals feed. */
export function pendingApprovals(state: State): PendingApproval[] {
  if (state.approvals) return [...state.approvals].sort((a, b) => (a.since < b.since ? -1 : a.since > b.since ? 1 : 0));
  const out: PendingApproval[] = [];
  for (const [sessionId, t] of Object.entries(state.transcripts)) {
    const personaId = state.sessions[sessionId]?.personaId ?? "";
    for (const it of t.items) {
      if (it.kind === "tool_call" && it.status === "pending_approval") {
        out.push({
          sessionId,
          personaId,
          toolUseId: it.id,
          name: it.name,
          inputPreview: it.inputPreview,
          rule: it.approvalReason ?? "",
          since: it.ts,
        });
      }
    }
  }
  return out.sort((a, b) => (a.since < b.since ? -1 : a.since > b.since ? 1 : 0));
}

export function usePendingApprovals(): PendingApproval[] {
  const { state } = useStore();
  return useMemo(() => pendingApprovals(state), [state.approvals, state.transcripts, state.sessions]); // eslint-disable-line react-hooks/exhaustive-deps
}

export function modelLabel(state: State, model: { provider: string; id: string }): string {
  const m = state.models?.find((x) => x.provider === model.provider && x.id === model.id);
  return m?.label ?? model.id;
}
