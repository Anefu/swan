# Demo workspace

A tiny project for trying persona-harness. The `demo` persona mounts this folder read-write at
`/workspace/demo`; nothing else on your machine is visible to the agent.

Try asking the agent:
- "Give me a tour of this repo" (uses the repo-tour skill)
- "Add a --shout flag to greet.py and test it"
- "curl https://example.com" (blocked by the egress allowlist — check the Network tab)
