# Design: tracker, watchers, schedules and unattended runs

Status: built in 0.2.0, except: the Settings editors for triggers and unattended runs (use the YAML), presets in the UI (examples in the README), "Allow once and continue" on refused actions, and `conversation:` on triggers (waits for several conversations per persona).

Three pieces that work together:

1. **Tracker**: the work items a persona's agent creates or touches (MRs, tickets, docs, deploys), with their status.
2. **Triggers**: watchers (something new appeared) and schedules (it is 9:00 on a weekday) that start a turn without you.
3. **Unattended rules**: what a turn may do when nobody is there to answer a card.

A persona works fully without any of them. Each persona has its own tracker and its own triggers.

## 1. Tracker

### What the agent sees

A new tool, `track`, always available (like the memory tools; it needs no sandbox and no approval):

```
track({ url, title?, kind?, status?, note? })
```

- `url` identifies the item. Calling `track` again with the same URL updates it.
- `kind` is free text: `mr`, `ticket`, `doc`, `deploy`, anything. Known kinds get an icon; others a plain one.
- `status`: `in_progress` (default for a new item), `waiting` (on a review or on someone else), `done`, `dropped`.
- `note`: one line on where it stands ("2 review comments open", "blocked on infra").

The system prompt asks the agent to track what it creates or is asked to follow, and to keep statuses current. It may mark items done on its own. If you want a gate, tell the persona ("mark MRs done only once they are merged") in its instructions; Swan doesn't enforce one.

A second tool, `tracker_list`, returns the persona's open items, so a fresh context (or a watcher turn) can pick up where things are.

### Storage

`~/.swan/tracker/<persona>.yaml`, readable and editable by hand, validated with zod on load:

```yaml
items:
  - url: https://gitlab.example.com/platform/api/-/merge_requests/482
    title: Rotate the ingress certificates
    kind: mr
    status: waiting
    note: Waiting for review from @sam
    created: 2026-11-03T09:12:00Z
    updated: 2026-11-03T14:40:00Z
    conversation: <id of the conversation item where it was registered>
    history:
      - { at: 2026-11-03T09:12:00Z, status: in_progress, by: agent }
      - { at: 2026-11-03T14:40:00Z, status: waiting, by: agent }
```

Exported personas don't carry their tracker. Deleting a persona deletes it.

### What you see

- **Overview card**: "Tracker · 3 in progress, 1 waiting". Opens the Tracker pane.
- **Tracker pane** (in the rail, like Memory): items grouped In progress, Waiting, Done (last 14 days, then folded away), Dropped (folded). Each row: kind icon, title as a link (opens in the browser), note, "updated 2 h ago", and a menu to change the status, jump to where it was registered in the conversation, or remove it.
- **In the conversation**: a `track` call shows as a compact line ("Tracking MR !482 · waiting"), not a tool card.
- You can add an item yourself (URL + title) from the pane, e.g. a ticket you want the persona to follow.

## 2. Triggers

### Watchers

A watcher polls an HTTP API **through the persona's own connection and rules**, finds items it hasn't seen, and starts a turn about them. It knows nothing about GitLab or Jira; presets fill in its fields.

```yaml
# in the persona's YAML
watchers:
  - name: assigned-tickets
    every: 5m
    get: https://jira.example.com/rest/api/3/search?jql=assignee%3DcurrentUser()%20AND%20statusCategory%3D%22To%20Do%22&fields=summary,updated
    items: issues            # where the list is in the JSON response ("" for the top level)
    id: key                  # the field that identifies an item
    changed: fields.updated  # optional: a changed value triggers again
    prompt: |
      A Jira ticket was assigned to you: {{item.key}} "{{item.fields.summary}}".
      Read it, track it, and say how you would approach it. Don't start the work.

  - name: mr-comments
    every: 2m
    forEach: { tracker: { kind: mr, status: [in_progress, waiting] } }
    get: "{{gitlabApi tracker.url}}/notes?sort=desc&per_page=50"
    items: ""
    id: id
    skip: { system: true }   # optional: ignore items whose fields match
    prompt: |
      New comment on {{tracker.title}} ({{tracker.url}}) from {{item.author.username}}:
      {{item.body}}
      Address it if it asks for a change, or reply. Update the tracker.
```

How it works:

- **Requests** go through the egress proxy exactly like the agent's own: the persona's allowed hosts, its credential rules (the request must be allowed, not asked or denied), placeholders swapped for the real value on the host. Watchers can only make GET requests. Neither the watcher definition nor the turn ever sees a token.
- **New or changed**: Swan stores the ids (and `changed` values) it has seen per watcher in `~/.swan/watchers/<persona>.yaml`. The first poll only records what's there; it doesn't trigger on the backlog.
- **forEach tracker**: the watcher runs once per matching tracker item, with `{{tracker.*}}` available. When the item is done or dropped, polling for it stops. This is how an MR the agent opened gets its review comments back to it with no setup per MR.
- **Templates** are plain `{{path}}` lookups, plus a few named helpers for URL shapes that need converting (`gitlabApi` turns an MR page URL into its API URL; `githubApi` likewise). No expressions, no code.
- **Batching**: several new items in one poll start one turn, listing them all (up to 20; the rest are summarised).
- **Timing**: `every` is 1 minute at least. A failed poll backs off (2×, up to 1 hour) and shows on the watcher's status; three failures in a row raise a notice in the app. Polling pauses while Swan isn't running; on start, it resumes and catches up with one poll per watcher.
- **When the persona is busy**: the turn is queued and starts when the current one ends. One queued turn per watcher at most; later triggers are merged into it.

