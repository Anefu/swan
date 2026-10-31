# Swan on Compact-Bench

[Compact-Bench](https://github.com/cai-jianfeng/compact-bench) (Apache-2.0) measures what context
compaction costs coding agents. It has three tracks:

- **Task track:** a frozen half-finished repository fix is condensed, a fixed agent finishes it from
  the summary alone, and the repository's tests decide. Results are compared with the same
  continuation from the full history.
- **Retention:** how many concrete details (paths, errors, commits) a summary keeps from long
  real sessions.
- **Production:** retention across recorded compactions.

This folder adds Swan's checkpoint as two more summary methods beside the five production prompts
(Claude Code, Codex, OpenCode, Gemini CLI, Kimi Code):

| Method | What it carries |
|---|---|
| `swan-full` | Swan's full structured checkpoint, plus the last 24 events (up to 16,000 characters) |
| `swan-minimal` | Swan's small continuity checkpoint, plus the last 6 events (up to 4,000 characters) |

`swan_checkpoint.py` is a port of Swan's rollover (`apps/server/src/agent/session.ts`): the same
prompts, event lines, low effort, retry and carried text. The one deliberate difference is that
Swan's pointer to `history_search` is left out, because the continuation agent has no history tools.
`bench/src/compact-bench.test.ts` fails if the prompts or limits in `session.ts` change without this
port.

## Set up (no API calls)

```bash
bench/compact-bench/setup.sh            # clones upstream at 9dd9a3f into ~/.swan-bench/compact-bench,
                                        # applies swan.patch and builds localhost/compact-bench:9dd9a3f-swan
```

`swan.patch` wires the two methods into the task and retention tracks, and adds `--variants` so
retention runs only the methods you name (upstream always runs all five).

## Run

**Only inside the container.** The continuation agent runs model-chosen shell commands in the task
repository, and its allowlist checks only the first word of a command. Use a separate API key with
a spend limit (an Anthropic Console workspace for benchmarks), in an `.env` file:

```
CB_API_KEY=...                         # the benchmark key, never your main one
CB_MESSAGES_URL=https://api.anthropic.com/v1/messages
CB_AGENT_MODEL=claude-sonnet-5-5       # the fixed continuation agent
```

Compact-Bench has no spending limit and records no token usage, so every paid run goes through
`meter.py`. It forwards each request to the Messages API, logs tokens and estimated cost to a JSONL
file, refuses models without a price, and refuses everything once the cap is reached:

```bash
B=~/.swan-bench/compact-bench
podman run --rm --env-file $B/.env -v $B/data:/bench/data -v $B/results:/bench/results -v $B/work:/bench/work \
  --entrypoint python localhost/compact-bench:9dd9a3f-swan \
  scripts/meter.py --cap 4 --log /bench/results/usage.jsonl -- \
  python run.py --track task --prompt swan-minimal --model claude-haiku-5-5 --limit 5
```

`--model` is the model that writes the summary; `CB_AGENT_MODEL` continues from it. Run a method per
`--prompt`; the full-history baseline is computed once per agent model and reused. Retention:
`--track retention --variants swan-full,swan-minimal,claude --model <summarizer> --limit 40`.

No-API checks: `--track production`, `--track retention --baseline-only`, and the tests
(`python -m unittest discover -s tests` in the image, with a copy of the folder mounted).

## Cost (estimates, Sonnet 5.5 as the continuation agent)

| Run | Estimate |
|---|---|
| Task track, 5 tasks, one method | ~$3 |
| Task track, all 35 tasks, four methods | ~$36 (about $12 for the full-history baseline, $6 per method) |
| Retention, 40 sessions, three methods | ~$14 with Sonnet summaries, under $1 with Haiku |

Histories are 13–53 KB per task (median 28 KB); continuations stop after 8 steps.

## Validated (2026-10-31, no model calls)

- Upstream tests and the Swan port's tests: 16 passing, in the container, without network.
- Production track and the retention reference ran end to end; data downloads from Hugging Face.
- Task environment: for `pylint-dev__pylint-6903`, the unfixed repository fails its target test and
  the reference patch makes it pass.
