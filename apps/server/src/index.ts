import { promises as fs } from "node:fs";
import type { LauncherMessage } from "@ph/shared";
import { ProviderRegistry } from "./agent/providers.js";
import { SessionManager } from "./agent/session.js";
import { Hub, startApi } from "./api.js";
import { AttachmentStore } from "./attachments.js";
import { ConnectionManager } from "./connections/manager.js";
import { HomeInUseError, HomeLock, choosePort, moveLegacyHome } from "./home.js";
import { applyNetwork, loadExtraCas } from "./network.js";
import { migrateConnections } from "./connections/migrate.js";
import { ModelCatalog } from "./catalog.js";
import { MemoryStore } from "./memory.js";
import { PersonaStore } from "./personas.js";
import { UsageLedger } from "./usage.js";
import { CertAuthority } from "./proxy/ca.js";
import { EgressProxy } from "./proxy/egress.js";
import { PodmanRuntime } from "./sandbox/podman.js";
import { SecretStore } from "./secrets.js";
import { HOME_FROM_ENV, LEGACY_HOME, ensureHome, loadSettings, paths } from "./settings.js";
import { SkillRegistry } from "./skills.js";
import { debounce, errMsg, exists, log, randomId, writeFileAtomic } from "./util.js";

async function apiToken(): Promise<string> {
  if (await exists(paths.apiToken)) {
    const t = (await fs.readFile(paths.apiToken, "utf8")).trim();
    if (t.length >= 32) return t;
  }
  const t = randomId("", 24);
  await writeFileAtomic(paths.apiToken, t, 0o600);
  return t;
}

const VERSION = process.env.SWAN_VERSION ?? "dev";

// Only when a launcher (the desktop app) started the server with an IPC channel.
const tellLauncher = (msg: LauncherMessage) =>
  new Promise<void>((resolve) => {
    if (!process.send || !process.connected) return resolve();
    process.send(msg, undefined, {}, () => resolve());
  });

async function main() {
  if (!HOME_FROM_ENV) await moveLegacyHome(LEGACY_HOME, paths.home);
  await ensureHome();
  const settings = await loadSettings();
  const token = await apiToken();
  const lock = await HomeLock.claim({ home: paths.home, file: paths.serverLock, token, configPort: settings.port, version: VERSION });
  process.on("exit", () => lock.releaseSync());
  // The app asks for this: a taken port should not stop Swan from starting.
  const portFallback = process.env.PH_PORT_FALLBACK === "1";
  const extraCas = await loadExtraCas(settings.caFiles);
  await applyNetwork(settings, extraCas, paths.extraCa);

  // Model-provider keys stay host-side secrets; everything else becomes a connection once.
  const providerKeys = new Set(Object.values(settings.providers).flatMap((p) => (p.apiKeySecret ? [p.apiKeySecret] : p.type === "copilot" ? ["COPILOT_GITHUB_TOKEN"] : [])));
  await migrateConnections(providerKeys).catch((e) => log.error("connections", `could not convert credentials to connections: ${errMsg(e)}`));

  const secrets = new SecretStore();
  await secrets.tryLoad();
  secrets.watch();

  const connections = new ConnectionManager(secrets, settings);
  await connections.loadConfig();
  connections.watch();

  const skills = new SkillRegistry(settings);
  await skills.load();
  skills.watch();

  const personas = new PersonaStore(settings, connections, skills);
  await personas.load();
  personas.watch();

  const ca = await CertAuthority.load();
  const proxy = new EgressProxy(connections, ca);
  settings.proxyPort = await proxy.listen(await choosePort(settings.proxyPort, portFallback));

  const runtime = new PodmanRuntime(settings, ca, extraCas);
  const providers = new ProviderRegistry(settings, secrets);
  const hub = new Hub();
  const memory = new MemoryStore();
  const usage = new UsageLedger();
  await usage.load();
  const catalog = new ModelCatalog(settings, secrets, providers);
  const attachments = new AttachmentStore();
  // eslint-disable-next-line prefer-const
  let sessions: SessionManager;
  sessions = new SessionManager({
    settings, runtime, proxy, connections, personas, skills, providers, memory, usage, attachments, catalog,
    broadcast: hub.broadcast,
    onApprovalsChanged: () => hub.broadcast({ type: "approvals.updated", approvals: sessions.pendingApprovals() }),
  });
  memory.on("changed", (personaId) => hub.broadcast({ type: "memory.updated", personaId }));
  await sessions.loadAll();

  const personaSummaries = () => personas.list().map((p) => personas.summary(p));
  secrets.on("status", (error) => hub.broadcast({ type: "secrets.status", error }));
  secrets.on("changed", () => {
    catalog.invalidate();
    hub.broadcast({ type: "providers.updated", providers: providers.status() });
  });
  const broadcastConnections = debounce(() => hub.broadcast({ type: "connections.updated", connections: connections.status(), changed: [] }), 50);
  connections.on("updated", broadcastConnections);
  connections.on("changed", (changed) => {
    log.info("connections", `changed: ${changed.join(", ")}`);
    hub.broadcast({ type: "connections.updated", connections: connections.status(), changed });
    hub.broadcast({ type: "personas.updated", personas: personaSummaries() });
  });
  connections.on("configLoaded", () => personas.revalidate());
  personas.on("changed", () => {
    hub.broadcast({ type: "personas.updated", personas: personaSummaries() });
    broadcastConnections();
    sessions.onPersonasChanged();
  });
  skills.on("changed", () => personas.revalidate());
  runtime.on("status", (s) => hub.broadcast({ type: "runtime.status", runtime: s }));
  proxy.on("event", (e) => hub.broadcast({ type: "egress", event: e }));

  settings.port = await choosePort(settings.port, portFallback);
  const { port } = await startApi({ settings, token, secrets, connections, personas, skills, runtime, proxy, providers, sessions, memory, usage, catalog, attachments }, hub);
  await lock.update({ port, proxyPort: settings.proxyPort });
  log.info("main", `harness home: ${paths.home}`);
  void tellLauncher({ type: "ready", url: `http://127.0.0.1:${port}/`, port, proxyPort: settings.proxyPort, home: paths.home, version: VERSION });

  void runtime.init().then(() => runtime.removeOrphans());

  let stopping = false;
  const shutdown = async () => {
    if (stopping) process.exit(1);
    stopping = true;
    log.info("main", "shutting down: stopping session containers");
    await sessions.shutdown().catch(() => {});
    await providers.shutdown().catch(() => {});
    process.exit(0);
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
  // The launcher went away (quit or crashed): do not outlive it.
  process.on("disconnect", shutdown);
}

main().catch(async (e) => {
  log.error("main", errMsg(e));
  if (e instanceof HomeInUseError) await tellLauncher({ type: "home-in-use", home: e.home, url: e.url, pid: e.pid });
  else await tellLauncher({ type: "fatal", message: errMsg(e) });
  process.exit(e instanceof HomeInUseError ? 3 : 1);
});
