import { createHash, randomUUID } from "node:crypto";
import type { ServerResponse } from "node:http";
import { decodeAwsChunked, esc, formParams, header, json, send, xml, type Req } from "./http.js";
import { ACCOUNT, ROLES, type Identity, type Role, type StubState } from "./state.js";

/** How each service reports errors (its protocol). */
type Protocol = "query" | "rest-xml" | "json" | "rest-json";
export const PROTOCOL: Record<string, Protocol> = { sts: "query", s3: "rest-xml", logs: "json", eks: "rest-json" };

export type AwsErrorKind = "Unrecognized" | "BadSignature" | "Expired" | "Skewed" | "AccessDenied" | "NotFound" | "Invalid" | "Unsupported";

const CODES: Record<AwsErrorKind, Record<Protocol, [number, string]>> = {
  Unrecognized: { query: [403, "InvalidClientTokenId"], "rest-xml": [403, "InvalidAccessKeyId"], json: [400, "UnrecognizedClientException"], "rest-json": [403, "UnrecognizedClientException"] },
  BadSignature: { query: [403, "SignatureDoesNotMatch"], "rest-xml": [403, "SignatureDoesNotMatch"], json: [400, "InvalidSignatureException"], "rest-json": [403, "InvalidSignatureException"] },
  Expired: { query: [403, "ExpiredToken"], "rest-xml": [400, "ExpiredToken"], json: [400, "ExpiredTokenException"], "rest-json": [403, "ExpiredTokenException"] },
  Skewed: { query: [403, "SignatureDoesNotMatch"], "rest-xml": [403, "RequestTimeTooSkewed"], json: [400, "InvalidSignatureException"], "rest-json": [403, "InvalidSignatureException"] },
  AccessDenied: { query: [403, "AccessDenied"], "rest-xml": [403, "AccessDenied"], json: [400, "AccessDeniedException"], "rest-json": [403, "AccessDeniedException"] },
  NotFound: { query: [404, "NoSuchEntity"], "rest-xml": [404, "NoSuchKey"], json: [400, "ResourceNotFoundException"], "rest-json": [404, "ResourceNotFoundException"] },
  Invalid: { query: [400, "ValidationError"], "rest-xml": [400, "InvalidRequest"], json: [400, "InvalidParameterException"], "rest-json": [400, "InvalidParameterException"] },
  Unsupported: { query: [400, "InvalidAction"], "rest-xml": [501, "NotImplemented"], json: [400, "UnknownOperationException"], "rest-json": [404, "UnknownOperationException"] },
};

export function awsError(res: ServerResponse, service: string, kind: AwsErrorKind, message: string, s3Code?: string) {
  const protocol = PROTOCOL[service] ?? "query";
  const [status, code0] = CODES[kind][protocol];
  const code = s3Code ?? code0;
  const id = randomUUID();
  if (protocol === "query")
    return xml(res, status, `<ErrorResponse xmlns="https://sts.amazonaws.com/doc/2011-06-15/"><Error><Type>Sender</Type><Code>${code}</Code><Message>${esc(message)}</Message></Error><RequestId>${id}</RequestId></ErrorResponse>`, { "x-amzn-requestid": id });
  if (protocol === "rest-xml") return xml(res, status, `<Error><Code>${code}</Code><Message>${esc(message)}</Message><RequestId>${id}</RequestId></Error>`, { "x-amz-request-id": id });
  if (protocol === "json") return json(res, status, { __type: code, message }, "application/x-amz-json-1.1", { "x-amzn-requestid": id });
  return json(res, status, { message }, "application/json", { "x-amzn-errortype": code, "x-amzn-requestid": id });
}

interface Ctx {
  r: Req;
  res: ServerResponse;
  state: StubState;
  identity: Identity;
  /** Base URL of this stub, for links in responses (EKS endpoints). */
  base: string;
  caData?: string;
}

/** Record the call and return whether the identity may make it. */
function authorize(c: Ctx, service: string, action: string, write: boolean): boolean {
  const allowed = c.state.allows(c.identity, write);
  c.state.requests.push({ service, action, identity: c.identity.arn, allowed });
  if (!allowed) awsError(c.res, service, "AccessDenied", `User: ${c.identity.arn} is not authorized to perform: ${service}:${action}`);
  return allowed;
}

