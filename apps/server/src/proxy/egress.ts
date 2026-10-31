import { timingSafeEqual } from "node:crypto";
import dns from "node:dns/promises";
import { promises as fs } from "node:fs";
import http from "node:http";
import https from "node:https";
import net from "node:net";
import path from "node:path";
import { Transform, type TransformCallback } from "node:stream";
import tls from "node:tls";
import { describeAuth, sign, verify } from "@ph/aws-sigv4";
import type { EgressEvent } from "@ph/shared";
import type { Rule } from "../connections/config.js";
import type { ConnectionManager, ResolvedCredential } from "../connections/manager.js";
import { evaluate, ruleKey, type RequestFacts, type Verdict } from "../connections/rules.js";
import { paths } from "../settings.js";
import { TypedEmitter, errMsg, hostMatches, hostMatchesAny, log, nowIso, randomId } from "../util.js";
import type { CertAuthority } from "./ca.js";

/** What the proxy knows about a running session. Registered by the session, never by the sandbox. */
export interface ProxySession {
  sessionId: string;
  personaId: string;
  token: string;
  allowHosts: string[];
  credentials: string[]; // refs (connection/name) the persona's rules name
  placeholders: Map<string, { ref: string; field?: string }>; // placeholder -> credential (aws: and field)
  rules: Map<string, Rule[]>; // connection -> the persona's rules for it
  sessionAllowed: Set<string>; // `${ref} ${ruleKey}`: ask rules allowed until stopped
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
// Payload markers the proxy can carry over to a new signature: the body itself is not signed.
const PASSTHROUGH_PAYLOAD = new Set(["UNSIGNED-PAYLOAD", "STREAMING-UNSIGNED-PAYLOAD-TRAILER"]);

// Destinations the sandbox must never reach through the proxy: the harness itself (loopback),
// the LAN, link-local/metadata, CGNAT (Tailscale), multicast and reserved space.
const PRIVATE = new net.BlockList();
for (const [a, p] of [
  ["0.0.0.0", 8], ["10.0.0.0", 8], ["100.64.0.0", 10], ["127.0.0.0", 8], ["169.254.0.0", 16],
  ["172.16.0.0", 12], ["192.0.0.0", 24], ["192.168.0.0", 16], ["198.18.0.0", 15], ["224.0.0.0", 4], ["240.0.0.0", 4],
] as const) PRIVATE.addSubnet(a, p, "ipv4");
for (const [a, p] of [["::", 128], ["::1", 128], ["fc00::", 7], ["fe80::", 10], ["ff00::", 8], ["64:ff9b::", 96]] as const)
  PRIVATE.addSubnet(a, p, "ipv6");

export function isPrivateAddress(ip: string): boolean {
  const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/i.exec(ip);
  if (mapped) return PRIVATE.check(mapped[1], "ipv4");
  return PRIVATE.check(ip, net.isIPv6(ip) ? "ipv6" : "ipv4");
}

/** Resolve once and pin the address, so a DNS answer cannot change between check and connect. */
async function resolvePublic(host: string, port: number): Promise<{ address: string; port: number }> {
  if (host === "localhost" || host.endsWith(".localhost") || host.endsWith(".internal") || host.endsWith(".local"))
    throw new Error("local hostnames are not reachable from the sandbox");
  const addrs = net.isIP(host) ? [{ address: host }] : await dns.lookup(host, { all: true, verbatim: true });
  if (addrs.length === 0) throw new Error("no address");
  for (const a of addrs) if (isPrivateAddress(a.address)) throw new Error(`${host} resolves to private address ${a.address}`);
  return { address: addrs[0].address, port };
}

function splitHostPort(s: string, defPort: number): { host: string; port: number } {
  const m = /^\[([^\]]+)\](?::(\d+))?$/.exec(s) ?? /^([^:]+)(?::(\d+))?$/.exec(s);
  if (!m) throw new Error("bad authority");
  return { host: m[1].toLowerCase(), port: m[2] ? Number(m[2]) : defPort };
}

const first = (v: string | string[] | undefined) => (Array.isArray(v) ? v[0] : v);

/** Streams a body through, rewriting real secret values back to placeholders. */
class Redactor extends Transform {
  private pending: Buffer = Buffer.alloc(0);
  private keep: number;
  constructor(private pairs: { secret: Buffer; placeholder: Buffer }[]) {
    super();
    this.keep = Math.max(0, ...pairs.map((p) => p.secret.length - 1));
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
  upstream: { address: string; port: number };
}

/** What one request may carry, after the persona's rules. */
interface CredentialPlan {
  permitted: Set<string>; // refs to substitute, inject or re-sign
  denied: { credential: string; operation: string; rule: string | null }[];
  aws: { ref: string; real: NonNullable<ResolvedCredential["aws"]>; service: string; region: string; declaredPayload?: string } | null;
  refuse: { status: number; message: string } | null;
  stale: string[]; // placeholders of credentials that expired or lost their value
}

type Events = { event: [EgressEvent] };

export interface EgressOptions {
  /** Where to connect for a host (tests point public names at a local stub). Default: resolve and refuse private addresses. */
  resolve?: (host: string, port: number) => Promise<{ address: string; port: number }>;
}

export class EgressProxy extends TypedEmitter<Events> {
  private sessions = new Map<string, ProxySession>();
  private recent: EgressEvent[] = [];
  private server = http.createServer();
  private mitm = http.createServer();
  private mitmCtx = new WeakMap<net.Socket, MitmContext>();
  private upstreamAgent = new https.Agent({ keepAlive: true, maxSockets: 64 });
  private resolve: NonNullable<EgressOptions["resolve"]>;

