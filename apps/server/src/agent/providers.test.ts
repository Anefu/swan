import http from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { SecretStore } from "../secrets.js";
import type { Settings } from "../settings.js";
import { ProviderRegistry } from "./providers.js";

/** A stand-in OpenAI-compatible server: records the request body and streams a reply with usage. */
function fakeServer() {
  const bodies: Record<string, unknown>[] = [];
  const server = http.createServer((req, res) => {
    let raw = "";
    req.on("data", (c) => (raw += c));
    req.on("end", () => {
      bodies.push(JSON.parse(raw));
      res.writeHead(200, { "content-type": "text/event-stream" });
      const send = (o: unknown) => res.write(`data: ${JSON.stringify(o)}\n\n`);
      send({ id: "c1", object: "chat.completion.chunk", created: 0, model: "m", choices: [{ index: 0, delta: { content: "hi" }, finish_reason: null }] });
      send({ id: "c1", object: "chat.completion.chunk", created: 0, model: "m", choices: [{ index: 0, delta: {}, finish_reason: "stop" }] });
      send({ id: "c1", object: "chat.completion.chunk", created: 0, model: "m", choices: [], usage: { prompt_tokens: 100, completion_tokens: 5, total_tokens: 105, prompt_tokens_details: { cached_tokens: 30 } } });
      res.end("data: [DONE]\n\n");
    });
  });
  return { server, bodies };
}

describe("OpenAI-compatible provider", () => {
  const { server, bodies } = fakeServer();
  let registry: ProviderRegistry;
  beforeAll(async () => {
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    const baseURL = `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1`;
    const settings = {
      providers: {
        or: { type: "openai", baseURL, models: { "glm-5": { extraBody: { provider: { order: ["z-ai"], allow_fallbacks: false }, model: "other", stream: false } } } },
      },
    } as unknown as Settings;
    registry = new ProviderRegistry(settings, new SecretStore());
  });
  afterAll(() => server.close());

  const turn = (model: string) =>
    registry.runTurn(
      "or",
      { model, system: "sys", tools: [], messages: [{ role: "user", content: "hello" }], maxTokens: 100, signal: new AbortController().signal },
      { onBlockStart() {}, onDelta() {}, onBlockStop() {} },
    );

  it("asks for usage and records input as uncached, separate from cached reads", async () => {
    const r = await turn("plain");
    expect(bodies.at(-1)).toMatchObject({ model: "plain", stream: true, stream_options: { include_usage: true } });
    expect(r.usage).toEqual({ inputTokens: 70, outputTokens: 5, cacheReadTokens: 30, cacheWriteTokens: 0 });
  });

  it("sends a model's extra request fields without letting them replace the model or the stream", async () => {
    await turn("glm-5");
    expect(bodies.at(-1)).toMatchObject({ model: "glm-5", stream: true, provider: { order: ["z-ai"], allow_fallbacks: false } });
  });
});

/** A stand-in Anthropic Messages API: records the request body and streams a one-word reply. */
function fakeAnthropic() {
  const bodies: Record<string, unknown>[] = [];
  const server = http.createServer((req, res) => {
    let raw = "";
    req.on("data", (c) => (raw += c));
    req.on("end", () => {
      bodies.push(JSON.parse(raw));
      res.writeHead(200, { "content-type": "text/event-stream" });
      const send = (event: string, data: unknown) => res.write(`event: ${event}\ndata: ${JSON.stringify({ type: event, ...(data as object) })}\n\n`);
      send("message_start", { message: { id: "m1", type: "message", role: "assistant", model: "claude-sonnet-5-5", content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 10, output_tokens: 0 } } });
      send("content_block_start", { index: 0, content_block: { type: "text", text: "" } });
      send("content_block_delta", { index: 0, delta: { type: "text_delta", text: "ok" } });
      send("content_block_stop", { index: 0 });
      send("message_delta", { delta: { stop_reason: "end_turn", stop_sequence: null }, usage: { output_tokens: 1 } });
      send("message_stop", {});
      res.end();
    });
  });
  return { server, bodies };
}

describe("Anthropic provider", () => {
  const { server, bodies } = fakeAnthropic();
  let registry: ProviderRegistry;
  beforeAll(async () => {
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    const baseURL = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    process.env.SWAN_TEST_ANTHROPIC_KEY = "test-key"; // read from the environment when the secrets store has none
    registry = new ProviderRegistry({ providers: { a: { type: "anthropic", baseURL, apiKeySecret: "SWAN_TEST_ANTHROPIC_KEY" } } } as unknown as Settings, new SecretStore());
  });
  afterAll(() => server.close());

  const turn = (extra: { cache?: boolean; effort?: "low" | "high" }) =>
    registry.runTurn(
      "a",
      { model: "claude-sonnet-5-5", system: "sys", tools: [], messages: [{ role: "user", content: "hello" }], maxTokens: 100, signal: new AbortController().signal, ...extra },
      { onBlockStart() {}, onDelta() {}, onBlockStop() {} },
    );

  it("caches conversation turns but not one-off requests", async () => {
    await turn({});
    expect(bodies.at(-1)).toMatchObject({ cache_control: { type: "ephemeral" } });
    await turn({ cache: false, effort: "low" });
    expect(bodies.at(-1)).not.toHaveProperty("cache_control");
    expect(bodies.at(-1)).toMatchObject({ output_config: { effort: "low" } });
  });
});
