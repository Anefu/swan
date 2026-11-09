import { timingSafeEqual } from "node:crypto";
import dns from "node:dns/promises";
import { promises as fs } from "node:fs";
import http from "node:http";
import https from "node:https";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { type Duplex, Transform, type TransformCallback } from "node:stream";
import tls from "node:tls";
import zlib from "node:zlib";
import { describeAuth, sign, verify } from "@ph/aws-sigv4";
import type { EgressEvent } from "@ph/shared";
import type { Rule } from "../connections/config.js";
import type { ConnectionManager, ResolvedCredential } from "../connections/manager.js";
import { evaluate, ruleKey, rulePath, type RequestFacts, type Verdict } from "../connections/rules.js";
import { paths } from "../settings.js";
import { TypedEmitter, errMsg, hostMatches, hostMatchesAny, log, nowIso, randomId } from "../util.js";
import type { CertAuthority } from "./ca.js";

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
const HOP_BY_HOP = new Set([
  "connection",
  "proxy-connection",
  "keep-alive",
  "proxy-authorization",
  "proxy-authenticate",
  "te",
  "trailer",
  "transfer-encoding",
  "upgrade",
]);
const MAX_RESIGN_BODY = 64 * 1024 * 1024;
/** Requests reloaded from the audit log on start, newest last; the UI asks for at most this many. */
const RESTORED_EVENTS = 2000;
// Payload markers the proxy can carry over to a new signature: the body itself is not signed.
const PASSTHROUGH_PAYLOAD = new Set(["UNSIGNED-PAYLOAD", "STREAMING-UNSIGNED-PAYLOAD-TRAILER"]);

// Never reachable, whatever the persona lists: this computer (loopback), link-local and cloud
// metadata, CGNAT (Tailscale), multicast, reserved and benchmarking space, NAT64, and Podman's own
// networks (its default network and the Podman machine's).
const NEVER = new net.BlockList();
for (const [a, p] of [
  ["0.0.0.0", 8], ["100.64.0.0", 10], ["127.0.0.0", 8], ["169.254.0.0", 16], ["192.0.0.0", 24], ["198.18.0.0", 15],
  ["224.0.0.0", 4], ["240.0.0.0", 4], ["10.88.0.0", 16], ["192.168.127.0", 24],
] as const) NEVER.addSubnet(a, p, "ipv4");
for (const [a, p] of [["::", 128], ["::1", 128], ["fe80::", 10], ["ff00::", 8], ["64:ff9b::", 96], ["64:ff9b:1::", 48]] as const)
  NEVER.addSubnet(a, p, "ipv6");

// Private ranges company networks use: reachable only for hosts a persona lists as internal.
const COMPANY = new net.BlockList();
for (const [a, p] of [["10.0.0.0", 8], ["172.16.0.0", 12], ["192.168.0.0", 16]] as const) COMPANY.addSubnet(a, p, "ipv4");
COMPANY.addSubnet("fc00::", 7, "ipv6");

function inList(list: net.BlockList, ip: string): boolean {
  const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/i.exec(ip);
  if (mapped) return list.check(mapped[1], "ipv4");
  return list.check(ip, net.isIPv6(ip) ? "ipv6" : "ipv4");
}

export const isPrivateAddress = (ip: string): boolean => inList(NEVER, ip) || inList(COMPANY, ip);

/** This computer's own addresses, read at check time (they change with the network). */
function ownAddresses(): net.BlockList {
  const list = new net.BlockList();
  for (const i of Object.values(os.networkInterfaces()).flat())
    if (i) list.addAddress(i.address.replace(/%.*$/, ""), i.family === "IPv6" ? "ipv6" : "ipv4");
  return list;
}

/** Subnets in CIDR notation as a list; Swan's own sandbox network, for example. */
export function subnetList(cidrs: string[]): net.BlockList {
  const list = new net.BlockList();
  for (const c of cidrs) {
    const [a, p] = c.split("/");
    if (a && p && net.isIP(a)) list.addSubnet(a, Number(p), net.isIPv6(a) ? "ipv6" : "ipv4");
  }
  return list;
}

