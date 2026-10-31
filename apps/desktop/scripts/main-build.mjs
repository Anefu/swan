import path from "node:path";
import { fileURLToPath } from "node:url";
import * as esbuild from "esbuild";

const desktop = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

/** The main process as one CommonJS file (what Electron loads without extra setup). */
export function buildMain() {
  return esbuild.build({
    entryPoints: [path.join(desktop, "main", "main.ts")],
    outfile: path.join(desktop, "dist", "main.cjs"),
    bundle: true,
    platform: "node",
    format: "cjs",
    target: "node22",
    external: ["electron"],
    logLevel: "warning",
  });
}