export function handleAws(service: string, c: Ctx) {
  switch (service) {
    case "sts":
      return sts(c);
    case "s3":
      return s3(c);
    case "logs":
      return logs(c);
    case "eks":
      return eks(c);
    default:
      return awsError(c.res, service, "Unsupported", `The stub does not implement the ${service} service`);
  }
}

// ---------- STS (query protocol) ----------

const STS_NS = "https://sts.amazonaws.com/doc/2011-06-15/";

function sts(c: Ctx) {
  const p = formParams(c.r);
  const action = p.get("Action") ?? "";
  const meta = `<ResponseMetadata><RequestId>${randomUUID()}</RequestId></ResponseMetadata>`;
  if (action === "GetCallerIdentity") {
    if (!authorize(c, "sts", action, false)) return;
    return xml(c.res, 200, `<GetCallerIdentityResponse xmlns="${STS_NS}"><GetCallerIdentityResult><Arn>${c.identity.arn}</Arn><UserId>${c.identity.userId}</UserId><Account>${c.identity.account}</Account></GetCallerIdentityResult>${meta}</GetCallerIdentityResponse>`);
  }
  if (action === "AssumeRole") {
    if (!authorize(c, "sts", action, false)) return;
    const role = /^arn:aws:iam::\d{12}:role\/(.+)$/.exec(p.get("RoleArn") ?? "")?.[1] as Role | undefined;
    if (!role || !ROLES.includes(role)) return awsError(c.res, "sts", "AccessDenied", `Not authorized to assume ${p.get("RoleArn")}; the stub has roles ${ROLES.join(", ")}`);
    const name = p.get("RoleSessionName") ?? "swan";
    const seconds = Math.min(Number(p.get("DurationSeconds") ?? c.state.options.sessionSeconds), 43_200);
    const s = c.state.issueSession(role, name, seconds);
    return xml(c.res, 200, `<AssumeRoleResponse xmlns="${STS_NS}"><AssumeRoleResult><Credentials><AccessKeyId>${s.accessKeyId}</AccessKeyId><SecretAccessKey>${s.secretAccessKey}</SecretAccessKey><SessionToken>${esc(s.sessionToken)}</SessionToken><Expiration>${new Date(s.expiresAt).toISOString()}</Expiration></Credentials><AssumedRoleUser><AssumedRoleId>${s.identity.userId}</AssumedRoleId><Arn>${s.identity.arn}</Arn></AssumedRoleUser></AssumeRoleResult>${meta}</AssumeRoleResponse>`);
  }
  return awsError(c.res, "sts", "Unsupported", `Could not find operation ${action}`);
}

// ---------- S3 (REST-XML, path-style) ----------

const S3_NS = "http://s3.amazonaws.com/doc/2006-03-01/";
const etag = (b: Buffer) => `"${createHash("md5").update(b).digest("hex")}"`;

