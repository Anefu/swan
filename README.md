# Swan (persona-harness)

A local agent harness with a web UI: an agent loop (Claude or any OpenAI-compatible model) whose
tool calls run in a Podman sandbox that only sees the folders you approved, and whose network
traffic goes through an egress proxy that injects credentials, so the agent never sees a secret.

Work is organised into **personas** (workspaces). Each one bundles folders, skills, MCP servers,
rules for the credentials it may use, a network allowlist and tool permissions.

| Feature | How |
|---|---|
| Credentials hidden from agents | Every credential comes from a **connection**. The sandbox gets placeholders; the host-side proxy swaps in real values only for HTTPS requests to the credential's hosts, and rewrites echoed secrets back to placeholders |
| Credential use rules | Per persona and credential, `kubernetes`, `aws` or `http` rules (deny, ask, allow) say which requests may carry it, checked by the proxy however the request was made; anything unmatched goes out without the credential and the user is told |
| Command connections | A wrapper around your own sign-in tool (SSO, cloud CLI, registry login) speaks a small JSON protocol; Swan shows the device-code sign-in, keeps the values on the host, writes placeholder config files into the sandbox and renews before expiry |
| AWS | The sandbox signs with placeholder keys; the proxy checks that signature and re-signs with the real session credentials, so the AWS CLI and SDKs work unmodified |
| Hot-reloaded credentials | `secrets.yaml` / `secrets.env` and the `connections` block of `config.yaml` are watched; the next request uses the new value, with no restart |
| Filesystem sandbox | One Podman container per session; only persona folders are mounted (ro/rw); non-root, `cap-drop ALL`, cpu/mem/pids limits |
| Network sandbox | Container on an `--internal` network with no route and no DNS; the only way out is the relay → proxy, which enforces the allowlist and blocks private/loopback addresses |
| MCP | stdio servers run inside the sandbox (placeholders only); http servers run from the host with real headers and reconnect when their credential rotates |
| Skills | Agent Skills format (`SKILL.md` + files), mounted read-only at `/skills/<name>`, loaded on demand |
| Agent loop | Streaming, adaptive thinking, prompt caching, context epochs with checkpoints, refusal fallbacks, per-tool approvals, interrupt, resumable sessions |
| One conversation per persona | Long conversations roll over into new context epochs with a structured checkpoint; nothing is rewritten, and `history_search` recovers older turns |
| Memory | Persona-private records (preferences, decisions, observations, procedures, episodes) the agent reads and proposes through host-side tools; `/dream` consolidates them |
| Slash commands | `/dream`, `/stop`, `/usage`, plus `/<skill>` for every skill on the persona |
| Sub-agents | An `agent` tool runs focused sub-loops with the same sandbox, credentials and permissions: in parallel, in the background (the parent is told when they finish or ask), with a named sub-agent or a model the parent picks, a forked or brief-only context, and a turn limit per task. Sub-agents can ask the parent a question (`ask_parent`); the parent answers with `agent_message` |
| Attachments | Paperclip, paste or drag-and-drop; files are copied into the sandbox at `/home/agent/attachments/`, images and PDFs also go to the model |
| Usage | Per-request ledger in `audit/usage-*.jsonl` (foreground, subagent, checkpoint, dream), context occupancy, estimated cost where rates are known |
| UI | Swan: persona dropdown, one conversation column, and a right icon rail opening Settings (persona and global), Memory, Usage, Network activity and Attachments |

Design and threat model: [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md). Working on the code (people or agents): [AGENTS.md](AGENTS.md).

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

Add your Anthropic key to `~/.persona-harness/secrets.yaml` (`ANTHROPIC_API_KEY: sk-ant-…`)
or under Settings → Swan → Model providers. Without one, the harness falls back to
`$ANTHROPIC_API_KEY` or an `ant auth login` profile.

Tests (no network, Podman or API keys needed):

```bash
pnpm typecheck && pnpm test
```

Development (server with auto-restart, plus Vite with HMR):

```bash
pnpm dev
```

Vite prints its port (5173, or the next free one).

## Files in `~/.persona-harness`

