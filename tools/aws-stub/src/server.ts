import http from "node:http";
import https from "node:https";
import type { AddressInfo } from "node:net";
import { describeAuth, verify } from "@ph/aws-sigv4";
import { awsError, handleAws, PROTOCOL } from "./aws.js";
import { json, type Req } from "./http.js";
import { handleKubernetes } from "./k8s.js";
import { approve, handleSso } from "./sso.js";
import { StubState, type StubOptions } from "./state.js";

export interface StubServer {
  url: string;
  state: StubState;
  close(): Promise<void>;
}

export interface StartOptions extends Partial<StubOptions> {
  port?: number;
  host?: string;
  /** PEM key and certificate to serve HTTPS; `ca` is reported as the EKS cluster CA. */
  tls?: { key: string; cert: string; ca: string };
}

/**
 * Starts the stub. Routes:
 *   /_stub/*            test controls (reset, approve a device code, recorded requests)
 *   /sso/*              device-code sign-in and role credentials
 *   /k8s/<cluster>/*    Kubernetes API with EKS token auth
 *   anything else       AWS APIs, routed by the service in the SigV4 credential scope
 */
export async function startStub(opts: StartOptions = {}): Promise<StubServer> {
  const state = new StubState(opts);
  const caData = opts.tls ? Buffer.from(opts.tls.ca).toString("base64") : undefined;
  let base = "";

  const handler = (req: http.IncomingMessage, res: http.ServerResponse) => {
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => chunks.push(c));
    req.on("end", () => {
      const host = req.headers.host ?? "localhost";
      const rawUrl = `${opts.tls ? "https" : "http"}://${host}${req.url ?? "/"}`;
      const r: Req = { method: req.method ?? "GET", url: new URL(rawUrl), rawUrl, headers: req.headers, body: Buffer.concat(chunks) };
      try {
        route(r, res);
      } catch (e) {
        json(res, 500, { message: e instanceof Error ? e.message : String(e) });
      }
    });
  };

  const route = (r: Req, res: http.ServerResponse) => {
    const path = r.url.pathname;
    if (path.startsWith("/_stub/")) return control(r, res);
    if (path.startsWith("/sso/")) return handleSso(r, res, state, base);
    const k = /^\/k8s\/([^/]+)(\/.*)?$/.exec(path);
    if (k) return handleKubernetes(r, res, state, decodeURIComponent(k[1]), k[2] ?? "/");

    const auth = describeAuth({ url: r.rawUrl, headers: r.headers });
    const service = auth?.service ?? "sts";
    if (!auth) return awsError(res, service, "Unrecognized", "Request is missing Authentication Token");
    if (!PROTOCOL[service]) return awsError(res, service, "Unsupported", `The stub does not implement the ${service} service`);
    const v = verify({ method: r.method, url: r.rawUrl, headers: r.headers, body: r.body }, { lookup: state.lookup });
    if (!v.ok) {
      const kind = v.code === "InvalidAccessKeyId" || v.code === "InvalidToken" || v.code === "MissingAuthentication" ? "Unrecognized" : v.code === "RequestExpired" ? "Skewed" : "BadSignature";
      return awsError(res, service, kind, v.message, v.code === "BadDigest" ? "XAmzContentSHA256Mismatch" : undefined);
    }
    const identity = state.identity(v.accessKeyId);
    if (identity === "expired") return awsError(res, service, "Expired", "The security token included in the request is expired");
    if (!identity) return awsError(res, service, "Unrecognized", "The security token included in the request is invalid.");
    return handleAws(service, { r, res, state, identity, base, caData });
  };

  const control = (r: Req, res: http.ServerResponse) => {
    const path = r.url.pathname;
    if (path === "/_stub/reset" && r.method === "POST") {
      state.reset();
      return json(res, 200, { ok: true });
    }
    if (path === "/_stub/sso/approve" && r.method === "POST") {
      const ok = approve(state, JSON.parse(r.body.toString("utf8") || "{}").user_code ?? "");
      return json(res, ok ? 200 : 404, { ok });
    }
    if (path === "/_stub/requests") return json(res, 200, state.requests);
    return json(res, 404, { message: "not found" });
  };

  const server = opts.tls ? https.createServer({ key: opts.tls.key, cert: opts.tls.cert }, handler) : http.createServer(handler);
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(opts.port ?? 0, opts.host ?? "127.0.0.1", () => resolve());
  });
  const { port } = server.address() as AddressInfo;
  base = `${opts.tls ? "https" : "http"}://${opts.host === "0.0.0.0" ? "127.0.0.1" : (opts.host ?? "127.0.0.1")}:${port}`;
  return {
    url: base,
    state,
    close: () =>
      new Promise((resolve) => {
        server.closeAllConnections?.();
        server.close(() => resolve());
      }),
  };
}
