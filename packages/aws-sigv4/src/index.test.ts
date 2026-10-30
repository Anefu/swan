import { Sha256 } from "@aws-crypto/sha256-js";
import { HttpRequest } from "@smithy/protocol-http";
import { SignatureV4 } from "@smithy/signature-v4";
import { describe, expect, it } from "vitest";
import { canonicalQuery, parseAuthorization, presign, sign, uriEncode, verify, type Credentials } from "./index.js";

const creds: Credentials = { accessKeyId: "AKIDEXAMPLE", secretAccessKey: "wJalrXUtnFEMI/K7MDENG+bPxRfiCYEXAMPLEKEY" };
const date = new Date(Date.UTC(2015, 7, 30, 12, 36, 0));

// The reference implementation used by the AWS SDK for JavaScript.
async function smithySign(
  req: { method: string; host: string; path: string; query?: Record<string, string>; headers?: Record<string, string>; body?: string },
  c: Credentials,
  service: string,
  applyChecksum = true,
) {
  const signer = new SignatureV4({ credentials: c, service, region: "us-east-1", sha256: Sha256, uriEscapePath: service !== "s3", applyChecksum });
  const r = new HttpRequest({ method: req.method, protocol: "https:", hostname: req.host, path: req.path, query: req.query, headers: { host: req.host, ...req.headers }, body: req.body });
  const signed = await signer.sign(r, { signingDate: date });
  return signed.headers as Record<string, string>;
}

const lookup = (c: Credentials) => (id: string) => (id === c.accessKeyId ? c : undefined);

describe("sign", () => {
  it("matches the AWS test suite get-vanilla case", () => {
    const h = sign({ method: "GET", url: "https://example.amazonaws.com/", headers: { host: "example.amazonaws.com" } }, creds, { service: "service", region: "us-east-1", date });
    expect(h.authorization).toBe(
      "AWS4-HMAC-SHA256 Credential=AKIDEXAMPLE/20150830/us-east-1/service/aws4_request, SignedHeaders=host;x-amz-date, Signature=5fa00fa31553b73ebf1942676e86291e8372ff2a2260956d9b8aae1d763fbf31",
    );
  });

  const cases: { name: string; service: string; method: string; path: string; query?: Record<string, string>; headers?: Record<string, string>; body?: string }[] = [
    { name: "query with reserved characters", service: "sts", method: "GET", path: "/", query: { Action: "GetCallerIdentity", Version: "2011-06-15", Extra: "a b/c~*" } },
    { name: "form POST", service: "sts", method: "POST", path: "/", headers: { "content-type": "application/x-www-form-urlencoded; charset=utf-8" }, body: "Action=GetCallerIdentity&Version=2011-06-15" },
    { name: "JSON target", service: "logs", method: "POST", path: "/", headers: { "content-type": "application/x-amz-json-1.1", "x-amz-target": "Logs_20140328.DescribeLogGroups" }, body: "{}" },
    { name: "REST path that needs encoding", service: "eks", method: "GET", path: "/clusters/my%20cluster", query: {} },
  ];
  for (const c of cases) {
    it(`agrees with the AWS SDK: ${c.name}`, async () => {
      const ref = await smithySign({ ...c, host: `${c.service}.us-east-1.amazonaws.com` }, { ...creds, sessionToken: "token/with+chars=" }, c.service, false);
      const qs = Object.entries(c.query ?? {}).map(([k, v]) => `${uriEncode(k)}=${uriEncode(v)}`).join("&");
      const url = `https://${c.service}.us-east-1.amazonaws.com${c.path}${qs ? `?${qs}` : ""}`;
      const ours = sign({ method: c.method, url, headers: { host: `${c.service}.us-east-1.amazonaws.com`, ...c.headers }, body: c.body }, { ...creds, sessionToken: "token/with+chars=" }, { service: c.service, region: "us-east-1", date });
      expect(parseAuthorization(ours.authorization)?.signature).toBe(parseAuthorization(ref.authorization)?.signature);
    });
  }
});

