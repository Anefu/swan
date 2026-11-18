import type { ToolDef } from "./tools.js";

/**
 * Commands in the sandbox call Swan's tools at this name through the session's own egress proxy,
 * which knows the session from its proxy credentials. `.internal` is reserved for private use, so
 * it never reaches the internet.
 */
export const TOOL_HOST = "tools.swan.internal";
export const SWAN_TOOL_PATH = "/home/agent/.swan/bin/swan-tool";

/** Tools a script can't call: the shell it runs in, and what only the agent itself can do. */
export const NOT_FROM_SCRIPTS = new Set(["bash", "ask_user", "ask_parent", "agent", "agent_message", "agent_status", "agent_stop"]);

/** What a script may call, of the tools the bash call that runs it could. */
export const scriptable = (t: ToolDef) => !NOT_FROM_SCRIPTS.has(t.name);

/** One line per tool for `swan-tool --list`: the description's first sentence. */
export function toolList(tools: ToolDef[]): string {
  const first = (d: string) => (/^(.*?[.!?])(\s|$)/s.exec(d)?.[1] ?? d).replace(/\s+/g, " ").slice(0, 200);
  return tools.map((t) => `${t.name}: ${first(t.description)}`).join("\n") + "\n";
}

/** `swan-tool --help <tool>`: its description and input schema. */
export function toolHelp(t: ToolDef): string {
  return `${t.name}\n\n${t.description}\n\nInput (JSON Schema):\n${JSON.stringify(t.inputSchema, null, 2)}\n`;
}

/** Written into each sandbox. Plain sh and curl, so it works in a persona's own image too. */
export const SWAN_TOOL_SCRIPT = `#!/bin/sh
# swan-tool: call one of Swan's tools from a command. Written by Swan; changes are overwritten.
#   swan-tool <tool> '<json input>'    (or the input on stdin)
#   swan-tool --list | --help <tool>
# Exit status: 0 done (result on stdout), 1 the tool reported an error (stdout),
# 2 refused (stderr), 3 anything else (stderr).
set -u
U=http://${TOOL_HOST}
if [ $# -lt 1 ]; then
  sed -n '3,6p' "$0" | sed 's/^# //' >&2
  exit 3
fi
command -v curl >/dev/null 2>&1 || { echo "swan-tool needs curl in the sandbox" >&2; exit 3; }
[ -n "\${SWAN_CALL:-}" ] || { echo "swan-tool works only in a command the agent runs with the bash tool" >&2; exit 3; }
out=$(mktemp) || exit 3
trap 'rm -f "$out"' EXIT
case "$1" in
  --list) code=$(curl -sS -o "$out" -w '%{http_code}' -H "x-swan-call: $SWAN_CALL" "$U/tools") ;;
  --help)
    [ $# -ge 2 ] || { echo "usage: swan-tool --help <tool>" >&2; exit 3; }
    code=$(curl -sS -o "$out" -w '%{http_code}' -H "x-swan-call: $SWAN_CALL" "$U/tools/$2") ;;
  *)
    name=$1
    shift
    if [ $# -ge 1 ]; then input=$1; else input=$(cat); fi
    code=$(printf '%s' "$input" | curl -sS -o "$out" -w '%{http_code}' -X POST -H "x-swan-call: $SWAN_CALL" -H 'content-type: application/json' --data-binary @- "$U/call/$name") ;;
esac
case "\${code:-}" in
  200) cat "$out"; exit 0 ;;
  422) cat "$out"; exit 1 ;;
  403) cat "$out" >&2; exit 2 ;;
  *) cat "$out" >&2; [ -n "\${code:-}" ] || echo "swan-tool: no answer from Swan" >&2; exit 3 ;;
esac
`;
