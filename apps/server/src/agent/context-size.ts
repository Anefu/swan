import type { ContentBlockParam, MessageParam } from "./providers.js";

/** Characters an image stands for: models bill an image as roughly 1,600 tokens, whatever its base64 size. */
export const IMAGE_CHARS = 1_600 * 3.5;

function blockChars(b: ContentBlockParam | string): number {
  if (typeof b === "string") return b.length;
  switch (b.type) {
    case "text":
      return b.text.length;
    case "image":
      return IMAGE_CHARS;
    case "tool_use":
      return b.name.length + JSON.stringify(b.input ?? {}).length;
    case "tool_result":
      return typeof b.content === "string" ? b.content.length : (b.content ?? []).reduce((n, c) => n + blockChars(c as ContentBlockParam), 0);
    case "thinking":
      return b.thinking.length;
    case "redacted_thinking":
      return 0;
    default: {
      // Documents and other block kinds: their JSON is a fair upper bound.
      return JSON.stringify(b).length;
    }
  }
}

/** Characters of model-visible content in messages, with images at their token cost rather than their base64 length. */
export function messageChars(messages: MessageParam[]): number {
  let n = 0;
  for (const m of messages) n += typeof m.content === "string" ? m.content.length : (m.content ?? []).reduce((s, b) => s + blockChars(b), 0);
  return n;
}

/**
 * Whether a provider rejected a request because its input is longer than the model's context.
 * Matches the wording of Anthropic ("prompt is too long: 205000 tokens > 200000 maximum"),
 * OpenAI-style servers ("maximum context length is 128000 tokens") and Copilot ("exceeds the limit",
 * and the Copilot SDK's own check before sending: "Request exceeds the model's prompt budget after
 * reserving output (130500 tokens; limit 128000)").
 */
export function isContextOverflow(err: unknown): boolean {
  const msg = err instanceof Error ? err.message : String(err);
  return /prompt is too long|input is too long|context[ _-]?(length|window)|maximum context|too many (input )?tokens|token limit|exceeds? the (context|limit|max)|max_prompt_tokens|prompt budget|request_too_large|request too large/i.test(msg);
}

/** The model's prompt limit in tokens, when an overflow error says it. */
export function overflowLimit(err: unknown): number | undefined {
  const msg = err instanceof Error ? err.message : String(err);
  const m =
    /\blimit(?: of|:)?\s*([\d,]+)/i.exec(msg) ?? // Copilot: "(130500 tokens; limit 128000)", "exceeds the limit of 200000"
    /([\d,]+) (?:tokens )?maximum/i.exec(msg) ?? // Anthropic: "205000 tokens > 200000 maximum"
    /maximum context length is ([\d,]+)/i.exec(msg); // OpenAI-style
  const n = m ? Number(m[1]!.replace(/,/g, "")) : NaN;
  return Number.isFinite(n) && n >= 1000 ? n : undefined;
}

/** Tokens a Copilot model takes as a prompt: its prompt limit, and no more than its window less its output. */
export function promptBudget(m: { maxPromptTokens?: number; maxOutputTokens?: number; maxContextWindowTokens?: number }): number | undefined {
  const limits = [m.maxPromptTokens, m.maxContextWindowTokens && m.maxOutputTokens ? m.maxContextWindowTokens - m.maxOutputTokens : m.maxContextWindowTokens];
  const known = limits.filter((n): n is number => typeof n === "number" && n > 0);
  return known.length ? Math.min(...known) : undefined;
}
