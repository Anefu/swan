// The egress proxy end to end: a sandbox-side client signs and authenticates with placeholders,
// the proxy applies the persona's rules and swaps in (or re-signs with) the wrapper's real
// credentials, and the AWS/Kubernetes stub checks what arrives.
import { promises as fs } from "node:fs";
import http from "node:http";
import https from "node:https";
import type net from "node:net";
import path from "node:path";
import tls from "node:tls";
import { fileURLToPath } from "node:url";
import { CloudWatchLogsClient, FilterLogEventsCommand } from "@aws-sdk/client-cloudwatch-logs";
import { GetObjectCommand, PutObjectCommand, S3Client } from "@aws-sdk/client-s3";
import { GetCallerIdentityCommand, STSClient } from "@aws-sdk/client-sts";
import { presign, sign } from "@ph/aws-sigv4";
import { startStub, type StubServer } from "@ph/aws-stub/server";
import { makeTls } from "@ph/aws-stub/tls";
import { NodeHttpHandler } from "@smithy/node-http-handler";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { Rule } from "../connections/config.js";
import { ConnectionManager } from "../connections/manager.js";
import { newPlaceholder } from "../connections/placeholders.js";
import { ruleKey, type Verdict } from "../connections/rules.js";
import { SecretStore } from "../secrets.js";
import { paths, type Settings } from "../settings.js";
import { CertAuthority } from "./ca.js";
import { startCompanyProxy, type CompanyProxy } from "./company-proxy.fixture.js";
import { EgressProxy, type ProxySession } from "./egress.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const wrapper = path.resolve(here, "../../../../tools/aws-stub/bin/swan-stub-connection");
const AWS_URL = "https://api.aws.test";
const CLUSTER_URL = "https://swan-dev.k8s.aws.test";

let stub: StubServer;
let m: ConnectionManager;
let proxy: EgressProxy;
let ca: CertAuthority;
let proxyPort: number;
let session: ProxySession;
const asked: Verdict[] = [];
const denied: Verdict[] = [];
let askAnswer = true;

const rules = (): Rule[] => [
  { credential: "aws", api: "aws", allow: ["sts:GetCallerIdentity", "s3:Get*", "s3:List*", "logs:*"], ask: [], deny: ["iam:*"] },
  { credential: "eks", api: "kubernetes", allow: ["get *", "list *", "watch *"], ask: ["patch deployments in payments"], deny: ["* secrets"] },
];

beforeAll(async () => {
  const stubTls = makeTls(["*.aws.test", "*.k8s.aws.test"]);
  stub = await startStub({ tls: stubTls, autoApprove: true });
  // The wrapper runs on the host and talks to the stub directly.
  process.env.NODE_EXTRA_CA_CERTS = stubTls.caFile;
  await fs.mkdir(paths.connections, { recursive: true });
  await fs.mkdir(paths.ca, { recursive: true });
  await fs.mkdir(paths.audit, { recursive: true });
  await fs.writeFile(
    paths.config,
    `connections:\n  stub:\n    type: command\n    command: ["${wrapper}", --stub, "${stub.url}", --sandbox-url, "${AWS_URL}", --cluster-url, "${CLUSTER_URL}", --ca, "${stubTls.caFile}"]\n    hosts: ["*.aws.test"]\n`,
  );
  await fs.rm(paths.secretsYaml, { force: true });
  const secrets = new SecretStore();
  await secrets.load();
  m = new ConnectionManager(secrets, { providers: {} } as unknown as Settings);
  await m.loadConfig();
  const signedIn = await m.login("stub");
  if (signedIn !== "ready") {
    // Say why: the wrapper's message and its stderr log.
    const status = m.status().find((c) => c.name === "stub");
    const wrapperLog = await fs.readFile(path.join(paths.connections, "stub", "wrapper.log"), "utf8").catch(() => "(no wrapper.log)");
    throw new Error(`stub sign-in ended in "${signedIn}": ${status?.message ?? "no message"}\n${wrapperLog.slice(-4000)}`);
  }

  ca = await CertAuthority.load();
  const port = Number(new URL(stub.url).port);
  proxy = new EgressProxy(m, ca, {
    resolve: async (host) => {
      if (!host.endsWith(".aws.test")) throw new Error("not a test host");
      return { address: "127.0.0.1", port };
    },
  });
  proxyPort = await proxy.listen(0);
  proxy.credentialAsker = async (_s, _ref, v) => {
    asked.push(v);
    return askAnswer;
  };
  proxy.onDenied = (_s, _ref, v) => denied.push(v);

  const placeholders = new Map<string, { ref: string; field?: string }>();
  for (const field of ["accessKeyId", "secretAccessKey", "sessionToken"]) placeholders.set(newPlaceholder("stub/aws", field), { ref: "stub/aws", field });
  placeholders.set(newPlaceholder("stub/eks"), { ref: "stub/eks" });
  session = { sessionId: "s1", personaId: "p1", token: "t0ken", allowHosts: [], internalHosts: [], credentials: ["stub/aws", "stub/eks"], placeholders, rules: new Map([["stub", rules()]]), sessionAllowed: new Set() };
  proxy.register(session);
});

