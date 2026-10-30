// AWS Signature Version 4: signing, presigning and verification, with no dependencies.
//
// Used by the AWS stub to check requests and mint tokens, and by the egress proxy to re-sign
// requests that the sandbox signed with placeholder keys.
import { createHash, createHmac, timingSafeEqual } from "node:crypto";

export const ALGORITHM = "AWS4-HMAC-SHA256";
export const UNSIGNED_PAYLOAD = "UNSIGNED-PAYLOAD";
export const EMPTY_SHA256 = "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855";

export interface Credentials {
  accessKeyId: string;
  secretAccessKey: string;
  sessionToken?: string;
}

export type HeaderMap = Record<string, string | string[] | undefined>;

export interface SignableRequest {
  method: string;
  /** Absolute URL as sent on the wire (path and query already percent-encoded). */
  url: string;
  headers: HeaderMap;
  body?: Buffer | string | null;
}

export interface SignOptions {
  service: string;
  region: string;
  date?: Date;
  /** S3 signs the path as sent; every other service encodes each path segment again. */
  doubleEncodePath?: boolean;
  /** Overrides the payload hash (for example UNSIGNED-PAYLOAD or a streaming marker). */
  payloadHash?: string;
  /** Headers to sign besides host and x-amz-*; defaults to content-type and content-md5 when present. */
  signHeaders?: string[];
}

const sha256Hex = (data: Buffer | string) => createHash("sha256").update(data).digest("hex");
const hmac = (key: Buffer | string, data: string) => createHmac("sha256", key).update(data, "utf8").digest();

/** RFC 3986 encoding as AWS expects: everything except unreserved characters. */
export function uriEncode(s: string): string {
  return encodeURIComponent(s).replace(/[!'()*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`);
}

function safeDecode(s: string): string {
  try {
    return decodeURIComponent(s);
  } catch {
    return s;
  }
}

export function amzDate(d: Date): string {
  return d.toISOString().replace(/[-:]/g, "").replace(/\.\d{3}/, "");
}

/** 20150830T123600Z -> Date, or null. */
export function parseAmzDate(s: string): Date | null {
  const m = /^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})Z$/.exec(s);
  if (!m) return null;
  return new Date(Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +m[6]));
}

export function signingKey(secret: string, date: string, region: string, service: string): Buffer {
  return hmac(hmac(hmac(hmac(`AWS4${secret}`, date), region), service), "aws4_request");
}

function headerValue(headers: HeaderMap, name: string): string | undefined {
  for (const [k, v] of Object.entries(headers)) {
    if (k.toLowerCase() !== name) continue;
    if (v === undefined) return undefined;
    return Array.isArray(v) ? v.join(",") : v;
  }
  return undefined;
}

export function canonicalPath(rawPath: string, doubleEncode: boolean): string {
  if (!rawPath) return "/";
  if (!doubleEncode) return rawPath;
  const out: string[] = [];
  for (const seg of rawPath.split("/")) {
    if (seg === ".") continue;
    if (seg === "..") {
      out.pop();
      continue;
    }
    out.push(uriEncode(seg));
  }
  const p = out.join("/");
  return p.startsWith("/") ? p : `/${p}`;
}

/** Query string from the wire, decoded and re-encoded in canonical order. */
export function canonicalQuery(rawQuery: string, omit: string[] = []): string {
  if (!rawQuery) return "";
  const pairs: [string, string][] = [];
  for (const part of rawQuery.split("&")) {
    if (!part) continue;
    const i = part.indexOf("=");
    const k = safeDecode(i === -1 ? part : part.slice(0, i));
    const v = i === -1 ? "" : safeDecode(part.slice(i + 1));
    if (omit.includes(k)) continue;
    pairs.push([uriEncode(k), uriEncode(v)]);
  }
  pairs.sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : a[1] < b[1] ? -1 : a[1] > b[1] ? 1 : 0));
  return pairs.map(([k, v]) => `${k}=${v}`).join("&");
}

export function canonicalHeaders(headers: HeaderMap, signed: string[]): string {
  return signed
    .map((name) => `${name}:${(headerValue(headers, name) ?? "").trim().replace(/\s+/g, " ")}\n`)
    .join("");
}

