import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import YAML from "yaml";
import { beforeAll, describe, expect, it } from "vitest";
import { ConnectionManager } from "./connections/manager.js";
import { exportPersona, importPersona, previewImport } from "./persona-share.js";
import { PersonaStore } from "./personas.js";
import { SecretStore } from "./secrets.js";
import { paths, type Settings } from "./settings.js";
import { SkillRegistry } from "./skills.js";

const SECRET = "ghp-super-secret-value-0123456789";
const settings = { providers: {}, skillDirs: [], defaultModel: { provider: "none", id: "none" }, sandboxTools: { packages: [] } } as unknown as Settings;
let d: { settings: Settings; personas: PersonaStore; connections: ConnectionManager; skills: SkillRegistry };
let work: string;
let docs: string;

const CONFIG = (corpCommand = "/bin/echo") => `connections:
  github:
    type: static
    credentials:
      GITHUB_TOKEN: { hosts: [api.github.com], inject: { header: Authorization, format: "Bearer {value}" } }
  corp:
    type: command
    command: [${corpCommand}, sign-in]
    hosts: ["*.corp.test"]
`;

beforeAll(async () => {
  // Start clean: the test home lives in the system's temp folder and may be left from an earlier run.
  if (!paths.home.startsWith(os.tmpdir()) && !paths.home.startsWith("/private" + os.tmpdir())) throw new Error(`refusing to clean ${paths.home}`);
  await fs.rm(paths.personas, { recursive: true, force: true });
  await fs.rm(paths.skills, { recursive: true, force: true });
  await fs.mkdir(paths.personas, { recursive: true });
  work = await fs.mkdtemp(path.join(os.homedir(), ".swan-share-test-"));
  docs = await fs.mkdtemp(path.join(os.homedir(), ".swan-share-docs-"));
  await fs.writeFile(paths.config, CONFIG());
  await fs.writeFile(paths.secretsYaml, `github/GITHUB_TOKEN: ${SECRET}\n`, { mode: 0o600 });
  const skill = path.join(paths.skills, "tour");
  await fs.mkdir(path.join(skill, "scripts"), { recursive: true });
  await fs.writeFile(path.join(skill, "SKILL.md"), "---\nname: tour\ndescription: Tour a repo\n---\nRun the script.\n");
  await fs.writeFile(path.join(skill, "scripts", "run.sh"), "#!/bin/sh\necho tour\n", { mode: 0o755 });

  const secrets = new SecretStore();
  await secrets.load();
  const connections = new ConnectionManager(secrets, settings);
  await connections.loadConfig();
  const skills = new SkillRegistry(settings);
  await skills.load();
  const personas = new PersonaStore(settings, connections, skills);
  d = { settings, personas, connections, skills };
  await personas.save(
    "platform",
    `name: Platform\nfolders:\n  - { path: ${work}, mode: rw }\n  - { path: ${docs}, mount: /workspace/docs, mode: ro }\nskills: [tour]\nnetwork: { allow: [pypi.org], internal: [jira.corp.test] }\nconnections:\n  github: { rules: [{ credential: GITHUB_TOKEN, api: http, allow: ["GET /**"], ask: ["POST /**"] }] }\n  corp: { rules: [{ credential: eks, api: kubernetes, allow: ["get *"] }] }\npermissions: { default: ask, allow: [bash] }\n`,
    { create: true },
  );
  return async () => {
    await fs.rm(work, { recursive: true, force: true });
    await fs.rm(docs, { recursive: true, force: true });
  };
});

describe("exporting a persona", () => {
  it("carries the persona, its connections and chosen skills, and never a secret value", async () => {
    const text = await exportPersona(d, "platform", ["tour"]);
    expect(text).not.toContain(SECRET);
    const f = YAML.parse(text);
    expect(f.persona).toContain("name: Platform");
    expect(Object.keys(f.connections).sort()).toEqual(["corp", "github"]);
    expect(f.connections.github.credentials.GITHUB_TOKEN).toEqual({ hosts: ["api.github.com"], inject: { header: "Authorization", format: "Bearer {value}" } });
    expect(f.needs).toEqual({ values: ["github/GITHUB_TOKEN"], commands: ["/bin/echo"], sandboxTools: false });
    expect(f.skills.tour.files["scripts/run.sh"]).toMatchObject({ executable: true });
    expect(Buffer.from(f.skills.tour.files["SKILL.md"].base64, "base64").toString()).toContain("Tour a repo");
    expect(YAML.parse(await exportPersona(d, "platform", [])).skills).toEqual({});
  });
});