afterAll(async () => {
  proxy?.close();
  await stub?.close();
});

const ph = (ref: string, field?: string) => [...session.placeholders].find(([, v]) => v.ref === ref && v.field === field)![0];
const placeholderCreds = () => ({ accessKeyId: ph("stub/aws", "accessKeyId"), secretAccessKey: ph("stub/aws", "secretAccessKey"), sessionToken: ph("stub/aws", "sessionToken") });

/** An https.Agent that reaches every host through the proxy, trusting only Swan's CA: what the sandbox sees. */
function sandboxAgent(port = proxyPort): https.Agent {
  const agent = new https.Agent({ ca: ca.certPem, keepAlive: false });
  (agent as unknown as { createConnection: unknown }).createConnection = (opts: tls.ConnectionOptions & { host: string; port: number }, cb: (e: Error | null, s?: net.Socket) => void) => {
    const req = http.request({ host: "127.0.0.1", port, method: "CONNECT", path: `${opts.host}:${opts.port}`, headers: { "proxy-authorization": `Basic ${Buffer.from("s1:t0ken").toString("base64")}` } });
    req.on("connect", (res, socket) => {
      if (res.statusCode !== 200) return cb(new Error(`CONNECT ${res.statusCode}: ${res.headers["x-ph-reason"] ?? ""}`));
      cb(null, tls.connect({ socket, servername: opts.servername || opts.host, ca: ca.certPem }));
    });
    req.on("error", (e) => cb(e));
    req.end();
  };
  return agent;
}

const sdk = { endpoint: AWS_URL, region: "us-east-1", credentials: async () => placeholderCreds(), requestHandler: () => new NodeHttpHandler({ httpsAgent: sandboxAgent() }) };

function request(url: string, init: { method?: string; headers?: Record<string, string>; body?: string; port?: number } = {}) {
  return new Promise<{ status: number; headers: http.IncomingHttpHeaders; body: string }>((resolve, reject) => {
    const req = https.request(url, { method: init.method ?? "GET", headers: init.headers, agent: sandboxAgent(init.port) }, (res) => {
      let body = "";
      res.on("data", (c) => (body += c));
      res.on("end", () => resolve({ status: res.statusCode ?? 0, headers: res.headers, body }));
    });
    req.on("error", reject);
    req.end(init.body);
  });
}

