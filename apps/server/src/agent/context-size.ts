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
  for (const m of messages) n += typeof m.content === "string" ? m.content.length : m.content.reduce((s, b) => s + blockChars(b), 0);
  return n;
}

/**
 * Whether a provider rejected a request because its input is longer than the model's context.
 * Matches the wording of Anthropic ("prompt is too long: 205000 tokens > 200000 maximum"),
 * OpenAI-style servers ("maximum context length is 128000 tokens") and Copilot ("exceeds the limit").
 */
export function isContextOverflow(err: unknown): boolean {
  const msg = err instanceof Error ? err.message : String(err);
  return /prompt is too long|input is too long|context[ _-]?(length|window)|maximum context|too many (input )?tokens|token limit|exceeds? the (context|limit|max)|max_prompt_tokens|request_too_large|request too large/i.test(msg);
}