const isLocalName = (h: string) => h === "localhost" || h.endsWith(".localhost") || h.endsWith(".containers.internal") || h.endsWith(".docker.internal");

export type Lookup = (host: string) => Promise<string[]>;
const systemLookup: Lookup = async (host) => (await dns.lookup(host, { all: true, verbatim: true })).map((a) => a.address);

export interface Destination {
  address: string;
  port: number;
  internal?: boolean; // on a company range
}

/**
 * Resolve once on this computer, check every address and pin the first, so a DNS answer cannot
 * change between check and connect. Company ranges only when the persona lists the host as
 * internal; loopback, link-local, CGNAT, reserved space, Swan's and Podman's networks and this
 * computer's own addresses never.
 */
export async function resolveChecked(host: string, port: number, opts: { internal: boolean; own?: net.BlockList; lookup?: Lookup }): Promise<Destination> {
  if (isLocalName(host) || (!opts.internal && (host.endsWith(".internal") || host.endsWith(".local"))))
    throw new Error(`${host} is a local name, not reachable from the sandbox`);
  let addrs: string[] = [host];
  if (!net.isIP(host)) addrs = await (opts.lookup ?? systemLookup)(host).catch(() => []);
  if (addrs.length === 0) throw new Error(`${host} does not resolve on this computer`);
  const mine = ownAddresses();
  for (const a of addrs) {
    if (inList(NEVER, a) || inList(mine, a) || (opts.own && inList(opts.own, a))) throw new Error(`${host} resolves to private address ${a}`);
    if (inList(COMPANY, a) && !opts.internal)
      throw new Error(`${host} resolves to ${a} on a private network; to reach it, list it under "On your company network" in the persona's Settings`);
  }
  return { address: addrs[0]!, port, ...(addrs.some((a) => inList(COMPANY, a)) ? { internal: true } : {}) };
}

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

class ProxyRefused extends Error {}

/** A reason as a header value: one line. */
const reasonHeader = (e: unknown) => `X-PH-Reason: ${errMsg(e).replace(/[\r\n]+/g, " ")}`;

const authority = (host: string, port: number) => (net.isIPv6(host) ? `[${host}]:${port}` : `${host}:${port}`);

