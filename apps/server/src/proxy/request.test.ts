import type http from "node:http";
import { sign } from "@ph/aws-sigv4";
import { describe, expect, it } from "vitest";
import { foreignCredential, forwardable, viewRequest } from "./request.js";

const req = (url: string, headers: http.IncomingHttpHeaders = {}, method = "GET") => ({ url, headers, method }) as http.IncomingMessage;
const PH = "ph_github_token_1";
const AKID = "AKIAPLACEHOLDER0001";
const foreign = (url: string, headers: http.IncomingHttpHeaders = {}, inject: string[] = []) => foreignCredential(viewRequest(req(url, headers), "api.example.com"), [PH], new Set([AKID]), inject);
const basic = (s: string) => `Basic ${Buffer.from(s).toString("base64")}`;

describe("a request's view", () => {
  it("reads the path, query, Basic credentials and AWS signature once", () => {
    const v = viewRequest(req("/repos?page=2", { authorization: `  ${basic(`x:${PH}`)}  ` }, "POST"), "api.example.com");
    expect(v).toMatchObject({ method: "POST", rawPath: "/repos?page=2", basic: `x:${PH}`, aws: null });
    expect(v.url.searchParams.get("page")).toBe("2");
    expect(viewRequest(req("/"), "h").basic).toBeNull();
  });

  it("passes on end-to-end headers only", () => {
    expect(forwardable({ "content-type": "a", connection: "close", "proxy-authorization": "x", "transfer-encoding": "chunked", accept: undefined }).map(([k]) => k)).toEqual(["content-type"]);
  });
});

describe("a credential not from Swan", () => {
  it("is found in Authorization, Basic or bearer, unless it holds a placeholder", () => {
    expect(foreign("/", { authorization: `Bearer ${PH}` })).toBeNull();
    expect(foreign("/", { authorization: basic(`user:${PH}`) })).toBeNull();
    expect(foreign("/", { authorization: "Bearer someone-elses-token" })).toBe("Authorization");
    expect(foreign("/", { authorization: basic("user:their-password") })).toBe("Authorization");
    expect(foreign("/", { authorization: `Basic\t${Buffer.from("user:their-password").toString("base64")}` })).toBe("Authorization");
  });

  it("is found in credential headers, injected headers and query tokens", () => {
    expect(foreign("/", { "x-api-key": "theirs" })).toBe("x-api-key");
    expect(foreign("/", { "x-api-key": PH })).toBeNull();
    expect(foreign("/", { "x-custom-auth": "theirs" }, ["X-Custom-Auth"])).toBe("x-custom-auth");
    expect(foreign("/items?access_token=theirs")).toBe("access_token in the query");
    expect(foreign(`/items?access_token=${PH}`)).toBeNull();
    expect(foreign("/items?page=theirs")).toBeNull();
  });

  it("is an AWS signature made with keys other than the session's placeholder keys", () => {
    const signed = (accessKeyId: string) =>
      sign({ method: "GET", url: "https://api.example.com/", headers: { host: "api.example.com" }, body: null }, { accessKeyId, secretAccessKey: "s" }, { service: "sts", region: "us-east-1" });
    expect(foreign("/", { host: "api.example.com", ...signed(AKID) })).toBeNull();
    expect(foreign("/", { host: "api.example.com", ...signed("AKIAREALKEYOFSOMEONE") })).toBe("Authorization");
    expect(foreign("/?X-Amz-Algorithm=AWS4-HMAC-SHA256&X-Amz-Credential=AKIAREALKEYOFSOMEONE%2F20260101%2Fus-east-1%2Fs3%2Faws4_request&X-Amz-Signature=x&X-Amz-SignedHeaders=host&X-Amz-Date=20260101T000000Z")).toBe("X-Amz-Credential");
  });
});
