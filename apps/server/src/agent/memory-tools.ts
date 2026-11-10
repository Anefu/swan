import type { ChatItem } from "@ph/shared";
import { z } from "zod";
import { MEMORY_TYPES, type MemoryStore } from "../memory.js";
import { truncateMiddle } from "../util.js";
import { zodTool, type ToolDef } from "./tools.js";

/** Read-only memory/history tools run without asking unless the persona denies them. */

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
      defaultAllow: { rule: "memory read" },
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
      defaultAllow: { rule: "memory read" },
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
      defaultAllow: { rule: "memory read" },
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
      defaultAllow: { rule: "memory read" },
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
        "Save something to this persona's memory: what would help a later conversation, or this one after its context rolls over, and can't simply be read again from files or tools. Cite the event ids it comes from. Origin 'user' is for what the user said, 'observation' for what tools showed, 'inference' for your own conclusions, which stay tentative. If a saved memory already covers it, use memory_update instead.",
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
    zodTool({
      name: "memory_update",
      description:
        "Correct one of this persona's saved memories when you learn it is wrong, out of date or incomplete, rather than saving a second one that contradicts it. Give the whole new text, the event ids it now rests on, and its origin as for memory_propose.",
      schema: z.object({
        id: z.string().min(1),
        content: z.string().min(1).max(2000),
        origin: z.enum(["user", "observation", "inference"]),
        sources: z.array(z.string()).max(20),
        reason: z.string().max(300).optional().describe("What changed, in a few words"),
      }),
      preview: (i) => `${i.id}: ${i.content.slice(0, 80)}`,
      primaryArg: (i) => i.id,
      async run(i) {
        const r = await memory.get(personaId, i.id);
        if (!r || (r.status !== "active" && r.status !== "tentative")) return { text: "No such memory.", isError: true };
        const rec = await memory.revise(personaId, i.id, { content: i.content, origin: i.origin, sources: i.sources, reason: i.reason }, "agent");
        return { text: `Updated ${rec.id} (version ${rec.version}, ${rec.status}).` };
      },
    }),
    zodTool({
      name: "memory_archive",
      description:
        "Retire one of this persona's saved memories that no longer matters or turned out to be wrong. It leaves memory search and the brief; the user can restore it. Memories the user stated, and pinned ones, can't be archived this way: update a user's memory with what they say now.",
      schema: z.object({ id: z.string().min(1), reason: z.string().min(1).max(300) }),
      preview: (i) => `${i.id}: ${i.reason.slice(0, 80)}`,
      primaryArg: (i) => i.id,
      async run(i) {
        const r = await memory.get(personaId, i.id);
        if (!r || (r.status !== "active" && r.status !== "tentative")) return { text: "No such memory.", isError: true };
        if (r.pinned) return { text: "That memory is pinned by the user; ask them before retiring it.", isError: true };
        if (r.origin === "user") return { text: "That memory is something the user said. Update it with memory_update to what they say now, or ask them to archive it.", isError: true };
        await memory.act(personaId, i.id, "archive", "agent", i.reason);
        return { text: `Archived ${i.id}.` };
      },
    }),
  ];
}
