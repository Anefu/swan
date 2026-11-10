import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { appCsp, resolveUiFile, uiContentType } from "./app-protocol.js";

let root: string;
let outside: string;
beforeAll(async () => {
  const base = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "swan-ui-")));
  root = path.join(base, "ui");
  outside = path.join(base, "secret.txt");
  await fs.mkdir(path.join(root, "assets"), { recursive: true });
  await fs.writeFile(path.join(root, "index.html"), "<!doctype html>");
  await fs.writeFile(path.join(root, "assets", "app.js"), "1");
  await fs.writeFile(outside, "not for the UI");
});
afterAll(async () => {
  await fs.rm(path.dirname(root), { recursive: true, force: true });
});

describe("resolveUiFile", () => {
  it("serves files of the UI build", async () => {
    expect(await resolveUiFile(root, "/assets/app.js")).toBe(path.join(root, "assets", "app.js"));
  });

  it("leaves the page itself and app routes to the single-page app", async () => {
    for (const p of ["/", "/index.html", "/personas/demo", "/assets/missing.js"]) expect(await resolveUiFile(root, p)).toBeNull();
  });

  it("never reaches outside the build", async () => {
    for (const p of ["/../secret.txt", "/assets/../../secret.txt", "/%2e%2e/secret.txt", "/..%2fsecret.txt", "/assets/app.js%00.png", "/%E0%A4%A"])
      expect(await resolveUiFile(root, p)).toBeNull();
  });
});

describe("uiContentType", () => {
  it("names the types the build contains and falls back to a download type", () => {
    expect(uiContentType("a.js")).toBe("text/javascript; charset=utf-8");
    expect(uiContentType("a.WOFF2")).toBe("font/woff2");
    expect(uiContentType("a.exe")).toBe("application/octet-stream");
  });
});

describe("appCsp", () => {
  it("allows only the app's own scripts and the server's WebSocket", () => {
    const csp = appCsp("4317");
    expect(csp).toContain("script-src 'self'");
    expect(csp).toContain("connect-src 'self' ws://127.0.0.1:4317");
    expect(csp).toContain("object-src 'none'");
    expect(csp).not.toContain("unsafe-eval");
  });

  it("loads no image from the web, so a reply can't send data out through one", () => {
    const img = appCsp("4317").split("; ").find((d) => d.startsWith("img-src"));
    expect(img).toBe("img-src 'self' data: blob:");
  });
});
