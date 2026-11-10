import { describe, expect, it } from "vitest";
import { blankConfig, cleaned, validate, withDefaults } from "./config";

const named = () => ({ ...blankConfig(), name: "Backend" });

describe("a persona's settings form", () => {
  it("accepts the blank form once it has a name and a file name", () => {
    expect(validate(blankConfig(), true, "", false, null)).toMatchObject({ id: "Choose a file name for the persona.", name: "Name is required." });
    expect(validate(named(), true, "backend-dev", false, null)).toEqual({});
    expect(validate(named(), true, "Backend_Dev", false, null).id).toBe("Use lowercase letters, digits and single dashes.");
    expect(validate(named(), true, "backend-dev", true, null).id).toBe("A persona with this file name already exists.");
    expect(validate(named(), false, "", false, null)).toEqual({});
  });

  it("names each host, folder, rule and sub-agent row that needs fixing", () => {
    const d = named();
    d.networkAllow = ["api.github.com", "*.example.com", "bad host", ""];
    d.networkInternal = ["jira.corp:8443"];
    d.folders = [{ path: "~/code", mode: "rw" }, { path: "~/x", mount: "/elsewhere", mode: "ro" }];
    d.connections = { github: { rules: [{ credential: "GITHUB_*", api: "http", allow: [], ask: [], deny: [] } as never, { credential: "has space", api: "http", allow: [], ask: [], deny: [] } as never] } };
    d.subagents.agents = [
      { name: "reviewer", model: "anthropic/claude-x" },
      { name: "auto", model: "auto" },
      { name: "reviewer", model: "auto" },
      { name: "fast", model: "no-slash" },
    ];
    const e = validate(d, false, "", false, null);
    expect(Object.keys(e).sort()).toEqual(["folder1", "host2", "host3", "rule-github-1", "sa-1", "sa-2", "sa-3"]);
    expect(e["sa-2"]).toBe("Another sub-agent has this name.");
  });

  it("checks the limits and passes on an MCP JSON problem", () => {
    const d = named();
    d.subagents.maxBackground = 33;
    d.subagents.maxTurns = Number.NaN;
    d.memory.briefTokens = 1.5;
    expect(Object.keys(validate(d, false, "", false, "Not valid JSON yet.")).sort()).toEqual(["briefTokens", "maxBackground", "maxTurns", "mcp"]);
  });

  it("trims what is saved and drops empty rows", () => {
    const d = named();
    d.name = "  Backend  ";
    d.networkAllow = [" api.github.com ", "  "];
    d.permissions.allow = ["read_file", " ", " grep "];
    d.connections = { github: { rules: [{ credential: " TOKEN ", api: "http", allow: [" GET /repos/* ", ""], ask: [], deny: [] } as never] } };
    const c = cleaned(d);
    expect(c).toMatchObject({ name: "Backend", networkAllow: ["api.github.com"], permissions: { allow: ["read_file", "grep"] } });
    expect(c.connections.github.rules[0]).toMatchObject({ credential: "TOKEN", allow: ["GET /repos/*"] });
    expect(d.name).toBe("  Backend  "); // the draft itself is left as typed
  });

  it("fills in what an older server leaves out", () => {
    const { subagents: _s, networkInternal: _i, ...old } = blankConfig();
    expect(withDefaults(old as never)).toMatchObject({ subagents: { maxBackground: 4, maxTurns: 200 }, networkInternal: [], networkOtherCredentials: [] });
  });
});
