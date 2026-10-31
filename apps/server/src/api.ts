import { timingSafeEqual } from "node:crypto";
import { promises as fs, realpathSync } from "node:fs";
import type { AddressInfo } from "node:net";
import path from "node:path";
import websocket from "@fastify/websocket";
import Fastify, { type FastifyRequest } from "fastify";
import type { WebSocket } from "ws";
import type { AttachmentMeta, ApprovalBody, ClientMessage, CredentialUpsert, Effort, FileEntry, MemoryType, PersonaConfigView, ServerEvent } from "@ph/shared";
import type { AttachmentStore } from "./attachments.js";
import type { ConnectionManager } from "./connections/manager.js";
import { dismissMigrationNote, readMigrationNote } from "./connections/migrate.js";
import type { ModelCatalog } from "./catalog.js";
import type { MemoryStore } from "./memory.js";
import type { UsageLedger } from "./usage.js";
import type { ProviderRegistry } from "./agent/providers.js";
import type { SessionManager } from "./agent/session.js";
import { PERSONA_ID, type PersonaStore } from "./personas.js";
import type { EgressProxy } from "./proxy/egress.js";
import type { PodmanRuntime } from "./sandbox/podman.js";
import type { SecretStore } from "./secrets.js";
import type { Settings } from "./settings.js";
import type { SkillRegistry } from "./skills.js";
import { builtinTools, skillTool } from "./agent/tools.js";
import { PermissionPolicy } from "./agent/permissions.js";
import { log } from "./util.js";

