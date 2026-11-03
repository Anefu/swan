import { z } from "zod";
import type { PersonaStore } from "../personas.js";
import { zodTool, type ToolDef } from "./tools.js";

/** Reminders and schedules only start turns that run under the unattended rules: allowed by default. Watchers ask. */
export const SCHEDULE_TOOLS = new Set(["schedule"]);

const name = z.string().regex(/^[a-z0-9][a-z0-9-]{0,40}$/).describe("Lowercase letters, digits and dashes; unique in this persona");

export function triggerTools(o: { personas: PersonaStore; personaId: string }): ToolDef[] {
  const { personas, personaId } = o;
  const cfg = () => personas.get(personaId)?.config;
  return [
    zodTool({
      name: "schedule",
      description: [
        "Manage this persona's schedules: turns that start without the user, at a time you set. Use it for reminders",
        '("remind me at 17:00": once "YYYY-MM-DD 17:00", local time) and recurring checks (at "09:00" with days, or every "1h").',
        "The prompt is what you will be asked then; write it for yourself, with the context you'll need.",
        "Scheduled turns run unattended: anything that would need the user's approval is refused.",
        "action list shows them; add creates or replaces one by name (use a new name for a new reminder); remove deletes one.",
      ].join(" "),
      schema: z.object({
        action: z.enum(["list", "add", "remove"]),
        name: name.optional(),
        once: z.string().optional().describe('Local date and time, "YYYY-MM-DD HH:MM"'),
        at: z.string().optional().describe('"HH:MM", daily or on the given days'),
        days: z.array(z.enum(["mon", "tue", "wed", "thu", "fri", "sat", "sun"])).optional(),
        every: z.string().optional().describe('Interval such as "30m", "2h", "1d"'),
        prompt: z.string().optional(),
      }),
      preview: (i) => (i.action === "list" ? "list schedules" : `${i.action} ${i.name ?? ""}${i.once ? ` · ${i.once}` : i.at ? ` · ${i.at}` : i.every ? ` · every ${i.every}` : ""}`),
      primaryArg: (i) => i.name,
      async run(i) {
        if (i.action === "list") {
          const list = cfg()?.schedules ?? [];
          return { text: list.length ? list.map((s) => `- ${s.name}: ${s.once ? `once ${s.once}` : s.every ? `every ${s.every}` : `${s.at}${s.days?.length ? ` on ${s.days.join(",")}` : " daily"}`} · ${s.prompt}`).join("\n") : "No schedules." };
        }
        if (!i.name) return { text: "Give a name.", isError: true };
        try {
          if (i.action === "remove") {
            await personas.setTrigger(personaId, "schedules", i.name, null);
            return { text: `Removed schedule ${i.name}.` };
          }
          if (!i.prompt) return { text: "Give the prompt to run.", isError: true };
          const entry = { name: i.name, ...(i.once ? { once: i.once } : i.every ? { every: i.every } : { at: i.at, ...(i.days?.length ? { days: i.days } : {}) }), prompt: i.prompt };
          await personas.setTrigger(personaId, "schedules", i.name, entry);
          return { text: `Saved schedule ${i.name}. The user can see and change it in the persona's settings.` };
        } catch (e) {
          return { text: e instanceof Error ? e.message : String(e), isError: true };
        }
      },
    }),
    zodTool({
      name: "watch",
      description: [
        "Manage this persona's watchers: checks of an API, every interval, that start a turn when something new appears.",
        "get is a URL fetched from your sandbox with this persona's hosts and credentials ({{tracker.url}}, {{gitlabApi tracker.url}} and {{githubApi tracker.url}} work with for_each_tracked);",
        "items is the path to the list in the JSON response (\"\" for the top level), id the field identifying an item;",
        "prompt is what you will be asked, with {{item.<field>}} for the new item. The first check only records what is there.",
        "Watcher turns run unattended. action list, add (create or replace by name) or remove.",
      ].join(" "),
      schema: z.object({
        action: z.enum(["list", "add", "remove"]),
        name: name.optional(),
        every: z.string().optional().describe('At least "1m"'),
        get: z.string().optional(),
        for_each_tracked: z.string().optional().describe("Run once per open tracked item of this kind, e.g. mr"),
        items: z.string().optional(),
        id: z.string().optional(),
        changed: z.string().optional().describe("Field whose change makes an item new again"),
        prompt: z.string().optional(),
      }),
      preview: (i) => (i.action === "list" ? "list watchers" : `${i.action} ${i.name ?? ""}${i.get ? ` · ${i.get}` : ""}`),
      primaryArg: (i) => i.name,
      async run(i) {
        if (i.action === "list") {
          const list = cfg()?.watchers ?? [];
          return { text: list.length ? list.map((w) => `- ${w.name}: every ${w.every} · ${w.get ?? w.run?.join(" ")}${w.forEach ? ` · per tracked ${w.forEach.tracker.kind ?? "item"}` : ""}`).join("\n") : "No watchers." };
        }
        if (!i.name) return { text: "Give a name.", isError: true };
        try {
          if (i.action === "remove") {
            await personas.setTrigger(personaId, "watchers", i.name, null);
            return { text: `Removed watcher ${i.name}.` };
          }
          if (!i.get || !i.prompt || !i.every) return { text: "Give every, get and prompt.", isError: true };
          const entry = {
            name: i.name,
            every: i.every,
            get: i.get,
            ...(i.for_each_tracked ? { forEach: { tracker: { kind: i.for_each_tracked } } } : {}),
            items: i.items ?? "",
            id: i.id ?? "id",
            ...(i.changed ? { changed: i.changed } : {}),
            prompt: i.prompt,
          };
          await personas.setTrigger(personaId, "watchers", i.name, entry);
          return { text: `Saved watcher ${i.name}. The user can see, test and change it in the persona's settings.` };
        } catch (e) {
          return { text: e instanceof Error ? e.message : String(e), isError: true };
        }
      },
    }),
  ];
}
