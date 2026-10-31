// Wire protocol shared by the harness server and the web UI.
// REST carries commands and queries; one WebSocket (/api/ws) carries live events.

export type ProviderType = "anthropic" | "openai" | "copilot";
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
  connections: string[]; // connection names the persona's rules use
  credentials: string[]; // "<connection>/<name>" refs its rules name
  missingCredentials: string[]; // refs with no usable value right now (missing, expired, needs sign-in)
  networkAllow: string[]; // host patterns reachable from the sandbox
  networkInternal: string[]; // also reachable, and may resolve to private (company) addresses
  errors: string[]; // validation problems; a persona with errors cannot start sessions
}

export interface PersonaSource {
  id: string;
  yaml: string;
}

// ---------- Connections ----------
// Every credential an agent can use comes from a connection defined in config.yaml. `static`
// connections read values from secrets.yaml / secrets.env; `command` connections run a wrapper
// that speaks connection protocol v1 (docs/connection-protocol-v1.schema.json).

export type ConnectionType = "static" | "command";
export type ConnectionState =
  | "ready" // every credential usable
  | "incomplete" // static: some credentials have no value
  | "signing_in" // command: waiting for the user to finish a device-code sign-in
  | "login_required" // command: needs a sign-in
  | "error"
  | "unknown"; // command: not checked yet (checked when a session needs it)
export type CredentialKind = "static" | "bearer" | "header" | "basic" | "aws-sigv4";
export type RuleApi = "kubernetes" | "aws" | "http";

export interface ConnectionCredentialStatus {
  name: string; // unique within the connection
  ref: string; // "<connection>/<name>"
  kind: CredentialKind;
  present: boolean; // has a usable value now (not expired)
  source: "yaml" | "env" | "command" | null;
  hosts: string[];
  injects: boolean;
  env?: string; // static: sandbox variable that holds the placeholder
  fingerprint: string | null; // first 8 hex chars of sha256(value)
  expiresAt: string | null;
  updatedAt: string | null;
  usedBy: string[]; // persona ids whose rules name it
}

export interface DeviceCode {
  verificationUri: string;
  userCode: string;
  verificationUriComplete?: string;
  expiresAt?: string;
}

export interface ConnectionStatus {
  name: string;
  type: ConnectionType;
  state: ConnectionState;
  message: string | null; // from the wrapper, or why it is incomplete / failed
  hosts: string[]; // command: upper bound for every credential's hosts
  command?: string[]; // command: the wrapper argv from config.yaml
  expiresAt: string | null; // earliest credential expiry
  lastRenewedAt: string | null;
  signIn: DeviceCode | null; // pending device-code sign-in
  credentials: ConnectionCredentialStatus[];
  usedBy: string[];
}

export interface CredentialUpsert {
  value?: string; // omit to keep the existing value (e.g. only change hosts)
  hosts?: string[];
  inject?: { header: string; format: string } | null; // format uses {value}, e.g. "Bearer {value}"
  env?: string | null; // sandbox variable; default: the credential name
}

export interface CredentialRule {
  credential: string; // name or glob within the connection
  api: RuleApi;
  allow?: string[];
  ask?: string[];
  deny?: string[];
}

export interface PersonaConnection {
  rules: CredentialRule[];
}

/** One-time note after converting the earlier secrets format. */
export interface MigrationNote {
  at: string;
  moved: string[]; // e.g. "GITHUB_TOKEN → github/GITHUB_TOKEN"
  personas: string[]; // persona ids whose credentials became rules
  kept: string[]; // host-less entries left in secrets.yaml
  problems: string[];
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
  epoch: number; // current context epoch (starts at 1)
  allowances: string[]; // "Allow until stopped" rules; cleared on stop, interrupt or restart
  queued: number; // user messages waiting to steer the next model step
}

export type ToolCallStatus =
  | "pending_approval"
  | "running"
  | "done"
  | "error"
  | "denied"
  | "interrupted";

