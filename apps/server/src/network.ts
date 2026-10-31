import { promises as fs } from "node:fs";
import tls from "node:tls";
import { Agent, EnvHttpProxyAgent, setGlobalDispatcher } from "undici";
import type { Settings } from "./settings.js";
import { expandHome, writeFileAtomic } from "./util.js";

// Local model servers, the home probe and the egress proxy's own listener never go through a proxy.
const ALWAYS_DIRECT = ["localhost", "127.0.0.1", "::1"];

const PEM = /-----BEGIN CERTIFICATE-----[\s\S]+?-----END CERTIFICATE-----/g;

/** The certificates in a PEM text. */
export function splitPem(text: string): string[] {
  return text.match(PEM) ?? [];
}

/** caFiles, read and checked so a wrong path or file fails at start with its name. */
export async function loadExtraCas(files: string[]): Promise<string[]> {
  const out: string[] = [];
  for (const f of files) {
    const text = await fs.readFile(expandHome(f), "utf8").catch((e: NodeJS.ErrnoException) => {
      throw new Error(`caFiles: cannot read ${f} (${e.code ?? e.message})`);
    });
    const certs = splitPem(text);
    if (!certs.length) throw new Error(`caFiles: ${f} has no PEM certificates (-----BEGIN CERTIFICATE-----)`);
    out.push(...certs);
  }
  return out;
}

export function noProxyList(proxy: Settings["proxy"]): string[] {
  return [...new Set([...ALWAYS_DIRECT, ...(proxy?.noProxy ?? [])])];
}

let hostEnv: Record<string, string> = {};

/**
 * Applies `proxy` and `caFiles` to this process (model calls, http MCP servers and anything else
 * that uses fetch) and records them for programs Swan starts on the host. The egress proxy's
 * connections for agents are separate and not affected.
 */
export async function applyNetwork(settings: Pick<Settings, "proxy">, extraCas: string[], extraCaFile: string): Promise<void> {
  const env: Record<string, string> = {};
  // Giving `ca` replaces the defaults, so start from them (bundled roots, plus the system's when Node uses those).
  const ca = extraCas.length ? [...(tls.getCACertificates?.("default") ?? tls.rootCertificates), ...extraCas] : undefined;
  if (ca) {
    tls.setDefaultCACertificates?.(ca); // Node 22.19+: every other TLS connection too
    await writeFileAtomic(extraCaFile, extraCas.join("\n") + "\n", 0o644);
    env.NODE_EXTRA_CA_CERTS = extraCaFile;
  }
  const tlsOptions = ca ? { connect: { ca }, requestTls: { ca }, proxyTls: { ca } } : {};
  if (settings.proxy) {
    const { url } = settings.proxy;
    const noProxy = noProxyList(settings.proxy).join(",");
    setGlobalDispatcher(new EnvHttpProxyAgent({ ...tlsOptions, httpProxy: url, httpsProxy: url, noProxy }));
    Object.assign(env, { HTTPS_PROXY: url, HTTP_PROXY: url, NO_PROXY: noProxy, https_proxy: url, http_proxy: url, no_proxy: noProxy });
  } else if (ca) {
    setGlobalDispatcher(new Agent(tlsOptions));
  }
  hostEnv = env;
}

/** Proxy and certificate variables for the Copilot runtime and connection wrappers (empty when not configured). */
export const networkEnv = (): Record<string, string> => ({ ...hostEnv });
