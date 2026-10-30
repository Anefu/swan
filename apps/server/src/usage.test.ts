import { describe, expect, it } from "vitest";
import { estimateCost } from "./usage.js";

describe("estimateCost", () => {
  it("prices known Anthropic models and refuses to guess for others", () => {
    const base = { inputTokens: 1_000_000, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 };
    expect(estimateCost({ ...base, providerType: "anthropic", model: "claude-opus-5-5" })).toBe(4);
    expect(estimateCost({ ...base, providerType: "anthropic", model: "unknown-model" })).toBeNull();
    expect(estimateCost({ ...base, providerType: "openai", model: "claude-opus-5-5" })).toBeNull();
  });
});
