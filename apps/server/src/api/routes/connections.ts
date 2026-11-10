// Connections: their status, static credential values, and command connections' sign-ins.
import type { CredentialUpsert } from "@ph/shared";
import type { FastifyInstance } from "fastify";
import { log } from "../../util.js";
import type { ApiDeps } from "../deps.js";
import { HttpError, type Req } from "../http.js";

export function connectionRoutes(app: FastifyInstance, d: ApiDeps) {
  const connection = (name: string) => {
    const c = d.connections.status().find((x) => x.name === name);
    if (!c) throw new HttpError(404, `connection "${name}" not found`);
    return c;
  };
  app.get("/api/connections", async () => d.connections.status());
  app.put("/api/connections/:conn/credentials/:name", async (req: Req<{ conn: string; name: string }, CredentialUpsert>) => {
    await d.connections.upsertStatic(req.params.conn, req.params.name, req.body ?? {});
    return connection(req.params.conn);
  });
  app.delete("/api/connections/:conn/credentials/:name", async (req: Req<{ conn: string; name: string }>) => {
    await d.connections.removeStatic(req.params.conn, req.params.name);
    return d.connections.status().find((x) => x.name === req.params.conn) ?? { ok: true };
  });
  app.post("/api/connections/:conn/:action", async (req: Req<{ conn: string; action: string }>) => {
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
}
