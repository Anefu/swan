// The sandbox runtime, model providers and their keys, and what spans personas: approvals,
// usage and the egress log.
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { personaOf, type ApiDeps } from "../deps.js";
import { HttpError, bodyOf, type Req } from "../http.js";

export function systemRoutes(app: FastifyInstance, d: ApiDeps) {
  app.get("/api/runtime", async () => d.runtime.status);
  for (const [action, run] of [
    ["retry", () => d.runtime.init()],
    ["setup", () => d.runtime.setupMachine()],
    ["rebuild", () => d.runtime.rebuild()],
  ] as const)
    app.post(`/api/runtime/${action}`, async () => {
      void run();
      return d.runtime.status;
    });

  app.get("/api/providers", async () => d.providers.status());
  app.get("/api/providers/:name/models", async (req: Req<{ name: string }>) => {
    if (d.settings.providers[req.params.name]?.type !== "copilot") throw new HttpError(400, "model listing is available for copilot providers");
    return d.providers.listModels(req.params.name);
  });
  app.get("/api/providers/:name/allowance", async (req: Req<{ name: string }>) => d.catalog.allowance(req.params.name));

  // Model-provider keys: host-side only, never a connection.
  const providerKey = (name: string) => {
    const cfg = d.settings.providers[name];
    const key = cfg?.apiKeySecret ?? (cfg?.type === "copilot" ? "COPILOT_GITHUB_TOKEN" : undefined);
    if (!key) throw new HttpError(404, `provider "${name}" has no key`);
    return key;
  };
  app.put("/api/providers/:name/key", async (req: Req<{ name: string }>) => {
    const { value } = bodyOf(req, z.object({ value: z.string().trim().min(1, "required") }));
    await d.secrets.setValue(providerKey(req.params.name), value);
    return d.providers.status().find((p) => p.name === req.params.name);
  });
  app.delete("/api/providers/:name/key", async (req: Req<{ name: string }>) => {
    await d.secrets.remove(providerKey(req.params.name));
    return { ok: true };
  });
  app.get("/api/secrets/status", async () => ({ error: d.secrets.error }));

  app.get("/api/models", async () => d.catalog.list());
  app.get("/api/skills", async () => d.skills.list());
  app.get("/api/approvals", async () => d.sessions.pendingApprovals());
  app.get("/api/usage", async (req: Req<never, unknown, { personaId?: string; period?: string }>) => {
    const p = personaOf(d, req.query.personaId ?? "");
    return d.usage.report(p.id, req.query.period === "all" ? "all" : "today");
  });
  app.get("/api/egress", async (req: Req<never, unknown, { sessionId?: string; limit?: string }>) =>
    d.proxy.events(req.query.sessionId || undefined, Math.min(2000, Number(req.query.limit ?? 200) || 200)),
  );
}
