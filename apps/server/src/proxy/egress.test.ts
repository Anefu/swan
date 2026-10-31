import { promises as fs } from "node:fs";
import http from "node:http";
import path from "node:path";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ConnectionManager } from "../connections/manager.js";
import { SecretStore } from "../secrets.js";
import { paths, type Settings } from "../settings.js";
import { CertAuthority } from "./ca.js";
import { EgressProxy, isPrivateAddress } from "./egress.js";

describe("isPrivateAddress", () => {
  it("blocks loopback, LAN, link-local, CGNAT, metadata and mapped addresses", () => {
    for (const ip of ["127.0.0.1", "10.1.2.3", "172.16.0.1", "192.168.1.1", "169.254.169.254", "100.100.100.100", "0.0.0.0", "::1", "fe80::1", "fd00::1", "::ffff:127.0.0.1", "::ffff:10.0.0.1", "224.0.0.1"])
      expect(isPrivateAddress(ip), ip).toBe(true);
  });
  it("allows public addresses", () => {
    for (const ip of ["1.1.1.1", "140.82.112.3", "2606:4700:4700::1111", "::ffff:8.8.8.8"]) expect(isPrivateAddress(ip), ip).toBe(false);
  });
});

describe("EgressProxy", () => {
  let proxy: EgressProxy;
  let port: number;
  beforeAll(async () => {
    await fs.mkdir(paths.ca, { recursive: true });
    await fs.mkdir(paths.audit, { recursive: true });
    proxy = new EgressProxy(new ConnectionManager(new SecretStore(), { providers: {} } as unknown as Settings), await CertAuthority.load());
    await proxy.listen(0);
    port = ((proxy as unknown as { server: http.Server }).server.address() as AddressInfo).port;
    proxy.register({ sessionId: "s1", personaId: "p1", token: "t0ken", allowHosts: ["localhost", "127.0.0.1", "example.com:22", "allowed.example"], credentials: [], placeholders: new Map(), rules: new Map(), sessionAllowed: new Set() });
  });
  afterAll(() => (proxy as unknown as { server: http.Server }).server.close());

  /** Send CONNECT through the proxy and return the status line. */
  const connect = (target: string, auth?: string) =>
    new Promise<{ status: number; reason?: string }>((resolve, reject) => {
      const req = http.request({ host: "127.0.0.1", port, method: "CONNECT", path: target, headers: auth ? { "proxy-authorization": `Basic ${Buffer.from(auth).toString("base64")}` } : {} });
      req.on("connect", (res, socket) => {
        socket.destroy();
        resolve({ status: res.statusCode ?? 0, reason: res.headers["x-ph-reason"] as string | undefined });
      });
      req.on("response", (res) => resolve({ status: res.statusCode ?? 0 }));
      req.on("error", reject);
      req.end();
    });

  it("requires the session's proxy credentials", async () => {
    expect((await connect("example.com:443")).status).toBe(407);
    expect((await connect("example.com:443", "s1:wrong")).status).toBe(407);
  });

  it("refuses hosts outside the allowlist when nobody can be asked", async () => {
    expect(await connect("not-listed.example:443", "s1:t0ken")).toMatchObject({ status: 403, reason: "host not in persona allowlist" });
  });

  it("refuses ports that are not explicitly allowed", async () => {
    expect(await connect("allowed.example:8443", "s1:t0ken")).toMatchObject({ status: 403, reason: "port 8443 not allowed" });
  });

  it("refuses loopback even when the persona lists it", async () => {
    expect((await connect("localhost:443", "s1:t0ken")).status).toBe(403);
    expect((await connect("127.0.0.1:443", "s1:t0ken")).status).toBe(403);
    expect(proxy.events("s1").at(-1)).toMatchObject({ decision: "blocked", host: "127.0.0.1", reason: expect.stringContaining("private") });
  });
});

describe("EgressProxy history", () => {
  const days = ["egress-2001-01-01.jsonl", "egress-2001-01-02.jsonl"];
  const event = (id: string, ts: string) =>
    JSON.stringify({ id, ts, sessionId: "old", personaId: "p-old", method: "CONNECT", host: "example.org", port: 443, decision: "tunneled", credentials: [] });
  afterAll(() => Promise.all(days.map((f) => fs.rm(path.join(paths.audit, f), { force: true }))));

  it("reloads earlier days from the audit log on start, oldest first, skipping broken lines", async () => {
    await fs.mkdir(paths.audit, { recursive: true });
    await fs.mkdir(paths.ca, { recursive: true });
    await fs.writeFile(path.join(paths.audit, days[0]), event("eg_day1", "2001-01-01T10:00:00.000Z") + "\nnot json\n");
    await fs.writeFile(path.join(paths.audit, days[1]), event("eg_day2", "2001-01-02T10:00:00.000Z") + "\n");
    const proxy = new EgressProxy(new ConnectionManager(new SecretStore(), { providers: {} } as unknown as Settings), await CertAuthority.load());
    await proxy.listen(0);
    try {
      const ids = proxy.events(undefined, 2000).map((e) => e.id);
      expect(ids).toContain("eg_day1");
      expect(ids.indexOf("eg_day1")).toBeLessThan(ids.indexOf("eg_day2"));
      expect(proxy.events("old").map((e) => e.id)).toEqual(["eg_day1", "eg_day2"]);
    } finally {
      proxy.close();
    }
  });
});
