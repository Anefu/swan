import { describe, expect, it } from "vitest";
import type { Rule } from "./config.js";
import { classifyAws, classifyKubernetes, evaluate, patternError, ruleKey, type RequestFacts } from "./rules.js";

const req = (method: string, url: string, extra: Partial<RequestFacts> = {}): RequestFacts => {
  const u = new URL(url, "https://example.test");
  return { method, host: u.hostname, path: u.pathname, query: u.searchParams, headers: {}, ...extra };
};
const rule = (r: Partial<Rule> & Pick<Rule, "api">): Rule => ({ credential: "*", allow: [], ask: [], deny: [], ...r });

describe("kubernetes rules", () => {
  it("reads verb, resource, subresource and namespace from the request", () => {
    expect(classifyKubernetes(req("GET", "/api/v1/namespaces/payments/pods"))).toMatchObject({ verb: "list", resource: "pods", namespace: "payments" });
    expect(classifyKubernetes(req("GET", "/api/v1/namespaces/payments/pods/api-7f9"))).toMatchObject({ verb: "get", name: "api-7f9" });
    expect(classifyKubernetes(req("GET", "/api/v1/pods?watch=true"))).toMatchObject({ verb: "watch", resource: "pods", namespace: undefined });
    expect(classifyKubernetes(req("GET", "/api/v1/namespaces/p/pods/x/log"))).toMatchObject({ verb: "get", subresource: "log" });
    expect(classifyKubernetes(req("DELETE", "/api/v1/namespaces/p/pods/x")).description).toBe("delete pods x in p");
    expect(classifyKubernetes(req("DELETE", "/api/v1/namespaces/p/pods")).verb).toBe("deletecollection");
    expect(classifyKubernetes(req("PATCH", "/apis/apps/v1/namespaces/p/deployments/web"))).toMatchObject({ verb: "patch", resource: "deployments", group: "apps" });
    expect(classifyKubernetes(req("GET", "/api/v1/namespaces/dev"))).toMatchObject({ verb: "get", resource: "namespaces", name: "dev", namespace: undefined });
    expect(classifyKubernetes(req("GET", "/api/v1/namespaces/p/pods/x/exec", { headers: { connection: "Upgrade", upgrade: "websocket" } })).verb).toBe("create");
    expect(classifyKubernetes(req("GET", "/apis/apps/v1")).discovery).toBe(true);
    expect(classifyKubernetes(req("GET", "/metrics")).classified).toBe(false);
  });

  const ro = rule({ api: "kubernetes", allow: ["get *", "list *", "watch *"], ask: ["patch deployments in payments", "create pods/exec in dev-*"], deny: ["* secrets"] });

  it("applies deny, then ask, then allow, and denies anything unmatched", () => {
    const v = (method: string, url: string, h?: RequestFacts["headers"]) => evaluate("prod-eks", [ro], req(method, url, { headers: h ?? {} }));
    expect(v("GET", "/api/v1/namespaces/payments/pods").mode).toBe("allow");
    expect(v("GET", "/api/v1/namespaces/payments/pods/x/log")).toMatchObject({ mode: "allow", rule: "get *" });
    expect(v("GET", "/api/v1/namespaces/payments/secrets")).toMatchObject({ mode: "deny", rule: "* secrets" });
    expect(v("PATCH", "/apis/apps/v1/namespaces/payments/deployments/web")).toMatchObject({ mode: "ask", rule: "patch deployments in payments" });
    expect(v("PATCH", "/apis/apps/v1/namespaces/dev/deployments/web")).toMatchObject({ mode: "deny", rule: null });
    expect(v("POST", "/api/v1/namespaces/dev-alice/pods/x/exec").mode).toBe("ask");
    expect(v("POST", "/api/v1/namespaces/payments/pods/x/exec").mode).toBe("deny");
    expect(v("DELETE", "/api/v1/namespaces/payments/pods/x")).toMatchObject({ mode: "deny", rule: null, op: { suggestion: "delete pods in payments" } });
    // kubectl's discovery requests work with any kubernetes rule; other paths need "* *".
    expect(v("GET", "/apis").mode).toBe("allow");
    expect(v("GET", "/metrics").mode).toBe("deny");
    expect(evaluate("x", [rule({ api: "kubernetes", allow: ["* *"] })], req("GET", "/metrics")).mode).toBe("allow");
  });

  it("lets a rule name a subresource without granting the parent", () => {
    const logs = rule({ api: "kubernetes", allow: ["get pods/log"] });
    expect(evaluate("c", [logs], req("GET", "/api/v1/namespaces/p/pods/x/log")).mode).toBe("allow");
    expect(evaluate("c", [logs], req("GET", "/api/v1/namespaces/p/pods/x")).mode).toBe("deny");
    expect(evaluate("c", [rule({ api: "kubernetes", allow: ["get deployments.apps"] })], req("GET", "/apis/apps/v1/namespaces/p/deployments/w")).mode).toBe("allow");
  });

  it("honours allow-until-stopped for the matched ask rule only", () => {
    const allowed = new Set([ruleKey("kubernetes", "patch deployments in payments")]);
    expect(evaluate("c", [ro], req("PATCH", "/apis/apps/v1/namespaces/payments/deployments/web"), allowed).mode).toBe("allow");
    expect(evaluate("c", [ro], req("POST", "/api/v1/namespaces/dev-x/pods/p/exec"), allowed).mode).toBe("ask");
  });

  it("only applies rules whose credential glob matches", () => {
    expect(evaluate("prod-aws", [rule({ api: "kubernetes", credential: "prod-eks", allow: ["* *"] })], req("GET", "/api")).mode).toBe("deny");
  });
});

