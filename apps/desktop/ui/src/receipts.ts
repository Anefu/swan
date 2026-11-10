import type { AgentRun, ChatItem, PersonaSummary } from "@ph/shared";
import { basename, exitCode, isRecord, toolDisplayName } from "./util";

export type ToolItem = Extract<ChatItem, { kind: "tool_call" }>;

export function str(input: unknown, keys: string[]): string | null {
  if (!isRecord(input)) return null;
  for (const k of keys) if (typeof input[k] === "string") return input[k] as string;
  return null;
}

function num(input: unknown, key: string): number | null {
  if (!isRecord(input)) return null;
  const v = input[key];
  return typeof v === "number" ? v : null;
}

function lineCount(s: string): number {
  if (!s) return 0;
  return s.replace(/\n$/, "").split("\n").length;
}

function firstLine(s: string, max = 80): string {
  const line = s.split("\n")[0].trim();
  return line.length > max ? `${line.slice(0, max - 1)}…` : line;
}

const PATH_KEYS = ["path", "file_path", "filePath", "file"];

export interface ReceiptText {
  verb: string;
  /** Rendered in mono. */
  target: string;
  /** Short result summary after a separator, e.g. "3 matches" or "exit 1". */
  result: string | null;
  /** The target is words (an agent's description, a question), not code. */
  prose?: boolean;
}

/**
 * Spec verb mapping: Searched / Read / Ran / Wrote / Edited / Called.
 * `agents` maps sub-agent ids to their descriptions, for the calls that name an agent by id.
 */
