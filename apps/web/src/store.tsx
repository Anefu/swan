import { createContext, useContext, useEffect, useMemo, useReducer, useRef, type ReactNode } from "react";
import type {
  ApprovalBody,
  ChatItem,
  CredentialStatus,
  CredentialUpsert,
  EgressEvent,
  PersonaSummary,
  ProviderStatus,
  RuntimeStatus,
  ServerEvent,
  SessionSummary,
} from "@ph/shared";
import { api, ApiError, configureApi, probeToken, readToken, type ApiHealth } from "./api";
import { errorMessage, loadPref, savePref } from "./util";
import { EventSocket, wsUrl, type WsState } from "./ws";

// ---------- State ----------

export type ServerState = "loading" | "ok" | "unreachable" | "unauthorized" | "no-token";
export type RightTab = "workspace" | "tools" | "network" | "persona";
export type ToastKind = "info" | "success" | "warn" | "error";

export interface Toast {
  id: number;
  kind: ToastKind;
  text: string;
  title?: string;
  icon?: "key";
}

export interface Transcript {
  items: ChatItem[];
  /** ws = live snapshot; rest = fetched over HTTP; stale = no longer subscribed. */
  source: "ws" | "rest" | "stale";
}

export interface UiPrefs {
  rightOpen: boolean;
  rightTab: RightTab;
  rightWidth: number;
  egressSessionOnly: boolean;
  lastSession: Record<string, string>;
}

export type Dialog = { kind: "new-persona" } | null;

export interface State {
  token: string | null;
  server: ServerState;
  ws: WsState;
  loaded: boolean;
  runtime: RuntimeStatus | null;
  providers: ProviderStatus[];
  personas: PersonaSummary[];
  credentials: CredentialStatus[];
  /** credential name -> epoch ms of the last hot reload that touched it */
  credentialFlash: Record<string, number>;
  sessions: Record<string, SessionSummary>;
  transcripts: Record<string, Transcript>;
  egress: EgressEvent[];
  selectedPersonaId: string | null;
  selectedSessionId: string | null;
  view: "chat" | "credentials";
  toasts: Toast[];
  ui: UiPrefs;
  dialog: Dialog;
}

const PREFS_KEY = "ph.ui.v1";
const SELECTION_KEY = "ph.selection.v1";
export const MAX_EGRESS = 1000;

const DEFAULT_UI: UiPrefs = {
  rightOpen: true,
  rightTab: "workspace",
  rightWidth: 420,
  egressSessionOnly: false,
  lastSession: {},
};

function initState(): State {
  const token = readToken();
  const sel = loadPref<{ personaId: string | null; sessionId: string | null }>(SELECTION_KEY, {
    personaId: null,
    sessionId: null,
  });
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
    sessions: {},
    transcripts: {},
    egress: [],
    selectedPersonaId: sel.personaId,
    selectedSessionId: sel.sessionId,
    view: "chat",
    toasts: [],
    ui: loadPref(PREFS_KEY, DEFAULT_UI),
    dialog: null,
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
  | { type: "persona.remove"; id: string }
  | { type: "credentials"; credentials: CredentialStatus[]; changed?: string[] }
  | { type: "credential.upsert"; credential: CredentialStatus }
  | { type: "credential.remove"; name: string }
  | { type: "sessions.forPersona"; personaId: string; sessions: SessionSummary[] }
  | { type: "session.upsert"; session: SessionSummary }
  | { type: "session.remove"; id: string }
  | { type: "transcript.set"; sessionId: string; items: ChatItem[]; source: "ws" | "rest" }
  | { type: "transcripts.stale" }
  | { type: "item.put"; sessionId: string; item: ChatItem }
  | { type: "item.delta"; sessionId: string; itemId: string; delta: string }
  | { type: "egress.merge"; events: EgressEvent[] }
  | { type: "egress.add"; event: EgressEvent }
  | { type: "egress.clear" }
  | { type: "select.persona"; id: string | null }
  | { type: "select.session"; id: string | null }
  | { type: "view"; view: State["view"] }
  | { type: "toast.add"; toast: Toast }
  | { type: "toast.remove"; id: number }
  | { type: "ui"; patch: Partial<UiPrefs> }
  | { type: "dialog"; dialog: Dialog };

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
  next[idx] = { ...it, text: it.text + delta };
  return next;
}

function byTs(a: EgressEvent, b: EgressEvent): number {
  return a.ts < b.ts ? -1 : a.ts > b.ts ? 1 : 0;
}

