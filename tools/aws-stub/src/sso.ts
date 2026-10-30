// An OAuth 2.0 device-authorization flow (RFC 8628) shaped like AWS IAM Identity Center, so a
// connection wrapper can be exercised end to end: authorize, show a code, poll, refresh, and fetch
// short-lived role credentials.
import { randomBytes } from "node:crypto";
import type { ServerResponse } from "node:http";
import { esc, formParams, header, json, send, type Req } from "./http.js";
import { ROLES, type Role, type StubState } from "./state.js";

const token = () => randomBytes(24).toString("base64url");
const userCode = () => {
  const a = "BCDFGHJKLMNPQRSTVWXZ";
  const s = Array.from(randomBytes(8), (b) => a[b % a.length]).join("");
  return `${s.slice(0, 4)}-${s.slice(4)}`;
};

function params(r: Req): URLSearchParams {
  if ((header(r, "content-type") ?? "").includes("json")) {
    try {
      return new URLSearchParams(Object.entries(JSON.parse(r.body.toString("utf8")) as Record<string, string>));
    } catch {
      return new URLSearchParams();
    }
  }
  return formParams(r);
}

const oauthError = (res: ServerResponse, error: string, description: string) => json(res, 400, { error, error_description: description });

export function approve(state: StubState, code: string): boolean {
  for (const d of state.sso.devices.values()) {
    if (d.userCode === code && d.expiresAt > Date.now()) {
      d.approved = true;
      return true;
    }
  }
  return false;
}

export function handleSso(r: Req, res: ServerResponse, state: StubState, base: string) {
  const path = r.url.pathname;
  const sso = state.sso;

  if (path === "/sso/device_authorization" && r.method === "POST") {
    const role = (params(r).get("role") ?? "ReadOnly") as Role;
    if (!ROLES.includes(role)) return oauthError(res, "invalid_scope", `role must be one of ${ROLES.join(", ")}`);
    const deviceCode = token();
    const code = userCode();
    sso.devices.set(deviceCode, { userCode: code, expiresAt: Date.now() + 600_000, approved: state.options.autoApprove, role });
    return json(res, 200, {
      device_code: deviceCode,
      user_code: code,
      verification_uri: `${base}/sso/device`,
      verification_uri_complete: `${base}/sso/device?user_code=${code}`,
      expires_in: 600,
      interval: 1,
    });
  }

  if (path === "/sso/device") {
    if (r.method === "POST") {
      const code = params(r).get("user_code") ?? "";
      const ok = approve(state, code);
      return send(res, ok ? 200 : 400, page(ok ? "Signed in. You can close this tab and return to Swan." : "That code is not valid or has expired."), "text/html; charset=utf-8");
    }
    const code = r.url.searchParams.get("user_code") ?? "";
    return send(
      res,
      200,
      page(`<form method="post"><p>Approve the sign-in for code</p><input name="user_code" value="${esc(code)}" autofocus><button>Approve</button></form>`),
      "text/html; charset=utf-8",
    );
  }

  if (path === "/sso/token" && r.method === "POST") {
    const p = params(r);
    const grant = p.get("grant_type");
    if (grant === "urn:ietf:params:oauth:grant-type:device_code") {
      const d = sso.devices.get(p.get("device_code") ?? "");
      if (!d) return oauthError(res, "invalid_grant", "unknown device code");
      if (d.expiresAt < Date.now()) return oauthError(res, "expired_token", "the device code has expired");
      if (!d.approved) return oauthError(res, "authorization_pending", "the user has not approved the sign-in yet");
      sso.devices.delete(p.get("device_code")!);
      const refresh = token();
      sso.refreshTokens.set(refresh, { expiresAt: Date.now() + state.options.refreshTokenSeconds * 1000, role: d.role });
      return issueAccess(res, state, d.role, refresh);
    }
    if (grant === "refresh_token") {
      const refresh = p.get("refresh_token") ?? "";
      const t = sso.refreshTokens.get(refresh);
      if (!t || t.expiresAt < Date.now()) return oauthError(res, "invalid_grant", "the refresh token is invalid or has expired; sign in again");
      return issueAccess(res, state, t.role, refresh);
    }
    return oauthError(res, "unsupported_grant_type", `grant_type ${grant} is not supported`);
  }

  if (path === "/sso/credentials" && r.method === "GET") {
    const auth = header(r, "authorization") ?? "";
    const t = sso.accessTokens.get(auth.replace(/^Bearer\s+/, ""));
    if (!t || t.expiresAt < Date.now()) return json(res, 401, { message: "Session token not found or invalid" });
    const s = state.issueSession(t.role, "swan-sso");
    return json(res, 200, { roleCredentials: { accessKeyId: s.accessKeyId, secretAccessKey: s.secretAccessKey, sessionToken: s.sessionToken, expiration: s.expiresAt } });
  }

  return json(res, 404, { message: "not found" });
}

function issueAccess(res: ServerResponse, state: StubState, role: Role, refresh: string) {
  const access = token();
  state.sso.accessTokens.set(access, { expiresAt: Date.now() + state.options.accessTokenSeconds * 1000, role });
  const refreshLeft = Math.max(0, Math.floor((state.sso.refreshTokens.get(refresh)!.expiresAt - Date.now()) / 1000));
  return json(res, 200, { access_token: access, token_type: "Bearer", expires_in: state.options.accessTokenSeconds, refresh_token: refresh, refresh_expires_in: refreshLeft, role });
}

const page = (body: string) =>
  `<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>Swan stub sign-in</title><style>body{font:16px system-ui;max-width:28rem;margin:4rem auto;padding:0 1rem}input,button{font:inherit;padding:.4rem .6rem}</style><h1>Swan stub sign-in</h1>${body}`;
