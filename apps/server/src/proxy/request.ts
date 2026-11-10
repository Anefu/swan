// A request from the sandbox as the proxy reads it, and the checks on what it carries.
import type http from "node:http";
import { describeAuth } from "@ph/aws-sigv4";

const HOP_BY_HOP = new Set(["connection", "proxy-connection", "keep-alive", "proxy-authorization", "proxy-authenticate", "te", "trailer", "transfer-encoding", "upgrade"]);

export const first = (v: string | string[] | undefined) => (Array.isArray(v) ? v[0] : v);

/** The headers that pass from one hop to the next. */
export function forwardable(headers: http.IncomingHttpHeaders): [string, string | string[]][] {
  return Object.entries(headers).flatMap(([k, v]) => (v === undefined || HOP_BY_HOP.has(k) ? [] : [[k, v] as [string, string | string[]]]));
}

export function splitHostPort(s: string, defPort: number): { host: string; port: number } {
  const m = /^\[([^\]]+)\](?::(\d+))?$/.exec(s) ?? /^([^:]+)(?::(\d+))?$/.exec(s);
  if (!m) throw new Error("bad authority");
  return { host: m[1].toLowerCase(), port: m[2] ? Number(m[2]) : defPort };
}

/** One request to a credential host, read once. */
export interface RequestView {
  method: string;
  rawPath: string; // as sent
  url: URL; // rawPath against https://host
  headers: http.IncomingHttpHeaders;
  basic: string | null; // the decoded credentials of Authorization: Basic
  aws: ReturnType<typeof describeAuth>; // the AWS signature it carries, if any
}

export function viewRequest(req: http.IncomingMessage, host: string): RequestView {
  const rawPath = req.url ?? "/";
  const auth = first(req.headers.authorization)?.trim();
  const basic = auth ? /^basic\s+/i.exec(auth) : null;
  return {
    method: req.method ?? "GET",
    rawPath,
    url: new URL(rawPath, `https://${host}`),
    headers: req.headers,
    basic: basic ? Buffer.from(auth!.slice(basic[0].length), "base64").toString("utf8") : null,
    aws: describeAuth({ url: `https://${host}${rawPath}`, headers: req.headers }),
  };
}

// Where requests carry credentials, besides Authorization and AWS signatures. On a host bound to the
// session's credentials, a value here that holds none of the session's placeholders is someone
// else's credential: an agent told to use an attacker's token could send data to their account.
const CREDENTIAL_HEADERS = ["x-api-key", "private-token", "x-auth-token", "x-amz-security-token"];
const CREDENTIAL_QUERY = new Set(["access_token", "token", "api_key", "x-amz-security-token"]);

/** The field of a request that carries a credential not from this session, or null. Never its value. */
export function foreignCredential(r: RequestView, placeholders: string[], awsKeyIds: Set<string>, injectHeaders: string[]): string | null {
  const ours = (v: string) => placeholders.some((p) => v.includes(p));
  if (r.aws) {
    if (!awsKeyIds.has(r.aws.accessKeyId)) return r.aws.presigned ? "X-Amz-Credential" : "Authorization";
  } else {
    const auth = first(r.headers.authorization)?.trim();
    if (auth && !ours(auth) && !ours(r.basic ?? "")) return "Authorization";
  }
  for (const h of new Set([...CREDENTIAL_HEADERS, ...injectHeaders.map((x) => x.toLowerCase())])) {
    const v = h === "authorization" ? undefined : first(r.headers[h])?.trim();
    if (v && !ours(v)) return h;
  }
  for (const [k, v] of r.url.searchParams) if (CREDENTIAL_QUERY.has(k.toLowerCase()) && v && !ours(v)) return `${k} in the query`;
  return null;
}
