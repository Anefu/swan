# Swan

Swan is a Mac app for working with AI agents without handing them your computer. You give an agent
a job, such as fixing a bug, tidying a folder or checking a cloud account, and it works in a sandbox.
The sandbox sees only the folders you choose and reaches only the websites you allow. The agent can
use your tokens and passwords without ever seeing them, and it asks before doing anything you
haven't allowed.

## What you get

- **A sandbox for every agent.** Commands run in a Linux container that can see only the folders you
  add, read-only or read-write. The rest of your Mac doesn't exist to it.
- **Secrets that stay secret.** Agents get stand-ins for your credentials. Swan swaps in the real
  value on the way out, only to the website it belongs to, and only for requests you've allowed.
- **You decide what happens.** For each kind of action you choose: allowed, ask first, or never.
  When an agent wants something you haven't decided on, you get a card to allow it once, allow it
  always, or deny it.
- **No surprise network traffic.** Agents reach only the websites on their allowlist. Anything else
  is blocked and shows up in the Network panel, where you can allow it.
- **Personas.** Set an agent up once for a kind of work (its model, folders, credentials and rules)
  and keep one ongoing conversation with it. It remembers your preferences and decisions over time.
- **Your choice of model.** Claude (Anthropic), OpenAI, any OpenAI-compatible server including models
  running on your Mac, or your GitHub Copilot subscription.
- **More when you need it.** Skills, MCP servers, sub-agents that work in parallel, file and image
  attachments, and usage and cost tracking.

Everything stays on your Mac, in `~/.swan`. What leaves it: your conversations go to the model
provider you chose, and agents' requests go only to hosts you've allowed.

## What you need

