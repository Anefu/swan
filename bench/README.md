# Swan benchmarks

Measures how well Swan keeps what matters across context rollovers, restarts and new conversations,
and what a task costs, per model and configuration. It drives a real Swan (agent loop, sandbox,
proxy) through its API; nothing is mocked except the model in dry runs.

```bash
pnpm bench run bench/campaigns/dry-run.yaml                     # scripted model, spends nothing
pnpm bench run bench/campaigns/pilot.yaml --secrets ~/.persona-harness/secrets.yaml
pnpm bench report ~/.swan-bench/results/<campaign>-<time>      # rebuild the summary
```

Options: `--only <case-id>` runs one case; `--variant <name>` runs one variant; `--work <dir>`
moves the working directory (default `~/.swan-bench`, inside `$HOME` so Podman can mount the run's
workspace).

## How a run works

Every run gets a fresh Swan home with its own config, the `bench` persona and a copy of the case's
workspace, on port 4617 with network `ph-bench` and relay `ph-relay-bench`. It never touches the
user's Swan or `~/.persona-harness`. One CA is kept in `<work>/.state/ca`, so the sandbox image is
built once rather than per run.

The runner sends the case's stages, waits for each turn, and applies the variant at the `break`
stage:

| Variant | At `break` |
|---|---|
| `rollover` | sends the case's `fill` messages until a new context starts |
| `restart` | stops Swan and starts it again on the same home |
| `newConversation` | starts a new conversation on the same persona (memory kept; `/dream` first if the config says so) |

Approvals are scripted: the persona allows every tool call, and a request to a host outside the
case's `network` list is refused. Checks run afterwards; a `command` check runs in a throwaway
container with no network, never on the host. Each run's directory keeps its transcripts, memory,
network log, usage and Swan log.

## Spending

`cap` in a campaign is a hard limit in dollars across the whole campaign. The runner adds up Swan's
own usage log while turns run and interrupts as soon as the cap is reached. A model without a price
stops the campaign unless its config sets `allowUnpriced` (scripted and local models). Open models
get a price under `providers.<name>.models.<id>.price` in the campaign, from the live price of the
pinned host.

## Results

`summary.md` groups runs by variant (memory) or tier (cost) and configuration: pass rate with a
95% interval, errors (harness or environment, kept out of the pass rate), total cost, cost per
success (all spend divided by passes), the share spent on checkpoints and dreaming, tokens,
rollovers and time. A config's `contextTokens` applies to rollover runs only, to force a rollover
(a labelled local variant); the other variants run on the model's real context window.

## Writing a case

See `cases/`. A case names its suite and tier, a workspace from `fixtures/`, the variants it runs,
its stages and its checks (`file`, `command`, `reply`, `toolCalls`, `memory`, `egress`). A `command`
check can `include` a directory from `gold/` (hidden tests, original files): it is copied to
`.gold/` in the check's container only, never into the agent's workspace. Each fixture with hidden
checks has an oracle test (`src/fixtures.test.ts`): the shipped workspace fails them and the
reference solution passes. `fake` holds
scripts for the dry run's scripted model, keyed by a phrase from the user's message; they only prove
the plumbing and say nothing about model quality. Keep facts the agent must remember out of the
workspace files, so a check measures memory rather than reading.
