"""Swan's checkpoint port: event lines, request shape, rendering and fallback. No model calls."""
import json
import os
from pathlib import Path
import sys
import unittest
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "harness"))
import swan_checkpoint as SC

H = [
    {"role": "user", "content": "Fix the failing date parser. Keep the public API unchanged."},
    {"role": "assistant", "content": [
        {"type": "text", "text": "Looking at the parser."},
        {"type": "tool_use", "id": "t1", "name": "run_command", "input": {"command": "pytest -q tests/test_dates.py"}},
    ]},
    {"role": "user", "content": [{"type": "tool_result", "tool_use_id": "t1", "content": "1 failed: test_iso_week " + "x" * 3000}]},
    {"role": "assistant", "content": [{"type": "tool_use", "id": "t2", "name": "read_file", "input": {"file_path": "src/dates.py"}}]},
]

GOOD = json.dumps({
    "objective": "Fix the date parser so tests pass",
    "constraints": ["Keep the public API unchanged."],
    "decisions": [],
    "completed": [],
    "failures": ["test_iso_week fails"],
    "openQuestions": ["Why ISO weeks are off by one"],
    "nextAction": "Read src/dates.py",
    "sources": ["e1", "e99"],
})


class EventLines(unittest.TestCase):
    def test_one_event_per_text_and_per_tool_call(self):
        lines = SC.event_lines(H)
        self.assertEqual(lines[0], "[e1] User: Fix the failing date parser. Keep the public API unchanged.")
        self.assertEqual(lines[1], "[e2] Assistant: Looking at the parser.")
        self.assertTrue(lines[2].startswith('[e3] Tool run_command → done: {"command": "pytest -q tests/test_dates.py"}\n1 failed'))
        self.assertIn("characters truncated", lines[2])  # output cut to 1,200 characters, as in Swan
        self.assertTrue(lines[3].startswith("[e4] Tool read_file → running:"))


class Checkpoint(unittest.TestCase):
    def test_request_uses_swan_system_prompt_and_low_effort_for_current_claude_models(self):
        sent = []

        def fake_post(req):
            sent.append(json.loads(req.data))
            return {"content": [{"type": "text", "text": GOOD}]}

        with patch.object(SC.C, "post_with_retry", fake_post):
            SC.checkpoint(H, "claude-haiku-5-5", "swan-minimal", "key")
            SC.checkpoint(H, "kimi-k3", "swan-minimal", "key")
        self.assertEqual(sent[0]["system"], SC.SYSTEM)
        self.assertEqual(sent[0]["output_config"], {"effort": "low"})
        self.assertIn("Previous checkpoint (may be null):\nnull", sent[0]["messages"][0]["content"])
        self.assertTrue(sent[0]["messages"][0]["content"].endswith(SC.ASK["swan-minimal"]))
        self.assertNotIn("output_config", sent[1])
        self.assertNotIn("thinking", sent[1])

    def test_renders_the_checkpoint_and_recent_events(self):
        S = SC.checkpoint(H, "claude-sonnet-5-5", "swan-full", "key", call=lambda *a: "Here it is: " + GOOD)
        self.assertIn("## Checkpoint", S)
        self.assertIn("Constraints:\n- Keep the public API unchanged.", S)
        self.assertIn("Sources: e1", S)
        self.assertNotIn("e99", S)  # sources must name real events
        self.assertNotIn("Decisions:", S)  # empty lists are left out
        self.assertIn("## Most recent events", S)
        self.assertIn("[e4] Tool read_file", S)
        self.assertNotIn("history_search", S)

    def test_minimal_carries_fewer_recent_events(self):
        long_h = [{"role": "user", "content": f"step {i}"} for i in range(40)]
        full = SC.checkpoint(long_h, "m", "swan-full", "k", call=lambda *a: GOOD)
        minimal = SC.checkpoint(long_h, "m", "swan-minimal", "k", call=lambda *a: GOOD)
        self.assertIn("[e17] User: step 16", full)  # last 24 of 40
        self.assertNotIn("[e16] User: step 15", full)
        self.assertIn("[e35] User: step 34", minimal)  # last 6 of 40
        self.assertNotIn("[e34] User: step 33", minimal)

    def test_retries_once_then_carries_recent_events_alone(self):
        calls = []

        def bad(*a):
            calls.append(1)
            return "not json"

        S = SC.checkpoint(H, "m", "swan-full", "k", call=bad)
        self.assertEqual(len(calls), 2)
        self.assertNotIn("## Checkpoint", S)
        self.assertIn("## Most recent events", S)


class Wiring(unittest.TestCase):
    def test_variants_reach_both_tracks(self):
        import e1_xb
        import e2_score
        self.assertIn("swan-full", e2_score.VARIANTS)
        self.assertIn("swan-minimal", e2_score.ORDER)
        with patch.object(SC, "checkpoint", return_value="S") as cp, patch.dict(os.environ, {"CB_API_KEY": "test"}):
            self.assertEqual(e1_xb.compress_x(H, "m", "swan-minimal"), "S")
            r = e2_score.compress_one(("s1", "cli", H, [{"value": "S"}], "swan-full", "m"))
        self.assertEqual(cp.call_count, 2)
        self.assertEqual(r["recall"], 1.0)


if __name__ == "__main__":
    unittest.main()
