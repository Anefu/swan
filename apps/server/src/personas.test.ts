import { promises as fs } from "node:fs";
import { beforeAll, describe, expect, it } from "vitest";
import { ConnectionManager } from "./connections/manager.js";
import { PersonaStore } from "./personas.js";
import { SecretStore } from "./secrets.js";
import { paths, type Settings } from "./settings.js";
import { SkillRegistry } from "./skills.js";

const settings = { providers: {}, skillDirs: [], defaultModel: { provider: "none", id: "none" } } as unknown as Settings;
const store = new PersonaStore(settings, new ConnectionManager(new SecretStore(), settings), new SkillRegistry(settings));
const networkErrors = (yaml: string) => store.parse("p", yaml).errors.filter((e) => e.startsWith("network."));

describe("persona network settings", () => {
  beforeAll(() => fs.mkdir(paths.personas, { recursive: true }));

  it("accepts internal hosts in the same forms as allowed hosts", () => {
    expect(networkErrors(`name: P\nnetwork:\n  internal: [jira.corp.example.com, "*.corp.example.com", "build.corp.example.com:8443"]\n`)).toEqual([]);
    expect(networkErrors(`name: P\nnetwork:\n  internal: ["*", 10.0.0.0/8]\n`)).toEqual([
      'network.internal entry "*" must be a hostname, *.domain or host:port',
      'network.internal entry "10.0.0.0/8" must be a hostname, *.domain or host:port',
    ]);
  });

  it("checks otherCredentials like the other host lists", () => {
    expect(networkErrors(`name: P\nnetwork:\n  otherCredentials: [registry.corp.example.com]\n`)).toEqual([]);
    expect(networkErrors(`name: P\nnetwork:\n  otherCredentials: ["*"]\n`)).toEqual(['network.otherCredentials entry "*" must be a hostname, *.domain or host:port']);
  });

  it("saves internal hosts from Settings, and leaves the key out while there are none", async () => {
    await store.save("net-test", "name: Net test\nnetwork:\n  allow: [example.com]\n", { create: true });
    const view = store.configView("net-test");
    expect(view.networkInternal).toEqual([]);
    await store.saveConfig("net-test", view);
    expect(await fs.readFile(`${paths.personas}/net-test.yaml`, "utf8")).not.toContain("internal");

    const result = await store.saveConfig("net-test", { ...view, networkInternal: ["jira.corp.example.com"] });
    expect(result.appliedNow).toContain("network allowlist");
    expect(store.configView("net-test")).toMatchObject({ networkAllow: ["example.com"], networkInternal: ["jira.corp.example.com"] });
    expect(store.summary(store.get("net-test")!).networkInternal).toEqual(["jira.corp.example.com"]);
  });
});

describe("persona permissions", () => {
  it("adds allow rules from an approval card once, keeping the others", async () => {
    await fs.mkdir(paths.personas, { recursive: true });
    await store.save("perm-test", "name: Perm test\npermissions:\n  allow: [read_file, \"cd *\"]\n  ask: [bash]\n", { create: true });
    await store.addAllowRules("perm-test", ["npm test *", "bash(npm test)", "cd *"]);
    await store.addAllowRules("perm-test", ["npm test *"]);
    expect(store.get("perm-test")!.config!.permissions).toMatchObject({ allow: ["read_file", "cd *", "npm test *", "bash(npm test)"], ask: ["bash"] });
    expect(store.parse("perm-test", await fs.readFile(`${paths.personas}/perm-test.yaml`, "utf8")).config!.permissions.allow).toContain("npm test *");
  });
});

describe("http MCP servers", () => {
  const urlErrors = (yaml: string) => store.parse("p", yaml).errors.filter((e) => e.includes(".url"));
  it("must use https when a header uses a credential", () => {
    const srv = (url: string, auth: string) => `name: P\nmcpServers:\n  gh:\n    url: ${url}\n    headers: { Authorization: "${auth}" }\n`;
    expect(urlErrors(srv("http://mcp.example.com/mcp", "Bearer {{credential:github/token}}"))).toEqual(["mcpServers.gh.url: a server whose headers use a credential must use https://"]);
    expect(urlErrors(srv("https://mcp.example.com/mcp", "Bearer {{credential:github/token}}"))).toEqual([]);
    expect(urlErrors(srv("http://localhost:3000/mcp", "Bearer static"))).toEqual([]);
  });
});

describe("persona edits", () => {
  beforeAll(() => fs.mkdir(paths.personas, { recursive: true }));

  it("made at the same time all land: each runs on the latest YAML", async () => {
    await store.save("edit-race", "# kept\nname: Race\nnetwork:\n  allow: [a.example.com]\n", { create: true });
    await Promise.all([
      store.addNetworkHost("edit-race", "b.example.com"),
      store.addAllowRules("edit-race", ["npm test *"]),
      store.addNetworkHost("edit-race", "c.example.com"),
      store.setModel("edit-race", { provider: "none", id: "m2" }).catch(() => {}), // unknown provider: refused, and the others still land
    ]);
    const cfg = store.get("edit-race")!.config!;
    expect(cfg.network.allow).toEqual(["a.example.com", "b.example.com", "c.example.com"]);
    expect(cfg.permissions.allow).toContain("npm test *");
    expect(await fs.readFile(`${paths.personas}/edit-race.yaml`, "utf8")).toContain("# kept");
    await store.remove("edit-race");
  });
});

describe("credential references", () => {
  it("say what to write instead of the {{secret:NAME}} form from before connections", () => {
    const errors = store.parse("p", `name: P\nenv:\n  TOKEN: "{{secret:GITHUB_TOKEN}}"\n`).errors;
    expect(errors).toContain("env.TOKEN: {{secret:GITHUB_TOKEN}} is no longer read; write {{credential:<connection>/GITHUB_TOKEN}}");
  });
});
