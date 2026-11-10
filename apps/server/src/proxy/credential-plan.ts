// What one request to a credential host may carry under the persona's rules, and putting it there:
// placeholders swapped for values, injected headers, and AWS requests signed again with real keys.
import type http from "node:http";
import { sign, verify } from "@ph/aws-sigv4";
import type { ConnectionManager, ResolvedCredential } from "../connections/manager.js";
import { evaluate, rulePath, type RequestFacts, type Verdict } from "../connections/rules.js";
import { hostMatches } from "../util.js";
import type { ProxySession } from "./egress.js";
import { Redactor } from "./redactor.js";
import { first, foreignCredential, forwardable, type RequestView } from "./request.js";

// Payload markers the proxy can carry over to a new signature: the body itself is not signed.
const PASSTHROUGH_PAYLOAD = new Set(["UNSIGNED-PAYLOAD", "STREAMING-UNSIGNED-PAYLOAD-TRAILER"]);


/** The request's session and the host it goes to. */
export interface Target {
  session: ProxySession;
  host: string;
  port: number;
}

/** What one request may carry, after the persona's rules. */
export interface CredentialPlan {
  permitted: Set<string>; // refs to substitute, inject or re-sign
  denied: { credential: string; operation: string; rule: string | null }[];
  aws: { ref: string; real: NonNullable<ResolvedCredential["aws"]>; service: string; region: string; declaredPayload?: string } | null;
  refuse: { status: number; message: string } | null;
  stale: string[]; // placeholders of credentials that expired or lost their value
  echoes: { secret: string; placeholder: string }[]; // values as sent in this request, to scrub from echoes
}

/** Set by the session manager: how the user is asked, and told. */
export interface PlanHooks {
  /** A request matched an `ask` rule: resolves true when the person allowed it. */
  credentialAsker: ((s: ProxySession, ref: string, v: Verdict) => Promise<boolean>) | null;
  /** A request went out without its credential because of a rule (or no rule). */
  onDenied: ((s: ProxySession, ref: string, v: Verdict) => void) | null;
  /** A request to a credential host carried a credential not from Swan, and was refused. */
  onForeignCredential: ((s: ProxySession, host: string, field: string) => void) | null;
}

/** The credentials a request went without, and the rule that kept each, for an X-Swan-Denied header. */
export function deniedHeader(plan: CredentialPlan) {
  return plan.denied.map((d) => `${d.credential}: ${d.rule ? `rule "${d.rule}"` : "no rule"}`).join(", ");
}


export class CredentialPlanner {
  constructor(
    private connections: ConnectionManager,
    private hooks: PlanHooks,
  ) {}

