import type { ChatItem, EgressEvent, SessionSummary } from "@ph/shared";
import { describe, expect, it } from "vitest";
import { reducer } from "./reducer";
import type { State } from "./state";

const base = () => ({ sessions: {}, transcripts: {}, conversations: {}, egress: [] }) as unknown as State;
const text = (id: string, t: string, streaming = false): ChatItem => ({ kind: "assistant_text", id, ts: "2026-11-10T00:00:00.000Z", text: t, streaming });
const withTranscript = (items: ChatItem[], source: "ws" | "rest" = "ws") => reducer(base(), { type: "transcript.set", sessionId: "s1", items, source });
const items = (s: State) => s.transcripts.s1!.items;

describe("the state reducer", () => {
  it("adds an item, and replaces one that has its id", () => {
    let s = withTranscript([text("a", "one")]);
    s = reducer(s, { type: "item.put", sessionId: "s1", item: text("b", "two") });
    s = reducer(s, { type: "item.put", sessionId: "s1", item: text("a", "one, edited") });
    expect(items(s).map((i) => (i as { text: string }).text)).toEqual(["one, edited", "two"]);
    expect(reducer(s, { type: "item.put", sessionId: "nope", item: text("c", "x") })).toBe(s);
  });

  it("appends streamed text to its item, in order, and leaves other conversations alone", () => {
    let s = withTranscript([text("a", "Hel", true)]);
    s = reducer(s, { type: "item.deltas", deltas: [{ sessionId: "s1", itemId: "a", delta: "lo" }, { sessionId: "s1", itemId: "a", delta: "!" }, { sessionId: "s2", itemId: "a", delta: "?" }] });
    expect((items(s)[0] as { text: string }).text).toBe("Hello!");
    const same = reducer(s, { type: "item.deltas", deltas: [{ sessionId: "s1", itemId: "missing", delta: "x" }] });
    expect(same.transcripts).toBe(s.transcripts);
  });

  it("doesn't let a slower fetch overwrite what the live socket sent", () => {
    const s = withTranscript([text("a", "live")], "ws");
    expect(reducer(s, { type: "transcript.set", sessionId: "s1", items: [], source: "rest" })).toBe(s);
    const stale = reducer(s, { type: "transcripts.stale" });
    expect(items(reducer(stale, { type: "transcript.set", sessionId: "s1", items: [], source: "rest" }))).toEqual([]);
  });

  it("drops a removed conversation everywhere it appears", () => {
    let s = reducer(base(), { type: "session.upsert", session: { id: "s1", personaId: "p" } as SessionSummary });
    s = reducer(s, { type: "transcript.set", sessionId: "s1", items: [], source: "ws" });
    s = { ...s, conversations: { p: "s1" } };
    s = reducer(s, { type: "session.remove", id: "s1" });
    expect([s.sessions, s.transcripts, s.conversations]).toEqual([{}, {}, {}]);
  });

  it("keeps network events in time order without duplicates", () => {
    const ev = (id: string, ts: string) => ({ id, ts }) as EgressEvent;
    let s = reducer(base(), { type: "egress.add", event: ev("e1", "2026-11-10T00:00:01Z") });
    s = reducer(s, { type: "egress.add", event: ev("e2", "2026-11-10T00:00:02Z") });
    s = reducer(s, { type: "egress.merge", events: [ev("e0", "2026-11-10T00:00:00Z"), ev("e2", "2026-11-10T00:00:02Z")] });
    expect(s.egress.map((e) => e.id)).toEqual(["e0", "e1", "e2"]);
  });
});
