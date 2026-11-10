import { createContext, useContext, useEffect, useMemo, useReducer, useRef, type ReactNode } from "react";
import type { PendingApproval, PersonaSummary, ServerEvent } from "@ph/shared";
import { configureApi, probeToken, type ApiHealth } from "./api";
import { savePref } from "./util";
import { EventSocket, wsUrl } from "./ws";
import { type State, PREFS_KEY, SELECTION_KEY, COMPOSER_KEY, initState } from "./state/state";
import { reducer } from "./state/reducer";
import { type Actions, createActions } from "./state/actions";
import { pendingApprovals } from "./state/selectors";

// The store is the UI's one way into the state: these live in state/ and are used across components.
export { CHANGES_DEFAULT, DEFAULT_MEMORY_PANE, DOCK_DEFAULT, NEW_PERSONA, attachmentPreviews, dockWidthKey, inRail } from "./state/state";
export type { DockMode, DraftAttachment, MemoryPaneState, ServerState, SettingsDraft, SettingsFocus, State, Toast, ToastKind } from "./state/state";
export { conversationSession, modelLabel, pendingApprovals } from "./state/selectors";
export type { Actions } from "./state/actions";

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

  const { actions, loadAll } = useMemo(() => createActions({ dispatch, stateRef, socketRef, toastSeq, loadFailed }), []);

  // Streaming deltas are applied once per animation frame; any other event flushes them first so a
  // full replacement (item.updated, snapshot) never gets stale text appended after it.
  const deltaBuf = useRef<Array<{ sessionId: string; itemId: string; delta: string }>>([]);
  const deltaFrame = useRef<number | null>(null);
  const flushDeltas = () => {
    if (deltaFrame.current !== null) {
      cancelAnimationFrame(deltaFrame.current);
      deltaFrame.current = null;
    }
    if (deltaBuf.current.length === 0) return;
    const deltas = deltaBuf.current;
    deltaBuf.current = [];
    dispatch({ type: "item.deltas", deltas });
  };

  const onEvent = useRef<(ev: ServerEvent) => void>(() => {});
  onEvent.current = (ev: ServerEvent) => {
    if (ev.type === "item.delta") {
      const buf = deltaBuf.current;
      const last = buf[buf.length - 1];
      if (last && last.sessionId === ev.sessionId && last.itemId === ev.itemId) last.delta += ev.delta;
      else buf.push({ sessionId: ev.sessionId, itemId: ev.itemId, delta: ev.delta });
      if (deltaFrame.current === null) deltaFrame.current = requestAnimationFrame(flushDeltas);
      return;
    }
    flushDeltas();
    switch (ev.type) {
      case "hello":
      case "runtime.status":
        dispatch({ type: "runtime", runtime: ev.runtime });
        break;
      case "personas.updated":
        dispatch({ type: "personas", personas: ev.personas });
        break;
      case "connections.updated": {
        // Command connections renew on their own; only hand-edited (static) values are worth a toast.
        const known = [...ev.connections, ...stateRef.current.connections];
        const isStatic = (ref: string) => known.find((c) => c.name === ref.slice(0, ref.indexOf("/")))?.type !== "command";
        const changed = ev.changed.filter(isStatic);
        dispatch({ type: "connections", connections: ev.connections, changed });
        if (changed.length > 0) actions.toast("success", `${changed.join(", ")} reloaded, no restart`, "Connections");
        break;
      }
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
      case "egress":
        dispatch({ type: "egress.add", event: ev.event });
        break;
      case "approvals.updated":
        dispatch({ type: "approvals", approvals: ev.approvals });
        break;
      case "secrets.status":
        dispatch({ type: "secrets", error: ev.error });
        break;
      case "providers.updated":
        dispatch({ type: "providers", providers: ev.providers });
        break;
      case "usage.updated":
        dispatch({ type: "rev", which: "usageRev", personaId: ev.personaId });
        break;
      case "memory.updated":
        dispatch({ type: "rev", which: "memoryRev", personaId: ev.personaId });
        break;
      case "tracker.updated":
        dispatch({ type: "rev", which: "trackerRev", personaId: ev.personaId });
        break;
      case "triggers.updated":
        dispatch({ type: "rev", which: "triggersRev", personaId: ev.personaId });
        break;
      case "changes.updated":
        dispatch({ type: "rev", which: "changesRev", personaId: ev.sessionId });
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

export function usePendingApprovals(): PendingApproval[] {
  const { state } = useStore();
  return useMemo(() => pendingApprovals(state), [state.approvals, state.transcripts, state.sessions]); // eslint-disable-line react-hooks/exhaustive-deps
}
