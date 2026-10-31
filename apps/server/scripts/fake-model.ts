// Scripted OpenAI-compatible model for exercising the harness without an API key.
//
//   pnpm --filter @ph/server exec tsx scripts/fake-model.ts        # listens on 127.0.0.1:8099
//
// Add to ~/.persona-harness/config.yaml:   providers: { fake: { type: openai, baseURL: http://127.0.0.1:8099/v1 } }
// and set a persona's model to { provider: fake, id: scripted }.
//
// Each user message picks a script by keyword (see SCRIPTS); every model turn after it plays the
// next step. Steps are tool calls or a final text reply.
import http from "node:http";

// args may depend on the user message that started the script (e.g. an agent id in a notification).
type Step = { text?: string; tool?: string; args?: Record<string, unknown> | ((userText: string) => Record<string, unknown>) };
let lastUserText = "";

const SCRIPTS: Record<string, Step[]> = {
  isolation: [
    { text: "Checking what the sandbox can see.", tool: "bash", args: { command: "id; echo; ls -la /workspace /workspace/*; echo; ls /Users 2>&1; ls ~ 2>&1 | head; cat /etc/hostname" } },
    { tool: "bash", args: { command: "curl -s -m 8 -o /dev/null -w 'example.com via proxy: %{http_code}\\n' https://example.com; curl -s -m 5 --noproxy '*' https://1.1.1.1 >/dev/null 2>&1 && echo 'direct: LEAK' || echo 'direct (no proxy): blocked'; getent hosts example.com && echo 'dns: LEAK' || echo 'dns: none'" } },
    { tool: "bash", args: { command: "env | grep -E '^(DEMO_TOKEN|HTTPS_PROXY)=' | sed -E 's/(:\\/\\/[^:]+:)[^@]+@/\\1***@/'" } },
    { text: "Isolation checks done." },
  ],
  inject: [
    { text: "Calling an echo service with the placeholder token.", tool: "bash", args: { command: "curl -s -m 15 -H \"Authorization: Bearer $DEMO_TOKEN\" https://httpbin.org/headers" } },
    { text: "Done — the response above shows what the upstream received (long secrets are redacted back to the placeholder)." },
  ],
  write: [
    { tool: "write_file", args: { path: "/workspace/demo/hello.txt", content: "written from the sandbox\n" } },
    { tool: "bash", args: { command: "cat /workspace/demo/hello.txt && rm /workspace/demo/hello.txt && echo removed" } },
    { text: "Wrote, read back and removed the file." },
  ],
  skill: [
    { tool: "load_skill", args: { name: "repo-tour" } },
    { tool: "bash", args: { command: "bash /skills/repo-tour/scripts/summarize.sh /workspace/demo" } },
    { text: "That is the repo tour." },
  ],
  remember: [
    { tool: "memory_propose", args: { content: "Use pnpm in this repository.", type: "preference", origin: "user", sources: [] } },
    { tool: "memory_search", args: { query: "pnpm" } },
    { tool: "history_search", args: { query: "pnpm" } },
    { text: "Saved and found it again." },
  ],
  connections: [
    { tool: "connection_status", args: {} },
    { tool: "bash", args: { command: "echo \"profile=$AWS_PROFILE kubeconfig=$KUBECONFIG github=${GITHUB_TOKEN:0:4}…\"; cat ~/.aws/credentials; grep -E 'server|token' ~/.kube/config; ls -l ~/.aws ~/.kube" } },
    { text: "Those are the connection files; every value is a placeholder." },
  ],
  // Sub-agents: a foreground agent, then a background one that asks the parent a question.
  "agents-demo": [
    { text: "Counting files with a foreground agent first.", tool: "agent", args: { description: "Count workspace files", prompt: "subtask-count: count the entries under /workspace/demo", max_turns: 5 } },
    { tool: "agent", args: { description: "Check hidden files", prompt: "subtask-ask: check the hidden files under /workspace/demo", background: true } },
    { text: "A background agent is checking hidden files; I'll answer it when it asks." },
  ],
  "subtask-count": [
    { tool: "bash", args: { command: "ls -1 /workspace/demo | wc -l" } },
    { text: "Report: /workspace/demo has the entries listed above." },
  ],
  "subtask-ask": [
    { tool: "bash", args: { command: "sleep 2; ls -A1 /workspace/demo | head -5" } },
    { tool: "ask_parent", args: { question: "Should I include dotfiles like .git in the count?" } },
    { text: "Report: counted with dotfiles included, as the parent asked." },
  ],
  "asked a question]": [
    { tool: "agent_message", args: (t) => ({ id: /ag_[0-9a-f]+/.exec(t)?.[0] ?? "", message: "Yes, include them." }) },
    { text: "Answered the background agent." },
  ],
  "finished]": [{ text: "The background agent is done." }],
  slow: [{ tool: "bash", args: { command: "for i in 1 2 3 4 5 6 7 8 9 10; do echo tick $i; sleep 1; done" } }, { text: "finished counting" }],
};

