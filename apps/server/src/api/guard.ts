import { timingSafeEqual } from "node:crypto";
import type { FastifyReply, FastifyRequest } from "fastify";

const LOCAL_HOST = /^(localhost|127\.0\.0\.1|\[::1\])(:\d+)?$/i;
// The desktop app's own pages (swan://app), or a local page in development (Vite on localhost).
const LOCAL_ORIGIN = /^(https?:\/\/(localhost|127\.0\.0\.1|\[::1\])(:\d+)?|swan:\/\/app)$/i;

/** DNS-rebinding guard: only requests addressed to a loopback name. */
export const hostAllowed = (host: string | undefined) => LOCAL_HOST.test(host ?? "");
/** CSRF guard: browsers send Origin, and only Swan's own pages may call the API. */
export const originAllowed = (origin: string | undefined) => origin === undefined || LOCAL_ORIGIN.test(origin);

/**
 * DNS-rebinding and CSRF guard, and the token for everything except the plain notice at "/".
 * The router decodes the path before matching (`/%61pi/…` is `/api/…`), so the token check can't
 * look at the raw URL to decide what is API: it applies to every request but one.
 */
export function requestGuard(token: string) {
  const want = Buffer.from(token);
  const tokenOk = (t: unknown) => {
    if (typeof t !== "string") return false;
    const got = Buffer.from(t);
    return got.length === want.length && timingSafeEqual(got, want);
  };
  return async (req: FastifyRequest, reply: FastifyReply) => {
    if (!hostAllowed(req.headers.host)) return reply.code(403).send({ error: "forbidden host" });
    if (!originAllowed(req.headers.origin)) return reply.code(403).send({ error: "forbidden origin" });
    const [pathname, query = ""] = req.url.split("?", 2);
    if (req.method === "GET" && pathname === "/") return;
    const t = req.headers["x-ph-token"] ?? new URLSearchParams(query).get("token");
    if (!tokenOk(t)) return reply.code(401).send({ error: "missing or invalid token" });
  };
}
