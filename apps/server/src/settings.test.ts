import { describe, expect, it } from "vitest";
import { contextLimit, type Settings } from "./settings.js";

describe("contextLimit", () => {
  it("uses the model's own context window, else the configured default", () => {
    const s = {
      contextLimitTokens: 200_000,
      providers: { or: { type: "openai", models: { "glm-5": { contextTokens: 128_000 } } } },
    } as unknown as Settings;
    expect(contextLimit(s, "or", "glm-5")).toBe(128_000);
    expect(contextLimit(s, "or", "other")).toBe(200_000);
    expect(contextLimit(s, "missing", "glm-5")).toBe(200_000);
  });
});
