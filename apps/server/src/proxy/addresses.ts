// Where the sandbox's traffic may go: one DNS answer, checked against the addresses that are never
// reachable and the private ranges only a persona's internal hosts may use.
import dns from "node:dns/promises";
import net from "node:net";
import os from "node:os";

// Never reachable, whatever the persona lists: this computer (loopback), link-local and cloud
// metadata, CGNAT (Tailscale), multicast, reserved and benchmarking space, NAT64, and Podman's own
// networks (its default network and the Podman machine's).
const NEVER = new net.BlockList();
for (const [a, p] of [
  ["0.0.0.0", 8], ["100.64.0.0", 10], ["127.0.0.0", 8], ["169.254.0.0", 16], ["192.0.0.0", 24], ["198.18.0.0", 15],
  ["224.0.0.0", 4], ["240.0.0.0", 4], ["10.88.0.0", 16], ["192.168.127.0", 24],
] as const) NEVER.addSubnet(a, p, "ipv4");
for (const [a, p] of [["::", 128], ["::1", 128], ["fe80::", 10], ["ff00::", 8], ["64:ff9b::", 96], ["64:ff9b:1::", 48]] as const)
  NEVER.addSubnet(a, p, "ipv6");

// Private ranges company networks use: reachable only for hosts a persona lists as internal.
const COMPANY = new net.BlockList();
for (const [a, p] of [["10.0.0.0", 8], ["172.16.0.0", 12], ["192.168.0.0", 16]] as const) COMPANY.addSubnet(a, p, "ipv4");
COMPANY.addSubnet("fc00::", 7, "ipv6");

function inList(list: net.BlockList, ip: string): boolean {
  const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/i.exec(ip);
  if (mapped) return list.check(mapped[1], "ipv4");
  return list.check(ip, net.isIPv6(ip) ? "ipv6" : "ipv4");
}

export const isPrivateAddress = (ip: string): boolean => inList(NEVER, ip) || inList(COMPANY, ip);

/** This computer's own addresses, read at check time (they change with the network). */
function ownAddresses(): net.BlockList {
  const list = new net.BlockList();
  for (const i of Object.values(os.networkInterfaces()).flat())
    if (i) list.addAddress(i.address.replace(/%.*$/, ""), i.family === "IPv6" ? "ipv6" : "ipv4");
  return list;
}

/** Subnets in CIDR notation as a list; Swan's own sandbox network, for example. */
export function subnetList(cidrs: string[]): net.BlockList {
  const list = new net.BlockList();
  for (const c of cidrs) {
    const [a, p] = c.split("/");
    if (a && p && net.isIP(a)) list.addSubnet(a, Number(p), net.isIPv6(a) ? "ipv6" : "ipv4");
  }
  return list;
}

const isLocalName = (h: string) => h === "localhost" || h.endsWith(".localhost") || h.endsWith(".containers.internal") || h.endsWith(".docker.internal");

export type Lookup = (host: string) => Promise<string[]>;
const systemLookup: Lookup = async (host) => (await dns.lookup(host, { all: true, verbatim: true })).map((a) => a.address);

export interface Destination {
  address: string;
  port: number;
  internal?: boolean; // on a company range
}

/**
 * Resolve once on this computer, check every address and pin the first, so a DNS answer cannot
 * change between check and connect. Company ranges only when the persona lists the host as
 * internal; loopback, link-local, CGNAT, reserved space, Swan's and Podman's networks and this
 * computer's own addresses never.
 */
export async function resolveChecked(host: string, port: number, opts: { internal: boolean; own?: net.BlockList; lookup?: Lookup }): Promise<Destination> {
  if (isLocalName(host) || (!opts.internal && (host.endsWith(".internal") || host.endsWith(".local"))))
    throw new Error(`${host} is a local name, not reachable from the sandbox`);
  let addrs: string[] = [host];
  if (!net.isIP(host)) addrs = await (opts.lookup ?? systemLookup)(host).catch(() => []);
  if (addrs.length === 0) throw new Error(`${host} does not resolve on this computer`);
  const mine = ownAddresses();
  for (const a of addrs) {
    if (inList(NEVER, a) || inList(mine, a) || (opts.own && inList(opts.own, a))) throw new Error(`${host} resolves to private address ${a}`);
    if (inList(COMPANY, a) && !opts.internal)
      throw new Error(`${host} resolves to ${a} on a private network; to reach it, list it under "On your company network" in the persona's Settings`);
  }
  return { address: addrs[0]!, port, ...(addrs.some((a) => inList(COMPANY, a)) ? { internal: true } : {}) };
}
