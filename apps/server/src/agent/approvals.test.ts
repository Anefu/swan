import { describe, expect, it, vi } from "vitest";
import { Approvals } from "./approvals.js";

const info = (id: string, name = "bash") => ({ sessionId: "s", personaId: "p", toolUseId: id, name, inputPreview: "", rule: "ask", since: "" });

describe("Approvals", () => {
  it("lists a decision while it waits, and settles it with the user's answer", async () => {
    const changed = vi.fn();
    const a = new Approvals(changed);
    const d = a.wait("t1", info("t1"));
    expect(a.list().map((i) => i.toolUseId)).toEqual(["t1"]);
    a.decide("t1", { decision: "allow" });
    expect(await d).toEqual({ decision: "allow" });
    expect(a.size).toBe(0);
    expect(changed).toHaveBeenCalledTimes(2);
    expect(() => a.decide("t1", { decision: "allow" })).toThrow();
  });

  it("gives null on a stop or a timeout", async () => {
    vi.useFakeTimers();
    const a = new Approvals(() => {});
    const ac = new AbortController();
    const stopped = a.wait("t1", info("t1"), { signal: ac.signal });
    const late = a.wait("t2", info("t2"), { timeoutMs: 1000 });
    ac.abort();
    vi.advanceTimersByTime(1000);
    expect(await stopped).toBeNull();
    expect(await late).toBeNull();
    expect(a.size).toBe(0);
    vi.useRealTimers();
  });

  it("refuses the decisions that match", async () => {
    const a = new Approvals(() => {});
    const net = a.wait("n1", info("n1", "network_access"));
    void a.wait("t1", info("t1"));
    expect(a.find((i) => i.name === "network_access")).toBe("n1");
    a.denyWhere((i) => i.name === "network_access", "stopped");
    expect(await net).toEqual({ decision: "deny", reason: "stopped" });
    expect(a.list().map((i) => i.toolUseId)).toEqual(["t1"]);
  });
});
