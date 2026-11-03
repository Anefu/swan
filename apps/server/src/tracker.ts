import { EventEmitter } from "node:events";
import { promises as fs } from "node:fs";
import path from "node:path";
import type { TrackerItem, TrackStatus } from "@ph/shared";
import YAML from "yaml";
import { z } from "zod";
import { paths } from "./settings.js";
import { errMsg, log, writeFileAtomic } from "./util.js";

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
  private cache = new Map<string, TrackerItem[]>();
  private chain = new Map<string, Promise<unknown>>();

  private file(personaId: string) {
    return path.join(paths.home, "tracker", `${personaId}.yaml`);
  }

  async list(personaId: string): Promise<TrackerItem[]> {
    const hit = this.cache.get(personaId);
    if (hit) return hit;
    let items: TrackerItem[] = [];
    try {
      const r = FileSchema.safeParse(YAML.parse(await fs.readFile(this.file(personaId), "utf8")) ?? {});
      if (r.success) items = r.data.items;
      else log.warn("tracker", `${personaId}: ${r.error.issues[0]?.path.join(".")} ${r.error.issues[0]?.message}; starting empty`);
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== "ENOENT") log.warn("tracker", `${personaId}: ${errMsg(e)}`);
    }
    this.cache.set(personaId, items);
    return items;
  }

  /** Changes run one at a time per persona, each reading the latest list. */
  private change<T>(personaId: string, fn: (items: TrackerItem[]) => T): Promise<T> {
    const run = (this.chain.get(personaId) ?? Promise.resolve()).then(async () => {
      const items = [...(await this.list(personaId))];
      const out = fn(items);
      this.cache.set(personaId, items);
      await fs.mkdir(path.dirname(this.file(personaId)), { recursive: true });
      await writeFileAtomic(this.file(personaId), YAML.stringify({ items }), 0o644);
      this.emit("changed", personaId);
      return out;
    });
    this.chain.set(personaId, run.catch(() => {}));
    return run;
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

  async removePersona(personaId: string) {
    this.cache.delete(personaId);
    await fs.rm(this.file(personaId), { force: true });
  }
}
