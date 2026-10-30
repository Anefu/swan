// The stub is checked with the official AWS SDK as the client, so a passing test means real
// SigV4 signatures (and the SDK's request shapes) are accepted, not just our own.
import { CloudWatchLogsClient, CreateLogGroupCommand, DescribeLogGroupsCommand, FilterLogEventsCommand } from "@aws-sdk/client-cloudwatch-logs";
import { DescribeClusterCommand, EKSClient, ListClustersCommand } from "@aws-sdk/client-eks";
import { GetObjectCommand, ListBucketsCommand, ListObjectsV2Command, PutObjectCommand, S3Client } from "@aws-sdk/client-s3";
import { AssumeRoleCommand, GetCallerIdentityCommand, STSClient } from "@aws-sdk/client-sts";
import { presign, type Credentials } from "@ph/aws-sigv4";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { TOKEN_PREFIX } from "./k8s.js";
import { startStub, type StubServer } from "./server.js";
import { STUB_USER } from "./state.js";

let stub: StubServer;
beforeAll(async () => {
  stub = await startStub({ sessionSeconds: 3600 });
});
afterAll(() => stub.close());
beforeEach(() => stub.state.reset());

const user: Credentials = { accessKeyId: STUB_USER.accessKeyId, secretAccessKey: STUB_USER.secretAccessKey };
const cfg = (credentials: Credentials) => ({ endpoint: stub.url, region: "us-east-1", credentials });

async function assume(role: "ReadOnly" | "Developer"): Promise<Credentials> {
  const out = await new STSClient(cfg(user)).send(new AssumeRoleCommand({ RoleArn: `arn:aws:iam::000000000000:role/${role}`, RoleSessionName: "test" }));
  const c = out.Credentials!;
  return { accessKeyId: c.AccessKeyId!, secretAccessKey: c.SecretAccessKey!, sessionToken: c.SessionToken! };
}

function eksToken(creds: Credentials, cluster = "swan-dev", date = new Date()): string {
  const url = presign("GET", `${stub.url}/?Action=GetCallerIdentity&Version=2011-06-15`, creds, { service: "sts", region: "us-east-1", date, expiresIn: 60, headers: { "x-k8s-aws-id": cluster } });
  return TOKEN_PREFIX + Buffer.from(url).toString("base64url");
}

const kube = (path: string, token: string, init: RequestInit = {}) =>
  fetch(`${stub.url}/k8s/swan-dev${path}`, { ...init, headers: { authorization: `Bearer ${token}`, ...(init.headers as Record<string, string>) } });

describe("STS", () => {
  it("identifies the stub user and assumed roles", async () => {
    const me = await new STSClient(cfg(user)).send(new GetCallerIdentityCommand({}));
    expect(me.Arn).toBe(STUB_USER.arn);
    const ro = await new STSClient(cfg(await assume("ReadOnly"))).send(new GetCallerIdentityCommand({}));
    expect(ro.Arn).toMatch(/assumed-role\/ReadOnly\/test$/);
  });

  it("rejects a wrong secret, an unknown key and expired credentials", async () => {
    await expect(new STSClient(cfg({ ...user, secretAccessKey: "wrong" })).send(new GetCallerIdentityCommand({}))).rejects.toMatchObject({ name: "SignatureDoesNotMatch" });
    await expect(new STSClient(cfg({ ...user, accessKeyId: "AKIAUNKNOWN000000000" })).send(new GetCallerIdentityCommand({}))).rejects.toMatchObject({ name: "InvalidClientTokenId" });
    const short = stub.state.issueSession("ReadOnly", "short", -1);
    await expect(new STSClient(cfg(short)).send(new GetCallerIdentityCommand({}))).rejects.toMatchObject({ name: "ExpiredToken" });
  });
});

