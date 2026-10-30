import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import react from "@vitejs/plugin-react";
import { defineConfig, type Plugin } from "vite";

const TOKEN_PLACEHOLDER = "__PH_TOKEN__";
const API_TARGET = process.env.PH_SERVER_URL?.trim() || "http://127.0.0.1:4317";

function phHome(): string {
  const env = process.env.PH_HOME?.trim();
  if (!env) return join(homedir(), ".persona-harness");
  if (env === "~" || env.startsWith("~/")) return join(homedir(), env.slice(1));
  return env;
}

function escapeAttr(value: string): string {
  return value.replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

/**
 * Dev only: inject the API token the server wrote to $PH_HOME/api-token.
 * The file is read on every page load, so starting the server and reloading
 * the page is enough. If the file is missing, the placeholder stays and the UI
 * shows a "token missing" state. Production builds keep the placeholder; the
 * server substitutes it when serving dist/index.html.
 */
function devToken(): Plugin {
  return {
    name: "ph-dev-token",
    apply: "serve",
    transformIndexHtml(html) {
      let token = "";
      try {
        token = readFileSync(join(phHome(), "api-token"), "utf8").trim();
      } catch {
        // Server has not created the token yet.
      }
      return token ? html.replaceAll(TOKEN_PLACEHOLDER, escapeAttr(token)) : html;
    },
  };
}

export default defineConfig({
  plugins: [react(), devToken()],
  server: {
    // Falls back to the next free port if 5173 is taken by another project.
    port: 5173,
    proxy: {
      "/api": { target: API_TARGET, ws: true },
    },
  },
  build: {
    outDir: "dist",
    emptyOutDir: true,
  },
});