/** A connection to host:port through the company proxy (CONNECT, by name). Rejects when the proxy refuses or fails. */
function tunnelThrough(proxy: URL, host: string, port: number): Promise<net.Socket> {
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
class TunnelAgent extends https.Agent {
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
function dial(address: string, port: number): Promise<net.Socket> {
  return new Promise((resolve, reject) => {
    const s = net.connect({ host: address, port });
    s.once("connect", () => {
      s.off("error", reject);
      resolve(s);
    });
    s.once("error", reject);
  });
}

function splitHostPort(s: string, defPort: number): { host: string; port: number } {
  const m = /^\[([^\]]+)\](?::(\d+))?$/.exec(s) ?? /^([^:]+)(?::(\d+))?$/.exec(s);
  if (!m) throw new Error("bad authority");
  return { host: m[1].toLowerCase(), port: m[2] ? Number(m[2]) : defPort };
}

const first = (v: string | string[] | undefined) => (Array.isArray(v) ? v[0] : v);

// Where requests carry credentials, besides Authorization and AWS signatures. On a host bound to the
// session's credentials, a value here that holds none of the session's placeholders is someone
// else's credential: an agent told to use an attacker's token could send data to their account.
const CREDENTIAL_HEADERS = ["x-api-key", "private-token", "x-auth-token", "x-amz-security-token"];
const CREDENTIAL_QUERY = new Set(["access_token", "token", "api_key", "x-amz-security-token"]);

/** The field of a request that carries a credential not from this session, or null. Never its value. */
export function foreignCredential(
  req: { url?: string; headers: http.IncomingHttpHeaders },
  host: string,
  placeholders: string[],
  awsKeyIds: Set<string>,
  injectHeaders: string[],
): string | null {
  const ours = (v: string) => placeholders.some((p) => v.includes(p));
  const rawPath = req.url ?? "/";
  const aws = describeAuth({ url: `https://${host}${rawPath}`, headers: req.headers });
  if (aws) {
    if (!awsKeyIds.has(aws.accessKeyId)) return aws.presigned ? "X-Amz-Credential" : "Authorization";
  } else {
    const auth = first(req.headers.authorization)?.trim();
    if (auth) {
      const basic = /^basic\s+/i.exec(auth);
      const decoded = basic ? Buffer.from(auth.slice(basic[0].length), "base64").toString("utf8") : "";
      if (!ours(auth) && !ours(decoded)) return "Authorization";
    }
  }
  for (const h of new Set([...CREDENTIAL_HEADERS, ...injectHeaders.map((x) => x.toLowerCase())])) {
    const v = h === "authorization" ? undefined : first(req.headers[h])?.trim();
    if (v && !ours(v)) return h;
  }
  for (const [k, v] of new URL(rawPath, `https://${host}`).searchParams)
    if (CREDENTIAL_QUERY.has(k.toLowerCase()) && v && !ours(v)) return `${k} in the query`;
  return null;
}

/** Streams a body through, rewriting real secret values back to placeholders. */
export class Redactor extends Transform {
  private pending: Buffer = Buffer.alloc(0);
  private keep: number;
  constructor(private pairs: { secret: Buffer; placeholder: Buffer }[]) {
    super();
    this.keep = Math.max(0, ...pairs.map((p) => p.secret.length - 1));
  }

  /**
   * Each value as sent, and as a server might echo it: percent-encoded, JSON-escaped and base64.
   * `exact` adds pairs seen in this request (a Basic header as sent). Longest first.
   */
  static pairs(values: { secret: string; placeholder: string }[], exact: { secret: string; placeholder: string }[] = []) {
    const forms = [(v: string) => v, encodeURIComponent, (v: string) => JSON.stringify(v).slice(1, -1), (v: string) => Buffer.from(v).toString("base64")];
    const out = new Map<string, string>();
    for (const { secret, placeholder } of values) for (const f of forms) if (!out.has(f(secret))) out.set(f(secret), f(placeholder));
    for (const e of exact) out.set(e.secret, e.placeholder);
    return [...out].sort((a, b) => b[0].length - a[0].length).map(([secret, placeholder]) => ({ secret: Buffer.from(secret), placeholder: Buffer.from(placeholder) }));
  }

  text(value: string): string {
    return this.replaceAll(Buffer.from(value)).toString();
  }

  private replaceAll(buf: Buffer): Buffer {
    for (const { secret, placeholder } of this.pairs) {
      let idx = buf.indexOf(secret);
      if (idx === -1) continue;
      const parts: Buffer[] = [];
      let from = 0;
      while (idx !== -1) {
        parts.push(buf.subarray(from, idx), placeholder);
        from = idx + secret.length;
        idx = buf.indexOf(secret, from);
      }
      parts.push(buf.subarray(from));
      buf = Buffer.concat(parts);
    }
    return buf;
  }
  _transform(chunk: Buffer, _enc: BufferEncoding, cb: TransformCallback) {
    const data = this.replaceAll(Buffer.concat([this.pending, chunk]));
    const cut = Math.max(0, data.length - this.keep);
    this.pending = data.subarray(cut);
    cb(null, data.subarray(0, cut));
  }
  _flush(cb: TransformCallback) {
    cb(null, this.replaceAll(this.pending));
  }
}

interface MitmContext {
  session: ProxySession;
  host: string;
  port: number;
  upstream: Destination;
}

/** What one request may carry, after the persona's rules. */
interface CredentialPlan {
  permitted: Set<string>; // refs to substitute, inject or re-sign
  denied: { credential: string; operation: string; rule: string | null }[];
  aws: { ref: string; real: NonNullable<ResolvedCredential["aws"]>; service: string; region: string; declaredPayload?: string } | null;
  refuse: { status: number; message: string } | null;
  stale: string[]; // placeholders of credentials that expired or lost their value
  echoes: { secret: string; placeholder: string }[]; // values as sent in this request, to scrub from echoes
}

/** A decoder for a response encoding, so it can be scanned; null when Swan can't read it. */
function decoder(encoding: string): Transform | null {
  const e = encoding.trim().toLowerCase();
  if (e === "gzip" || e === "x-gzip") return zlib.createGunzip();
  if (e === "deflate") return zlib.createInflate();
  if (e === "br") return zlib.createBrotliDecompress();
  return null;
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

export class EgressProxy extends TypedEmitter<Events> {
  private sessions = new Map<string, ProxySession>();
  private recent: EgressEvent[] = [];
  private server = http.createServer();
  private mitm = http.createServer();
  private mitmCtx = new WeakMap<net.Socket, MitmContext>();
  private upstreamAgent = new https.Agent({ keepAlive: true, maxSockets: 64 });
  private resolveHook: EgressOptions["resolve"];
  private lookup: Lookup | undefined;
  private own: net.BlockList;
  private proxy: { url: URL; noProxy: string[]; agent: TunnelAgent } | null = null;

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
    this.recent = await restoreEvents();
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
    const list = sessionId ? this.recent.filter((e) => e.sessionId === sessionId) : this.recent;
    return list.slice(-limit);
  }

  private record(e: Omit<EgressEvent, "id" | "ts">) {
    const ev: EgressEvent = { id: randomId("eg_", 6), ts: nowIso(), ...e };
    if (!ev.denied?.length) delete ev.denied;
    this.recent.push(ev);
    if (this.recent.length > 5000) this.recent.splice(0, this.recent.length - 5000);
    this.emit("event", ev);
    const file = path.join(paths.audit, `egress-${ev.ts.slice(0, 10)}.jsonl`);
    fs.appendFile(file, JSON.stringify(ev) + "\n", { mode: 0o600 }).catch(() => {});
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

  /** Usable credentials of this session bound to `host`. Read live, so edits and renewals apply now. */
  private credsFor(s: ProxySession, host: string): ResolvedCredential[] {
    return s.credentials.flatMap((ref) => {
      const c = this.connections.usable(ref);
      return c && c.hosts.some((p) => hostMatches(host, p)) ? [c] : [];
    });
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
    const creds = this.credsFor(s, host);
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

  private placeholdersOf(s: ProxySession, ref: string) {
    const out: Record<string, string> = {};
    for (const [ph, v] of s.placeholders) if (v.ref === ref) out[v.field ?? "value"] = ph;
    return out;
  }

  /**
   * Which credentials this request would carry (placeholders present, an inject header missing,
   * or an AWS signature made with the session's placeholder keys), and what the rules say.
   */
  private async plan(req: http.IncomingMessage, ctx: MitmContext, body: () => Promise<Buffer | null>): Promise<CredentialPlan> {
    const s = ctx.session;
    const creds = this.credsFor(s, ctx.host);
    const usableRefs = new Set(creds.map((c) => c.ref));
    const plan: CredentialPlan = { permitted: new Set(), denied: [], aws: null, refuse: null, stale: [], echoes: [] };
    const rawPath = req.url ?? "/";
    // TRACE echoes the request, credentials included, back to the sandbox.
    if (/^(TRACE|TRACK)$/i.test(req.method ?? "")) {
      plan.refuse = { status: 405, message: `Swan did not forward this request: ${req.method} isn't allowed to hosts that get credentials.` };
      return plan;
    }
    const checked = rulePath(rawPath);
    if ("error" in checked) {
      plan.refuse = { status: 400, message: `Swan did not forward this request: ${checked.error}.` };
      return plan;
    }

    if (!s.otherCredentials?.some((p) => hostMatches(ctx.host, p))) {
      const awsKeyIds = new Set([...s.placeholders].filter(([, v]) => v.field === "accessKeyId").map(([ph]) => ph));
      const injected = creds.flatMap((c) => (c.inject ? [c.inject.header] : []));
      const field = foreignCredential(req, ctx.host, [...s.placeholders.keys()], awsKeyIds, injected);
      if (field) {
        plan.refuse = {
          status: 403,
          message: `Swan did not forward this request: it carries a credential that is not from Swan (${field}). Use the persona's credentials; to allow others for this host, list it under network.otherCredentials.`,
        };
        this.onForeignCredential?.(s, ctx.host, field);
        return plan;
      }
    }
    const texts = [rawPath, ...Object.entries(req.headers).flatMap(([k, v]) => (k === "proxy-authorization" || v === undefined ? [] : Array.isArray(v) ? v : [v]))];
    const auth = first(req.headers.authorization);
    if (auth && /^basic /i.test(auth)) texts.push(Buffer.from(auth.slice(6).trim(), "base64").toString("utf8"));
    const joined = texts.join("\n");

    const candidates = new Set<string>();
    for (const [ph, { ref }] of s.placeholders) {
      if (!joined.includes(ph)) continue;
      if (usableRefs.has(ref)) candidates.add(ref);
      else if (s.credentials.includes(ref) && this.connections.resolve(ref)?.hosts.some((p) => hostMatches(ctx.host, p))) plan.stale.push(ref);
    }
    for (const c of creds) if (c.inject && c.kind !== "aws-sigv4" && req.headers[c.inject.header.toLowerCase()] === undefined) candidates.add(c.ref);

    // AWS: the sandbox signed with this session's placeholder keys; the proxy re-signs.
    let awsService: string | undefined;
    const awsCreds = creds.filter((c) => c.kind === "aws-sigv4");
    if (awsCreds.length) {
      const described = describeAuth({ url: `https://${ctx.host}${rawPath}`, headers: req.headers });
      const mine = described && awsCreds.find((c) => this.placeholdersOf(s, c.ref).accessKeyId === described.accessKeyId);
      if (described && mine) {
        candidates.delete(mine.ref);
        const declared = first(req.headers["x-amz-content-sha256"]);
        if (described.presigned) plan.refuse = { status: 403, message: "Swan cannot re-sign presigned URLs or query-string authentication; sign requests with the Authorization header." };
        else if (declared?.startsWith("STREAMING-") && !PASSTHROUGH_PAYLOAD.has(declared))
          plan.refuse = { status: 400, message: `Swan cannot re-sign ${declared} uploads (each chunk is signed). Unsigned payloads work: the AWS CLI and SDKs use them over HTTPS by default.` };
        else {
          awsService = described.service;
          candidates.add(mine.ref);
          plan.aws = { ref: mine.ref, real: mine.aws!, service: described.service, region: described.region, declaredPayload: declared };
        }
      }
    }
    if (!candidates.size) return plan;

    const u = new URL(rawPath, `https://${ctx.host}`);
    const facts: RequestFacts = { method: req.method ?? "GET", host: ctx.host, path: checked.path, query: u.searchParams, headers: req.headers, awsService };
    // The query protocol names the action in a form body; other bodies are only read to re-sign.
    const form = /x-www-form-urlencoded/i.test(first(req.headers["content-type"]) ?? "");
    if (plan.aws && (!plan.aws.declaredPayload || (form && !PASSTHROUGH_PAYLOAD.has(plan.aws.declaredPayload)))) facts.body = await body();
    for (const ref of candidates) {
      const i = ref.indexOf("/");
      const conn = ref.slice(0, i);
      const name = ref.slice(i + 1);
      const rules = s.rules.get(conn) ?? [];
      const allowed = new Set([...s.sessionAllowed].filter((k) => k.startsWith(`${ref} `)).map((k) => k.slice(ref.length + 1)));
      const v = evaluate(name, rules, facts, allowed);
      let ok = v.mode === "allow";
      if (v.mode === "ask") ok = (await this.credentialAsker?.(s, ref, v)) ?? false;
      if (ok) plan.permitted.add(ref);
      else {
        plan.denied.push({ credential: ref, operation: v.op.description, rule: v.mode === "ask" ? `${v.rule} (denied by the user)` : v.rule });
        if (v.mode !== "ask") this.onDenied?.(s, ref, v);
      }
    }
    if (plan.aws && !plan.permitted.has(plan.aws.ref)) plan.aws = null;
    return plan;
  }

  /** Replace this session's placeholders for permitted credentials (never AWS keys, which are re-signed). */
  private substitute(value: string, s: ProxySession, plan: CredentialPlan, used: Set<string>): string {
    for (const [ph, { ref }] of s.placeholders) {
      if (!value.includes(ph) || !plan.permitted.has(ref)) continue;
      const c = this.connections.usable(ref);
      if (!c?.value || c.kind === "aws-sigv4") continue;
      value = value.split(ph).join(c.value);
      used.add(ref);
    }
    return value;
  }

  private buildUpstreamHeaders(req: http.IncomingMessage, ctx: MitmContext, plan: CredentialPlan, used: Set<string>): http.OutgoingHttpHeaders {
    const out: http.OutgoingHttpHeaders = {};
    for (const [k, v] of Object.entries(req.headers)) {
      if (v === undefined || HOP_BY_HOP.has(k)) continue;
      const vals = Array.isArray(v) ? v : [v];
      const mapped = vals.map((val) => {
        if (k === "authorization" && /^basic /i.test(val)) {
          const decoded = Buffer.from(val.slice(6).trim(), "base64").toString("utf8");
          const sub = this.substitute(decoded, ctx.session, plan, used);
          if (sub === decoded) return val;
          const sent = Buffer.from(sub, "utf8").toString("base64");
          plan.echoes.push({ secret: sent, placeholder: val.slice(6).trim() });
          return `Basic ${sent}`;
        }
        return this.substitute(val, ctx.session, plan, used);
      });
      out[k] = Array.isArray(v) ? mapped : mapped[0];
    }
    for (const ref of plan.permitted) {
      const c = this.connections.usable(ref);
      if (!c?.inject || !c.value) continue;
      const key = c.inject.header.toLowerCase();
      if (out[key] === undefined) {
        out[key] = c.inject.format.split("{value}").join(c.value);
        used.add(ref);
      }
    }
    out.host = ctx.port === 443 ? ctx.host : `${ctx.host}:${ctx.port}`;
    out["accept-encoding"] = "identity"; // so responses can be scanned for leaked values
    return out;
  }

  /** Check the placeholder signature, then sign again with the real keys. Returns an error message or null. */
  private resign(req: http.IncomingMessage, ctx: MitmContext, plan: CredentialPlan, headers: http.OutgoingHttpHeaders, body: Buffer | null, used: Set<string>): string | null {
    const a = plan.aws!;
    const ph = this.placeholdersOf(ctx.session, a.ref);
    const url = `https://${headers.host as string}${req.url ?? "/"}`;
    const checked = verify(
      { method: req.method ?? "GET", url, headers: { ...req.headers, host: headers.host as string }, body: a.declaredPayload ? null : body },
      { lookup: (akid) => (akid === ph.accessKeyId ? { accessKeyId: akid, secretAccessKey: ph.secretAccessKey, sessionToken: ph.sessionToken } : undefined) },
    );
    if (!checked.ok) return `the request is not signed with this session's placeholder keys (${checked.code}: ${checked.message})`;
    for (const k of ["authorization", "x-amz-date", "x-amz-security-token"]) delete headers[k];
    const signHeaders: Record<string, string | string[]> = {};
    for (const [k, v] of Object.entries(headers)) if (v !== undefined) signHeaders[k] = Array.isArray(v) ? v : String(v);
    const added = sign({ method: req.method ?? "GET", url, headers: signHeaders, body }, a.real, { service: a.service, region: a.region });
    Object.assign(headers, added);
    used.add(a.ref);
    return null;
  }

  private upstreamOptions(ctx: MitmContext, req: http.IncomingMessage, headers: http.OutgoingHttpHeaders, pathAndQuery: string): https.RequestOptions {
    // A credential may name the CA that signs its hosts (a cluster's own CA, for example).
    const ca = this.credsFor(ctx.session, ctx.host).find((c) => c.ca)?.ca;
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

  private redactor(s: ProxySession, echoes: CredentialPlan["echoes"] = []): Redactor | null {
    const values: { secret: string; placeholder: string }[] = [];
    for (const [ph, { ref, field }] of s.placeholders) {
      const c = this.connections.resolve(ref);
      const v = field && c?.aws ? c.aws[field as keyof typeof c.aws] : c?.value;
      if (v && v.length >= 6) values.push({ secret: v, placeholder: ph });
    }
    return values.length || echoes.length ? new Redactor(Redactor.pairs(values, echoes)) : null;
  }

  /** Response headers with real values rewritten to placeholders (a Location or Link can echo a query token). */
  private scrubHeaders(h: http.IncomingHttpHeaders, red: Redactor | null): http.OutgoingHttpHeaders {
    const out: http.OutgoingHttpHeaders = {};
    for (const [k, v] of Object.entries(h)) {
      if (v === undefined || HOP_BY_HOP.has(k)) continue;
      out[k] = !red ? v : Array.isArray(v) ? v.map((x) => red.text(x)) : red.text(v);
    }
    return out;
  }

  private deniedHeader(plan: CredentialPlan) {
    return plan.denied.map((d) => `${d.credential}: ${d.rule ? `rule "${d.rule}"` : "no rule"}`).join(", ");
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
    if (hostHeader !== ctx.host && hostHeader !== `${ctx.host}:${ctx.port}`) {
      res.writeHead(421, { "content-type": "text/plain" }).end("Host header does not match CONNECT target\n");
      this.record({ ...base, decision: "blocked", credentials: [], reason: `Host header ${hostHeader} != ${ctx.host}` });
      return;
    }

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
      plan = await this.plan(req, ctx, readBody);
    } catch (e) {
      res.writeHead(413, { "content-type": "text/plain" }).end(`Swan can re-sign AWS request bodies up to 64 MB: ${errMsg(e)}\n`);
      this.record({ ...base, decision: "blocked", credentials: [], reason: errMsg(e) });
      return;
    }
    if (plan.refuse) {
      res.writeHead(plan.refuse.status, { "content-type": "text/plain" }).end(`${plan.refuse.message}\n`);
      this.record({ ...base, status: plan.refuse.status, decision: "blocked", credentials: [], reason: plan.refuse.message });
      return;
    }
    const headers = this.buildUpstreamHeaders(req, ctx, plan, used);
    const pathAndQuery = this.substitute(rawPath, ctx.session, plan, used);
    let body = await this.substitutedBody(req, ctx, plan, used, headers, buffered);
    if (body === null && buffered !== undefined) body = buffered;
    if (plan.aws) {
      if (body === null && !plan.aws.declaredPayload) body = await readBody();
      const problem = this.resign(req, ctx, plan, headers, plan.aws.declaredPayload ? null : body, used);
      if (problem) {
        res.writeHead(403, { "content-type": "text/plain" }).end(`Swan did not forward this request: ${problem}\n`);
        this.record({ ...base, status: 403, decision: "blocked", credentials: [], reason: problem });
        return;
      }
    }
    const reason = plan.stale.length ? `credential ${plan.stale.join(", ")} expired or has no value` : undefined;
    let bytesUp = 0;
    let bytesDown = 0;
    req.on("data", (c: Buffer) => (bytesUp += c.length));

    const upstream = https.request(this.upstreamOptions(ctx, req, headers, pathAndQuery), (up) => {
      // Every response is scanned, whatever its type: an echo can come back as anything.
      const red = this.redactor(ctx.session, plan.echoes);
      const respHeaders = this.scrubHeaders(up.headers, red);
      if (plan.denied.length) respHeaders["x-swan-denied"] = this.deniedHeader(plan);
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

  /**
   * Opt-in (per credential, substituteInBody) placeholder swap in JSON or form bodies up to 1 MB with
   * a declared length. Anything else streams through untouched.
   */
  private async substitutedBody(req: http.IncomingMessage, ctx: MitmContext, plan: CredentialPlan, used: Set<string>, headers: http.OutgoingHttpHeaders, already?: Buffer | null): Promise<Buffer | null> {
    const opted = [...plan.permitted].filter((r) => this.connections.usable(r)?.substituteInBody);
    const len = Number(req.headers["content-length"] ?? NaN);
    const ct = String(req.headers["content-type"] ?? "");
    if (!opted.length || !Number.isFinite(len) || len > 1_000_000 || !/json|x-www-form-urlencoded/i.test(ct) || req.headers["content-encoding"]) return null;
    let raw = already;
    if (raw === undefined || raw === null) {
      const chunks: Buffer[] = [];
      for await (const c of req) chunks.push(c as Buffer);
      raw = Buffer.concat(chunks);
    }
    let text = raw.toString("utf8");
    for (const [ph, { ref }] of ctx.session.placeholders) {
      if (!opted.includes(ref) || !text.includes(ph)) continue;
      const real = this.connections.usable(ref)?.value;
      if (real === undefined) continue;
      text = text.split(ph).join(/json/i.test(ct) ? JSON.stringify(real).slice(1, -1) : encodeURIComponent(real));
      used.add(ref);
    }
    const out = Buffer.from(text, "utf8");
    headers["content-length"] = String(out.length);
    return out;
  }

  private async onMitmUpgrade(req: http.IncomingMessage, socket: net.Socket, head: Buffer) {
    const ctx = this.mitmCtx.get(socket);
    if (!ctx) return socket.destroy();
    socket.on("error", () => {});
    const used = new Set<string>();
    const plan = await this.plan(req, ctx, async () => null).catch(() => null);
    if (!plan || plan.refuse) {
      socket.end(`HTTP/1.1 403 Forbidden\r\n\r\n`);
      return;
    }
    const headers = this.buildUpstreamHeaders(req, ctx, plan, used);
    headers.connection = "Upgrade";
    headers.upgrade = req.headers.upgrade;
    const record = (status?: number) =>
      this.record({ sessionId: ctx.session.sessionId, personaId: ctx.session.personaId, method: "UPGRADE", host: ctx.host, port: ctx.port, path: (req.url ?? "/").split("?")[0], ...this.route(ctx.host, ctx.port, ctx.upstream), status, decision: used.size ? "injected" : "inspected", credentials: [...used], denied: plan.denied });
    // An upgraded connection leaves the pool, so it gets an agent of its own.
    const via = this.via(ctx.host, ctx.port);
    const agent = via ? new TunnelAgent(via, { keepAlive: false }) : false;
    const upstream = https.request({ ...this.upstreamOptions(ctx, req, headers, this.substitute(req.url ?? "/", ctx.session, plan, used)), agent });
    upstream.on("upgrade", (up, upSocket, upHead) => {
      const red = this.redactor(ctx.session, plan.echoes);
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
      const extra = plan.denied.length ? `X-Swan-Denied: ${this.deniedHeader(plan)}\r\n` : "";
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
    const headers: http.OutgoingHttpHeaders = {};
    for (const [k, v] of Object.entries(req.headers)) if (v !== undefined && !HOP_BY_HOP.has(k)) headers[k] = v;
    // Through the company proxy: the request in absolute form, to the proxy.
    const via = this.via(host, port);
    const target = via
      ? { host: via.hostname.replace(/^\[|\]$/g, ""), port: Number(via.port) || (via.protocol === "https:" ? 443 : 80), path: `http://${url.host}${url.pathname}${url.search}` }
      : { host: upstreamAddr.address, port: upstreamAddr.port, path: url.pathname + url.search };
    const upstream = (via?.protocol === "https:" ? https : http).request({ ...target, method: req.method, headers: { ...headers, host: url.host } }, (up) => {
      const h: http.OutgoingHttpHeaders = {};
      for (const [k, v] of Object.entries(up.headers)) if (v !== undefined && !HOP_BY_HOP.has(k)) h[k] = v;
      res.writeHead(up.statusCode ?? 502, h);
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

/**
 * Recent history from the audit logs (one file per UTC day), newest files first until there is enough,
 * so the UI keeps earlier requests across restarts and past midnight. Unreadable files and lines are skipped.
 */
async function restoreEvents(): Promise<EgressEvent[]> {
  let files: string[];
  try {
    files = (await fs.readdir(paths.audit)).filter((f) => /^egress-\d{4}-\d{2}-\d{2}\.jsonl$/.test(f));
  } catch {
    return [];
  }
  let events: EgressEvent[] = [];
  for (const f of files.sort().reverse()) {
    let text: string;
    try {
      text = await fs.readFile(path.join(paths.audit, f), "utf8");
    } catch {
      continue;
    }
    const day = text.split("\n").flatMap((l) => {
      if (!l.trim()) return [];
      try {
        return [JSON.parse(l) as EgressEvent];
      } catch {
        return [];
      }
    });
    events = day.concat(events);
    if (events.length >= RESTORED_EVENTS) break;
  }
  return events.slice(-RESTORED_EVENTS);
}
