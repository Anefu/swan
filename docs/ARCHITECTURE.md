# persona-harness — architecture

A local, single-user agent harness: an agent loop (Claude or any OpenAI-compatible model) with a
web UI, where every tool call runs in a Podman sandbox that can only see approved folders and can
only reach the network through a credential-injecting egress proxy. Agents never see secret values.

## Trust boundaries

```
 ┌──────────────────────────── macOS host (trusted) ─────────────────────────────┐
 │                                                                                │
 │  Browser UI ──HTTP/WS (127.0.0.1:4317, token + Host/Origin checks)──┐          │
 │                                                                     ▼          │
 │  ┌────────────────────────── harness server (Node) ──────────────────────────┐ │
 │  │ agent loop ─ providers (Anthropic, OpenAI-compatible) ── LLM APIs/local   │ │
 │  │ personas (watched YAML)   secrets store (watched .env/.yaml)              │ │
 │  │ MCP manager: http servers called from host with real headers              │ │
 │  │ egress proxy 127.0.0.1:4318  ── MITM for credential hosts, tunnel others ─┼─┼──▶ internet
 │  └──────────────────────────────▲───────────────────────────────────────────┘ │
 └─────────────────────────────────┼──────────────────────────────────────────────┘
                                   │ host.containers.internal (gvproxy)
 ┌─────────────── Podman VM ───────┼──────────────────────────────────────────────┐
 │   ph-relay (socat, no secrets)  │   networks: podman + ph-internal(10.213.0.2) │
 │        ▲  :3128                                                                 │
 │        │   ph-internal: --internal --disable-dns (no route out, no DNS)        │
 │   ph-sess-<id> (untrusted): bash/file tools, stdio MCP servers, skills (ro)    │
 │        mounts: only persona folders (ro|rw) + /skills/<name> (ro)              │
 │        user agent (uid 1000, keep-id), --init, cap-drop ALL, no-new-privileges,│
 │        pids/mem/cpu limits; HTTP(S)_PROXY=http://<sid>:<token>@10.213.0.2:3128 │
 └────────────────────────────────────────────────────────────────────────────────┘
```

What runs where:

| Component | Where | Sees secrets? |
|---|---|---|
| Agent loop, provider clients | host (harness) | yes (LLM API keys), never sent to the model |
| Copilot SDK runtime (copilot provider) | host child process, own dir under PH_HOME, minimal env | yes (its GitHub token only) |
| Built-in tools (bash, read/write/edit, glob, grep) | session container via `podman exec` | no |
| stdio MCP servers | session container via `podman exec -i` | no — env holds placeholders |
| http MCP servers | host (harness) | yes — headers resolved host-side |
| Skills | mounted read-only at `/skills/<name>` | no |
| Egress proxy | host (harness) | yes — substitutes at egress |
| Relay | Podman VM | no — dumb TCP forwarder |

## Credential flow

1. Secrets live in `~/.persona-harness/secrets.yaml` and/or `secrets.env`, outside every mount.
   Both are file-watched; edits apply immediately (no session restart).
2. A persona lists the secret names it may use (`credentials:`). Each session gets a random
   placeholder per secret, e.g. `phs_GITHUB_TOKEN_3f9c…`. Persona/MCP config refers to secrets as
   `{{secret:GITHUB_TOKEN}}`; inside the sandbox that renders as the placeholder.
3. Container traffic must use the proxy (there is no other route). The proxy identifies the session
   from `Proxy-Authorization`, then for each request:
   - destination not in `network.allow` ∪ credential hosts → **blocked** (403, audited);
   - destination resolves to loopback/private/link-local → **blocked** (prevents reaching the
     harness API or the LAN via the proxy);
   - destination is a host bound to one of the session's credentials → TLS is terminated with the
     harness CA (trusted inside the image only), placeholders in headers/query/Basic-auth are
     replaced with real values, optional `inject` headers are added, upstream TLS is verified, and
     real values in the response are rewritten back to placeholders;
   - otherwise → plain CONNECT tunnel (no interception).
4. A placeholder sent to any host not bound to that secret stays a useless placeholder.
5. Rotation = edit the file. The proxy reads values per request; http MCP clients that reference a
   changed secret reconnect; provider clients are created per request.

Secret file formats:

```yaml
# secrets.yaml
GITHUB_TOKEN:
  value: ghp_xxx
  hosts: [api.github.com, github.com, "*.githubusercontent.com"]
  inject: { header: Authorization, format: "Bearer {value}" }   # optional
ANTHROPIC_API_KEY:
  value: sk-ant-xxx            # no hosts: usable by the harness only, never by the sandbox
```

```sh
# secrets.env — values only; bind hosts with NAME__HOSTS
GITHUB_TOKEN=ghp_xxx
GITHUB_TOKEN__HOSTS=api.github.com,github.com
```

## Personas (workspaces)

`~/.persona-harness/personas/<id>.yaml`, file-watched. See `examples/personas/`.

