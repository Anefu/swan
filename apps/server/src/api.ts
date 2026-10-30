import { timingSafeEqual } from "node:crypto";
import { promises as fs, realpathSync } from "node:fs";
import path from "node:path";
import fastifyStatic from "@fastify/static";
import websocket from "@fastify/websocket";
import Fastify, { type FastifyReply, type FastifyRequest } from "fastify";
import type { WebSocket } from "ws";
import type { ApprovalBody, ClientMessage, CredentialUpsert, FileEntry, ServerEvent } from "@ph/shared";
import type { ProviderRegistry } from "./agent/providers.js";
import type { SessionManager } from "./agent/session.js";
import { PERSONA_ID, type PersonaStore } from "./personas.js";
import type { EgressProxy } from "./proxy/egress.js";
import type { PodmanRuntime } from "./sandbox/podman.js";
import type { SecretStore } from "./secrets.js";
import { paths, type Settings } from "./settings.js";
import type { SkillRegistry } from "./skills.js";
import { builtinTools, skillTool } from "./agent/tools.js";
import { PermissionPolicy } from "./agent/permissions.js";
import { exists, log } from "./util.js";

export interface ApiDeps {
  settings: Settings;
  token: string;
  secrets: SecretStore;
  personas: PersonaStore;
  skills: SkillRegistry;
  runtime: PodmanRuntime;
  proxy: EgressProxy;
  providers: ProviderRegistry;
  sessions: SessionManager;
}

class HttpError extends Error {
  constructor(
    readonly statusCode: number,
    message: string,
  ) {
    super(message);
  }
}

const LOCAL_HOST = /^(localhost|127\.0\.0\.1|\[::1\])(:\d+)?$/i;
const LOCAL_ORIGIN = /^https?:\/\/(localhost|127\.0\.0\.1|\[::1\])(:\d+)?$/i;

/** Fans server events out to WebSocket clients; item-level events only to subscribers. */
export class Hub {
  private clients = new Set<{ ws: WebSocket; subs: Set<string> }>();
  add(ws: WebSocket) {
    const c = { ws, subs: new Set<string>() };
    this.clients.add(c);
    ws.on("close", () => this.clients.delete(c));
    return c;
  }
  broadcast = (ev: ServerEvent) => {
    const scoped = ev.type.startsWith("item.") ? (ev as { sessionId: string }).sessionId : null;
    const data = JSON.stringify(ev);
    for (const c of this.clients) {
      if (scoped && !c.subs.has(scoped)) continue;
      if (c.ws.readyState === c.ws.OPEN) c.ws.send(data);
    }
  };
}