- A Mac with Apple silicon (M1 or later) and macOS 13 or later.
- [Podman](https://podman.io), the free tool that runs the sandboxes: `brew install podman`, or
  [Podman Desktop](https://podman-desktop.io).
- A model: an Anthropic or OpenAI API key, a GitHub Copilot subscription, or a model server running
  on your Mac (Ollama, LM Studio, `mlx_lm.server`, vLLM).

## Install

1. In Terminal, run:
   ```bash
   curl -fsSL https://raw.githubusercontent.com/Anefu/swan/main/install.sh | bash
   ```
   It downloads the latest release, checks it against the release's checksums and puts Swan in
   Applications. [install.sh](install.sh) is short; read it first if you like.
2. Open Swan. If Podman has no machine yet, click **Set up Podman** (a one-time download of about
   1 GB). Swan then builds its sandbox, which takes a minute or two the first time.

You can also download `Swan-<version>-arm64.dmg` from
[Releases](https://github.com/Anefu/swan/releases) and drag Swan to Applications. Builds are not
signed by Apple yet, so macOS blocks a downloaded app the first time: choose System Settings →
Privacy & Security → Open Anyway, or run `xattr -dr com.apple.quarantine /Applications/Swan.app`.
The install script avoids this, because files `curl` downloads aren't marked as downloaded.

## Getting started

1. **Add a model.** Click the swan icon at the top right to open **Swan settings** (or press ⌘,),
   and add a key under **Model providers**. For Copilot, see [GitHub Copilot](#github-copilot).
2. **Make a persona.** Swan starts with two examples, Demo and GitHub helper. To make your own, open
   the persona menu at the top left and choose **New persona**: give it a name and a model, add the
   folders it may see ("Can read" or "Can change"), and choose what it may do without asking. The
   gear icon opens the current persona's settings.
3. **Give it a job.** Type what you want done. When the agent wants to run a command, change a file
   or reach a new website, a card asks you first. **Stop** interrupts it at any time.
4. **Keep an eye on it.** The Overview panel (the list icon) shows what the agent is working on, its
   sub-agents, credentials, memory, attachments and network activity.

Type `/` in the message box for commands: `/dream` tidies the persona's memory, `/stop` stops the
agent and clears what you allowed for this run, `/usage` shows usage, and `/<skill>` asks the agent
to use one of the persona's skills.

## Main ideas

- **Persona**: an agent set up for a kind of work, with its own model, instructions, folders,
  skills, credentials, allowed websites and permissions. Each persona has one conversation; long ones
  continue in a fresh context with a summary, and nothing is lost.
- **Folders**: the only parts of your Mac an agent sees, at `/workspace/<name>`. Swan refuses
  folders that would expose your whole home folder, system folders or its own data.
- **Permissions**: per tool, `allow`, `ask` or `deny`, and for commands patterns such as `cd *` or
  `npm test*`. A command that joins several, like `cd app && npm test`, is allowed when every part
  is. A command's card names the parts no rule covers and offers to allow them with any arguments
  (`ls *`, `npm test *`) until the agent stops, or always (saved to the persona). Shells and
  interpreters such as `bash` or `python` are never offered that way.
- **Credentials**: tokens and keys agents may use, each limited to its websites and to the requests
  the persona's rules allow. See [docs/CREDENTIALS.md](docs/CREDENTIALS.md).
- **Allowed websites**: each persona lists the hosts its agent may reach. Private and local
  addresses on your network are never reachable.
- **Memory**: preferences, decisions and facts the agent saves for the persona, which you can review
  and edit under Memory. It never leaves the persona.
- **Skills**: folders of instructions and scripts (the Agent Skills format) the agent loads when a
  task needs them.
- **MCP servers**: extra tools for the agent. Ones that run as a command run inside the sandbox; ones
  at a URL are called from your Mac with the real credentials.
- **Tools in the sandbox**: git, curl, Python, Node and more are there; add others such as kubectl
  or the AWS CLI under `sandboxTools` in `config.yaml`
  ([how](docs/DESKTOP.md#tools-in-the-sandbox)), or give a persona an image of your own
  ([how](docs/DESKTOP.md#a-personas-own-image)).
- **Settings that need a fresh sandbox** (folders, skills, MCP servers, environment variables)
  restart it by themselves between turns; the conversation carries on.
- **Sub-agents**: the agent can hand parts of a task to focused helpers that work in parallel or in
  the background, with the same sandbox and rules.
- **Sharing a persona**: **Export…** at the bottom of a persona's settings saves a
  `.swan-persona.yaml` file with its settings, the connections it uses and, if you choose, its skills;
  never secret values. **Import persona…** in the persona menu shows what the persona may reach before
  anything is saved: you pick its name, point its folders at yours, and choose whether to add sign-in
  tools that run on your Mac. Connections and skills you already have are kept.

- **Changes**: the agent shows you diffs with `show_diff`, as many as there are things to review, and
  the +/− button at the top right opens them. Each comes from a command in the sandbox (`git diff`,
  `git show`, `diff -u`), under the persona's rules for commands. They show what the agent chose to
  show, so treat them as a reading aid, not proof.
- **Questions**: when the agent needs you to choose, it shows options in the conversation and waits.
  Pick one (or several, then Send), answer in the message box instead, or skip. Unattended runs
  can't ask.
- **Tracker**: the merge requests, tickets, docs and deploys the agent creates or follows, with
  their status (in progress, waiting, done, dropped). Open it from the Overview; you can add items
  and change their status too.
- **Schedules and watchers**: turns that start without you. See below.

### Schedules and watchers

Ask the agent ("remind me at 17:00 to…"; it has `schedule` and `watch` tools), or add them in a
persona's Settings under **Schedules and watchers** (with GitLab, GitHub and Jira
starting points), or in its YAML. A watcher checks an API every so often from the persona's sandbox,
so its requests use the persona's allowed hosts and credentials like the agent's own; it remembers
what it has seen (the first check only records), and starts one turn for everything new.

```yaml
schedules:
  - name: morning
    at: "09:00"                # or every: 1h, or once: "2026-11-03 17:00" for a reminder
    days: [mon, tue, wed, thu, fri]
    prompt: Check the tracker, update each open item, and summarise what needs me today.

watchers:
  - name: assigned-tickets
    every: 5m
    get: https://jira.example.com/rest/api/3/search?jql=assignee%3DcurrentUser()&fields=summary
    items: issues              # where the list is in the response ("" for the top level)
    id: key                    # what identifies an item
    prompt: "Assigned to you: {{item.key}} {{item.fields.summary}}. Track it and say how you'd approach it."

  - name: mr-comments          # every MR in the tracker that is in progress or waiting
    every: 2m
    forEach: { tracker: { kind: mr } }
    get: "{{gitlabApi tracker.url}}/notes?sort=desc&per_page=50"   # githubApi for GitHub PRs
    skip: { system: true }
    prompt: "New comment on {{tracker.title}} from {{item.author.username}}: {{item.body}}"

unattended:                    # what a triggered turn may do; anything else that would ask is refused
  allow: [read, "bash(git *)"]
  credentials:
    gitlab/GITLAB_TOKEN: ["POST /api/v4/projects/*/merge_requests/*/notes"]   # ask rules allowed unattended
  maxTurnsPerDay: 30
```

`changed: fields.updated` makes an edited item count as new again; `run: [script, args]` instead of
`get` runs a command in the sandbox that prints one JSON object per line. Triggered turns never
reach new hosts, and text from watched items is treated as data, not instructions. The Triggers
screen in the Overview shows each one's last and next run and errors, with Test, Run now and a
switch to pause them. A schedule missed while Swan was closed runs once on start if it was missed
by less than two hours.

A complete persona, `config.yaml` and `secrets.yaml` using every setting:
[examples/reference/](examples/reference/).

## Models

Models are set up in Swan settings → Model providers, or under `providers` in
`~/.swan/config.yaml`. Keys are used only by Swan itself; no agent can ever see or use them.

- **Anthropic**: Claude, with an API key.
- **OpenAI and compatible servers**: OpenAI with an API key, or any OpenAI-compatible server, such as
  a model running on your Mac.

### GitHub Copilot

Swan can use your Copilot subscription through GitHub's official
[Copilot SDK](https://github.com/github/copilot-sdk).

1. On your personal GitHub account, create a fine-grained personal access token with the
   **Copilot Requests** permission. Classic `ghp_` tokens don't work.
2. Add it in Swan settings → Model providers → GitHub Copilot.
3. Pick a Copilot model in the model menu below the message box. Which ones you see depends on your
   plan.

Good to know: usage counts against your Copilot plan. After you stop the agent or restart Swan,
earlier turns are passed to Copilot as text, so it may lose some detail of past tool calls. Images
reach Copilot models, PDFs don't.

## Privacy and safety

- Your conversations, including file contents the agent reads, go to your model provider. Check
  that this is allowed for the data you give it.
- Credentials and keys stay on your Mac: in `~/.swan/secrets.yaml`, readable only by your user, or
  with your own sign-in tools. Agents, logs and the UI see stand-ins, names and fingerprints.
- An agent can send what it reads to any website you allow. Keep each persona's list short.
- Swan has no analytics or telemetry of its own.
- Swan is young (version 0.x) and has not had an independent security review. How it works and what
  it defends against: [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md).

## Behind a company proxy

If your network reaches the internet only through a proxy or internal mirrors (an Artifactory, for
example), see [docs/DESKTOP.md](docs/DESKTOP.md#behind-a-proxy-or-internal-mirrors). Agents' traffic
goes through the proxy too. Agents reach internal hosts (private addresses) only when you list them
in the persona's Settings under Allowed hosts → On your company network.

## Your data

Everything is in `~/.swan`:

| Path | What |
|---|---|
| `config.yaml` | Model providers, credentials (`connections`), proxy and mirrors, ports. Restart Swan after editing, except `connections`, which apply at once |
| `secrets.yaml`, `secrets.env` | Keys and credential values (readable only by you) |
| `personas/<id>.yaml` | Personas (also editable in Settings) |
| `skills/` | Skills |
| `sessions/` | Conversations |
| `memory/` | Each persona's memory |
| `attachments/` | Files you attached |
| `audit/` | Every outbound request the agents made (hosts and decisions, never values), and every model request with its usage |
| `ca/` | Swan's own certificate authority, trusted only inside the sandbox |
| `copilot-runtime/` | Copilot's working files |
| `connections/` | Your sign-in tools' working folders |
| `api-token`, `server.json` | How the app talks to its server |

Swan's log is at `~/Library/Logs/Swan/server.log` (Help → Show Server Log). Data from before Swan
was renamed, in `~/.persona-harness`, is moved to `~/.swan` on first start.

## Updating and uninstalling

To update, quit Swan and run the install command again (end it with `bash -s -- 0.1.3` for a
specific version), or replace the app with a new DMG. Your data stays. Builds are unsigned, so
macOS may ask again for access to folders such as Documents.

To remove Swan completely:
1. Quit Swan and delete `/Applications/Swan.app`.
2. Delete `~/.swan`, `~/Library/Application Support/Swan` and `~/Library/Logs/Swan`.
3. Remove Swan's Podman resources: `podman rm -f ph-relay`, `podman network rm ph-internal`, and the
   `localhost/persona-harness-sandbox` images (`podman images`). Or remove the whole Podman machine
   with `podman machine rm`.
4. Revoke any tokens you created for it.

## Limits

- macOS on Apple silicon only for now. Intel Macs, Linux and Windows may come later.
- Not yet signed or notarized by Apple, and no automatic updates.

## Building from source and contributing

Node 22.12 or later and pnpm 10.

```bash
pnpm install
pnpm start      # build and open the app
pnpm package    # Swan.app and a DMG in apps/desktop/release
pnpm dev        # the server with auto-restart, and the UI with hot reload in the app window
pnpm typecheck && pnpm test   # no network, Podman or API keys needed
```

- How Swan works and its threat model: [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md)
- The desktop app, test instances and releases: [docs/DESKTOP.md](docs/DESKTOP.md)
- Conventions and the security rules every change keeps: [AGENTS.md](AGENTS.md)
- To try Swan without an API key, `apps/server/scripts/fake-model.ts` is a scripted model; its
  header explains how to use it.

```
apps/server       The server: agent loop, model providers, MCP, sandbox, egress proxy, API
apps/desktop      The Mac app: Electron (main/) and the React UI (ui/)
packages/shared   Types shared by the server and the app
packages/aws-sigv4  AWS request signing
tools/aws-stub    A local AWS and Kubernetes stand-in for testing sign-in tools
sandbox/          The sandbox image
examples/         Example personas, skills and a complete reference configuration
```

## License

Swan is licensed under the [Apache License 2.0](LICENSE). Copyright 2026 Anefu; see [NOTICE](NOTICE).
Contributions are accepted under the same license.
