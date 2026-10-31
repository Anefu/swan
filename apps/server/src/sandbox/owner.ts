import { z } from "zod";

// Labels on Swan's containers. ph.home is the real path of the home whose server made the container,
// so two Swans that share Podman names (a second PH_HOME with default runtime settings) leave each
// other's containers alone.
export const HOME_LABEL = "ph.home";
export const RELAY_LABEL = "ph.relay";
export const SESSION_LABEL = "ph.session";

const Labels = z
  .record(z.string(), z.string())
  .nullish()
  .transform((l) => l ?? {});

const Inspected = z.array(z.object({ State: z.object({ Running: z.boolean() }), Config: z.object({ Labels }) })).min(1);

const Listed = z
  .array(
    z.object({
      Names: z.array(z.string()).min(1),
      Labels,
      Networks: z
        .array(z.string())
        .nullish()
        .transform((n) => n ?? []),
    }),
  )
  .nullable() // some Podman versions print null for no containers
  .transform((l) => l ?? []);

export interface RelayContainer {
  running: boolean;
  labels: Record<string, string>;
}

export interface ListedContainer {
  name: string;
  labels: Record<string, string>;
  networks: string[];
}

function parseJson<T>(schema: z.ZodType<T>, stdout: string, what: string): T {
  let raw: unknown;
  try {
    raw = JSON.parse(stdout);
  } catch {
    throw new Error(`${what}: output is not JSON`);
  }
  const r = schema.safeParse(raw);
  if (!r.success) {
    const issue = r.error.issues[0];
    throw new Error(`${what}: unexpected output at ${issue?.path.join(".") || "(root)"}: ${issue?.message}`);
  }
  return r.data;
}

/** `podman container inspect <name>` output. */
export function parseInspect(stdout: string): RelayContainer {
  const [c] = parseJson(Inspected, stdout, "podman container inspect");
  return { running: c!.State.Running, labels: c!.Config.Labels };
}

/** `podman ps --format json` output. */
export function parsePs(stdout: string): ListedContainer[] {
  return parseJson(Listed, stdout, "podman ps").map((c) => ({ name: c.Names[0]!, labels: c.Labels, networks: c.Networks }));
}

export type RelayPlan = { action: "create" | "keep" | "replace" } | { action: "refuse"; owner: string };

/**
 * What to do with the container that holds the relay's name. One labelled with another home is that
 * Swan's relay, running or not: replacing it would cut off that Swan's sandboxes, and it would refuse
 * ours in turn. One without a home label (older versions) is replaced, which also labels it.
 */
export function planRelay(found: RelayContainer | null, want: { home: string; relay: string; force?: boolean }): RelayPlan {
  if (!found) return { action: "create" };
  const owner = found.labels[HOME_LABEL];
  if (owner && owner !== want.home) return { action: "refuse", owner };
  const current = owner === want.home && found.running && found.labels[RELAY_LABEL] === want.relay;
  return { action: current && !want.force ? "keep" : "replace" };
}

export function relayTakenMessage(relayName: string, owner: string, configFile: string): string {
  return (
    `The Podman relay ${relayName} belongs to the Swan for ${owner}, which uses the same runtime names. ` +
    `Give this Swan its own: set runtime.network, runtime.subnet, runtime.relayIp and runtime.relayName in ${configFile} ` +
    `(for example { network: swan-test, subnet: 10.231.0.0/24, relayIp: 10.231.0.2, relayName: swan-test-relay }), then restart Swan.`
  );
}

/**
 * Session containers a starting server may remove: its own home's on any network (the runtime
 * settings may have changed), and unlabelled ones from older versions on its network.
 */
export function orphanSessions(list: ListedContainer[], opts: { home: string; network: string; keep: Set<string> }): string[] {
  return list
    .filter((c) => c.labels[SESSION_LABEL] !== undefined && !opts.keep.has(c.name))
    .filter((c) => {
      const owner = c.labels[HOME_LABEL];
      return owner ? owner === opts.home : c.networks.includes(opts.network);
    })
    .map((c) => c.name);
}
