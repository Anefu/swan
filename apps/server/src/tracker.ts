import { EventEmitter } from "node:events";
import path from "node:path";
import type { TrackerItem, TrackStatus } from "@ph/shared";
import { z } from "zod";
import { FileStore } from "./file-store.js";
import { paths } from "./settings.js";

export const TRACK_STATUSES = ["in_progress", "waiting", "done", "dropped"] as const;

const ItemSchema = z.object({
  url: z.string().url(),
  title: z.string(),
  kind: z.string(),
  status: z.enum(TRACK_STATUSES),
  note: z.string().optional(),
  created: z.string(),
  updated: z.string(),
  itemId: z.string().optional(),
  history: z.array(z.object({ at: z.string(), status: z.enum(TRACK_STATUSES), by: z.enum(["agent", "user"]) })).default([]),
});
const FileSchema = z.object({ items: z.array(ItemSchema).default([]) });

export interface TrackInput {
  url: string;
  title?: string;
  kind?: string;
  status?: TrackStatus;
  note?: string;
  itemId?: string;
}

/** Each persona's tracked work items, in ~/.swan/tracker/<persona>.yaml. Emits "changed" (personaId). */
export class TrackerStore extends EventEmitter {
  private store = new FileStore({ name: "tracker", dir: () => path.join(paths.home, "tracker"), format: "yaml", schema: FileSchema, empty: () => ({ items: [] }), mode: 0o644 });

  async list(personaId: string): Promise<TrackerItem[]> {
    return (await this.store.get(personaId)).items;
  }

  /** Changes run one at a time per persona, each reading the latest list. */
  private async change<T>(personaId: string, fn: (items: TrackerItem[]) => T): Promise<T> {
    const out = await this.store.change(personaId, (f) => fn(f.items));
    this.emit("changed", personaId);
    return out;
  }

  /** Add an item, or update the one with the same URL. */
  track(personaId: string, i: TrackInput, by: "agent" | "user"): Promise<{ item: TrackerItem; added: boolean }> {
    const url = new URL(i.url).toString();
    return this.change(personaId, (items) => {
      const now = new Date().toISOString();
      const at = items.findIndex((x) => x.url === url);
      if (at < 0) {
        const status = i.status ?? "in_progress";
        const item: TrackerItem = {
          url,
          title: i.title?.trim() || url,
          kind: i.kind?.trim().toLowerCase() || "item",
          status,
          ...(i.note ? { note: i.note } : {}),
          created: now,
          updated: now,
          ...(i.itemId ? { itemId: i.itemId } : {}),
          history: [{ at: now, status, by }],
        };
        items.unshift(item);
        return { item, added: true };
      }
      const old = items[at]!;
      const item: TrackerItem = {
        ...old,
        ...(i.title?.trim() ? { title: i.title.trim() } : {}),
        ...(i.kind?.trim() ? { kind: i.kind.trim().toLowerCase() } : {}),
        ...(i.note !== undefined ? { note: i.note } : {}),
        ...(i.status ? { status: i.status } : {}),
        updated: now,
        history: i.status && i.status !== old.status ? [...old.history, { at: now, status: i.status, by }].slice(-50) : old.history,
      };
      items[at] = item;
      return { item, added: false };
    });
  }

  remove(personaId: string, url: string): Promise<boolean> {
    return this.change(personaId, (items) => {
      const at = items.findIndex((x) => x.url === url);
      if (at >= 0) items.splice(at, 1);
      return at >= 0;
    });
  }

  removePersona(personaId: string) {
    return this.store.remove(personaId);
  }
}
