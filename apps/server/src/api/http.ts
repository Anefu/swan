import type { FastifyInstance, FastifyRequest } from "fastify";
import type { z } from "zod";
import { log } from "../util.js";

export class HttpError extends Error {
  constructor(
    readonly statusCode: number,
    message: string,
  ) {
    super(message);
  }
}

export type Req<Params = Record<string, string>, Body = unknown, Query = Record<string, string | undefined>> = FastifyRequest<{ Params: Params; Body: Body; Querystring: Query }>;

/** JSON bodies, empty ones included: clients often send the header on bodiless POSTs. */
export function acceptJson(app: FastifyInstance) {
  app.removeContentTypeParser("application/json");
  app.addContentTypeParser("application/json", { parseAs: "string" }, (_req, body, done) => {
    if (!body) return done(null, {});
    try {
      done(null, JSON.parse(body as string));
    } catch {
      done(new HttpError(400, "invalid JSON body"), undefined);
    }
  });
}

/** Every error is a JSON {error}; one without a status of its own is the client's (400). */
export function errorReplies(app: FastifyInstance) {
  app.setErrorHandler((err: Error & { statusCode?: number }, _req, reply) => {
    const code = err.statusCode && err.statusCode >= 400 ? err.statusCode : 400;
    if (code >= 500) log.error("api", err.message);
    reply.code(code).send({ error: err.message });
  });
}

/** A request body checked against its schema; a bad field is a 400 that names it. */
export function bodyOf<T>(req: FastifyRequest, schema: z.ZodType<T>): T {
  const r = schema.safeParse(req.body ?? {});
  if (r.success) return r.data;
  const issue = r.error.issues[0];
  throw new HttpError(400, `${issue?.path.join(".") || "body"}: ${issue?.message}`);
}