export type ChatItem =
  | { kind: "user"; id: string; ts: string; text: string; attachments?: AttachmentMeta[] }
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
      parentId?: string; // set on calls made by a sub-agent: the id of its `agent` call
      agent?: AgentRun; // on `agent` calls: the sub-agent it started, kept current while it runs
    }
  | { kind: "notice"; id: string; ts: string; level: "info" | "warn" | "error"; text: string }
  // One-line record of a harness action: /dream, a context rollover, a queued steering message.
  | { kind: "receipt"; id: string; ts: string; action: "dream" | "rollover" | "steer" | "command" | "agent"; title: string; detail: string; status: "running" | "done" | "error" }
  // A command connection needs the user to sign in. Only the user sees the code and opens the link.
  | {
      kind: "sign_in";
      id: string;
      ts: string;
      connection: string;
      state: "starting" | "waiting" | "done" | "cancelled" | "failed";
      code?: DeviceCode;
      message?: string;
    }
  // Requests the proxy sent without the credential because no rule allowed them. Grouped per
  // credential and rule within a minute.
  | {
      kind: "credential_blocked";
      id: string;
      ts: string;
      credential: string; // ref
      api: RuleApi;
      rule: string | null; // the deny pattern, or null for "no rule"
      operations: string[]; // described requests, newest last (at most 5)
      count: number;
      suggestion: string; // allow pattern that would match the latest request
    };

// allow: this call (network: until stopped); allow_session: until stopped (credential use);
// allow_always: until stopped plus a persona change; deny.
/** A sub-agent started by an `agent` call. */
export interface AgentRun {
  id: string; // what agent_message / agent_stop take
  name: string; // the persona's sub-agent, or "auto"
  model: { provider: string; id: string; effort?: Effort };
  auto: boolean; // the parent chose the model (an auto sub-agent)
  context: "brief" | "fork";
  background: boolean;
  maxTurns: number;
  turns: number;
  state: "running" | "asking" | "done" | "error" | "stopped";
  question?: string; // while asking
  brief: string;
  startedAt: string;
  endedAt?: string;
}

export type ApprovalDecision = "allow" | "allow_session" | "allow_always" | "deny";

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
  credentials: string[]; // refs used, never values
  denied?: { credential: string; operation: string; rule: string | null }[]; // sent without the credential
  reason?: string; // why blocked
  via?: "proxy"; // through the company proxy (config.yaml `proxy`)
  internal?: boolean; // to an address on a company network (a persona's internal host)
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
  // What the user has to do first: install Podman, or create its machine (POST /api/runtime/setup).
  needs: "install" | "machine" | null;
}

export interface ProviderStatus {
  name: string;
  type: ProviderType;
  baseURL?: string;
  apiKeySecret?: string;
  ready: boolean; // key present (or not needed)
  detail?: string; // e.g. how to sign in when not ready
  keyRequired: boolean; // false for local servers that need no key
  keySource: "secrets" | "env" | "login" | null; // where the key comes from; null = not connected
  fingerprint: string | null; // first 8 hex of sha256(key), when it is in Swan's secrets
  keyUpdatedAt: string | null;
}

/** A model a provider offers (currently listed for Copilot only). */
export interface ProviderModel {
  id: string; // use as persona model.id
  name: string;
  enabled: boolean; // false when the user's plan or org policy has not enabled it
  policyState?: string;
  vision: boolean;
  reasoningEfforts: Effort[];
  maxPromptTokens?: number;
  maxOutputTokens?: number;
}