describe("verify", () => {
  it("accepts a request signed by the AWS SDK and rejects tampering", async () => {
    const host = "logs.us-east-1.amazonaws.com";
    const headers = { "content-type": "application/x-amz-json-1.1", "x-amz-target": "Logs_20140328.FilterLogEvents" };
    const body = '{"logGroupName":"/swan/demo"}';
    const signed = await smithySign({ method: "POST", host, path: "/", headers, body }, creds, "logs");
    const req = { method: "POST", url: `https://${host}/`, headers: signed, body };
    const ok = verify(req, { lookup: lookup(creds), now: date });
    expect(ok).toMatchObject({ ok: true, service: "logs", region: "us-east-1", accessKeyId: "AKIDEXAMPLE" });

    // The SDK declares the body hash, so a changed body fails the digest check before the signature.
    expect(verify({ ...req, body: '{"logGroupName":"/other"}' }, { lookup: lookup(creds), now: date })).toMatchObject({ ok: false, code: "BadDigest" });
    expect(verify({ ...req, headers: { ...signed, "x-amz-target": "Logs_20140328.DeleteLogGroup" } }, { lookup: lookup(creds), now: date })).toMatchObject({ ok: false, code: "SignatureDoesNotMatch" });
    expect(verify(req, { lookup: () => ({ ...creds, secretAccessKey: "wrong" }), now: date })).toMatchObject({ ok: false, code: "SignatureDoesNotMatch" });
    expect(verify(req, { lookup: () => undefined, now: date })).toMatchObject({ ok: false, code: "InvalidAccessKeyId" });
    expect(verify(req, { lookup: lookup(creds), now: new Date(date.getTime() + 16 * 60_000) })).toMatchObject({ ok: false, code: "RequestExpired" });
  });

  it("checks the session token", async () => {
    const session = { ...creds, sessionToken: "session-1" };
    const signed = await smithySign({ method: "GET", host: "sts.amazonaws.com", path: "/", query: { Action: "GetCallerIdentity", Version: "2011-06-15" } }, session, "sts");
    const req = { method: "GET", url: "https://sts.amazonaws.com/?Action=GetCallerIdentity&Version=2011-06-15", headers: signed };
    expect(verify(req, { lookup: () => session, now: date }).ok).toBe(true);
    expect(verify(req, { lookup: () => ({ ...session, sessionToken: "session-2" }), now: date })).toMatchObject({ ok: false, code: "InvalidToken" });
  });

  it("round-trips its own signatures, including S3 paths signed as sent", () => {
    const url = "https://s3.us-east-1.amazonaws.com/bucket/dir/a%20b%2Bc.txt?x-id=PutObject";
    const headers = { host: "s3.us-east-1.amazonaws.com", "content-type": "text/plain" };
    const signed = sign({ method: "PUT", url, headers, body: "hello" }, creds, { service: "s3", region: "us-east-1", date });
    expect(verify({ method: "PUT", url, headers: { ...headers, ...signed }, body: "hello" }, { lookup: lookup(creds), now: date }).ok).toBe(true);
    expect(verify({ method: "PUT", url, headers: { ...headers, ...signed }, body: "bye" }, { lookup: lookup(creds), now: date })).toMatchObject({ ok: false, code: "BadDigest" });
  });
});

describe("presign", () => {
  it("agrees with the AWS SDK and verifies, with an implied header", async () => {
    const session = { ...creds, sessionToken: "tok" };
    const signer = new SignatureV4({ credentials: session, service: "sts", region: "us-east-1", sha256: Sha256 });
    const ref = await signer.presign(
      new HttpRequest({ method: "GET", protocol: "https:", hostname: "sts.us-east-1.amazonaws.com", path: "/", query: { Action: "GetCallerIdentity", Version: "2011-06-15" }, headers: { host: "sts.us-east-1.amazonaws.com", "x-k8s-aws-id": "swan-dev" } }),
      { signingDate: date, expiresIn: 60 },
    );
    const ours = presign("GET", "https://sts.us-east-1.amazonaws.com/?Action=GetCallerIdentity&Version=2011-06-15", session, {
      service: "sts",
      region: "us-east-1",
      date,
      expiresIn: 60,
      headers: { "x-k8s-aws-id": "swan-dev" },
    });
    expect(new URL(ours).searchParams.get("X-Amz-Signature")).toBe((ref.query as Record<string, string>)["X-Amz-Signature"]);

    const check = (now: Date, id = "swan-dev") => verify({ method: "GET", url: ours, headers: {} }, { lookup: () => session, now, impliedHeaders: { "x-k8s-aws-id": id }, maxPresignSeconds: 900 });
    expect(check(new Date(date.getTime() + 30_000)).ok).toBe(true);
    expect(check(new Date(date.getTime() + 30_000), "other-cluster")).toMatchObject({ ok: false, code: "SignatureDoesNotMatch" });
    expect(check(new Date(date.getTime() + 61_000))).toMatchObject({ ok: false, code: "RequestExpired" });
  });
});

describe("canonicalQuery", () => {
  it("sorts by encoded key and value and drops omitted keys", () => {
    expect(canonicalQuery("b=2&a=2&a=1&X-Amz-Signature=zz&c=%7E%20x", ["X-Amz-Signature"])).toBe("a=1&a=2&b=2&c=~%20x");
  });
});
