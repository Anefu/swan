import { promises as fs } from "node:fs";
import http from "node:http";
import net, { type AddressInfo } from "node:net";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { ConnectionManager } from "../connections/manager.js";
import { SecretStore } from "../secrets.js";
import { paths, type Settings } from "../settings.js";
import { CertAuthority } from "./ca.js";
import { startCompanyProxy, type CompanyProxy } from "./company-proxy.fixture.js";
import { EgressProxy, bypassesProxy, isPrivateAddress, resolveChecked, subnetList, type ProxySession } from "./egress.js";

describe("isPrivateAddress", () => {
  it("blocks loopback, LAN, link-local, CGNAT, metadata and mapped addresses", () => {
    for (const ip of ["127.0.0.1", "10.1.2.3", "172.16.0.1", "192.168.1.1", "169.254.169.254", "100.100.100.100", "0.0.0.0", "::1", "fe80::1", "fd00::1", "::ffff:127.0.0.1", "::ffff:10.0.0.1", "224.0.0.1"])
      expect(isPrivateAddress(ip), ip).toBe(true);
  });
  it("allows public addresses", () => {
    for (const ip of ["1.1.1.1", "140.82.112.3", "2606:4700:4700::1111", "::ffff:8.8.8.8"]) expect(isPrivateAddress(ip), ip).toBe(false);
  });
});

describe("resolveChecked", () => {
  const dnsAnswers: Record<string, string[]> = {
    "example.com": ["93.184.216.34"],
    "jira.corp.test": ["10.20.30.40"],
    "wiki.corp.test": ["fd12::1"],
    "split.corp.test": ["10.1.1.1", "127.0.0.1"],
    "mapped.corp.test": ["::ffff:10.0.0.7"],
  };
  const lookup = async (h: string) => dnsAnswers[h] ?? [];
  const own = subnetList(["10.213.0.0/24"]);
  const check = (host: string, internal: boolean, answers?: string[]) =>
    resolveChecked(host, 443, { internal, own, lookup: answers ? async () => answers : lookup });

  it("allows public addresses, unmarked", async () => {
    expect(await check("example.com", false)).toEqual({ address: "93.184.216.34", port: 443 });
  });

  it("allows company ranges only for hosts the persona lists as internal", async () => {
    await expect(check("jira.corp.test", false)).rejects.toThrow(/10\.20\.30\.40 on a private network.*On your company network/);
    expect(await check("jira.corp.test", true)).toEqual({ address: "10.20.30.40", port: 443, internal: true });
    expect(await check("wiki.corp.test", true)).toMatchObject({ address: "fd12::1", internal: true });
    await expect(check("mapped.corp.test", false)).rejects.toThrow(/private network/);
    expect(await check("mapped.corp.test", true)).toMatchObject({ internal: true });
  });

  it("never allows this computer, link-local, metadata, CGNAT, reserved space or Swan's and Podman's networks", async () => {
    for (const ip of ["127.0.0.1", "::1", "169.254.169.254", "fe80::1", "100.64.0.1", "100.100.100.100", "0.0.0.0", "224.0.0.1", "240.0.0.1", "198.18.0.1", "192.0.0.1", "64:ff9b::a00:1", "10.88.0.5", "192.168.127.1", "10.213.0.2", "::ffff:127.0.0.1"])
      await expect(check("intranet.corp.test", true, [ip]), ip).rejects.toThrow(/private address/);
  });

  it("never allows this computer's own network addresses", async () => {
    const mine = Object.values(os.networkInterfaces()).flat().find((i) => i && !i.internal && i.family === "IPv4");
    if (!mine) return; // no network interface besides loopback
    await expect(check("me.corp.test", true, [mine.address])).rejects.toThrow(/private address/);
  });

  it("refuses a name when any of its addresses is refused", async () => {
    await expect(check("split.corp.test", true)).rejects.toThrow(/127\.0\.0\.1/);
  });

  it("refuses names that do not resolve on this computer", async () => {
    await expect(check("nowhere.test", false)).rejects.toThrow("nowhere.test does not resolve on this computer");
  });

  it("refuses local names, and .internal or .local names unless listed", async () => {
    for (const h of ["localhost", "app.localhost", "host.containers.internal", "host.docker.internal"])
      await expect(check(h, true, ["10.0.0.1"]), h).rejects.toThrow(/local name/);
    await expect(check("build.corp.internal", false, ["10.0.0.1"])).rejects.toThrow(/local name/);
    expect(await check("build.corp.internal", true, ["10.0.0.1"])).toMatchObject({ internal: true });
  });
});

