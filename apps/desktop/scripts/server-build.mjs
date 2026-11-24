// The server as the app ships it, shared by build.mjs (the app's Resources) and
// build-server-linux.mjs (the headless Linux package): the bundle, the Copilot SDK it loads from
// disk with the native packages for the target platform, the Containerfile, examples and licences;
// and the pinned Node runtime.
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";
import * as esbuild from "esbuild";

export const desktop = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
export const repo = path.resolve(desktop, "../..");
const cache = path.join(desktop, ".cache");

/**
 * Writes the server and what it reads at runtime into `out` (server/, sandbox/, examples/,
 * LICENSE, NOTICE). `target` is the platform it will run on ({ os, cpu } as in process.platform
 * and process.arch); native packages for another platform come from the registry, checked
 * against the lockfile.
 */
export async function buildServer(out, target) {
  // Server: one ESM file. Workspace packages are TypeScript sources, so they are bundled in.
  await esbuild.build({
    entryPoints: [path.join(repo, "apps", "server", "src", "index.ts")],
    outfile: path.join(out, "server", "index.mjs"),
    bundle: true,
    platform: "node",
    format: "esm",
    target: "node22",
    // The Copilot SDK finds its runtime next to its own files; ws loads these only if present.
    external: ["@github/copilot-sdk", "bufferutil", "utf-8-validate"],
    banner: { js: "import { createRequire as __swanRequire } from 'node:module'; const require = __swanRequire(import.meta.url);" },
    legalComments: "linked",
    logLevel: "warning",
  });
  // Node looks for the nearest package.json to scope the bundle; without one here it walks up past
  // the app (into ~/Documents for a build inside a checkout, which makes macOS ask for access).
  fs.writeFileSync(path.join(out, "server", "package.json"), '{ "type": "module", "private": true }\n');
  await copyPackage("@github/copilot-sdk", path.join(repo, "apps", "server"), path.join(out, "server", "node_modules"), target);

  fs.mkdirSync(path.join(out, "sandbox"), { recursive: true });
  for (const f of ["Containerfile", "Containerfile.base"]) fs.copyFileSync(path.join(repo, "sandbox", f), path.join(out, "sandbox", f));
  fs.cpSync(path.join(repo, "examples"), path.join(out, "examples"), { recursive: true });
  for (const f of ["LICENSE", "NOTICE"]) fs.copyFileSync(path.join(repo, f), path.join(out, f)); // Apache 2.0: ship both
}

/** Where Node would resolve `name` from `fromDir`. */
function packageDir(name, fromDir) {
  for (let dir = fromDir; ; dir = path.dirname(dir)) {
    const candidate = path.join(dir, "node_modules", name);
    if (fs.existsSync(path.join(candidate, "package.json"))) return fs.realpathSync(candidate);
    if (path.dirname(dir) === dir) return null;
  }
}

/** Copy a package and its installed dependencies as real files (pnpm keeps them as links). */
async function copyPackage(name, fromDir, dest, target, seen = new Set()) {
  if (seen.has(name)) return;
  const dir = packageDir(name, fromDir);
  if (!dir) throw new Error(`cannot find ${name} from ${fromDir}`);
  seen.add(name);
  fs.cpSync(dir, path.join(dest, name), {
    recursive: true,
    dereference: true,
    filter: (src) => !path.relative(dir, src).split(path.sep).includes("node_modules"),
  });
  const pkg = JSON.parse(fs.readFileSync(path.join(dir, "package.json"), "utf8"));
  for (const dep of Object.keys(pkg.dependencies ?? {})) await copyPackage(dep, dir, dest, target, seen);
  for (const [dep, version] of Object.entries(pkg.optionalDependencies ?? {})) {
    const entry = lockEntry(dep, version);
    if (entry && !forTarget(dep, entry, target)) continue; // another platform's native package
    const installed = packageDir(dep, dir);
    if (installed && (!entry || JSON.parse(fs.readFileSync(path.join(installed, "package.json"), "utf8")).version === version)) {
      await copyPackage(dep, dir, dest, target, seen);
    } else if (entry && entry.os) {
      // The target's native package, not installed on this machine.
      await fetchPackage(dep, version, entry.resolution.integrity, path.join(dest, dep));
      seen.add(dep);
    }
  }
}

