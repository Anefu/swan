import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { PODMAN_DIRS, loginShellEnv, parseEnvOutput, serverEnv, withPodmanDirs } from "./shell-env.js";

const MARK = "__SWAN_ENV_7f3a__";

describe("parseEnvOutput", () => {
  it("reads NUL-separated variables between the markers, ignoring what rc files print around them", () => {
    const out = `Welcome!\n${MARK}PATH=/opt/homebrew/bin:/usr/bin\0EQ=a=b\0EMPTY=\0${MARK}bye\n`;
    expect(parseEnvOutput(out)).toEqual({ PATH: "/opt/homebrew/bin:/usr/bin", EQ: "a=b", EMPTY: "" });
  });

  it("returns null without both markers or without variables", () => {
    expect(parseEnvOutput("PATH=/usr/bin")).toBeNull();
    expect(parseEnvOutput(`${MARK}PATH=/usr/bin`)).toBeNull();
    expect(parseEnvOutput(`${MARK}${MARK}`)).toBeNull();
  });
});

describe("withPodmanDirs", () => {
  it("appends Podman's install locations that are missing, keeping the user's order", () => {
    expect(withPodmanDirs("/usr/local/bin:/usr/bin")).toBe(["/usr/local/bin", "/usr/bin", "/opt/homebrew/bin", "/opt/podman/bin"].join(":"));
    expect(withPodmanDirs(undefined)).toBe(PODMAN_DIRS.join(":"));
  });
});

describe("serverEnv", () => {
  it("keeps the user's environment but not Electron, Node or home overrides", () => {
    const env = serverEnv(
      { HOME: "/Users/a", PATH: "/usr/bin", AWS_PROFILE: "dev", ELECTRON_RUN_AS_NODE: "1", NODE_OPTIONS: "--require x", PH_HOME: "/tmp/x", SWAN_RESOLVING_ENVIRONMENT: "1" },
      { PH_RESOURCES: "/r" },
    );
    expect(env).toMatchObject({ HOME: "/Users/a", AWS_PROFILE: "dev", PH_RESOURCES: "/r" });
    expect(env.PATH.startsWith("/usr/bin:")).toBe(true);
    for (const k of ["ELECTRON_RUN_AS_NODE", "NODE_OPTIONS", "PH_HOME", "SWAN_RESOLVING_ENVIRONMENT"]) expect(env).not.toHaveProperty(k);
  });

  it("lets the launcher set the home explicitly", () => {
    expect(serverEnv({ PH_HOME: "/shell/home" }, { PH_HOME: "/launch/home" }).PH_HOME).toBe("/launch/home");
  });
});

describe("loginShellEnv", () => {
  it("reads the environment a login shell prints", async () => {
    const env = await loginShellEnv("/bin/sh");
    expect(env?.HOME).toBe(os.homedir());
  });

  it("gives up on a shell that hangs", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "swan-shell-"));
    const shell = path.join(dir, "slow-shell");
    await fs.writeFile(shell, "#!/bin/sh\nsleep 30\n", { mode: 0o755 });
    const started = Date.now();
    expect(await loginShellEnv(shell, 300)).toBeNull();
    expect(Date.now() - started).toBeLessThan(5000);
    await fs.rm(dir, { recursive: true, force: true });
  });

  it("returns null when the shell does not exist", async () => {
    expect(await loginShellEnv("/nonexistent/shell")).toBeNull();
  });
});
