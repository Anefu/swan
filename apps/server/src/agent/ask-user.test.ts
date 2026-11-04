import { describe, expect, it } from "vitest";
import { AnswerSchema, askUserTool, questionResult } from "./ask-user.js";

const input = { question: "Which region?", options: [{ label: "eu-west-1" }, { label: "us-east-1" }, { label: "both" }] };

describe("ask_user", () => {
  it("needs a question and at least two options", () => {
    const t = askUserTool();
    expect(t.validate(input).ok).toBe(true);
    expect(t.validate({ question: "Sure?", options: [{ label: "yes" }] }).ok).toBe(false);
    expect(t.validate({ options: input.options }).ok).toBe(false);
  });

  it("reports the option chosen, and only one unless several are allowed", () => {
    expect(questionResult(input, { selected: ["us-east-1", "both"] })).toEqual({ text: "The user chose: us-east-1.", answer: "us-east-1" });
    expect(questionResult({ ...input, multiple: true }, { selected: ["both", "eu-west-1", "both"] }).answer).toBe("both, eu-west-1");
  });

  it("ignores options that weren't offered, and takes the user's own words", () => {
    expect(questionResult(input, { selected: ["ap-south-1"] }).answer).toBe("Skipped");
    expect(questionResult(input, { selected: [], other: "  ask infra  " })).toEqual({ text: "The user answered in their own words: ask infra", answer: "ask infra" });
    expect(questionResult(input, undefined).text).toMatch(/skipped/);
  });

  it("refuses a malformed answer at the API", () => {
    expect(AnswerSchema.safeParse({ selected: "both" }).success).toBe(false);
    expect(AnswerSchema.safeParse({ other: 3 }).success).toBe(false);
    expect(AnswerSchema.parse({ other: "x" })).toEqual({ selected: [], other: "x" });
  });
});
