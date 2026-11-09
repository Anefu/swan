import { describe, expect, it } from "vitest";
import { systemBlocks, systemText } from "./providers.js";

describe("the system prompt sent to Anthropic", () => {
  it("has a cache point after each part", () => {
    expect(systemBlocks(["fixed", "per context"])).toEqual([
      { type: "text", text: "fixed", cache_control: { type: "ephemeral" } },
      { type: "text", text: "per context", cache_control: { type: "ephemeral" } },
    ]);
    expect(systemBlocks("one text")).toEqual([{ type: "text", text: "one text", cache_control: { type: "ephemeral" } }]);
  });

  it("uses at most 3 cache points, leaving one for the conversation", () => {
    expect(systemBlocks(["a", "b", "c", "d", ""]).map((b) => b.text)).toEqual(["a\n\nb", "c", "d"]);
  });

  it("is one text for providers without prompt caching", () => {
    expect(systemText(["a", "b"])).toBe("a\n\nb");
    expect(systemText("a")).toBe("a");
  });
});
