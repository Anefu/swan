import { describe, expect, it } from "vitest";
import { estimateCost } from "./usage.js";

describe("estimateCost", () => {
  it("prices known Anthropic models and refuses to guess for others", () => {
    const base = { inputTokens: 1_000_000, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 };
    expect(estimateCost({ ...base, providerType: "anthropic", model: "claude-opus-5-5" })).toBe(4);
    expect(estimateCost({ ...base, providerType: "anthropic", model: "unknown-model" })).toBeNull();
    expect(estimateCost({ ...base, providerType: "openai", model: "claude-opus-5-5" })).toBeNull();
  });

  it("uses a price from config.yaml for any provider, defaulting cached rates to the input rate", () => {
    const base = { inputTokens: 1_000_000, outputTokens: 1_000_000, cacheReadTokens: 1_000_000, cacheWriteTokens: 0 };
    expect(estimateCost({ ...base, providerType: "openai", model: "z-ai/glm" }, { input: 0.5, output: 2 })).toBe(3);
    expect(estimateCost({ ...base, providerType: "openai", model: "z-ai/glm" }, { input: 0.5, output: 2, cacheRead: 0.1 })).toBeCloseTo(2.6);
    expect(estimateCost({ ...base, providerType: "anthropic", model: "claude-opus-5-5" }, { input: 1, output: 1, cacheRead: 1 })).toBe(3);
  });
});
