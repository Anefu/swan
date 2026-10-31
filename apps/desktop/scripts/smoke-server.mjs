// Starts the bundled server the way the app does (plain Node, IPC channel, PH_RESOURCES) against
// a throwaway home, and checks the launcher protocol, the home lock and the API guards. Needs
// `pnpm build` first; no Podman (the runtime points at a binary that does not exist).
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const resources = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "build", "resources");
const home = fs.mkdtempSync(path.join(os.tmpdir(), "swan-smoke-"));
fs.writeFileSync(
  path.join(home, "config.yaml"),
  [
    "port: 0",
    "proxyPort: 0",
    "runtime:",
    "  binary: /nonexistent/podman",
    "  network: swan-smoke",
    "  relayName: swan-smoke-relay",
    "connections: # as in the default config, which the example personas use",
    "  github: { type: static, credentials: { GITHUB_TOKEN: { hosts: [api.github.com] } } }",
    "",
  ].join("\n"),
);

/** The server and its first IPC message. */
function start() {
  const child = spawn(process.execPath, [path.join(resources, "server", "index.mjs")], {
    env: { PATH: process.env.PATH, HOME: home, PH_HOME: home, PH_RESOURCES: resources, SWAN_VERSION: "smoke" },
    stdio: ["ignore", "pipe", "pipe", "ipc"],
  });
  let out = "";
  child.stdout.on("data", (c) => (out += c));
  child.stderr.on("data", (c) => (out += c));
  const exited = new Promise((resolve) => child.on("exit", (code) => resolve(code)));
  const first = new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`no message within 30 s:\n${out}`)), 30_000);
    child.once("message", (m) => {
      clearTimeout(timer);
      resolve(m);
    });
    child.once("exit", (code) => reject(new Error(`exited (${code}) before a message:\n${out}`)));
  });
  return { child, first, exited };
}

/** A request with full control of Host and Origin (fetch does not allow setting Host). */
function call(method, port, urlPath, headers = {}, json) {
  return new Promise((resolve, reject) => {
    const body = json === undefined ? undefined : JSON.stringify(json);
    const req = http.request(
      { host: "127.0.0.1", port, path: urlPath, method, headers: { host: `127.0.0.1:${port}`, ...(body ? { "content-type": "application/json" } : {}), ...headers } },
      (res) => {
        let data = "";
        res.on("data", (c) => (data += c));
        res.on("end", () => resolve({ status: res.statusCode, body: data }));
      },
    );
    req.on("error", reject);
    req.end(body);
  });
}
const get = (port, urlPath, headers) => call("GET", port, urlPath, headers);

const a = start();
const ready = await a.first;
assert.equal(ready.type, "ready");
assert.equal(ready.home, home);
const port = ready.port;
const token = fs.readFileSync(path.join(home, "api-token"), "utf8").trim();
const auth = { "x-ph-token": token };

const lock = JSON.parse(fs.readFileSync(path.join(home, "server.json"), "utf8"));
assert.deepEqual([lock.pid, lock.port, lock.version], [a.child.pid, port, "smoke"]);

const root = await get(port, "/");
assert.equal(root.status, 200);
assert.doesNotMatch(root.body, /<html|ph-token|__PH_TOKEN__/i, "the server no longer serves the UI");

assert.equal((await get(port, "/api/runtime")).status, 401, "no token");
assert.equal((await get(port, "/api/runtime", { "x-ph-token": "x".repeat(token.length) })).status, 401, "wrong token");
const runtime = await get(port, "/api/runtime", auth);
assert.equal(runtime.status, 200);
assert.equal(JSON.parse(runtime.body).needs, "install");
assert.equal((await get(port, "/api/runtime", { ...auth, host: "evil.example" })).status, 403, "foreign Host");
assert.equal((await get(port, "/api/runtime", { ...auth, origin: "https://evil.example" })).status, 403, "foreign Origin");
assert.equal((await get(port, "/api/runtime", { ...auth, origin: "swan://app" })).status, 200, "the app's origin");

// A fresh home's example personas can start: no folder that only exists in a checkout.
const personas = JSON.parse((await get(port, "/api/personas", auth)).body);
assert.deepEqual(personas.map((p) => p.id).sort(), ["demo", "github-helper"]);
for (const p of personas) assert.deepEqual(p.errors, [], `${p.id} has problems`);

// Deleting a persona takes its conversation and memory with it.
const session = JSON.parse((await call("POST", port, "/api/sessions", auth, { personaId: "demo" })).body);
assert.equal((await call("POST", port, "/api/personas/demo/memory", auth, { content: "Use pnpm.", type: "preference" })).status, 200);
assert.ok(fs.existsSync(path.join(home, "memory", "demo.json")));
assert.equal((await call("DELETE", port, "/api/personas/demo", auth)).status, 200);
assert.deepEqual(JSON.parse((await get(port, "/api/personas", auth)).body).map((p) => p.id), ["github-helper"]);
assert.equal((await get(port, `/api/sessions/${session.id}`, auth)).status, 404);
assert.ok(!fs.existsSync(path.join(home, "memory", "demo.json")), "memory removed");
assert.ok(!fs.existsSync(path.join(home, "personas", "demo.yaml")), "persona file removed");

// A second server for the same home says who holds it, and exits.
const b = start();
assert.deepEqual(await b.first, { type: "home-in-use", home, url: `http://127.0.0.1:${port}/`, pid: a.child.pid });
assert.equal(await b.exited, 3);

// SIGTERM: clean exit, lock removed.
a.child.kill("SIGTERM");
assert.equal(await a.exited, 0);
assert.ok(!fs.existsSync(path.join(home, "server.json")), "server.json removed on exit");

// The launcher going away stops the server too.
const c = start();
assert.equal((await c.first).type, "ready");
c.child.disconnect();
assert.equal(await c.exited, 0);

fs.rmSync(home, { recursive: true, force: true });
console.log("server smoke test passed");
