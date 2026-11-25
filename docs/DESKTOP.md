# Swan for macOS

Swan is a macOS app. The app starts Swan's server, shows its UI in its own window, and stops the
server when you quit. There is no browser mode: the server answers the API only.

## Install

```bash
curl -fsSL https://raw.githubusercontent.com/Anefu/swan/main/install.sh | bash
```

[install.sh](../install.sh) finds the newest release (pre-releases included) from the releases
feed, downloads its DMG, checks it against `SHA256SUMS.txt` and copies Swan into `/Applications`,
or `~/Applications` when `/Applications` isn't writable. It updates Swan where it already is,
refuses while Swan is running, and replaces the app only once the new copy is complete. A version
after `bash -s --` installs that one; `SWAN_APP_DIR` installs somewhere else (tests use it). Files
`curl` downloads aren't quarantined, so macOS opens the unsigned app without blocking it. It uses
`https_proxy` if you need a proxy.

Or download `Swan-<version>-arm64.dmg` from the repository's Releases and drag Swan to
Applications. Builds are not signed yet, so macOS blocks a downloaded app the first time: choose
System Settings → Privacy & Security → Open Anyway (or run
`xattr -dr com.apple.quarantine /Applications/Swan.app`).

Swan needs Podman: `brew install podman`, or Podman Desktop. If Podman has no machine yet, Swan
offers to create one (a one-time download of about 1 GB); a stopped machine is started for you.

When a persona uses folders in Documents, Desktop or Downloads, macOS asks once whether Swan may
access them. An unsigned build is a new app to macOS each time, so it asks again after an update.

## The server on Linux

Swan's server also runs on its own on a Linux machine (x86_64 or arm64, glibc), such as a cloud
workspace you reach over SSH; the app on your Mac shows its UI. Install or update it there, without
root:

```bash
curl -fsSL https://raw.githubusercontent.com/Anefu/swan/main/install-server.sh | bash
```

[install-server.sh](../install-server.sh) downloads the release's
`swan-server-<version>-linux-<arch>.tar.gz`, checks it against `SHA256SUMS.txt`, unpacks it into
`~/.local/share/swan-server/<version>`, points `current` at it and links
`~/.local/bin/swan-server`. It keeps the previous version and removes older ones. A version after
`bash -s --` installs that one; `SWAN_SERVER_DIR` and `SWAN_BIN_DIR` install somewhere else.

```bash
swan-server                              # in the foreground; Ctrl-C stops it
tmux new-session -d -s swan swan-server  # or in the background
```

The package holds the same server, Copilot SDK, examples and Containerfile as the app, with its own
Node (the version in `apps/desktop/node-runtime.json`); nothing else needs installing. Data lives
in `~/.swan` (`PH_HOME` for another folder) and the API listens on 127.0.0.1 only, on the port in
`config.yaml` (4317 by default). The app connects over SSH: it reads `~/.swan/api-token` and
reaches the port through a tunnel, so nothing is exposed on the network. A running server keeps
its version after an update until you restart it. Agents' tools run with the runtime in
`config.yaml`, as on the Mac; Podman's sandbox network on Linux is not checked yet (Not yet, below).

Build the package from a checkout (on any OS; the Linux Node and native packages are downloaded
and checked against `node-runtime.json` and `pnpm-lock.yaml`):

```bash
pnpm package-server --arch x64   # or arm64: apps/desktop/release/swan-server-<version>-linux-<arch>.tar.gz
```

## Behind a proxy or internal mirrors

On a network that reaches the internet only through a proxy and internal mirrors (an Artifactory,
for example), tell Swan in `~/.swan/config.yaml` and restart it:

```yaml
proxy: { url: http://proxy.example.com:8080, noProxy: [.example.com] }
caFiles: [~/certs/company-root.pem]        # only if the proxy or a mirror uses your company's own CA
mirrors:
  baseImage: artifactory.example.com/docker-remote/library/node:22-bookworm-slim
```

