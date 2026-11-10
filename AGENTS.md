# AGENTS.md

Guidance for coding agents working in this repository.

## What this is

Swan (package name `persona-harness`) is a local, single-user agent harness for macOS, shipped as a desktop app. An agent loop runs on the host; every tool call runs in a Podman sandbox that only sees approved folders, and all sandbox traffic leaves through a host-side egress proxy that injects credentials. **Agents never see a secret value.** Work is organised into personas, each with any number of conversations.

Read before changing behaviour:

- [README.md](README.md): features, setup, files under `~/.swan`.
- [docs/DESKTOP.md](docs/DESKTOP.md): the app, test instances, releases.
- [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md): trust boundaries, credential flow, API hardening.
- The product specification is kept by the maintainer outside the repository. Where code and spec disagree, ask rather than guess.

## Layout

```
apps/server       Node harness (TypeScript, run with tsx): agent loop, providers, MCP, sandbox, egress proxy, connections, API
apps/desktop      The macOS app: Electron main process (main/), React UI (ui/, Vite), build and release scripts
packages/shared   Wire protocol types used by the server and the app; change these first
packages/aws-sigv4  AWS Signature V4 signing and verification (no dependencies)
tools/aws-stub    Local AWS + Kubernetes stand-in and a reference connection wrapper, for tests without an AWS account
sandbox/          Containerfile for the session image
examples/         Seed personas, skills, secrets template, demo workspace
install.sh        Installs or updates Swan from the newest release (curl … | bash; bash 3.2, shellcheck clean)
```

## Commands

```bash
pnpm install
pnpm typecheck        # all packages
pnpm test             # unit and integration tests (no network, Podman or API keys needed)
pnpm build            # the app's main process, UI and server bundle (apps/desktop/build)
pnpm start            # build and open the app (needs Podman)
pnpm package          # unsigned Swan.app and DMG in apps/desktop/release
pnpm dev              # server with restart + the UI with hot reload in the app window
pnpm aws-stub         # local AWS/Kubernetes stub, see tools/aws-stub/README.md
```

- Node ≥ 22.12, pnpm 10 (see `packageManager`).
- The server keeps its state in `PH_HOME` (default `~/.swan`). Use a temporary `PH_HOME` for experiments and tests, with its own ports and Podman network and relay names (docs/DESKTOP.md); never touch the user's real one from a test, and never launch the app without `PH_HOME` while testing.
- The server serves no UI. The app serves it at `swan://app` and passes `/api/` to the server; `pnpm dev` loads it from Vite instead.
- `apps/server/scripts/fake-model.ts` is a scripted OpenAI-compatible model for end-to-end runs without an API key.

## Security invariants

These are the product. A change that weakens one needs an explicit decision from the maintainer, not a workaround.

1. Secret values exist only on the host. The sandbox, transcripts, logs, audit files, API responses and the UI see placeholders, names and fingerprints only.
2. The proxy substitutes a credential only for HTTPS requests to that credential's bound hosts that the persona's rules allow (unmatched means not substituted), re-signs AWS requests only after verifying the placeholder signature, and rewrites echoed values back to placeholders. On those hosts it refuses requests that carry any credential not from the session's placeholders (Authorization, an AWS signature or presigned key, credential headers or query tokens), except on hosts the persona lists in `network.otherCredentials`; it records which field, never the value.
3. The proxy resolves once on the host and refuses loopback, link-local, CGNAT, multicast and reserved addresses, Swan's and Podman's networks, the host's own addresses and names that do not resolve; private ranges (10/8, 172.16/12, 192.168/16, fc00::/7) only for hosts a persona lists in `network.internal`, which only Settings or the YAML add. It connects to the address it checked, or through config.yaml's `proxy` by name. Ports other than 80/443 only by explicit `host:port`, always tunnelled, never credentialed.
4. Host patterns are exact or one-level `*.domain`; a bare `*` never matches.
5. Model-provider keys never reach a persona or the sandbox: they are plain secrets, never connections.
6. Host-side commands (MCP stdio is in the sandbox; connection wrappers and runtimes are on the host) are run as argv without a shell, without Swan's own secrets in their environment, and nothing from the sandbox is passed to them. Wrapper output is validated against protocol v1 and may not put real values into files.
7. The API binds to 127.0.0.1, checks `Host` and `Origin` (loopback pages and the app's `swan://app` only), and requires the token. Uploaded files are served inline only for images and PDFs; everything else downloads with `nosniff` and a sandboxing CSP.
9. The app runs no remote content in its window: the UI comes from the app bundle with a CSP, navigation and new windows outside Swan open in the browser, permissions are denied except clipboard writes, and Electron's RunAsNode, NodeOptions and NodeCliInspect fuses stay off.
8. Containers run as uid 1000 with `cap-drop ALL`, `no-new-privileges`, `--init` and resource limits, on the `--internal` network with no DNS.

When you touch the proxy, secrets, sandbox or API, add or update a test that proves the relevant invariant.

## Conventions

- TypeScript, strict, ES modules with `NodeNext` resolution: relative imports end in `.js`.
- Validate every config and file format with zod at the boundary; report errors with the path to the bad field.
- Wire types live in `packages/shared`; the server and the app import them from `@ph/shared`.
- Match the surrounding code: sparse comments that explain why, not what; small functions; no new dependency without a reason.
- User-facing text is short, plain and specific. Errors say what happened and what to do.
- UI: minimal and uncluttered (the maintainer has rejected dense designs). Use the existing tokens in `apps/desktop/ui/src/styles.css`; no new colours or visual styles without being asked. Every control has a label, visible focus and a keyboard path.

## Tests

- Vitest. Tests sit next to the code as `*.test.ts` (`apps/server/src`, `apps/desktop/main`, `apps/desktop/ui/src` for logic without a DOM, `packages/*/src`, `tools/*/src`). `pnpm --filter @ph/desktop smoke-server` starts the bundled server the way the app does (after `pnpm build`).
- Tests must not need the internet, Podman, a real `PH_HOME` or API keys. Use temporary directories, ephemeral ports and the stubs in this repository.
- Run tests with `pnpm test`, or `vitest` from a package folder (each has a config with the shared setup); either gives every test a temporary `PH_HOME`. Under Vitest, `settings.ts` refuses any other `PH_HOME`: a single test file once ran against the real `~/.swan` and overwrote its config and secrets.
- AWS and Kubernetes behaviour is tested against `tools/aws-stub` (with the official AWS SDK as the client, so signatures are checked against a real implementation). `apps/server/src/proxy/credentials.test.ts` drives the real proxy end to end against the stub; its `resolve` hook is the only way to point the proxy at a local address, and it exists for tests only.
- Run `pnpm typecheck && pnpm test` before committing. CI runs the same plus the build and the server smoke test, and packages the app on macOS when `apps/desktop/` changes.

## Git

- CI (`.github/workflows/ci.yml`) runs on every push to `main` and every pull request. Work on a branch and open a pull request unless the maintainer says otherwise; merge only when CI passes.
- Commit messages: a short imperative summary line, then what changed and why when it is not obvious.
- A tag `vX.Y.Z` on `main` publishes a pre-release (`.github/workflows/release.yml`). Only the maintainer tags.
- Never commit `secrets.yaml`, `secrets.env`, `.env`, anything from `PH_HOME`, or generated certificates.
