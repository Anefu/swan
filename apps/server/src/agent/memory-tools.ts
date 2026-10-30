import type { ChatItem } from "@ph/shared";
import { z } from "zod";
import { MEMORY_TYPES, type MemoryStore } from "../memory.js";
import { truncateMiddle } from "../util.js";
import { zodTool, type ToolDef } from "./tools.js";

/** Read-only memory/history tools run without asking unless the persona denies them. */
export const MEMORY_READ_TOOLS = new Set(["memory_search", "memory_read", "history_search", "history_read"]);

const itemText = (it: ChatItem): string => {
  switch (it.kind) {
    case "user":
      return `User: ${it.text}`;
    case "assistant_text":
      return `Assistant: ${it.text}`;
    case "tool_call":
      return `Tool ${it.name} (${it.status}): ${it.inputPreview}${it.output ? `\n${truncateMiddle(it.output, 1500)}` : ""}`;
    case "notice":
      return `Notice: ${it.text}`;
    case "receipt":
      return `${it.title}: ${it.detail}`;
    default:
      return "";
  }
};

/**
 * Host-side tools over the persona's memory and this conversation's history. The persona comes
 * from the session, never from tool input, and no host path or query language is exposed.
 */
export function memoryTools(o: { memory: MemoryStore; personaId: string; items: () => ChatItem[] }): ToolDef[] {
  const { memory, personaId } = o;
  return [
    zodTool({
      name: "memory_search",
      description: "Search this persona's saved memories (preferences, decisions, observations, procedures, episodes). Use before asking the user something they may have told you before.",
      schema: z.object({ query: z.string().min(1), type: z.enum(MEMORY_TYPES as [string, ...string[]]).optional(), limit: z.number().int().min(1).max(20).optional() }),
      preview: (i) => i.query,
      primaryArg: (i) => i.query,
      async run(i) {
        const recs = await memory.search(personaId, i.query, i.type, i.limit ?? 8);
        if (!recs.length) return { text: "No matching memories." };
        return { text: recs.map((r) => `[${r.id}] ${r.type}${r.status === "tentative" ? " (tentative)" : ""}${r.pinned ? " (pinned)" : ""}: ${truncateMiddle(r.content, 600)}`).join("\n") };
      },
    }),
    zodTool({
      name: "memory_read",
      description: "Read one saved memory with its provenance (origin, sources, version, dates).",
      schema: z.object({ id: z.string().min(1) }),
      preview: (i) => i.id,
      primaryArg: (i) => i.id,
      async run(i) {
        const r = await memory.get(personaId, i.id);
        if (!r || r.status === "forgotten") return { text: "No such memory.", isError: true };
        return { text: JSON.stringify({ ...r }, null, 2) };
      },
    }),
    zodTool({
      name: "history_search",
      description: "Search the full history of this conversation, including turns that are no longer in your context. Returns matching events with their ids.",
      schema: z.object({ query: z.string().min(1), limit: z.number().int().min(1).max(20).optional() }),
      preview: (i) => i.query,
      primaryArg: (i) => i.query,
      async run(i) {
        const terms = i.query.toLowerCase().split(/\s+/).filter(Boolean);
        const hits = o
          .items()
          .map((it) => ({ it, text: itemText(it) }))
          .filter((x) => x.text && terms.every((t) => x.text.toLowerCase().includes(t)))
          .slice(-(i.limit ?? 10));
        if (!hits.length) return { text: "No matching events." };
        return { text: hits.map((h) => `[${h.it.id} · ${h.it.ts}] ${truncateMiddle(h.text, 400)}`).join("\n") };
      },
    }),
    zodTool({
      name: "history_read",
      description: "Read an event from this conversation's history by id, with surrounding events.",
      schema: z.object({ event_id: z.string().min(1), surrounding: z.number().int().min(0).max(10).optional() }),
      preview: (i) => i.event_id,
      primaryArg: (i) => i.event_id,
      async run(i) {
        const items = o.items();
        const idx = items.findIndex((it) => it.id === i.event_id);
        if (idx < 0) return { text: "No such event.", isError: true };
        const n = i.surrounding ?? 2;
        return { text: items.slice(Math.max(0, idx - n), idx + n + 1).map((it) => `[${it.id} · ${it.ts}] ${itemText(it)}`).join("\n\n") };
      },
    }),
    zodTool({
      name: "memory_propose",
      description:
        "Save a durable memory for this persona: a user preference they stated, a project decision with its rationale, an observed fact, or a procedure that worked. Cite the event ids it comes from. Use origin 'user' only for things the user said; your own guesses must use 'inference' and stay tentative.",
      schema: z.object({
        content: z.string().min(1).max(2000),
        type: z.enum(MEMORY_TYPES as [string, ...string[]]),
        origin: z.enum(["user", "observation", "inference"]),
        sources: z.array(z.string()).max(20),
      }),
      preview: (i) => `${i.type}: ${i.content.slice(0, 80)}`,
      primaryArg: (i) => i.type,
      async run(i) {
        const rec = await memory.add(personaId, { content: i.content, type: i.type as never, origin: i.origin, sources: i.sources, by: "agent" });
        return { text: `Saved ${rec.id} (${rec.status}).` };
      },
    }),
  ];
}