| Path | What |
|---|---|
| `config.yaml` | Ports, model providers, extra skill directories (restart to apply); `connections` (hot-reloaded) |
| `secrets.yaml`, `secrets.env` | Secret values: model-provider keys, and static connection credentials as `connection/NAME` (hot-reloaded, mode 0600) |
| `connections/<name>/` | A command connection's working directory: the wrapper's own state and a redacted `wrapper.log` |
| `personas/<id>.yaml` | Personas (hot-reloaded; also editable in the UI) |
| `skills/<name>/SKILL.md` | Skills (plus any `skillDirs`, e.g. `~/.claude/skills`) |
| `sessions/<id>.json` | Transcripts; a stopped session resumes when you message it |
| `audit/egress-YYYY-MM-DD.jsonl` | Every outbound request: host, path, decision, credential names (never values) |
| `audit/usage-YYYY-MM-DD.jsonl` | Every model request: persona, purpose, tokens, estimated cost or Copilot credits |
| `attachments/<session>/` | Uploaded attachments and their metadata |
| `memory/<persona>.json` | Persona memory records, change history and checkpoints; never mounted into a sandbox |
| `ca/` | Local CA used to terminate TLS for credential hosts; trusted only inside the sandbox image |
| `copilot-runtime/` | Working and state directory of the Copilot SDK runtime (copilot provider only) |
| `api-token` | Token the UI uses for the API |

## Connections

Every credential an agent can use comes from a connection in `config.yaml`. A persona gets exactly
the credentials its rules name, and the proxy substitutes one only into requests those rules allow.

```yaml
# config.yaml (no values here)
connections:
  github:
    type: static                       # values from secrets.yaml / secrets.env
    credentials:
      GITHUB_TOKEN:
        hosts: [api.github.com]
        inject: { header: Authorization, format: "Bearer {value}" }   # optional
  corp-aws:
    type: command                      # a wrapper that speaks protocol v1
    command: [~/bin/corp-swan, --role, ReadOnly]
    hosts: ["*.amazonaws.com"]         # upper bound for every credential it returns
```

```yaml
# secrets.yaml
github/GITHUB_TOKEN: ghp_…
```

```yaml
# persona
connections:
  github:
    rules:
      - { credential: GITHUB_TOKEN, api: http, allow: ["GET /**"], ask: ["POST /repos/*/*/issues"] }
  corp-aws:
    rules:
      - { credential: prod-eks, api: kubernetes, allow: ["get *", "list *", "watch *"], deny: ["* secrets"] }
      - { credential: prod-aws, api: aws, allow: ["sts:GetCallerIdentity", "s3:Get*", "logs:*"] }
```

Rule forms: `kubernetes` `<verb> <resource>[/<sub>] [in <namespace>]`; `aws` `service:Action`;
`http` `METHOD /path` (`*` within a segment, `**` across). Deny wins over ask, ask over allow, and a
request no rule matches goes out with the placeholder (so it fails upstream) and shows a
"Blocked …" notice with **Add rule…**. An ask rule pauses the request on an approval card.

A command connection runs on the host: `<command> status|login|renew`, `{"protocol":1,…}` on stdin,
JSON Lines on stdout, defined by [docs/connection-protocol-v1.schema.json](docs/connection-protocol-v1.schema.json).
Credential kinds are `bearer`, `header`, `basic` and `aws-sigv4`; files it returns (for example
`~/.aws/credentials`, `~/.kube/config`) are written into the sandbox home with placeholders, and its
env applies to every new shell. `tools/aws-stub` has a reference wrapper and a local AWS +
Kubernetes stand-in to try it without an AWS account.

Upgrading from the earlier format (credentials with `hosts` in the secrets files, personas with
`credentials: [...]`) happens once on start: originals are kept as `.bak`, existing access is kept
with `allow: ["* /**"]` rules, and Settings shows what moved.

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
2. Add it under Settings → Swan → Model providers, or as `COPILOT_GITHUB_TOKEN` in
   `secrets.yaml`. Model-provider keys are used only by the harness; they are not connections, so
   no persona rule can name them and they never reach the sandbox.
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
packages/aws-sigv4  AWS Signature V4 signing and verification
tools/aws-stub  Local AWS + Kubernetes stand-in and a reference connection wrapper (see its README)
sandbox/        Containerfile for the session image
examples/       Seed personas, skills, secrets template, demo workspace
```