  /** An unlisted public host on 80/443: resolves true when the person allowed it. */
  asker: ((s: ProxySession, host: string, port: number) => Promise<boolean>) | null = null;
  /** A request matched an `ask` rule: resolves true when the person allowed it. */
  credentialAsker: ((s: ProxySession, ref: string, v: Verdict) => Promise<boolean>) | null = null;
  /** A request went out without its credential because of a rule (or no rule). */
  onDenied: ((s: ProxySession, ref: string, v: Verdict) => void) | null = null;

  constructor(
    private connections: ConnectionManager,
    private ca: CertAuthority,
    opts: EgressOptions = {},
  ) {
    super();
    this.resolve = opts.resolve ?? resolvePublic;
    this.server.on("connect", (req, socket: net.Socket, head) => void this.onConnect(req, socket, head));
    this.server.on("request", (req, res) => void this.onPlainHttp(req, res));
    this.server.on("clientError", (_e, socket) => socket.destroy());
    this.mitm.on("request", (req, res) => void this.onMitmRequest(req, res));
    this.mitm.on("upgrade", (req, socket: net.Socket, head) => void this.onMitmUpgrade(req, socket, head));
    this.mitm.on("clientError", (_e, socket) => socket.destroy());
  }

  async listen(port: number): Promise<number> {
    // Restore recent history from today's audit log so the UI survives restarts.
    try {
      const file = path.join(paths.audit, `egress-${nowIso().slice(0, 10)}.jsonl`);
      const lines = (await fs.readFile(file, "utf8")).trim().split("\n").slice(-2000);
      this.recent = lines.flatMap((l) => {
        try {
          return [JSON.parse(l) as EgressEvent];
        } catch {
          return [];
        }
      });
    } catch {}
    return new Promise((resolve, reject) => {
      this.server.once("error", reject);
      this.server.listen(port, "127.0.0.1", () => {
        const actual = (this.server.address() as net.AddressInfo).port;
        log.info("proxy", `egress proxy on 127.0.0.1:${actual}`);
        resolve(actual);
      });
    });
  }

