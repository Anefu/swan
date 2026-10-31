# AGENTS.md

Guidance for coding agents working in this repository.

## What this is

Swan (package name `persona-harness`) is a local, single-user agent harness. An agent loop runs on the host; every tool call runs in a Podman sandbox that only sees approved folders, and all sandbox traffic leaves through a host-side egress proxy that injects credentials. **Agents never see a secret value.** Work is organised into personas, each with one conversation.

Read before changing behaviour:

- [README.md](README.md): features, setup, files under `~/.persona-harness`.
- [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md): trust boundaries, credential flow, API hardening.
- The product specification is kept by the maintainer outside the repository. Where code and spec disagree, ask rather than guess.

## Layout

```
apps/server       Node harness (TypeScript, run with tsx): agent loop, providers, MCP, sandbox, egress proxy, connections, API
apps/web          React UI (Vite), served by the server from apps/web/dist
packages/shared   Wire protocol types used by server and web; change these first
packages/aws-sigv4  AWS Signature V4 signing and verification (no dependencies)
tools/aws-stub    Local AWS + Kubernetes stand-in and a reference connection wrapper, for tests without an AWS account
sandbox/          Containerfile for the session image
examples/         Seed personas, skills, secrets template, demo workspace
bench/            Benchmark runner for memory and cost per task (see bench/README.md)
```

## Commands

```bash
pnpm install
pnpm typecheck        # all packages
pnpm test             # unit and integration tests (no network, Podman or API keys needed)
pnpm build            # web UI
pnpm start            # server on http://127.0.0.1:4317 (needs Podman)
pnpm dev              # server with restart + Vite with HMR
pnpm aws-stub         # local AWS/Kubernetes stub, see tools/aws-stub/README.md
pnpm bench run bench/campaigns/dry-run.yaml   # benchmark dry run, scripted model (needs Podman)
```

- Node ≥ 22.12, pnpm 10 (see `packageManager`).
- The server keeps its state in `PH_HOME` (default `~/.persona-harness`). Use a temporary `PH_HOME` for experiments and tests; never touch the user's real one from a test.
- The server serves built web assets and only registers files that exist at start, so rebuild the web app and restart the server to see UI changes outside `pnpm dev`.
- `apps/server/scripts/fake-model.ts` is a scripted OpenAI-compatible model for end-to-end runs without an API key.

## Security invariants

These are the product. A change that weakens one needs an explicit decision from the maintainer, not a workaround.

1. Secret values exist only on the host. The sandbox, transcripts, logs, audit files, API responses and the UI see placeholders, names and fingerprints only.
2. The proxy substitutes a credential only for HTTPS requests to that credential's bound hosts that the persona's rules allow (unmatched means not substituted), re-signs AWS requests only after verifying the placeholder signature, and rewrites echoed values back to placeholders.
3. The proxy refuses loopback, private, link-local, CGNAT, multicast and reserved addresses, resolves once and connects to the address it checked. Ports other than 80/443 only by explicit `host:port`, always tunnelled, never credentialed.
4. Host patterns are exact or one-level `*.domain`; a bare `*` never matches.
5. Model-provider keys never reach a persona or the sandbox: they are plain secrets, never connections.
6. Host-side commands (MCP stdio is in the sandbox; connection wrappers and runtimes are on the host) are run as argv without a shell, without Swan's own secrets in their environment, and nothing from the sandbox is passed to them. Wrapper output is validated against protocol v1 and may not put real values into files.
7. The API binds to 127.0.0.1, checks `Host` and `Origin`, and requires the token. Uploaded files are served inline only for images and PDFs; everything else downloads with `nosniff` and a sandboxing CSP.
8. Containers run as uid 1000 with `cap-drop ALL`, `no-new-privileges`, `--init` and resource limits, on the `--internal` network with no DNS.

When you touch the proxy, secrets, sandbox or API, add or update a test that proves the relevant invariant.

## Conventions

- TypeScript, strict, ES modules with `NodeNext` resolution: relative imports end in `.js`.
- Validate every config and file format with zod at the boundary; report errors with the path to the bad field.
- Wire types live in `packages/shared`; the server and web import them from `@ph/shared`.
- Match the surrounding code: sparse comments that explain why, not what; small functions; no new dependency without a reason.
- User-facing text is short, plain and specific. Errors say what happened and what to do.
- UI: minimal and uncluttered (the maintainer has rejected dense designs). Use the existing tokens in `apps/web/src/styles.css`; no new colours or visual styles without being asked. Every control has a label, visible focus and a keyboard path.

## Tests

- Vitest. Tests sit next to the code as `*.test.ts` (`apps/server/src`, `packages/*/src`, `tools/*/src`).
- Tests must not need the internet, Podman, a real `PH_HOME` or API keys. Use temporary directories, ephemeral ports and the stubs in this repository.
- AWS and Kubernetes behaviour is tested against `tools/aws-stub` (with the official AWS SDK as the client, so signatures are checked against a real implementation). `apps/server/src/proxy/credentials.test.ts` drives the real proxy end to end against the stub; its `resolve` hook is the only way to point the proxy at a local address, and it exists for tests only.
- Run `pnpm typecheck && pnpm test` before committing. CI runs the same plus the web build.

## Git

- CI (`.github/workflows/ci.yml`) runs on every push to `main` and every pull request. Work on a branch and open a pull request unless the maintainer says otherwise; merge only when CI passes.
- Commit messages: a short imperative summary line, then what changed and why when it is not obvious.
- Never commit `secrets.yaml`, `secrets.env`, `.env`, anything from `PH_HOME`, or generated certificates.