// ---------- REST endpoints ----------
// All requests need header `x-ph-token: <token>` (the token is in <meta name="ph-token">).
// Bodies are JSON. Errors come back as { error: string } with a 4xx/5xx status.
//
// GET    /api/runtime                         -> RuntimeStatus
// POST   /api/runtime/rebuild                 -> RuntimeStatus   (rebuild sandbox image)
// POST   /api/runtime/retry                   -> RuntimeStatus   (check Podman again and bring the sandbox up)
// POST   /api/runtime/setup                   -> RuntimeStatus   (create and start the Podman machine)
// GET    /api/secrets/status                  -> { error: string | null } (why secrets.yaml cannot be read)
// GET    /api/providers                       -> ProviderStatus[]
// GET    /api/providers/:name/models          -> ProviderModel[] (copilot providers)
// GET    /api/personas                        -> PersonaSummary[]
// POST   /api/personas            {id,yaml}   -> PersonaSummary
// GET    /api/personas/:id/source             -> PersonaSource
// PUT    /api/personas/:id/source {yaml}      -> PersonaSummary
// DELETE /api/personas/:id                    -> { ok: true }  (also its conversation, memory and attachments)
// GET    /api/personas/:id/tools              -> ToolSummary[]  (built-in + skill tools; MCP tools appear once a session runs)
// GET    /api/personas/:id/files?path=/workspace/x -> { path, entries: FileEntry[] } (path inside sandbox)
// GET    /api/personas/:id/file?path=...      -> { path, content, truncated }
// GET    /api/skills                          -> SkillSummary[]
// GET    /api/connections                     -> ConnectionStatus[]
// PUT    /api/connections/:conn/credentials/:name CredentialUpsert -> ConnectionStatus (static; creates the connection)
// DELETE /api/connections/:conn/credentials/:name -> ConnectionStatus | { ok: true } (static)
// POST   /api/connections/:conn/:action       (login|renew|cancel|logout) -> ConnectionStatus (command)
// GET    /api/connections/migration           -> MigrationNote | null
// DELETE /api/connections/migration           -> { ok: true } (dismiss the note)
// GET    /api/sessions?personaId=             -> SessionSummary[] (newest first)
// POST   /api/sessions            {personaId, title?} -> SessionSummary
// GET    /api/sessions/:id                    -> { session: SessionSummary, items: ChatItem[] }
// GET    /api/sessions/:id/tools              -> ToolSummary[]
// POST   /api/sessions/:id/messages {text}    -> { ok: true }
// POST   /api/sessions/:id/interrupt          -> { ok: true }
// POST   /api/sessions/:id/approvals/:toolUseId ApprovalBody -> { ok: true }
// POST   /api/sessions/:id/stop               -> SessionSummary (removes container, keeps transcript)
// POST   /api/sessions/:id/agents/:agentId/stop -> { ok: true } (one sub-agent; "all" stops every one)
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
  | { type: "connections.updated"; connections: ConnectionStatus[]; changed: string[] } // changed: credential refs
  | { type: "session.updated"; session: SessionSummary }
  | { type: "session.deleted"; sessionId: string }
  | { type: "session.snapshot"; session: SessionSummary; items: ChatItem[] } // reply to subscribe
  | { type: "item.added"; sessionId: string; item: ChatItem }
  | { type: "item.updated"; sessionId: string; item: ChatItem } // full replacement
  | { type: "item.delta"; sessionId: string; itemId: string; delta: string } // append to text
  | { type: "egress"; event: EgressEvent }
  | { type: "approvals.updated"; approvals: PendingApproval[] } // every waiting call, all personas
  | { type: "providers.updated"; providers: ProviderStatus[] } // a model-provider key changed
  | { type: "secrets.status"; error: string | null } // secrets.yaml / secrets.env cannot be read (null: fine again)
  | { type: "usage.updated"; personaId: string }
  | { type: "memory.updated"; personaId: string };

// ---------- Attachments ----------
// POST /api/sessions/:id/attachments {name, mediaType, data (base64)} -> AttachmentMeta  (max 20 MB)
// POST /api/sessions/:id/messages {text, attachments?: string[] (ids)}
// Images go to the model as images, PDFs as documents; every attachment is also copied into the
// sandbox at sandboxPath so tools can use it.

export interface AttachmentMeta {
  id: string;
  name: string;
  mediaType: string;
  size: number; // bytes
  kind: "image" | "pdf" | "file";
  sandboxPath: string; // e.g. /home/agent/attachments/report.pdf
}

// GET /api/personas/:id/attachments -> PersonaAttachment[] (newest first, every conversation of the persona)
// GET /api/sessions/:id/attachments/:attId/file?token=… -> the bytes (images and PDFs inline, anything else as a download)

export interface PersonaAttachment extends AttachmentMeta {
  sessionId: string;
  itemId: string; // the user message it was sent with
  ts: string;
}

// ---------- Swan additions ----------
// One ongoing conversation per persona. A conversation is a session the server picks or creates;
// the UI addresses it by persona and never lists sessions.
//
// GET    /api/personas/:id/conversation        -> { session: SessionSummary, items: ChatItem[] } (creates if absent)
// GET    /api/personas/:id/commands            -> SlashCommand[]
// GET    /api/personas/:id/config              -> PersonaConfigView
// PUT    /api/personas/:id/config  PersonaConfigView -> SaveResult (writes the YAML, keeps comments)
// PUT    /api/personas/:id/model   {provider, id, effort?} -> PersonaSummary (composer selectors; next turn)
// GET    /api/approvals                        -> PendingApproval[]
// DELETE /api/sessions/:id/allowances          -> SessionSummary (reset all)
// DELETE /api/sessions/:id/allowances/:rule    -> SessionSummary (rule URL-encoded)
// GET    /api/models                           -> ModelOption[] (every provider's selectable models)
// Messages starting with "/" are commands: /dream, /stop, /usage (UI only), /<skill> [text].
//
// Memory (persona-private):
// GET    /api/personas/:id/memory?query=&type=&status=  -> MemoryRecord[]
// POST   /api/personas/:id/memory     {content, type, pinned?}       -> MemoryRecord
// PUT    /api/personas/:id/memory/:recordId {content?, type?}        -> MemoryRecord (new version)
// POST   /api/personas/:id/memory/:recordId/:action  (pin|unpin|archive|forget) -> MemoryRecord
// GET    /api/personas/:id/memory-history  -> MemoryChange[] (newest first)
// GET    /api/personas/:id/checkpoint      -> Checkpoint | null (latest committed)
//
// Usage:
// GET    /api/usage?personaId=&period=today|all -> UsageReport
// GET    /api/providers/:name/allowance          -> ProviderAllowance

