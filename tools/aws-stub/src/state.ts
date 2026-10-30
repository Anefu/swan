import { randomBytes } from "node:crypto";
import type { Credentials } from "@ph/aws-sigv4";

export const ACCOUNT = "000000000000";

/** Long-lived keys the stub accepts out of the box. Not secrets: they only work against the stub. */
export const STUB_USER = {
  accessKeyId: "AKIASWANSTUB00000001",
  secretAccessKey: "swanStubSecretKey00000000000000000000001",
  arn: `arn:aws:iam::${ACCOUNT}:user/swan-dev`,
  userId: "AIDASWANSTUB00000001",
};

export const ROLES = ["ReadOnly", "Developer"] as const;
export type Role = (typeof ROLES)[number];

export interface Identity {
  arn: string;
  userId: string;
  account: string;
  role: Role | null; // null: the IAM user, which may do everything
}

interface Session extends Credentials {
  sessionToken: string;
  expiresAt: number;
  identity: Identity;
}

const rand = (n: number, alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567") =>
  Array.from(randomBytes(n), (b) => alphabet[b % alphabet.length]).join("");

export interface StubOptions {
  /** Lifetime of temporary credentials from AssumeRole and SSO, in seconds. */
  sessionSeconds: number;
  /** Lifetime of SSO access tokens and refresh tokens, in seconds. */
  accessTokenSeconds: number;
  refreshTokenSeconds: number;
  /** Approve device-code sign-ins without the browser step (for tests). */
  autoApprove: boolean;
}

export const DEFAULT_OPTIONS: StubOptions = { sessionSeconds: 3600, accessTokenSeconds: 3600, refreshTokenSeconds: 8 * 3600, autoApprove: false };

export interface K8sObject {
  apiVersion: string;
  kind: string;
  metadata: { name: string; namespace?: string; uid: string; creationTimestamp: string; labels?: Record<string, string>; resourceVersion?: string };
  spec?: Record<string, unknown>;
  status?: Record<string, unknown>;
  data?: Record<string, string>;
}

export class StubState {
  options: StubOptions;
  private sessions = new Map<string, Session>();
  buckets = new Map<string, Map<string, { body: Buffer; contentType: string; modified: Date }>>();
  logGroups = new Map<string, { created: number; events: { timestamp: number; message: string; logStreamName: string }[] }>();
  k8s = new Map<string, K8sObject[]>(); // "<cluster>/<resource>" -> objects
  clusters = ["swan-dev"];
  sso = {
    devices: new Map<string, { userCode: string; expiresAt: number; approved: boolean; role: Role }>(),
    accessTokens: new Map<string, { expiresAt: number; role: Role }>(),
    refreshTokens: new Map<string, { expiresAt: number; role: Role }>(),
  };
  /** Every authenticated request, newest last, for assertions in tests. */
  requests: { service: string; action: string; identity: string; allowed: boolean }[] = [];

  constructor(options: Partial<StubOptions> = {}) {
    this.options = { ...DEFAULT_OPTIONS, ...options };
    this.reset();
  }

  reset() {
    this.sessions.clear();
    this.buckets = new Map([["swan-demo", new Map([["README.txt", { body: Buffer.from("Objects in this bucket live in the AWS stub.\n"), contentType: "text/plain", modified: new Date() }]])]]);
    const t = Date.now();
    this.logGroups = new Map([
      ["/swan/payments", { created: t - 86_400_000, events: [
        { timestamp: t - 60_000, message: "payment accepted id=p-1001", logStreamName: "api-1" },
        { timestamp: t - 30_000, message: "payment declined id=p-1002 reason=insufficient_funds", logStreamName: "api-1" },
        { timestamp: t - 10_000, message: "payment accepted id=p-1003", logStreamName: "api-2" },
      ] }],
      ["/swan/dev", { created: t - 3_600_000, events: [{ timestamp: t - 5_000, message: "debug: stub log line", logStreamName: "dev" }] }],
    ]);
    this.k8s = seedKubernetes(this.clusters);
    this.sso.devices.clear();
    this.sso.accessTokens.clear();
    this.sso.refreshTokens.clear();
    this.requests = [];
  }

  lookup = (accessKeyId: string): Credentials | undefined => {
    if (accessKeyId === STUB_USER.accessKeyId) return STUB_USER;
    const s = this.sessions.get(accessKeyId);
    return s ? { accessKeyId: s.accessKeyId, secretAccessKey: s.secretAccessKey, sessionToken: s.sessionToken } : undefined;
  };

  /** Identity behind a verified access key, or "expired" for a temporary key past its expiry. */
  identity(accessKeyId: string): Identity | "expired" | undefined {
    if (accessKeyId === STUB_USER.accessKeyId) return { arn: STUB_USER.arn, userId: STUB_USER.userId, account: ACCOUNT, role: null };
    const s = this.sessions.get(accessKeyId);
    if (!s) return undefined;
    return s.expiresAt < Date.now() ? "expired" : s.identity;
  }

  issueSession(role: Role, sessionName: string, seconds = this.options.sessionSeconds): Session {
    const accessKeyId = `ASIA${rand(16)}`;
    const s: Session = {
      accessKeyId,
      secretAccessKey: rand(40, "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789"),
      sessionToken: `swanstub/${randomBytes(48).toString("base64")}`,
      expiresAt: Date.now() + seconds * 1000,
      identity: { arn: `arn:aws:sts::${ACCOUNT}:assumed-role/${role}/${sessionName}`, userId: `AROA${rand(16)}:${sessionName}`, account: ACCOUNT, role },
    };
    this.sessions.set(accessKeyId, s);
    return s;
  }

  /** Roles are deliberately simple: ReadOnly may only read, everyone else may do anything. */
  allows(identity: Identity, write: boolean): boolean {
    return !(write && identity.role === "ReadOnly");
  }
}

function seedKubernetes(clusters: string[]): Map<string, K8sObject[]> {
  const out = new Map<string, K8sObject[]>();
  const created = new Date(Date.now() - 3 * 86_400_000).toISOString();
  let n = 0;
  const meta = (name: string, namespace?: string, labels?: Record<string, string>) => ({
    name,
    ...(namespace ? { namespace } : {}),
    uid: `00000000-0000-4000-8000-${String(++n).padStart(12, "0")}`,
    creationTimestamp: created,
    resourceVersion: String(1000 + n),
    ...(labels ? { labels } : {}),
  });
  const pod = (name: string, ns: string, app: string, phase = "Running"): K8sObject => ({
    apiVersion: "v1",
    kind: "Pod",
    metadata: meta(name, ns, { app }),
    spec: { containers: [{ name: app, image: `registry.example/${app}:1.4.2` }], nodeName: "ip-10-0-1-23.ec2.internal" },
    status: { phase, containerStatuses: [{ name: app, ready: phase === "Running", restartCount: phase === "Running" ? 0 : 3 }] },
  });
  for (const c of clusters) {
    out.set(`${c}/namespaces`, ["default", "kube-system", "payments", "dev-alice"].map((ns) => ({ apiVersion: "v1", kind: "Namespace", metadata: meta(ns), status: { phase: "Active" } })));
    out.set(`${c}/pods`, [
      pod("payments-api-7f9c6d-x2k4p", "payments", "payments-api"),
      pod("payments-api-7f9c6d-q8w3n", "payments", "payments-api"),
      pod("payments-worker-5b7d8-zz9l1", "payments", "payments-worker", "CrashLoopBackOff"),
      pod("coredns-6d8c4-abcde", "kube-system", "coredns"),
      pod("scratch-shell", "dev-alice", "shell"),
    ]);
    out.set(`${c}/deployments`, [
      { apiVersion: "apps/v1", kind: "Deployment", metadata: meta("payments-api", "payments"), spec: { replicas: 2 }, status: { replicas: 2, readyReplicas: 2, availableReplicas: 2, updatedReplicas: 2 } },
      { apiVersion: "apps/v1", kind: "Deployment", metadata: meta("payments-worker", "payments"), spec: { replicas: 1 }, status: { replicas: 1, readyReplicas: 0, availableReplicas: 0, updatedReplicas: 1 } },
    ]);
    out.set(`${c}/configmaps`, [{ apiVersion: "v1", kind: "ConfigMap", metadata: meta("payments-config", "payments"), data: { LOG_LEVEL: "info" } }]);
    out.set(`${c}/secrets`, [{ apiVersion: "v1", kind: "Secret", metadata: meta("payments-db", "payments"), data: { password: Buffer.from("stub-password").toString("base64") } }]);
  }
  return out;
}
