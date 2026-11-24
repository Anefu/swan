// Builds what the desktop app runs into build/resources (the app's Resources folder once packaged):
// the UI, the server as one bundle, the Copilot SDK it loads from disk, the Containerfile and
// examples. Also compiles the main process to dist/. With --node, adds the pinned Node runtime.
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "vite";
import { buildMain } from "./main-build.mjs";
import { addNode, buildServer, desktop, repo } from "./server-build.mjs";

const out = path.join(desktop, "build", "resources");
const arch = process.env.SWAN_ARCH ?? process.arch;

fs.rmSync(out, { recursive: true, force: true });
fs.mkdirSync(out, { recursive: true });

await buildMain();

await buildServer(out, { os: process.platform, cpu: arch });

await build({ root: path.join(desktop, "ui"), logLevel: "warn", build: { outDir: path.join(out, "ui"), emptyOutDir: true } });

if (process.argv.includes("--node")) await addNode(out, { os: "darwin", cpu: arch });
if (!process.env.ELECTRON_SKIP_BINARY_DOWNLOAD) ensureElectron();
console.log(`built ${path.relative(repo, out)} (${arch})`);

/** pnpm runs Electron's download only on a fresh install; `electron .` needs the binary. */
function ensureElectron() {
  const pkg = path.dirname(fileURLToPath(import.meta.resolve("electron/package.json")));
  if (!fs.existsSync(path.join(pkg, "path.txt"))) execFileSync(process.execPath, [path.join(pkg, "install.js")], { stdio: "inherit" });
}
