# Swan (persona-harness)

A local agent harness with a web UI: an agent loop (Claude or any OpenAI-compatible model) whose
tool calls run in a Podman sandbox that only sees the folders you approved, and whose network
traffic goes through an egress proxy that injects credentials, so the agent never sees a secret.

Work is organised into **personas** (workspaces). Each one bundles folders, skills, MCP servers, the
credentials it may use, a network allowlist and tool permissions.

| Feature | How |
|---|---|
| Credentials hidden from agents | The sandbox gets placeholders; the host-side proxy swaps in real values only for HTTPS requests to each secret's bound hosts, and rewrites echoed secrets back to placeholders |
| Hot-reloaded credentials | `secrets.yaml` / `secrets.env` are watched; the next request uses the new value, with no restart, and sessions get a notice |
| Filesystem sandbox | One Podman container per session; only persona folders are mounted (ro/rw); non-root, `cap-drop ALL`, cpu/mem/pids limits |
| Network sandbox | Container on an `--internal` network with no route and no DNS; the only way out is the relay → proxy, which enforces the allowlist and blocks private/loopback addresses |
| MCP | stdio servers run inside the sandbox (placeholders only); http servers run from the host with real headers and reconnect when their secret rotates |
| Skills | Agent Skills format (`SKILL.md` + files), mounted read-only at `/skills/<name>`, loaded on demand |
| Agent loop | Streaming, adaptive thinking, prompt caching, context epochs with checkpoints, refusal fallbacks, per-tool approvals, interrupt, resumable sessions |
| One conversation per persona | Long conversations roll over into new context epochs with a structured checkpoint; nothing is rewritten, and `history_search` recovers older turns |
| Memory | Persona-private records (preferences, decisions, observations, procedures, episodes) the agent reads and proposes through host-side tools; `/dream` consolidates them |
| Slash commands | `/dream`, `/stop`, `/usage`, plus `/<skill>` for every skill on the persona |
| Usage | Per-request ledger in `audit/usage-*.jsonl` (foreground, checkpoint, dream), context occupancy, estimated cost where rates are known |
| UI | Swan: persona dropdown, one conversation column, Settings (persona and global) and Memory & Usage panes, Network activity view |

Design and threat model: [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md).

## Requirements

- macOS with Podman (`brew install podman && podman machine init && podman machine start`)
- Node ≥ 22.12 and pnpm 10

## Run

```bash
pnpm install
```

```bash
pnpm build && pnpm start
```

Open http://127.0.0.1:4317. On first start the harness creates `~/.persona-harness/`, seeds two
example personas, builds the sandbox image (about a minute) and starts the relay container.

Add your Anthropic key to `~/.persona-harness/secrets.yaml` (`ANTHROPIC_API_KEY: { value: sk-ant-… }`)
or from the Credentials page. Without one, the harness falls back to `$ANTHROPIC_API_KEY` or an
`ant auth login` profile.

Development (server with auto-restart, plus Vite with HMR):

```bash
pnpm dev
```

Vite prints its port (5173, or the next free one).

## Files in `~/.persona-harness`

| Path | What |
|---|---|
| `config.yaml` | Ports, model providers, extra skill directories (restart to apply) |
| `secrets.yaml`, `secrets.env` | Credentials and their host bindings (hot-reloaded, mode 0600) |
| `personas/<id>.yaml` | Personas (hot-reloaded; also editable in the UI) |
| `skills/<name>/SKILL.md` | Skills (plus any `skillDirs`, e.g. `~/.claude/skills`) |
| `sessions/<id>.json` | Transcripts; a stopped session resumes when you message it |
| `audit/egress-YYYY-MM-DD.jsonl` | Every outbound request: host, path, decision, credential names (never values) |
| `audit/usage-YYYY-MM-DD.jsonl` | Every model request: persona, purpose, tokens, estimated cost or Copilot credits |
| `memory/<persona>.json` | Persona memory records, change history and checkpoints; never mounted into a sandbox |
| `ca/` | Local CA used to terminate TLS for credential hosts; trusted only inside the sandbox image |
| `copilot-runtime/` | Working and state directory of the Copilot SDK runtime (copilot provider only) |
| `api-token` | Token the UI uses for the API |

A credential is usable from the sandbox only when both are true: the persona lists it under
`credentials:`, and the secret has `hosts:`. Example:

```yaml
GITHUB_TOKEN:
  value: ghp_…
  hosts: [api.github.com]
  inject: { header: Authorization, format: "Bearer {value}" }   # optional
```

Persona reference: [docs/ARCHITECTURE.md#personas-workspaces](docs/ARCHITECTURE.md#personas-workspaces)
and `examples/personas/`.

## Models

`config.yaml` → `providers`. `type: anthropic` uses the Anthropic SDK. `type: openai` works with
OpenAI or any OpenAI-compatible server: `mlx_lm.server`, Ollama, vLLM or LM Studio. A persona picks
one with `model: { provider: local, id: <model> }`.

### GitHub Copilot

`type: copilot` uses your Copilot subscription through GitHub's official
[Copilot SDK](https://github.com/github/copilot-sdk). GitHub has no public model API for
third-party apps, and this is the supported route.

1. Create a fine-grained personal access token on your **personal** account (not an org) with the
   **Copilot Requests** account permission. Classic `ghp_` tokens are rejected.
2. Add it as `COPILOT_GITHUB_TOKEN` on the Credentials page or in `secrets.yaml`. Leave it
   without `hosts`: it is used only by the harness and never reaches the sandbox. Personas cannot
   list provider keys under `credentials:`.
3. List the model ids your plan offers:
   `curl -H "x-ph-token: $(cat ~/.persona-harness/api-token)" http://127.0.0.1:4317/api/providers/copilot/models`
4. Use one in a persona: `model: { provider: copilot, id: <id>, effort: high }`.

How it works: the SDK runs Copilot's agent runtime on the host in `empty` mode, with no built-in
tools, instructions, skills or MCP. The harness declares its own tools without handlers, so the
runtime hands every tool call back. Calls then go through the persona's permission rules and run
in the sandbox, exactly as with the other providers. Rotating the token starts a fresh runtime on
the next turn.

Limits:
- The runtime keeps its own session state. After an interrupt, a restart or a persona change,
  earlier turns are replayed to the model as text, so some tool-call detail is lost.
- Output-token limits and thinking display follow Copilot's runtime, not the persona's `maxTokens`.
- Usage is billed to your Copilot AI credits; the server log shows credits per model step.
- To use your GitHub CLI login (`gh auth login`) instead of a token, set `useLoggedInUser: true` on the
  provider.

To test without any API key, `apps/server/scripts/fake-model.ts` is a scripted model that drives
real tool calls (isolation checks, credential injection, approvals, skills, interrupt). Its header
explains how to wire it up.

## Layout

```
apps/server     Node harness: agent loop, providers, MCP, sandbox runtime, egress proxy, API
apps/web        React UI (Vite)
packages/shared Wire protocol types shared by both
sandbox/        Containerfile for the session image
examples/       Seed personas, skills, secrets template, demo workspace
```