describe("importing a persona", () => {
  it("previews what the persona may reach, with a free id, and saves nothing", async () => {
    const p = await previewImport(d, await exportPersona(d, "platform", ["tour"]));
    expect(p.id).toBe("platform-2");
    expect(p.access).toMatchObject({ networkAllow: ["pypi.org"], networkInternal: ["jira.corp.test"], allowsAllCommands: true });
    expect(p.access.credentialRules.map((r) => `${r.connection}/${r.credential}`)).toEqual(["github/GITHUB_TOKEN", "corp/eks"]);
    expect(p.connections.map((c) => [c.name, c.status])).toEqual([["github", "same"], ["corp", "same"]]);
    expect(p.connections.find((c) => c.name === "corp")?.command).toEqual(["/bin/echo", "sign-in"]);
    expect(p.skills).toEqual([{ name: "tour", files: 2, exists: true }]);
    expect(d.personas.get("platform-2")).toBeUndefined();
  });

  it("maps folders, keeps existing connections and skills, and adds a sign-in tool only when ticked", async () => {
    const text = await exportPersona(d, "platform", ["tour"]);
    // A teammate's Mac: no github connection, a different corp sign-in tool, no skills.
    await fs.writeFile(paths.config, "connections:\n" + CONFIG("/usr/local/bin/other").split("\n").slice(5).join("\n"));
    await d.connections.loadConfig();
    await fs.rm(path.join(paths.skills, "tour"), { recursive: true });
    await d.skills.load();
    const p = await previewImport(d, text);
    expect(p.connections.map((c) => [c.name, c.status])).toEqual([["github", "new"], ["corp", "different"]]);

    const r = await importPersona(d, text, { id: "team-platform", name: "Team platform", folders: [docs, null], commandConnections: [], skills: ["tour"] });
    expect(r).toMatchObject({ connectionsAdded: ["github"], skillsAdded: ["tour"] });
    const cfg = YAML.parse(await fs.readFile(paths.config, "utf8"));
    expect(cfg.connections.corp.command).toEqual(["/usr/local/bin/other", "sign-in"]); // existing, untouched
    expect(cfg.connections.github.type).toBe("static");
    expect(await fs.readFile(paths.secretsYaml, "utf8")).not.toContain("team-platform");
    const saved = d.personas.get("team-platform")!.config!;
    expect(saved.name).toBe("Team platform");
    expect(saved.folders.map((f) => f.path)).toEqual([docs]);
    expect((await fs.stat(path.join(paths.skills, "tour", "scripts", "run.sh"))).mode & 0o111).toBeTruthy();
  });

  it("shows a persona's sandbox tools and adds them only when accepted, since they run as root in the build", async () => {
    await d.personas.save("tooly", "name: Tooly\nsandbox:\n  memory: 4g\n  tools:\n    packages: [jq]\n    install: curl https://example.com/x | sh\n", { create: true });
    const text = await exportPersona(d, "tooly", []);
    expect(YAML.parse(text).needs.sandboxTools).toBe(false);
    expect((await previewImport(d, text)).access.tools).toEqual({ packages: ["jq"], install: "curl https://example.com/x | sh" });
    const base = { name: "T", folders: [], skills: [], commandConnections: [] };
    await importPersona(d, text, { ...base, id: "tools-left-out" });
    expect(d.personas.get("tools-left-out")!.config!.sandbox).toMatchObject({ memory: "4g" });
    expect(d.personas.get("tools-left-out")!.config!.sandbox.tools).toBeUndefined();
    await importPersona(d, text, { ...base, id: "tools-kept", acceptTools: true });
    expect(d.personas.get("tools-kept")!.config!.sandbox.tools).toMatchObject({ packages: ["jq"] });
  });

  it("adds a new sign-in tool only when ticked, and refuses taken ids", async () => {
    await fs.writeFile(paths.config, CONFIG());
    await d.connections.loadConfig();
    const text = await exportPersona(d, "platform", []);
    await fs.writeFile(paths.config, "connections: {}\n");
    await d.connections.loadConfig();
    const base = { name: "X", folders: [null, null], skills: [] };
    await importPersona(d, text, { ...base, id: "no-tool", commandConnections: [] });
    expect(d.connections.configOf("corp")).toBeUndefined();
    await importPersona(d, text, { ...base, id: "with-tool", commandConnections: ["corp"] });
    expect(d.connections.configOf("corp")).toMatchObject({ type: "command", command: ["/bin/echo", "sign-in"] });
    await expect(importPersona(d, text, { ...base, id: "with-tool", commandConnections: [] })).rejects.toThrow(/already exists/);
  });

  it("refuses files that are not persona files or reach outside a skill's folder", async () => {
    await expect(previewImport(d, "just: text\n")).rejects.toThrow(/not a Swan persona file/);
    const f = YAML.parse(await exportPersona(d, "platform", []));
    f.skills = { tour: { files: { "../../config.yaml": { base64: "eA==" } } } };
    await expect(previewImport(d, YAML.stringify(f))).rejects.toThrow(/outside its folder/);
    f.skills = { "Bad Name": { files: {} } };
    await expect(previewImport(d, YAML.stringify(f))).rejects.toThrow(/not valid/);
  });
});