- `proxy`: model calls, http MCP servers, the Copilot runtime, connection wrappers, the image build
  (Debian packages, PyPI) and agents' traffic go through it; `noProxy` hosts (and always localhost)
  are reached directly. A proxy on this Mac's loopback (`127.0.0.1`) also works for the build. A
  proxy that needs a username and password is not supported.
  The Podman machine pulls the base image itself: Swan gives it the proxy when it sets the machine
  up or starts it. A machine that was already running keeps its old settings; stop it once
  (`podman machine stop`) and let Swan start it again.
- `caFiles`: extra root certificates (PEM), for a proxy that inspects HTTPS or mirrors with an
  internal certificate. Swan trusts them, and so does everything inside the sandbox.
- `mirrors`: the sandbox image is built from `baseImage`. If the registry needs a login, run
  `podman login` for it first. Where there are mirrors for those too, `apt` maps a Debian source URL
  to its mirror (`http://deb.debian.org/debian: https://…/debian-remote`), and `pypi` and `npm` set
  the index and registry for pip, uv and npm, in the build and inside the sandbox. Changing any of
  these builds a new image on the next start.
  Images based on Debian fetch from two sources, and each needs its mirror once only mirrors are
  reachable: `http://deb.debian.org/debian` and `http://deb.debian.org/debian-security`. If the
  build can't reach one, its error names the source and the line to add. A persona's own image
  uses the same `apt`, `pypi` and `npm` mirrors.

A complete `config.yaml`, `secrets.yaml` and persona for this setup: [examples/reference/](../examples/reference/).

Agents' traffic: Swan's egress proxy applies a persona's hosts and credential rules as usual,
resolves the name on this Mac and checks the address, then asks the company proxy to connect by
name. A name that only the company proxy can resolve is refused, since Swan checks every address
before connecting, unless you set `remoteDns: true` (`proxy: { url: …, remoteDns: true }`), for
machines whose only way out is the proxy. Then a name that doesn't resolve here goes to the proxy by
name and the proxy resolves it. The trade-off: Swan can't check those addresses, so the proxy decides
where they go, and the audit log marks those requests `dns: proxy`. Names that do resolve here are
still checked, `noProxy` hosts still need DNS here, and local names (`localhost`, `.local`,
`.internal`) are still refused.

Internal hosts: agents reach a private address (`10.x`, `172.16–31.x`, `192.168.x`, `fc00::/7`)
only for hosts the persona lists in Settings → Allowed hosts → On your company network
(`network.internal` in its YAML), such as an internal Jira or a mirror. An "Allow" card never adds
one. This Mac, link-local and cloud metadata addresses, `100.64.0.0/10` (Tailscale and similar) and
Swan's and Podman's own networks stay unreachable even for listed hosts. Credentials work on
internal hosts as on any other host.

## Tools in the sandbox

The sandbox has git, curl, jq, Python, Node, ripgrep and a few more. Add your own under
`sandbox.tools` in a persona's YAML. Swan builds them into that persona's image, and restarts its
sandbox between turns (the first build after a change takes a few minutes). `sandboxTools` in
`config.yaml` still works for personas that set no tools of their own, but move it to the persona:

```yaml
sandbox:
  tools:
    packages: [postgresql-client]   # with the image's package manager
    install: |                      # runs as root in /tmp while the image builds
      # kubectl, checked against its published checksum (or pin a version: v=v1.31.2)
      v=$(curl -fsSL https://dl.k8s.io/release/stable.txt)
      arch=$(dpkg --print-architecture)
      curl -fsSLO "https://dl.k8s.io/release/$v/bin/linux/$arch/kubectl"
      curl -fsSLO "https://dl.k8s.io/release/$v/bin/linux/$arch/kubectl.sha256"
      echo "$(cat kubectl.sha256)  kubectl" | sha256sum --check
      install -m 0755 kubectl /usr/local/bin/kubectl && rm kubectl kubectl.sha256
      # AWS CLI v2
      curl -fsSLo awscliv2.zip "https://awscli.amazonaws.com/awscli-exe-linux-$(uname -m).zip"
      unzip -q awscliv2.zip && ./aws/install && rm -rf aws awscliv2.zip
```