function mergeEgress(existing: EgressEvent[], incoming: EgressEvent[]): EgressEvent[] {
  if (incoming.length === 0) return existing;
  const map = new Map<string, EgressEvent>();
  for (const e of existing) map.set(e.id, e);
  for (const e of incoming) map.set(e.id, e);
  const all = [...map.values()].sort(byTs);
  return all.length > MAX_EGRESS ? all.slice(all.length - MAX_EGRESS) : all;
}

function selectSession(state: State, id: string | null): State {
  const transcripts = { ...state.transcripts };
  const prev = state.selectedSessionId;
  if (prev && prev !== id && transcripts[prev]) transcripts[prev] = { ...transcripts[prev], source: "stale" };
  // keep a small cache of recently viewed transcripts
  const keys = Object.keys(transcripts);
  if (keys.length > 8) for (const k of keys) if (k !== id && k !== prev) delete transcripts[k];
  const session = id ? state.sessions[id] : undefined;
  const personaId = session ? session.personaId : state.selectedPersonaId;
  const ui =
    session && personaId
      ? { ...state.ui, lastSession: { ...state.ui.lastSession, [personaId]: session.id } }
      : state.ui;
  return { ...state, selectedSessionId: id, selectedPersonaId: personaId, transcripts, ui, view: id ? "chat" : state.view };
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
      let next: State = { ...state, personas: a.personas };
      if (next.selectedPersonaId && !a.personas.some((p) => p.id === next.selectedPersonaId)) {
        next = { ...next, selectedPersonaId: null, selectedSessionId: null };
      }
      if (!next.selectedPersonaId && a.personas.length > 0) {
        next = { ...next, selectedPersonaId: a.personas[0].id };
      }
      return next;
    }
    case "persona.upsert": {
      const exists = state.personas.some((p) => p.id === a.persona.id);
      const personas = exists
        ? state.personas.map((p) => (p.id === a.persona.id ? a.persona : p))
        : [...state.personas, a.persona];
      return { ...state, personas };
    }
    case "persona.remove": {
      const personas = state.personas.filter((p) => p.id !== a.id);
      const sel = state.selectedPersonaId === a.id;
      return {
        ...state,
        personas,
        selectedPersonaId: sel ? (personas[0]?.id ?? null) : state.selectedPersonaId,
        selectedSessionId: sel ? null : state.selectedSessionId,
      };
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
      return { ...state, credentials };
    }
    case "credential.remove":
      return { ...state, credentials: state.credentials.filter((c) => c.name !== a.name) };
    case "sessions.forPersona": {
      const sessions: Record<string, SessionSummary> = {};
      for (const [id, s] of Object.entries(state.sessions)) if (s.personaId !== a.personaId) sessions[id] = s;
      for (const s of a.sessions) sessions[s.id] = s;
      let selectedSessionId = state.selectedSessionId;
      if (selectedSessionId && !sessions[selectedSessionId] && state.selectedPersonaId === a.personaId) {
        selectedSessionId = null;
      }
      return { ...state, sessions, selectedSessionId };
    }
    case "session.upsert":
      return { ...state, sessions: { ...state.sessions, [a.session.id]: a.session } };
    case "session.remove": {
      if (!state.sessions[a.id] && state.selectedSessionId !== a.id) return state;
      const sessions = { ...state.sessions };
      delete sessions[a.id];
      const transcripts = { ...state.transcripts };
      delete transcripts[a.id];
      return {
        ...state,
        sessions,
        transcripts,
        selectedSessionId: state.selectedSessionId === a.id ? null : state.selectedSessionId,
      };
    }
    case "transcript.set": {
      const cur = state.transcripts[a.sessionId];
      // A live snapshot always wins over an HTTP fetch that may have raced with it.
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
      let egress: EgressEvent[];
      if (!last || (last.ts <= a.event.ts && !list.some((e) => e.id === a.event.id))) {
        egress = list.length >= MAX_EGRESS ? [...list.slice(list.length - MAX_EGRESS + 1), a.event] : [...list, a.event];
      } else {
        egress = mergeEgress(list, [a.event]);
      }
      return { ...state, egress };
    }
    case "egress.clear":
      return { ...state, egress: [] };
    case "select.persona": {
      if (a.id === state.selectedPersonaId) return { ...state, view: "chat" };
      const remembered = a.id ? state.ui.lastSession[a.id] : undefined;
      const sessionId = remembered && state.sessions[remembered] ? remembered : null;
      const next = selectSession({ ...state, selectedPersonaId: a.id }, sessionId);
      return { ...next, selectedPersonaId: a.id, view: "chat" };
    }
    case "select.session":
      return selectSession(state, a.id);
    case "view":
      return { ...state, view: a.view };
    case "toast.add": {
      // Do not stack identical toasts (e.g. repeated connection errors).
      const dupe = state.toasts.find((t) => t.text === a.toast.text && t.kind === a.toast.kind);
      const toasts = dupe ? state.toasts.filter((t) => t !== dupe) : state.toasts;
      return { ...state, toasts: [...toasts.slice(-4), a.toast] };
    }
    case "toast.remove":
      return { ...state, toasts: state.toasts.filter((t) => t.id !== a.id) };
    case "ui":
      return { ...state, ui: { ...state.ui, ...a.patch } };
    case "dialog":
      return { ...state, dialog: a.dialog };
  }
}

