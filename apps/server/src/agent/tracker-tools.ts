import { z } from "zod";
import { TRACK_STATUSES, type TrackerStore } from "../tracker.js";
import { zodTool, type ToolDef } from "./tools.js";

/** Tracker tools run without asking: they only change the persona's own list. */
export const TRACKER_TOOLS = new Set(["track", "tracker_list"]);

export function trackerTools(o: { tracker: TrackerStore; personaId: string }): ToolDef[] {
  const { tracker, personaId } = o;
  return [
    zodTool({
      name: "track",
      description: [
        "Add a work item to this persona's tracker, or update it: merge requests, tickets, docs, deploys you create or are asked to follow.",
        "The URL identifies the item; calling again with the same URL updates it. Keep statuses current:",
        "in_progress (being worked on), waiting (on a review or someone else), done, dropped. The note is one line on where it stands.",
      ].join(" "),
      schema: z.object({
        url: z.string().url(),
        title: z.string().max(200).optional().describe("Short title; required when adding"),
        kind: z.string().max(30).optional().describe("mr, ticket, doc, deploy, or another word"),
        status: z.enum(TRACK_STATUSES).optional(),
        note: z.string().max(300).optional(),
      }),
      preview: (i) => `${i.title ?? i.url}${i.status ? ` · ${i.status.replace("_", " ")}` : ""}`,
      primaryArg: (i) => i.url,
      async run(i, ctx) {
        const { item, added } = await tracker.track(personaId, { ...i, itemId: ctx.toolUseId }, "agent");
        return {
          text: `${added ? "Tracking" : "Updated"} ${item.title} (${item.kind}, ${item.status.replace("_", " ")}).`,
          itemPatch: { inputPreview: `${item.title} · ${item.status.replace("_", " ")}` },
        };
      },
    }),
    zodTool({
      name: "tracker_list",
      description: "List this persona's tracked work items. By default the open ones (in progress and waiting).",
      schema: z.object({ all: z.boolean().optional().describe("Include done and dropped items") }),
      preview: (i) => (i.all ? "all items" : "open items"),
      async run(i) {
        const items = (await tracker.list(personaId)).filter((x) => i.all || x.status === "in_progress" || x.status === "waiting");
        if (!items.length) return { text: "No tracked items." };
        return { text: items.map((x) => `- [${x.status}] ${x.kind}: ${x.title} <${x.url}>${x.note ? ` (${x.note})` : ""} · updated ${x.updated.slice(0, 16)}`).join("\n") };
      },
    }),
  ];
}