type Msg = { role: string; content?: string | null; tool_calls?: unknown[] };

function pick(messages: Msg[]): Step {
  // Harness side-calls: checkpoints and /dream consolidation expect one JSON object.
  const system = String(messages.find((m) => m.role === "system")?.content ?? "");
  if (system.includes("write checkpoints"))
    return { text: JSON.stringify({ objective: "Finish the scripted demo task", constraints: ["Keep changes small"], decisions: ["Use the scripted model"], completed: ["Ran the earlier steps"], failures: [], openQuestions: [], nextAction: "Run the next scripted step", sources: [] }) };
  if (system.includes("long-term memory"))
    return { text: JSON.stringify({ add: [{ type: "preference", content: "The user prefers small, reviewed changes.", origin: "user", sources: [] }], merge: [], archive: [] }) };
  let lastUser = -1;
  messages.forEach((m, i) => {
    if (m.role === "user") lastUser = i;
  });
  lastUserText = String(messages[lastUser]?.content ?? "");
  const text = lastUserText.toLowerCase();
  const key = Object.keys(SCRIPTS).find((k) => text.includes(k));
  if (!key) return { text: `Scripted model. Say one of: ${Object.keys(SCRIPTS).join(", ")}.` };
  const done = messages.slice(lastUser + 1).filter((m) => m.role === "assistant").length;
  return SCRIPTS[key][done] ?? { text: "(script finished)" };
}

const server = http.createServer((req, res) => {
  if (req.method === "GET" && req.url?.endsWith("/models")) {
    res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ data: [{ id: "scripted", object: "model" }] }));
    return;
  }
  let body = "";
  req.on("data", (c) => (body += c));
  req.on("end", async () => {
    const { messages } = JSON.parse(body || "{}") as { messages: Msg[] };
    const step = pick(messages ?? []);
    res.writeHead(200, { "content-type": "text/event-stream" });
    const send = (delta: unknown, finish: string | null = null) =>
      res.write(`data: ${JSON.stringify({ id: "x", object: "chat.completion.chunk", choices: [{ index: 0, delta, finish_reason: finish }] })}\n\n`);
    if (step.text) {
      for (const word of step.text.split(/(?<= )/)) {
        send({ content: word });
        await new Promise((r) => setTimeout(r, 15));
      }
    }
    if (step.tool) {
      send({ tool_calls: [{ index: 0, id: `call_${Date.now()}`, type: "function", function: { name: step.tool, arguments: JSON.stringify((typeof step.args === "function" ? step.args(lastUserText) : step.args) ?? {}) } }] });
      send({}, "tool_calls");
    } else send({}, "stop");
    res.end("data: [DONE]\n\n");
  });
});
server.listen(Number(process.env.FAKE_MODEL_PORT ?? 8099), "127.0.0.1", () => console.log(`fake model on http://127.0.0.1:${process.env.FAKE_MODEL_PORT ?? 8099}/v1`));
