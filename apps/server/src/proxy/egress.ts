import { timingSafeEqual } from "node:crypto";
import http from "node:http";
import https from "node:https";
import net from "node:net";
import { Transform } from "node:stream";
import tls from "node:tls";
import type { EgressEvent } from "@ph/shared";
import type { Rule } from "../connections/config.js";
import type { ConnectionManager, ResolvedCredential } from "../connections/manager.js";
import type { Verdict } from "../connections/rules.js";
import { TypedEmitter, errMsg, hostMatches, hostMatchesAny, log } from "../util.js";
import type { CertAuthority } from "./ca.js";
import { resolveChecked, subnetList, type Destination, type Lookup } from "./addresses.js";
import { EgressAudit } from "./audit.js";
import { CredentialPlanner, deniedHeader, type CredentialPlan, type PlanHooks } from "./credential-plan.js";
import { Redactor, decoder } from "./redactor.js";
import { forwardable, splitHostPort, viewRequest } from "./request.js";
import { ProxyRefused, TunnelAgent, bypassesProxy, dial, tunnelThrough } from "./upstream.js";

/** What the proxy knows about a running session. Registered by the session, never by the sandbox. */
export interface ProxySession {
  sessionId: string;
  personaId: string;
  token: string;
  allowHosts: string[];
  internalHosts: string[]; // also allowed, and may resolve to company (private) ranges
  credentials: string[]; // refs (connection/name) the persona's rules name
  placeholders: Map<string, { ref: string; field?: string }>; // placeholder -> credential (aws: and field)
  rules: Map<string, Rule[]>; // connection -> the persona's rules for it
  sessionAllowed: Set<string>; // `${ref} ${ruleKey}`: ask rules allowed until stopped
  otherCredentials?: string[]; // credential hosts that may also receive credentials not from Swan
}

const ALLOWED_PORTS = new Set([80, 443]);
const MAX_RESIGN_BODY = 64 * 1024 * 1024;
/** A reason as a header value: one line. */
const reasonHeader = (e: unknown) => `X-PH-Reason: ${errMsg(e).replace(/[\r\n]+/g, " ")}`;

interface MitmContext {
  session: ProxySession;
  host: string;
  port: number;
  upstream: Destination;
}

type Events = { event: [EgressEvent] };

export interface EgressOptions {
  /** Tests only: where to connect for a host, skipping DNS and the address checks (to reach a local stub). */
  resolve?: (host: string, port: number) => Promise<Destination>;
  /** Tests only: DNS answers. The address checks still apply. */
  lookup?: Lookup;
  /** config.yaml `proxy`: agents' traffic goes through it too, except hosts in noProxy. */
  upstreamProxy?: { url: string; noProxy: string[] };
  /** Swan's own networks in CIDR notation (runtime.subnet), never reachable. */
  ownSubnets?: string[];
}

export class EgressProxy extends TypedEmitter<Events> implements PlanHooks {
  private sessions = new Map<string, ProxySession>();
  private audit = new EgressAudit((e) => this.emit("event", e));
  private server = http.createServer();
  private mitm = http.createServer();
  private mitmCtx = new WeakMap<net.Socket, MitmContext>();
  private upstreamAgent = new https.Agent({ keepAlive: true, maxSockets: 64 });
  private resolveHook: EgressOptions["resolve"];
  private lookup: Lookup | undefined;
  private own: net.BlockList;
  private proxy: { url: URL; noProxy: string[]; agent: TunnelAgent } | null = null;
  private planner: CredentialPlanner;

  /** An unlisted public host on 80/443: resolves true when the person allowed it. */
  asker: ((s: ProxySession, host: string, port: number) => Promise<boolean>) | null = null;
  /** A request matched an `ask` rule: resolves true when the person allowed it. */
  credentialAsker: ((s: ProxySession, ref: string, v: Verdict) => Promise<boolean>) | null = null;
  /** A request went out without its credential because of a rule (or no rule). */
  onDenied: ((s: ProxySession, ref: string, v: Verdict) => void) | null = null;
  /** A request to a credential host carried a credential not from Swan, and was refused. */
  onForeignCredential: ((s: ProxySession, host: string, field: string) => void) | null = null;

