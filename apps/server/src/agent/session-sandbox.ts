// A conversation's sandbox: the container, its MCP servers and its registration with the proxy,
// started on demand and restarted between turns when settings it took at its start change.
import type { AttachmentMeta } from "@ph/shared";
import type { ConnectionManager } from "../connections/manager.js";
import type { PersonaStore } from "../personas.js";
import type { EgressProxy } from "../proxy/egress.js";
import { hasTools } from "../sandbox/image.js";
import type { PodmanRuntime } from "../sandbox/podman.js";
import type { Settings } from "../settings.js";
import type { SkillRegistry } from "../skills.js";
import { SessionMcp, credentialValues, scrubValues, type McpCredentials } from "./mcp.js";
import { ENV_FILE, type SessionCredentials } from "./session-credentials.js";

export interface SandboxHost {
  id: string;
  personaId: string;
  settings: Settings;
  runtime: PodmanRuntime;
  proxy: EgressProxy;
  connections: ConnectionManager;
  personas: PersonaStore;
  skills: SkillRegistry;
  creds: SessionCredentials;
  proxyToken: string;
  allowances(): string[];
  starting(detail: string): void;
  notice(level: "info" | "warn" | "error", text: string): void;
  /** Something besides a turn uses the sandbox: an approval, /dream or a sub-agent. */
  inUse(): boolean;
  /** Build the conversation's tools on the running container. */
  started(o: { connectionSkills: string[]; mcp: SessionMcp }): Promise<void>;
  /** The container is up, with its tools and sign-ins under way. */
  ready(): void;
  /** The container is gone: what ran on it ends too. */
  stopped(): void;
}

export class SessionSandbox {
  container: string | null = null;
  workdir = "/workspace";
  private mcp: SessionMcp | null = null;
  private starting: Promise<void> | null = null;
  private restarting: Promise<void> | null = null;
  private startedWith: Record<string, string> | null = null; // what the running container took at its start
  private restartFor: string[] | null = null; // of those, what has changed since: restart when nothing uses it
  private toolsNoticed = false;

  constructor(private host: SandboxHost) {}

  get running() {
    return this.container !== null;
  }

  /** A start in progress or a running container: messages for it need not stop it afterwards. */
  get wanted() {
    return this.container !== null || this.starting !== null;
  }

  async ensureStarted(): Promise<void> {
    if (this.restarting) await this.restarting;
    if (this.container) return;
    this.starting ??= this.start().finally(() => (this.starting = null));
    return this.starting;
  }

  /** What a container takes only when it starts, under the names the restart notice uses. */
  private settingsNow(): Record<string, string> | null {
    const persona = this.host.personas.get(this.host.personaId);
    const cfg = persona?.config;
    if (!persona || !cfg) return null;
    const credentials = Object.entries(cfg.connections).flatMap(([conn, c]) => c.rules.map((r) => `${conn}/${r.credential}`));
    const settings = {
      folders: persona.folders,
      skills: cfg.skills,
      "MCP servers": cfg.mcpServers,
      "environment variables": cfg.env,
      "sandbox settings": cfg.sandbox,
      credentials: [...new Set(credentials)].sort(),
    };
    return Object.fromEntries(Object.entries(settings).map(([k, v]) => [k, JSON.stringify(v)]));
  }

  /** A persona edit: rules apply at once; settings the container took at its start restart it, between turns. */
  async onPersonaChanged(turnRunning: boolean) {
    this.refreshPolicy();
    const now = this.settingsNow();
    if (!this.container || !this.startedWith || !now) return;
    const changed = Object.keys(now).filter((k) => now[k] !== this.startedWith![k]);
    this.restartFor = changed.length ? changed : null;
    if (!turnRunning) await this.restartIfDue();
  }

