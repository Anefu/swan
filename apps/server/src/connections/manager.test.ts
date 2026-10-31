import { promises as fs } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { startStub, type StubServer } from "@ph/aws-stub/server";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { SecretStore } from "../secrets.js";
import { paths, type Settings } from "../settings.js";
import { ConnectionManager } from "./manager.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const wrapper = path.resolve(here, "../../../../tools/aws-stub/bin/swan-stub-connection");
const settings = { providers: { anthropic: { type: "anthropic", apiKeySecret: "ANTHROPIC_API_KEY" } } } as unknown as Settings;

let stub: StubServer;
beforeAll(async () => {
  stub = await startStub();
});
afterAll(() => stub.close());

async function setup(connections: string, secrets = "") {
  await fs.mkdir(paths.connections, { recursive: true });
  await fs.rm(path.join(paths.connections, "stub"), { recursive: true, force: true });
  await fs.writeFile(paths.config, `port: 4317\nconnections:\n${connections}`);
  await fs.writeFile(paths.secretsYaml, secrets);
  await fs.rm(paths.secretsEnv, { force: true });
  const s = new SecretStore();
  await s.load();
  const m = new ConnectionManager(s, settings);
  await m.loadConfig();
  return { m, s };
}

const stubConnection = (hosts = '["127.0.0.1"]') => `  stub:\n    type: command\n    command: ["${wrapper}", --stub, "${stub.url}"]\n    hosts: ${hosts}\n`;

const waitFor = async <T>(fn: () => T | undefined, ms = 10_000): Promise<T> => {
  const end = Date.now() + ms;
  for (;;) {
    const v = fn();
    if (v) return v;
    if (Date.now() > end) throw new Error("timed out");
    await new Promise((r) => setTimeout(r, 50));
  }
};

beforeEach(() => {
  stub.state.options.autoApprove = false;
});

