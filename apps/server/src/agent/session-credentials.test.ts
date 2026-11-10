import type { ApprovalBody, ChatItem } from "@ph/shared";
import { describe, expect, it } from "vitest";
import type { ConnectionManager, ResolvedCredential } from "../connections/manager.js";
import type { Verdict } from "../connections/rules.js";
import type { PersonaConfig, PersonaStore } from "../personas.js";
import type { PodmanRuntime } from "../sandbox/podman.js";
import { SessionCredentials, type CredentialHost } from "./session-credentials.js";

const creds: Record<string, Partial<ResolvedCredential>> = {
  "github/GITHUB_TOKEN": { kind: "static", env: "GITHUB_TOKEN", hosts: ["api.github.com"], value: "real-gh" },
  "corp/aws": { kind: "aws-sigv4", hosts: ["*.amazonaws.com"], aws: { accessKeyId: "ASIAREAL0000000000", secretAccessKey: "real-secret" } },
  "corp/registry": { kind: "basic", username: "dev", hosts: ["registry.corp.example"], value: "real-pw" },
};

function setup(approve: ApprovalBody | null = { decision: "allow_session" }) {
  const items: ChatItem[] = [];
  let allowances: string[] = [];
  const cfg = {
    connections: {
      github: { rules: [{ credential: "GITHUB_TOKEN", api: "http", allow: ["GET /**"], ask: ["POST /**"], deny: [] }] },
      corp: { rules: [{ credential: "*", api: "aws", allow: ["s3:Get*"], ask: [], deny: [] }] },
    },
  } as unknown as PersonaConfig;
  const connections = {
    configOf: (c: string) => (c === "github" ? { type: "static" } : c === "corp" ? { type: "command" } : undefined),
    resolve: (ref: string) => (creds[ref] ? { ref, ...creds[ref] } : undefined),
    status: () => [],
  } as unknown as ConnectionManager;
  const personas = {
    get: () => ({ config: cfg }),
    namedRefs: () => new Set(["github/GITHUB_TOKEN", "corp/aws", "corp/registry"]),
  } as unknown as PersonaStore;
  const host: CredentialHost = {
    id: "s1",
    personaId: "p1",
    connections,
    personas,
    runtime: {} as PodmanRuntime,
    container: () => "ph-s1",
    addItem: (it) => items.push(it),
    syncItem: (it) => items.splice(items.findIndex((x) => x.id === it.id), 1, { ...it }),
    notice: () => {},
    allowances: () => allowances,
    setAllowances: (a) => (allowances = a),
    waitApproval: async () => approve,
    refreshPolicy: () => {},
  };
  const placeholders: Record<string, string> = {};
  return { sc: new SessionCredentials(host, placeholders), items, placeholders, allowances: () => allowances };
}

const verdict = (description: string, rule: string | null = null): Verdict => ({ mode: rule ? "ask" : "deny", rule, api: "http", op: { api: "http", classified: true, description, suggestion: description } });

describe("SessionCredentials", () => {
  it("renders references as this session's placeholders, never values", () => {
    const { sc } = setup();
    sc.ensurePlaceholders();
    const out = sc.render("t={{credential:github/GITHUB_TOKEN}} k={{credential:corp/aws.accessKeyId}} b={{credential:corp/registry|basic}} x={{credential:other/X}}");
    expect(out).toMatch(/^t=phs_GITHUB_TOKEN_[0-9a-f]{16} k=ASIASWAN[0-9A-F]{12} b=\S+ x=$/);
    expect(Buffer.from(/b=(\S+)/.exec(out)![1], "base64").toString()).toMatch(/^dev:phs_registry_/);
    expect(out).not.toMatch(/real-/);
    expect(sc.staticEnv()).toEqual({ GITHUB_TOKEN: expect.stringMatching(/^phs_GITHUB_TOKEN_/) });
  });

  it("registers placeholders, rules and until-stopped allowances with the proxy", () => {
    const { sc, placeholders } = setup();
    sc.ensurePlaceholders();
    const f = sc.proxyFields();
    expect(f.credentials).toEqual(["github/GITHUB_TOKEN", "corp/aws", "corp/registry"]);
    expect(f.placeholders.get(placeholders["corp/aws.secretAccessKey"])).toEqual({ ref: "corp/aws", field: "secretAccessKey" });
    expect(f.placeholders.get(placeholders["github/GITHUB_TOKEN"])).toEqual({ ref: "github/GITHUB_TOKEN" });
    expect(f.rules.get("corp")?.[0].allow).toEqual(["s3:Get*"]);
  });

  it("groups blocked requests per credential and rule within a minute", () => {
    const { sc, items } = setup();
    sc.blockedRequest("github/GITHUB_TOKEN", verdict("DELETE /repos/a/b"));
    sc.blockedRequest("github/GITHUB_TOKEN", verdict("DELETE /repos/a/c"));
    sc.blockedRequest("github/GITHUB_TOKEN", verdict("DELETE /repos/a/b"));
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({ kind: "credential_blocked", count: 3, rule: null, operations: ["DELETE /repos/a/c", "DELETE /repos/a/b"] });
  });

  it("allows until stopped for the matched ask rule, and remembers a deny until reset", async () => {
    const allow = setup({ decision: "allow_session" });
    expect(await allow.sc.requestUse("github/GITHUB_TOKEN", verdict("POST /repos/a/b/issues", "POST /**"))).toBe(true);
    expect(allow.allowances()).toEqual(["cred:github/GITHUB_TOKEN http:POST /**"]);
    expect(allow.items[0]).toMatchObject({ kind: "tool_call", name: "credential_use", status: "done" });

    const deny = setup({ decision: "deny" });
    expect(await deny.sc.requestUse("github/GITHUB_TOKEN", verdict("POST /x", "POST /**"))).toBe(false);
    expect(await deny.sc.requestUse("github/GITHUB_TOKEN", verdict("POST /y", "POST /**"))).toBe(false);
    expect(deny.items).toHaveLength(1); // the second request did not ask again
    deny.sc.reset();
    await deny.sc.requestUse("github/GITHUB_TOKEN", verdict("POST /z", "POST /**"));
    expect(deny.items).toHaveLength(2);
  });
});
