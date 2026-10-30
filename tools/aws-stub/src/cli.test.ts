// End to end with the real AWS CLI and kubectl, when they are installed (they are on GitHub's
// Ubuntu runners). Skipped otherwise.
import { execFile, execFileSync } from "node:child_process";
import { mkdtempSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { startStub, type StubServer } from "./server.js";
import { STUB_USER } from "./state.js";
import { makeTls } from "./tls.js";

const has = (bin: string, versionArgs = bin === "kubectl" ? ["version", "--client"] : ["--version"]) => {
  try {
    execFileSync(bin, versionArgs, { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
};
const run = promisify(execFile);

describe.skipIf(!has("aws") || !has("openssl", ["version"]))("AWS CLI and kubectl against the stub", () => {
  let stub: StubServer;
  let env: NodeJS.ProcessEnv;
  beforeAll(async () => {
    // HTTPS like real AWS: kubectl only sends exec-plugin tokens over TLS.
    const tls = makeTls();
    stub = await startStub({ tls });
    const home = mkdtempSync(path.join(os.tmpdir(), "swan-cli-"));
    env = {
      PATH: process.env.PATH,
      HOME: home,
      AWS_ACCESS_KEY_ID: STUB_USER.accessKeyId,
      AWS_SECRET_ACCESS_KEY: STUB_USER.secretAccessKey,
      AWS_REGION: "us-east-1",
      AWS_ENDPOINT_URL: stub.url,
      AWS_CA_BUNDLE: tls.caFile,
      AWS_PAGER: "",
      KUBECONFIG: path.join(home, "kubeconfig"),
    };
  });
  afterAll(() => stub?.close());

  const aws = async (...args: string[]) => (await run("aws", [...args, "--output", "json"], { env })).stdout;

  it("signs requests the stub accepts", async () => {
    expect(JSON.parse(await aws("sts", "get-caller-identity")).Arn).toBe(STUB_USER.arn);
    expect((await run("aws", ["s3", "ls", "s3://swan-demo"], { env })).stdout).toContain("README.txt");
    const events = JSON.parse(await aws("logs", "filter-log-events", "--log-group-name", "/swan/payments", "--filter-pattern", "declined"));
    expect(events.events).toHaveLength(1);
  });

  it.skipIf(!has("kubectl"))("lets kubectl use an EKS token from aws eks get-token", async () => {
    await aws("eks", "update-kubeconfig", "--name", "swan-dev");
    const { stdout } = await run("kubectl", ["get", "pods", "-n", "payments"], { env });
    expect(stdout).toMatch(/payments-api-7f9c6d-x2k4p\s+1\/1\s+Running/);
    // The IAM user is not ReadOnly, so writes work; ReadOnly is covered in stub.test.ts.
    expect((await run("kubectl", ["delete", "pod", "scratch-shell", "-n", "dev-alice"], { env })).stdout).toContain('pod "scratch-shell" deleted');
  });
});
