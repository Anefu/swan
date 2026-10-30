// A small Kubernetes API that authenticates EKS-style tokens: `k8s-aws-v1.` + base64url of a
// presigned STS GetCallerIdentity URL that also signs the `x-k8s-aws-id` header (the cluster name).
import { randomUUID } from "node:crypto";
import type { ServerResponse } from "node:http";
import { verify } from "@ph/aws-sigv4";
import { header, json, send, type Req } from "./http.js";
import type { Identity, K8sObject, StubState } from "./state.js";

export const TOKEN_PREFIX = "k8s-aws-v1.";

interface Kind {
  resource: string;
  kind: string;
  group: "" | "apps";
  namespaced: boolean;
  shortNames: string[];
}

const KINDS: Kind[] = [
  { resource: "namespaces", kind: "Namespace", group: "", namespaced: false, shortNames: ["ns"] },
  { resource: "pods", kind: "Pod", group: "", namespaced: true, shortNames: ["po"] },
  { resource: "configmaps", kind: "ConfigMap", group: "", namespaced: true, shortNames: ["cm"] },
  { resource: "secrets", kind: "Secret", group: "", namespaced: true, shortNames: [] },
  { resource: "deployments", kind: "Deployment", group: "apps", namespaced: true, shortNames: ["deploy"] },
];
const VERBS = ["create", "delete", "deletecollection", "get", "list", "patch", "update", "watch"];

function status(res: ServerResponse, code: number, reason: string, message: string) {
  json(res, code, { kind: "Status", apiVersion: "v1", metadata: {}, status: "Failure", message, reason, code });
}

/** Verify the bearer token for this cluster; returns the caller or writes a 401. */
export function authenticate(r: Req, res: ServerResponse, state: StubState, cluster: string): Identity | null {
  const auth = header(r, "authorization") ?? "";
  const token = auth.startsWith("Bearer ") ? auth.slice(7).trim() : "";
  const fail = (why: string) => {
    status(res, 401, "Unauthorized", `Unauthorized: ${why}`);
    return null;
  };
  if (!token.startsWith(TOKEN_PREFIX)) return fail("expected an EKS token (k8s-aws-v1.…)");
  let url: URL;
  try {
    url = new URL(Buffer.from(token.slice(TOKEN_PREFIX.length), "base64url").toString("utf8"));
  } catch {
    return fail("token does not decode to a URL");
  }
  if (url.searchParams.get("Action") !== "GetCallerIdentity") return fail("token is not a presigned GetCallerIdentity request");
  const v = verify({ method: "GET", url: url.toString(), headers: {} }, { lookup: state.lookup, impliedHeaders: { "x-k8s-aws-id": cluster }, presignLifetimeSeconds: 900 });
  if (!v.ok) return fail(`${v.code}: ${v.message}`);
  const id = state.identity(v.accessKeyId);
  if (!id) return fail("unknown access key");
  if (id === "expired") return fail("the credentials that signed this token have expired");
  return id;
}

const age = (iso: string) => {
  const s = Math.max(0, (Date.now() - Date.parse(iso)) / 1000);
  return s < 120 ? `${Math.floor(s)}s` : s < 7200 ? `${Math.floor(s / 60)}m` : s < 172_800 ? `${Math.floor(s / 3600)}h` : `${Math.floor(s / 86_400)}d`;
};

