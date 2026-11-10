// Credential use rules: what a persona may do with a credential, checked by the egress proxy on
// every request that would carry it. Precedence is deny, then ask, then allow; no match is deny.
import type { RuleApi } from "@ph/shared";
import type { Rule } from "./config.js";

export interface RequestFacts {
  method: string;
  host: string;
  path: string; // as sent, without the query string
  query: URLSearchParams;
  headers: Record<string, string | string[] | undefined>;
  body?: Buffer | null; // only needed for the AWS query protocol
  awsService?: string; // signing name from the SigV4 credential scope
}

export interface Operation {
  api: RuleApi;
  classified: boolean;
  description: string; // "delete pods api-7f9 in payments"
  suggestion: string; // an allow pattern that matches this request
  discovery?: boolean; // Kubernetes API metadata (/api, /apis, /version, /openapi)
  // kubernetes
  verb?: string;
  resource?: string;
  group?: string;
  subresource?: string;
  namespace?: string;
  name?: string;
  // aws
  service?: string;
  action?: string | null;
  // http
  method?: string;
  path?: string;
}

export interface Verdict {
  mode: "allow" | "ask" | "deny";
  rule: string | null; // matched pattern; null when no rule matched
  api: RuleApi;
  op: Operation;
}

const header = (h: RequestFacts["headers"], k: string) => {
  const v = h[k];
  return Array.isArray(v) ? v[0] : v;
};

function decodeSeg(s: string) {
  try {
    return decodeURIComponent(s);
  } catch {
    return s;
  }
}

/** Glob where `*` stays inside one path segment and `**` crosses segments. Case-sensitive unless told otherwise. */
function globRegex(pattern: string, opts: { segment?: boolean; nocase?: boolean } = {}): RegExp {
  let re = "";
  for (let i = 0; i < pattern.length; i++) {
    const c = pattern[i];
    if (c === "*") {
      if (pattern[i + 1] === "*") {
        // A trailing "/**" also matches the bare prefix.
        if (re.endsWith("\\/") && i + 2 === pattern.length) re = re.slice(0, -2) + "(?:\\/.*)?";
        else re += ".*";
        i++;
      } else re += opts.segment ? "[^/]*" : ".*";
    } else if (c === "?") re += opts.segment ? "[^/]" : ".";
    else re += c.replace(/[.+^${}()|[\]\\/]/g, "\\$&");
  }
  return new RegExp(`^${re}$`, opts.nocase ? "is" : "s");
}

const glob = (value: string, pattern: string, opts?: { segment?: boolean; nocase?: boolean }) => globRegex(pattern, opts).test(value);

// ---------- Kubernetes ----------

interface K8sPattern {
  verb: string;
  resource: string; // may include "/sub"
  namespace?: string;
}

function parseK8s(p: string): K8sPattern | string {
  const t = p.trim().split(/\s+/);
  if (t.length === 1 && t[0] === "*") return { verb: "*", resource: "*" };
  if (t.length === 2) return { verb: t[0].toLowerCase(), resource: t[1] };
  if (t.length === 4 && t[2] === "in") return { verb: t[0].toLowerCase(), resource: t[1], namespace: t[3] };
  return `"${p}" must look like "<verb> <resource>[/<subresource>] [in <namespace>]"`;
}

const DISCOVERY = /^\/(?:api|apis|version|openapi|healthz|livez|readyz|\.well-known)(?:\/|$)/;

export function classifyKubernetes(r: RequestFacts): Operation {
  const segs = r.path.split("/").filter(Boolean).map(decodeSeg);
  const unclassified = (): Operation => ({ api: "kubernetes", classified: false, description: `${r.method} ${r.path}`, suggestion: "*" });
  if (!DISCOVERY.test(r.path)) return unclassified();

  let group = "";
  let rest: string[];
  if (segs[0] === "api" && segs.length >= 2) rest = segs.slice(2);
  else if (segs[0] === "apis" && segs.length >= 3) {
    group = segs[1];
    rest = segs.slice(3);
  } else rest = [];
  const watchPath = rest[0] === "watch";
  if (watchPath) rest = rest.slice(1);
  if (rest.length === 0 && r.method === "GET")
    return { api: "kubernetes", classified: true, discovery: true, verb: "get", description: `read API metadata ${r.path}`, suggestion: "get *" };
  if (rest.length === 0) return unclassified();

  let namespace: string | undefined;
  if (rest[0] === "namespaces" && rest.length >= 3 && !(rest.length === 3 && (rest[2] === "status" || rest[2] === "finalize"))) {
    namespace = rest[1];
    rest = rest.slice(2);
  }
  const [resource, name, subresource] = rest;
  if (rest.length > 3) return unclassified();
  const watch = watchPath || /^(1|true)$/.test(r.query.get("watch") ?? "");
  const upgrade = /upgrade/i.test(header(r.headers, "connection") ?? "") || !!header(r.headers, "upgrade");
  let verb: string;
  switch (r.method) {
    case "GET":
    case "HEAD":
      verb = watch ? "watch" : subresource && upgrade && ["exec", "attach", "portforward"].includes(subresource) ? "create" : name ? "get" : "list";
      break;
    case "POST":
      verb = "create";
      break;
    case "PUT":
      verb = "update";
      break;
    case "PATCH":
      verb = "patch";
      break;
    case "DELETE":
      verb = name ? "delete" : "deletecollection";
      break;
    default:
      return unclassified();
  }
  const res = subresource ? `${resource}/${subresource}` : resource;
  return {
    api: "kubernetes",
    classified: true,
    verb,
    resource,
    group,
    subresource,
    namespace,
    name,
    description: `${verb} ${res}${name ? ` ${name}` : ""}${namespace ? ` in ${namespace}` : ""}`,
    suggestion: `${verb} ${res}${namespace ? ` in ${namespace}` : ""}`,
  };
}

