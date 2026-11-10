import Fastify from "fastify";
import { describe, expect, it } from "vitest";
import { hostAllowed, originAllowed, requestGuard } from "./api.js";

describe("API guards", () => {
  it("accepts only loopback Host names (DNS rebinding)", () => {
    for (const h of ["127.0.0.1:4317", "localhost:4317", "[::1]:4317", "127.0.0.1"]) expect(hostAllowed(h)).toBe(true);
    for (const h of [undefined, "", "evil.example", "evil.example:4317", "127.0.0.1.evil.example", "localhost.evil.example:4317"]) expect(hostAllowed(h)).toBe(false);
  });

  it("accepts the app's pages and local development pages, nothing else (CSRF)", () => {
    for (const o of [undefined, "swan://app", "http://127.0.0.1:4317", "http://localhost:5173"]) expect(originAllowed(o)).toBe(true);
    for (const o of ["null", "https://evil.example", "http://127.0.0.1.evil.example", "swan://app.evil", "swan://other", "file://", "chrome-extension://abc"])
      expect(originAllowed(o)).toBe(false);
  });
});

describe("the API token", () => {
  const TOKEN = "t0ken-for-tests-0123456789";
  const app = () => {
    const a = Fastify();
    a.addHook("onRequest", requestGuard(TOKEN));
    a.get("/", async () => "notice");
    a.get("/api/personas", async () => ({ secret: true }));
    a.post("/api/personas", async () => ({ created: true }));
    return a;
  };
  const host = { host: "127.0.0.1:4317" };

  it("is needed for every route, however the path is spelled", async () => {
    const a = app();
    for (const url of ["/api/personas", "/%61pi/personas", "/%61%70%69/personas", "/api/%70ersonas", "/API/personas", "//api/personas", "/api/personas?x=1", "/nope"]) {
      const r = await a.inject({ method: "GET", url, headers: host });
      expect(r.statusCode, url).toBe(401);
    }
    expect((await a.inject({ method: "POST", url: "/%61pi/personas", headers: host })).statusCode).toBe(401);
  });

  it("is accepted from the header or the query, and must match exactly", async () => {
    const a = app();
    expect((await a.inject({ url: "/api/personas", headers: { ...host, "x-ph-token": TOKEN } })).statusCode).toBe(200);
    expect((await a.inject({ url: `/%61pi/personas?token=${TOKEN}`, headers: host })).statusCode).toBe(200);
    for (const t of ["", "x", TOKEN.slice(1), `${TOKEN}x`, "é".repeat(TOKEN.length)]) expect((await a.inject({ url: "/api/personas", headers: { ...host, "x-ph-token": t } })).statusCode, t).toBe(401);
  });

  it("isn't needed for the plain notice, which still checks Host and Origin", async () => {
    const a = app();
    expect((await a.inject({ url: "/", headers: host })).statusCode).toBe(200);
    expect((await a.inject({ url: "/", headers: { host: "evil.example" } })).statusCode).toBe(403);
    expect((await a.inject({ url: "/api/personas", headers: { ...host, "x-ph-token": TOKEN, origin: "https://evil.example" } })).statusCode).toBe(403);
  });
});