describe("proxy with a command connection", () => {
  it("re-signs AWS requests the sandbox signed with placeholder keys", async () => {
    const me = await new STSClient({ ...sdk, requestHandler: sdk.requestHandler() }).send(new GetCallerIdentityCommand({}));
    expect(me.Arn).toMatch(/assumed-role\/ReadOnly\/swan-sso$/);
    const s3 = new S3Client({ ...sdk, forcePathStyle: true, requestHandler: sdk.requestHandler() });
    const obj = await s3.send(new GetObjectCommand({ Bucket: "swan-demo", Key: "README.txt" }));
    expect(await obj.Body!.transformToString()).toContain("Objects in this bucket");
    const logs = await new CloudWatchLogsClient({ ...sdk, requestHandler: sdk.requestHandler() }).send(new FilterLogEventsCommand({ logGroupName: "/swan/payments" }));
    expect(logs.events?.length).toBeGreaterThan(0);
    const ev = proxy.events("s1").filter((e) => e.host === "api.aws.test").at(-1)!;
    expect(ev).toMatchObject({ decision: "injected", credentials: ["stub/aws"] });
    // The stub accepted the real signature; the real keys never show up in the audit.
    expect(stub.state.requests.at(-1)).toMatchObject({ service: "logs", action: "FilterLogEvents", identity: expect.stringContaining("ReadOnly"), allowed: true });
    const real = m.usable("stub/aws")!.aws!;
    expect(JSON.stringify(proxy.events())).not.toContain(real.secretAccessKey);
    expect(JSON.stringify(proxy.events())).not.toContain(real.accessKeyId);
  });

  it("sends a request no rule allows with the placeholder signature, and says so", async () => {
    const s3 = new S3Client({ ...sdk, forcePathStyle: true, requestHandler: sdk.requestHandler() });
    const before = denied.length;
    await expect(s3.send(new PutObjectCommand({ Bucket: "swan-demo", Key: "x.txt", Body: "hi" }))).rejects.toThrow();
    expect(denied.slice(before).map((v) => [v.rule, v.op.description])).toEqual([[null, "s3:PutObject swan-demo/x.txt"]]);
    expect(proxy.events("s1").at(-1)).toMatchObject({ decision: "inspected", credentials: [], denied: [{ credential: "stub/aws", rule: null }] });
  });

  it("judges an S3 request by its shape, not by a header that names another action", async () => {
    const target = `${AWS_URL}/swan-demo/README.txt?Action=GetObject`;
    const headers = sign({ method: "DELETE", url: target, headers: { host: "api.aws.test", "x-amz-target": "x.GetObject", "x-amz-content-sha256": "UNSIGNED-PAYLOAD" } }, placeholderCreds(), { service: "s3", region: "us-east-1" });
    const before = denied.length;
    const r = await request(target, { method: "DELETE", headers });
    expect(r.status).toBe(403); // the placeholder signature went upstream
    expect(denied.slice(before).map((v) => v.op.description)).toEqual(["s3:DeleteObject swan-demo/README.txt"]);
  });

  it("checks rules against the decoded path, and refuses targets that aren't a plain path", async () => {
    const auth = { authorization: `Bearer ${ph("stub/eks")}` };
    const escaped = await request(`${CLUSTER_URL}/api/v1/namespaces/payments/%73ecrets`, { headers: auth });
    expect(escaped.status).toBe(401);
    expect(escaped.headers["x-swan-denied"]).toBe('stub/eks: rule "* secrets"');
    for (const p of ["//api/v1/namespaces/payments/secrets", "/api/v1/namespaces/payments/pods/../secrets"]) {
      const r = await new Promise<{ status: number; body: string }>((resolve, reject) => {
        const req = https.request({ host: "swan-dev.k8s.aws.test", port: 443, path: p, headers: auth, agent: sandboxAgent() }, (res) => {
          let body = "";
          res.on("data", (c) => (body += c));
          res.on("end", () => resolve({ status: res.statusCode ?? 0, body }));
        });
        req.on("error", reject);
        req.end();
      });
      expect(r.status, p).toBe(400);
      expect(r.body).toMatch(/did not forward/);
    }
  });

  it("refuses presigned URLs and signatures that do not match the placeholder keys", async () => {
    const url = presign("GET", `${AWS_URL}/swan-demo/README.txt`, placeholderCreds(), { service: "s3", region: "us-east-1", expiresIn: 60 });
    const r = await request(url);
    expect(r.status).toBe(403);
    expect(r.body).toMatch(/cannot re-sign presigned URLs/);

    const wrong = { ...placeholderCreds(), secretAccessKey: "not-the-placeholder-secret-key-000000000" };
    const target = `${AWS_URL}/?Action=GetCallerIdentity&Version=2011-06-15`;
    const signed = sign({ method: "GET", url: target, headers: { host: "api.aws.test" } }, wrong, { service: "sts", region: "us-east-1" });
    const bad = await request(target, { headers: signed });
    expect(bad.status).toBe(403);
    expect(bad.body).toMatch(/not signed with this session's placeholder keys/);
  });

  it("substitutes the EKS token only for Kubernetes requests the rules allow", async () => {
    const auth = { authorization: `Bearer ${ph("stub/eks")}` };
    const pods = await request(`${CLUSTER_URL}/api/v1/namespaces/payments/pods`, { headers: auth });
    expect(pods.status).toBe(200);
    expect(JSON.parse(pods.body).items.length).toBeGreaterThan(0);

    const secrets = await request(`${CLUSTER_URL}/api/v1/namespaces/payments/secrets`, { headers: auth });
    expect(secrets.status).toBe(401); // the placeholder went upstream
    expect(secrets.headers["x-swan-denied"]).toBe('stub/eks: rule "* secrets"');

    askAnswer = true;
    const patch = await request(`${CLUSTER_URL}/apis/apps/v1/namespaces/payments/deployments/payments-api`, {
      method: "PATCH",
      headers: { ...auth, "content-type": "application/merge-patch+json" },
      body: JSON.stringify({ spec: { replicas: 3 } }),
    });
    expect(asked.at(-1)).toMatchObject({ mode: "ask", rule: "patch deployments in payments", op: { description: "patch deployments payments-api in payments" } });
    expect(patch.status).toBe(403); // authenticated as ReadOnly; the stub's RBAC said no

    askAnswer = false;
    const denied = await request(`${CLUSTER_URL}/apis/apps/v1/namespaces/payments/deployments/payments-api`, { method: "PATCH", headers: { ...auth, "content-type": "application/merge-patch+json" }, body: "{}" });
    expect(denied.status).toBe(401);

    // "Allow until stopped" for the matched rule skips the question.
    session.sessionAllowed.add(`stub/eks ${ruleKey("kubernetes", "patch deployments in payments")}`);
    const n = asked.length;
    await request(`${CLUSTER_URL}/apis/apps/v1/namespaces/payments/deployments/payments-api`, { method: "PATCH", headers: { ...auth, "content-type": "application/merge-patch+json" }, body: "{}" });
    expect(asked.length).toBe(n);
  });

  it("stops substituting an expired credential and says why the host is unreachable", async () => {
    const eks = m.resolve("stub/eks")!;
    const saved = eks.expiresAt;
    eks.expiresAt = Date.now() - 1000;
    try {
      await expect(request(`${CLUSTER_URL}/api/v1/pods`, { headers: { authorization: `Bearer ${ph("stub/eks")}` } })).rejects.toThrow(/CONNECT 403: credential stub\/eks expired/);
    } finally {
      eks.expiresAt = saved;
    }
  });
});

describe("credentials not from Swan", () => {
  // An agent told to use an attacker's token could send data to the attacker's account on a host
  // the persona can reach. On credential hosts, only this session's placeholders authenticate.
  const FOREIGN = "FOREIGN-token-0123456789abcdef";
  const foreignKeys = { accessKeyId: "AKIAFOREIGNEXAMPLE00", secretAccessKey: "foreign-secret-key-000000000000000000000" };
  const refusedFor = async (r: { status: number; body: string }, field: string) => {
    expect(r.status).toBe(403);
    expect(r.body).toContain(`it carries a credential that is not from Swan (${field})`);
  };

  it("refuses AWS requests signed or presigned with someone else's keys", async () => {
    const target = `${AWS_URL}/?Action=GetCallerIdentity&Version=2011-06-15`;
    const signed = sign({ method: "GET", url: target, headers: { host: "api.aws.test" } }, foreignKeys, { service: "sts", region: "us-east-1" });
    await refusedFor(await request(target, { headers: signed }), "Authorization");
    const url = presign("PUT", `${AWS_URL}/attacker-bucket/loot.txt`, foreignKeys, { service: "s3", region: "us-east-1", expiresIn: 60 });
    await refusedFor(await request(url, { method: "PUT", body: "data" }), "X-Amz-Credential");
  });

  it("refuses tokens, Basic auth, credential headers and query tokens that are not placeholders", async () => {
    const pods = `${CLUSTER_URL}/api/v1/namespaces/payments/pods`;
    await refusedFor(await request(pods, { headers: { authorization: `Bearer ${FOREIGN}` } }), "Authorization");
    await refusedFor(await request(pods, { headers: { authorization: `Basic ${Buffer.from(`me:${FOREIGN}`).toString("base64")}` } }), "Authorization");
    await refusedFor(await request(pods, { headers: { "x-api-key": FOREIGN } }), "x-api-key");
    await refusedFor(await request(`${pods}?access_token=${FOREIGN}`), "access_token in the query");
  });

  it("forwards anonymous requests and this session's placeholders, and never records the value", async () => {
    const pods = `${CLUSTER_URL}/api/v1/namespaces/payments/pods`;
    const anonymous = await request(pods);
    expect(anonymous.body).not.toContain("not from Swan");
    const mine = await request(pods, { headers: { authorization: `Bearer ${ph("stub/eks")}` } });
    expect(mine.status).toBe(200);
    expect(JSON.stringify(proxy.events())).not.toContain(FOREIGN);
    expect(proxy.events("s1").find((e) => e.reason?.includes("not from Swan"))).toMatchObject({ decision: "blocked", status: 403 });
  });

  it("tells the session once per refusal, and lets hosts listed in otherCredentials through", async () => {
    const told: string[] = [];
    proxy.onForeignCredential = (_s, host, field) => told.push(`${host} ${field}`);
    try {
      await request(`${CLUSTER_URL}/version`, { headers: { authorization: `Bearer ${FOREIGN}` } });
      expect(told).toEqual(["swan-dev.k8s.aws.test Authorization"]);
      session.otherCredentials = ["*.k8s.aws.test"];
      const allowed = await request(`${CLUSTER_URL}/version`, { headers: { authorization: `Bearer ${FOREIGN}` } });
      expect(allowed.body).not.toContain("not from Swan");
      expect(told).toHaveLength(1);
      // Only the listed host: AWS still refuses.
      const signed = sign({ method: "GET", url: `${AWS_URL}/`, headers: { host: "api.aws.test" } }, foreignKeys, { service: "sts", region: "us-east-1" });
      await refusedFor(await request(`${AWS_URL}/`, { headers: signed }), "Authorization");
    } finally {
      session.otherCredentials = undefined;
      proxy.onForeignCredential = null;
    }
  });
});

describe("proxy chained through a company proxy", () => {
  let company: CompanyProxy;
  let chained: EgressProxy;
  let chainedPort: number;
  beforeAll(async () => {
    const stubPort = Number(new URL(stub.url).port);
    company = await startCompanyProxy({ "api.aws.test:443": stubPort, "swan-dev.k8s.aws.test:443": stubPort });
    chained = new EgressProxy(m, ca, {
      resolve: async () => ({ address: "127.0.0.1", port: stubPort }), // never used for the connection: it goes to the proxy by name
      upstreamProxy: { url: company.url, noProxy: [] },
    });
    chainedPort = await chained.listen(0);
    chained.register(session);
  });
  afterAll(() => {
    chained?.close();
    company?.close();
  });

  const lastEvent = (host: string) =>
    vi.waitFor(() => {
      const e = chained.events("s1").filter((x) => x.host === host).at(-1);
      if (!e) throw new Error(`no event for ${host}`);
      return e;
    });

  it("re-signs AWS requests and sends them over a tunnel of the company proxy", async () => {
    const me = await new STSClient({ ...sdk, requestHandler: new NodeHttpHandler({ httpsAgent: sandboxAgent(chainedPort) }) }).send(new GetCallerIdentityCommand({}));
    expect(me.Arn).toMatch(/assumed-role\/ReadOnly\/swan-sso$/);
    expect(company.seen).toContain("CONNECT api.aws.test:443");
    expect(await lastEvent("api.aws.test")).toMatchObject({ decision: "injected", credentials: ["stub/aws"], via: "proxy" });
  });

  it("substitutes the EKS token through the company proxy, and still applies the rules", async () => {
    const auth = { authorization: `Bearer ${ph("stub/eks")}` };
    const pods = await request(`${CLUSTER_URL}/api/v1/namespaces/payments/pods`, { headers: auth, port: chainedPort });
    expect(pods.status).toBe(200);
    expect(company.seen).toContain("CONNECT swan-dev.k8s.aws.test:443");
    expect(await lastEvent("swan-dev.k8s.aws.test")).toMatchObject({ decision: "injected", credentials: ["stub/eks"], via: "proxy" });
    const secrets = await request(`${CLUSTER_URL}/api/v1/namespaces/payments/secrets`, { headers: auth, port: chainedPort });
    expect(secrets.status).toBe(401);
    expect(secrets.headers["x-swan-denied"]).toBe('stub/eks: rule "* secrets"');
  });

  it("answers 502 and records blocked when the company proxy refuses a credential host", async () => {
    const strict = await startCompanyProxy({}); // refuses everything
    const refusing = new EgressProxy(m, ca, { resolve: async () => ({ address: "127.0.0.1", port: 9 }), upstreamProxy: { url: strict.url, noProxy: [] } });
    try {
      const port = await refusing.listen(0);
      refusing.register(session);
      const r = await request(`${AWS_URL}/`, { port });
      expect(r.status).toBe(502);
      expect(r.body).toContain("the company proxy refused api.aws.test:443 (403 Forbidden)");
      expect(refusing.events("s1").filter((e) => e.host === "api.aws.test").at(-1)).toMatchObject({ decision: "blocked", via: "proxy", status: 502 });
    } finally {
      refusing.close();
      strict.close();
    }
  });
});