  constructor(
    private connections: ConnectionManager,
    private ca: CertAuthority,
    opts: EgressOptions = {},
  ) {
    super();
    this.planner = new CredentialPlanner(connections, this);
    this.resolveHook = opts.resolve;
    this.lookup = opts.lookup;
    this.own = subnetList(opts.ownSubnets ?? []);
    if (opts.upstreamProxy) {
      const url = new URL(opts.upstreamProxy.url);
      this.proxy = { url, noProxy: opts.upstreamProxy.noProxy, agent: new TunnelAgent(url, { keepAlive: true, maxSockets: 64 }) };
    }
    this.server.on("connect", (req, socket: net.Socket, head) => void this.onConnect(req, socket, head));
    this.server.on("request", (req, res) => void this.onPlainHttp(req, res));
    this.server.on("clientError", (_e, socket) => socket.destroy());
    this.mitm.on("request", (req, res) => void this.onMitmRequest(req, res));
    this.mitm.on("upgrade", (req, socket: net.Socket, head) => void this.onMitmUpgrade(req, socket, head));
    this.mitm.on("clientError", (_e, socket) => socket.destroy());
  }

  async listen(port: number): Promise<number> {
    await this.audit.restore();
    return new Promise((resolve, reject) => {
      this.server.once("error", reject);
      this.server.listen(port, "127.0.0.1", () => {
        const actual = (this.server.address() as net.AddressInfo).port;
        log.info("proxy", `egress proxy on 127.0.0.1:${actual}${this.proxy ? `, agents' traffic through ${this.proxy.url.host}` : ""}`);
        resolve(actual);
      });
    });
  }

  close() {
    this.server.close();
    this.upstreamAgent.destroy();
    this.proxy?.agent.destroy();
  }

  register(s: ProxySession) {
    this.sessions.set(s.sessionId, s);
  }
  unregister(sessionId: string) {
    this.sessions.delete(sessionId);
  }

  events(sessionId?: string, limit = 200): EgressEvent[] {
    return this.audit.events(sessionId, limit);
  }

  private record(e: Parameters<EgressAudit["record"]>[0]) {
    this.audit.record(e);
  }

  private authenticate(req: http.IncomingMessage): ProxySession | null {
    const h = req.headers["proxy-authorization"];
    if (!h || !h.startsWith("Basic ")) return null;
    const [sid, token] = Buffer.from(h.slice(6), "base64").toString("utf8").split(":", 2);
    const s = this.sessions.get(sid ?? "");
    if (!s || !token) return null;
    const a = Buffer.from(token);
    const b = Buffer.from(s.token);
    return a.length === b.length && timingSafeEqual(a, b) ? s : null;
  }

  /** Where a host is, checked against what this session may reach. */
  private destination(s: ProxySession, host: string, port: number): Promise<Destination> {
    if (this.resolveHook) return this.resolveHook(host, port);
    const internal = s.internalHosts.some((p) => hostMatches(host, p.split(":")[0]!));
    return resolveChecked(host, port, { internal, own: this.own, lookup: this.lookup });
  }

  /** The company proxy to go through for host:port, or null to connect directly. */
  private via(host: string, port: number): URL | null {
    return this.proxy && !bypassesProxy(host, port, this.proxy.noProxy) ? this.proxy.url : null;
  }

  /** How a request went out, for its audit event. */
  private route(host: string, port: number, dest: Destination): Pick<EgressEvent, "via" | "internal"> {
    return { ...(this.via(host, port) ? { via: "proxy" as const } : {}), ...(dest.internal ? { internal: true } : {}) };
  }

  /** decide(), but an unlisted public host waits for the person instead of failing outright. */
  private async decideOrAsk(s: ProxySession, host: string, port: number): Promise<{ ok: true; creds: ResolvedCredential[] } | { ok: false; reason: string }> {
    const d = this.decide(s, host, port);
    if (d.ok || d.reason !== "host not in persona allowlist" || !this.asker) return d;
    try {
      await this.destination(s, host, port); // never offer private or local destinations
    } catch (e) {
      return { ok: false, reason: errMsg(e) };
    }
    if (!(await this.asker(s, host, port))) return { ok: false, reason: "denied by the user" };
    return this.decide(this.sessions.get(s.sessionId) ?? s, host, port);
  }

  private decide(s: ProxySession, host: string, port: number): { ok: true; creds: ResolvedCredential[] } | { ok: false; reason: string } {
    if (!ALLOWED_PORTS.has(port)) {
      // Other ports only by an explicit host:port entry; always tunnelled, never credentialed.
      const listed = [...s.allowHosts, ...s.internalHosts];
      if (listed.some((p) => p.includes(":") && hostMatches(host, p.split(":")[0]!) && Number(p.split(":")[1]) === port)) return { ok: true, creds: [] };
      return { ok: false, reason: `port ${port} not allowed` };
    }
    const creds = this.planner.bound(s, host);
    if (creds.length === 0 && !hostMatchesAny(host, s.allowHosts) && !hostMatchesAny(host, s.internalHosts)) {
      // Say why a credential host is unreachable instead of offering it as a new host.
      const bound = s.credentials.find((ref) => this.connections.resolve(ref)?.hosts.some((p) => hostMatches(host, p)));
      if (bound) return { ok: false, reason: `credential ${bound} ${this.connections.isExpired(bound) ? "expired" : "has no value"}` };
      return { ok: false, reason: "host not in persona allowlist" };
    }
    return { ok: true, creds };
  }

  private async onConnect(req: http.IncomingMessage, client: net.Socket, head: Buffer) {
    client.on("error", () => {});
    const started = Date.now();
    const session = this.authenticate(req);
    let host = "?";
    let port = 0;
    try {
      ({ host, port } = splitHostPort(req.url ?? "", 443));
    } catch {
      client.end("HTTP/1.1 400 Bad Request\r\n\r\n");
      return;
    }
    if (!session) {
      client.end('HTTP/1.1 407 Proxy Authentication Required\r\nProxy-Authenticate: Basic realm="persona-harness"\r\n\r\n');
      this.record({ sessionId: null, personaId: null, method: "CONNECT", host, port, decision: "blocked", credentials: [], reason: "missing or invalid proxy credentials" });
      return;
    }
    const base = { sessionId: session.sessionId, personaId: session.personaId, method: "CONNECT", host, port };
    const d = await this.decideOrAsk(session, host, port);
    if (!d.ok) {
      client.end(`HTTP/1.1 403 Forbidden\r\nX-PH-Reason: ${d.reason}\r\n\r\n`);
      this.record({ ...base, decision: "blocked", credentials: [], reason: d.reason });
      return;
    }
    let upstream: Destination;
    try {
      upstream = await this.destination(session, host, port);
    } catch (e) {
      client.end(`HTTP/1.1 403 Forbidden\r\n${reasonHeader(e)}\r\n\r\n`);
      this.record({ ...base, decision: "blocked", credentials: [], reason: errMsg(e) });
      return;
    }
    const route = this.route(host, port, upstream);

    if (d.creds.length > 0) {
      // Terminate TLS so credentials can be substituted; requests are audited individually.
      client.write("HTTP/1.1 200 Connection Established\r\n\r\n");
      if (head.length) client.unshift(head);
      const tlsSock = new tls.TLSSocket(client, {
        isServer: true,
        secureContext: this.ca.contextFor(host),
        ALPNProtocols: ["http/1.1"],
      });
      tlsSock.on("error", () => client.destroy());
      this.mitmCtx.set(tlsSock, { session, host, port, upstream });
      this.mitm.emit("connection", tlsSock);
      return;
    }

    // No credentials for this host: blind tunnel, no interception.
    const via = this.via(host, port);
    let up: net.Socket;
    try {
      up = via ? await tunnelThrough(via, host, port) : await dial(upstream.address, upstream.port);
    } catch (e) {
      const refused = e instanceof ProxyRefused;
      client.end(`HTTP/1.1 ${refused ? "403 Forbidden" : "502 Bad Gateway"}\r\n${reasonHeader(e)}\r\n\r\n`);
      this.record({ ...base, ...route, decision: refused ? "blocked" : "tunneled", credentials: [], durationMs: Date.now() - started, reason: errMsg(e) });
      return;
    }
    if (client.destroyed) return void up.destroy(); // the sandbox gave up while the connection opened
    let bytesUp = 0;
    let bytesDown = 0;
    client.write("HTTP/1.1 200 Connection Established\r\n\r\n");
    if (head.length) up.write(head);
    client.on("data", (c: Buffer) => (bytesUp += c.length));
    up.on("data", (c: Buffer) => (bytesDown += c.length));
    client.pipe(up);
    up.pipe(client);
    let done = false;
    const finish = (err?: Error) => {
      if (done) return;
      done = true;
      client.destroy();
      up.destroy();
      this.record({ ...base, ...route, decision: "tunneled", credentials: [], durationMs: Date.now() - started, bytesUp, bytesDown, reason: err ? errMsg(err) : undefined });
    };
    up.on("error", finish);
    up.on("close", () => finish());
    client.on("close", () => finish());
  }

  private upstreamOptions(ctx: MitmContext, req: http.IncomingMessage, headers: http.OutgoingHttpHeaders, pathAndQuery: string): https.RequestOptions {
    // A credential may name the CA that signs its hosts (a cluster's own CA, for example).
    const ca = this.planner.bound(ctx.session, ctx.host).find((c) => c.ca)?.ca;
    // Through the company proxy by name (CONNECT), after the same checks as a direct connection.
    const via = this.via(ctx.host, ctx.port);
    return {
      host: via ? ctx.host : ctx.upstream.address,
      port: via ? ctx.port : ctx.upstream.port,
      servername: net.isIP(ctx.host) ? undefined : ctx.host,
      method: req.method,
      path: pathAndQuery,
      headers,
      agent: via ? this.proxy!.agent : this.upstreamAgent,
      ...(ca ? { ca } : {}),
      checkServerIdentity: (_h, cert) => tls.checkServerIdentity(ctx.host, cert),
      timeout: 300_000,
    };
  }

  /** Response headers with real values rewritten to placeholders (a Location or Link can echo a query token). */
  private scrubHeaders(h: http.IncomingHttpHeaders, red: Redactor | null): http.OutgoingHttpHeaders {
    const out: http.OutgoingHttpHeaders = {};
    for (const [k, v] of forwardable(h)) out[k] = !red ? v : Array.isArray(v) ? v.map((x) => red.text(x)) : red.text(v);
    return out;
  }

  private async onMitmRequest(req: http.IncomingMessage, res: http.ServerResponse) {
    const ctx = this.mitmCtx.get(req.socket);
    if (!ctx) {
      res.writeHead(500).end();
      return;
    }
    const started = Date.now();
    const used = new Set<string>();
    const rawPath = req.url ?? "/";
    const hostHeader = (req.headers.host ?? ctx.host).toLowerCase().replace(/:443$/, "");
    const base = { sessionId: ctx.session.sessionId, personaId: ctx.session.personaId, method: req.method ?? "GET", host: ctx.host, port: ctx.port, path: rawPath.split("?")[0], ...this.route(ctx.host, ctx.port, ctx.upstream) };
    /** Answer the sandbox without forwarding, and audit why. */
    const refuse = (status: number, text: string, reason = text) => {
      res.writeHead(status, { "content-type": "text/plain" }).end(`${text}\n`);
      this.record({ ...base, status, decision: "blocked", credentials: [], reason });
    };
    if (hostHeader !== ctx.host && hostHeader !== `${ctx.host}:${ctx.port}`) return refuse(421, "Host header does not match CONNECT target", `Host header ${hostHeader} != ${ctx.host}`);

    let buffered: Buffer | null | undefined;
    const readBody = async (): Promise<Buffer | null> => {
      if (buffered !== undefined) return buffered;
      const chunks: Buffer[] = [];
      let size = 0;
      for await (const c of req) {
        size += (c as Buffer).length;
        if (size > MAX_RESIGN_BODY) throw new Error("body too large");
        chunks.push(c as Buffer);
      }
      return (buffered = Buffer.concat(chunks));
    };

    let plan: CredentialPlan;
    try {
      plan = await this.planner.plan(viewRequest(req, ctx.host), ctx, readBody);
    } catch (e) {
      return refuse(413, `Swan can re-sign AWS request bodies up to 64 MB: ${errMsg(e)}`, errMsg(e));
    }
    if (plan.refuse) return refuse(plan.refuse.status, plan.refuse.message);
    const headers = this.planner.headers(req, ctx, plan, used);
    const pathAndQuery = this.planner.substitute(rawPath, ctx.session, plan, used);
    let body = await this.planner.substitutedBody(req, ctx, plan, used, headers, buffered);
    if (body === null && buffered !== undefined) body = buffered;
    if (plan.aws) {
      if (body === null && !plan.aws.declaredPayload) body = await readBody();
      const problem = this.planner.resign(req, ctx, plan, headers, plan.aws.declaredPayload ? null : body, used);
      if (problem) return refuse(403, `Swan did not forward this request: ${problem}`, problem);
    }
    const reason = plan.stale.length ? `credential ${plan.stale.join(", ")} expired or has no value` : undefined;
    let bytesUp = 0;
    let bytesDown = 0;
    req.on("data", (c: Buffer) => (bytesUp += c.length));

    const upstream = https.request(this.upstreamOptions(ctx, req, headers, pathAndQuery), (up) => {
      // Every response is scanned, whatever its type: an echo can come back as anything.
      const red = this.planner.redactor(ctx.session, plan.echoes);
      const respHeaders = this.scrubHeaders(up.headers, red);
      if (plan.denied.length) respHeaders["x-swan-denied"] = deniedHeader(plan);
      let stream: NodeJS.ReadableStream = up;
      const encoding = String(up.headers["content-encoding"] ?? "identity");
      if (red && encoding.toLowerCase() !== "identity") {
        const dec = decoder(encoding);
        if (!dec) {
          up.destroy();
          const problem = `the response is encoded as ${encoding}, which Swan can't check for credential values`;
          res.writeHead(502, { "content-type": "text/plain" }).end(`Swan did not pass on this response: ${problem}.\n`);
          this.record({ ...base, status: 502, decision: "blocked", credentials: [...used], denied: plan.denied, reason: problem, durationMs: Date.now() - started });
          return;
        }
        dec.on("error", () => res.destroy());
        delete respHeaders["content-encoding"];
        stream = up.pipe(dec);
      }
      // A HEAD, 204 or 304 has no body, so its Content-Length describes the resource and stays.
      const bodiless = req.method === "HEAD" || up.statusCode === 204 || up.statusCode === 304;
      if (red && !bodiless) delete respHeaders["content-length"];
      res.writeHead(up.statusCode ?? 502, up.statusMessage, respHeaders);
      up.on("data", (c: Buffer) => (bytesDown += c.length));
      (red ? stream.pipe(red) : stream).pipe(res);
      if ((up.statusCode === 401 || up.statusCode === 403) && used.size)
        for (const ref of used) this.connections.authFailed(ref.slice(0, ref.indexOf("/")));
      up.on("end", () =>
        this.record({ ...base, status: up.statusCode, decision: used.size ? "injected" : "inspected", credentials: [...used], denied: plan.denied, reason, durationMs: Date.now() - started, bytesUp: bytesUp || body?.length || 0, bytesDown }),
      );
    });
    upstream.on("timeout", () => upstream.destroy(new Error("upstream timeout")));
    upstream.on("error", (e) => {
      if (!res.headersSent) res.writeHead(502, { "content-type": "text/plain" }).end(`upstream error: ${errMsg(e)}\n`);
      else res.destroy();
      const decision = e instanceof ProxyRefused ? "blocked" : used.size ? "injected" : "inspected";
      this.record({ ...base, status: 502, decision, credentials: [...used], denied: plan.denied, reason: errMsg(e), durationMs: Date.now() - started });
    });
    if (body) {
      headers["content-length"] = String(body.length);
      upstream.end(body);
    } else if (buffered !== undefined) upstream.end();
    else req.pipe(upstream);
  }

  private async onMitmUpgrade(req: http.IncomingMessage, socket: net.Socket, head: Buffer) {
    const ctx = this.mitmCtx.get(socket);
    if (!ctx) return socket.destroy();
    socket.on("error", () => {});
    const used = new Set<string>();
    const plan = await this.planner.plan(viewRequest(req, ctx.host), ctx, async () => null).catch(() => null);
    if (!plan || plan.refuse) {
      socket.end(`HTTP/1.1 403 Forbidden\r\n\r\n`);
      return;
    }
    const headers = this.planner.headers(req, ctx, plan, used);
    headers.connection = "Upgrade";
    headers.upgrade = req.headers.upgrade;
    const record = (status?: number) =>
      this.record({ sessionId: ctx.session.sessionId, personaId: ctx.session.personaId, method: "UPGRADE", host: ctx.host, port: ctx.port, path: (req.url ?? "/").split("?")[0], ...this.route(ctx.host, ctx.port, ctx.upstream), status, decision: used.size ? "injected" : "inspected", credentials: [...used], denied: plan.denied });
    // An upgraded connection leaves the pool, so it gets an agent of its own.
    const via = this.via(ctx.host, ctx.port);
    const agent = via ? new TunnelAgent(via, { keepAlive: false }) : false;
    const upstream = https.request({ ...this.upstreamOptions(ctx, req, headers, this.planner.substitute(req.url ?? "/", ctx.session, plan, used)), agent });
    upstream.on("upgrade", (up, upSocket, upHead) => {
      const red = this.planner.redactor(ctx.session, plan.echoes);
      const scrub = (v: string) => (red ? red.text(v) : v);
      const lines = [`HTTP/1.1 ${up.statusCode} ${up.statusMessage}`];
      for (let i = 0; i < up.rawHeaders.length; i += 2) lines.push(`${up.rawHeaders[i]}: ${scrub(up.rawHeaders[i + 1]!)}`);
      socket.write(lines.join("\r\n") + "\r\n\r\n");
      if (head.length) upSocket.write(head);
      socket.pipe(upSocket);
      // The upgraded stream is scanned too; a value in it would break a frame, but never reach the sandbox.
      const down = red ?? new Transform({ transform: (c, _e, cb) => cb(null, c) });
      down.pipe(socket);
      if (upHead.length) down.write(upHead);
      upSocket.pipe(down);
      upSocket.on("error", () => socket.destroy());
      socket.on("error", () => upSocket.destroy());
      record(up.statusCode);
    });
    upstream.on("response", (r) => {
      const extra = plan.denied.length ? `X-Swan-Denied: ${deniedHeader(plan)}\r\n` : "";
      socket.end(`HTTP/1.1 ${r.statusCode} ${r.statusMessage}\r\n${extra}Content-Length: 0\r\n\r\n`);
      record(r.statusCode);
    });
    upstream.on("error", () => socket.destroy());
    upstream.end();
  }

  /** Absolute-URI requests (plain http:// through the proxy). Never carries credentials. */
  private async onPlainHttp(req: http.IncomingMessage, res: http.ServerResponse) {
    const started = Date.now();
    const session = this.authenticate(req);
    let url: URL;
    try {
      url = new URL(req.url ?? "");
      if (url.protocol !== "http:") throw new Error();
    } catch {
      res.writeHead(400, { "content-type": "text/plain" }).end("persona-harness egress proxy: absolute http:// URL required\n");
      return;
    }
    const host = url.hostname.toLowerCase().replace(/^\[|\]$/g, "");
    const port = Number(url.port || 80);
    if (!session) {
      res.writeHead(407, { "proxy-authenticate": 'Basic realm="persona-harness"' }).end();
      this.record({ sessionId: null, personaId: null, method: req.method ?? "GET", host, port, path: url.pathname, decision: "blocked", credentials: [], reason: "missing or invalid proxy credentials" });
      return;
    }
    const base = { sessionId: session.sessionId, personaId: session.personaId, method: req.method ?? "GET", host, port, path: url.pathname };
    const d = await this.decideOrAsk(session, host, port);
    const reason = !d.ok ? d.reason : d.creds.length ? "credential hosts require https" : null;
    if (reason) {
      res.writeHead(403, { "content-type": "text/plain" }).end(`blocked: ${reason}\n`);
      this.record({ ...base, decision: "blocked", credentials: [], reason });
      return;
    }
    let upstreamAddr: Destination;
    try {
      upstreamAddr = await this.destination(session, host, port);
    } catch (e) {
      res.writeHead(403, { "content-type": "text/plain" }).end(`blocked: ${errMsg(e)}\n`);
      this.record({ ...base, decision: "blocked", credentials: [], reason: errMsg(e) });
      return;
    }
    const route = this.route(host, port, upstreamAddr);
    const headers: http.OutgoingHttpHeaders = Object.fromEntries(forwardable(req.headers));
    // Through the company proxy: the request in absolute form, to the proxy.
    const via = this.via(host, port);
    const target = via
      ? { host: via.hostname.replace(/^\[|\]$/g, ""), port: Number(via.port) || (via.protocol === "https:" ? 443 : 80), path: `http://${url.host}${url.pathname}${url.search}` }
      : { host: upstreamAddr.address, port: upstreamAddr.port, path: url.pathname + url.search };
    const upstream = (via?.protocol === "https:" ? https : http).request({ ...target, method: req.method, headers: { ...headers, host: url.host } }, (up) => {
      res.writeHead(up.statusCode ?? 502, Object.fromEntries(forwardable(up.headers)));
      up.pipe(res);
      up.on("end", () => this.record({ ...base, ...route, status: up.statusCode, decision: "inspected", credentials: [], durationMs: Date.now() - started }));
    });
    upstream.on("error", (e) => {
      if (!res.headersSent) res.writeHead(502).end();
      this.record({ ...base, ...route, status: 502, decision: "inspected", credentials: [], reason: errMsg(e) });
    });
    req.pipe(upstream);
  }
}
