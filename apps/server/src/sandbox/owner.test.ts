import { describe, expect, it } from "vitest";
import { orphanSessions, parseInspect, parsePs, planRelay, relayTakenMessage, type ListedContainer } from "./owner.js";

const HOME = "/Users/me/.swan";
const OTHER = "/private/tmp/swan-test";
const RELAY = "localhost/persona-harness-sandbox:ca-014e|4318";

const relay = (running: boolean, labels: Record<string, string>) => ({ running, labels });

describe("parseInspect", () => {
  it("reads state and labels from podman container inspect", () => {
    const out = JSON.stringify([{ State: { Running: true }, Config: { Labels: { "ph.relay": RELAY, "ph.home": HOME } } }]);
    expect(parseInspect(out)).toEqual(relay(true, { "ph.relay": RELAY, "ph.home": HOME }));
  });

  it("treats missing labels as none", () => {
    expect(parseInspect(JSON.stringify([{ State: { Running: false }, Config: { Labels: null } }]))).toEqual(relay(false, {}));
  });

  it("rejects output it cannot read, so nothing is removed on a guess", () => {
    expect(() => parseInspect("Error: no such container")).toThrow(/not JSON/);
    expect(() => parseInspect("[]")).toThrow(/unexpected output/);
    expect(() => parseInspect(JSON.stringify([{ State: {}, Config: {} }]))).toThrow(/0\.State\.Running/);
  });
});

describe("parsePs", () => {
  it("reads names, labels and networks from podman ps --format json", () => {
    const out = JSON.stringify([
      { Names: ["ph-a"], Labels: { "ph.session": "a", "ph.home": HOME }, Networks: ["ph-internal"], State: "running" },
      { Names: ["ph-b"], Labels: null },
    ]);
    expect(parsePs(out)).toEqual([
      { name: "ph-a", labels: { "ph.session": "a", "ph.home": HOME }, networks: ["ph-internal"] },
      { name: "ph-b", labels: {}, networks: [] },
    ]);
  });

  it("reads an empty list either way Podman prints it", () => {
    expect(parsePs("[]")).toEqual([]);
    expect(parsePs("null")).toEqual([]);
  });
});

describe("planRelay", () => {
  const want = { home: HOME, relay: RELAY };

  it("creates a relay when none exists", () => {
    expect(planRelay(null, want)).toEqual({ action: "create" });
  });

  it("keeps this home's running relay when it is current", () => {
    expect(planRelay(relay(true, { "ph.relay": RELAY, "ph.home": HOME }), want)).toEqual({ action: "keep" });
  });

  it("replaces this home's relay when it is stopped, stale or a rebuild asks", () => {
    expect(planRelay(relay(false, { "ph.relay": RELAY, "ph.home": HOME }), want)).toEqual({ action: "replace" });
    expect(planRelay(relay(true, { "ph.relay": "localhost/persona-harness-sandbox:ca-014e|4999", "ph.home": HOME }), want)).toEqual({ action: "replace" });
    expect(planRelay(relay(true, { "ph.relay": RELAY, "ph.home": HOME }), { ...want, force: true })).toEqual({ action: "replace" });
  });

  it("replaces a relay without a home label (older versions), which labels it", () => {
    expect(planRelay(relay(true, { "ph.relay": RELAY }), want)).toEqual({ action: "replace" });
    expect(planRelay(relay(true, {}), want)).toEqual({ action: "replace" });
  });

  it("refuses another home's relay, running or not, even on a rebuild", () => {
    const theirs = { "ph.relay": "localhost/persona-harness-sandbox:ca-9f00|4518", "ph.home": OTHER };
    expect(planRelay(relay(true, theirs), want)).toEqual({ action: "refuse", owner: OTHER });
    expect(planRelay(relay(false, theirs), want)).toEqual({ action: "refuse", owner: OTHER });
    expect(planRelay(relay(true, { ...theirs, "ph.relay": RELAY }), { ...want, force: true })).toEqual({ action: "refuse", owner: OTHER });
  });
});

describe("relayTakenMessage", () => {
  it("names the other home and the settings to change in this one", () => {
    const msg = relayTakenMessage("ph-relay", OTHER, `${HOME}/config.yaml`);
    expect(msg).toContain(`Swan for ${OTHER}`);
    expect(msg).toContain(`${HOME}/config.yaml`);
    for (const key of ["runtime.network", "runtime.subnet", "runtime.relayIp", "runtime.relayName"]) expect(msg).toContain(key);
  });
});

describe("orphanSessions", () => {
  const c = (name: string, labels: Record<string, string>, networks = ["ph-internal"]): ListedContainer => ({ name, labels, networks });
  const opts = { home: HOME, network: "ph-internal", keep: new Set<string>() };

  it("removes this home's session containers on any network", () => {
    expect(orphanSessions([c("ph-a", { "ph.session": "a", "ph.home": HOME }), c("ph-b", { "ph.session": "b", "ph.home": HOME }, ["old-net"])], opts)).toEqual(["ph-a", "ph-b"]);
  });

  it("leaves another home's session containers, even on the same network", () => {
    expect(orphanSessions([c("ph-x", { "ph.session": "x", "ph.home": OTHER })], opts)).toEqual([]);
  });

  it("removes unlabelled session containers (older versions) only on this network", () => {
    expect(orphanSessions([c("ph-old", { "ph.session": "old" }), c("ph-far", { "ph.session": "far" }, ["swan-test"])], opts)).toEqual(["ph-old"]);
  });

  it("leaves containers it was told to keep and ones that are not sessions", () => {
    const list = [c("ph-a", { "ph.session": "a", "ph.home": HOME }), c("ph-relay", { "ph.relay": RELAY, "ph.home": HOME })];
    expect(orphanSessions(list, { ...opts, keep: new Set(["ph-a"]) })).toEqual([]);
  });
});
