// Development: the UI from Vite with hot reload, inside Electron. `pnpm dev` at the repository
// root runs this next to the server (tsx watch); Vite passes /api to it. The Vite page is for the
// app window only.
import { spawn } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import electron from "electron";
import { createServer } from "vite";
import { buildMain } from "./main-build.mjs";

const desktop = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

await buildMain();
// 127.0.0.1, not "localhost": Vite checks the port on the host it binds, and localhost may be IPv6
// while another program holds the same port on IPv4.
const vite = await createServer({ root: path.join(desktop, "ui"), server: { host: "127.0.0.1" } });
await vite.listen();
const url = vite.resolvedUrls?.local[0];
if (!url) throw new Error("Vite did not report a local URL");
console.log(`UI on ${url} (for the app window)`);

const app = spawn(electron, [desktop], { stdio: "inherit", env: { ...process.env, SWAN_DEV_URL: url } });
app.on("exit", async (code) => {
  await vite.close();
  process.exit(code ?? 0);
});
for (const sig of ["SIGINT", "SIGTERM"]) process.on(sig, () => app.kill(sig));
