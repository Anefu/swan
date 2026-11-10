// Personas: creating, editing, sharing and removing them, their settings, and what the app shows
// of a persona (its conversation, commands, tools, folders and attachments).
import { promises as fs, realpathSync } from "node:fs";
import path from "node:path";
import type { AttachmentMeta, FileEntry, PersonaConfigView, PersonaImportChoices } from "@ph/shared";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { PermissionPolicy } from "../../agent/permissions.js";
import { builtinTools, skillTool } from "../../agent/tools.js";
import { exportPersona, importPersona, previewImport } from "../../persona-share.js";
import { PERSONA_ID, type Persona } from "../../personas.js";
import { runnable, underPersona, type ApiDeps } from "../deps.js";
import { HttpError, bodyOf, type Req } from "../http.js";

const EFFORTS = ["low", "medium", "high", "xhigh", "max"] as const;

export function personaRoutes(app: FastifyInstance, d: ApiDeps) {
  app.get("/api/personas", async () => d.personas.list().map((p) => d.personas.summary(p)));
  app.post("/api/personas", async (req) => {
    const { id, yaml } = bodyOf(req, z.object({ id: z.string().regex(PERSONA_ID, "must be lowercase letters, digits and dashes"), yaml: z.string() }));
    return d.personas.summary(await d.personas.save(id, yaml, { create: true }));
  });
  // Sharing: a file with no secret values; importing is previewed, and saves only with the user's choices.
  app.post("/api/personas/import/preview", async (req: Req<never, { text?: string }>) => previewImport(d, req.body?.text ?? ""));
  app.post("/api/personas/import", async (req: Req<never, { text?: string; choices?: PersonaImportChoices }>) => {
    if (!req.body?.choices) throw new HttpError(400, "choices are required");
    return importPersona(d, req.body.text ?? "", req.body.choices);
  });

  underPersona(app, d, (p) => {
    p.get("/source", async (req) => ({ id: req.persona.id, yaml: req.persona.yaml }));
    p.put("/source", async (req: Req<{ id: string }, { yaml?: string }>) => d.personas.summary(await d.personas.save(req.persona.id, req.body?.yaml ?? "")));
    p.get("/export", async (req: Req<{ id: string }, unknown, { skills?: string }>, reply) => {
      const text = await exportPersona(d, req.persona.id, (req.query.skills ?? "").split(",").filter(Boolean));
      return reply
        .header("content-type", "application/octet-stream")
        .header("content-disposition", `attachment; filename="${req.persona.id}.swan-persona.yaml"`)
        .header("x-content-type-options", "nosniff")
        .header("content-security-policy", "default-src 'none'; sandbox")
        .send(text);
    });
    // What belongs to the persona goes with it (its conversations stop first); its folders are the user's.
    p.delete("", async (req) => {
      const id = req.persona.id;
      for (const s of d.sessions.list(id)) await d.sessions.remove(s.id);
      await d.memory.removePersona(id);
      await d.tracker.removePersona(id);
      await d.personas.remove(id);
      return { ok: true };
    });

    p.get("/config", async (req) => d.personas.configView(req.persona.id));
    p.put("/config", async (req: Req<{ id: string }, PersonaConfigView>) => d.personas.saveConfig(req.persona.id, req.body));
    p.put("/model", async (req) => d.personas.setModel(req.persona.id, bodyOf(req, z.object({ provider: z.string().min(1), id: z.string().min(1), effort: z.enum(EFFORTS).optional() }))));
    p.get("/tools", async (req) => {
      const cfg = req.persona.config;
      const policy = new PermissionPolicy(cfg?.permissions ?? { default: "ask", allow: [], ask: [], deny: [] }, []);
      return [...builtinTools(), ...(cfg?.skills.length ? [skillTool()] : [])].map((t) => ({ name: t.name, source: t.source, description: t.description, permission: policy.view(t) }));
    });

    // The conversation the app opens for a persona.
    p.get("/conversation", async (req) => {
      const s = d.sessions.conversation(runnable(req.persona).id);
      return { session: s.summary, items: s.items };
    });
    p.get("/commands", async (req) => d.sessions.conversation(req.persona.id).commands());
    p.get("/attachments", async (req) => {
      const out: (AttachmentMeta & { sessionId: string; itemId: string; ts: string })[] = [];
      for (const sum of d.sessions.list(req.persona.id))
        for (const it of d.sessions.get(sum.id)?.items ?? []) if (it.kind === "user" && it.attachments) for (const a of it.attachments) out.push({ ...a, sessionId: sum.id, itemId: it.id, ts: it.ts });
      return out.sort((a, b) => b.ts.localeCompare(a.ts));
    });

    p.get("/files", async (req: Req<{ id: string }, unknown, { path?: string }>) => {
      const { norm, host } = resolveSandboxPath(req.persona, req.query.path ?? "/workspace");
      if (!host) {
        const entries: FileEntry[] = req.persona.folders
          .filter((f) => path.posix.dirname(f.mountPath) === norm || (norm === "/workspace" && f.mountPath.startsWith("/workspace/")))
          .map((f) => ({ name: path.posix.basename(f.mountPath), path: f.mountPath, type: "dir" as const, size: 0 }));
        return { path: norm, entries };
      }
      const entries: FileEntry[] = [];
      for (const de of (await fs.readdir(host, { withFileTypes: true })).slice(0, 2000)) {
        if (de.name === ".git" || de.name === "node_modules" || de.name === ".DS_Store") continue;
        const st = await fs.stat(path.join(host, de.name)).catch(() => null);
        if (!st) continue;
        entries.push({ name: de.name, path: path.posix.join(norm, de.name), type: st.isDirectory() ? "dir" : "file", size: st.size });
      }
      entries.sort((a, b) => (a.type === b.type ? a.name.localeCompare(b.name) : a.type === "dir" ? -1 : 1));
      return { path: norm, entries };
    });
    p.get("/file", async (req: Req<{ id: string }, unknown, { path?: string }>) => {
      const { norm, host } = resolveSandboxPath(req.persona, req.query.path ?? "");
      if (!host) throw new HttpError(404, "not inside a mounted folder");
      const st = await fs.stat(host);
      if (!st.isFile()) throw new HttpError(400, "not a file");
      const max = 512 * 1024;
      const fh = await fs.open(host, "r");
      try {
        const buf = Buffer.alloc(Math.min(max, st.size));
        await fh.read(buf, 0, buf.length, 0);
        return { path: norm, content: buf.includes(0) ? `(binary file, ${st.size} bytes)` : buf.toString("utf8"), truncated: st.size > max };
      } finally {
        await fh.close();
      }
    });
  });
}

/** A sandbox path in one of the persona's folders, as a real path on this computer that stays inside it. */
function resolveSandboxPath(p: Persona, sandboxPath: string): { norm: string; host: string | null } {
  const norm = path.posix.normalize(sandboxPath || "/workspace");
  const mount = p.folders.find((f) => norm === f.mountPath || norm.startsWith(f.mountPath + "/"));
  if (!mount) return { norm, host: null };
  let real: string;
  try {
    real = realpathSync(path.join(mount.hostPath, path.posix.relative(mount.mountPath, norm)));
  } catch {
    throw new HttpError(404, "no such file");
  }
  const rel = path.relative(mount.hostPath, real);
  if (rel.startsWith("..") || path.isAbsolute(rel)) throw new HttpError(403, "path escapes the mounted folder");
  return { norm, host: real };
}
