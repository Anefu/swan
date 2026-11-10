import type { ChatItem, ToolCallStatus } from "@ph/shared";
import type { PersonaStore } from "../personas.js";
import { errMsg, nowIso, randomId } from "../util.js";
import type { Approvals } from "./approvals.js";

const DECIDE_MS = 10 * 60_000;

export interface NetworkHost {
  id: string;
  personaId: string;
  personas: PersonaStore;
  approvals: Approvals;
  addItem(it: ChatItem): void;
  syncItem(it: ChatItem): void;
  notice(level: "info" | "warn" | "error", text: string): void;
  allowances(): string[];
  setAllowances(a: string[]): void;
  /** The sandbox's requests can't be told apart by who made them, so this covers every agent at work. */
  unattended(): boolean;
  /** The latest tool call, to explain what made the request. */
  lastActivity(): { preview: string; reason?: string } | null;
}

/** What the sandbox's traffic asks of the user: new hosts, and requests the proxy refused. */
export class NetworkRequests {
  private pending = new Map<string, Promise<boolean>>(); // host -> decision in flight
  private denied = new Set<string>(); // until stopped
  private foreignNoticed = new Set<string>(); // hosts already named in a notice this run

  constructor(private host: NetworkHost) {}

  /**
   * A public host not on the allowlist waits on an approval in the conversation: allow (until
   * stopped), always (adds the host to the persona) or deny (remembered until stopped, so a
   * retrying tool does not ask again).
   */
  request(hostname: string, port: number): Promise<boolean> {
    if (this.denied.has(hostname)) return Promise.resolve(false);
    if (this.host.unattended()) {
      this.denied.add(hostname);
      this.host.notice("warn", `Blocked ${hostname}: it isn't in this persona's allowed hosts, and new hosts are never allowed in an unattended run.`);
      return Promise.resolve(false);
    }
    const inflight = this.pending.get(hostname);
    if (inflight) return inflight;
    const p = this.ask(hostname, port).finally(() => this.pending.delete(hostname));
    this.pending.set(hostname, p);
    return p;
  }

  private async ask(hostname: string, port: number): Promise<boolean> {
    const h = this.host;
    const id = randomId("net_", 8);
    const target = port === 443 || port === 80 ? hostname : `${hostname}:${port}`;
    const last = h.lastActivity();
    const item: Extract<ChatItem, { kind: "tool_call" }> = {
      kind: "tool_call",
      id,
      ts: nowIso(),
      name: "network_access",
      source: "builtin",
      input: { host: hostname, port },
      inputPreview: target,
      status: "pending_approval",
      approvalReason: "not in this persona's allowed hosts",
      ...(last ? { reason: `While running ${last.preview.slice(0, 120)}${last.reason ? `: ${last.reason}` : ""}` } : {}),
    };
    h.addItem(item);
    const done = (ok: boolean, status: ToolCallStatus, output: string) => {
      Object.assign(item, { status, output, approvalReason: undefined });
      h.syncItem(item);
      return ok;
    };
    const d = await h.approvals.wait(id, { sessionId: h.id, personaId: h.personaId, toolUseId: id, name: "network_access", inputPreview: target, rule: "network: ask", since: item.ts }, { timeoutMs: DECIDE_MS });
    if (!d) return done(false, "interrupted", "No decision within 10 minutes; the request was blocked.");
    if (d.decision === "deny") {
      this.denied.add(hostname);
      return done(false, "denied", `Blocked ${target}${d.reason?.trim() ? `: ${d.reason.trim()}` : ""}. Other requests to it are blocked until the agent is stopped.`);
    }
    if (!h.allowances().includes(`net:${hostname}`)) h.setAllowances([...h.allowances(), `net:${hostname}`]);
    if (d.decision !== "allow_always") return done(true, "done", `Allowed ${target} until the agent is stopped.`);
    void h.personas.addNetworkHost(h.personaId, hostname).catch((e) => h.notice("error", `Could not save ${hostname} to the persona: ${errMsg(e)}`));
    return done(true, "done", `Allowed ${target} and added it to this persona's allowed hosts.`);
  }

  /** The proxy refused a request that carried a credential not from Swan: say so once per host per run. */
  foreignCredential(hostname: string, field: string) {
    if (this.foreignNoticed.has(hostname)) return;
    this.foreignNoticed.add(hostname);
    this.host.notice(
      "warn",
      `Blocked a request to ${hostname} that used a credential not from Swan (${field}). Swan sends only this persona's credentials there. If you didn't expect the agent to use other credentials, check what it read recently.`,
    );
  }

  /** Stop: decisions "until stopped" end here. */
  reset() {
    this.denied.clear();
    this.foreignNoticed.clear();
  }
}
