// All conversations: loading, creating, forking and removing them, and routing the proxy's and
// the connections' events to the conversation they concern.
import { promises as fs } from "node:fs";
import path from "node:path";
import type { PendingApproval } from "@ph/shared";
import { paths } from "../settings.js";
import { errMsg, log } from "../util.js";
import type { ConversationAccess } from "./conversation-tools.js";
import { Session, type SessionDeps } from "./session.js";

export class SessionManager {
  private sessions = new Map<string, Session>();
  spendTurn?: (personaId: string) => Promise<string | null>; // set once triggers exist; says why a turn can't start

  constructor(private deps: SessionDeps) {
    deps.conversations = this.access();
    deps.findEvents = (personaId, ids) => {
      const want = new Set(ids);
      return this.of(personaId).flatMap((s) => s.items.filter((it) => want.has(it.id)));
    };
    deps.siblingAtWork = (id, personaId) => this.of(personaId).some((s) => s.id !== id && (s.summary.status === "running" || s.summary.status === "awaiting_approval"));
    deps.proxy.asker = async (ps, host, port) => this.sessions.get(ps.sessionId)?.requestNetwork(host, port) ?? false;
    deps.proxy.credentialAsker = async (ps, ref, v) => this.sessions.get(ps.sessionId)?.requestCredentialUse(ref, v) ?? false;
    deps.proxy.onDenied = (ps, ref, v) => this.sessions.get(ps.sessionId)?.credentialBlocked(ref, v);
    deps.proxy.onForeignCredential = (ps, host, field) => this.sessions.get(ps.sessionId)?.foreignCredentialBlocked(host, field);
    deps.connections.on("changed", (refs) => this.each((s) => void s.onCredentialsChanged(refs)));
    deps.connections.on("materials", (conn) => this.each((s) => void s.onMaterials(conn)));
    deps.connections.on("updated", () => this.each((s) => s.creds.syncSignIns()));
    deps.connections.on("needsSignIn", (conn) => this.each((s) => s.creds.onNeedsSignIn(conn)));
  }

  private of(personaId: string) {
    return [...this.sessions.values()].filter((s) => s.personaId === personaId);
  }

  private each(f: (s: Session) => void) {
    for (const s of this.sessions.values()) f(s);
  }

  /** What the conversations tool may do across conversations. */
  private access(): ConversationAccess {
    const { personas } = this.deps;
    return {
      list: (personaId) => this.list(personaId),
      personas: () => personas.list().map((p) => ({ id: p.id, name: p.config?.name ?? p.id })),
      rename: (id, title) => this.sessions.get(id)?.rename(title),
      remove: (id) => this.remove(id),
      deliver: async (fromId, to, text) => {
        const from = this.sessions.get(fromId);
        if (!from) return "This conversation is gone.";
        const target = "id" in to ? this.sessions.get(to.id) : undefined;
        if ("id" in to && !target) return "That conversation is gone.";
        const personaId = target?.personaId ?? ("personaId" in to ? to.personaId : "");
        const persona = personas.get(personaId);
        if (!persona?.config) return `Persona ${personaId} can't run: ${persona?.errors.join("; ") || "not found"}.`;
        // The turn runs in the target persona, so it counts against that persona's daily limit.
        const refused = await this.spendTurn?.(personaId);
        if (refused) return refused;
        const fromPersona = personaId === from.personaId ? undefined : (personas.get(from.personaId)?.config?.name ?? from.personaId);
        const dest = target ?? this.create(personaId, `From ${fromPersona}: ${from.summary.title}`.slice(0, 120), `a message from ${fromPersona}`);
        dest.deliver(from.summary, text, fromPersona);
        return null;
      },
    };
  }

  async loadAll() {
    for (const f of await fs.readdir(paths.sessions)) {
      if (!f.endsWith(".json")) continue;
      try {
        const s = await Session.load(this.deps, path.join(paths.sessions, f));
        this.sessions.set(s.id, s);
      } catch (e) {
        log.warn("sessions", `skipping ${f}: ${errMsg(e)}`);
      }
    }
  }

  create(personaId: string, title?: string, trigger?: string) {
    const s = Session.create(this.deps, personaId, title, trigger);
    this.sessions.set(s.id, s);
    void s.persist();
    this.deps.broadcast({ type: "session.updated", session: s.summary });
    return s;
  }

  /** A copy of a conversation in its persona, with its attachments, diffs and latest checkpoint. */
  async fork(id: string) {
    const src = this.sessions.get(id);
    if (!src) throw new Error(`conversation ${id} not found`);
    const s = src.fork();
    this.sessions.set(s.id, s);
    const own = new Set(src.items.map((it) => it.id));
    const [cp] = await Promise.all([
      this.deps.memory.latestCheckpoint(src.personaId, src.id, (e) => own.has(e)),
      this.deps.attachments.copySession(src.id, s.id),
      this.deps.diffs.copySession(src.id, s.id),
    ]);
    if (cp) await this.deps.memory.addCheckpoint(src.personaId, { ...cp, sessionId: s.id });
    await s.persist();
    this.deps.broadcast({ type: "session.updated", session: s.summary });
    return s;
  }

  /** The conversation to open for a persona: the latest one the user started, created if absent. */
  conversation(personaId: string) {
    const mine = this.of(personaId)
      .filter((s) => !s.summary.trigger)
      .sort((a, b) => b.summary.updatedAt.localeCompare(a.summary.updatedAt));
    return mine[0] ?? this.create(personaId);
  }

  /** For schedules and watchers: each run gets a conversation of its own, and polling uses the persona's usual sandbox. */
  triggerTarget(personaId: string) {
    return {
      trigger: (label: string, prompt: string) => this.create(personaId, label, label).trigger(label, prompt),
      pollExec: (argv: string[], timeoutMs?: number) => this.conversation(personaId).pollExec(argv, timeoutMs),
    };
  }

  get(id: string) {
    return this.sessions.get(id);
  }

  list(personaId?: string) {
    return [...this.sessions.values()]
      .filter((s) => !personaId || s.personaId === personaId)
      .map((s) => s.summary)
      .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  }

  pendingApprovals(): PendingApproval[] {
    return [...this.sessions.values()].flatMap((s) => s.pendingApprovals()).sort((a, b) => a.since.localeCompare(b.since));
  }

  async remove(id: string) {
    const s = this.sessions.get(id);
    if (!s) return;
    await s.stop();
    await s.deleteFile();
    await this.deps.diffs.removeSession(id);
    await this.deps.attachments.removeSession(id);
    this.sessions.delete(id);
    this.deps.broadcast({ type: "session.deleted", sessionId: id });
  }

  onPersonasChanged() {
    this.each((s) => void s.onPersonaChanged());
  }

  async shutdown() {
    await Promise.all([...this.sessions.values()].filter((s) => s.isActive).map((s) => s.stop()));
  }
}