export function describeTool(item: ToolItem, agents?: ReadonlyMap<string, string>): ReceiptText {
  const { server, tool } = toolDisplayName(item.name);
  const done = item.status === "done" || item.status === "error";
  const out = item.output ?? "";
  if (server) {
    const arg = str(item.input, Object.keys(isRecord(item.input) ? item.input : {}));
    return { verb: "Called", target: `${server} › ${tool}${arg ? ` ${firstLine(arg, 50)}` : ""}`, result: null };
  }
  switch (tool) {
    case "agent":
      return {
        verb: "Agent",
        target: str(item.input, ["description"]) ?? item.inputPreview ?? "",
        result: null,
        prose: true,
      };
    case "agent_message": {
      const id = str(item.input, ["id"]) ?? "";
      const message = str(item.input, ["message"]);
      return {
        verb: "Replied to",
        target: agents?.get(id) ?? id,
        result: message ? `“${firstLine(message, 80)}”` : null,
        prose: true,
      };
    }
    case "agent_stop": {
      const id = str(item.input, ["id"]) ?? "";
      return { verb: "Stopped", target: agents?.get(id) ?? id, result: null, prose: true };
    }
    case "agent_status":
      return { verb: "Checked agents", target: "", result: null };
    case "ask_parent":
      return { verb: "Asked the parent", target: str(item.input, ["question"]) ?? item.inputPreview, result: null, prose: true };
    case "ask_user":
      return { verb: "Asked", target: str(item.input, ["question"]) ?? item.inputPreview, result: item.answer ?? null, prose: true };
    case "network_access":
      return { verb: "Network", target: item.inputPreview || (str(item.input, ["host"]) ?? ""), result: null };
    case "credential_use": {
      const op = str(item.input, ["operation"]);
      const cred = str(item.input, ["credential"]);
      return { verb: "Credential", target: op && cred ? `${op} with ${cred}` : item.inputPreview, result: null };
    }
    case "grep":
    case "glob": {
      const pattern = str(item.input, ["pattern"]) ?? item.inputPreview;
      let result: string | null = null;
      if (done && !item.isError) {
        const n = out.trim() ? lineCount(out.trim()) : 0;
        result = n === 0 ? "no matches" : `${n} ${tool === "glob" ? (n === 1 ? "file" : "files") : n === 1 ? "match" : "matches"}`;
      }
      return { verb: "Searched", target: pattern, result };
    }
    case "read_file": {
      const p = str(item.input, PATH_KEYS) ?? item.inputPreview;
      const off = num(item.input, "offset");
      const lim = num(item.input, "limit");
      const range = off !== null || lim !== null ? `:${off ?? 1}–${(off ?? 1) + (lim ?? 2000) - 1}` : "";
      return { verb: "Read", target: `${shortPath(p)}${range}`, result: null };
    }
    case "list_dir": {
      const p = str(item.input, PATH_KEYS) ?? ".";
      return { verb: "Read", target: shortPath(p), result: null };
    }
    case "bash": {
      const cmd = str(item.input, ["command", "cmd"]) ?? item.inputPreview;
      let result: string | null = null;
      if (done) {
        const parts: string[] = [];
        const failed = /(\d+)\s+failed/i.exec(out);
        const passed = /(\d+)\s+passed/i.exec(out);
        if (failed) parts.push(`${failed[1]} failed`);
        if (passed) parts.push(`${passed[1]} passed`);
        const code = exitCode(out);
        if (code !== null) parts.push(`exit ${code}`);
        result = parts.length ? parts.join(", ") : null;
      }
      return { verb: "Ran", target: firstLine(cmd, 90), result };
    }
    case "write_file": {
      const p = str(item.input, PATH_KEYS) ?? item.inputPreview;
      const c = str(item.input, ["content"]) ?? "";
      const n = lineCount(c);
      return { verb: "Wrote", target: basename(p), result: c ? `+${n}` : null };
    }
    case "edit_file": {
      const p = str(item.input, PATH_KEYS) ?? item.inputPreview;
      const n = str(item.input, ["new_string"]) ?? "";
      const o = str(item.input, ["old_string"]) ?? "";
      return { verb: "Edited", target: basename(p), result: editCounts(o, n) };
    }
    case "show_diff":
      return { verb: "Showed diff", target: str(item.input, ["title"]) ?? item.inputPreview, result: item.inputPreview.split(" · ")[1] ?? null };
    case "load_skill":
      return { verb: "Loaded skill", target: str(item.input, ["name"]) ?? item.inputPreview, result: null };
    case "memory_search":
    case "history_search":
      return { verb: "Searched", target: `${tool === "memory_search" ? "memory" : "history"} for ${str(item.input, ["query"]) ?? item.inputPreview}`, result: null };
    case "memory_read":
    case "history_read":
      return { verb: "Read", target: `${tool === "memory_read" ? "memory" : "history"} ${item.inputPreview}`, result: null };
    case "memory_propose":
      return { verb: "Proposed memory", target: firstLine(str(item.input, ["content"]) ?? item.inputPreview, 70), result: null };
    case "memory_update":
      return { verb: "Updated memory", target: firstLine(str(item.input, ["content"]) ?? item.inputPreview, 70), result: null };
    case "memory_archive":
      return { verb: "Archived memory", target: firstLine(str(item.input, ["reason"]) ?? item.inputPreview, 70), result: null };
    default:
      return { verb: "Used", target: `${tool}${item.inputPreview ? ` ${firstLine(item.inputPreview, 70)}` : ""}`, result: null };
  }
}