export function canonicalRequest(
  method: string,
  url: URL,
  headers: HeaderMap,
  signed: string[],
  payloadHash: string,
  doubleEncodePath: boolean,
  omitQuery: string[] = [],
): string {
  const rawPath = url.pathname;
  const rawQuery = url.search.startsWith("?") ? url.search.slice(1) : url.search;
  return [
    method.toUpperCase(),
    canonicalPath(rawPath, doubleEncodePath),
    canonicalQuery(rawQuery, omitQuery),
    canonicalHeaders(headers, signed),
    signed.join(";"),
    payloadHash,
  ].join("\n");
}

export function stringToSign(amz: string, scope: string, canonical: string): string {
  return [ALGORITHM, amz, scope, sha256Hex(canonical)].join("\n");
}

function payloadHashFor(req: SignableRequest, override?: string): string {
  if (override) return override;
  const declared = headerValue(req.headers, "x-amz-content-sha256");
  if (declared) return declared;
  return req.body == null || req.body.length === 0 ? EMPTY_SHA256 : sha256Hex(req.body);
}

const isDoubleEncode = (opts: { service: string; doubleEncodePath?: boolean }) => opts.doubleEncodePath ?? opts.service !== "s3";

/**
 * Sign a request with an Authorization header. Returns the headers to set; the caller's headers
 * are not modified. `host` is taken from the headers, or from the URL when absent.
 */
export function sign(req: SignableRequest, creds: Credentials, opts: SignOptions): Record<string, string> {
  const url = new URL(req.url);
  const now = opts.date ?? new Date();
  const amz = amzDate(now);
  const day = amz.slice(0, 8);
  const payloadHash = payloadHashFor(req, opts.payloadHash);
  const added: Record<string, string> = { "x-amz-date": amz };
  if (creds.sessionToken) added["x-amz-security-token"] = creds.sessionToken;
  if (opts.service === "s3" && !headerValue(req.headers, "x-amz-content-sha256")) added["x-amz-content-sha256"] = payloadHash;
  const all: HeaderMap = { ...req.headers, ...added };
  if (!headerValue(all, "host")) all.host = url.host;

  const extra = opts.signHeaders ?? ["content-type", "content-md5"];
  const signed = [
    ...new Set(
      Object.keys(all)
        .map((k) => k.toLowerCase())
        .filter((k) => k === "host" || k.startsWith("x-amz-") || extra.includes(k))
        .filter((k) => headerValue(all, k) !== undefined),
    ),
  ].sort();
  const scope = `${day}/${opts.region}/${opts.service}/aws4_request`;
  const canonical = canonicalRequest(req.method, url, all, signed, payloadHash, isDoubleEncode(opts));
  const signature = createHmac("sha256", signingKey(creds.secretAccessKey, day, opts.region, opts.service))
    .update(stringToSign(amz, scope, canonical))
    .digest("hex");
  return {
    ...added,
    authorization: `${ALGORITHM} Credential=${creds.accessKeyId}/${scope}, SignedHeaders=${signed.join(";")}, Signature=${signature}`,
  };
}

export interface PresignOptions extends Omit<SignOptions, "signHeaders"> {
  expiresIn: number;
  /** Extra headers that become part of the signature (for example x-k8s-aws-id). */
  headers?: Record<string, string>;
}

