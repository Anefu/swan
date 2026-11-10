// The HTTP and WebSocket API the app talks to: loopback only, behind the Host, Origin and token
// guard. Routes live in api/routes, one file per area.
import type { AddressInfo } from "node:net";
import websocket from "@fastify/websocket";
import Fastify from "fastify";
import type { ApiDeps } from "./api/deps.js";
import { requestGuard } from "./api/guard.js";
import { acceptJson, errorReplies } from "./api/http.js";
import type { Hub } from "./api/hub.js";
import { connectionRoutes } from "./api/routes/connections.js";
import { liveRoutes } from "./api/routes/live.js";
import { personaDataRoutes } from "./api/routes/persona-data.js";
import { personaRoutes } from "./api/routes/personas.js";
import { sessionRoutes } from "./api/routes/sessions.js";
import { systemRoutes } from "./api/routes/system.js";
import { log } from "./util.js";

export type { ApiDeps } from "./api/deps.js";
export { hostAllowed, originAllowed, requestGuard } from "./api/guard.js";
export { Hub } from "./api/hub.js";

export async function startApi(d: ApiDeps, hub: Hub) {
  const app = Fastify({ logger: false, bodyLimit: 30 * 1024 * 1024 }); // base64 attachments up to 20 MB
  await app.register(websocket);
  acceptJson(app);
  // Before every route, including the scoped ones registered below.
  app.addHook("onRequest", requestGuard(d.token));
  errorReplies(app);
  app.decorateRequest("persona", null as never);
  app.decorateRequest("session", null as never);

  systemRoutes(app, d);
  connectionRoutes(app, d);
  personaRoutes(app, d);
  personaDataRoutes(app, d);
  sessionRoutes(app, d);
  liveRoutes(app, d, hub);

  // The UI ships inside the desktop app; this server only answers the API.
  app.get("/", async (_req, reply) => reply.type("text/plain").send("This is Swan's server. Open the Swan app to use it.\n"));
  app.setNotFoundHandler(async (_req, reply) => reply.code(404).send({ error: "not found" }));

  await app.listen({ host: "127.0.0.1", port: d.settings.port });
  const port = (app.server.address() as AddressInfo).port;
  log.info("api", `API on http://127.0.0.1:${port}`);
  return { app, port };
}