  /**
   * Restart the container for changed settings once nothing uses it: no turn, approval, /dream or
   * sub-agent. The next turn starts it again; the conversation and "until stopped" rules stay.
   */
  async restartIfDue() {
    const changed = this.restartFor;
    if (!changed || !this.container || this.restarting || this.host.inUse()) return;
    if (this.host.personas.get(this.host.personaId)?.errors.length) return; // waits until the persona can start
    this.restarting = this.teardown().finally(() => (this.restarting = null));
    await this.restarting;
    const what = changed.length > 1 ? `${changed.slice(0, -1).join(", ")} and ${changed.at(-1)}` : changed[0];
    this.host.notice("info", `The sandbox restarts with the next message to apply the changed ${what}. Anything outside your folders, like installed packages or programs it was running, starts fresh.`);
  }

  private registration() {
    const h = this.host;
    const cfg = h.personas.get(h.personaId)?.config;
    return {
      sessionId: h.id,
      personaId: h.personaId,
      token: h.proxyToken,
      // Hosts allowed "until stopped" ride along with the persona's own allowlist.
      allowHosts: [...(cfg?.network.allow ?? []), ...h.allowances().filter((a) => a.startsWith("net:")).map((a) => a.slice(4))],
      internalHosts: cfg?.network.internal ?? [], // only from Settings, never from an "Allow" card
      otherCredentials: cfg?.network.otherCredentials ?? [], // the same
      ...h.creds.proxyFields(),
    };
  }

  /** Persona edits (allowlist, credential rules, permissions) apply to a running sandbox. */
  refreshPolicy() {
    if (this.container) this.host.proxy.register(this.registration());
  }

  private render = (template: string) => this.host.creds.render(template);

  private async start(): Promise<void> {
    const h = this.host;
    const { personas, runtime, skills, connections, settings, creds } = h;
    const persona = personas.get(h.personaId);
    if (!persona?.config) throw new Error(`persona "${h.personaId}" is missing or invalid`);
    if (persona.errors.length) throw new Error(`persona has problems: ${persona.errors.join("; ")}`);
    const cfg = persona.config;
    h.starting(creds.commandConnections().length ? "checking connections" : "starting sandbox container");

    const prepared = await creds.prepare();
    h.starting("starting sandbox container");
    h.proxy.register(this.registration());

    this.workdir = cfg.sandbox.workdir ?? persona.folders[0]?.mountPath ?? "/workspace";
    // Connection wrappers' variables live in a file every bash shell reads, so a later sign-in applies to new shells.
    const env: Record<string, string> = { ...creds.staticEnv(), BASH_ENV: ENV_FILE };
    for (const [k, v] of Object.entries(cfg.env)) env[k] = this.render(v);
    const connectionSkills = creds.commandConnections().flatMap((c) => {
      const cc = connections.configOf(c);
      return cc?.type === "command" && cc.skill && !cfg.skills.includes(cc.skill) && skills.get(cc.skill) ? [cc.skill] : [];
    });
    const skillMounts = [...cfg.skills, ...connectionSkills].flatMap((name) => {
      const s = skills.get(name);
      return s ? [{ name, hostPath: s.hostPath }] : [];
    });

    let mcp: SessionMcp;
    try {
      if (cfg.sandbox.image) h.starting(`preparing the sandbox from ${cfg.sandbox.image}`);
      else if (cfg.sandbox.tools) h.starting("preparing the sandbox with this persona's tools");
      const image = await runtime.sessionImage(cfg.sandbox);
      if (!cfg.sandbox.tools && hasTools(settings.sandboxTools) && !this.toolsNoticed) {
        this.toolsNoticed = true;
        h.notice("warn", "sandboxTools in config.yaml is being replaced: move it to this persona's sandbox.tools.");
      }
      h.starting("starting sandbox container");
      this.container = await runtime.startSession({
        sessionId: h.id,
        personaId: persona.id,
        image,
        folders: persona.folders,
        skills: skillMounts,
        env,
        proxyUrl: runtime.proxyUrl(h.id, h.proxyToken),
        workdir: this.workdir,
        cpus: cfg.sandbox.cpus,
        memory: cfg.sandbox.memory,
        pidsLimit: cfg.sandbox.pidsLimit,
      });

      for (const p of await creds.writeMaterials()) h.notice("warn", p);
      const named = new Set(creds.namedRefs());
      const mcpCreds: McpCredentials = {
        resolve: (t) => connections.resolveHost(t, named),
        hosts: (ref) => connections.resolve(ref)?.hosts ?? [],
        scrub: (text, refs) => scrubValues(text, refs.flatMap((ref) => credentialValues(connections.resolve(ref)).map((secret) => ({ secret, placeholder: `[credential ${ref}]` })))),
      };
      mcp = this.mcp = new SessionMcp(runtime, mcpCreds, settings, this.container, this.workdir, this.render);
      const problems = await mcp.start(cfg.mcpServers, (msg) => h.starting(msg));
      for (const p of problems) h.notice("warn", p);
    } catch (e) {
      await this.teardown();
      throw e;
    }

    await h.started({ connectionSkills, mcp });
    for (const p of prepared.problems) h.notice("warn", p);
    // Turns go ahead; requests that need the connection fail until the user signs in.
    for (const conn of prepared.needSignIn) void creds.signIn(conn);
    this.startedWith = this.settingsNow();
    h.ready();
  }

