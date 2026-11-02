// Builds what the desktop app runs into build/resources (the app's Resources folder once packaged):
// the UI, the server as one bundle, the Copilot SDK it loads from disk, the Containerfile and
// examples. Also compiles the main process to dist/. With --node, adds the pinned Node runtime.
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import * as esbuild from "esbuild";
import { build } from "vite";
import { buildMain } from "./main-build.mjs";

const desktop = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const repo = path.resolve(desktop, "../..");
const out = path.join(desktop, "build", "resources");
const arch = process.env.SWAN_ARCH ?? process.arch;

fs.rmSync(out, { recursive: true, force: true });
fs.mkdirSync(out, { recursive: true });

await buildMain();

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
copyPackage("@github/copilot-sdk", path.join(repo, "apps", "server"), path.join(out, "server", "node_modules"));

await build({ root: path.join(desktop, "ui"), logLevel: "warn", build: { outDir: path.join(out, "ui"), emptyOutDir: true } });
fs.mkdirSync(path.join(out, "sandbox"));
for (const f of ["Containerfile", "Containerfile.base"]) fs.copyFileSync(path.join(repo, "sandbox", f), path.join(out, "sandbox", f));
fs.cpSync(path.join(repo, "examples"), path.join(out, "examples"), { recursive: true });
for (const f of ["LICENSE", "NOTICE"]) fs.copyFileSync(path.join(repo, f), path.join(out, f)); // Apache 2.0: ship both

if (process.argv.includes("--node")) await addNode();
if (!process.env.ELECTRON_SKIP_BINARY_DOWNLOAD) ensureElectron();
console.log(`built ${path.relative(repo, out)} (${arch})`);

/** Where Node would resolve `name` from `fromDir`. */
function packageDir(name, fromDir) {
  for (let dir = fromDir; ; dir = path.dirname(dir)) {
    const candidate = path.join(dir, "node_modules", name);
    if (fs.existsSync(path.join(candidate, "package.json"))) return fs.realpathSync(candidate);
    if (path.dirname(dir) === dir) return null;
  }
}

/** Copy a package and its installed dependencies as real files (pnpm keeps them as links). */
function copyPackage(name, fromDir, dest, seen = new Set()) {
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
  for (const dep of Object.keys(pkg.dependencies ?? {})) copyPackage(dep, dir, dest, seen);
  // Only the platform packages installed for this machine exist; the rest are skipped.
  for (const dep of Object.keys(pkg.optionalDependencies ?? {})) if (packageDir(dep, dir)) copyPackage(dep, dir, dest, seen);
}

/** The pinned Node release for macOS, checked against the hash in node-runtime.json. */
async function addNode() {
  const { version, sha256 } = JSON.parse(fs.readFileSync(path.join(desktop, "node-runtime.json"), "utf8"));
  const name = `node-v${version}-darwin-${arch}`;
  const want = sha256[`darwin-${arch}`];
  if (!want) throw new Error(`node-runtime.json has no hash for darwin-${arch}`);
  const cache = path.join(desktop, ".cache");
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

/** pnpm runs Electron's download only on a fresh install; `electron .` needs the binary. */
function ensureElectron() {
  const pkg = path.dirname(fileURLToPath(import.meta.resolve("electron/package.json")));
  if (!fs.existsSync(path.join(pkg, "path.txt"))) execFileSync(process.execPath, [path.join(pkg, "install.js")], { stdio: "inherit" });
}
