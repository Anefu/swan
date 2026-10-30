import type {
  ApprovalBody,
  ChatItem,
  Checkpoint,
  Effort,
  MemoryChange,
  MemoryRecord,
  MemoryType,
  ModelOption,
  PendingApproval,
  PersonaConfigView,
  ProviderAllowance,
  SaveResult,
  SlashCommand,
  UsageReport,
  CredentialStatus,
  CredentialUpsert,
  EgressEvent,
  FileEntry,
  PersonaSource,
  PersonaSummary,
  ProviderStatus,
  RuntimeStatus,
  SessionSummary,
  SkillSummary,
  ToolSummary,
} from "@ph/shared";

// Matches the un-substituted placeholder without spelling it out, so a server that
// rewrites the placeholder in served files can never rewrite this check.
const PLACEHOLDER_RE = /^__[A-Z_]+__$/;

function tokenFromDocument(doc: Document): string | null {
  const value = doc.querySelector<HTMLMetaElement>('meta[name="ph-token"]')?.content?.trim() ?? "";
  if (!value || PLACEHOLDER_RE.test(value)) return null;
  return value;
}

export function readToken(): string | null {
  return tokenFromDocument(document);
}

/** Re-fetch index.html and check whether a token is available now (dev: server just started). */
export async function probeToken(): Promise<string | null> {
  try {
    const res = await fetch(window.location.pathname || "/", { cache: "no-store" });
    if (!res.ok) return null;
    const html = await res.text();
    return tokenFromDocument(new DOMParser().parseFromString(html, "text/html"));
  } catch {
    return null;
  }
}

export class ApiError extends Error {
  readonly status: number;
  /** True when the server could not be reached at all (network error or proxy failure). */
  readonly unreachable: boolean;
  constructor(message: string, status: number, unreachable: boolean) {
    super(message);
    this.name = "ApiError";
    this.status = status;
    this.unreachable = unreachable;
  }
}

export type ApiHealth = "ok" | "unreachable" | "unauthorized";

let apiToken = "";
let healthListener: (h: ApiHealth) => void = () => {};

export function configureApi(token: string, onHealth: (h: ApiHealth) => void): void {
  apiToken = token;
  healthListener = onHealth;
}

async function request<T>(method: string, path: string, body?: unknown): Promise<T> {
  const headers: Record<string, string> = { "x-ph-token": apiToken, accept: "application/json" };
  const init: RequestInit = { method, headers, cache: "no-store" };
  if (body !== undefined) {
    headers["content-type"] = "application/json";
    init.body = JSON.stringify(body);
  }
  let res: Response;
  try {
    res = await fetch(path, init);
  } catch {
    healthListener("unreachable");
    throw new ApiError("Cannot reach the harness server", 0, true);
  }
  const text = await res.text().catch(() => "");
  let data: unknown = undefined;
  if (text) {
    try {
      data = JSON.parse(text);
    } catch {
      data = undefined;
    }
  }
  if (!res.ok) {
    const serverMsg =
      data && typeof data === "object" && "error" in data && typeof (data as { error: unknown }).error === "string"
        ? (data as { error: string }).error
        : null;
    // The Vite dev proxy answers 5xx with an empty/non-JSON body when the backend is down.
    const unreachable = !serverMsg && res.status >= 500;
    if (unreachable) healthListener("unreachable");
    else if (res.status === 401 || res.status === 403) healthListener("unauthorized");
    else healthListener("ok");
    throw new ApiError(
      serverMsg ?? (unreachable ? "Cannot reach the harness server" : `${method} ${path} failed (HTTP ${res.status})`),
      res.status,
      unreachable,
    );
  }
  healthListener("ok");
  return data as T;
}

const enc = encodeURIComponent;

export interface FileList {
  path: string;
  entries: FileEntry[];
}
export interface FileContent {
  path: string;
  content: string;
  truncated: boolean;
}
export interface Ok {
  ok: true;
}