describe("command connections", () => {
  it("signs in with a device code, then holds the wrapper's credentials on the host", async () => {
    const { m } = await setup(stubConnection());
    expect(await m.ensure("stub")).toBe("login_required");

    const login = m.login("stub");
    const code = await waitFor(() => m.status()[0].signIn ?? undefined);
    expect(m.status()[0].state).toBe("signing_in");
    expect(code.verificationUri).toBe(`${stub.url}/sso/device`);
    await fetch(`${stub.url}/_stub/sso/approve`, { method: "POST", body: JSON.stringify({ user_code: code.userCode }) });
    expect(await login).toBe("ready");

    const st = m.status()[0];
    expect(st).toMatchObject({ state: "ready", signIn: null, message: "Signed in to the AWS stub as ReadOnly" });
    expect(st.credentials.map((c) => [c.name, c.kind, c.present])).toEqual([
      ["aws", "aws-sigv4", true],
      ["eks", "bearer", true],
    ]);
    const aws = m.usable("stub/aws")!;
    expect(aws.aws?.accessKeyId).toMatch(/^ASIA/);
    // Status carries fingerprints, never values.
    expect(JSON.stringify(m.status())).not.toContain(aws.aws!.secretAccessKey);

    // Files are rendered with a session's placeholders; values never appear.
    const { files, env } = m.materials("stub");
    const creds = files.find((f) => f.path === "~/.aws/credentials")!;
    const rendered = m.render("stub", creds.content, (ref, field) => `PH(${ref}${field ? `.${field}` : ""})`);
    expect(rendered).toContain("aws_access_key_id = PH(stub/aws.accessKeyId)");
    expect(rendered).not.toContain(aws.aws!.secretAccessKey);
    expect(m.render("stub", files.find((f) => f.path === "~/.kube/config")!.content, (ref) => `PH(${ref})`)).toContain("token: PH(stub/eks)");
    expect(env).toMatchObject({ AWS_PROFILE: "swan-stub" });

    // A renewal swaps the values and keeps everything else.
    const before = m.usable("stub/aws")!.aws!.accessKeyId;
    const changed: string[][] = [];
    m.on("changed", (refs) => changed.push(refs));
    expect(await m.renew("stub")).toBe("ready");
    expect(m.usable("stub/aws")!.aws!.accessKeyId).not.toBe(before);
    expect(changed.flat()).toContain("stub/aws");
  });

  it("asks for a sign-in only when a check finds it gone, not when the user signs out or cancels", async () => {
    stub.state.options.autoApprove = true;
    const { m } = await setup(stubConnection());
    const asked: string[] = [];
    m.on("needsSignIn", (c) => asked.push(c));
    expect(await m.ensure("stub")).toBe("login_required");
    expect(asked).toEqual(["stub"]);
    expect(await m.login("stub")).toBe("ready");
    m.logout("stub");
    expect(m.status()[0]).toMatchObject({ state: "login_required", credentials: [] });
    expect(asked).toEqual(["stub"]);
  });

  it("can cancel a sign-in that waits on the user", async () => {
    const { m } = await setup(stubConnection());
    const login = m.login("stub");
    await waitFor(() => m.status()[0].signIn ?? undefined);
    m.cancel("stub");
    expect(await login).toBe("login_required");
    expect(m.status()[0]).toMatchObject({ state: "login_required", message: "Sign-in cancelled", signIn: null });
  });

  it("rejects credentials for hosts outside the connection's bounds", async () => {
    stub.state.options.autoApprove = true;
    const { m } = await setup(stubConnection('["*.amazonaws.com"]'));
    expect(await m.login("stub")).toBe("error");
    expect(m.status()[0].message).toMatch(/host 127\.0\.0\.1 is outside the connection's hosts/);
    expect(m.usable("stub/aws")).toBeUndefined();
  });

  it("turns broken wrapper output into an error", async () => {
    const bad = path.join(paths.home, "bad-wrapper.sh");
    await fs.writeFile(bad, "#!/bin/sh\necho 'not json'\n", { mode: 0o755 });
    const { m } = await setup(`  broken:\n    type: command\n    command: ["${bad}"]\n    hosts: [example.com]\n`);
    expect(await m.ensure("broken")).toBe("error");
    expect(m.status()[0].message).toMatch(/line 1 is not JSON/);
  });
});

describe("static connections", () => {
  it("keeps bindings in config.yaml and values in secrets.yaml", async () => {
    const { m, s } = await setup("  github:\n    type: static\n    credentials:\n      GITHUB_TOKEN: { hosts: [api.github.com] }\n", "github/GITHUB_TOKEN: ghp_secret\n");
    expect(m.usable("github/GITHUB_TOKEN")).toMatchObject({ kind: "static", value: "ghp_secret", env: "GITHUB_TOKEN", hosts: ["api.github.com"] });
    expect(m.status()[0]).toMatchObject({ state: "ready", credentials: [{ ref: "github/GITHUB_TOKEN", present: true, source: "yaml" }] });

    await m.upsertStatic("npm", "NPM_TOKEN", { value: "npm_x", hosts: ["registry.npmjs.org"], inject: { header: "Authorization", format: "Bearer {value}" } });
    expect(await fs.readFile(paths.config, "utf8")).toMatch(/npm:\n\s+type: static/);
    expect(s.value("npm/NPM_TOKEN")).toBe("npm_x");
    expect(m.usable("npm/NPM_TOKEN")?.inject).toEqual({ header: "Authorization", format: "Bearer {value}" });
    await expect(m.upsertStatic("npm", "OTHER", { value: "v" })).rejects.toThrow(/needs at least one host/);

    await m.removeStatic("npm", "NPM_TOKEN");
    expect(m.names()).toEqual(["github"]);
    expect(s.value("npm/NPM_TOKEN")).toBeUndefined();
  });

  it("reads secrets.env spellings and resolves host-side references only for allowed refs", async () => {
    const { m, s } = await setup("  corp-api:\n    type: static\n    credentials:\n      KEY: { hosts: [api.corp.example] }\n");
    await fs.writeFile(paths.secretsEnv, "CORP_API__KEY=from-env\n");
    await s.load();
    expect(m.usable("corp-api/KEY")?.value).toBe("from-env");
    expect(m.resolveHost("Bearer {{credential:corp-api/KEY}}", new Set(["corp-api/KEY"]))).toEqual({ text: "Bearer from-env", missing: [], used: ["corp-api/KEY"] });
    expect(m.resolveHost("{{secret:KEY}}", new Set(["corp-api/KEY"])).text).toBe("from-env");
    expect(m.resolveHost("{{credential:corp-api/KEY}}", new Set()).text).toBe("");
  });

  it("keeps the last good set when config.yaml has a bad connection", async () => {
    const { m } = await setup("  github:\n    type: static\n    credentials:\n      GITHUB_TOKEN: { hosts: [api.github.com] }\n");
    await fs.writeFile(paths.config, "connections:\n  Bad_Name:\n    type: static\n");
    await m.loadConfig();
    expect(m.error).toMatch(/connection names/);
    expect(m.names()).toEqual(["github"]);
  });
});