/** Presign a URL (query-string authentication). Returns the full URL. */
export function presign(method: string, rawUrl: string, creds: Credentials, opts: PresignOptions): string {
  const url = new URL(rawUrl);
  const now = opts.date ?? new Date();
  const amz = amzDate(now);
  const day = amz.slice(0, 8);
  const scope = `${day}/${opts.region}/${opts.service}/aws4_request`;
  const headers: HeaderMap = { host: url.host };
  for (const [k, v] of Object.entries(opts.headers ?? {})) headers[k.toLowerCase()] = v;
  const signed = Object.keys(headers).sort();
  const q = url.searchParams;
  q.set("X-Amz-Algorithm", ALGORITHM);
  q.set("X-Amz-Credential", `${creds.accessKeyId}/${scope}`);
  q.set("X-Amz-Date", amz);
  q.set("X-Amz-Expires", String(opts.expiresIn));
  if (creds.sessionToken) q.set("X-Amz-Security-Token", creds.sessionToken);
  q.set("X-Amz-SignedHeaders", signed.join(";"));
  // Re-encode with RFC 3986 rules; URLSearchParams would use + for spaces.
  url.search = [...q.entries()].map(([k, v]) => `${uriEncode(k)}=${uriEncode(v)}`).join("&");
  const payloadHash = opts.payloadHash ?? (opts.service === "s3" ? UNSIGNED_PAYLOAD : EMPTY_SHA256);
  const canonical = canonicalRequest(method, url, headers, signed, payloadHash, isDoubleEncode(opts));
  const signature = createHmac("sha256", signingKey(creds.secretAccessKey, day, opts.region, opts.service))
    .update(stringToSign(amz, scope, canonical))
    .digest("hex");
  return `${url.toString()}&X-Amz-Signature=${signature}`;
}

export interface ParsedAuth {
  accessKeyId: string;
  date: string; // YYYYMMDD from the scope
  region: string;
  service: string;
  signedHeaders: string[];
  signature: string;
}

export function parseAuthorization(header: string): ParsedAuth | null {
  if (!header.startsWith(`${ALGORITHM} `)) return null;
  const fields: Record<string, string> = {};
  for (const part of header.slice(ALGORITHM.length + 1).split(",")) {
    const i = part.indexOf("=");
    if (i > 0) fields[part.slice(0, i).trim()] = part.slice(i + 1).trim();
  }
  const cred = fields.Credential?.split("/");
  if (!cred || cred.length !== 5 || cred[4] !== "aws4_request" || !fields.SignedHeaders || !fields.Signature) return null;
  return {
    accessKeyId: cred[0],
    date: cred[1],
    region: cred[2],
    service: cred[3],
    signedHeaders: fields.SignedHeaders.split(";"),
    signature: fields.Signature,
  };
}

/** Header auth or presigned query: which one a request uses, and its scope, without verifying. */
export function describeAuth(req: { url: string; headers: HeaderMap }): (ParsedAuth & { presigned: boolean }) | null {
  const auth = headerValue(req.headers, "authorization");
  if (auth) {
    const p = parseAuthorization(auth);
    return p ? { ...p, presigned: false } : null;
  }
  const q = new URL(req.url).searchParams;
  if (q.get("X-Amz-Algorithm") !== ALGORITHM) return null;
  const cred = q.get("X-Amz-Credential")?.split("/");
  if (!cred || cred.length !== 5) return null;
  return {
    accessKeyId: cred[0],
    date: cred[1],
    region: cred[2],
    service: cred[3],
    signedHeaders: (q.get("X-Amz-SignedHeaders") ?? "").split(";"),
    signature: q.get("X-Amz-Signature") ?? "",
    presigned: true,
  };
}

export type VerifyResult =
  | { ok: true; accessKeyId: string; service: string; region: string; sessionToken?: string; signedAt: Date; presigned: boolean }
  | { ok: false; code: "MissingAuthentication" | "IncompleteSignature" | "InvalidAccessKeyId" | "InvalidToken" | "SignatureDoesNotMatch" | "RequestExpired" | "BadDigest"; message: string };

export interface VerifyOptions {
  lookup: (accessKeyId: string) => Credentials | undefined;
  now?: Date;
  /** Allowed clock skew for header auth; AWS uses 15 minutes. */
  maxSkewMs?: number;
  /** Values of headers the client signed but did not send (presigned tokens, e.g. x-k8s-aws-id). */
  impliedHeaders?: Record<string, string>;
  /** Longest validity accepted for a presigned request regardless of X-Amz-Expires. */
  maxPresignSeconds?: number;
  /** Validity to apply instead of X-Amz-Expires (EKS accepts tokens for 15 minutes whatever they say). */
  presignLifetimeSeconds?: number;
}

const constantEq = (a: string, b: string) => a.length === b.length && timingSafeEqual(Buffer.from(a), Buffer.from(b));