function table(kind: Kind, items: K8sObject[]) {
  const col = (name: string, type = "string", format = "") => ({ name, type, format, description: name, priority: 0 });
  let columns = [col("Name", "string", "name")];
  let cells = (o: K8sObject): unknown[] => [o.metadata.name];
  if (kind.resource === "pods") {
    columns = [col("Name", "string", "name"), col("Ready"), col("Status"), col("Restarts", "string"), col("Age")];
    cells = (o) => {
      const cs = (o.status?.containerStatuses as { ready: boolean; restartCount: number }[]) ?? [];
      return [o.metadata.name, `${cs.filter((c) => c.ready).length}/${cs.length}`, o.status?.phase ?? "Unknown", String(cs.reduce((n, c) => n + c.restartCount, 0)), age(o.metadata.creationTimestamp)];
    };
  } else if (kind.resource === "deployments") {
    columns = [col("Name", "string", "name"), col("Ready"), col("Up-to-date", "integer"), col("Available", "integer"), col("Age")];
    cells = (o) => [o.metadata.name, `${o.status?.readyReplicas ?? 0}/${o.spec?.replicas ?? 0}`, o.status?.updatedReplicas ?? 0, o.status?.availableReplicas ?? 0, age(o.metadata.creationTimestamp)];
  } else if (kind.resource === "namespaces") {
    columns = [col("Name", "string", "name"), col("Status"), col("Age")];
    cells = (o) => [o.metadata.name, o.status?.phase ?? "Active", age(o.metadata.creationTimestamp)];
  } else {
    columns = [col("Name", "string", "name"), col("Data", "integer"), col("Age")];
    cells = (o) => [o.metadata.name, Object.keys(o.data ?? {}).length, age(o.metadata.creationTimestamp)];
  }
  return {
    kind: "Table",
    apiVersion: "meta.k8s.io/v1",
    metadata: { resourceVersion: "1" },
    columnDefinitions: columns,
    rows: items.map((o) => ({ cells: cells(o), object: { kind: "PartialObjectMetadata", apiVersion: "meta.k8s.io/v1", metadata: o.metadata } })),
  };
}

function merge(target: Record<string, unknown>, patch: Record<string, unknown>) {
  for (const [k, v] of Object.entries(patch)) {
    if (v === null) delete target[k];
    else if (typeof v === "object" && !Array.isArray(v) && typeof target[k] === "object" && target[k] !== null && !Array.isArray(target[k]))
      merge(target[k] as Record<string, unknown>, v as Record<string, unknown>);
    else target[k] = v;
  }
}