describe("bypassesProxy", () => {
  it("reads noProxy as undici does", () => {
    expect(bypassesProxy("corp.example", 443, ["corp.example"])).toBe(true);
    expect(bypassesProxy("jira.corp.example", 443, ["corp.example"])).toBe(false);
    expect(bypassesProxy("jira.corp.example", 443, [".corp.example"])).toBe(true);
    expect(bypassesProxy("jira.corp.example", 443, ["*.corp.example"])).toBe(true);
    expect(bypassesProxy("jira.corp.example", 443, ["jira.corp.example:8443"])).toBe(false);
    expect(bypassesProxy("jira.corp.example", 8443, ["jira.corp.example:8443"])).toBe(true);
    expect(bypassesProxy("anything.example", 443, ["*"])).toBe(true);
    expect(bypassesProxy("example.com", 443, [])).toBe(false);
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
    proxy.register({ sessionId: "s1", personaId: "p1", token: "t0ken", allowHosts: ["localhost", "127.0.0.1", "example.com:22", "allowed.example"], internalHosts: [], credentials: [], placeholders: new Map(), rules: new Map(), sessionAllowed: new Set() });
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

/** CONNECT through a proxy as the sandbox does; on 200 the socket is returned open. */
function tunnel(port: number, target: string, auth: string) {
  return new Promise<{ status: number; reason?: string; socket?: net.Socket }>((resolve, reject) => {
    const req = http.request({ host: "127.0.0.1", port, method: "CONNECT", path: target, headers: { "proxy-authorization": `Basic ${Buffer.from(auth).toString("base64")}` } });
    req.on("connect", (res, socket) => {
      if (res.statusCode !== 200) socket.destroy();
      resolve({ status: res.statusCode ?? 0, reason: res.headers["x-ph-reason"] as string | undefined, socket: res.statusCode === 200 ? socket : undefined });
    });
    req.on("error", reject);
    req.end();
  });
}

/** Write through an open tunnel to the echo server and read the same bytes back. */
function echo(socket: net.Socket, text: string) {
  return new Promise<string>((resolve) => {
    socket.once("data", (d: Buffer) => resolve(d.toString()));
    socket.write(text);
  });
}

describe("EgressProxy through a company proxy", () => {
  let echoServer: net.Server;
  let echoPort: number;
  let company: CompanyProxy;
  let checked: EgressProxy; // real address checks, with test DNS answers
  let hooked: EgressProxy; // test resolve hook, to reach the local echo server directly
  let checkedPort: number;
  let hookedPort: number;
  const dnsAnswers: Record<string, string[]> = {
    "public.test": ["93.184.216.34"],
    "refused.test": ["93.184.216.35"],
    "jira.corp.test": ["10.20.30.40"],
    "metadata.corp.test": ["169.254.169.254"],
    "tailnet.corp.test": ["100.100.1.1"],
    "sneaky.test": ["10.9.9.9"],
    "intranet.test": ["10.1.1.1"],
  };
  const session = (id: string, allowHosts: string[], internalHosts: string[]): ProxySession => ({
    sessionId: id, personaId: "p1", token: "t0ken", allowHosts, internalHosts, credentials: [], placeholders: new Map(), rules: new Map(), sessionAllowed: new Set(),
  });

  beforeAll(async () => {
    await fs.mkdir(paths.ca, { recursive: true });
    await fs.mkdir(paths.audit, { recursive: true });
    echoServer = net.createServer((s) => s.on("error", () => {}).pipe(s));
    await new Promise<void>((r) => echoServer.listen(0, "127.0.0.1", r));
    echoPort = (echoServer.address() as AddressInfo).port;
    company = await startCompanyProxy({ "public.test:443": echoPort, "jira.corp.test:443": echoPort, "via.test:443": echoPort });
    const conns = new ConnectionManager(new SecretStore(), { providers: {} } as unknown as Settings);
    const ca = await CertAuthority.load();
    checked = new EgressProxy(conns, ca, { lookup: async (h) => dnsAnswers[h] ?? [], upstreamProxy: { url: company.url, noProxy: [] } });
    checkedPort = await checked.listen(0);
    checked.register(session("s2", ["public.test", "refused.test", "sneaky.test", "nowhere.test"], ["*.corp.test"]));
    hooked = new EgressProxy(conns, ca, { resolve: async () => ({ address: "127.0.0.1", port: echoPort }), upstreamProxy: { url: company.url, noProxy: [".direct.test"] } });
    hookedPort = await hooked.listen(0);
    hooked.register(session("s3", ["a.direct.test", "via.test"], []));
  });
  afterAll(() => {
    checked?.close();
    hooked?.close();
    company?.close();
    echoServer?.close();
  });

  const lastEvent = (proxy: EgressProxy, sid: string, host: string) => vi.waitFor(() => {
    const e = proxy.events(sid).filter((x) => x.host === host).at(-1);
    if (!e) throw new Error(`no event for ${host}`);
    return e;
  });

  it("tunnels through the proxy by name, after checking the address here", async () => {
    const t = await tunnel(checkedPort, "public.test:443", "s2:t0ken");
    expect(t.status).toBe(200);
    expect(await echo(t.socket!, "ping")).toBe("ping");
    t.socket!.destroy();
    expect(company.seen).toContain("CONNECT public.test:443");
    expect(await lastEvent(checked, "s2", "public.test")).toMatchObject({ decision: "tunneled", via: "proxy" });
  });

  it("reaches a listed internal host (one-level wildcard) and marks it", async () => {
    const t = await tunnel(checkedPort, "jira.corp.test:443", "s2:t0ken");
    expect(t.status).toBe(200);
    expect(await echo(t.socket!, "hello jira")).toBe("hello jira");
    t.socket!.destroy();
    expect(await lastEvent(checked, "s2", "jira.corp.test")).toMatchObject({ decision: "tunneled", via: "proxy", internal: true });
  });

  it("refuses private and local addresses before contacting the proxy", async () => {
    expect(await tunnel(checkedPort, "sneaky.test:443", "s2:t0ken")).toMatchObject({ status: 403, reason: expect.stringContaining("On your company network") });
    expect(await tunnel(checkedPort, "metadata.corp.test:443", "s2:t0ken")).toMatchObject({ status: 403, reason: expect.stringContaining("private address 169.254.169.254") });
    expect(await tunnel(checkedPort, "tailnet.corp.test:443", "s2:t0ken")).toMatchObject({ status: 403, reason: expect.stringContaining("private address 100.100.1.1") });
    for (const h of ["sneaky.test", "metadata.corp.test", "tailnet.corp.test"]) expect(company.seen.join("\n")).not.toContain(h);
  });

  it("refuses names that only the proxy could resolve", async () => {
    expect(await tunnel(checkedPort, "nowhere.test:443", "s2:t0ken")).toMatchObject({ status: 403, reason: "nowhere.test does not resolve on this computer" });
    expect(company.seen.join("\n")).not.toContain("nowhere.test");
  });

  it("never offers an unlisted host on a private network in an ask card", async () => {
    const asker = vi.fn(async () => true);
    checked.asker = asker;
    try {
      expect(await tunnel(checkedPort, "intranet.test:443", "s2:t0ken")).toMatchObject({ status: 403, reason: expect.stringContaining("On your company network") });
      expect(asker).not.toHaveBeenCalled();
    } finally {
      checked.asker = null;
    }
  });

  it("reports the proxy's refusal as blocked", async () => {
    expect(await tunnel(checkedPort, "refused.test:443", "s2:t0ken")).toMatchObject({ status: 403, reason: "the company proxy refused refused.test:443 (403 Forbidden)" });
    expect(await lastEvent(checked, "s2", "refused.test")).toMatchObject({ decision: "blocked", via: "proxy" });
  });

  it("sends plain http requests to the proxy in absolute form", async () => {
    const res = await new Promise<{ status: number; body: string }>((resolve, reject) => {
      const req = http.request({ host: "127.0.0.1", port: checkedPort, path: "http://public.test/hello?x=1", headers: { host: "public.test", "proxy-authorization": `Basic ${Buffer.from("s2:t0ken").toString("base64")}` } }, (r) => {
        let body = "";
        r.on("data", (c) => (body += c));
        r.on("end", () => resolve({ status: r.statusCode ?? 0, body }));
      });
      req.on("error", reject);
      req.end();
    });
    expect(res).toEqual({ status: 200, body: "company proxy: GET http://public.test/hello?x=1\n" });
    expect(await lastEvent(checked, "s2", "public.test")).toMatchObject({ method: "GET", decision: "inspected", via: "proxy" });
  });

  it("connects directly to noProxy hosts", async () => {
    const direct = await tunnel(hookedPort, "a.direct.test:443", "s3:t0ken");
    expect(direct.status).toBe(200);
    expect(await echo(direct.socket!, "direct")).toBe("direct");
    direct.socket!.destroy();
    expect(company.seen.join("\n")).not.toContain("direct.test");
    const ev = await lastEvent(hooked, "s3", "a.direct.test");
    expect(ev.decision).toBe("tunneled");
    expect(ev.via).toBeUndefined();

    const proxied = await tunnel(hookedPort, "via.test:443", "s3:t0ken");
    expect(proxied.status).toBe(200);
    proxied.socket!.destroy();
    expect(company.seen).toContain("CONNECT via.test:443");
  });

  it("never passes the session's proxy credentials on to the company proxy", () => {
    expect(company.seen.length).toBeGreaterThan(3);
    expect([...company.headerNames]).not.toContain("proxy-authorization");
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
