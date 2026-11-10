// How each action changes the state. Pure: no requests, no timers.
import type { ChatItem, ConnectionStatus, EgressEvent, ModelOption, PendingApproval, PersonaSummary, ProviderStatus, RuntimeStatus, SessionSummary, SkillSummary } from "@ph/shared";
import type { WsState } from "../ws";
import { type ServerState, type DockMode, type Toast, type Transcript, type MemoryPaneState, DEFAULT_MEMORY_PANE, type SettingsDraft, type SettingsFocus, type DraftAttachment, type NetworkFilters, type State, MAX_EGRESS } from "./state";

export type Action =
  | { type: "server"; server: ServerState }
  | { type: "ws"; ws: WsState }
  | { type: "loaded" }
  | { type: "runtime"; runtime: RuntimeStatus }
  | { type: "providers"; providers: ProviderStatus[] }
  | { type: "personas"; personas: PersonaSummary[] }
  | { type: "persona.upsert"; persona: PersonaSummary }
  | { type: "connections"; connections: ConnectionStatus[]; changed?: string[] }
  | { type: "connection.upsert"; connection: ConnectionStatus; changed?: string }
  | { type: "connection.remove"; name: string }
  | { type: "secrets"; error: string | null }
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
  | { type: "item.deltas"; deltas: Array<{ sessionId: string; itemId: string; delta: string }> }
  | { type: "egress.merge"; events: EgressEvent[] }
  | { type: "egress.add"; event: EgressEvent }
  | { type: "select.persona"; id: string | null }
  | { type: "dock"; dock: DockMode | null }
  | { type: "dock.width"; mode: DockMode; width: number }
  | { type: "settings.new"; isNew: boolean }
  | { type: "import.file"; file: { name: string; text: string } | null }
  | { type: "settings.section"; section: string | null }
  | { type: "settings.focus"; focus: SettingsFocus | null }
  | { type: "draft.set"; key: string; draft: SettingsDraft | null }
  | { type: "memoryPane"; personaId: string; patch: Partial<MemoryPaneState> }
  | { type: "composer"; personaId: string; text: string }
  | { type: "network"; patch: Partial<NetworkFilters> }
  | { type: "att.add"; personaId: string; att: DraftAttachment }
  | { type: "att.update"; personaId: string; key: string; patch: Partial<DraftAttachment> }
  | { type: "att.remove"; personaId: string; key: string }
  | { type: "att.clear"; personaId: string; keys: string[] }
  | { type: "focus.approval"; sessionId: string; toolUseId: string }
  | { type: "focus.item"; sessionId: string; itemId: string }
  | { type: "personaMenu.open" }
  | { type: "rev"; which: "usageRev" | "memoryRev" | "trackerRev" | "triggersRev" | "changesRev"; personaId: string }
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

export function reducer(state: State, a: Action): State {
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
    case "connections": {
      let flash = state.credentialFlash;
      if (a.changed && a.changed.length > 0) {
        const now = Date.now();
        flash = { ...flash };
        for (const n of a.changed) flash[n] = now;
      }
      return { ...state, connections: a.connections, credentialFlash: flash };
    }
    case "connection.upsert": {
      const exists = state.connections.some((c) => c.name === a.connection.name);
      const connections = exists
        ? state.connections.map((c) => (c.name === a.connection.name ? a.connection : c))
        : [...state.connections, a.connection].sort((x, y) => x.name.localeCompare(y.name));
      const credentialFlash = a.changed ? { ...state.credentialFlash, [a.changed]: Date.now() } : state.credentialFlash;
      return { ...state, connections, credentialFlash };
    }
    case "connection.remove":
      return { ...state, connections: state.connections.filter((c) => c.name !== a.name) };
    case "secrets":
      return { ...state, secretsError: a.error };
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
    case "item.deltas": {
      let transcripts = state.transcripts;
      for (const d of a.deltas) {
        const cur = transcripts[d.sessionId];
        if (!cur) continue;
        const items = appendDelta(cur.items, d.itemId, d.delta);
        if (items === cur.items) continue;
        if (transcripts === state.transcripts) transcripts = { ...transcripts };
        transcripts[d.sessionId] = { ...cur, items };
      }
      return transcripts === state.transcripts ? state : { ...state, transcripts };
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
    case "dock":
      return { ...state, ui: { ...state.ui, dock: a.dock } };
    case "dock.width":
      return { ...state, ui: { ...state.ui, widths: { ...state.ui.widths, [a.mode]: a.width } } };
    case "settings.new":
      return { ...state, settingsNew: a.isNew };
    case "import.file":
      return { ...state, importFile: a.file };
    case "settings.section":
      return { ...state, settingsSection: a.section };
    case "settings.focus":
      return { ...state, settingsFocus: a.focus };
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
    case "att.add":
      return { ...state, attachments: { ...state.attachments, [a.personaId]: [...(state.attachments[a.personaId] ?? []), a.att] } };
    case "att.update": {
      const list = state.attachments[a.personaId];
      if (!list) return state;
      return {
        ...state,
        attachments: { ...state.attachments, [a.personaId]: list.map((x) => (x.key === a.key ? { ...x, ...a.patch } : x)) },
      };
    }
    case "att.remove":
      return {
        ...state,
        attachments: { ...state.attachments, [a.personaId]: (state.attachments[a.personaId] ?? []).filter((x) => x.key !== a.key) },
      };
    case "att.clear":
      return {
        ...state,
        attachments: {
          ...state.attachments,
          [a.personaId]: (state.attachments[a.personaId] ?? []).filter((x) => !a.keys.includes(x.key)),
        },
      };
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