function s3(c: Ctx) {
  const { r, res, state } = c;
  const parts = r.url.pathname.split("/").filter(Boolean);
  const bucket = parts[0] ? decodeURIComponent(parts[0]) : undefined;
  const key = parts.length > 1 ? decodeURIComponent(parts.slice(1).join("/")) : undefined;
  const q = r.url.searchParams;
  const m = r.method;

  if (!bucket) {
    if (m !== "GET") return awsError(res, "s3", "Unsupported", "Unsupported request");
    if (!authorize(c, "s3", "ListAllMyBuckets", false)) return;
    const list = [...state.buckets.keys()].map((b) => `<Bucket><Name>${esc(b)}</Name><CreationDate>2026-01-01T00:00:00.000Z</CreationDate></Bucket>`).join("");
    return xml(res, 200, `<ListAllMyBucketsResult xmlns="${S3_NS}"><Owner><ID>${ACCOUNT}</ID><DisplayName>swan</DisplayName></Owner><Buckets>${list}</Buckets></ListAllMyBucketsResult>`);
  }

  const objects = state.buckets.get(bucket);
  if (!key) {
    if (m === "PUT") {
      if (!authorize(c, "s3", "CreateBucket", true)) return;
      if (objects) return awsError(res, "s3", "Invalid", "Your previous request to create the named bucket succeeded and you already own it.", "BucketAlreadyOwnedByYou");
      state.buckets.set(bucket, new Map());
      return send(res, 200, "", "text/plain", { location: `/${bucket}` });
    }
    if (!objects) return awsError(res, "s3", "NotFound", "The specified bucket does not exist", "NoSuchBucket");
    if (m === "DELETE") {
      if (!authorize(c, "s3", "DeleteBucket", true)) return;
      if (objects.size) return awsError(res, "s3", "Invalid", "The bucket you tried to delete is not empty", "BucketNotEmpty");
      state.buckets.delete(bucket);
      return send(res, 204, "", "text/plain");
    }
    if (m === "HEAD") return authorize(c, "s3", "ListBucket", false) && send(res, 200, "", "text/plain");
    if (q.has("location")) {
      if (!authorize(c, "s3", "GetBucketLocation", false)) return;
      return xml(res, 200, `<LocationConstraint xmlns="${S3_NS}"></LocationConstraint>`);
    }
    if (!authorize(c, "s3", "ListBucket", false)) return;
    const prefix = q.get("prefix") ?? "";
    const delimiter = q.get("delimiter") ?? "";
    const keys = [...objects.keys()].filter((k) => k.startsWith(prefix)).sort();
    const prefixes = new Set<string>();
    const contents: string[] = [];
    for (const k of keys) {
      const rest = k.slice(prefix.length);
      const cut = delimiter ? rest.indexOf(delimiter) : -1;
      if (cut !== -1) {
        prefixes.add(prefix + rest.slice(0, cut + delimiter.length));
        continue;
      }
      const o = objects.get(k)!;
      contents.push(`<Contents><Key>${esc(k)}</Key><LastModified>${o.modified.toISOString()}</LastModified><ETag>${esc(etag(o.body))}</ETag><Size>${o.body.length}</Size><StorageClass>STANDARD</StorageClass></Contents>`);
    }
    const common = [...prefixes].map((p) => `<CommonPrefixes><Prefix>${esc(p)}</Prefix></CommonPrefixes>`).join("");
    return xml(res, 200, `<ListBucketResult xmlns="${S3_NS}"><Name>${esc(bucket)}</Name><Prefix>${esc(prefix)}</Prefix>${delimiter ? `<Delimiter>${esc(delimiter)}</Delimiter>` : ""}<KeyCount>${contents.length + prefixes.size}</KeyCount><MaxKeys>1000</MaxKeys><IsTruncated>false</IsTruncated>${contents.join("")}${common}</ListBucketResult>`);
  }

  if (!objects) return awsError(res, "s3", "NotFound", "The specified bucket does not exist", "NoSuchBucket");
  if (m === "PUT") {
    if (!authorize(c, "s3", "PutObject", true)) return;
    const declared = header(r, "x-amz-content-sha256") ?? "";
    const chunked = declared.startsWith("STREAMING-") || (header(r, "content-encoding") ?? "").includes("aws-chunked");
    const body = chunked ? decodeAwsChunked(r.body) : r.body;
    objects.set(key, { body, contentType: header(r, "content-type") ?? "binary/octet-stream", modified: new Date() });
    return send(res, 200, "", "text/plain", { etag: etag(body) });
  }
  if (m === "DELETE") {
    if (!authorize(c, "s3", "DeleteObject", true)) return;
    objects.delete(key);
    return send(res, 204, "", "text/plain");
  }
  if (m === "GET" || m === "HEAD") {
    if (!authorize(c, "s3", "GetObject", false)) return;
    const o = objects.get(key);
    if (!o) return awsError(res, "s3", "NotFound", "The specified key does not exist.", "NoSuchKey");
    const headers = { etag: etag(o.body), "last-modified": o.modified.toUTCString(), "accept-ranges": "bytes" };
    if (m === "HEAD") {
      res.writeHead(200, { "content-type": o.contentType, "content-length": o.body.length, ...headers });
      return res.end();
    }
    return send(res, 200, o.body, o.contentType, headers);
  }
  return awsError(res, "s3", "Unsupported", "Unsupported request");
}

// ---------- CloudWatch Logs (JSON 1.1 with X-Amz-Target) ----------