function k8sResourceMatches(pattern: string, op: Operation): boolean {
  if (pattern === "*") return true; // like RBAC: every resource and subresource
  const res = op.resource ?? "";
  const names = op.group ? [res, `${res}.${op.group}`] : [res];
  const [pr, ps] = pattern.split("/", 2);
  return names.some((n) => glob(n, pr, { segment: true })) && (ps === undefined ? !op.subresource : glob(op.subresource ?? "", ps, { segment: true }) && !!op.subresource);
}

function matchK8s(p: K8sPattern, op: Operation): boolean {
  if (!op.classified) return p.verb === "*" && p.resource === "*" && !p.namespace;
  if (!glob(op.verb ?? "", p.verb)) return false;
  if (!k8sResourceMatches(p.resource, op)) return false;
  if (p.namespace !== undefined) return op.namespace !== undefined && glob(op.namespace, p.namespace, { segment: true });
  return true;
}

// ---------- AWS ----------

// Signing names whose IAM action prefix differs.
const IAM_PREFIX: Record<string, string> = { monitoring: "cloudwatch", email: "ses", "execute-api": "execute-api" };

function parseAws(p: string): { service: string; action: string } | string {
  const t = p.trim();
  if (t === "*") return { service: "*", action: "*" };
  const m = /^([a-z0-9*?-]+):([A-Za-z0-9*?]+)$/.exec(t);
  return m ? { service: m[1], action: m[2] } : `"${p}" must look like "service:Action"`;
}

function s3Action(r: RequestFacts): { action: string | null; target: string } {
  const vhost = /^(.+)\.s3(?:[.-][a-z0-9-]+)*\.amazonaws\.com$/.exec(r.host);
  const segs = r.path.split("/").filter(Boolean).map(decodeSeg);
  const bucket = vhost ? vhost[1] : segs[0];
  const key = (vhost ? segs : segs.slice(1)).join("/");
  const q = r.query;
  const has = (k: string) => q.has(k);
  const target = bucket ? `${bucket}${key ? `/${key}` : ""}` : "";
  const m = r.method;
  if (!bucket) return { action: m === "GET" ? "ListAllMyBuckets" : null, target };
  if (!key) {
    if (m === "GET" || m === "HEAD") {
      if (has("location")) return { action: "GetBucketLocation", target };
      if (has("versions")) return { action: "ListBucketVersions", target };
      if (has("uploads")) return { action: "ListBucketMultipartUploads", target };
      if (has("policy")) return { action: "GetBucketPolicy", target };
      if (has("acl")) return { action: "GetBucketAcl", target };
      if (has("tagging")) return { action: "GetBucketTagging", target };
      if (has("versioning")) return { action: "GetBucketVersioning", target };
      return { action: "ListBucket", target };
    }
    if (m === "PUT") {
      if (has("policy")) return { action: "PutBucketPolicy", target };
      if (has("acl")) return { action: "PutBucketAcl", target };
      if (has("tagging")) return { action: "PutBucketTagging", target };
      if (has("versioning")) return { action: "PutBucketVersioning", target };
      return { action: "CreateBucket", target };
    }
    if (m === "POST" && has("delete")) return { action: "DeleteObject", target };
    if (m === "DELETE") return { action: has("policy") ? "DeleteBucketPolicy" : "DeleteBucket", target };
    return { action: null, target };
  }
  if (m === "GET" || m === "HEAD") {
    if (has("acl")) return { action: "GetObjectAcl", target };
    if (has("tagging")) return { action: "GetObjectTagging", target };
    if (has("uploadId")) return { action: "ListMultipartUploadParts", target };
    return { action: has("versionId") ? "GetObjectVersion" : "GetObject", target };
  }
  if (m === "PUT") {
    if (has("acl")) return { action: "PutObjectAcl", target };
    if (has("tagging")) return { action: "PutObjectTagging", target };
    return { action: "PutObject", target };
  }
  if (m === "POST") return { action: has("uploads") || has("uploadId") ? "PutObject" : has("restore") ? "RestoreObject" : null, target };
  if (m === "DELETE") {
    if (has("uploadId")) return { action: "AbortMultipartUpload", target };
    if (has("tagging")) return { action: "DeleteObjectTagging", target };
    return { action: has("versionId") ? "DeleteObjectVersion" : "DeleteObject", target };
  }
  return { action: null, target };
}

