import { describe, expect, it } from "vitest";
import type { McpHttpConfig } from "../personas.js";
import { SessionMcp, credentialValues, httpMcpHeaders, scrubValues, type McpCredentials } from "./mcp.js";

const REAL = "ghp_realTokenValue+/=123";
const creds = (hosts: string[]): McpCredentials => ({
  resolve: (t) => ({ text: t.replace("{{credential:github/token}}", REAL), used: t.includes("{{credential:") ? ["github/token"] : [] }),
  hosts: () => hosts,
  scrub: (text, refs) => scrubValues(text, refs.length ? [{ secret: REAL, placeholder: "[credential github/token]" }] : []),
});
const cfg = (url: string): McpHttpConfig => ({ url, headers: { Authorization: "Bearer {{credential:github/token}}" }, enabled: true });

describe("http MCP credentials", () => {
  it("go only over HTTPS to one of the credential's hosts", () => {
    expect(httpMcpHeaders(cfg("https://api.githubcopilot.com/mcp/"), creds(["api.githubcopilot.com"])).headers.Authorization).toBe(`Bearer ${REAL}`);
    expect(httpMcpHeaders(cfg("https://x.github.com/mcp"), creds(["*.github.com"])).refs).toEqual(["github/token"]);
    expect(() => httpMcpHeaders(cfg("http://api.githubcopilot.com/mcp/"), creds(["api.githubcopilot.com"]))).toThrow(/only sent over HTTPS/);
    expect(() => httpMcpHeaders(cfg("https://attacker.example/mcp"), creds(["api.githubcopilot.com"]))).toThrow(/only sent to its own hosts \(api.githubcopilot.com\), and attacker.example isn't/);
    expect(() => httpMcpHeaders(cfg("https://api.githubcopilot.com.attacker.example/"), creds(["api.githubcopilot.com"]))).toThrow(/own hosts/);
    // No credential, no restriction: a local server with a static header is fine.
    expect(httpMcpHeaders({ url: "http://localhost:3000/mcp", headers: { "X-Key": "static" }, enabled: true }, creds([])).refs).toEqual([]);
  });

  it("are rewritten out of what the server sends back", async () => {
    const mcp = new SessionMcp({} as never, creds(["api.githubcopilot.com"]), { toolOutputLimit: 100_000 } as never, "c", "/workspace", (t) => t);
    const client = { callTool: async () => ({ content: [{ type: "text", text: `echo: ${REAL} ${encodeURIComponent(REAL)} ${Buffer.from(REAL).toString("base64")}` }] }) };
    (mcp as unknown as { conns: Map<string, unknown> }).conns.set("gh", { name: "gh", cfg: cfg("https://api.githubcopilot.com/mcp/"), client, error: null, credentialRefs: ["github/token"] });
    const out = await mcp.call("gh", "whoami", {}, new AbortController().signal);
    expect(out.text).not.toContain(REAL);
    expect(out.text).not.toContain(encodeURIComponent(REAL));
    expect(out.text).not.toContain(Buffer.from(REAL).toString("base64"));
    expect(out.text).toContain("[credential github/token]");
  });

  it("lists every real value of a credential", () => {
    expect(credentialValues({ value: "abcdefgh", aws: { accessKeyId: "AKIAEXAMPLE", secretAccessKey: "secretsecret" } } as never)).toEqual(["abcdefgh", "AKIAEXAMPLE", "secretsecret"]);
    expect(credentialValues(undefined)).toEqual([]);
  });
});