**Presets** (in the UI, "Add watcher"): GitLab MR comments, GitHub PR reviews and comments, Jira assigned to me, Jira comments on tracked tickets. Choosing one fills in the fields, which stay visible and editable. Presets are data shipped with Swan, not code paths.

**Escape hatch**: a watcher can use `run: [script, args]` instead of `get`. The command runs in the persona's sandbox (same image, folders and proxy) and prints one JSON object per line; `id`/`changed` then apply to those objects. For anything a single GET can't express.

### Schedules

```yaml
schedules:
  - name: morning
    at: "09:00"
    days: [mon, tue, wed, thu, fri]
    prompt: Check the tracker. For each open item, see where it stands and update it. Then summarise what needs me today.
```

`at` + `days` (local time), or `every: 1h`. A schedule missed while the Mac was asleep or Swan was closed runs once on start if it was missed by less than 2 hours, otherwise it's skipped and noted.

### Where triggered turns go

Each persona has one conversation today. Triggered turns run there, starting with a marker ("Watcher assigned-tickets · 2 new"), so you see them in context.

Once **several conversations per persona** lands (next on the roadmap), a watcher or schedule can say `conversation: new` (a fresh conversation per trigger, titled from it) or `conversation: <name>` (a standing one, e.g. "Reviews"). That is the better home for most triggers; this design works with either.

## 3. Unattended rules

A triggered turn has nobody to answer a card. Today every `ask` would just wait. Instead:

```yaml
unattended:
  # What a triggered turn may do. Anything that would ask is denied, and the agent is told so.
  permissions:
    allow: [read, "bash(git *)", "bash(glab mr note *)"]
  # Credential rules that would ask are denied unless listed here.
  credentials:
    gitlab/GITLAB_TOKEN: { allow: ["POST /api/v4/projects/*/merge_requests/*/notes"] }
  network: deny-new        # a host not already allowed is refused, never offered
```

- In a triggered turn, every check runs as normal, and where the result would be **ask**, Swan looks at `unattended`: allowed there means allowed; otherwise denied with a message the agent sees ("not allowed in an unattended run; leave it for the user"). Nothing becomes more permissive than the persona's normal rules: a `deny` stays a deny.
- Without an `unattended` block, triggered turns can only do what the persona already allows without asking.
- When you come back, the conversation shows what was denied in each triggered turn, with a button to allow it once and continue, so the work isn't lost.
- The agent's system prompt in a triggered turn says it is unattended and that text from watched items (comments, ticket descriptions) is untrusted input: data to act on, not instructions that widen what it does.

## Safety

- **Untrusted input.** Comments and tickets can contain anything, including instructions aimed at the agent. Watcher turns therefore run under the unattended rules: no new hosts, no asking-type credential use, no commands outside the unattended allow list. The worst a malicious comment can do is limited to what you allowed for unattended runs.
- **Credentials.** Watcher polls are proxied requests under the persona's credential rules (GET only); invariants 1–4 apply unchanged. A watcher URL on a host with no matching credential just goes out without one.
- **Cost.** A chatty watcher could start many turns. Per persona: at most 30 triggered turns a day by default (`unattended.maxTurnsPerDay`), after which triggers are recorded but don't start turns, with a notice. Usage shows triggered turns separately.
- **Visibility.** The Overview shows each watcher and schedule with its last run, next run, last error, and a pause switch. Pausing a persona's triggers is one click.

## UI summary

- Overview: Tracker card; Triggers card ("2 watchers, 1 schedule · next 09:00").
- Tracker pane: described above.
- Settings → **Triggers**: list of watchers and schedules; Add watcher (presets or blank), Add schedule; each with a "Test" button that runs one poll and shows what it would trigger, without starting a turn.
- Settings → **Unattended runs**: the allow lists above, in the same editors as Permissions and credential rules.

## Build order

1. Tracker (tool, file, pane, Overview card). Useful alone.
2. Unattended rules and the triggered-turn plumbing (queue, marker, denied-in-unattended handling), with schedules as the first trigger since they're the simplest.
3. Watchers: `get` source with tracker `forEach`, presets, Test button.
4. `run` source.
5. After several conversations per persona: `conversation:` on triggers.

## Open questions

1. Should `done` items be removed from the tracker file after some time (say 90 days), or kept?
2. Daily cap: 30 triggered turns per persona a sensible default?
3. For a missed schedule, is "run once if missed by under 2 hours" right, or always run once on start?