// ---------- Actions ----------

export interface Actions {
  getState(): State;
  toast(kind: ToastKind, text: string, opts?: { title?: string; icon?: "key" }): void;
  dismissToast(id: number): void;
  reportError(e: unknown, context?: string): void;
  setUi(patch: Partial<UiPrefs>): void;
  openDialog(dialog: Dialog): void;
  selectPersona(id: string | null): void;
  selectSession(id: string | null): void;
  showView(view: State["view"]): void;
  openRightTab(tab: RightTab): void;

  retryConnection(): void;
  loadAll(): Promise<void>;
  refreshSessions(personaId: string): Promise<void>;
  refreshProviders(): Promise<void>;
  mergeEgress(events: EgressEvent[]): void;
  clearEgress(): void;

  createSession(personaId: string): Promise<SessionSummary | null>;
  sendMessage(sessionId: string, text: string): Promise<boolean>;
  interrupt(sessionId: string): Promise<void>;
  approve(sessionId: string, toolUseId: string, body: ApprovalBody): Promise<boolean>;
  stopSession(sessionId: string): Promise<void>;
  deleteSession(sessionId: string): Promise<boolean>;

  /** Throw on failure so forms can show the error inline. */
  createPersona(id: string, yaml: string): Promise<PersonaSummary>;
  savePersona(id: string, yaml: string): Promise<PersonaSummary>;
  deletePersona(id: string): Promise<boolean>;
  putCredential(name: string, body: CredentialUpsert): Promise<CredentialStatus>;
  deleteCredential(name: string): Promise<boolean>;
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

