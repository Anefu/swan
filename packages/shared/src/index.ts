// Wire protocol shared by the harness server and the web UI.
// REST carries commands and queries; one WebSocket (/api/ws) carries live events.

export type ProviderType = "anthropic" | "openai";
export type Effort = "low" | "medium" | "high" | "xhigh" | "max";
export type FolderMode = "ro" | "rw";
export type PermissionMode = "allow" | "ask" | "deny";

// ---------- Personas (workspaces) ----------

export interface FolderMount {
  hostPath: string; // absolute path on the Mac
  mountPath: string; // path inside the sandbox, e.g. /workspace/api
  mode: FolderMode;
}

export interface McpServerSummary {
  name: string;
  kind: "stdio" | "http"; // stdio runs inside the sandbox; http is called from the host
  target: string; // command line or URL (never contains secret values)
}

export interface PersonaSummary {
  id: string; // file stem of personas/<id>.yaml
  name: string;
  description: string;
  model: { provider: string; id: string; effort?: Effort };
  folders: FolderMount[];
  skills: string[];
  mcpServers: McpServerSummary[];
  credentials: string[]; // secret names this persona may use
  missingCredentials: string[]; // subset of credentials with no value right now
  networkAllow: string[]; // host patterns reachable from the sandbox
  errors: string[]; // validation problems; a persona with errors cannot start sessions
}

export interface PersonaSource {
  id: string;
  yaml: string;
}

// ---------- Credentials ----------

export interface CredentialStatus {
  name: string;
  present: boolean; // has a value
  source: "yaml" | "env" | null;
  hosts: string[]; // hosts the proxy may send this secret to; empty = host-side use only
  injects: boolean; // proxy adds an auth header automatically for those hosts
  fingerprint: string | null; // first 8 hex chars of sha256(value), to spot rotations
  updatedAt: string | null; // ISO time this value last changed (per harness observation)
  usedBy: string[]; // persona ids that declare it
}

export interface CredentialUpsert {
  value?: string; // omit to keep the existing value (e.g. only change hosts)
  hosts?: string[];
  inject?: { header: string; format: string } | null; // format uses {value}, e.g. "Bearer {value}"
}

// ---------- Skills ----------

export interface SkillSummary {
  name: string;
  description: string;
  hostPath: string;
  source: string; // which skills directory it came from
}

// ---------- Sessions ----------

export type SessionStatus =
  | "starting" // container + MCP servers coming up
  | "idle" // waiting for the user
  | "running" // model or tools working
  | "awaiting_approval" // at least one tool call needs a decision
  | "error"
  | "stopped"; // container gone; sending a message resumes it

export interface Usage {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
}

export interface SessionSummary {
  id: string;
  personaId: string;
  title: string;
  status: SessionStatus;
  statusDetail?: string; // e.g. the error text, or "starting MCP server github"
  createdAt: string;
  updatedAt: string;
  model: { provider: string; id: string };
  usage: Usage;
}

export type ToolCallStatus =
  | "pending_approval"
  | "running"
  | "done"
  | "error"
  | "denied"
  | "interrupted";

export type ChatItem =
  | { kind: "user"; id: string; ts: string; text: string }
  | { kind: "assistant_text"; id: string; ts: string; text: string; streaming?: boolean }
  | { kind: "thinking"; id: string; ts: string; text: string; streaming?: boolean }
  | {
      kind: "tool_call";
      id: string; // tool_use id
      ts: string;
      name: string; // e.g. bash, read_file, mcp__github__create_issue
      source: "builtin" | "mcp" | "skill";
      input: unknown;
      inputPreview: string; // one-line summary for collapsed display
      status: ToolCallStatus;
      output?: string;
      isError?: boolean;
      durationMs?: number;
      approvalReason?: string; // why it needs approval (matched rule)
      denyReason?: string;
    }
  | { kind: "notice"; id: string; ts: string; level: "info" | "warn" | "error"; text: string };

export type ApprovalDecision = "allow" | "allow_always" | "deny";

export interface ApprovalBody {
  decision: ApprovalDecision;
  reason?: string; // shown to the model when denying
}

export interface ToolSummary {
  name: string;
  source: "builtin" | "mcp" | "skill";
  server?: string;
  description: string;
  permission: PermissionMode; // effective rule for this persona
}

// ---------- Egress (network audit) ----------

export type EgressDecision =
  | "injected" // MITM'd, one or more credentials substituted/injected
  | "inspected" // MITM'd, nothing injected
  | "tunneled" // allowed, passed through without TLS interception
  | "blocked";

