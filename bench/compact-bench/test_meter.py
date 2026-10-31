"""The usage meter: forwards, prices, caps. No real API calls."""
import json
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
import sys
import tempfile
import threading
import unittest
import urllib.error
import urllib.request

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "scripts"))
import meter as M


def upstream(status=200, usage=None):
    seen = []

    class H(BaseHTTPRequestHandler):
        def log_message(self, *a):
            pass

        def do_POST(self):
            seen.append({k.lower(): v for k, v in self.headers.items()})
            self.rfile.read(int(self.headers.get("Content-Length", 0)))
            body = json.dumps({"content": [{"type": "text", "text": "ok"}], "usage": usage or {"input_tokens": 1_000_000, "output_tokens": 100_000}}).encode()
            self.send_response(status)
            self.send_header("Content-Type", "application/json")
            self.send_header("Content-Length", str(len(body)))
            self.end_headers()
            self.wfile.write(body)

    s = ThreadingHTTPServer(("127.0.0.1", 0), H)
    threading.Thread(target=s.serve_forever, daemon=True).start()
    return s, seen


def post(url, model, tools=False):
    body = {"model": model, "max_tokens": 10, "messages": [{"role": "user", "content": "hi"}]}
    if tools:
        body["tools"] = [{"name": "t", "input_schema": {"type": "object"}}]
    req = urllib.request.Request(url, data=json.dumps(body).encode(), headers={"x-api-key": "secret-key", "anthropic-version": "2023-06-01", "Content-Type": "application/json"})
    try:
        with urllib.request.urlopen(req) as r:
            return r.status, json.loads(r.read())
    except urllib.error.HTTPError as e:
        return e.code, json.loads(e.read())


class MeterTest(unittest.TestCase):
    def setUp(self):
        self.log = tempfile.NamedTemporaryFile(suffix=".jsonl", delete=False).name
        Path(self.log).write_text("")

    def start(self, cap, status=200):
        up, self.seen = upstream(status)
        self.addCleanup(up.shutdown)
        self.meter = M.Meter(f"http://127.0.0.1:{up.server_address[1]}/v1/messages", cap, self.log)
        server = self.meter.serve()
        self.addCleanup(server.shutdown)
        return f"http://127.0.0.1:{server.server_address[1]}/v1/messages"

    def test_forwards_and_prices_each_response(self):
        url = self.start(cap=10)
        self.assertEqual(post(url, "claude-sonnet-5-5", tools=True)[0], 200)
        self.assertEqual(self.seen[0]["x-api-key"], "secret-key")
        self.assertAlmostEqual(self.meter.spent, 3.0)  # 1M input at $2 + 100K output at $10
        line = json.loads(Path(self.log).read_text().splitlines()[0])
        self.assertEqual((line["kind"], line["model"]), ("agent", "claude-sonnet-5-5"))
        self.assertNotIn("secret-key", Path(self.log).read_text())

    def test_refuses_models_without_a_price(self):
        url = self.start(cap=10)
        status, body = post(url, "kimi-k3")
        self.assertEqual(status, 400)
        self.assertIn("no price", body["error"]["message"])
        self.assertEqual(self.seen, [])

    def test_stops_at_the_cap(self):
        url = self.start(cap=5)
        self.assertEqual(post(url, "claude-sonnet-5-5")[0], 200)  # $3
        self.assertEqual(post(url, "claude-sonnet-5-5")[0], 200)  # $6: over the cap after this one
        status, body = post(url, "claude-sonnet-5-5")
        self.assertEqual(status, 400)
        self.assertIn("spending cap", body["error"]["message"])
        self.assertEqual(len(self.seen), 2)

    def test_counts_spend_already_in_the_log_toward_the_cap(self):
        Path(self.log).write_text(json.dumps({"model": "claude-sonnet-5-5", "kind": "agent", "cost_usd": 4.5}) + "\n")
        url = self.start(cap=5)
        self.assertAlmostEqual(self.meter.spent, 4.5)
        self.assertEqual(post(url, "claude-sonnet-5-5")[0], 200)  # $7.50 now: over the cap
        self.assertEqual(post(url, "claude-sonnet-5-5")[0], 400)
        self.assertEqual(len(self.seen), 1)

    def test_passes_upstream_errors_through_for_the_harness_to_retry(self):
        url = self.start(cap=5, status=429)
        self.assertEqual(post(url, "claude-haiku-5-5")[0], 429)
        self.assertEqual(self.meter.requests, 0)


if __name__ == "__main__":
    unittest.main()
