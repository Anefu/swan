// Reference connection wrapper (Swan connection protocol v1) for the AWS stub.
//
//   swan-stub-connection <status|login|renew> [--stub URL] [--role ReadOnly] [--cluster swan-dev] [--region us-east-1]
//                        [--sandbox-url URL] [--cluster-url URL] [--ca FILE]
//
// --sandbox-url and --cluster-url are the addresses the sandbox uses for the AWS APIs and the
// cluster (they default to the stub's own); --ca attaches the PEM that signs them to each
// credential, so Swan's proxy can verify the stub upstream.
//
// It signs in with the stub's device-code flow, keeps its refresh token in the working directory
// (Swan runs wrappers in a private state directory per connection), and prints JSON Lines: an
// optional `device_code` line during login, then exactly one `result` line.
// A wrapper for a real identity tool has the same shape: run the tool, read what it produced,
// print the result.
import { promises as fs, readFileSync } from "node:fs";
import path from "node:path";
import { parseArgs } from "node:util";
import { presign, sign, type Credentials } from "@ph/aws-sigv4";
import { TOKEN_PREFIX } from "./k8s.js";

const { values, positionals } = parseArgs({
  allowPositionals: true,
  options: {
    stub: { type: "string", default: process.env.SWAN_STUB_URL ?? "http://127.0.0.1:4590" },
    role: { type: "string", default: "ReadOnly" },
    cluster: { type: "string", default: "swan-dev" },
    region: { type: "string", default: "us-east-1" },
    "state-dir": { type: "string", default: "." },
    "sandbox-url": { type: "string" },
    "cluster-url": { type: "string" },
    ca: { type: "string" },
  },
});
const verb = positionals[0];
const stub = values.stub!.replace(/\/$/, "");
const stateFile = path.join(values["state-dir"]!, "swan-stub-connection.json");
const sandboxUrl = (values["sandbox-url"] ?? stub).replace(/\/$/, "");
const caPem = values.ca ? readFileSync(values.ca, "utf8") : undefined;

interface Saved {
  refreshToken: string;
  refreshExpiresAt: number;
  accessToken?: string;
  accessExpiresAt?: number;
}

const out = (line: Record<string, unknown>) => process.stdout.write(`${JSON.stringify(line)}\n`);
const log = (msg: string) => process.stderr.write(`${msg}\n`);

async function post(url: string, body: Record<string, string>) {
  const res = await fetch(url, { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body: new URLSearchParams(body) });
  return { status: res.status, body: (await res.json()) as Record<string, unknown> };
}

async function load(): Promise<Saved | null> {
  try {
    return JSON.parse(await fs.readFile(stateFile, "utf8"));
  } catch {
    return null;
  }
}

async function save(s: Saved) {
  await fs.writeFile(stateFile, JSON.stringify(s), { mode: 0o600 });
}

function saveTokens(body: Record<string, unknown>, refreshExpiresAt?: number): Saved {
  return {
    refreshToken: String(body.refresh_token),
    refreshExpiresAt: refreshExpiresAt ?? Date.now() + Number(body.refresh_expires_in) * 1000,
    accessToken: String(body.access_token),
    accessExpiresAt: Date.now() + Number(body.expires_in) * 1000,
  };
}

/** Exchange the refresh token; null when the user has to sign in again. */
async function refresh(saved: Saved): Promise<Saved | null> {
  const r = await post(`${stub}/sso/token`, { grant_type: "refresh_token", refresh_token: saved.refreshToken });
  if (r.status !== 200) return null;
  const next = saveTokens(r.body);
  await save(next);
  return next;
}

async function login(): Promise<Saved> {
  const auth = await post(`${stub}/sso/device_authorization`, { role: values.role! });
  if (auth.status !== 200) throw new Error(`device authorization failed: ${auth.body.error_description ?? auth.status}`);
  const expiresAt = Date.now() + Number(auth.body.expires_in) * 1000;
  out({
    type: "device_code",
    verificationUri: auth.body.verification_uri,
    verificationUriComplete: auth.body.verification_uri_complete,
    userCode: auth.body.user_code,
    expiresAt: new Date(expiresAt).toISOString(),
  });
  while (Date.now() < expiresAt) {
    await new Promise((r) => setTimeout(r, Number(auth.body.interval ?? 1) * 1000));
    const t = await post(`${stub}/sso/token`, { grant_type: "urn:ietf:params:oauth:grant-type:device_code", device_code: String(auth.body.device_code) });
    if (t.status === 200) {
      const saved = saveTokens(t.body);
      await save(saved);
      return saved;
    }
    if (t.body.error !== "authorization_pending") throw new Error(`sign-in failed: ${t.body.error_description ?? t.body.error}`);
  }
  throw new Error("the sign-in code expired before it was approved");
}