  const actions = useMemo<Actions>(() => {
    const toast: Actions["toast"] = (kind, text, opts) => {
      toastSeq.current += 1;
      dispatch({ type: "toast.add", toast: { id: toastSeq.current, kind, text, ...opts } });
    };

    const reportError: Actions["reportError"] = (e, context) => {
      if (e instanceof ApiError && e.unreachable) {
        toast("error", "Cannot reach the harness server");
        return;
      }
      if (e instanceof ApiError && (e.status === 401 || e.status === 403)) return; // full-screen state handles it
      const msg = errorMessage(e);
      toast("error", context ? `${context}: ${msg}` : msg);
    };

    const inflightSessions = new Map<string, Promise<void>>();
    const refreshSessions = (personaId: string): Promise<void> => {
      const existing = inflightSessions.get(personaId);
      if (existing) return existing;
      const p = (async () => {
        try {
          const sessions = await api.sessions(personaId);
          dispatch({ type: "sessions.forPersona", personaId, sessions });
        } catch (e) {
          reportError(e, "Loading sessions");
        } finally {
          inflightSessions.delete(personaId);
        }
      })();
      inflightSessions.set(personaId, p);
      return p;
    };

    const refreshProviders = async () => {
      try {
        dispatch({ type: "providers", providers: await api.providers() });
      } catch {
        /* non-critical */
      }
    };

    const loadAll = async () => {
      const [runtime, providers, personas, credentials, egress] = await Promise.allSettled([
        api.runtime(),
        api.providers(),
        api.personas(),
        api.credentials(),
        api.egress({ limit: 200 }),
      ]);
      if (runtime.status === "fulfilled") dispatch({ type: "runtime", runtime: runtime.value });
      if (providers.status === "fulfilled") dispatch({ type: "providers", providers: providers.value });
      if (credentials.status === "fulfilled") dispatch({ type: "credentials", credentials: credentials.value });
      if (egress.status === "fulfilled") dispatch({ type: "egress.merge", events: egress.value });
      if (personas.status === "fulfilled") {
        dispatch({ type: "personas", personas: personas.value });
        dispatch({ type: "loaded" });
        loadFailed.current = false;
      } else {
        loadFailed.current = true;
        // A real server error (not "unreachable"/auth) should not trap the UI on the connecting screen.
        const r = personas.reason;
        if (r instanceof ApiError && !r.unreachable && r.status !== 401 && r.status !== 403) dispatch({ type: "loaded" });
      }
      const failures = [runtime, providers, personas, credentials, egress].filter(
        (r): r is PromiseRejectedResult => r.status === "rejected",
      );
      const firstReal = failures.find((f) => !(f.reason instanceof ApiError && f.reason.unreachable));
      if (firstReal) reportError(firstReal.reason);
      if (personas.status !== "fulfilled") return;
      // A newly auto-selected persona is loaded by the selection effect instead.
      const pid = stateRef.current.selectedPersonaId;
      if (pid && personas.value.some((p) => p.id === pid)) await refreshSessions(pid);
      const sid = stateRef.current.selectedSessionId;
      if (sid) ensureTranscript(sid);
    };

    let transcriptTimer: number | null = null;
    /** Live snapshot via WS is preferred; fall back to REST when the socket is down or slow. */
    const ensureTranscript = (sessionId: string) => {
      if (transcriptTimer !== null) window.clearTimeout(transcriptTimer);
      transcriptTimer = null;
      const t = stateRef.current.transcripts[sessionId];
      if (t?.source === "ws") return;
      if (!socketRef.current?.isOpen) {
        void fetchTranscript(sessionId);
        return;
      }
      transcriptTimer = window.setTimeout(() => {
        transcriptTimer = null;
        const cur = stateRef.current;
        if (cur.selectedSessionId === sessionId && cur.transcripts[sessionId]?.source !== "ws") {
          void fetchTranscript(sessionId);
        }
      }, 2500);
    };

    const fetchTranscript = async (sessionId: string) => {
      try {
        const res = await api.session(sessionId);
        dispatch({ type: "session.upsert", session: res.session });
        dispatch({ type: "transcript.set", sessionId, items: res.items, source: "rest" });
      } catch (e) {
        if (e instanceof ApiError && e.status === 404) {
          dispatch({ type: "session.remove", id: sessionId });
          return;
        }
        if (!(e instanceof ApiError && e.unreachable)) reportError(e, "Loading session");
      }
    };

    return {
      getState: () => stateRef.current,
      toast,
      dismissToast: (id) => dispatch({ type: "toast.remove", id }),
      reportError,
      setUi: (patch) => dispatch({ type: "ui", patch }),
      openDialog: (dialog) => dispatch({ type: "dialog", dialog }),
      selectPersona: (id) => dispatch({ type: "select.persona", id }),
      selectSession: (id) => {
        dispatch({ type: "select.session", id });
        if (id) ensureTranscript(id);
      },
      showView: (view) => dispatch({ type: "view", view }),
      openRightTab: (tab) => dispatch({ type: "ui", patch: { rightOpen: true, rightTab: tab } }),

      retryConnection: () => {
        socketRef.current?.retryNow();
        void loadAll();
      },
      loadAll,
      refreshSessions,
      refreshProviders,
      mergeEgress: (events) => dispatch({ type: "egress.merge", events }),
      clearEgress: () => dispatch({ type: "egress.clear" }),

      createSession: async (personaId) => {
        try {
          const session = await api.createSession(personaId);
          dispatch({ type: "session.upsert", session });
          dispatch({ type: "transcript.set", sessionId: session.id, items: [], source: "rest" });
          dispatch({ type: "select.session", id: session.id });
          return session;
        } catch (e) {
          reportError(e, "New session");
          return null;
        }
      },
      sendMessage: async (sessionId, text) => {
        try {
          await api.sendMessage(sessionId, text);
          return true;
        } catch (e) {
          reportError(e, "Send failed");
          return false;
        }
      },
      interrupt: async (sessionId) => {
        try {
          await api.interrupt(sessionId);
        } catch (e) {
          reportError(e, "Interrupt failed");
        }
      },
      approve: async (sessionId, toolUseId, body) => {
        try {
          await api.approve(sessionId, toolUseId, body);
          return true;
        } catch (e) {
          reportError(e, "Approval failed");
          return false;
        }
      },
      stopSession: async (sessionId) => {
        try {
          const session = await api.stopSession(sessionId);
          dispatch({ type: "session.upsert", session });
        } catch (e) {
          reportError(e, "Stop failed");
        }
      },
      deleteSession: async (sessionId) => {
        try {
          await api.deleteSession(sessionId);
          dispatch({ type: "session.remove", id: sessionId });
          return true;
        } catch (e) {
          reportError(e, "Delete session failed");
          return false;
        }
      },

      createPersona: async (id, yaml) => {
        const persona = await api.createPersona(id, yaml);
        dispatch({ type: "persona.upsert", persona });
        dispatch({ type: "select.persona", id: persona.id });
        return persona;
      },
      savePersona: async (id, yaml) => {
        const persona = await api.savePersonaSource(id, yaml);
        dispatch({ type: "persona.upsert", persona });
        return persona;
      },
      deletePersona: async (id) => {
        try {
          await api.deletePersona(id);
          dispatch({ type: "persona.remove", id });
          toast("success", `Persona ${id} deleted`);
          return true;
        } catch (e) {
          reportError(e, "Delete persona failed");
          return false;
        }
      },
      putCredential: async (name, body) => {
        const credential = await api.putCredential(name, body);
        dispatch({ type: "credential.upsert", credential });
        // When live, the credentials.updated event produces the "reloaded" toast.
        if (!socketRef.current?.isOpen) toast("success", `Saved ${name}`, { icon: "key" });
        return credential;
      },
      deleteCredential: async (name) => {
        try {
          await api.deleteCredential(name);
          dispatch({ type: "credential.remove", name });
          return true;
        } catch (e) {
          reportError(e, "Delete credential failed");
          return false;
        }
      },
      rebuildRuntime: async () => {
        try {
          dispatch({ type: "runtime", runtime: await api.rebuildRuntime() });
        } catch (e) {
          reportError(e, "Rebuild failed");
        }
      },
    };
  }, []);

