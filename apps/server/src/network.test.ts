import { promises as fs } from "node:fs";
import http from "node:http";
import https from "node:https";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import tls from "node:tls";
import { makeTls } from "@ph/aws-stub/tls";
import { Agent, setGlobalDispatcher } from "undici";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { applyNetwork, loadExtraCas, networkEnv, noProxyList, splitPem } from "./network.js";

const servers: net.Server[] = [];
const listen = async (s: net.Server) => {
  servers.push(s);
  await new Promise<void>((r) => s.listen(0, "127.0.0.1", r));
  return (s.address() as net.AddressInfo).port;
};

let dir: string;
let caFile: string;
let upstreamPort: number;
let directPort: number;
let proxyPort: number;
const connects: string[] = [];
const defaultCas = tls.getCACertificates?.("default");

beforeAll(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), "swan-net-"));
  // An HTTPS server for a name only the proxy can reach, with a certificate from a throwaway CA.
  const t = makeTls(["upstream.test"]);
  caFile = t.caFile;
  upstreamPort = await listen(https.createServer({ key: t.key, cert: t.cert }, (_req, res) => res.end("upstream")));
  directPort = await listen(http.createServer((_req, res) => res.end("direct")));
  // A forward proxy that records each CONNECT and sends it to the test server.
  const proxy = http.createServer((_req, res) => res.writeHead(405).end());
  proxy.on("connect", (req, client, head) => {
    connects.push(req.url ?? "");
    const up = net.connect(upstreamPort, "127.0.0.1", () => {
      client.write("HTTP/1.1 200 Connection Established\r\n\r\n");
      up.write(head);
      up.pipe(client).pipe(up);
    });
    up.on("error", () => client.destroy());
  });
  proxyPort = await listen(proxy);
});

afterAll(async () => {
  setGlobalDispatcher(new Agent());
  if (defaultCas) tls.setDefaultCACertificates?.(defaultCas);
  await Promise.all(servers.map((s) => new Promise((r) => s.close(r))));
  await fs.rm(dir, { recursive: true, force: true });
});

describe("network settings", () => {
  it("reads caFiles and names a bad one", async () => {
    expect(await loadExtraCas([caFile])).toHaveLength(1);
    const notPem = path.join(dir, "not.pem");
    await fs.writeFile(notPem, "hello");
    await expect(loadExtraCas([notPem])).rejects.toThrow(/not\.pem has no PEM certificates/);
    await expect(loadExtraCas([path.join(dir, "missing.pem")])).rejects.toThrow(/cannot read .*missing\.pem/);
    expect(splitPem("x\n-----BEGIN CERTIFICATE-----\na\n-----END CERTIFICATE-----\ny")).toHaveLength(1);
  });

  it("keeps localhost direct whatever noProxy says", () => {
    expect(noProxyList({ url: "http://p.example.com:8080", noProxy: [".corp.example.com"] })).toEqual(["localhost", "127.0.0.1", "::1", ".corp.example.com"]);
  });

  it("sends fetch through the proxy, trusting the extra CA, and keeps localhost direct", async () => {
    const extraCaFile = path.join(dir, "extra-roots.pem");
    const proxyUrl = `http://127.0.0.1:${proxyPort}`;
    await applyNetwork({ proxy: { url: proxyUrl, noProxy: [] } }, await loadExtraCas([caFile]), extraCaFile);

    const res = await fetch("https://upstream.test/");
    expect(await res.text()).toBe("upstream");
    expect(connects).toEqual(["upstream.test:443"]);

    expect(await (await fetch(`http://127.0.0.1:${directPort}/`)).text()).toBe("direct");
    expect(connects).toHaveLength(1);

    // Programs Swan starts get the same settings.
    expect(networkEnv()).toMatchObject({ HTTPS_PROXY: proxyUrl, https_proxy: proxyUrl, NO_PROXY: "localhost,127.0.0.1,::1", NODE_EXTRA_CA_CERTS: extraCaFile });
    expect(await fs.readFile(extraCaFile, "utf8")).toContain("-----BEGIN CERTIFICATE-----");
  });
});