function eksAction(r: RequestFacts): { action: string | null; target: string } {
  const s = r.path.split("/").filter(Boolean).map(decodeSeg);
  const m = r.method;
  if (s[0] !== "clusters") return { action: null, target: "" };
  if (s.length === 1) return { action: m === "GET" ? "ListClusters" : m === "POST" ? "CreateCluster" : null, target: "" };
  const target = s[1];
  if (s.length === 2) return { action: m === "GET" ? "DescribeCluster" : m === "DELETE" ? "DeleteCluster" : null, target };
  const sub = s[2];
  const table: Record<string, [string, string, string]> = {
    "node-groups": ["ListNodegroups", "DescribeNodegroup", "CreateNodegroup"],
    addons: ["ListAddons", "DescribeAddon", "CreateAddon"],
    "fargate-profiles": ["ListFargateProfiles", "DescribeFargateProfile", "CreateFargateProfile"],
    "access-entries": ["ListAccessEntries", "DescribeAccessEntry", "CreateAccessEntry"],
  };
  const t = table[sub];
  if (!t) return { action: null, target };
  if (m === "GET") return { action: s.length === 3 ? t[0] : t[1], target };
  if (m === "POST" && s.length === 3) return { action: t[2], target };
  if (m === "DELETE" && s.length === 4) return { action: t[1].replace(/^Describe/, "Delete"), target };
  return { action: null, target };
}

/**
 * The action, by the service's protocol. S3 and EKS are REST: the method and path are the action,
 * and they ignore X-Amz-Target and an Action parameter, so those can't be allowed to name it.
 * Elsewhere the action is in X-Amz-Target (JSON), or ?Action= or the form body (query); if more
 * than one is present and they disagree, the request is unclassified rather than trusted.
 */
export function classifyAws(r: RequestFacts): Operation {
  const signing = r.awsService ?? "";
  const service = IAM_PREFIX[signing] ?? signing;
  let action: string | null = null;
  let target = "";
  if (signing === "s3") ({ action, target } = s3Action(r));
  else if (signing === "eks") ({ action, target } = eksAction(r));
  else {
    const named = new Set<string>();
    const amzTarget = header(r.headers, "x-amz-target");
    if (amzTarget !== undefined) named.add(amzTarget.slice(amzTarget.lastIndexOf(".") + 1));
    for (const a of r.query.getAll("Action")) named.add(a);
    const ct = header(r.headers, "content-type") ?? "";
    if (r.body?.length && /x-www-form-urlencoded/i.test(ct)) for (const a of new URLSearchParams(r.body.toString("utf8")).getAll("Action")) named.add(a);
    action = named.size === 1 ? [...named][0]! || null : null;
  }
  if (action && !/^[A-Za-z0-9]{1,128}$/.test(action)) action = null;
  return {
    api: "aws",
    classified: !!service && !!action,
    service,
    action,
    description: `${service || "aws"}:${action ?? "?"}${target ? ` ${target}` : ""}${action ? "" : ` (${r.method} ${r.path})`}`,
    suggestion: `${service || "*"}:${action ?? "*"}`,
  };
}

function matchAws(p: { service: string; action: string }, op: Operation): boolean {
  if (!glob(op.service ?? "", p.service, { nocase: true })) return p.service === "*" && p.action === "*";
  if (!op.action) return p.action === "*";
  return glob(op.action, p.action, { nocase: true });
}

// ---------- http ----------

const UNRESERVED = /[A-Za-z0-9\-._~]/;

/**
 * The path rules are checked against. Escapes of unreserved characters mean the same to every
 * server (RFC 3986), so `/%61dmin` is checked as `/admin`; other escapes stay as sent, uppercased.
 * A target that isn't a single-slash path, or has dot segments, is refused: servers resolve those
 * differently, so no rule could say what it reaches.
 */
export function rulePath(target: string): { path: string } | { error: string } {
  if (!target.startsWith("/") || target.startsWith("//")) return { error: "the request target must be a path starting with a single /" };
  const raw = target.split("?", 1)[0]!;
  const path = raw.replace(/%([0-9A-Fa-f]{2})/g, (m, h: string) => {
    const c = String.fromCharCode(parseInt(h, 16));
    return UNRESERVED.test(c) ? c : m.toUpperCase();
  });
  if (path.split("/").some((seg) => seg === "." || seg === "..")) return { error: "the path has . or .. segments" };
  return { path };
}

