import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import YAML from "yaml";
import { describe, expect, it } from "vitest";
import { ConnectionsSchema, credentialRefs } from "./connections/config.js";
import { PersonaSchema } from "./personas.js";
import { SECRET_KEY } from "./secrets.js";
import { SettingsSchema } from "./settings.js";

// The examples people copy must keep matching the formats Swan reads.
const examples = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../examples");
const load = (file: string): unknown => YAML.parse(readFileSync(path.join(examples, file), "utf8"));

const config = SettingsSchema.parse(load("reference/config.yaml"));
const connections = ConnectionsSchema.parse(config.connections);
const credentialsOf = (conn: string) => {
  const c = connections[conn];
  return c?.type === "static" ? Object.keys(c.credentials) : [];
};

describe("reference examples", () => {
  it("config.yaml parses, with its proxy, mirrors and connections", () => {
    expect(config.providers.copilot?.type).toBe("copilot");
    expect(config.proxy?.url).toMatch(/^http/);
    expect(config.mirrors.baseImage).toContain("node:22");
    expect(credentialsOf("github")).toEqual(["GITHUB_TOKEN"]);
  });

  it("persona.yaml parses and uses only providers, connections and credentials config.yaml defines", () => {
    const persona = PersonaSchema.parse(load("reference/persona.yaml"));
    expect(config.providers[persona.model!.provider]).toBeDefined();
    for (const a of persona.subagents.agents) if (a.model !== "auto") expect(config.providers[a.model.split("/")[0]!]).toBeDefined();
    for (const [conn, { rules }] of Object.entries(persona.connections))
      for (const r of rules) expect(credentialsOf(conn), `${conn}/${r.credential}`).toContain(r.credential);
    const refs = credentialRefs(JSON.stringify(persona.mcpServers));
    expect(refs.length).toBeGreaterThan(0);
    for (const ref of refs) expect(credentialsOf(ref.connection!), `${ref.connection}/${ref.name}`).toContain(ref.name);
  });

  it("secrets.example.yaml names only provider keys and the connections' credentials", () => {
    const secrets = load("reference/secrets.example.yaml") as Record<string, string>;
    const providerKeys = Object.values(config.providers).flatMap((p) => (p.apiKeySecret ? [p.apiKeySecret] : []));
    for (const [key, value] of Object.entries(secrets)) {
      expect(key).toMatch(SECRET_KEY);
      expect(value, `${key} must be empty in the example`).toBe("");
      if (key.includes("/")) {
        const [conn, name] = key.split("/") as [string, string];
        expect(credentialsOf(conn), key).toContain(name);
      } else expect(providerKeys, key).toContain(key);
    }
  });

  it("the example personas Swan seeds parse", () => {
    for (const f of readdirSync(path.join(examples, "personas"))) expect(() => PersonaSchema.parse(load(`personas/${f}`)), f).not.toThrow();
  });
});