export const api = {
  runtime: () => request<RuntimeStatus>("GET", "/api/runtime"),
  rebuildRuntime: () => request<RuntimeStatus>("POST", "/api/runtime/rebuild"),
  providers: () => request<ProviderStatus[]>("GET", "/api/providers"),

  personas: () => request<PersonaSummary[]>("GET", "/api/personas"),
  createPersona: (id: string, yaml: string) => request<PersonaSummary>("POST", "/api/personas", { id, yaml }),
  personaSource: (id: string) => request<PersonaSource>("GET", `/api/personas/${enc(id)}/source`),
  savePersonaSource: (id: string, yaml: string) =>
    request<PersonaSummary>("PUT", `/api/personas/${enc(id)}/source`, { yaml }),
  deletePersona: (id: string) => request<Ok>("DELETE", `/api/personas/${enc(id)}`),
  personaTools: (id: string) => request<ToolSummary[]>("GET", `/api/personas/${enc(id)}/tools`),
  files: (id: string, path: string) =>
    request<FileList>("GET", `/api/personas/${enc(id)}/files?path=${enc(path)}`),
  file: (id: string, path: string) => request<FileContent>("GET", `/api/personas/${enc(id)}/file?path=${enc(path)}`),

  skills: () => request<SkillSummary[]>("GET", "/api/skills"),

  credentials: () => request<CredentialStatus[]>("GET", "/api/credentials"),
  putCredential: (name: string, body: CredentialUpsert) =>
    request<CredentialStatus>("PUT", `/api/credentials/${enc(name)}`, body),
  deleteCredential: (name: string) => request<Ok>("DELETE", `/api/credentials/${enc(name)}`),

  sessions: (personaId?: string) =>
    request<SessionSummary[]>("GET", personaId ? `/api/sessions?personaId=${enc(personaId)}` : "/api/sessions"),
  createSession: (personaId: string, title?: string) =>
    request<SessionSummary>("POST", "/api/sessions", title ? { personaId, title } : { personaId }),
  session: (id: string) => request<{ session: SessionSummary; items: ChatItem[] }>("GET", `/api/sessions/${enc(id)}`),
  sessionTools: (id: string) => request<ToolSummary[]>("GET", `/api/sessions/${enc(id)}/tools`),
  sendMessage: (id: string, text: string) => request<Ok>("POST", `/api/sessions/${enc(id)}/messages`, { text }),
  interrupt: (id: string) => request<Ok>("POST", `/api/sessions/${enc(id)}/interrupt`),
  approve: (id: string, toolUseId: string, body: ApprovalBody) =>
    request<Ok>("POST", `/api/sessions/${enc(id)}/approvals/${enc(toolUseId)}`, body),
  stopSession: (id: string) => request<SessionSummary>("POST", `/api/sessions/${enc(id)}/stop`),
  deleteSession: (id: string) => request<Ok>("DELETE", `/api/sessions/${enc(id)}`),

  egress: (opts: { sessionId?: string; limit?: number } = {}) => {
    const q = new URLSearchParams();
    if (opts.sessionId) q.set("sessionId", opts.sessionId);
    q.set("limit", String(opts.limit ?? 200));
    return request<EgressEvent[]>("GET", `/api/egress?${q.toString()}`);
  },

  // ---------- Swan additions ----------
  conversation: (personaId: string) =>
    request<{ session: SessionSummary; items: ChatItem[] }>("GET", `/api/personas/${enc(personaId)}/conversation`),
  commands: (personaId: string) => request<SlashCommand[]>("GET", `/api/personas/${enc(personaId)}/commands`),
  config: (personaId: string) => request<PersonaConfigView>("GET", `/api/personas/${enc(personaId)}/config`),
  saveConfig: (personaId: string, view: PersonaConfigView) =>
    request<SaveResult>("PUT", `/api/personas/${enc(personaId)}/config`, view),
  setModel: (personaId: string, body: { provider: string; id: string; effort?: Effort }) =>
    request<PersonaSummary>("PUT", `/api/personas/${enc(personaId)}/model`, body),
  approvals: () => request<PendingApproval[]>("GET", "/api/approvals"),
  resetAllowances: (sessionId: string) => request<SessionSummary>("DELETE", `/api/sessions/${enc(sessionId)}/allowances`),
  removeAllowance: (sessionId: string, rule: string) =>
    request<SessionSummary>("DELETE", `/api/sessions/${enc(sessionId)}/allowances/${enc(rule)}`),
  models: () => request<ModelOption[]>("GET", "/api/models"),

  memory: (personaId: string, q: { query?: string; type?: string; status?: string } = {}) => {
    const p = new URLSearchParams();
    if (q.query) p.set("query", q.query);
    if (q.type) p.set("type", q.type);
    if (q.status) p.set("status", q.status);
    const qs = p.toString();
    return request<MemoryRecord[]>("GET", `/api/personas/${enc(personaId)}/memory${qs ? `?${qs}` : ""}`);
  },
  addMemory: (personaId: string, body: { content: string; type: MemoryType; pinned?: boolean }) =>
    request<MemoryRecord>("POST", `/api/personas/${enc(personaId)}/memory`, body),
  editMemory: (personaId: string, recordId: string, body: { content?: string; type?: MemoryType }) =>
    request<MemoryRecord>("PUT", `/api/personas/${enc(personaId)}/memory/${enc(recordId)}`, body),
  memoryAction: (personaId: string, recordId: string, action: "pin" | "unpin" | "archive" | "forget") =>
    request<MemoryRecord>("POST", `/api/personas/${enc(personaId)}/memory/${enc(recordId)}/${action}`),
  memoryHistory: (personaId: string) => request<MemoryChange[]>("GET", `/api/personas/${enc(personaId)}/memory-history`),
  checkpoint: (personaId: string) => request<Checkpoint | null>("GET", `/api/personas/${enc(personaId)}/checkpoint`),

  usage: (personaId: string, period: "today" | "all") =>
    request<UsageReport>("GET", `/api/usage?personaId=${enc(personaId)}&period=${period}`),
  allowance: (provider: string) => request<ProviderAllowance>("GET", `/api/providers/${enc(provider)}/allowance`),
};
