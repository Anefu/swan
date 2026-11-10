// Leaving this computer: directly to a checked address, or through config.yaml's company proxy by name.
import http from "node:http";
import https from "node:https";
import net from "node:net";
import type { Duplex } from "node:stream";
import tls from "node:tls";
import { errMsg } from "../util.js";

/** NO_PROXY as undici reads it: an exact name, or ".domain" / "*.domain" for names ending so; "*" for all. */
export function bypassesProxy(host: string, port: number, noProxy: string[]): boolean {
  return noProxy.some((entry) => {
    const m = /^(.+):(\d+)$/.exec(entry);
    const name = (m ? m[1]! : entry).toLowerCase();
    if (m && Number(m[2]) !== port) return false;
    if (name === "*") return true;
    return /^[.*]/.test(name) ? host.endsWith(name.replace(/^\*/, "")) : host === name;
  });
}

/** The company proxy refused the connection (as opposed to failing to reach it). */
export class ProxyRefused extends Error {}

export const authority = (host: string, port: number) => (net.isIPv6(host) ? `[${host}]:${port}` : `${host}:${port}`);

/** A connection to host:port through the company proxy (CONNECT, by name). Rejects when the proxy refuses or fails. */
export function tunnelThrough(proxy: URL, host: string, port: number): Promise<net.Socket> {
  const target = authority(host, port);
  return new Promise((resolve, reject) => {
    const secure = proxy.protocol === "https:";
    const req = (secure ? https : http).request({
      host: proxy.hostname.replace(/^\[|\]$/g, ""),
      port: Number(proxy.port) || (secure ? 443 : 80),
      method: "CONNECT",
      path: target,
      headers: { host: target },
      agent: false,
    });
    const timer = setTimeout(() => req.destroy(new Error("no answer in 30 s")), 30_000);
    req.on("connect", (res, socket, head) => {
      clearTimeout(timer);
      const status = res.statusCode ?? 0;
      if (status < 200 || status > 299) {
        socket.destroy();
        return reject(new ProxyRefused(`the company proxy refused ${target} (${status}${res.statusMessage ? ` ${res.statusMessage}` : ""})`));
      }
      if (head.length) socket.unshift(head);
      resolve(socket);
    });
    req.on("error", (e) => {
      clearTimeout(timer);
      reject(new Error(`company proxy ${proxy.host}: ${errMsg(e)}`));
    });
    req.end();
  });
}

/** TLS to credential hosts through CONNECT tunnels of the company proxy, kept alive like a direct agent. */
export class TunnelAgent extends https.Agent {
  constructor(
    private proxy: URL,
    opts: https.AgentOptions,
  ) {
    super(opts);
  }
  override createConnection(options: https.RequestOptions, cb?: (err: Error | null, stream: Duplex) => void): Duplex | null | undefined {
    tunnelThrough(this.proxy, String(options.host), Number(options.port)).then(
      (socket) => cb?.(null, tls.connect({ ...(options as tls.ConnectionOptions), socket })),
      (e: Error) => cb?.(e, undefined as unknown as Duplex),
    );
    return undefined;
  }
}

/** A direct TCP connection, once it is open. */
export function dial(address: string, port: number): Promise<net.Socket> {
  return new Promise((resolve, reject) => {
    const s = net.connect({ host: address, port });
    s.once("connect", () => {
      s.off("error", reject);
      resolve(s);
    });
    s.once("error", reject);
  });
}