  async teardown() {
    const h = this.host;
    this.startedWith = null;
    this.restartFor = null;
    h.stopped();
    await this.mcp?.close().catch(() => {});
    this.mcp = null;
    h.proxy.unregister(h.id);
    h.creds.release();
    if (this.container) await h.runtime.stopSession(h.id).catch(() => {});
    this.container = null;
  }

  /** Hot reload: the proxy reads values live; reconnect http MCP servers and tell the user about static edits. */
  async onCredentialsChanged(refs: string[]) {
    const h = this.host;
    if (!this.container) return;
    const named = new Set(h.creds.namedRefs());
    const mine = refs.filter((r) => named.has(r));
    if (!mine.length) return;
    h.creds.ensurePlaceholders();
    this.refreshPolicy();
    const reconnected = (await this.mcp?.onCredentialsChanged(mine)) ?? [];
    // Wrapper renewals are routine; only edits to static credentials get a notice.
    const edited = mine.filter((r) => h.connections.configOf(r.split("/")[0])?.type === "static");
    if (edited.length || reconnected.length)
      h.notice("info", `Credentials reloaded: ${(edited.length ? edited : mine).join(", ")}, applied to new requests immediately${reconnected.length ? `; reconnected MCP ${reconnected.join(", ")}` : ""}.`);
  }

  /** A command connection returned new files or env: rewrite what changed. */
  async onMaterials(conn: string) {
    const h = this.host;
    if (!this.container || !h.creds.commandConnections().includes(conn)) return;
    h.creds.ensurePlaceholders();
    this.refreshPolicy();
    for (const p of await h.creds.writeMaterials()) h.notice("warn", p);
  }

  /** Copy attachments into the running container so tools can open them. */
  async placeFiles(files: { meta: AttachmentMeta; data: Buffer }[] | undefined) {
    if (!files?.length || !this.container) return;
    for (const f of files) {
      const r = await this.host.runtime.exec(this.container, ["sh", "-c", 'mkdir -p "$(dirname "$1")" && base64 -d > "$1"', "sh", f.meta.sandboxPath], {
        input: f.data.toString("base64"),
        timeoutMs: 60_000,
      });
      if (r.code !== 0) this.host.notice("warn", `Could not copy ${f.meta.name} into the sandbox: ${r.stderr.trim()}`);
    }
  }

  /** A command for a watcher, started if needed; its traffic goes through the proxy like the agent's. */
  async exec(argv: string[], timeoutMs = 60_000) {
    await this.ensureStarted();
    if (!this.container) throw new Error("the sandbox isn't running");
    return this.host.runtime.exec(this.container, argv, { timeoutMs });
  }
}