export async function startApi(d: ApiDeps, hub: Hub) {
  const app = Fastify({ logger: false, bodyLimit: 10 * 1024 * 1024 });
  await app.register(websocket);
  // Accept an empty JSON body (clients often send the header on bodiless POSTs).
  app.removeContentTypeParser("application/json");
  app.addContentTypeParser("application/json", { parseAs: "string" }, (_req, body, done) => {
    if (!body) return done(null, {});
    try {
      done(null, JSON.parse(body as string));
    } catch {
      done(new HttpError(400, "invalid JSON body"), undefined);
    }
  });

  const tokenBuf = Buffer.from(d.token);
  const tokenOk = (t: unknown) => typeof t === "string" && t.length === d.token.length && timingSafeEqual(Buffer.from(t), tokenBuf);

  // DNS-rebinding and CSRF guard for everything, token for the API.
  app.addHook("onRequest", async (req, reply) => {
    if (!LOCAL_HOST.test(req.headers.host ?? "")) return reply.code(403).send({ error: "forbidden host" });
    const origin = req.headers.origin;
    if (origin && !LOCAL_ORIGIN.test(origin)) return reply.code(403).send({ error: "forbidden origin" });
    if (req.url.startsWith("/api/")) {
      const t = req.headers["x-ph-token"] ?? new URL(req.url, "http://x").searchParams.get("token");
      if (!tokenOk(t)) return reply.code(401).send({ error: "missing or invalid token" });
    }
  });

  app.setErrorHandler((err: Error & { statusCode?: number }, _req, reply) => {
    const code = err.statusCode && err.statusCode >= 400 ? err.statusCode : 400;
    if (code >= 500) log.error("api", err.message);
    reply.code(code).send({ error: err.message });
  });

  const persona = (id: string) => {
    const p = d.personas.get(id);
    if (!p) throw new HttpError(404, `persona "${id}" not found`);
    return p;
  };
  const session = (id: string) => {
    const s = d.sessions.get(id);
    if (!s) throw new HttpError(404, `session "${id}" not found`);
    return s;
  };
  type P<T = Record<string, string>> = FastifyRequest<{ Params: T }>;

  // ----- runtime / providers -----
  app.get("/api/runtime", async () => d.runtime.status);
  app.post("/api/runtime/rebuild", async () => {
    void d.runtime.rebuild();
    return d.runtime.status;
  });
  app.get("/api/providers", async () => d.providers.status());

  // ----- personas -----
  app.get("/api/personas", async () => d.personas.list().map((p) => d.personas.summary(p)));
  app.post("/api/personas", async (req: FastifyRequest<{ Body: { id: string; yaml: string } }>) => {
    const { id, yaml } = req.body ?? ({} as { id: string; yaml: string });
    if (!PERSONA_ID.test(id ?? "")) throw new HttpError(400, "id must be lowercase letters, digits and dashes");
    return d.personas.summary(await d.personas.save(id, yaml, { create: true }));
  });
  app.get("/api/personas/:id/source", async (req: P) => {
    const p = persona(req.params.id);
    return { id: p.id, yaml: p.yaml };
  });
  app.put("/api/personas/:id/source", async (req: FastifyRequest<{ Params: { id: string }; Body: { yaml: string } }>) => {
    persona(req.params.id);
    return d.personas.summary(await d.personas.save(req.params.id, req.body?.yaml ?? ""));
  });
  app.delete("/api/personas/:id", async (req: P) => {
    persona(req.params.id);
    await d.personas.remove(req.params.id);
    return { ok: true };
  });
  app.get("/api/personas/:id/tools", async (req: P) => {
    const cfg = persona(req.params.id).config;
    const policy = new PermissionPolicy(cfg?.permissions ?? { default: "ask", allow: [], ask: [], deny: [] }, []);
    return [...builtinTools(), ...(cfg?.skills.length ? [skillTool()] : [])].map((t) => ({
      name: t.name,
      source: t.source,
      description: t.description,
      permission: policy.describe(t),
    }));
  });

  // Host-side browsing of a persona's mounted folders, addressed by sandbox path.
  const resolveSandboxPath = (personaId: string, sandboxPath: string) => {
    const p = persona(personaId);
    const norm = path.posix.normalize(sandboxPath || "/workspace");
    const mount = p.folders.find((f) => norm === f.mountPath || norm.startsWith(f.mountPath + "/"));
    if (!mount) return { p, norm, host: null as string | null };
    const host = path.join(mount.hostPath, path.posix.relative(mount.mountPath, norm));
    let real: string;
    try {
      real = realpathSync(host);
    } catch {
      throw new HttpError(404, "no such file");
    }
    const rel = path.relative(mount.hostPath, real);
    if (rel.startsWith("..") || path.isAbsolute(rel)) throw new HttpError(403, "path escapes the mounted folder");
    return { p, norm, host: real };
  };
  app.get("/api/personas/:id/files", async (req: FastifyRequest<{ Params: { id: string }; Querystring: { path?: string } }>) => {
    const { p, norm, host } = resolveSandboxPath(req.params.id, req.query.path ?? "/workspace");
    if (!host) {
      const entries: FileEntry[] = p.folders
        .filter((f) => path.posix.dirname(f.mountPath) === norm || (norm === "/workspace" && f.mountPath.startsWith("/workspace/")))
        .map((f) => ({ name: path.posix.basename(f.mountPath), path: f.mountPath, type: "dir" as const, size: 0 }));
      return { path: norm, entries };
    }
    const dirents = await fs.readdir(host, { withFileTypes: true });
    const entries: FileEntry[] = [];
    for (const de of dirents.slice(0, 2000)) {
      if (de.name === ".git" || de.name === "node_modules" || de.name === ".DS_Store") continue;
      const st = await fs.stat(path.join(host, de.name)).catch(() => null);
      if (!st) continue;
      entries.push({ name: de.name, path: path.posix.join(norm, de.name), type: st.isDirectory() ? "dir" : "file", size: st.size });
    }
    entries.sort((a, b) => (a.type === b.type ? a.name.localeCompare(b.name) : a.type === "dir" ? -1 : 1));
    return { path: norm, entries };
  });
  app.get("/api/personas/:id/file", async (req: FastifyRequest<{ Params: { id: string }; Querystring: { path?: string } }>) => {
    const { norm, host } = resolveSandboxPath(req.params.id, req.query.path ?? "");
    if (!host) throw new HttpError(404, "not inside a mounted folder");
    const st = await fs.stat(host);
    if (!st.isFile()) throw new HttpError(400, "not a file");
    const max = 512 * 1024;
    const fh = await fs.open(host, "r");
    try {
      const buf = Buffer.alloc(Math.min(max, st.size));
      await fh.read(buf, 0, buf.length, 0);
      const binary = buf.includes(0);
      return { path: norm, content: binary ? `(binary file, ${st.size} bytes)` : buf.toString("utf8"), truncated: st.size > max };
    } finally {
      await fh.close();
    }
  });

  // ----- skills / credentials -----
  app.get("/api/skills", async () => d.skills.list());
  app.get("/api/credentials", async () => d.secrets.status(d.personas.usedBy()));
  app.put("/api/credentials/:name", async (req: FastifyRequest<{ Params: { name: string }; Body: CredentialUpsert }>) => {
    await d.secrets.upsert(req.params.name, req.body ?? {});
    return d.secrets.status(d.personas.usedBy()).find((c) => c.name === req.params.name);
  });
  app.delete("/api/credentials/:name", async (req: P<{ name: string }>) => {
    await d.secrets.remove(req.params.name);
    return { ok: true };
  });

  // ----- sessions -----
  app.get("/api/sessions", async (req: FastifyRequest<{ Querystring: { personaId?: string } }>) => d.sessions.list(req.query.personaId));
  app.post("/api/sessions", async (req: FastifyRequest<{ Body: { personaId: string; title?: string } }>) => {
    const p = persona(req.body?.personaId ?? "");
    if (!p.config) throw new HttpError(400, `persona "${p.id}" is invalid: ${p.errors.join("; ")}`);
    return d.sessions.create(p.id, req.body.title).summary;
  });
  app.get("/api/sessions/:id", async (req: P) => {
    const s = session(req.params.id);
    return { session: s.summary, items: s.items };
  });
  app.get("/api/sessions/:id/tools", async (req: P) => session(req.params.id).tools());
  app.post("/api/sessions/:id/messages", async (req: FastifyRequest<{ Params: { id: string }; Body: { text: string } }>) => {
    await session(req.params.id).sendMessage(String(req.body?.text ?? ""));
    return { ok: true };
  });
  app.post("/api/sessions/:id/interrupt", async (req: P) => {
    session(req.params.id).interrupt();
    return { ok: true };
  });
  app.post("/api/sessions/:id/approvals/:toolUseId", async (req: FastifyRequest<{ Params: { id: string; toolUseId: string }; Body: ApprovalBody }>) => {
    const body = req.body;
    if (!body || !["allow", "allow_always", "deny"].includes(body.decision)) throw new HttpError(400, "decision must be allow, allow_always or deny");
    session(req.params.id).approve(req.params.toolUseId, body);
    return { ok: true };
  });
  app.post("/api/sessions/:id/stop", async (req: P) => {
    const s = session(req.params.id);
    await s.stop();
    return s.summary;
  });
  app.delete("/api/sessions/:id", async (req: P) => {
    session(req.params.id);
    await d.sessions.remove(req.params.id);
    return { ok: true };
  });

  app.get("/api/egress", async (req: FastifyRequest<{ Querystring: { sessionId?: string; limit?: string } }>) =>
    d.proxy.events(req.query.sessionId || undefined, Math.min(2000, Number(req.query.limit ?? 200) || 200)),
  );

  // ----- live events -----
  app.get("/api/ws", { websocket: true }, (ws) => {
    const client = hub.add(ws);
    ws.send(JSON.stringify({ type: "hello", runtime: d.runtime.status } satisfies ServerEvent));
    ws.on("message", (raw) => {
      let msg: ClientMessage;
      try {
        msg = JSON.parse(String(raw));
      } catch {
        return;
      }
      if (msg.type === "subscribe") {
        const s = d.sessions.get(msg.sessionId);
        if (!s) return;
        client.subs.add(msg.sessionId);
        ws.send(JSON.stringify({ type: "session.snapshot", session: s.summary, items: s.items } satisfies ServerEvent));
      } else if (msg.type === "unsubscribe") client.subs.delete(msg.sessionId);
    });
  });

  // ----- web UI -----
  const serveIndex = async (_req: FastifyRequest, reply: FastifyReply) => {
    const index = path.join(paths.webDist, "index.html");
    if (!(await exists(index)))
      return reply
        .type("text/html")
        .send(`<!doctype html><title>persona-harness</title><p style="font-family:system-ui;padding:2rem">The web UI is not built. Run <code>pnpm build</code>, or use <code>pnpm dev</code> and open <a href="http://localhost:5173">localhost:5173</a>.</p>`);
    const html = (await fs.readFile(index, "utf8")).replace("__PH_TOKEN__", d.token);
    return reply.type("text/html").header("cache-control", "no-store").send(html);
  };
  if (await exists(paths.webDist)) {
    await app.register(fastifyStatic, { root: paths.webDist, index: false, wildcard: false, prefix: "/" });
    // Static files registered with wildcard:false get explicit routes; the rest falls to the SPA.
  }
  app.get("/", serveIndex);
  app.setNotFoundHandler(async (req, reply) => {
    if (req.url.startsWith("/api/")) return reply.code(404).send({ error: "not found" });
    return serveIndex(req, reply);
  });

  await app.listen({ host: "127.0.0.1", port: d.settings.port });
  log.info("api", `UI and API on http://127.0.0.1:${d.settings.port}`);
  return app;
}