```yaml
name: Backend dev
description: Works on the API service
model: { provider: anthropic, id: claude-opus-5-5, effort: high }
instructions: |                 # appended to the system prompt
  Prefer small, reviewed changes.
folders:
  - { path: ~/code/api, mode: rw }                 # → /workspace/api
  - { path: ~/docs/specs, mount: /workspace/specs, mode: ro }
skills: [git-hygiene]
mcpServers:
  github:                                         # stdio, runs in the sandbox
    command: npx
    args: [-y, "@modelcontextprotocol/server-github"]
    env: { GITHUB_PERSONAL_ACCESS_TOKEN: "{{secret:GITHUB_TOKEN}}" }
  docs:                                           # http, called from the host
    url: https://example.com/mcp
    headers: { Authorization: "Bearer {{secret:DOCS_TOKEN}}" }
credentials: [GITHUB_TOKEN, DOCS_TOKEN]
env: { NODE_ENV: development }
network:
  allow: [registry.npmjs.org, pypi.org, files.pythonhosted.org]
permissions:
  default: ask                  # allow | ask | deny for anything unmatched
  allow: [read_file, list_dir, glob, grep, load_skill, "mcp__github__get_*", "bash(git status*)"]
  ask: [bash, write_file, edit_file]
  deny: ["mcp__github__delete_*"]
sandbox: { cpus: 2, memory: 2g, pidsLimit: 512 }
```

Path guards: folders must exist, must not contain `~/.persona-harness`, and must not be `/`, `~`,
or a system directory. Rule precedence: deny > allow > ask > default; "Always allow" in the UI adds a
session-scoped allow rule.

## Agent loop

- Canonical transcript = Anthropic message format, append-only (required for preserved thinking and
  good for prompt caching). The OpenAI adapter converts on the way out.
- Anthropic requests: streaming, adaptive thinking with summarized display, `output_config.effort`,
  `eager_input_streaming` on every tool (inputs validated before execution), top-level prompt
  caching, Swan context epochs with checkpoints (not provider compaction), and server-side refusal fallbacks
  (`fallbacks: "default"`, `server-side-fallback-2026-07-01`) for models that support them.
- Tools are frozen at session start (deterministic order) so the prefix stays cacheable.
- Each assistant turn: stream → validate tool inputs → permission check (ask → UI approval) →
  execute approved calls concurrently → one user message with all `tool_result`s.
- Interrupt aborts the stream, kills running execs, and closes open tool calls with
  "interrupted" results so the transcript stays valid.
- Tool output is truncated (head + tail) before it enters the transcript, never edited later.
- Sessions persist to `~/.persona-harness/sessions/<id>.json`; after a restart a session is
  `stopped` and the next message re-creates its container and MCP servers.

## Copilot provider

GitHub exposes Copilot models to third-party apps only through the Copilot SDK, which runs
Copilot's own agent runtime. To keep the harness in charge of the loop:

- The client runs in `mode: "empty"` with `availableTools: ["custom:*"]`, `systemMessage` replaced
  by the harness prompt, infinite sessions off and custom instructions skipped. Any permission
  request from the runtime is denied.
- Harness tools are declared without handlers. The runtime emits `external_tool.requested`; the
  adapter returns those as `tool_use`, the harness gates and runs them in the sandbox, and the next
  turn answers them with `session.rpc.tools.handlePendingToolCall` (marked experimental in the SDK).
- The adapter is stateful: one SDK session per harness session. Each turn checks that the
  transcript extends what the runtime has seen (length + hash). If not, it rebuilds the session and
  replays earlier turns as text, since the SDK cannot seed tool-call history.
- The runtime gets an explicit minimal environment (no provider keys from the harness's env), and
  its token comes only from `COPILOT_GITHUB_TOKEN` (or, with `useLoggedInUser`, the GitHub CLI login: SDK empty mode cannot see a `copilot login`).
- Personas may not list any provider key under `credentials:`, so the egress proxy can never
  inject it into sandbox traffic.

## Harness API hardening

- Binds 127.0.0.1 only; rejects requests whose Host is not localhost/127.0.0.1 (DNS rebinding) and
  whose Origin is foreign; requires `x-ph-token` (random per install, `~/.persona-harness/api-token`).
- The sandbox cannot reach it: no route from `ph-internal`, and the proxy refuses loopback/private
  destinations.

## Known limits / roadmap

- Data exfiltration to *allowed* hosts is possible by design; keep allowlists tight.
- Tools that ignore `HTTP(S)_PROXY` simply fail (secure default); some need extra config
  (e.g. `git config http.proxy` is picked up from env, Java needs `-Dhttps.proxyHost`).
- Certificate-pinning clients fail on MITM'd hosts; leave those hosts without credentials (tunnel).
- Not yet: OAuth flows for remote MCP servers, subagents, checkpoints/undo (git snapshots), per-
  session cost budgets, scheduled runs, multi-user auth, Docker/Seatbelt backends.