let lockfile;
/** The lockfile's entry for name@version (integrity, os, cpu, libc), if it has one. */
function lockEntry(name, version) {
  if (!lockfile) {
    const YAML = createRequire(path.join(repo, "apps", "server", "package.json"))("yaml");
    lockfile = YAML.parse(fs.readFileSync(path.join(repo, "pnpm-lock.yaml"), "utf8")).packages ?? {};
  }
  return lockfile[`${name}@${version}`];
}

/** Whether a package's os/cpu/libc fields allow the target. Linux means glibc: the Copilot SDK's musl packages say so only in their names. */
function forTarget(name, entry, target) {
  const allows = (list, value) => !list || list.includes(value);
  const glibc = target.os !== "linux" || (allows(entry.libc, "glibc") && !/musl/.test(name));
  return allows(entry.os, target.os) && allows(entry.cpu, target.cpu) && glibc;
}

/** Downloads name@version from the npm registry into `dest`, checked against the lockfile's integrity. */
async function fetchPackage(name, version, integrity, dest) {
  const [algo, want] = integrity.split("-", 2);
  const file = path.join(cache, `${name.replace("/", "+")}-${version}.tgz`);
  const digest = (f) => createHash(algo).update(fs.readFileSync(f)).digest("base64");
  fs.mkdirSync(cache, { recursive: true });
  if (!fs.existsSync(file) || digest(file) !== want) {
    const registry = (process.env.npm_config_registry || "https://registry.npmjs.org/").replace(/\/?$/, "/");
    const url = `${registry}${name}/-/${name.split("/").pop()}-${version}.tgz`;
    console.log(`downloading ${url}`);
    const res = await fetch(url);
    if (!res.ok) throw new Error(`${url}: HTTP ${res.status}`);
    fs.writeFileSync(file, Buffer.from(await res.arrayBuffer()));
    if (digest(file) !== want) {
      fs.rmSync(file);
      throw new Error(`${name}@${version} does not match the integrity in pnpm-lock.yaml`);
    }
  }
  fs.mkdirSync(dest, { recursive: true });
  execFileSync("tar", ["-xzf", file, "-C", dest, "--strip-components=1"]); // npm packs into package/
}

/** The pinned Node release for os-cpu, checked against the hash in node-runtime.json: `node` and `node-LICENSE` in `out`. */
export async function addNode(out, target) {
  const { version, sha256 } = JSON.parse(fs.readFileSync(path.join(desktop, "node-runtime.json"), "utf8"));
  const platform = `${target.os}-${target.cpu}`;
  const name = `node-v${version}-${platform}`;
  const want = sha256[platform];
  if (!want) throw new Error(`node-runtime.json has no hash for ${platform}`);
  fs.mkdirSync(cache, { recursive: true });
  const tarball = path.join(cache, `${name}.tar.gz`);
  const hash = (f) => createHash("sha256").update(fs.readFileSync(f)).digest("hex");
  if (!fs.existsSync(tarball) || hash(tarball) !== want) {
    const url = `https://nodejs.org/dist/v${version}/${name}.tar.gz`;
    console.log(`downloading ${url}`);
    const res = await fetch(url);
    if (!res.ok) throw new Error(`${url}: HTTP ${res.status}`);
    fs.writeFileSync(tarball, Buffer.from(await res.arrayBuffer()));
    if (hash(tarball) !== want) {
      fs.rmSync(tarball);
      throw new Error(`${name}.tar.gz does not match the sha256 in node-runtime.json`);
    }
  }
  execFileSync("tar", ["-xzf", tarball, "-C", cache, `${name}/bin/node`, `${name}/LICENSE`]);
  fs.copyFileSync(path.join(cache, name, "bin", "node"), path.join(out, "node"));
  fs.chmodSync(path.join(out, "node"), 0o755);
  fs.copyFileSync(path.join(cache, name, "LICENSE"), path.join(out, "node-LICENSE"));
}
