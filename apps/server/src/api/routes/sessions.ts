// Conversations: messages, approvals, attachments, diffs, sub-agents and allowances.
import type { ApprovalBody } from "@ph/shared";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { AnswerSchema } from "../../agent/ask-user.js";
import { personaOf, runnable, underSession, type ApiDeps } from "../deps.js";
import { bodyOf, type Req } from "../http.js";

const Approval = z.object({
  decision: z.enum(["allow", "allow_session", "allow_always", "deny"], "must be allow, allow_session, allow_always or deny"),
  reason: z.string().optional(),
  answer: AnswerSchema.optional(),
}) satisfies z.ZodType<ApprovalBody>;

export function sessionRoutes(app: FastifyInstance, d: ApiDeps) {
  app.get("/api/sessions", async (req: Req<never, unknown, { personaId?: string }>) => d.sessions.list(req.query.personaId));
  app.post("/api/sessions", async (req) => {
    const b = bodyOf(req, z.object({ personaId: z.string().default(""), title: z.string().optional() }));
    return d.sessions.create(runnable(personaOf(d, b.personaId)).id, b.title).summary;
  });

  underSession(app, d, (s) => {
    s.get("", async (req) => ({ session: req.session.summary, items: req.session.items }));
    s.patch("", async (req) => {
      const { title } = bodyOf(req, z.object({ title: z.string().transform((t) => t.replace(/\s+/g, " ").trim()).pipe(z.string().min(1, "must be 1 to 120 characters").max(120, "must be 1 to 120 characters")) }));
      req.session.rename(title);
      return req.session.summary;
    });
    s.delete("", async (req) => {
      await d.sessions.remove(req.session.id);
      return { ok: true };
    });
    s.post("/fork", async (req) => (await d.sessions.fork(req.session.id)).summary);
    s.post("/stop", async (req) => {
      await req.session.stop();
      return req.session.summary;
    });

    s.post("/messages", async (req: Req<{ id: string }, { text?: unknown; attachments?: unknown }>) => {
      const b = req.body;
      await req.session.sendMessage(String(b?.text ?? ""), Array.isArray(b?.attachments) ? b.attachments.map(String) : []);
      return { ok: true };
    });
    s.post("/interrupt", async (req) => {
      req.session.interrupt();
      return { ok: true };
    });
    s.post("/approvals/:toolUseId", async (req: Req<{ id: string; toolUseId: string }>) => {
      req.session.approve(req.params.toolUseId, bodyOf(req, Approval));
      return { ok: true };
    });
    s.post("/agents/:agentId/stop", async (req: Req<{ id: string; agentId: string }>) => {
      req.session.stopAgents(req.params.agentId === "all" ? undefined : req.params.agentId);
      return { ok: true };
    });
    s.get("/tools", async (req) => req.session.tools());
    s.delete("/allowances", async (req) => {
      req.session.resetAllowances();
      return req.session.summary;
    });
    s.delete("/allowances/:rule", async (req: Req<{ id: string; rule: string }>) => {
      req.session.removeAllowance(decodeURIComponent(req.params.rule));
      return req.session.summary;
    });

    s.get("/diffs", async (req) => d.diffs.list(req.session.id));
    s.get("/diffs/:diffId", async (req: Req<{ id: string; diffId: string }>, reply) => {
      const view = await d.diffs.get(req.session.id, req.params.diffId);
      if (!view) return reply.code(404).send({ error: "That diff is gone." });
      return view;
    });

    s.post("/attachments", async (req: Req<{ id: string }, { name: string; mediaType: string; data: string }>) => d.attachments.save(req.session.id, req.body ?? ({} as never)));
    s.get("/attachments/:attId/file", async (req: Req<{ id: string; attId: string }>, reply) => {
      const { meta, data } = await d.attachments.get(req.session.id, req.params.attId);
      // Only images and PDFs render inline; anything else (HTML, SVG, scripts) downloads, so an
      // uploaded file can never run inside Swan's own origin.
      const inline = meta.kind === "image" || meta.kind === "pdf";
      return reply
        .header("content-type", inline ? meta.mediaType : "application/octet-stream")
        .header("content-disposition", `${inline ? "inline" : "attachment"}; filename="${meta.name.replace(/"/g, "")}"`)
        .header("x-content-type-options", "nosniff")
        .header("content-security-policy", "default-src 'none'; img-src 'self' data:; style-src 'unsafe-inline'; sandbox")
        .header("cache-control", "private, max-age=3600")
        .send(data);
    });
  });
}
