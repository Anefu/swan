"""Swan's context checkpoint, ported from Swan (apps/server/src/agent/session.ts, rollover()) so that
Compact-Bench can score it beside the five production compaction prompts.

Variants:
  swan-full     the full structured checkpoint, plus the last 24 events (up to 16,000 characters)
  swan-minimal  the small continuity checkpoint, plus the last 6 events (up to 4,000 characters)

As in Swan, the checkpoint request has its own system prompt, runs at low effort without prompt
caching, is retried once when the reply is not a usable checkpoint, and falls back to carrying the
recent events alone. The transcript uses Swan's own event lines (tool output cut to 1,200 characters
around the middle, the whole transcript to 150,000).

One deliberate difference: Swan ends the carried text by pointing the agent at history_search and
history_read. Compact-Bench's continuation agent has no history tools (for any method), so that
sentence is left out.
"""
import json
import re
import urllib.request

import cb_common as C

SYSTEM = "You write checkpoints that let an agent continue a long task in a fresh context. Output only one JSON object, no prose."
ASK = {
    "swan-full": 'Write the checkpoint for ALL unfinished work as JSON with exactly these keys: "objective" (the user\'s goal and acceptance criteria), "constraints" (explicit user constraints, verbatim where possible), "decisions" (with rationale), "completed" (work done, with file paths/artifacts), "failures" (what failed and test evidence), "openQuestions", "nextAction" (one concrete next step), "sources" (event ids that support the above). Arrays of strings except objective and nextAction.',
    "swan-minimal": 'Write a SMALL continuity checkpoint as JSON with exactly these keys: "objective" (the active goal), "constraints" (explicit user constraints, verbatim), "openQuestions" (unfinished work, one line each), "completed" (artifact references only: file paths, commits, URLs), "nextAction" (one concrete next step), "sources" (event ids to retrieve for details). Do not summarise rationale, attempts or tool output: the agent will retrieve those from history. Arrays of strings except objective and nextAction.',
}
STRATEGIES = tuple(ASK)
# Events carried after the checkpoint: count and character budget (Swan's values at a 200k context).
TAIL = {"swan-full": (24, 16_000), "swan-minimal": (6, 4_000)}
TRANSCRIPT_CAP = 150_000
MAX_TOKENS = 16_000
# Swan sends adaptive thinking and an effort level only to models on the current API surface.
MODERN = re.compile(r"^claude-(fable|mythos|opus|sonnet|haiku)-(5|4-[6-9])")


def truncate_middle(s, max_chars):
    if len(s) <= max_chars:
        return s
    head = int(max_chars * 0.4)
    tail = max_chars - head
    return f"{s[:head]}\n\n… [{len(s) - head - tail} characters truncated] …\n\n{s[-tail:]}"


def _text(content):
    if isinstance(content, str):
        return content
    if isinstance(content, list):
        return "\n".join(p.get("text", "") for p in content if isinstance(p, dict) and p.get("type") == "text")
    return ""


def _preview(value):
    return re.sub(r"\s+", " ", json.dumps(value, ensure_ascii=False))[:200]


def event_lines(H):
    """Swan's itemLine() for a Messages history: one event per user or assistant text, and one per
    tool call with its status and output. Ids are e1, e2, ... in order."""
    events = []
    pending = {}

    def add(line):
        events.append(f"[e{len(events) + 1}] {line}")

    for m in H:
        role = m.get("role", "user")
        content = m.get("content")
        parts = content if isinstance(content, list) else [{"type": "text", "text": content or ""}]
        for p in parts:
            if not isinstance(p, dict):
                continue
            t = p.get("type")
            if t == "text" and p.get("text", "").strip():
                add(f"{'User' if role == 'user' else 'Assistant'}: {p['text']}")
            elif t == "tool_use":
                pending[p.get("id")] = (p.get("name", "tool"), _preview(p.get("input", {})))
            elif t == "tool_result":
                name, preview = pending.pop(p.get("tool_use_id"), ("tool", ""))
                out = p.get("content")
                out = out if isinstance(out, str) else _text(out) or json.dumps(out, ensure_ascii=False)
                status = "error" if p.get("is_error") else "done"
                add(f"Tool {name} → {status}: {preview}" + (f"\n{truncate_middle(out, 1200)}" if out else ""))
    for name, preview in pending.values():
        add(f"Tool {name} → running: {preview}")
    return events


def _request(model, user, key):
    body = {"model": model, "max_tokens": MAX_TOKENS, "system": SYSTEM, "messages": [{"role": "user", "content": user}]}
    if MODERN.match(model):
        body["thinking"] = {"type": "adaptive"}
        body["output_config"] = {"effort": "low"}
    req = urllib.request.Request(
        C.MESSAGES_URL,
        data=json.dumps(body).encode(),
        headers={"x-api-key": key, "anthropic-version": "2023-06-01", "Content-Type": "application/json"},
    )
    d = C.post_with_retry(req)
    return "".join(p.get("text", "") for p in d.get("content") or [] if p.get("type") == "text")


def _parse(text):
    a, b = text.find("{"), text.rfind("}")
    if a < 0 or b <= a:
        return None
    try:
        j = json.loads(text[a : b + 1])
    except json.JSONDecodeError:
        return None
    return j if isinstance(j, dict) else None


def _strs(v):
    return [x for x in v if isinstance(x, str)] if isinstance(v, list) else []


def render(cp, tail, reason="context limit reached"):
    """The text Swan carries into the new context."""
    parts = [f"[Carried over from earlier in this conversation — context 2 starts here ({reason}).]"]
    if cp:
        def listed(h, xs):
            return f"{h}:\n" + "\n".join(f"- {x}" for x in xs) if xs else ""

        parts += [
            "## Checkpoint",
            f"Objective: {cp['objective']}",
            listed("Constraints", cp["constraints"]),
            listed("Decisions", cp["decisions"]),
            listed("Completed", cp["completed"]),
            listed("Failures", cp["failures"]),
            listed("Open questions", cp["openQuestions"]),
            f"Next action: {cp['nextAction']}",
            f"Sources: {', '.join(cp['sources'])}" if cp["sources"] else "",
        ]
    parts += ["## Most recent events", tail, "[End of carried-over context.]"]
    return "\n\n".join(p for p in parts if p)


def checkpoint(H, model, variant, key, call=_request):
    """Swan's rollover for one history: the checkpoint (or none, after two unusable replies) and the
    most recent events, rendered as the carried text."""
    events = event_lines(H)
    transcript = truncate_middle("\n\n".join(events), TRANSCRIPT_CAP)
    user = f"Previous checkpoint (may be null):\nnull\n\nEvents since then (ids in brackets):\n{transcript}\n\n{ASK[variant]}"
    ids = {f"e{i + 1}" for i in range(len(events))}
    cp = None
    for _ in range(2):
        j = _parse(call(model, user, key))
        if j and isinstance(j.get("objective"), str) and isinstance(j.get("nextAction"), str):
            cp = {
                "objective": j["objective"],
                "constraints": _strs(j.get("constraints")),
                "decisions": _strs(j.get("decisions")),
                "completed": _strs(j.get("completed")),
                "failures": _strs(j.get("failures")),
                "openQuestions": _strs(j.get("openQuestions")),
                "nextAction": j["nextAction"],
                "sources": [s for s in _strs(j.get("sources")) if s in ids],
            }
            break
    n, cap = TAIL[variant]
    tail = truncate_middle("\n\n".join(events[-n:]), cap)
    return render(cp, tail)