export interface SlashCommand {
  name: string; // without the slash
  description: string;
  source: "swan" | "skill";
}

export interface PendingApproval {
  sessionId: string;
  personaId: string;
  toolUseId: string;
  name: string;
  inputPreview: string;
  rule: string;
  since: string;
}

export interface ModelOption {
  provider: string;
  providerType: ProviderType;
  id: string;
  label: string;
  efforts: Effort[]; // empty when the model takes no effort setting
  preview?: boolean; // e.g. GitHub Copilot
  ready: boolean; // provider has credentials
}

export interface PersonaConfigView {
  name: string;
  description: string;
  instructions: string;
  folders: { path: string; mount?: string; mode: FolderMode }[];
  networkAllow: string[]; // hostnames, *.domain, or host:port (always tunnelled)
  networkInternal: string[]; // the same forms, on the company network (private addresses allowed)
  connections: Record<string, PersonaConnection>;
  permissions: { default: PermissionMode; allow: string[]; ask: string[]; deny: string[] };
  skills: string[];
  mcpServers: Record<string, unknown>; // raw YAML objects, edited as JSON
  memory: { autoBrief: boolean; briefTokens: number };
  subagents: SubagentsConfig;
}

export interface SubagentsConfig {
  agents: { name: string; model: string }[]; // model: "provider/id" or "auto"
  maxBackground: number;
  maxTurns: number;
}

export interface SaveResult {
  persona: PersonaSummary;
  appliedNow: string[]; // e.g. "permissions", "network allowlist"
  nextStart: string[]; // e.g. "folders" (next container start)
  notes?: string[]; // adjustments the server made, in plain words
}

export type MemoryType = "preference" | "decision" | "observation" | "procedure" | "episode";
export type MemoryOrigin = "user" | "observation" | "inference";
export type MemoryStatus = "active" | "tentative" | "archived" | "forgotten";

export interface MemoryRecord {
  id: string;
  version: number;
  type: MemoryType;
  content: string;
  origin: MemoryOrigin;
  status: MemoryStatus;
  pinned: boolean;
  sources: string[]; // chat item ids or "user"
  createdAt: string;
  updatedAt: string;
}

export interface MemoryChange {
  id: string;
  ts: string;
  recordId: string;
  action: "added" | "edited" | "pinned" | "unpinned" | "archived" | "forgotten" | "merged" | "dream";
  summary: string;
  by: "user" | "agent" | "dream";
  before?: string;
  after?: string;
}

export interface Checkpoint {
  epoch: number;
  createdAt: string;
  objective: string;
  constraints: string[];
  decisions: string[];
  completed: string[];
  failures: string[];
  openQuestions: string[];
  nextAction: string;
  sources: string[]; // chat item ids
}

export interface UsageTotals {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  costUsd: number | null; // null = cost unavailable for some requests
  credits: number | null; // Copilot AI credits, when reported
  requests: number;
}

export interface UsageReport {
  personaId: string;
  period: "today" | "all";
  total: UsageTotals;
  byPurpose: Record<string, UsageTotals>; // foreground, checkpoint, dream
  context: { usedTokens: number; limitTokens: number; estimated: boolean; epoch: number } | null;
  updatedAt: string;
}

export interface ProviderAllowance {
  provider: string;
  available: boolean;
  detail: string; // "Unavailable for this connection" when not reported
  usagePage?: string;
  observedAt: string;
}

// ---------- Launcher ----------
// When a launcher (the desktop app) starts the server with an IPC channel, the server reports
// over it and shuts down when the channel closes.

export type LauncherMessage =
  | { type: "ready"; url: string; port: number; proxyPort: number; home: string; version: string }
  | { type: "home-in-use"; home: string; url: string | null; pid: number | null }
  | { type: "fatal"; message: string };
