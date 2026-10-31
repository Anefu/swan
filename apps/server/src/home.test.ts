import { promises as fs } from "node:fs";
import http from "node:http";
import type { AddressInfo } from "node:net";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { HomeInUseError, HomeLock, choosePort, moveLegacyHome, swanAnswers } from "./home.js";

let dir: string;
const servers: http.Server[] = [];

beforeEach(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), "ph-home-"));
});
afterEach(async () => {
  await Promise.all(servers.splice(0).map((s) => new Promise((r) => s.close(r))));
  await fs.rm(dir, { recursive: true, force: true });
});

/** A stand-in Swan: 200 for its own token, 401 otherwise. */
async function fakeSwan(token: string): Promise<number> {
  const s = http.createServer((req, res) => res.writeHead(req.headers["x-ph-token"] === token ? 200 : 401).end("{}"));
  servers.push(s);
  await new Promise<void>((r) => s.listen(0, "127.0.0.1", r));
  return (s.address() as AddressInfo).port;
}

const TOKEN = "t".repeat(48);

describe("swanAnswers", () => {
  it("is true only for a server holding this token", async () => {
    const port = await fakeSwan(TOKEN);
    expect(await swanAnswers(port, TOKEN)).toBe(true);
    expect(await swanAnswers(port, "x".repeat(48))).toBe(false);
    expect(await swanAnswers(0, TOKEN)).toBe(false);
  });
});

describe("moveLegacyHome", () => {
  it("moves the old home and leaves a link to the new one", async () => {
    const from = path.join(dir, ".persona-harness");
    const to = path.join(dir, ".swan");
    await fs.mkdir(path.join(from, "personas"), { recursive: true });
    await fs.writeFile(path.join(from, "personas", "a.yaml"), "name: A\n");
    expect(await moveLegacyHome(from, to)).toBe(true);
    expect(await fs.readFile(path.join(to, "personas", "a.yaml"), "utf8")).toBe("name: A\n");
    expect((await fs.lstat(from)).isSymbolicLink()).toBe(true);
    expect(await fs.realpath(from)).toBe(await fs.realpath(to));
    expect(await moveLegacyHome(from, to)).toBe(false); // once only
  });

  it("does nothing when the new home exists or there is no old one", async () => {
    const from = path.join(dir, "old");
    const to = path.join(dir, "new");
    expect(await moveLegacyHome(from, to)).toBe(false);
    await fs.mkdir(from);
    await fs.mkdir(to);
    expect(await moveLegacyHome(from, to)).toBe(false);
    expect((await fs.lstat(from)).isDirectory()).toBe(true);
  });

  it("refuses while a Swan is running on the old home", async () => {
    const from = path.join(dir, "old");
    const to = path.join(dir, "new");
    await fs.mkdir(from);
    const port = await fakeSwan(TOKEN);
    await fs.writeFile(path.join(from, "config.yaml"), `port: ${port}\n`);
    await fs.writeFile(path.join(from, "api-token"), TOKEN);
    await expect(moveLegacyHome(from, to)).rejects.toThrow(/older Swan is running/);
    expect((await fs.lstat(from)).isDirectory()).toBe(true);
    await expect(fs.lstat(to)).rejects.toThrow();
  });
});

describe("HomeLock", () => {
  const claim = (configPort = 0, token = TOKEN) =>
    HomeLock.claim({ home: dir, file: path.join(dir, "server.json"), token, configPort, version: "test" });
  const writeRecord = (rec: object) =>
    fs.writeFile(path.join(dir, "server.json"), JSON.stringify({ port: null, proxyPort: null, version: "old", startedAt: new Date().toISOString(), ...rec }));
  const record = async () => JSON.parse(await fs.readFile(path.join(dir, "server.json"), "utf8"));

  it("records this server and removes the record on release", async () => {
    const lock = await claim();
    expect(await record()).toMatchObject({ pid: process.pid, port: null, version: "test" });
    await lock.update({ port: 1234, proxyPort: 1235 });
    expect(await record()).toMatchObject({ pid: process.pid, port: 1234, proxyPort: 1235 });
    expect((await fs.stat(path.join(dir, "server.json"))).mode & 0o777).toBe(0o600);
    lock.releaseSync();
    await expect(fs.stat(path.join(dir, "server.json"))).rejects.toThrow();
  });

  it("refuses when the recorded server answers with this home's token", async () => {
    const port = await fakeSwan(TOKEN);
    await writeRecord({ pid: process.ppid, port });
    const err = await claim().catch((e) => e);
    expect(err).toBeInstanceOf(HomeInUseError);
    expect(err).toMatchObject({ url: `http://127.0.0.1:${port}/`, pid: process.ppid });
  });

  it("refuses while the recorded server is still starting", async () => {
    await writeRecord({ pid: process.ppid });
    await expect(claim()).rejects.toBeInstanceOf(HomeInUseError);
  });

  it("takes over a record whose server is gone", async () => {
    await writeRecord({ pid: 2 ** 22 + 12345 }); // above macOS and Linux pid limits
    await claim();
    expect((await record()).pid).toBe(process.pid);
  });

  it("takes over a record whose pid was reused by something that is not this Swan", async () => {
    const other = await fakeSwan("someone else's token".padEnd(48, "-"));
    await writeRecord({ pid: process.ppid, port: other });
    await claim();
    expect((await record()).pid).toBe(process.pid);
  });

  it("takes over a record left starting long ago", async () => {
    await writeRecord({ pid: process.ppid, startedAt: new Date(Date.now() - 10 * 60_000).toISOString() });
    await claim();
    expect((await record()).pid).toBe(process.pid);
  });

  it("refuses when an older server without a record answers on the configured port", async () => {
    const port = await fakeSwan(TOKEN);
    await expect(claim(port)).rejects.toBeInstanceOf(HomeInUseError);
    await expect(fs.stat(path.join(dir, "server.json"))).rejects.toThrow();
  });

  it("leaves a record another server has since claimed", async () => {
    const lock = await claim();
    await writeRecord({ pid: process.ppid });
    lock.releaseSync();
    expect((await record()).pid).toBe(process.ppid);
  });
});

describe("choosePort", () => {
  it("keeps a free port, and falls back to any port only when allowed", async () => {
    const busy = await fakeSwan(TOKEN);
    expect(await choosePort(busy, false)).toBe(busy);
    expect(await choosePort(busy, true)).toBe(0);
    const s = http.createServer();
    await new Promise<void>((r) => s.listen(0, "127.0.0.1", r));
    const free = (s.address() as AddressInfo).port;
    await new Promise((r) => s.close(r));
    expect(await choosePort(free, true)).toBe(free);
  });
});
