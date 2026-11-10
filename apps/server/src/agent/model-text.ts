// Text for the model calls outside the conversation (checkpoints, /dream): events in, JSON out.
import type { ChatItem } from "@ph/shared";
import { truncateMiddle } from "../util.js";

/** One event as a line the model can cite by id; empty for events it has no use for. */
export function itemLine(it: ChatItem): string {
  switch (it.kind) {
    case "user":
      return `[${it.id}] User: ${it.text}${it.attachments?.length ? ` [attached: ${it.attachments.map((a) => a.name).join(", ")}]` : ""}`;
    case "assistant_text":
      return `[${it.id}] Assistant: ${it.text}`;
    case "tool_call":
      return `[${it.id}] Tool ${it.name} → ${it.status}: ${it.inputPreview}${it.output ? `\n${truncateMiddle(it.output, 1200)}` : ""}`;
    case "receipt":
      return `[${it.id}] ${it.title}: ${it.detail}`;
    default:
      return "";
  }
}

/** The first JSON object in a model reply. */
export function parseJson(text: string): Record<string, unknown> | null {
  const a = text.indexOf("{");
  const b = text.lastIndexOf("}");
  if (a < 0 || b <= a) return null;
  try {
    return JSON.parse(text.slice(a, b + 1));
  } catch {
    return null;
  }
}

/** The strings of a model-proposed list. */
export const strs = (v: unknown): string[] => (Array.isArray(v) ? v.filter((x): x is string => typeof x === "string").slice(0, 40) : []);

/** The objects of a model-proposed list. */
export const objs = (v: unknown): Record<string, unknown>[] => (Array.isArray(v) ? v.filter((x): x is Record<string, unknown> => !!x && typeof x === "object" && !Array.isArray(x)) : []);
