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
