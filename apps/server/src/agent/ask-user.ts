import { z } from "zod";
import { zodTool, type ToolDef } from "./tools.js";

export const ASK_USER = "ask_user";

const InputSchema = z.object({
  question: z.string().min(1).max(500).describe("One clear question"),
  options: z
    .array(z.object({ label: z.string().min(1).max(80), description: z.string().max(200).optional().describe("What choosing it means") }))
    .min(2)
    .max(8),
  multiple: z.boolean().optional().describe("The user may choose several"),
});
export type AskInput = z.infer<typeof InputSchema>;

/** What the card sends back; checked at the API. */
export const AnswerSchema = z.object({ selected: z.array(z.string().max(200)).max(8).default([]), other: z.string().max(4000).optional() });

/** The session runs this tool itself, since it pauses the turn; this `run` is only reached if it can't. */
export function askUserTool(): ToolDef {
  return zodTool({
    name: ASK_USER,
    defaultAllow: { rule: "question" },
    description: [
      "Show the user a card with options and wait for their answer. Use it when you need them to choose before you can go on, instead of asking in text.",
      "They can pick an option, type something else, or skip. Don't use it for what you can decide yourself, or for approval of a tool call: those cards appear by themselves.",
    ].join(" "),
    schema: InputSchema,
    preview: (i) => i.question,
    run: async () => ({ text: "The user can't be asked from here.", isError: true }),
  });
}

/** The tool result and the short answer shown on the card's line. Only offered options count, however the answer was sent. */
export function questionResult(input: AskInput, answer: { selected?: string[]; other?: string } | undefined): { text: string; answer: string } {
  const offered = input.options.map((o) => o.label);
  const chosen = (answer?.selected ?? []).filter((s) => offered.includes(s));
  const selected = input.multiple ? [...new Set(chosen)] : chosen.slice(0, 1);
  const other = answer?.other?.trim().slice(0, 4000);
  if (!selected.length && !other) return { text: "The user skipped the question. Decide what you reasonably can, and say what you assumed.", answer: "Skipped" };
  const parts = [selected.length ? `The user chose: ${selected.join(", ")}.` : "", other ? `The user answered in their own words: ${other}` : ""];
  return { text: parts.filter(Boolean).join(" "), answer: [...selected, ...(other ? [other] : [])].join(", ") };
}
