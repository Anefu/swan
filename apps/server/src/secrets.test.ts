import { promises as fs } from "node:fs";
import { beforeEach, describe, expect, it } from "vitest";
import { SecretStore } from "./secrets.js";
import { paths } from "./settings.js";

beforeEach(async () => {
  await fs.mkdir(paths.home, { recursive: true });
  await fs.rm(paths.secretsYaml, { force: true });
  await fs.rm(paths.secretsEnv, { force: true });
});

describe("SecretStore", () => {
  it("reads both files, lets YAML win, and binds env values to hosts", async () => {
    await fs.writeFile(
      paths.secretsEnv,
      ["NPM_TOKEN=npm_abc", "NPM_TOKEN__HOSTS=registry.npmjs.org, *.npmjs.com", 'SHARED="from env"', 'export QUOTED="a\\nb" # trailing comment', "HASH='x # y'", "PLAIN=value # comment", ""].join("\n"),
    );
    await fs.writeFile(paths.secretsYaml, "SHARED: from yaml\nGITHUB_TOKEN:\n  value: ghp_x\n  hosts: [api.github.com]\n  inject: { header: Authorization, format: 'Bearer {value}' }\n");
    const s = new SecretStore();
    await s.load();
    expect(s.get("NPM_TOKEN")).toMatchObject({ value: "npm_abc", source: "env", hosts: ["registry.npmjs.org", "*.npmjs.com"] });
    expect(s.value("SHARED")).toBe("from yaml");
    expect(s.value("QUOTED")).toBe("a\nb");
    expect(s.value("HASH")).toBe("x # y");
    expect(s.value("PLAIN")).toBe("value");
    expect(s.get("GITHUB_TOKEN")?.inject).toEqual({ header: "Authorization", format: "Bearer {value}" });
  });

  it("never exposes values in status, only fingerprints", async () => {
    await fs.writeFile(paths.secretsYaml, "API_KEY:\n  value: super-secret-value\n  hosts: [api.example.com]\n");
    const s = new SecretStore();
    await s.load();
    const status = JSON.stringify(s.status(new Map([["API_KEY", ["demo"]]])));
    expect(status).not.toContain("super-secret-value");
    expect(s.status(new Map())[0]).toMatchObject({ name: "API_KEY", present: true, fingerprint: expect.stringMatching(/^[0-9a-f]{8}$/), usedBy: [] });
  });

  it("reports changes and rejects bad files without clearing the last good set", async () => {
    await fs.writeFile(paths.secretsYaml, "A: one\n");
    const s = new SecretStore();
    const changed: string[][] = [];
    s.on("changed", (names) => changed.push(names));
    await s.load();
    await fs.writeFile(paths.secretsYaml, "A: two\nB: three\n");
    await s.load();
    expect(changed.at(-1)?.sort()).toEqual(["A", "B"]);
    await fs.writeFile(paths.secretsYaml, "bad-name!: x\n");
    await expect(s.load()).rejects.toThrow(/invalid secret name/);
    expect(s.value("A")).toBe("two");
  });

  it("resolves host-side references and lists missing ones", async () => {
    await fs.writeFile(paths.secretsYaml, "TOKEN: abc\n");
    const s = new SecretStore();
    await s.load();
    expect(s.resolveHost("Bearer {{secret:TOKEN}} {{ secret:MISSING }}")).toEqual({ text: "Bearer abc ", missing: ["MISSING"], used: ["TOKEN", "MISSING"] });
  });
});