export function handleKubernetes(r: Req, res: ServerResponse, state: StubState, cluster: string, path: string) {
  if (!state.clusters.includes(cluster)) return status(res, 404, "NotFound", `cluster ${cluster} does not exist in the stub`);
  const who = authenticate(r, res, state, cluster);
  if (!who) return;

  if (path === "/version" || path === "/version/") return json(res, 200, { major: "1", minor: "31", gitVersion: "v1.31.4-eks-stub", platform: "linux/amd64" });
  if (path === "/api") return json(res, 200, { kind: "APIVersions", versions: ["v1"], serverAddressByClientCIDRs: [{ clientCIDR: "0.0.0.0/0", serverAddress: r.url.host }] });
  if (path === "/apis")
    return json(res, 200, { kind: "APIGroupList", apiVersion: "v1", groups: [{ name: "apps", versions: [{ groupVersion: "apps/v1", version: "v1" }], preferredVersion: { groupVersion: "apps/v1", version: "v1" } }] });
  const resourceList = (group: "" | "apps") => {
    const resources = KINDS.filter((k) => k.group === group).flatMap((k) => [
      { name: k.resource, singularName: k.kind.toLowerCase(), namespaced: k.namespaced, kind: k.kind, verbs: VERBS, shortNames: k.shortNames },
      ...(k.resource === "pods" ? [{ name: "pods/log", singularName: "", namespaced: true, kind: "Pod", verbs: ["get"] }] : []),
    ]);
    return json(res, 200, { kind: "APIResourceList", apiVersion: "v1", groupVersion: group ? `${group}/v1` : "v1", resources });
  };
  if (path === "/api/v1") return resourceList("");
  if (path === "/apis/apps/v1") return resourceList("apps");

  const m = /^\/(?:api\/v1|apis\/apps\/v1)\/(.*)$/.exec(path);
  if (!m) return status(res, 404, "NotFound", "the server could not find the requested resource");
  const seg = m[1].split("/").filter(Boolean).map(decodeURIComponent);
  let ns: string | undefined, resource: string, name: string | undefined, sub: string | undefined;
  if (seg[0] === "namespaces" && seg.length >= 3) [, ns, resource, name, sub] = seg;
  else [resource, name, sub] = seg;
  const kind = KINDS.find((k) => k.resource === resource && (k.group === "apps") === path.startsWith("/apis/"));
  if (!kind) return status(res, 404, "NotFound", "the server could not find the requested resource");

  const watch = /^(1|true)$/.test(r.url.searchParams.get("watch") ?? "");
  const verb =
    r.method === "GET" ? (name ? "get" : watch ? "watch" : "list")
    : r.method === "POST" ? "create"
    : r.method === "PUT" ? "update"
    : r.method === "PATCH" ? "patch"
    : r.method === "DELETE" ? (name ? "delete" : "deletecollection")
    : "";
  const resName = sub ? `${resource}/${sub}` : resource;
  // ReadOnly mirrors the built-in "view" role: read verbs only, and never secrets.
  const allowed = who.role !== "ReadOnly" || (["get", "list", "watch"].includes(verb) && resource !== "secrets");
  state.requests.push({ service: "kubernetes", action: `${verb} ${resName}${ns ? ` in ${ns}` : ""}`, identity: who.arn, allowed });
  if (!allowed)
    return status(res, 403, "Forbidden", `${resName}${name ? ` "${name}"` : ""} is forbidden: User "${who.arn}" cannot ${verb} resource "${resName}" in API group "${kind.group}"${ns ? ` in the namespace "${ns}"` : " at the cluster scope"}`);

  const all = state.k8s.get(`${cluster}/${resource}`) ?? [];
  const scoped = kind.resource === "namespaces" ? all : all.filter((o) => !ns || o.metadata.namespace === ns);
  const one = name ? scoped.find((o) => o.metadata.name === name) : undefined;
  const notFound = () => status(res, 404, "NotFound", `${resource} "${name}" not found`);

  if (verb === "get") {
    if (!one) return notFound();
    if (sub === "log") {
      const lines = [`${new Date(Date.now() - 20_000).toISOString()} starting ${one.metadata.name}`, `${new Date(Date.now() - 10_000).toISOString()} listening on :8080`];
      if (one.status?.phase === "CrashLoopBackOff") lines.push(`${new Date().toISOString()} panic: connection refused (db)`);
      return send(res, 200, `${lines.join("\n")}\n`, "text/plain");
    }
    return json(res, 200, one);
  }
  if (verb === "list" || verb === "watch") {
    if ((header(r, "accept") ?? "").includes("as=Table")) return json(res, 200, table(kind, scoped));
    if (verb === "watch") {
      res.writeHead(200, { "content-type": "application/json" });
      for (const o of scoped) res.write(`${JSON.stringify({ type: "ADDED", object: o })}\n`);
      return res.end();
    }
    return json(res, 200, { kind: `${kind.kind}List`, apiVersion: kind.group ? "apps/v1" : "v1", metadata: { resourceVersion: "1" }, items: scoped });
  }
  if (verb === "delete") {
    if (!one) return notFound();
    state.k8s.set(`${cluster}/${resource}`, all.filter((o) => o !== one));
    return json(res, 200, one);
  }
  if (verb === "patch" || verb === "update") {
    if (!one) return notFound();
    let body: Record<string, unknown>;
    try {
      body = JSON.parse(r.body.toString("utf8"));
    } catch {
      return status(res, 400, "BadRequest", "the request body is not valid JSON");
    }
    if (verb === "patch") merge(one as unknown as Record<string, unknown>, body);
    else Object.assign(one, body, { metadata: { ...one.metadata, ...(body.metadata as object) } });
    return json(res, 200, one);
  }
  if (verb === "create") {
    let body: K8sObject;
    try {
      body = JSON.parse(r.body.toString("utf8"));
    } catch {
      return status(res, 400, "BadRequest", "the request body is not valid JSON");
    }
    const objName = body.metadata?.name;
    if (!objName) return status(res, 422, "Invalid", "metadata.name is required");
    if (scoped.some((o) => o.metadata.name === objName)) return status(res, 409, "AlreadyExists", `${resource} "${objName}" already exists`);
    const created: K8sObject = { ...body, metadata: { ...body.metadata, namespace: kind.namespaced ? ns : undefined, uid: randomUUID(), creationTimestamp: new Date().toISOString() } };
    state.k8s.set(`${cluster}/${resource}`, [...all, created]);
    return json(res, 201, created);
  }
  return status(res, 405, "MethodNotAllowed", `${r.method} is not supported for ${resource}`);
}