  close() {
    this.server.close();
    this.upstreamAgent.destroy();
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

  /** decide(), but an unlisted public host waits for the person instead of failing outright. */
  private async decideOrAsk(s: ProxySession, host: string, port: number): Promise<{ ok: true; creds: ResolvedCredential[] } | { ok: false; reason: string }> {
    const d = this.decide(s, host, port);
    if (d.ok || d.reason !== "host not in persona allowlist" || !this.asker) return d;
    try {
      await this.resolve(host, port); // never offer private or local destinations
    } catch (e) {
      return { ok: false, reason: errMsg(e) };
    }
    if (!(await this.asker(s, host, port))) return { ok: false, reason: "denied by the user" };
    return this.decide(this.sessions.get(s.sessionId) ?? s, host, port);
  }

  private decide(s: ProxySession, host: string, port: number): { ok: true; creds: ResolvedCredential[] } | { ok: false; reason: string } {
    if (!ALLOWED_PORTS.has(port)) {
      // Other ports only by an explicit host:port entry; always tunnelled, never credentialed.
      if (s.allowHosts.some((p) => p.includes(":") && hostMatches(host, p.split(":")[0]) && Number(p.split(":")[1]) === port)) return { ok: true, creds: [] };
      return { ok: false, reason: `port ${port} not allowed` };
    }
    const creds = this.credsFor(s, host);
    if (creds.length === 0 && !hostMatchesAny(host, s.allowHosts)) {
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
    let upstream: { address: string; port: number };
    try {
      upstream = await this.resolve(host, port);
    } catch (e) {
      client.end("HTTP/1.1 403 Forbidden\r\n\r\n");
      this.record({ ...base, decision: "blocked", credentials: [], reason: errMsg(e) });
      return;
    }

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
    const up = net.connect({ host: upstream.address, port: upstream.port });
    let bytesUp = 0;
    let bytesDown = 0;
    up.on("connect", () => {
      client.write("HTTP/1.1 200 Connection Established\r\n\r\n");
      if (head.length) up.write(head);
      client.on("data", (c: Buffer) => (bytesUp += c.length));
      up.on("data", (c: Buffer) => (bytesDown += c.length));
      client.pipe(up);
      up.pipe(client);
    });
    let done = false;
    const finish = (err?: Error) => {
      if (done) return;
      done = true;
      client.destroy();
      up.destroy();
      this.record({ ...base, decision: "tunneled", credentials: [], durationMs: Date.now() - started, bytesUp, bytesDown, reason: err ? errMsg(err) : undefined });
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
    const plan: CredentialPlan = { permitted: new Set(), denied: [], aws: null, refuse: null, stale: [] };
    const rawPath = req.url ?? "/";
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
    const facts: RequestFacts = { method: req.method ?? "GET", host: ctx.host, path: u.pathname, query: u.searchParams, headers: req.headers, awsService };
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
          return sub === decoded ? val : `Basic ${Buffer.from(sub, "utf8").toString("base64")}`;
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
    return {
      host: ctx.upstream.address,
      port: ctx.upstream.port,
      servername: net.isIP(ctx.host) ? undefined : ctx.host,
      method: req.method,
      path: pathAndQuery,
      headers,
      agent: this.upstreamAgent,
      ...(ca ? { ca } : {}),
      checkServerIdentity: (_h, cert) => tls.checkServerIdentity(ctx.host, cert),
      timeout: 300_000,
    };
  }

  private redactor(s: ProxySession): Redactor | null {
    const pairs: { secret: Buffer; placeholder: Buffer }[] = [];
    for (const [ph, { ref, field }] of s.placeholders) {
      const c = this.connections.resolve(ref);
      const v = field && c?.aws ? c.aws[field as keyof typeof c.aws] : c?.value;
      if (v && v.length >= 6) pairs.push({ secret: Buffer.from(v), placeholder: Buffer.from(ph) });
    }
    return pairs.length ? new Redactor(pairs) : null;
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
    const base = { sessionId: ctx.session.sessionId, personaId: ctx.session.personaId, method: req.method ?? "GET", host: ctx.host, port: ctx.port, path: rawPath.split("?")[0] };
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
      const respHeaders: http.OutgoingHttpHeaders = {};
      for (const [k, v] of Object.entries(up.headers)) if (v !== undefined && !HOP_BY_HOP.has(k)) respHeaders[k] = v;
      if (plan.denied.length) respHeaders["x-swan-denied"] = this.deniedHeader(plan);
      const ct = String(up.headers["content-type"] ?? "");
      const textual = !ct || /json|text|xml|javascript|form-urlencoded|event-stream|graphql/i.test(ct);
      const red = textual && !up.headers["content-encoding"] ? this.redactor(ctx.session) : null;
      if (red) delete respHeaders["content-length"];
      res.writeHead(up.statusCode ?? 502, up.statusMessage, respHeaders);
      up.on("data", (c: Buffer) => (bytesDown += c.length));
      (red ? up.pipe(red) : up).pipe(res);
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
      this.record({ ...base, status: 502, decision: used.size ? "injected" : "inspected", credentials: [...used], denied: plan.denied, reason: errMsg(e), durationMs: Date.now() - started });
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
      this.record({ sessionId: ctx.session.sessionId, personaId: ctx.session.personaId, method: "UPGRADE", host: ctx.host, port: ctx.port, path: (req.url ?? "/").split("?")[0], status, decision: used.size ? "injected" : "inspected", credentials: [...used], denied: plan.denied });
    const upstream = https.request({ ...this.upstreamOptions(ctx, req, headers, this.substitute(req.url ?? "/", ctx.session, plan, used)), agent: false });
    upstream.on("upgrade", (up, upSocket, upHead) => {
      const lines = [`HTTP/1.1 ${up.statusCode} ${up.statusMessage}`];
      for (let i = 0; i < up.rawHeaders.length; i += 2) lines.push(`${up.rawHeaders[i]}: ${up.rawHeaders[i + 1]}`);
      socket.write(lines.join("\r\n") + "\r\n\r\n");
      if (upHead.length) socket.write(upHead);
      if (head.length) upSocket.write(head);
      upSocket.pipe(socket).pipe(upSocket);
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
    let upstreamAddr: { address: string; port: number };
    try {
      upstreamAddr = await this.resolve(host, port);
    } catch (e) {
      res.writeHead(403, { "content-type": "text/plain" }).end(`blocked: ${errMsg(e)}\n`);
      this.record({ ...base, decision: "blocked", credentials: [], reason: errMsg(e) });
      return;
    }
    const headers: http.OutgoingHttpHeaders = {};
    for (const [k, v] of Object.entries(req.headers)) if (v !== undefined && !HOP_BY_HOP.has(k)) headers[k] = v;
    const upstream = http.request({ host: upstreamAddr.address, port: upstreamAddr.port, method: req.method, path: url.pathname + url.search, headers: { ...headers, host: url.host } }, (up) => {
      const h: http.OutgoingHttpHeaders = {};
      for (const [k, v] of Object.entries(up.headers)) if (v !== undefined && !HOP_BY_HOP.has(k)) h[k] = v;
      res.writeHead(up.statusCode ?? 502, h);
      up.pipe(res);
      up.on("end", () => this.record({ ...base, status: up.statusCode, decision: "inspected", credentials: [], durationMs: Date.now() - started }));
    });
    upstream.on("error", (e) => {
      if (!res.headersSent) res.writeHead(502).end();
      this.record({ ...base, status: 502, decision: "inspected", credentials: [], reason: errMsg(e) });
    });
    req.pipe(upstream);
  }
}

