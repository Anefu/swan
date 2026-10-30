import { promises as fs } from "node:fs";
import { ProviderRegistry } from "./agent/providers.js";
import { SessionManager } from "./agent/session.js";
import { Hub, startApi } from "./api.js";
import { ModelCatalog } from "./catalog.js";
import { MemoryStore } from "./memory.js";
import { PersonaStore } from "./personas.js";
import { UsageLedger } from "./usage.js";
import { CertAuthority } from "./proxy/ca.js";
import { EgressProxy } from "./proxy/egress.js";
import { PodmanRuntime } from "./sandbox/podman.js";
import { SecretStore } from "./secrets.js";
import { ensureHome, loadSettings, paths } from "./settings.js";
import { SkillRegistry } from "./skills.js";
import { errMsg, exists, log, randomId, writeFileAtomic } from "./util.js";

async function apiToken(): Promise<string> {
  if (await exists(paths.apiToken)) {
    const t = (await fs.readFile(paths.apiToken, "utf8")).trim();
    if (t.length >= 32) return t;
  }
  const t = randomId("", 24);
  await writeFileAtomic(paths.apiToken, t, 0o600);
  return t;
}

async function main() {
  await ensureHome();
  const settings = await loadSettings();
  const token = await apiToken();

  const secrets = new SecretStore();
  await secrets.load().catch((e) => log.error("secrets", `could not load secrets: ${errMsg(e)}`));
  secrets.watch();

  const skills = new SkillRegistry(settings);
  await skills.load();
  skills.watch();

  const personas = new PersonaStore(settings, secrets, skills);
  await personas.load();
  personas.watch();

  const ca = await CertAuthority.load();
  const proxy = new EgressProxy(secrets, ca);
  await proxy.listen(settings.proxyPort);

  const runtime = new PodmanRuntime(settings, ca);
  const providers = new ProviderRegistry(settings, secrets);
  const hub = new Hub();
  const memory = new MemoryStore();
  const usage = new UsageLedger();
  await usage.load();
  const catalog = new ModelCatalog(settings, secrets, providers);
  // eslint-disable-next-line prefer-const
  let sessions: SessionManager;
  sessions = new SessionManager({
    settings, runtime, proxy, secrets, personas, skills, providers, memory, usage,
    broadcast: hub.broadcast,
    onApprovalsChanged: () => hub.broadcast({ type: "approvals.updated", approvals: sessions.pendingApprovals() }),
  });
  memory.on("changed", (personaId) => hub.broadcast({ type: "memory.updated", personaId }));
  await sessions.loadAll();

  const personaSummaries = () => personas.list().map((p) => personas.summary(p));
  secrets.on("changed", (changed) => {
    log.info("secrets", `changed: ${changed.join(", ")}`);
    hub.broadcast({ type: "credentials.updated", credentials: secrets.status(personas.usedBy()), changed });
    hub.broadcast({ type: "personas.updated", personas: personaSummaries() });
    sessions.onSecretsChanged(changed);
    catalog.invalidate();
  });
  personas.on("changed", () => {
    hub.broadcast({ type: "personas.updated", personas: personaSummaries() });
    hub.broadcast({ type: "credentials.updated", credentials: secrets.status(personas.usedBy()), changed: [] });
    sessions.onPersonasChanged();
  });
  skills.on("changed", () => personas.revalidate());
  runtime.on("status", (s) => hub.broadcast({ type: "runtime.status", runtime: s }));
  proxy.on("event", (e) => hub.broadcast({ type: "egress", event: e }));

  await startApi({ settings, token, secrets, personas, skills, runtime, proxy, providers, sessions, memory, usage, catalog }, hub);
  log.info("main", `harness home: ${paths.home}`);

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
}

main().catch((e) => {
  log.error("main", errMsg(e));
  process.exit(1);
});
