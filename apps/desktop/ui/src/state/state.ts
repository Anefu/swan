// The app's state: its shape, the defaults it starts from, and what is kept between launches.
import type { AttachmentMeta, ChatItem, ConnectionStatus, CredentialRule, EgressEvent, MigrationNote, ModelOption, PendingApproval, PersonaConfigView, PersonaSummary, ProviderStatus, RuntimeStatus, SaveResult, SessionSummary, SkillSummary } from "@ph/shared";
import { readToken } from "../api";
import { loadPref } from "../util";
import type { WsState } from "../ws";

export type ServerState = "loading" | "ok" | "unreachable" | "unauthorized" | "no-token";
export type ToastKind = "info" | "success" | "warn" | "error";
/**
 * "overview" is the rail of cards; memory, usage, network and attachments open from it and lead back to it.
 * "settings" is the selected persona's settings; "swan" is Swan's own (providers, connections, sandbox).
 */
export type DockMode = "overview" | "settings" | "swan" | "memory" | "usage" | "network" | "attachments" | "import" | "tracker" | "triggers" | "changes";
export const RAIL_MODES: readonly DockMode[] = ["overview", "memory", "usage", "network", "attachments", "tracker", "triggers"];
export const inRail = (mode: DockMode | null): boolean => !!mode && RAIL_MODES.includes(mode);
/** The rail and the screens it opens share one width, so moving between them never jumps. */
export const dockWidthKey = (mode: DockMode): DockMode => (inRail(mode) ? "overview" : mode);
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
  sub: "saved" | "current" | "history";
  query: string;
  type: string;
  status: string;
  expanded: string | null;
  period: "today" | "all";
}

export const DEFAULT_MEMORY_PANE: MemoryPaneState = {
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
  /** The persona changed outside this form (e.g. "Always allow") while it had unsaved edits. */
  outdated?: boolean;
}

/** Open persona Settings at a section, optionally adding a credential rule to the draft (never saved by itself). */
export interface SettingsFocus {
  personaId: string;
  section: "connections";
  rule?: { connection: string; rule: CredentialRule };
  seq: number;
}

export interface DraftAttachment {
  key: string;
  name: string;
  size: number;
  mediaType: string;
  status: "uploading" | "done" | "error";
  progress: number;
  meta?: AttachmentMeta;
  error?: string;
  /** Object URL for image thumbnails in this browser session. */
  previewUrl?: string;
}

export const MAX_ATTACHMENT_BYTES = 20 * 1024 * 1024;
export const MAX_ATTACHMENTS = 20;

/** Attachment id -> local object URL, so sent images can show a thumbnail in this browser session. */
export const attachmentPreviews = new Map<string, string>();

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
  connections: ConnectionStatus[];
  /** Static credential ref -> when it last changed, for the "reloaded, no restart" line. */
  credentialFlash: Record<string, number>;
  migration: MigrationNote | null;
  secretsError: string | null; // why secrets.yaml / secrets.env cannot be read
  skills: SkillSummary[];
  /** null = not loaded or the server has no /api/models. */
  models: ModelOption[] | null;
  /** null = the server has no /api/approvals; pending calls are derived from loaded transcripts. */
  approvals: PendingApproval[] | null;
  /** personaId -> sessionId of the conversation on screen */
  conversations: Record<string, string>;
  conversationError: Record<string, string>;
  sessions: Record<string, SessionSummary>;
  transcripts: Record<string, Transcript>;
  egress: EgressEvent[];
  selectedPersonaId: string | null;
  /** Settings shows the new-persona draft instead of the selected persona. */
  settingsNew: boolean;
  /** The settings section opened from the list of cards; null shows the list. */
  settingsSection: string | null;
  settingsFocus: SettingsFocus | null;
  drafts: Record<string, SettingsDraft>;
  memoryPane: Record<string, MemoryPaneState>;
  composer: Record<string, string>;
  attachments: Record<string, DraftAttachment[]>;
  network: NetworkFilters;
  focusApproval: { sessionId: string; toolUseId: string; seq: number } | null;
  focusItem: { sessionId: string; itemId: string; seq: number } | null;
  personaMenuSeq: number;
  /** A persona file chosen for import; the import pane previews it. */
  importFile: { name: string; text: string } | null;
  usageRev: Record<string, number>;
  memoryRev: Record<string, number>;
  trackerRev: Record<string, number>;
  triggersRev: Record<string, number>;
  changesRev: Record<string, number>;
  toasts: Toast[];
  ui: UiPrefs;
}

export const PREFS_KEY = "swan.ui.v1";
export const SELECTION_KEY = "swan.persona.v1";
export const COMPOSER_KEY = "swan.composer.v1";
export const MAX_EGRESS = 2000;

export const DOCK_DEFAULT = 380;
export const CHANGES_DEFAULT = 680; // code needs the room
const DEFAULT_UI: UiPrefs = {
  dock: null,
  widths: { overview: DOCK_DEFAULT, settings: DOCK_DEFAULT, swan: DOCK_DEFAULT, memory: DOCK_DEFAULT, usage: DOCK_DEFAULT, network: DOCK_DEFAULT, attachments: DOCK_DEFAULT, import: DOCK_DEFAULT, tracker: DOCK_DEFAULT, triggers: DOCK_DEFAULT, changes: CHANGES_DEFAULT },
};

/** Saved prefs hold every width, chosen or not; 400 and 440 were earlier defaults, so they move to the new one. */
function loadUi(): UiPrefs {
  const ui = loadPref(PREFS_KEY, DEFAULT_UI);
  const widths = { ...DEFAULT_UI.widths, ...ui.widths };
  for (const k of Object.keys(widths) as DockMode[]) if (widths[k] === 400 || widths[k] === 440) widths[k] = DOCK_DEFAULT;
  return { ...DEFAULT_UI, ...ui, widths };
}

export function initState(): State {
  const token = readToken();
  return {
    token,
    server: token ? "loading" : "no-token",
    ws: { status: "connecting", attempt: 0, nextRetryAt: null },
    loaded: false,
    runtime: null,
    providers: [],
    personas: [],
    connections: [],
    credentialFlash: {},
    migration: null,
    secretsError: null,
    skills: [],
    models: null,
    approvals: null,
    conversations: {},
    conversationError: {},
    sessions: {},
    transcripts: {},
    egress: [],
    selectedPersonaId: loadPref<{ id: string | null }>(SELECTION_KEY, { id: null }).id,
    settingsNew: false,
    settingsSection: null,
    settingsFocus: null,
    drafts: {},
    memoryPane: {},
    composer: loadPref<Record<string, string>>(COMPOSER_KEY, {}),
    attachments: {},
    network: { query: "", range: "today", onlyBlocked: false, expanded: null },
    focusApproval: null,
    focusItem: null,
    personaMenuSeq: 0,
    importFile: null,
    usageRev: {},
    memoryRev: {},
    trackerRev: {},
    triggersRev: {},
    changesRev: {},
    toasts: [],
    ui: loadUi(),
  };
}
