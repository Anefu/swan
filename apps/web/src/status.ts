import type { ConnectionState, PendingApproval, PersonaSummary, RuleApi, SessionSummary } from "@ph/shared";
import { conversationSession, modelLabel, type State } from "./store";
import { EFFORT_LABEL } from "./util";

export type Tone = "attention" | "muted" | "error" | "ok";

export function plural(n: number, one: string, many = `${one}s`): string {
  return `${n} ${n === 1 ? one : many}`;
}

/** Text status for the persona dropdown. Status is always words, never colour alone. */
export function personaStatus(
  state: State,
  p: PersonaSummary,
  approvals: PendingApproval[],
): { text: string; tone: Tone } | null {
  const waiting = approvals.filter((a) => a.personaId === p.id).length;
  if (waiting > 0) return { text: plural(waiting, "decision"), tone: "attention" };
  if (p.errors.length > 0) return { text: "Configuration error", tone: "error" };
  const s = conversationSession(state, p.id);
  if (s?.status === "running") return { text: "Working", tone: "muted" };
  if (s?.status === "starting") return { text: "Starting", tone: "muted" };
  if (s?.status === "error") return { text: "Error", tone: "error" };
  const { missing, signIn } = unreadyCredentials(state, p);
  if (missing.length > 0) return { text: `Missing ${missing[0]}`, tone: "attention" };
  if (signIn.length > 0) return { text: `${signIn[0]} needs sign-in`, tone: "attention" };
  return null;
}

/**
 * Split a persona's unusable credential refs: static ones with no value, and command connections
 * waiting for a sign-in. Command connections not checked yet are left out; a session start checks them.
 */
export function unreadyCredentials(state: State, p: PersonaSummary): { missing: string[]; signIn: string[] } {
  const missing: string[] = [];
  const signIn = new Set<string>();
  for (const ref of p.missingCredentials) {
    const conn = ref.slice(0, ref.indexOf("/"));
    const c = state.connections.find((x) => x.name === conn);
    if (c?.type !== "command") missing.push(ref);
    else if (c.state === "login_required") signIn.add(conn);
  }
  return { missing, signIn: [...signIn] };
}

export const CONNECTION_STATE: Record<ConnectionState, { label: string; tone: Tone }> = {
  ready: { label: "Ready", tone: "ok" },
  login_required: { label: "Needs sign-in", tone: "attention" },
  signing_in: { label: "Signing in", tone: "muted" },
  incomplete: { label: "Incomplete", tone: "attention" },
  error: { label: "Error", tone: "error" },
  unknown: { label: "Not checked", tone: "muted" },
};

export const RULE_APIS: RuleApi[] = ["kubernetes", "aws", "http"];
export const RULE_API_LABEL: Record<RuleApi, string> = { kubernetes: "Kubernetes", aws: "AWS", http: "HTTP" };

/** Same values as the server's rule presets (apps/server/src/connections/rules.ts). */
export const RULE_PRESETS: Record<RuleApi, Record<string, { allow: string[]; ask: string[]; deny: string[] }>> = {
  kubernetes: {
    "Read-only": { allow: ["get *", "list *", "watch *"], ask: [], deny: ["* secrets"] },
    "Read + exec": { allow: ["get *", "list *", "watch *"], ask: ["create pods/exec", "create pods/portforward"], deny: ["* secrets"] },
    "Full access": { allow: ["* *"], ask: [], deny: [] },
  },
  aws: {
    "Read-only": { allow: ["*:Get*", "*:List*", "*:Describe*", "sts:GetCallerIdentity", "logs:FilterLogEvents"], ask: [], deny: ["iam:*"] },
    "Full access": { allow: ["*"], ask: [], deny: [] },
  },
  http: {
    "Read-only": { allow: ["GET /**", "HEAD /**"], ask: [], deny: [] },
    "Read + ask to write": { allow: ["GET /**", "HEAD /**"], ask: ["* /**"], deny: [] },
    "Full access": { allow: ["* /**"], ask: [], deny: [] },
  },
};

const CRED_ALLOWANCE = "cred:";

export function isCredentialAllowance(rule: string): boolean {
  return rule.startsWith(CRED_ALLOWANCE);
}

/** "cred:stub/eks kubernetes:patch deployments in payments" -> "stub/eks: patch deployments in payments". */
export function allowanceLabel(rule: string): string {
  if (rule.startsWith("net:")) return rule.slice(4);
  if (!isCredentialAllowance(rule)) return rule;
  const rest = rule.slice(CRED_ALLOWANCE.length);
  const sp = rest.indexOf(" ");
  if (sp < 0) return rest;
  const key = rest.slice(sp + 1);
  const colon = key.indexOf(":");
  const api = key.slice(0, colon);
  const pattern = colon > 0 && (RULE_APIS as string[]).includes(api) ? key.slice(colon + 1) : key;
  return `${rest.slice(0, sp)}: ${pattern}`;
}

export function personaModelLine(state: State, p: PersonaSummary): string {
  const m = state.models?.find((x) => x.provider === p.model.provider && x.id === p.model.id);
  const label = modelLabel(state, p.model);
  const parts = [label];
  if (m?.preview) parts.push("Preview");
  if (p.model.effort) parts.push(EFFORT_LABEL[p.model.effort].toLowerCase());
  return parts.join(" · ");
}

export function sessionStatusLine(s: SessionSummary | null): { text: string; tone: Tone } | null {
  if (!s) return null;
  switch (s.status) {
    case "starting":
      return { text: s.statusDetail ? `Starting: ${s.statusDetail}` : "Starting the sandbox…", tone: "muted" };
    case "running":
      return { text: "Working", tone: "muted" };
    case "awaiting_approval":
      return { text: "Waiting for your decision", tone: "attention" };
    case "error":
      return { text: s.statusDetail ? `Error: ${s.statusDetail}` : "Error", tone: "error" };
    case "stopped":
      return { text: "Stopped. Sending a message starts the agent again.", tone: "muted" };
    case "idle":
      return null;
  }
}

export function isWorking(s: SessionSummary | null): boolean {
  return !!s && (s.status === "running" || s.status === "awaiting_approval" || s.status === "starting");
}
