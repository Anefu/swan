// Values worked out from the state.
import type { PendingApproval, SessionSummary } from "@ph/shared";
import type { State } from "./state";

export function conversationSession(state: State, personaId: string | null): SessionSummary | null {
  if (!personaId) return null;
  const sid = state.conversations[personaId];
  if (sid && state.sessions[sid]) return state.sessions[sid];
  // Before the conversation loads, use the newest known session for status hints.
  let best: SessionSummary | null = null;
  for (const s of Object.values(state.sessions)) {
    if (s.personaId === personaId && (!best || s.updatedAt > best.updatedAt)) best = s;
  }
  return best;
}

/** Every waiting tool call, oldest first. Derived from loaded transcripts when the server has no approvals feed. */
export function pendingApprovals(state: State): PendingApproval[] {
  if (state.approvals) return [...state.approvals].sort((a, b) => (a.since < b.since ? -1 : a.since > b.since ? 1 : 0));
  const out: PendingApproval[] = [];
  for (const [sessionId, t] of Object.entries(state.transcripts)) {
    const personaId = state.sessions[sessionId]?.personaId ?? "";
    for (const it of t.items) {
      if (it.kind === "tool_call" && it.status === "pending_approval") {
        out.push({
          sessionId,
          personaId,
          toolUseId: it.id,
          name: it.name,
          inputPreview: it.inputPreview,
          rule: it.approvalReason ?? "",
          since: it.ts,
        });
      }
    }
  }
  return out.sort((a, b) => (a.since < b.since ? -1 : a.since > b.since ? 1 : 0));
}

export function modelLabel(state: State, model: { provider: string; id: string }): string {
  const m = state.models?.find((x) => x.provider === model.provider && x.id === model.id);
  return m?.label ?? model.id;
}
