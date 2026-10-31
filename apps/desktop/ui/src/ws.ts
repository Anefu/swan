import type { ClientMessage, ServerEvent } from "@ph/shared";
import { pageMeta } from "./api";

export interface WsState {
  status: "connecting" | "open" | "closed";
  /** Consecutive failed attempts since the last successful open. */
  attempt: number;
  /** Epoch ms of the next scheduled reconnect, when closed. */
  nextRetryAt: number | null;
}

interface Handlers {
  onEvent(ev: ServerEvent): void;
  onState(state: WsState): void;
  /** Called on every successful open. `reconnect` is false for the very first one. */
  onOpen(reconnect: boolean): void;
}

const BASE_DELAY = 500;
const MAX_DELAY = 15_000;

/** Single WebSocket to /api/ws with exponential backoff and one desired session subscription. */
export class EventSocket {
  private readonly url: string;
  private readonly handlers: Handlers;
  private ws: WebSocket | null = null;
  private attempt = 0;
  private timer: number | null = null;
  private stopped = false;
  private everOpened = false;
  private subscription: string | null = null;

  constructor(url: string, handlers: Handlers) {
    this.url = url;
    this.handlers = handlers;
  }

  start(): void {
    this.stopped = false;
    window.addEventListener("online", this.onWake);
    document.addEventListener("visibilitychange", this.onWake);
    this.connect();
  }

  stop(): void {
    this.stopped = true;
    window.removeEventListener("online", this.onWake);
    document.removeEventListener("visibilitychange", this.onWake);
    this.clearTimer();
    const ws = this.ws;
    this.ws = null;
    if (ws) {
      ws.onopen = ws.onclose = ws.onerror = ws.onmessage = null;
      try {
        ws.close();
      } catch {
        /* ignore */
      }
    }
  }

  get isOpen(): boolean {
    return this.ws?.readyState === WebSocket.OPEN;
  }

  /** Reconnect immediately if currently waiting on backoff. */
  retryNow(): void {
    if (this.stopped || this.ws) return;
    this.connect();
  }

  setSubscription(sessionId: string | null): void {
    if (sessionId === this.subscription) return;
    const prev = this.subscription;
    this.subscription = sessionId;
    if (!this.isOpen) return; // sent on (re)open
    if (prev) this.send({ type: "unsubscribe", sessionId: prev });
    if (sessionId) this.send({ type: "subscribe", sessionId });
  }

  private onWake = (): void => {
    if (document.visibilityState === "visible" && !this.ws && !this.stopped) {
      this.attempt = Math.min(this.attempt, 1);
      this.connect();
    }
  };

  private send(msg: ClientMessage): void {
    try {
      this.ws?.send(JSON.stringify(msg));
    } catch {
      /* close handler will reconnect */
    }
  }

  private connect(): void {
    this.clearTimer();
    if (this.stopped) return;
    this.handlers.onState({ status: "connecting", attempt: this.attempt, nextRetryAt: null });
    let ws: WebSocket;
    try {
      ws = new WebSocket(this.url);
    } catch {
      this.scheduleReconnect();
      return;
    }
    this.ws = ws;
    ws.onopen = () => {
      if (this.ws !== ws) return;
      const reconnect = this.everOpened;
      this.everOpened = true;
      this.attempt = 0;
      this.handlers.onState({ status: "open", attempt: 0, nextRetryAt: null });
      if (this.subscription) this.send({ type: "subscribe", sessionId: this.subscription });
      this.handlers.onOpen(reconnect);
    };
    ws.onmessage = (msg) => {
      if (this.ws !== ws || typeof msg.data !== "string") return;
      let ev: ServerEvent;
      try {
        ev = JSON.parse(msg.data) as ServerEvent;
      } catch {
        return;
      }
      if (ev && typeof ev === "object" && typeof ev.type === "string") this.handlers.onEvent(ev);
    };
    ws.onerror = () => {
      /* onclose follows */
    };
    ws.onclose = () => {
      if (this.ws !== ws) return;
      this.ws = null;
      this.scheduleReconnect();
    };
  }

  private scheduleReconnect(): void {
    if (this.stopped) return;
    const ceiling = Math.min(MAX_DELAY, BASE_DELAY * 2 ** this.attempt);
    const delay = Math.round(ceiling / 2 + (Math.random() * ceiling) / 2);
    this.attempt += 1;
    this.handlers.onState({ status: "closed", attempt: this.attempt, nextRetryAt: Date.now() + delay });
    this.timer = window.setTimeout(() => this.connect(), delay);
  }

  private clearTimer(): void {
    if (this.timer !== null) {
      window.clearTimeout(this.timer);
      this.timer = null;
    }
  }
}

/** The app names the server's WebSocket address in the page; in development the page's own host proxies it. */
export function wsUrl(token: string): string {
  const proto = window.location.protocol === "https:" ? "wss:" : "ws:";
  const base = pageMeta("ph-ws") ?? `${proto}//${window.location.host}/api/ws`;
  return `${base}?token=${encodeURIComponent(token)}`;
}
