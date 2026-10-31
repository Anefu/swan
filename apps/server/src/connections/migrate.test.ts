import { promises as fs } from "node:fs";
import path from "node:path";
import YAML from "yaml";
import { beforeEach, describe, expect, it } from "vitest";
import { SecretStore } from "../secrets.js";
import { paths, type Settings } from "../settings.js";
import { ConnectionManager } from "./manager.js";
import { connectionNameFor, migrateConnections, readMigrationNote } from "./migrate.js";

beforeEach(async () => {
  for (const f of [paths.config, paths.secretsYaml, paths.secretsEnv, paths.migrationNote]) {
    await fs.rm(f, { force: true });
    await fs.rm(`${f}.bak`, { force: true });
  }
  await fs.rm(paths.personas, { recursive: true, force: true });
  await fs.mkdir(paths.personas, { recursive: true });
});

describe("migration to connections", () => {
  it("names connections after the first host's registrable name", () => {
    expect(connectionNameFor("api.github.com")).toBe("github");
    expect(connectionNameFor("*.githubusercontent.com")).toBe("githubusercontent");
    expect(connectionNameFor("registry.npmjs.org")).toBe("npmjs");
    expect(connectionNameFor("api.example.co.uk")).toBe("example");
  });

  it("moves bindings to config.yaml, values to connection keys, and personas to rules that keep today's access", async () => {
    await fs.writeFile(paths.config, "# my settings\nport: 4317\n");
    await fs.writeFile(
      paths.secretsYaml,
      [
        "# keep this comment",
        "ANTHROPIC_API_KEY: sk-ant",
        "GITHUB_TOKEN:",
        "  value: ghp_x",
        "  hosts: [api.github.com]",
        "  inject: { header: Authorization, format: 'Bearer {value}' }",
        "LOOSE: no-hosts",
        "",
      ].join("\n"),
    );
    await fs.writeFile(paths.secretsEnv, 'NPM_TOKEN="npm_y" # from npm\nNPM_TOKEN__HOSTS=registry.npmjs.org\nOTHER=1\n');
    await fs.writeFile(
      path.join(paths.personas, "dev.yaml"),
      "name: Dev\ncredentials: [GITHUB_TOKEN, NPM_TOKEN, MISSING]\nmcpServers:\n  gh:\n    command: npx\n    env: { T: '{{secret:GITHUB_TOKEN}}' }\n",
    );

    const note = await migrateConnections(new Set(["ANTHROPIC_API_KEY"]));
    expect(note).toMatchObject({
      moved: ["GITHUB_TOKEN → github/GITHUB_TOKEN", "NPM_TOKEN → npmjs/NPM_TOKEN"],
      personas: ["dev"],
      kept: ["LOOSE"],
      problems: [expect.stringContaining("MISSING has no hosts")],
    });
    expect(await readMigrationNote()).toEqual(note);

    const config = YAML.parse(await fs.readFile(paths.config, "utf8"));
    expect(config.connections).toEqual({
      github: { type: "static", credentials: { GITHUB_TOKEN: { hosts: ["api.github.com"], inject: { header: "Authorization", format: "Bearer {value}" } } } },
      npmjs: { type: "static", credentials: { NPM_TOKEN: { hosts: ["registry.npmjs.org"] } } },
    });
    expect(await fs.readFile(paths.config, "utf8")).toMatch(/^# my settings/);
    const secrets = await fs.readFile(paths.secretsYaml, "utf8");
    expect(secrets).toContain("# keep this comment");
    expect(YAML.parse(secrets)).toEqual({ ANTHROPIC_API_KEY: "sk-ant", "github/GITHUB_TOKEN": "ghp_x", LOOSE: "no-hosts" });
    expect(await fs.readFile(paths.secretsEnv, "utf8")).toBe('NPMJS__NPM_TOKEN="npm_y" # from npm\nOTHER=1\n');
    expect(await fs.readFile(`${paths.secretsYaml}.bak`, "utf8")).toContain("hosts: [api.github.com]");

    const persona = YAML.parse(await fs.readFile(path.join(paths.personas, "dev.yaml"), "utf8"));
    expect(persona.credentials).toBeUndefined();
    expect(persona.connections).toEqual({
      github: { rules: [{ credential: "GITHUB_TOKEN", api: "http", allow: ["* /**"] }] },
      npmjs: { rules: [{ credential: "NPM_TOKEN", api: "http", allow: ["* /**"] }] },
    });
    expect(persona.mcpServers.gh.env.T).toBe("{{credential:github/GITHUB_TOKEN}}");

    // The converted files load as connections with the same values.
    const s = new SecretStore();
    await s.load();
    const m = new ConnectionManager(s, { providers: {} } as unknown as Settings);
    await m.loadConfig();
    expect(m.usable("github/GITHUB_TOKEN")?.value).toBe("ghp_x");
    expect(m.usable("npmjs/NPM_TOKEN")?.value).toBe("npm_y");

    // Runs once.
    expect(await migrateConnections(new Set())).toBeNull();
  });

  it("only adds an empty connections block when there is nothing to convert", async () => {
    await fs.writeFile(paths.config, "port: 4317\n");
    await fs.writeFile(paths.secretsYaml, "ANTHROPIC_API_KEY: sk\n");
    expect(await migrateConnections(new Set(["ANTHROPIC_API_KEY"]))).toBeNull();
    expect(YAML.parse(await fs.readFile(paths.config, "utf8"))).toEqual({ port: 4317, connections: {} });
    expect(await readMigrationNote()).toBeNull();
  });
});
