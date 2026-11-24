// Packages the server for Linux (glibc, x64 or arm64) to run headless, for example in a cloud
// workspace the app reaches over SSH: release/swan-server-<version>-linux-<arch>.tar.gz holds the
// same server, Copilot SDK and examples as the app, the pinned Node runtime and bin/swan-server.
// Builds on any OS: the Linux packages are downloaded and checked. --arch x64|arm64 (default: this
// machine's).
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { addNode, buildServer, desktop, repo } from "./server-build.mjs";

const flag = process.argv.indexOf("--arch");
const arch = flag > 0 ? process.argv[flag + 1] : process.arch;
if (arch !== "x64" && arch !== "arm64") throw new Error(`--arch must be x64 or arm64, not ${arch}`);
const target = { os: "linux", cpu: arch };
const { version } = JSON.parse(fs.readFileSync(path.join(desktop, "package.json"), "utf8"));
const name = `swan-server-${version}-linux-${arch}`;
const staging = path.join(desktop, "build", "server-linux");
const out = path.join(staging, name);
const releaseDir = path.join(desktop, "release");

fs.rmSync(staging, { recursive: true, force: true });
fs.mkdirSync(out, { recursive: true });
await buildServer(out, target);
await addNode(out, target);

fs.mkdirSync(path.join(out, "bin"));
fs.writeFileSync(
  path.join(out, "bin", "swan-server"),
  `#!/bin/sh
# Runs Swan's server ${version} with its own Node. Data lives in PH_HOME (default ~/.swan); the API
# listens on 127.0.0.1 only. Stop it with Ctrl-C or SIGTERM.
set -eu
root=$(dirname "$(dirname "$(readlink -f "$0")")")
PH_RESOURCES="$root" SWAN_VERSION="\${SWAN_VERSION:-${version}}" exec "$root/node" "$root/server/index.mjs" "$@"
`,
  { mode: 0o755 },
);

fs.mkdirSync(releaseDir, { recursive: true });
const tarball = path.join(releaseDir, `${name}.tar.gz`);
// Owned by root (uid 0), so the archive does not carry this machine's user names.
const gnu = execFileSync("tar", ["--version"], { encoding: "utf8" }).includes("GNU");
// macOS's bsdtar would also add extended attributes that GNU tar warns about on every file.
const owner = gnu ? ["--owner=0", "--group=0", "--numeric-owner"] : ["--uid", "0", "--gid", "0", "--no-xattrs", "--no-mac-metadata"];
execFileSync("tar", ["-czf", tarball, ...owner, "-C", staging, name], { env: { ...process.env, COPYFILE_DISABLE: "1" } });
console.log(`built ${path.relative(repo, tarball)}`);