export interface ApiDeps {
  settings: Settings;
  token: string;
  secrets: SecretStore;
  connections: ConnectionManager;
  personas: PersonaStore;
  skills: SkillRegistry;
  runtime: PodmanRuntime;
  proxy: EgressProxy;
  providers: ProviderRegistry;
  sessions: SessionManager;
  memory: MemoryStore;
  usage: UsageLedger;
  catalog: ModelCatalog;
  attachments: AttachmentStore;
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
// The desktop app's own pages (swan://app), or a local page in development (Vite on localhost).
const LOCAL_ORIGIN = /^(https?:\/\/(localhost|127\.0\.0\.1|\[::1\])(:\d+)?|swan:\/\/app)$/i;

/** DNS-rebinding guard: only requests addressed to a loopback name. */
export const hostAllowed = (host: string | undefined) => LOCAL_HOST.test(host ?? "");
/** CSRF guard: browsers send Origin, and only Swan's own pages may call the API. */
export const originAllowed = (origin: string | undefined) => origin === undefined || LOCAL_ORIGIN.test(origin);

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
  const app = Fastify({ logger: false, bodyLimit: 30 * 1024 * 1024 }); // base64 attachments up to 20 MB
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
    if (!hostAllowed(req.headers.host)) return reply.code(403).send({ error: "forbidden host" });
    if (!originAllowed(req.headers.origin)) return reply.code(403).send({ error: "forbidden origin" });
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
  app.post("/api/runtime/retry", async () => {
    void d.runtime.init();
    return d.runtime.status;
  });
  app.post("/api/runtime/setup", async () => {
    void d.runtime.setupMachine();
    return d.runtime.status;
  });
  app.post("/api/runtime/rebuild", async () => {
    void d.runtime.rebuild();
    return d.runtime.status;
  });
  app.get("/api/providers", async () => d.providers.status());
  app.get("/api/providers/:name/models", async (req: P<{ name: string }>) => {
    if (d.settings.providers[req.params.name]?.type !== "copilot") throw new HttpError(400, "model listing is available for copilot providers");
    return d.providers.listModels(req.params.name);
  });

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
  // What belongs to the persona goes with it (its conversation stops first); its folders are the user's.
  app.delete("/api/personas/:id", async (req: P) => {
    persona(req.params.id);
    for (const s of d.sessions.list(req.params.id)) await d.sessions.remove(s.id);
    await d.memory.removePersona(req.params.id);
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

  // ----- skills / connections -----
  app.get("/api/skills", async () => d.skills.list());
  const connection = (name: string) => {
    const c = d.connections.status().find((x) => x.name === name);
    if (!c) throw new HttpError(404, `connection "${name}" not found`);
    return c;
  };
  app.get("/api/connections", async () => d.connections.status());
  app.get("/api/connections/migration", async () => readMigrationNote());
  app.delete("/api/connections/migration", async () => {
    await dismissMigrationNote();
    return { ok: true };
  });
  app.put("/api/connections/:conn/credentials/:name", async (req: FastifyRequest<{ Params: { conn: string; name: string }; Body: CredentialUpsert }>) => {
    try {
      await d.connections.upsertStatic(req.params.conn, req.params.name, req.body ?? {});
    } catch (e) {
      throw new HttpError(400, e instanceof Error ? e.message : String(e));
    }
    return connection(req.params.conn);
  });
  app.delete("/api/connections/:conn/credentials/:name", async (req: P<{ conn: string; name: string }>) => {
    await d.connections.removeStatic(req.params.conn, req.params.name);
    return d.connections.status().find((x) => x.name === req.params.conn) ?? { ok: true };
  });
  app.post("/api/connections/:conn/:action", async (req: P<{ conn: string; action: string }>) => {
    const c = connection(req.params.conn);
    if (c.type !== "command") throw new HttpError(400, `${c.name} is a static connection`);
    const { action } = req.params;
    if (action === "login") d.connections.login(c.name).catch((e) => log.warn("connections", `${c.name} login: ${e instanceof Error ? e.message : e}`));
    else if (action === "renew") await d.connections.renew(c.name);
    else if (action === "cancel") d.connections.cancel(c.name);
    else if (action === "logout") d.connections.logout(c.name);
    else throw new HttpError(404, `unknown action ${action}`);
    return connection(c.name);
  });

  // Model-provider keys: host-side only, never a connection.
  const providerKey = (name: string) => {
    const cfg = d.settings.providers[name];
    const key = cfg?.apiKeySecret ?? (cfg?.type === "copilot" ? "COPILOT_GITHUB_TOKEN" : undefined);
    if (!key) throw new HttpError(404, `provider "${name}" has no key`);
    return key;
  };
  app.put("/api/providers/:name/key", async (req: FastifyRequest<{ Params: { name: string }; Body: { value?: string } }>) => {
    const value = req.body?.value?.trim();
    if (!value) throw new HttpError(400, "value is required");
    await d.secrets.setValue(providerKey(req.params.name), value);
    return d.providers.status().find((p) => p.name === req.params.name);
  });
  app.delete("/api/providers/:name/key", async (req: P<{ name: string }>) => {
    await d.secrets.remove(providerKey(req.params.name));
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
  app.post("/api/sessions/:id/attachments", async (req: FastifyRequest<{ Params: { id: string }; Body: { name: string; mediaType: string; data: string } }>) => {
    session(req.params.id);
    return d.attachments.save(req.params.id, req.body ?? ({} as never));
  });
  app.get("/api/personas/:id/attachments", async (req: P) => {
    persona(req.params.id);
    const out: (AttachmentMeta & { sessionId: string; itemId: string; ts: string })[] = [];
    for (const sum of d.sessions.list(req.params.id)) {
      for (const it of d.sessions.get(sum.id)?.items ?? []) {
        if (it.kind === "user" && it.attachments) for (const a of it.attachments) out.push({ ...a, sessionId: sum.id, itemId: it.id, ts: it.ts });
      }
    }
    return out.sort((a, b) => b.ts.localeCompare(a.ts));
  });
  app.get("/api/sessions/:id/attachments/:attId/file", async (req: P<{ id: string; attId: string }>, reply) => {
    session(req.params.id);
    const { meta, data } = await d.attachments.get(req.params.id, req.params.attId);
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
  app.post("/api/sessions/:id/messages", async (req: FastifyRequest<{ Params: { id: string }; Body: { text: string; attachments?: string[] } }>) => {
    await session(req.params.id).sendMessage(String(req.body?.text ?? ""), Array.isArray(req.body?.attachments) ? req.body.attachments.map(String) : []);
    return { ok: true };
  });
  app.post("/api/sessions/:id/interrupt", async (req: P) => {
    session(req.params.id).interrupt();
    return { ok: true };
  });
  app.post("/api/sessions/:id/approvals/:toolUseId", async (req: FastifyRequest<{ Params: { id: string; toolUseId: string }; Body: ApprovalBody }>) => {
    const body = req.body;
    if (!body || !["allow", "allow_session", "allow_always", "deny"].includes(body.decision)) throw new HttpError(400, "decision must be allow, allow_session, allow_always or deny");
    session(req.params.id).approve(req.params.toolUseId, body);
    return { ok: true };
  });
  app.post("/api/sessions/:id/agents/:agentId/stop", async (req: P<{ id: string; agentId: string }>) => {
    session(req.params.id).stopAgents(req.params.agentId === "all" ? undefined : req.params.agentId);
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

  // ----- Swan: one conversation per persona -----
  app.get("/api/personas/:id/conversation", async (req: P) => {
    const p = persona(req.params.id);
    if (!p.config) throw new HttpError(400, `persona "${p.id}" is invalid: ${p.errors.join("; ")}`);
    const s = d.sessions.conversation(p.id);
    return { session: s.summary, items: s.items };
  });
  app.get("/api/personas/:id/commands", async (req: P) => {
    persona(req.params.id);
    return d.sessions.conversation(req.params.id).commands();
  });
  app.get("/api/personas/:id/config", async (req: P) => {
    persona(req.params.id);
    return d.personas.configView(req.params.id);
  });
  app.put("/api/personas/:id/config", async (req: FastifyRequest<{ Params: { id: string }; Body: PersonaConfigView }>) => {
    persona(req.params.id);
    return d.personas.saveConfig(req.params.id, req.body);
  });
  app.put("/api/personas/:id/model", async (req: FastifyRequest<{ Params: { id: string }; Body: { provider: string; id: string; effort?: Effort } }>) => {
    persona(req.params.id);
    if (!req.body?.provider || !req.body?.id) throw new HttpError(400, "provider and id are required");
    return d.personas.setModel(req.params.id, req.body);
  });
  app.get("/api/models", async () => d.catalog.list());
  app.get("/api/approvals", async () => d.sessions.pendingApprovals());
  app.delete("/api/sessions/:id/allowances", async (req: P) => {
    const s = session(req.params.id);
    s.resetAllowances();
    return s.summary;
  });
  app.delete("/api/sessions/:id/allowances/:rule", async (req: P<{ id: string; rule: string }>) => {
    const s = session(req.params.id);
    s.removeAllowance(decodeURIComponent(req.params.rule));
    return s.summary;
  });

  // ----- memory (persona-private) -----
  app.get("/api/personas/:id/memory", async (req: FastifyRequest<{ Params: { id: string }; Querystring: { query?: string; type?: string; status?: string } }>) => {
    persona(req.params.id);
    return d.memory.list(req.params.id, req.query);
  });
  app.post("/api/personas/:id/memory", async (req: FastifyRequest<{ Params: { id: string }; Body: { content: string; type: MemoryType; pinned?: boolean } }>) => {
    persona(req.params.id);
    return d.memory.add(req.params.id, { content: req.body?.content ?? "", type: req.body?.type, origin: "user", sources: ["user"], pinned: req.body?.pinned, by: "user" });
  });
  app.put("/api/personas/:id/memory/:recordId", async (req: FastifyRequest<{ Params: { id: string; recordId: string }; Body: { content?: string; type?: MemoryType } }>) => {
    persona(req.params.id);
    return d.memory.edit(req.params.id, req.params.recordId, req.body ?? {});
  });
  app.post("/api/personas/:id/memory/:recordId/:action", async (req: P<{ id: string; recordId: string; action: string }>) => {
    persona(req.params.id);
    const a = req.params.action;
    if (a !== "pin" && a !== "unpin" && a !== "archive" && a !== "forget") throw new HttpError(400, "action must be pin, unpin, archive or forget");
    return d.memory.act(req.params.id, req.params.recordId, a);
  });
  app.get("/api/personas/:id/memory-history", async (req: P) => {
    persona(req.params.id);
    return d.memory.history(req.params.id);
  });
  app.get("/api/personas/:id/checkpoint", async (req: P) => {
    persona(req.params.id);
    return d.memory.latestCheckpoint(req.params.id);
  });

  // ----- usage -----
  app.get("/api/usage", async (req: FastifyRequest<{ Querystring: { personaId?: string; period?: string } }>) => {
    const p = persona(req.query.personaId ?? "");
    return d.usage.report(p.id, req.query.period === "all" ? "all" : "today");
  });
  app.get("/api/providers/:name/allowance", async (req: P<{ name: string }>) => d.catalog.allowance(req.params.name));

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

  // The UI ships inside the desktop app; this server only answers the API.
  app.get("/", async (_req, reply) => reply.type("text/plain").send("This is Swan's server. Open the Swan app to use it.\n"));
  app.setNotFoundHandler(async (_req, reply) => reply.code(404).send({ error: "not found" }));

  await app.listen({ host: "127.0.0.1", port: d.settings.port });
  const port = (app.server.address() as AddressInfo).port;
  log.info("api", `API on http://127.0.0.1:${port}`);
  return { app, port };
}

