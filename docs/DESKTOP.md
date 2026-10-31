# Swan for macOS

Swan is a macOS app. The app starts Swan's server, shows its UI in its own window, and stops the
server when you quit. There is no browser mode: the server answers the API only.

## Install

Download `Swan-<version>-arm64.dmg` from the repository's Releases and drag Swan to Applications.
Builds are not signed yet, so macOS blocks the first open: open it once, then choose
System Settings → Privacy & Security → Open Anyway (or run
`xattr -dr com.apple.quarantine /Applications/Swan.app`).

Swan needs Podman: `brew install podman`, or Podman Desktop. If Podman has no machine yet, Swan
offers to create one (a one-time download of about 1 GB); a stopped machine is started for you.

When a persona uses folders in Documents, Desktop or Downloads, macOS asks once whether Swan may
access them. An unsigned build is a new app to macOS each time, so it asks again after an update.

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

`.github/workflows/release.yml` checks that the tag is on `main` and matches the version, runs
typecheck and tests, builds the app on macOS, starts it once as a check, and publishes a GitHub
pre-release with the DMG and `SHA256SUMS.txt`.

CI on every pull request builds the server bundle and starts it the way the app does (Linux). It
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
- **Intel Macs, Linux, Windows.** Linux needs the sandbox's route to the proxy checked without
  Podman's macOS VM; Windows also needs its own file permissions, path handling and shutdown.