describe("S3", () => {
  it("lists, writes and reads objects, including SDK checksum trailers", async () => {
    const s3 = new S3Client({ ...cfg(await assume("Developer")), forcePathStyle: true });
    expect((await s3.send(new ListBucketsCommand({}))).Buckets?.map((b) => b.Name)).toEqual(["swan-demo"]);
    await s3.send(new PutObjectCommand({ Bucket: "swan-demo", Key: "dir/hello world.txt", Body: "hello from the sdk", ContentType: "text/plain" }));
    const listed = await s3.send(new ListObjectsV2Command({ Bucket: "swan-demo", Prefix: "dir/" }));
    expect(listed.Contents?.map((o) => o.Key)).toEqual(["dir/hello world.txt"]);
    const got = await s3.send(new GetObjectCommand({ Bucket: "swan-demo", Key: "dir/hello world.txt" }));
    expect(await got.Body?.transformToString()).toBe("hello from the sdk");
  });

  it("denies writes to ReadOnly", async () => {
    const s3 = new S3Client({ ...cfg(await assume("ReadOnly")), forcePathStyle: true });
    await expect(s3.send(new PutObjectCommand({ Bucket: "swan-demo", Key: "x", Body: "x" }))).rejects.toMatchObject({ name: "AccessDenied" });
    expect(stub.state.requests.at(-1)).toMatchObject({ service: "s3", action: "PutObject", allowed: false });
  });
});

describe("CloudWatch Logs and EKS", () => {
  it("serves JSON 1.1 targets and denies ReadOnly writes", async () => {
    const logs = new CloudWatchLogsClient(cfg(await assume("ReadOnly")));
    const groups = await logs.send(new DescribeLogGroupsCommand({ logGroupNamePrefix: "/swan/" }));
    expect(groups.logGroups?.map((g) => g.logGroupName)).toEqual(["/swan/payments", "/swan/dev"]);
    const ev = await logs.send(new FilterLogEventsCommand({ logGroupName: "/swan/payments", filterPattern: "declined" }));
    expect(ev.events?.map((e) => e.message)).toEqual(["payment declined id=p-1002 reason=insufficient_funds"]);
    await expect(logs.send(new CreateLogGroupCommand({ logGroupName: "/swan/new" }))).rejects.toMatchObject({ name: "AccessDeniedException" });
  });

  it("describes the cluster with an endpoint on the stub", async () => {
    const eks = new EKSClient(cfg(user));
    expect((await eks.send(new ListClustersCommand({}))).clusters).toEqual(["swan-dev"]);
    const c = await eks.send(new DescribeClusterCommand({ name: "swan-dev" }));
    expect(c.cluster?.endpoint).toBe(`${stub.url}/k8s/swan-dev`);
  });
});

describe("Kubernetes with EKS tokens", () => {
  it("lists pods and returns tables for kubectl", async () => {
    const token = eksToken(await assume("ReadOnly"));
    const list = (await (await kube("/api/v1/namespaces/payments/pods", token)).json()) as { items: { metadata: { name: string } }[] };
    expect(list.items.map((p) => p.metadata.name)).toHaveLength(3);
    const t = (await (await kube("/api/v1/pods", token, { headers: { accept: "application/json;as=Table;v=v1;g=meta.k8s.io,application/json" } })).json()) as { kind: string; rows: unknown[] };
    expect(t).toMatchObject({ kind: "Table" });
    expect(t.rows).toHaveLength(5);
    expect(await (await kube("/api/v1/namespaces/payments/pods/payments-worker-5b7d8-zz9l1/log", token)).text()).toContain("panic");
  });

  it("enforces the ReadOnly role like the built-in view role", async () => {
    const ro = eksToken(await assume("ReadOnly"));
    expect((await kube("/api/v1/namespaces/payments/pods/payments-api-7f9c6d-x2k4p", ro, { method: "DELETE" })).status).toBe(403);
    expect((await kube("/api/v1/namespaces/payments/secrets", ro)).status).toBe(403);
    expect(stub.state.requests.at(-1)).toMatchObject({ service: "kubernetes", action: "list secrets in payments", allowed: false });
    const dev = eksToken(await assume("Developer"));
    const patched = await kube("/apis/apps/v1/namespaces/payments/deployments/payments-api", dev, {
      method: "PATCH",
      headers: { "content-type": "application/merge-patch+json" },
      body: JSON.stringify({ spec: { replicas: 3 } }),
    });
    expect(((await patched.json()) as { spec: { replicas: number } }).spec.replicas).toBe(3);
  });

  it("rejects tokens for another cluster, stale tokens and garbage", async () => {
    const creds = await assume("Developer");
    expect((await kube("/api/v1/namespaces", eksToken(creds, "other"))).status).toBe(401);
    expect((await kube("/api/v1/namespaces", eksToken(creds, "swan-dev", new Date(Date.now() - 16 * 60_000)))).status).toBe(401);
    expect((await kube("/api/v1/namespaces", "k8s-aws-v1.bm90IGEgdXJs")).status).toBe(401);
    expect((await kube("/api/v1/namespaces", eksToken(creds))).status).toBe(200);
  });
});