describe("aws rules", () => {
  const aws = (method: string, url: string, service: string, extra: Partial<RequestFacts> = {}) => req(method, url, { awsService: service, ...extra });

  it("reads the action from X-Amz-Target, the Action parameter or the S3 request form", () => {
    expect(classifyAws(aws("POST", "/", "logs", { headers: { "x-amz-target": "Logs_20140328.FilterLogEvents" } }))).toMatchObject({ service: "logs", action: "FilterLogEvents" });
    expect(classifyAws(aws("POST", "/", "sts", { headers: { "content-type": "application/x-www-form-urlencoded" }, body: Buffer.from("Action=GetCallerIdentity&Version=2011-06-15") })).action).toBe("GetCallerIdentity");
    expect(classifyAws(aws("GET", "/?Action=AssumeRole", "sts")).action).toBe("AssumeRole");
    expect(classifyAws(aws("GET", "/swan-demo/README.txt", "s3"))).toMatchObject({ action: "GetObject", description: "s3:GetObject swan-demo/README.txt" });
    expect(classifyAws(aws("GET", "/swan-demo?list-type=2", "s3")).action).toBe("ListBucket");
    expect(classifyAws(aws("GET", "/", "s3")).action).toBe("ListAllMyBuckets");
    expect(classifyAws(aws("PUT", "/k", "s3", { host: "b.s3.us-east-1.amazonaws.com" }))).toMatchObject({ action: "PutObject", description: "s3:PutObject b/k" });
    expect(classifyAws(aws("DELETE", "/b/k", "s3")).action).toBe("DeleteObject");
    expect(classifyAws(aws("GET", "/clusters/swan-dev", "eks")).action).toBe("DescribeCluster");
    expect(classifyAws(aws("GET", "/2015-03-31/functions", "lambda"))).toMatchObject({ classified: false, suggestion: "lambda:*" });
    expect(classifyAws(aws("POST", "/", "monitoring", { headers: { "x-amz-target": "GraniteServiceVersion20100801.GetMetricData" } })).service).toBe("cloudwatch");
  });

  it("matches service:Action globs case-insensitively", () => {
    const r = rule({ api: "aws", allow: ["sts:GetCallerIdentity", "s3:Get*", "s3:List*", "logs:*"], deny: ["iam:*"] });
    const v = (f: RequestFacts) => evaluate("prod-aws", [r], f).mode;
    expect(v(aws("GET", "/b/k", "s3"))).toBe("allow");
    expect(v(aws("PUT", "/b/k", "s3"))).toBe("deny");
    expect(v(aws("GET", "/?Action=getcalleridentity", "sts"))).toBe("allow");
    expect(v(aws("GET", "/?Action=ListUsers", "iam"))).toBe("deny");
    expect(v(aws("POST", "/", "logs", { headers: { "x-amz-target": "Logs_20140328.DeleteLogGroup" } }))).toBe("allow");
    // An action Swan cannot name only matches "<service>:*" or "*".
    expect(v(aws("GET", "/2015-03-31/functions", "lambda"))).toBe("deny");
    expect(evaluate("c", [rule({ api: "aws", allow: ["lambda:*"] })], aws("GET", "/2015-03-31/functions", "lambda")).mode).toBe("allow");
  });
});

describe("http rules", () => {
  it("matches METHOD /path with * in one segment and ** across segments", () => {
    const r = rule({ api: "http", allow: ["GET /repos/**", "GET /search/*"], ask: ["POST /repos/*/*/issues"] });
    const v = (m: string, p: string) => evaluate("t", [r], req(m, p)).mode;
    expect(v("GET", "/repos/a/b/pulls")).toBe("allow");
    expect(v("GET", "/repos")).toBe("allow");
    expect(v("GET", "/search/code")).toBe("allow");
    expect(v("GET", "/search/code/x")).toBe("deny");
    expect(v("POST", "/repos/a/b/issues")).toBe("ask");
    expect(v("DELETE", "/repos/a/b")).toBe("deny");
    expect(evaluate("t", [rule({ api: "http", allow: ["* /**"] })], req("PATCH", "/anything/at/all")).mode).toBe("allow");
  });
});

describe("pattern validation", () => {
  it("rejects patterns that do not parse for their api", () => {
    expect(patternError("kubernetes", "get pods in")).toMatch(/must look like/);
    expect(patternError("kubernetes", "list deployments in payments")).toBeNull();
    expect(patternError("aws", "s3 GetObject")).toMatch(/service:Action/);
    expect(patternError("http", "GET repos")).toMatch(/METHOD \/path/);
    expect(patternError("http", "* /**")).toBeNull();
  });
});