function shortPath(p: string): string {
  // /workspace/api/src/x.ts -> src/x.ts is ambiguous across mounts; keep the mount name.
  return p.replace(/^\/workspace\//, "");
}

/** Tools that steer sub-agents; their lines carry no duration. */
export const AGENT_CONTROL_TOOLS = new Set(["agent_message", "agent_stop", "agent_status", "ask_parent"]);

const CALL_ENDED = new Set<ToolItem["status"]>(["error", "interrupted", "denied"]);

/**
 * The sub-agent's state as the UI should show it. A call that failed or was interrupted wins over a
 * stale "running" or "asking" (e.g. after a restart). Null for an `agent` call without a run yet.
 */
export function agentState(item: ToolItem): AgentRun["state"] | null {
  const a = item.agent;
  if (!a) return null;
  if ((a.state === "running" || a.state === "asking") && CALL_ENDED.has(item.status)) return "stopped";
  return a.state;
}

/**
 * True while an `agent` call's sub-agent works or waits for an answer. A background agent keeps
 * its call running after the parent moves on; a foreground one that asked may have returned already.
 */
export function agentLive(item: ToolItem): boolean {
  const s = agentState(item);
  if (s === null) return item.status === "running" || item.status === "pending_approval";
  return s === "running" || s === "asking";
}

export const TOOL_STATUS_TEXT: Record<ToolItem["status"], string | null> = {
  pending_approval: "Decision needed",
  running: "Running",
  done: null,
  error: "Failed",
  denied: "Denied",
  interrupted: "Interrupted",
};

/** Label for "Allow … until stopped": the exact command for bash, the tool name for anything else. */
export function allowScopeLabel(item: { name: string }): string {
  return item.name === "bash" ? "Allow this command until stopped" : `Allow ${item.name} until stopped`;
}

/** Concise consequence sentence for the approval card. */
export function consequence(item: ToolItem, persona: PersonaSummary | null): string {
  const { server, tool } = toolDisplayName(item.name);
  if (server) {
    const mcp = persona?.mcpServers.find((m) => m.name === server);
    return mcp?.kind === "http"
      ? `Calls ${server} from the host (${mcp.target})`
      : `Calls ${server} inside the sandbox`;
  }
  const path = str(item.input, PATH_KEYS);
  const folder = path ? mountFor(path, persona) : null;
  switch (tool) {
    case "edit_file":
    case "write_file":
      return folder ? `Writes to ${basename(folder.hostPath)}` : path ? `Writes ${path}` : "Writes a file in the sandbox";
    case "bash":
      return "Runs a shell command in the sandbox";
    case "read_file":
    case "list_dir":
    case "grep":
    case "glob":
      return folder ? `Reads ${basename(folder.hostPath)}` : "Reads files in the sandbox";
    default:
      return `Runs ${item.name}`;
  }
}

export function mountFor(path: string, persona: PersonaSummary | null) {
  if (!persona) return null;
  let best: PersonaSummary["folders"][number] | null = null;
  for (const f of persona.folders) {
    if ((path === f.mountPath || path.startsWith(`${f.mountPath}/`)) && (!best || f.mountPath.length > best.mountPath.length)) best = f;
  }
  return best;
}

const NOUNS: Record<string, [string, string, string]> = {
  // verb -> [summary verb, singular, plural]
  Read: ["read", "file", "files"],
  Searched: ["ran", "search", "searches"],
  Ran: ["ran", "command", "commands"],
  Wrote: ["wrote", "file", "files"],
  Edited: ["edited", "file", "files"],
  Called: ["called", "tool", "tools"],
  "Loaded skill": ["loaded", "skill", "skills"],
  Network: ["requested access to", "host", "hosts"],
  Credential: ["asked to use", "credential", "credentials"],
  Agent: ["ran", "agent", "agents"],
  "Replied to": ["replied to", "agent", "agents"],
  Stopped: ["stopped", "agent", "agents"],
  "Checked agents": ["checked", "agent status", "agent statuses"],
};

/** "Read 3 files, ran 2 commands" for a run of consecutive tool calls. */
export function summarizeTools(items: ToolItem[]): string {
  const counts = new Map<string, number>();
  for (const it of items) {
    const v = describeTool(it).verb;
    const key = NOUNS[v] ? v : "other";
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  const parts: string[] = [];
  for (const [v, n] of counts) {
    if (v === "other") parts.push(`used ${n} ${n === 1 ? "tool" : "tools"}`);
    else {
      const [verb, one, many] = NOUNS[v];
      parts.push(`${verb} ${n} ${n === 1 ? one : many}`);
    }
  }
  const s = parts.join(", ");
  return s.charAt(0).toUpperCase() + s.slice(1);
}

/** "+5 −2" for a replacement, not counting the lines it left alone at either end. */
function editCounts(oldText: string, newText: string): string | null {
  const a = oldText.split("\n");
  const b = newText.split("\n");
  let s = 0;
  while (s < a.length && s < b.length && a[s] === b[s]) s++;
  let e = 0;
  while (e < a.length - s && e < b.length - s && a[a.length - 1 - e] === b[b.length - 1 - e]) e++;
  const added = b.length - s - e;
  const removed = a.length - s - e;
  return [added && `+${added}`, removed && `−${removed}`].filter(Boolean).join(" ") || null;
}
