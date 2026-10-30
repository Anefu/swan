import { describe, expect, it } from "vitest";
import { hostMatches, hostMatchesAny, truncateMiddle, wildcardMatch } from "./util.js";

describe("hostMatches", () => {
  it("matches exact hosts case-insensitively, ignoring a trailing dot", () => {
    expect(hostMatches("API.GitHub.com.", "api.github.com")).toBe(true);
    expect(hostMatches("api.github.com.evil.io", "api.github.com")).toBe(false);
  });
  it("treats *.domain as subdomains only, never the apex or a suffix trick", () => {
    expect(hostMatches("raw.githubusercontent.com", "*.githubusercontent.com")).toBe(true);
    expect(hostMatches("a.b.githubusercontent.com", "*.githubusercontent.com")).toBe(true);
    expect(hostMatches("githubusercontent.com", "*.githubusercontent.com")).toBe(false);
    expect(hostMatches("evilgithubusercontent.com", "*.githubusercontent.com")).toBe(false);
  });
  it("never lets a bare * match", () => {
    expect(hostMatches("example.com", "*")).toBe(false);
    expect(hostMatchesAny("example.com", ["*", "other.com"])).toBe(false);
  });
});

describe("wildcardMatch", () => {
  it("anchors and escapes everything but *", () => {
    expect(wildcardMatch("mcp__github__get_issue", "mcp__github__get_*")).toBe(true);
    expect(wildcardMatch("xmcp__github__get_issue", "mcp__github__get_*")).toBe(false);
    expect(wildcardMatch("a.b", "a?b")).toBe(false);
    expect(wildcardMatch("git status --short", "git status*")).toBe(true);
  });
});

describe("truncateMiddle", () => {
  it("keeps short strings and marks what was cut", () => {
    expect(truncateMiddle("short", 100)).toBe("short");
    const out = truncateMiddle("a".repeat(500) + "b".repeat(500), 200);
    expect(out.startsWith("a")).toBe(true);
    expect(out.endsWith("b")).toBe(true);
    expect(out).toMatch(/characters truncated/);
  });
});
