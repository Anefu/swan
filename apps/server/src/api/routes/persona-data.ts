// What a persona keeps: its memory, checkpoints, tracked items, and schedules and watchers.
import type { MemoryType } from "@ph/shared";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { TRACK_STATUSES } from "../../tracker.js";
import { underPersona, type ApiDeps } from "../deps.js";
import { HttpError, bodyOf, type Req } from "../http.js";

const MEMORY_ACTIONS = ["pin", "unpin", "archive", "forget"] as const;

export function personaDataRoutes(app: FastifyInstance, d: ApiDeps) {
  underPersona(app, d, (p) => {
    p.get("/memory", async (req: Req<{ id: string }, unknown, { query?: string; type?: string; status?: string }>) => d.memory.list(req.persona.id, req.query));
    p.post("/memory", async (req: Req<{ id: string }, { content?: string; type?: MemoryType; pinned?: boolean }>) =>
      d.memory.add(req.persona.id, { content: req.body?.content ?? "", type: req.body?.type as MemoryType, origin: "user", sources: ["user"], pinned: req.body?.pinned, by: "user" }),
    );
    p.put("/memory/:recordId", async (req: Req<{ id: string; recordId: string }, { content?: string; type?: MemoryType }>) => d.memory.edit(req.persona.id, req.params.recordId, req.body ?? {}));
    p.post("/memory/:recordId/:action", async (req: Req<{ id: string; recordId: string; action: string }>) => {
      const a = req.params.action;
      if (!(MEMORY_ACTIONS as readonly string[]).includes(a)) throw new HttpError(400, "action must be pin, unpin, archive or forget");
      return d.memory.act(req.persona.id, req.params.recordId, a as (typeof MEMORY_ACTIONS)[number]);
    });
    p.get("/memory-history", async (req) => d.memory.history(req.persona.id));
    p.get("/checkpoint", async (req: Req<{ id: string }, unknown, { sessionId?: string }>) => {
      const sid = req.query.sessionId;
      if (!sid) return d.memory.latestCheckpoint(req.persona.id);
      const own = new Set((d.sessions.get(sid)?.items ?? []).map((it) => it.id));
      return d.memory.latestCheckpoint(req.persona.id, sid, (id) => own.has(id));
    });

    p.get("/tracker", async (req) => d.tracker.list(req.persona.id));
    p.post("/tracker", async (req) => {
      const b = bodyOf(
        req,
        z.object({
          url: z.url("enter the item's full URL, starting with https://"),
          title: z.string().optional(),
          kind: z.string().optional(),
          status: z.enum(TRACK_STATUSES).optional(),
          note: z.string().optional(),
        }),
      );
      return (await d.tracker.track(req.persona.id, b, "user")).item;
    });
    p.delete("/tracker", async (req: Req<{ id: string }, unknown, { url?: string }>) => ({ removed: await d.tracker.remove(req.persona.id, req.query.url ?? "") }));

    p.get("/triggers", async (req) => d.triggers.info(req.persona.id));
    p.post("/triggers/pause", async (req: Req<{ id: string }, { paused?: boolean }>) => {
      await d.triggers.setPaused(req.persona.id, !!req.body?.paused);
      return d.triggers.info(req.persona.id);
    });
    p.post("/triggers/:name/:action", async (req: Req<{ id: string; name: string; action: string }>) => {
      const { name, action } = req.params;
      const id = req.persona.id;
      if (action === "test") return d.triggers.test(id, name);
      if (action !== "run") throw new HttpError(404, `unknown action ${action}`);
      await d.triggers.runNow(id, name);
      return d.triggers.info(id);
    });
  });
}