  /** Usable credentials of this session bound to `host`. Read live, so edits and renewals apply now. */
  bound(s: ProxySession, host: string): ResolvedCredential[] {
    return s.credentials.flatMap((ref) => {
      const c = this.connections.usable(ref);
      return c && c.hosts.some((p) => hostMatches(host, p)) ? [c] : [];
    });
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
  async plan(r: RequestView, ctx: Target, body: () => Promise<Buffer | null>): Promise<CredentialPlan> {
    const s = ctx.session;
    const creds = this.bound(s, ctx.host);
    const usableRefs = new Set(creds.map((c) => c.ref));
    const plan: CredentialPlan = { permitted: new Set(), denied: [], aws: null, refuse: null, stale: [], echoes: [] };
    // TRACE echoes the request, credentials included, back to the sandbox.
    if (/^(TRACE|TRACK)$/i.test(r.method)) {
      plan.refuse = { status: 405, message: `Swan did not forward this request: ${r.method} isn't allowed to hosts that get credentials.` };
      return plan;
    }
    const checked = rulePath(r.rawPath);
    if ("error" in checked) {
      plan.refuse = { status: 400, message: `Swan did not forward this request: ${checked.error}.` };
      return plan;
    }

    if (!s.otherCredentials?.some((p) => hostMatches(ctx.host, p))) {
      const awsKeyIds = new Set([...s.placeholders].filter(([, v]) => v.field === "accessKeyId").map(([ph]) => ph));
      const injected = creds.flatMap((c) => (c.inject ? [c.inject.header] : []));
      const field = foreignCredential(r, [...s.placeholders.keys()], awsKeyIds, injected);
      if (field) {
        plan.refuse = {
          status: 403,
          message: `Swan did not forward this request: it carries a credential that is not from Swan (${field}). Use the persona's credentials; to allow others for this host, list it under network.otherCredentials.`,
        };
        this.hooks.onForeignCredential?.(s, ctx.host, field);
        return plan;
      }
    }
    const texts = [r.rawPath, ...Object.entries(r.headers).flatMap(([k, v]) => (k === "proxy-authorization" || v === undefined ? [] : Array.isArray(v) ? v : [v]))];
    if (r.basic !== null) texts.push(r.basic);
    const joined = texts.join("\n");

    const candidates = new Set<string>();
    for (const [ph, { ref }] of s.placeholders) {
      if (!joined.includes(ph)) continue;
      if (usableRefs.has(ref)) candidates.add(ref);
      else if (s.credentials.includes(ref) && this.connections.resolve(ref)?.hosts.some((p) => hostMatches(ctx.host, p))) plan.stale.push(ref);
    }
    for (const c of creds) if (c.inject && c.kind !== "aws-sigv4" && r.headers[c.inject.header.toLowerCase()] === undefined) candidates.add(c.ref);

    // AWS: the sandbox signed with this session's placeholder keys; the proxy re-signs.
    let awsService: string | undefined;
    const awsCreds = creds.filter((c) => c.kind === "aws-sigv4");
    if (awsCreds.length) {
      const described = r.aws;
      const mine = described && awsCreds.find((c) => this.placeholdersOf(s, c.ref).accessKeyId === described.accessKeyId);
      if (described && mine) {
        candidates.delete(mine.ref);
        const declared = first(r.headers["x-amz-content-sha256"]);
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

    const facts: RequestFacts = { method: r.method, host: ctx.host, path: checked.path, query: r.url.searchParams, headers: r.headers, awsService };
    // The query protocol names the action in a form body; other bodies are only read to re-sign.
    const form = /x-www-form-urlencoded/i.test(first(r.headers["content-type"]) ?? "");
    if (plan.aws && (!plan.aws.declaredPayload || (form && !PASSTHROUGH_PAYLOAD.has(plan.aws.declaredPayload)))) facts.body = await body();
    for (const ref of candidates) {
      const i = ref.indexOf("/");
      const conn = ref.slice(0, i);
      const name = ref.slice(i + 1);
      const rules = s.rules.get(conn) ?? [];
      const allowed = new Set([...s.sessionAllowed].filter((k) => k.startsWith(`${ref} `)).map((k) => k.slice(ref.length + 1)));
      const v = evaluate(name, rules, facts, allowed);
      let ok = v.mode === "allow";
      if (v.mode === "ask") ok = (await this.hooks.credentialAsker?.(s, ref, v)) ?? false;
      if (ok) plan.permitted.add(ref);
      else {
        plan.denied.push({ credential: ref, operation: v.op.description, rule: v.mode === "ask" ? `${v.rule} (denied by the user)` : v.rule });
        if (v.mode !== "ask") this.hooks.onDenied?.(s, ref, v);
      }
    }
    if (plan.aws && !plan.permitted.has(plan.aws.ref)) plan.aws = null;
    return plan;
  }

  /** Replace this session's placeholders for permitted credentials (never AWS keys, which are re-signed). */
  substitute(value: string, s: ProxySession, plan: CredentialPlan, used: Set<string>): string {
    for (const [ph, { ref }] of s.placeholders) {
      if (!value.includes(ph) || !plan.permitted.has(ref)) continue;
      const c = this.connections.usable(ref);
      if (!c?.value || c.kind === "aws-sigv4") continue;
      value = value.split(ph).join(c.value);
      used.add(ref);
    }
    return value;
  }

  headers(req: http.IncomingMessage, ctx: Target, plan: CredentialPlan, used: Set<string>): http.OutgoingHttpHeaders {
    const out: http.OutgoingHttpHeaders = {};
    for (const [k, v] of forwardable(req.headers)) {
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
  resign(req: http.IncomingMessage, ctx: Target, plan: CredentialPlan, headers: http.OutgoingHttpHeaders, body: Buffer | null, used: Set<string>): string | null {
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


  redactor(s: ProxySession, echoes: CredentialPlan["echoes"] = []): Redactor | null {
    const values: { secret: string; placeholder: string }[] = [];
    for (const [ph, { ref, field }] of s.placeholders) {
      const c = this.connections.resolve(ref);
      const v = field && c?.aws ? c.aws[field as keyof typeof c.aws] : c?.value;
      if (v && v.length >= 6) values.push({ secret: v, placeholder: ph });
    }
    return values.length || echoes.length ? new Redactor(Redactor.pairs(values, echoes)) : null;
  }


  /**
   * Opt-in (per credential, substituteInBody) placeholder swap in JSON or form bodies up to 1 MB with
   * a declared length. Anything else streams through untouched.
   */
  async substitutedBody(req: http.IncomingMessage, ctx: Target, plan: CredentialPlan, used: Set<string>, headers: http.OutgoingHttpHeaders, already?: Buffer | null): Promise<Buffer | null> {
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
}
