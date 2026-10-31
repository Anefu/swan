// Tests only: a stand-in for a company's HTTP proxy, so chaining can be tested without a network.
import http from "node:http";
import net from "node:net";

export interface CompanyProxy {
  url: string;
  seen: string[]; // "CONNECT host:port" and "GET http://…" as they arrived
  headerNames: Set<string>; // every request header name it received
  close(): void;
}

/**
 * CONNECT to a host:port in `routes` is piped to that local port; any other target is refused
 * with 403, as a proxy enforcing company policy would. Plain requests in absolute form are
 * answered by the proxy itself.
 */
export async function startCompanyProxy(routes: Record<string, number>): Promise<CompanyProxy> {
  const seen: string[] = [];
  const headerNames = new Set<string>();
  const sockets = new Set<net.Socket>();
  const server = http.createServer((req, res) => {
    seen.push(`${req.method} ${req.url}`);
    for (const k of Object.keys(req.headers)) headerNames.add(k);
    res.writeHead(200, { "content-type": "text/plain" }).end(`company proxy: ${req.method} ${req.url}\n`);
  });
  server.on("connection", (s: net.Socket) => {
    sockets.add(s);
    s.on("close", () => sockets.delete(s));
  });
  server.on("connect", (req: http.IncomingMessage, socket: net.Socket, head: Buffer) => {
    const target = req.url ?? "";
    seen.push(`CONNECT ${target}`);
    for (const k of Object.keys(req.headers)) headerNames.add(k);
    socket.on("error", () => {});
    const port = routes[target];
    if (port === undefined) return void socket.end("HTTP/1.1 403 Forbidden\r\n\r\n");
    const up = net.connect({ host: "127.0.0.1", port }, () => {
      socket.write("HTTP/1.1 200 Connection established\r\n\r\n");
      if (head.length) up.write(head);
      socket.pipe(up).pipe(socket);
    });
    up.on("error", () => socket.destroy());
    socket.on("close", () => up.destroy());
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  return {
    url: `http://127.0.0.1:${(server.address() as net.AddressInfo).port}`,
    seen,
    headerNames,
    close: () => {
      for (const s of sockets) s.destroy();
      server.close();
    },
  };
}