/** Verify a request signed with header auth or a presigned query string. */
export function verify(req: SignableRequest, opts: VerifyOptions): VerifyResult {
  const url = new URL(req.url);
  const described = describeAuth(req);
  if (!described) return { ok: false, code: "MissingAuthentication", message: "Request is missing Authentication Token" };
  const { accessKeyId, date, region, service, signedHeaders, signature, presigned } = described;
  if (!signature || signedHeaders.length === 0 || !signedHeaders.includes("host"))
    return { ok: false, code: "IncompleteSignature", message: "The request signature is incomplete" };

  const creds = opts.lookup(accessKeyId);
  if (!creds) return { ok: false, code: "InvalidAccessKeyId", message: "The security token included in the request is invalid." };

  const now = opts.now ?? new Date();
  const q = url.searchParams;
  const amz = presigned ? (q.get("X-Amz-Date") ?? "") : (headerValue(req.headers, "x-amz-date") ?? "");
  const signedAt = parseAmzDate(amz);
  if (!signedAt || amz.slice(0, 8) !== date) return { ok: false, code: "IncompleteSignature", message: "Date in the credential scope does not match the request date" };

  const token = presigned ? q.get("X-Amz-Security-Token") ?? undefined : headerValue(req.headers, "x-amz-security-token");
  if ((creds.sessionToken ?? undefined) !== (token ?? undefined))
    return { ok: false, code: "InvalidToken", message: "The security token included in the request is invalid" };

  if (presigned) {
    const expires = opts.presignLifetimeSeconds ?? Number(q.get("X-Amz-Expires") ?? "0");
    const limit = Math.min(expires || 0, opts.maxPresignSeconds ?? 7 * 24 * 3600);
    const age = (now.getTime() - signedAt.getTime()) / 1000;
    if (!(expires > 0) || age > limit || age < -(opts.maxSkewMs ?? 15 * 60_000) / 1000)
      return { ok: false, code: "RequestExpired", message: "Request has expired" };
  } else if (Math.abs(now.getTime() - signedAt.getTime()) > (opts.maxSkewMs ?? 15 * 60_000)) {
    return { ok: false, code: "RequestExpired", message: "Signature expired: the request time is too far from the server time" };
  }

  const headers: HeaderMap = { ...req.headers };
  for (const [k, v] of Object.entries(opts.impliedHeaders ?? {})) if (headerValue(headers, k) === undefined) headers[k] = v;
  if (presigned && headerValue(headers, "host") === undefined) headers.host = url.host;

  const candidates: string[] = [];
  if (presigned) {
    const declared = q.get("X-Amz-Content-Sha256");
    candidates.push(...(declared ? [declared] : [EMPTY_SHA256, UNSIGNED_PAYLOAD]));
  } else {
    const declared = headerValue(req.headers, "x-amz-content-sha256");
    if (declared) {
      if (/^[0-9a-f]{64}$/.test(declared) && req.body != null && sha256Hex(req.body) !== declared)
        return { ok: false, code: "BadDigest", message: "The provided x-amz-content-sha256 header does not match what was computed." };
      candidates.push(declared);
    } else candidates.push(req.body == null || req.body.length === 0 ? EMPTY_SHA256 : sha256Hex(req.body));
  }

  const scope = `${date}/${region}/${service}/aws4_request`;
  const key = signingKey(creds.secretAccessKey, date, region, service);
  for (const doubleEncode of service === "s3" ? [false] : [true, false]) {
    for (const payloadHash of candidates) {
      const canonical = canonicalRequest(req.method, url, headers, signedHeaders, payloadHash, doubleEncode, presigned ? ["X-Amz-Signature"] : []);
      const expected = createHmac("sha256", key).update(stringToSign(amz, scope, canonical)).digest("hex");
      if (constantEq(expected, signature)) return { ok: true, accessKeyId, service, region, sessionToken: token, signedAt, presigned };
    }
  }
  return {
    ok: false,
    code: "SignatureDoesNotMatch",
    message: "The request signature we calculated does not match the signature you provided. Check your AWS Secret Access Key and signing method.",
  };
}