function logs(c: Ctx) {
  const { r, res, state } = c;
  const action = (header(r, "x-amz-target") ?? "").replace(/^Logs_20140328\./, "");
  let input: Record<string, unknown> = {};
  try {
    input = r.body.length ? JSON.parse(r.body.toString("utf8")) : {};
  } catch {
    return awsError(res, "logs", "Invalid", "Request body is not valid JSON");
  }
  const reply = (v: unknown) => json(res, 200, v, "application/x-amz-json-1.1");
  const group = (name: unknown) => state.logGroups.get(String(name ?? ""));
  const arn = (name: string) => `arn:aws:logs:us-east-1:${ACCOUNT}:log-group:${name}:*`;
  const events = (g: NonNullable<ReturnType<typeof group>>, stream?: unknown, pattern?: unknown) =>
    g.events
      .filter((e) => !stream || e.logStreamName === stream)
      .filter((e) => !pattern || String(pattern).split(/\s+/).every((t) => e.message.includes(t.replace(/^"|"$/g, ""))))
      .map((e, i) => ({ ...e, ingestionTime: e.timestamp + 50, eventId: String(i).padStart(10, "0") }));

  switch (action) {
    case "DescribeLogGroups": {
      if (!authorize(c, "logs", action, false)) return;
      const prefix = String(input.logGroupNamePrefix ?? "");
      return reply({ logGroups: [...state.logGroups].filter(([n]) => n.startsWith(prefix)).map(([n, g]) => ({ logGroupName: n, creationTime: g.created, arn: arn(n), storedBytes: 1024 })) });
    }
    case "DescribeLogStreams": {
      if (!authorize(c, "logs", action, false)) return;
      const g = group(input.logGroupName);
      if (!g) return awsError(res, "logs", "NotFound", "The specified log group does not exist.");
      const streams = [...new Set(g.events.map((e) => e.logStreamName))];
      return reply({ logStreams: streams.map((s) => ({ logStreamName: s, creationTime: g.created, arn: `${arn(String(input.logGroupName)).slice(0, -2)}:log-stream:${s}` })) });
    }
    case "FilterLogEvents": {
      if (!authorize(c, "logs", action, false)) return;
      const g = group(input.logGroupName);
      if (!g) return awsError(res, "logs", "NotFound", "The specified log group does not exist.");
      return reply({ events: events(g, undefined, input.filterPattern), searchedLogStreams: [] });
    }
    case "GetLogEvents": {
      if (!authorize(c, "logs", action, false)) return;
      const g = group(input.logGroupName);
      if (!g) return awsError(res, "logs", "NotFound", "The specified log group does not exist.");
      return reply({ events: events(g, input.logStreamName).map(({ timestamp, message, ingestionTime }) => ({ timestamp, message, ingestionTime })), nextForwardToken: "f/0", nextBackwardToken: "b/0" });
    }
    case "CreateLogGroup": {
      if (!authorize(c, "logs", action, true)) return;
      const name = String(input.logGroupName ?? "");
      if (state.logGroups.has(name)) return awsError(res, "logs", "Invalid", "The specified log group already exists");
      state.logGroups.set(name, { created: Date.now(), events: [] });
      return reply({});
    }
    case "DeleteLogGroup": {
      if (!authorize(c, "logs", action, true)) return;
      if (!state.logGroups.delete(String(input.logGroupName ?? ""))) return awsError(res, "logs", "NotFound", "The specified log group does not exist.");
      return reply({});
    }
    default:
      return awsError(res, "logs", "Unsupported", `The stub does not implement logs:${action || "(no X-Amz-Target)"}`);
  }
}

// ---------- EKS (REST-JSON) ----------

function eks(c: Ctx) {
  const { r, res, state } = c;
  const m = /^\/clusters(?:\/([^/]+))?$/.exec(r.url.pathname);
  if (!m || r.method !== "GET") return awsError(res, "eks", "Unsupported", "The stub implements ListClusters and DescribeCluster");
  if (!m[1]) {
    if (!authorize(c, "eks", "ListClusters", false)) return;
    return json(res, 200, { clusters: state.clusters });
  }
  if (!authorize(c, "eks", "DescribeCluster", false)) return;
  const name = decodeURIComponent(m[1]);
  if (!state.clusters.includes(name)) return awsError(res, "eks", "NotFound", `No cluster found for name: ${name}.`);
  return json(res, 200, {
    cluster: {
      name,
      arn: `arn:aws:eks:us-east-1:${ACCOUNT}:cluster/${name}`,
      createdAt: 1767225600,
      version: "1.31",
      endpoint: `${c.base}/k8s/${name}`,
      status: "ACTIVE",
      platformVersion: "eks.1",
      certificateAuthority: c.caData ? { data: c.caData } : {},
      roleArn: `arn:aws:iam::${ACCOUNT}:role/eks-cluster`,
      resourcesVpcConfig: { endpointPublicAccess: true, endpointPrivateAccess: false },
    },
  });
}
