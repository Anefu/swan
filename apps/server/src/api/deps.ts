import type { FastifyInstance, FastifyRequest } from "fastify";
import type { ProviderRegistry } from "../agent/providers.js";
import type { Session } from "../agent/session.js";
import type { SessionManager } from "../agent/session-manager.js";
import type { AttachmentStore } from "../attachments.js";
import type { ModelCatalog } from "../catalog.js";
import type { ConnectionManager } from "../connections/manager.js";
import type { DiffStore } from "../diffs.js";
import type { MemoryStore } from "../memory.js";
import type { Persona, PersonaStore } from "../personas.js";
import type { EgressProxy } from "../proxy/egress.js";
import type { PodmanRuntime } from "../sandbox/podman.js";
import type { SecretStore } from "../secrets.js";
import type { Settings } from "../settings.js";
import type { SkillRegistry } from "../skills.js";
import type { TrackerStore } from "../tracker.js";
import type { TriggerManager } from "../triggers.js";
import type { UsageLedger } from "../usage.js";
import { HttpError } from "./http.js";

export interface ApiDeps {
  settings: Settings;
  token: string;
  secrets: SecretStore;
  connections: ConnectionManager;
  personas: PersonaStore;
  skills: SkillRegistry;
  runtime: PodmanRuntime;
  proxy: EgressProxy;
  providers: ProviderRegistry;
  sessions: SessionManager;
  memory: MemoryStore;
  usage: UsageLedger;
  catalog: ModelCatalog;
  attachments: AttachmentStore;
  tracker: TrackerStore;
  triggers: TriggerManager;
  diffs: DiffStore;
}

declare module "fastify" {
  interface FastifyRequest {
    /** The persona of a route under /api/personas/:id. */
    persona: Persona;
    /** The conversation of a route under /api/sessions/:id. */
    session: Session;
  }
}

export function personaOf(d: ApiDeps, id: string): Persona {
  const p = d.personas.get(id);
  if (!p) throw new HttpError(404, `persona "${id}" not found`);
  return p;
}

/** A persona that can run: one whose YAML is valid. */
export function runnable(p: Persona): Persona {
  if (!p.config) throw new HttpError(400, `persona "${p.id}" is invalid: ${p.errors.join("; ")}`);
  return p;
}

type Scoped = (app: FastifyInstance) => void;

/** Routes under /api/personas/:id: the persona is looked up once, after the token check, and is req.persona. */
export function underPersona(app: FastifyInstance, d: ApiDeps, routes: Scoped) {
  void app.register(
    async (scoped) => {
      scoped.addHook("preHandler", async (req: FastifyRequest<{ Params: { id: string } }>) => {
        req.persona = personaOf(d, req.params.id);
      });
      routes(scoped);
    },
    { prefix: "/api/personas/:id" },
  );
}

/** Routes under /api/sessions/:id: the conversation is looked up once, and is req.session. */
export function underSession(app: FastifyInstance, d: ApiDeps, routes: Scoped) {
  void app.register(
    async (scoped) => {
      scoped.addHook("preHandler", async (req: FastifyRequest<{ Params: { id: string } }>) => {
        const s = d.sessions.get(req.params.id);
        if (!s) throw new HttpError(404, `session "${req.params.id}" not found`);
        req.session = s;
      });
      routes(scoped);
    },
    { prefix: "/api/sessions/:id" },
  );
}
