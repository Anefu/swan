// Live events over a WebSocket: everything app-wide, and a conversation's items once subscribed.
import type { ClientMessage, ServerEvent } from "@ph/shared";
import type { FastifyInstance } from "fastify";
import type { ApiDeps } from "../deps.js";
import type { Hub } from "../hub.js";

export function liveRoutes(app: FastifyInstance, d: ApiDeps, hub: Hub) {
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
      if (!msg || typeof msg !== "object" || typeof msg.sessionId !== "string") return;
      if (msg.type === "subscribe") {
        const s = d.sessions.get(msg.sessionId);
        if (!s) return;
        client.subs.add(msg.sessionId);
        ws.send(JSON.stringify({ type: "session.snapshot", session: s.summary, items: s.items } satisfies ServerEvent));
      } else if (msg.type === "unsubscribe") client.subs.delete(msg.sessionId);
    });
  });
}