  // Server events -> state
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
        if (ev.changed.length > 0) {
          actions.toast("success", ev.changed.join(", "), { title: "Credentials reloaded", icon: "key" });
        }
        void actions.refreshProviders();
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
    }
  };

  // Connection lifecycle
  useEffect(() => {
    const token = state.token;
    if (!token) {
      // Dev convenience: poll index.html until the server has written its token, then reload.
      const t = window.setInterval(async () => {
        if (await probeToken()) window.location.reload();
      }, 3000);
      return () => window.clearInterval(t);
    }
    configureApi(token, (h: ApiHealth) => {
      dispatch({ type: "server", server: h });
    });
    const socket = new EventSocket(wsUrl(token), {
      onEvent: (ev) => onEvent.current(ev),
      onState: (ws) => {
        dispatch({ type: "ws", ws });
        if (ws.status === "closed") dispatch({ type: "transcripts.stale" });
      },
      onOpen: (reconnect) => {
        dispatch({ type: "server", server: "ok" });
        if (reconnect || loadFailed.current) void actions.loadAll();
      },
    });
    socketRef.current = socket;
    socket.setSubscription(stateRef.current.selectedSessionId);
    socket.start();
    void actions.loadAll();
    return () => {
      socket.stop();
      socketRef.current = null;
    };
  }, [state.token, actions]);

  // Keep the socket subscribed to the open session.
  useEffect(() => {
    socketRef.current?.setSubscription(state.selectedSessionId);
  }, [state.selectedSessionId]);

  // Load the session list of the selected persona.
  useEffect(() => {
    if (state.loaded && state.selectedPersonaId) void actions.refreshSessions(state.selectedPersonaId);
  }, [state.loaded, state.selectedPersonaId, actions]);

  // Persist selection and layout prefs.
  useEffect(() => {
    savePref(SELECTION_KEY, { personaId: state.selectedPersonaId, sessionId: state.selectedSessionId });
  }, [state.selectedPersonaId, state.selectedSessionId]);
  useEffect(() => {
    savePref(PREFS_KEY, state.ui);
  }, [state.ui]);

  const value = useMemo(() => ({ state, actions }), [state, actions]);
  return <StoreContext.Provider value={value}>{children}</StoreContext.Provider>;
}

// ---------- Selectors ----------

export function useSelectedPersona(): PersonaSummary | null {
  const { state } = useStore();
  return state.personas.find((p) => p.id === state.selectedPersonaId) ?? null;
}

export function useSelectedSession(): SessionSummary | null {
  const { state } = useStore();
  return state.selectedSessionId ? (state.sessions[state.selectedSessionId] ?? null) : null;
}

export function sessionsForPersona(state: State, personaId: string): SessionSummary[] {
  return Object.values(state.sessions)
    .filter((s) => s.personaId === personaId)
    .sort((a, b) => (a.createdAt < b.createdAt ? 1 : a.createdAt > b.createdAt ? -1 : 0));
}
