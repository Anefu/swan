import type { ServerEvent } from "@ph/shared";
import type { WebSocket } from "ws";

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