- The script runs with `sh -eu`: the build stops at the first failing command and shows its output
  under Swan settings → Sandbox (the full log is `~/.swan/build/sandbox-build.log`).
- It downloads through `proxy`, with `mirrors` and `caFiles` applied, like the rest of the build.
  Behind a company proxy, the download hosts (here `dl.k8s.io`, `awscli.amazonaws.com`) must be
  reachable through it, or use your Artifactory's copies instead.
- Everything in it ends up in the image: no tokens or passwords. Agents use these tools like any
  other program, through the egress proxy with the persona's credentials and rules.

### A persona's own image

A persona can run in an image of your own instead, such as your team's dev-tools image:

```yaml
# ~/.swan/personas/platform.yaml
sandbox:
  image: registry.corp.example.com/platform/dev-tools:2026.10   # pin a tag or a digest
```

Swan pulls it (through `proxy`) and builds a thin layer on top, once per image and again when it
changes: Swan's certificate and `caFiles` (in the system store and a bundle that `SSL_CERT_FILE`,
`AWS_CA_BUNDLE` and similar point to), root certificates if the image has none, a uid 1000 user
with a home (the image's own if it has one), `/workspace`, and then `sandbox.tools` with the image's
package manager (apt, apk or dnf). Nothing else changes. The image needs `bash` and the usual
coreutils; Swan says what is missing if not. Build for `arm64` (Apple silicon), or the sandbox runs
emulated. The sandbox's limits are the same as with Swan's image: they come from how Swan runs the
container, not from the image. The relay always runs Swan's own image.

## Connect to a remote Swan

The app can use a Swan server on another machine, such as a Linux cloud workspace, instead of the
one it starts on this Mac. Agents then work there: submit a task, close the laptop, and reconnect
later to see the result.

1. On the remote machine, start Swan with `swan-server`. It listens on its own `127.0.0.1` only
   (`port:` in its `~/.swan/config.yaml`, 4317 by default).
2. On the Mac, make sure `ssh <host>` works in Terminal without a password prompt (keys or an
   agent). For a Coder workspace, run `coder config-ssh` once; the host is then
   `coder.<workspace>`.
3. Choose Swan › Connect to Remote Swan…, enter the SSH host (and the port and Swan's home there if
   they aren't the defaults), and press Connect.

The app runs the system `ssh` with `BatchMode=yes`: it reads the server's API token from
`<home>/api-token` with one `ssh <host> cat …`, then keeps `ssh -N -L 127.0.0.1:<local port>:127.0.0.1:<port>`
open and loads its UI through it, as with a local server. Nothing listens beyond loopback on either
machine. When the tunnel drops (sleep, a network change) it reconnects with backoff on the same
local port, and right away when the Mac wakes; the window shows "Reconnecting" meanwhile. Quitting
the app closes the tunnel; the remote Swan keeps running.

The choice is kept in the app's own settings (not in `config.yaml`) and applies at the next start
too; Swan › Use This Mac switches back and starts the local server again. Swan settings and the
window title name the host the window is on. Folder paths in a persona's settings are paths on the
remote machine, and Help › Open Data Folder and Show Server Log are off, since both are there.
Connecting from this Mac stops the local server, as quitting does.

If the connection fails the app says why (unknown host, SSH login refused, Swan not running there)
with ssh's own message, and offers to try again, change the server or use this Mac.

## Build and run from a checkout

```bash
pnpm install
pnpm start      # build, then open the app from the checkout
pnpm package    # apps/desktop/release/mac-arm64/Swan.app and Swan-<version>-arm64.dmg
pnpm dev        # server with restart + the UI with hot reload, inside the app window
```

`pnpm start` and `pnpm package` build everything into `apps/desktop/build/resources`; `pnpm package`
also downloads the Node runtime pinned in `apps/desktop/node-runtime.json` and checks its SHA-256.

### Test instances

`PH_HOME` in the app's launch environment selects another data folder. That instance gets its own
browser profile, single-instance lock and server log, so it can run beside your everyday Swan.
Give its `config.yaml` its own ports and Podman names, or it competes with your Swan for them:

```yaml
port: 4517
proxyPort: 4518
runtime: { network: swan-test, subnet: 10.231.0.0/24, relayIp: 10.231.0.2, relayName: swan-test-relay }
```

```bash
PH_HOME=/tmp/swan-test apps/desktop/release/mac-arm64/Swan.app/Contents/MacOS/Swan
```

With `SWAN_SMOKE_TEST=1` the app starts, checks the UI, API and WebSocket, prints `SWAN SMOKE OK`
and quits (CI runs this).

## How it works

- **Server.** The app runs `Contents/Resources/server/index.mjs` (the server as one bundle) on its
  own Node 22, not Electron's. The Copilot SDK starts its runtime with `process.execPath`, which must
  be Node; and with its own Node the app can turn off Electron's `RunAsNode` switch. The server
  gets your login shell's environment (as from a terminal), so Podman, connection wrappers and
  their CLIs are found.
- **Start.** The server uses the ports in `config.yaml` and takes free ones when those are taken.
  Over an IPC channel it reports `ready` (or that another Swan holds the data folder, or why it
  failed). If the app goes away, the server shuts down.
- **UI.** The app serves the UI from its bundle at `swan://app`, puts the API token and the
  WebSocket address into the page, and passes `/api/` requests to the server. The page gets a
  Content Security Policy, cannot navigate away from Swan (links open in your browser), and is
  granted no permissions except clipboard writes. The server accepts the `swan://app` origin.
- **Quit.** Cmd+Q (or SIGTERM) asks the server to stop. It stops session containers, so
  conversations resume later. A server that crashes is restarted up to three times a minute.
- **Hardening.** The app is built with Electron's `RunAsNode`, `NodeOptions` and `NodeCliInspect`
  switches off, so it cannot be used to run other code, and loads only its own `app.asar`.
- **Logs.** `~/Library/Logs/Swan/server.log` (Help → Show Server Log).

## Data

Everything lives in `~/.swan`. The first start moves `~/.persona-harness` there and leaves a link
at the old path; it refuses while a Swan is still running on the old folder. `server.json` records
the running server (pid, ports, version): one server per data folder. A second server for the same
folder, from the app or a checkout, does not start; the app offers to open the one already running.

## Releases

1. Set the version in `apps/desktop/package.json` and merge it to `main`.
2. Tag that commit and push the tag: `git tag v0.2.0 && git push origin v0.2.0`.

`.github/workflows/release.yml` checks that the tag is on `main` and matches the version, runs the
same checks as CI on Linux, builds the app on macOS, starts it once as a check, builds and starts
the Linux server package on x64 and arm64 runners, and publishes a GitHub pre-release with the DMG,
the two server tarballs and one `SHA256SUMS.txt` for all of them. Then it runs `install.sh` for that
version on macOS and checks that the installed app is the new version and isn't quarantined, and
runs `install-server.sh` on Linux and starts the installed server.

CI on every pull request builds the server bundle and starts it the way the app does (Linux), and
builds the Linux x64 server package and starts it from its launcher. It
builds and starts the packaged app on macOS only when `apps/desktop/`, the workflows or the lockfile
change.

## Not yet

- **Signing and notarization.** These need an Apple Developer ID. The repository secrets will be
  `MACOS_CERTIFICATE` (the Developer ID Application certificate as a base64 `.p12`),
  `MACOS_CERTIFICATE_PASSWORD`, and an App Store Connect API key for notarization:
  `APPLE_API_KEY` (the `.p8` contents), `APPLE_API_KEY_ID`, `APPLE_API_ISSUER`. Signing also turns
  on the hardened runtime, makes the asar integrity check binding, and lets the bundled Node be
  limited to starting from Swan (a launch constraint).
- **Updates.** Download the new DMG for now; auto-update needs signed builds.
- **Intel Macs, a Linux app, Windows.** (The server alone runs on Linux, above.) A Linux app needs the sandbox's route to the proxy checked without
  Podman's macOS VM; Windows also needs its own file permissions, path handling and shutdown.