function parseHttp(p: string): { method: string; path: string } | string {
  const m = /^(\S+)\s+(\/\S*)$/.exec(p.trim());
  return m ? { method: m[1].toUpperCase(), path: m[2] } : `"${p}" must look like "METHOD /path" (* any method, ** any path suffix)`;
}

export function classifyHttp(r: RequestFacts): Operation {
  return { api: "http", classified: true, method: r.method, path: r.path, description: `${r.method} ${r.path}`, suggestion: `${r.method} ${r.path}` };
}

// ---------- shared ----------

const parsers: Record<RuleApi, (p: string) => object | string> = { kubernetes: parseK8s, aws: parseAws, http: parseHttp };

/** null when the pattern is valid for its api, else the problem. */
export function patternError(api: RuleApi, pattern: string): string | null {
  const r = parsers[api](pattern);
  return typeof r === "string" ? r : null;
}

export function classify(api: RuleApi, r: RequestFacts): Operation {
  return api === "kubernetes" ? classifyKubernetes(r) : api === "aws" ? classifyAws(r) : classifyHttp(r);
}

function matches(api: RuleApi, pattern: string, op: Operation): boolean {
  const p = parsers[api](pattern);
  if (typeof p === "string") return false;
  if (api === "kubernetes") return matchK8s(p as K8sPattern, op);
  if (api === "aws") return matchAws(p as { service: string; action: string }, op);
  const h = p as { method: string; path: string };
  return glob(op.method ?? "", h.method, { nocase: true }) && glob(op.path ?? "", h.path, { segment: true });
}

export const ruleKey = (api: RuleApi, pattern: string) => `${api}:${pattern}`;

/**
 * Decide one request for one credential. `rules` are the persona's rules for the credential's
 * connection; `sessionAllowed` holds ask patterns the user allowed until stopped (ruleKey form).
 */
export function evaluate(credential: string, rules: Rule[], facts: RequestFacts, sessionAllowed: ReadonlySet<string> = new Set()): Verdict {
  const mine = rules.filter((r) => glob(credential, r.credential));
  const ops = new Map<RuleApi, Operation>();
  const opFor = (api: RuleApi) => {
    let op = ops.get(api);
    if (!op) ops.set(api, (op = classify(api, facts)));
    return op;
  };
  for (const r of mine) {
    const op = opFor(r.api);
    if (op.discovery) {
      const all = r.deny.find((p) => matchK8s(parseK8s(p) as K8sPattern, { ...op, classified: false }));
      if (all) return { mode: "deny", rule: all, api: r.api, op };
    } else {
      const hit = r.deny.find((p) => matches(r.api, p, op));
      if (hit) return { mode: "deny", rule: hit, api: r.api, op };
    }
  }
  for (const r of mine) {
    const op = opFor(r.api);
    if (op.discovery) return { mode: "allow", rule: "API discovery", api: r.api, op };
  }
  for (const r of mine) {
    const op = opFor(r.api);
    const hit = r.ask.find((p) => matches(r.api, p, op));
    if (hit) return { mode: sessionAllowed.has(ruleKey(r.api, hit)) ? "allow" : "ask", rule: hit, api: r.api, op };
  }
  for (const r of mine) {
    const op = opFor(r.api);
    const hit = r.allow.find((p) => matches(r.api, p, op));
    if (hit) return { mode: "allow", rule: hit, api: r.api, op };
  }
  const api = mine[0]?.api ?? "http";
  return { mode: "deny", rule: null, api, op: opFor(api) };
}

/** Presets offered in Settings, per rule language. */
export const PRESETS: Record<RuleApi, Record<string, { allow: string[]; ask: string[]; deny: string[] }>> = {
  kubernetes: {
    "Read-only": { allow: ["get *", "list *", "watch *"], ask: [], deny: ["* secrets"] },
    "Read + exec": { allow: ["get *", "list *", "watch *"], ask: ["create pods/exec", "create pods/portforward"], deny: ["* secrets"] },
    "Full access": { allow: ["* *"], ask: [], deny: [] },
  },
  aws: {
    "Read-only": { allow: ["*:Get*", "*:List*", "*:Describe*", "sts:GetCallerIdentity", "logs:FilterLogEvents"], ask: [], deny: ["iam:*"] },
    "Full access": { allow: ["*"], ask: [], deny: [] },
  },
  http: {
    "Read-only": { allow: ["GET /**", "HEAD /**"], ask: [], deny: [] },
    "Read + ask to write": { allow: ["GET /**", "HEAD /**"], ask: ["* /**"], deny: [] },
    "Full access": { allow: ["* /**"], ask: [], deny: [] },
  },
};