async function describeCluster(creds: Credentials): Promise<{ endpoint: string; ca?: string }> {
  const url = `${stub}/clusters/${encodeURIComponent(values.cluster!)}`;
  const headers = { host: new URL(stub).host };
  const signed = sign({ method: "GET", url, headers }, creds, { service: "eks", region: values.region! });
  const res = await fetch(url, { headers: { ...headers, ...signed } });
  if (!res.ok) throw new Error(`DescribeCluster failed: ${res.status} ${await res.text()}`);
  const c = ((await res.json()) as { cluster: { endpoint: string; certificateAuthority?: { data?: string } } }).cluster;
  return { endpoint: c.endpoint, ca: c.certificateAuthority?.data };
}

async function ready(saved: Saved) {
  let s = saved;
  if (!s.accessToken || (s.accessExpiresAt ?? 0) < Date.now() + 30_000) {
    const next = await refresh(s);
    if (!next) return loginRequired();
    s = next;
  }
  const r = await fetch(`${stub}/sso/credentials`, { headers: { authorization: `Bearer ${s.accessToken}` } });
  if (r.status === 401) {
    const next = await refresh(s);
    if (!next) return loginRequired();
    return ready(next);
  }
  if (!r.ok) throw new Error(`role credentials failed: ${r.status}`);
  const rc = ((await r.json()) as { roleCredentials: { accessKeyId: string; secretAccessKey: string; sessionToken: string; expiration: number } }).roleCredentials;
  const creds = { accessKeyId: rc.accessKeyId, secretAccessKey: rc.secretAccessKey, sessionToken: rc.sessionToken };

  // An EKS token is a presigned GetCallerIdentity URL that also signs the cluster name.
  const signedAt = new Date();
  const presigned = presign("GET", `${stub}/?Action=GetCallerIdentity&Version=2011-06-15`, creds, {
    service: "sts",
    region: values.region!,
    date: signedAt,
    expiresIn: 60,
    headers: { "x-k8s-aws-id": values.cluster! },
  });
  const eksToken = TOKEN_PREFIX + Buffer.from(presigned).toString("base64url");
  const tokenExpiresAt = new Date(Math.min(signedAt.getTime() + 14 * 60_000, rc.expiration));
  const cluster = await describeCluster(creds);
  const server = values["cluster-url"] ?? cluster.endpoint.replace(stub, sandboxUrl);
  const clusterCa = caPem ?? (cluster.ca ? Buffer.from(cluster.ca, "base64").toString("utf8") : undefined);
  const kubeconfig = [
    "apiVersion: v1",
    "kind: Config",
    `current-context: ${values.cluster}`,
    "clusters:",
    `- name: ${values.cluster}`,
    "  cluster:",
    // No certificate-authority-data: Swan's proxy terminates TLS for credential hosts and checks
    // the cluster's certificate itself, with the CA attached to the credential.
    `    server: ${server}`,
    "contexts:",
    `- name: ${values.cluster}`,
    "  context:",
    `    cluster: ${values.cluster}`,
    "    user: swan",
    "users:",
    "- name: swan",
    "  user:",
    "    token: {{credential:eks}}",
    "",
  ].join("\n");

  out({
    type: "result",
    state: "ready",
    message: `Signed in to the AWS stub as ${values.role}`,
    expiresAt: tokenExpiresAt.toISOString(),
    credentials: [
      { name: "aws", kind: "aws-sigv4", ...creds, hosts: [new URL(sandboxUrl).hostname], expiresAt: new Date(rc.expiration).toISOString(), ...(caPem ? { ca: caPem } : {}) },
      { name: "eks", kind: "bearer", value: eksToken, hosts: [new URL(server).hostname], expiresAt: tokenExpiresAt.toISOString(), ...(clusterCa ? { ca: clusterCa } : {}) },
    ],
    files: [
      { path: "~/.aws/config", mode: "0644", content: `[profile swan-stub]\nregion = ${values.region}\nendpoint_url = ${sandboxUrl}\n` },
      {
        path: "~/.aws/credentials",
        content: "[swan-stub]\naws_access_key_id = {{credential:aws.accessKeyId}}\naws_secret_access_key = {{credential:aws.secretAccessKey}}\naws_session_token = {{credential:aws.sessionToken}}\n",
      },
      { path: "~/.kube/config", content: kubeconfig },
    ],
    env: { AWS_PROFILE: "swan-stub", KUBECONFIG: "/home/agent/.kube/config" },
  });
}

function loginRequired() {
  out({ type: "result", state: "login_required", message: "Sign in to the AWS stub to continue" });
}

async function main() {
  // Swan sends {"protocol":1,"connection":"…"} on stdin; this wrapper needs nothing from it.
  if (verb === "status") {
    const s = await load();
    if (!s || s.refreshExpiresAt < Date.now()) return loginRequired();
    return ready(s);
  }
  if (verb === "renew") {
    const s = await load();
    if (!s) return loginRequired();
    const next = await refresh(s);
    return next ? ready(next) : loginRequired();
  }
  if (verb === "login") return ready(await login());
  throw new Error(`unknown verb "${verb ?? ""}"; expected status, login or renew`);
}

main().catch((e) => {
  const message = e instanceof Error ? e.message : String(e);
  log(message);
  out({ type: "result", state: "error", message });
  process.exitCode = 1;
});
