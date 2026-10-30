import type { PendingApproval, PersonaSummary, SessionSummary } from "@ph/shared";
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
  if (p.missingCredentials.length > 0) return { text: `Missing ${p.missingCredentials[0]}`, tone: "attention" };
  return null;
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

/** Model-provider keys belong to Model providers, never to Credentials or a persona. */
export function providerKeyNames(providers: Array<{ type: string; apiKeySecret?: string }>): Set<string> {
  const keys = new Set<string>();
  for (const p of providers) {
    if (p.apiKeySecret) keys.add(p.apiKeySecret);
    if (p.type === "copilot") keys.add("COPILOT_GITHUB_TOKEN");
  }
  return keys;
}
