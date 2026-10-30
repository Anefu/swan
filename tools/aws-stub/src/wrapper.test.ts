import { spawn } from "node:child_process";
import { mkdtempSync, readFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { GetCallerIdentityCommand, STSClient } from "@aws-sdk/client-sts";
import { Ajv } from "ajv";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { startStub, type StubServer } from "./server.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const bin = path.join(here, "../bin/swan-stub-connection");
const schema = JSON.parse(readFileSync(path.join(here, "../../../docs/connection-protocol-v1.schema.json"), "utf8"));
const validate = new Ajv({ strict: false, allErrors: true }).compile(schema);

type Line = Record<string, any>;

let stub: StubServer;
beforeAll(async () => {
  stub = await startStub();
});
afterAll(() => stub.close());

/** Run the wrapper like Swan does: argv, JSON on stdin, JSON Lines out. `onLine` sees each line as it arrives. */
function run(verb: string, cwd: string, role = "ReadOnly", onLine?: (l: Line) => void): Promise<{ lines: Line[]; code: number | null }> {
  return new Promise((resolve, reject) => {
    const child = spawn(bin, [verb, "--stub", stub.url, "--role", role], { cwd, stdio: ["pipe", "pipe", "pipe"] });
    const lines: Line[] = [];
    let buf = "";
    child.stdout.on("data", (d: Buffer) => {
      buf += d.toString("utf8");
      let i: number;
      while ((i = buf.indexOf("\n")) !== -1) {
        const line = JSON.parse(buf.slice(0, i));
        buf = buf.slice(i + 1);
        lines.push(line);
        onLine?.(line);
      }
    });
    child.on("error", reject);
    child.on("close", (code) => resolve({ lines, code }));
    child.stdin.end(JSON.stringify({ protocol: 1, connection: "stub" }));
  });
}

function expectValid(lines: Line[]) {
  for (const l of lines) {
    const ok = validate(l);
    expect(ok, JSON.stringify(validate.errors)).toBe(true);
  }
  expect(lines.filter((l) => l.type === "result")).toHaveLength(1);
  expect(lines.at(-1)?.type).toBe("result");
}

describe("reference connection wrapper", () => {
  it("signs in with a device code and returns working credentials", async () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), "swan-conn-"));
    expect((await run("status", dir)).lines).toEqual([expect.objectContaining({ type: "result", state: "login_required" })]);

    const login = await run("login", dir, "ReadOnly", (l) => {
      if (l.type === "device_code") void fetch(`${stub.url}/_stub/sso/approve`, { method: "POST", body: JSON.stringify({ user_code: l.userCode }) });
    });
    expect(login.code).toBe(0);
    expectValid(login.lines);
    expect(login.lines[0]).toMatchObject({ type: "device_code", verificationUri: `${stub.url}/sso/device` });
    const result = login.lines.at(-1)!;
    expect(result.state).toBe("ready");

    const aws = result.credentials.find((c: Line) => c.kind === "aws-sigv4");
    const me = await new STSClient({ endpoint: stub.url, region: "us-east-1", credentials: aws }).send(new GetCallerIdentityCommand({}));
    expect(me.Arn).toMatch(/assumed-role\/ReadOnly\/swan-sso$/);

    const eks = result.credentials.find((c: Line) => c.kind === "bearer");
    const pods = await fetch(`${stub.url}/k8s/swan-dev/api/v1/pods`, { headers: { authorization: `Bearer ${eks.value}` } });
    expect(pods.status).toBe(200);

    // Files carry references, never values.
    const files = JSON.stringify(result.files);
    expect(files).toContain("{{credential:eks}}");
    expect(files).not.toContain(aws.secretAccessKey);
    expect(files).not.toContain(eks.value);

    const status = await run("status", dir);
    expectValid(status.lines);
    expect(status.lines[0].state).toBe("ready");

    const renewed = await run("renew", dir);
    expectValid(renewed.lines);
    expect(renewed.lines[0].credentials[0].accessKeyId).not.toBe(aws.accessKeyId);
  });

  it("asks for a new sign-in once the refresh token has expired", async () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), "swan-conn-"));
    stub.state.options.refreshTokenSeconds = 1;
    stub.state.options.autoApprove = true;
    try {
      expect((await run("login", dir)).lines.at(-1)?.state).toBe("ready");
      await new Promise((r) => setTimeout(r, 1500));
      const renewed = await run("renew", dir);
      expectValid(renewed.lines);
      expect(renewed.lines[0]).toMatchObject({ state: "login_required" });
    } finally {
      stub.state.options.refreshTokenSeconds = 8 * 3600;
      stub.state.options.autoApprove = false;
    }
  });

  it("reports errors as a result line and a non-zero exit", async () => {
    const r = await run("bogus", mkdtempSync(path.join(os.tmpdir(), "swan-conn-")));
    expect(r.code).toBe(1);
    expectValid(r.lines);
    expect(r.lines[0]).toMatchObject({ state: "error" });
  });
});
