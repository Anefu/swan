import type { ApprovalBody, PendingApproval } from "@ph/shared";

/**
 * Decisions a conversation waits on: tool calls, questions, network and credential requests. Each
 * is listed for the UI and settled by the user's answer, a stop, or its timeout.
 */
export class Approvals {
  private pending = new Map<string, { info: PendingApproval; settle: (d: ApprovalBody | null) => void }>();

  constructor(private onChange: () => void) {}

  get size() {
    return this.pending.size;
  }

  list(): PendingApproval[] {
    return [...this.pending.values()].map((p) => p.info);
  }

  /** The user's decision, or null if the signal aborts or the time runs out first. */
  wait(id: string, info: PendingApproval, o: { signal?: AbortSignal; timeoutMs?: number } = {}): Promise<ApprovalBody | null> {
    return new Promise((resolve) => {
      if (o.signal?.aborted) return resolve(null);
      const settle = (d: ApprovalBody | null) => {
        clearTimeout(timer);
        o.signal?.removeEventListener("abort", onAbort);
        this.pending.delete(id);
        this.onChange();
        resolve(d);
      };
      const onAbort = () => settle(null);
      const timer = o.timeoutMs ? setTimeout(onAbort, o.timeoutMs) : undefined;
      o.signal?.addEventListener("abort", onAbort, { once: true });
      this.pending.set(id, { info, settle });
      this.onChange();
    });
  }

  decide(id: string, body: ApprovalBody) {
    const p = this.pending.get(id);
    if (!p) throw new Error("no pending approval for that tool call");
    p.settle(body);
  }

  /** The id of the first pending decision that matches. */
  find(match: (info: PendingApproval) => boolean): string | undefined {
    for (const [id, p] of this.pending) if (match(p.info)) return id;
    return undefined;
  }

  denyWhere(match: (info: PendingApproval) => boolean, reason: string) {
    for (const p of [...this.pending.values()]) if (match(p.info)) p.settle({ decision: "deny", reason });
  }
}