export interface EgressEvent {
  id: string;
  ts: string;
  sessionId: string | null;
  personaId: string | null;
  method: string; // CONNECT, GET, POST...
  host: string;
  port: number;
  path?: string; // only known for inspected/injected/plain-http requests
  status?: number;
  decision: EgressDecision;
  credentials: string[]; // names used, never values
  reason?: string; // why blocked
  durationMs?: number;
  bytesUp?: number;
  bytesDown?: number;
}

// ---------- Runtime ----------

export interface RuntimeStatus {
  runtime: string; // "podman"
  available: boolean;
  version: string | null;
  imageReady: boolean;
  imageTag: string | null;
  networkReady: boolean;
  relayRunning: boolean;
  proxyPort: number;
  busy: string | null; // e.g. "building sandbox image"
  errors: string[];
}

export interface ProviderStatus {
  name: string;
  type: ProviderType;
  baseURL?: string;
  apiKeySecret?: string;
  ready: boolean; // key present (or not needed)
}

// ---------- REST endpoints ----------
// All requests need header `x-ph-token: <token>` (the token is in <meta name="ph-token">).
// Bodies are JSON. Errors come back as { error: string } with a 4xx/5xx status.
//
// GET    /api/runtime                         -> RuntimeStatus
// POST   /api/runtime/rebuild                 -> RuntimeStatus   (rebuild sandbox image)
// GET    /api/providers                       -> ProviderStatus[]
// GET    /api/personas                        -> PersonaSummary[]
// POST   /api/personas            {id,yaml}   -> PersonaSummary
// GET    /api/personas/:id/source             -> PersonaSource
// PUT    /api/personas/:id/source {yaml}      -> PersonaSummary
// DELETE /api/personas/:id                    -> { ok: true }
// GET    /api/personas/:id/tools              -> ToolSummary[]  (built-in + skill tools; MCP tools appear once a session runs)
// GET    /api/personas/:id/files?path=/workspace/x -> { path, entries: FileEntry[] } (path inside sandbox)
// GET    /api/personas/:id/file?path=...      -> { path, content, truncated }
// GET    /api/skills                          -> SkillSummary[]
// GET    /api/credentials                     -> CredentialStatus[]
// PUT    /api/credentials/:name   CredentialUpsert -> CredentialStatus
// DELETE /api/credentials/:name               -> { ok: true }
// GET    /api/sessions?personaId=             -> SessionSummary[] (newest first)
// POST   /api/sessions            {personaId, title?} -> SessionSummary
// GET    /api/sessions/:id                    -> { session: SessionSummary, items: ChatItem[] }
// GET    /api/sessions/:id/tools              -> ToolSummary[]
// POST   /api/sessions/:id/messages {text}    -> { ok: true }
// POST   /api/sessions/:id/interrupt          -> { ok: true }
// POST   /api/sessions/:id/approvals/:toolUseId ApprovalBody -> { ok: true }
// POST   /api/sessions/:id/stop               -> SessionSummary (removes container, keeps transcript)
// DELETE /api/sessions/:id                    -> { ok: true }  (also deletes transcript)
// GET    /api/egress?sessionId=&limit=200     -> EgressEvent[] (newest last)

export interface FileEntry {
  name: string;
  path: string; // sandbox path
  type: "file" | "dir";
  size: number;
}

// ---------- WebSocket ----------
// Connect to /api/ws?token=<token>. Global events (personas, credentials, runtime,
// sessions list, egress) are always sent. Item-level events are sent only for
// sessions the client subscribed to.

export type ClientMessage =
  | { type: "subscribe"; sessionId: string }
  | { type: "unsubscribe"; sessionId: string };

export type ServerEvent =
  | { type: "hello"; runtime: RuntimeStatus }
  | { type: "runtime.status"; runtime: RuntimeStatus }
  | { type: "personas.updated"; personas: PersonaSummary[] }
  | { type: "credentials.updated"; credentials: CredentialStatus[]; changed: string[] }
  | { type: "session.updated"; session: SessionSummary }
  | { type: "session.deleted"; sessionId: string }
  | { type: "session.snapshot"; session: SessionSummary; items: ChatItem[] } // reply to subscribe
  | { type: "item.added"; sessionId: string; item: ChatItem }
  | { type: "item.updated"; sessionId: string; item: ChatItem } // full replacement
  | { type: "item.delta"; sessionId: string; itemId: string; delta: string } // append to text
  | { type: "egress"; event: EgressEvent };
