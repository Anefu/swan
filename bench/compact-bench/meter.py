#!/usr/bin/env python3
"""Usage meter and hard spending cap for Compact-Bench runs.

Compact-Bench neither records token usage nor limits spend. This runs a local Messages endpoint
that forwards each request to the real one, records the response's token usage and estimated cost,
and refuses further requests once the cap is reached. It then runs the command after `--` with
CB_MESSAGES_URL pointing at itself, and prints the totals when it ends.

    python scripts/meter.py --cap 4 --log results/usage.jsonl -- python run.py --track task ...

Prices are list prices (USD per million tokens) for the models Swan benchmarks; a request for any
other model is refused rather than counted as free. API keys pass through and are never logged.
"""
import argparse
import json
import os
import subprocess
import sys
import threading
import time
import urllib.error
import urllib.request
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

# input, output, cache read, cache write (5-minute). Haiku 5.5 doubles past 100K-token prompts;
# Compact-Bench prompts stay under that (histories cap at 250,000 characters).
RATES = {
    "claude-opus-5-5": (4.0, 20.0, 0.2, 5.0),
    "claude-sonnet-5-5": (2.0, 10.0, 0.2, 2.5),
    "claude-haiku-5-5": (0.1, 0.5, 0.01, 0.125),
}
FORWARD_HEADERS = ("x-api-key", "anthropic-version", "anthropic-beta", "content-type")


def cost(model, usage):
    r = RATES[model]
    return (
        usage.get("input_tokens", 0) * r[0]
        + usage.get("output_tokens", 0) * r[1]
        + (usage.get("cache_read_input_tokens") or 0) * r[2]
        + (usage.get("cache_creation_input_tokens") or 0) * r[3]
    ) / 1e6


class Meter:
    def __init__(self, upstream, cap, log_path):
        self.upstream, self.cap, self.log_path = upstream, cap, log_path
        self.spent, self.requests, self.by = 0.0, 0, {}
        self.lock = threading.Lock()

    def record(self, model, kind, usage):
        c = cost(model, usage)
        with self.lock:
            self.spent += c
            self.requests += 1
            key = f"{kind} · {model}"
            n, s = self.by.get(key, (0, 0.0))
            self.by[key] = (n + 1, s + c)
            with open(self.log_path, "a", encoding="utf-8") as f:
                f.write(json.dumps({"ts": time.time(), "model": model, "kind": kind, "usage": usage, "cost_usd": c}) + "\n")
            if self.requests % 10 == 0:
                print(f"[meter] {self.requests} requests, ${self.spent:.3f} of ${self.cap:.2f}", file=sys.stderr, flush=True)

    def handler(self):
        meter = self

        class Handler(BaseHTTPRequestHandler):
            def log_message(self, *a):
                pass

            def reply(self, status, body, ctype="application/json"):
                self.send_response(status)
                self.send_header("Content-Type", ctype)
                self.send_header("Content-Length", str(len(body)))
                self.end_headers()
                self.wfile.write(body)

            def refuse(self, message):
                self.reply(400, json.dumps({"type": "error", "error": {"type": "invalid_request_error", "message": message}}).encode())

            def do_POST(self):
                body = self.rfile.read(int(self.headers.get("Content-Length", 0)))
                try:
                    req = json.loads(body)
                except json.JSONDecodeError:
                    return self.refuse("meter: request body is not JSON")
                model = req.get("model", "")
                if model not in RATES:
                    return self.refuse(f"meter: no price for {model!r}; refusing rather than counting it as free")
                with meter.lock:
                    if meter.spent >= meter.cap:
                        return self.refuse(f"meter: spending cap of ${meter.cap:.2f} reached (${meter.spent:.2f} spent)")
                headers = {h: self.headers[h] for h in FORWARD_HEADERS if self.headers.get(h)}
                upstream = urllib.request.Request(meter.upstream, data=body, headers=headers, method="POST")
                try:
                    with urllib.request.urlopen(upstream, timeout=300) as r:
                        data, status, ctype = r.read(), r.status, r.headers.get("Content-Type", "application/json")
                except urllib.error.HTTPError as e:
                    return self.reply(e.code, e.read() or b"{}", e.headers.get("Content-Type", "application/json"))
                except Exception as e:  # network failure: let the harness retry
                    return self.reply(502, json.dumps({"type": "error", "error": {"type": "api_error", "message": f"meter: {e}"}}).encode())
                try:
                    usage = json.loads(data).get("usage") or {}
                except json.JSONDecodeError:
                    usage = {}
                meter.record(model, "agent" if req.get("tools") else "summary", usage)
                self.reply(status, data, ctype)

        return Handler

    def serve(self, port=0):
        server = ThreadingHTTPServer(("127.0.0.1", port), self.handler())
        threading.Thread(target=server.serve_forever, daemon=True).start()
        return server

    def summary(self):
        lines = [f"[meter] {self.requests} requests, ${self.spent:.3f} spent (cap ${self.cap:.2f})"]
        lines += [f"[meter]   {k}: {n} requests, ${s:.3f}" for k, (n, s) in sorted(self.by.items())]
        return "\n".join(lines)


def main(argv=None):
    argv = sys.argv[1:] if argv is None else argv
    if "--" not in argv:
        print("usage: meter.py --cap USD --log FILE -- command ...", file=sys.stderr)
        return 2
    i = argv.index("--")
    ap = argparse.ArgumentParser()
    ap.add_argument("--cap", type=float, required=True)
    ap.add_argument("--log", required=True)
    args = ap.parse_args(argv[:i])
    upstream = os.environ.get("CB_MESSAGES_URL", "https://api.anthropic.com/v1/messages")
    meter = Meter(upstream, args.cap, args.log)
    server = meter.serve()
    env = dict(os.environ, CB_MESSAGES_URL=f"http://127.0.0.1:{server.server_address[1]}/v1/messages")
    try:
        code = subprocess.run(argv[i + 1 :], env=env).returncode
    finally:
        server.shutdown()
        print(meter.summary(), file=sys.stderr, flush=True)
    return code


if __name__ == "__main__":
    sys.exit(main())
