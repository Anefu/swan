import Anthropic from "@anthropic-ai/sdk";
import OpenAI from "openai";
import type { Effort, ProviderStatus, Usage } from "@ph/shared";
import type { SecretStore } from "../secrets.js";
import type { ProviderConfig, Settings } from "../settings.js";
import { errMsg } from "../util.js";
import type { ToolDef } from "./tools.js";

// The canonical transcript is the Anthropic beta message format; other providers convert.
export type MessageParam = Anthropic.Beta.BetaMessageParam;
export type ContentBlockParam = Anthropic.Beta.BetaContentBlockParam;

export interface TurnRequest {
  model: string;
  system: string;
  tools: ToolDef[];
  messages: MessageParam[];
  maxTokens: number;
  effort?: Effort;
  signal: AbortSignal;
}

export interface TurnCallbacks {
  onBlockStart(index: number, kind: "text" | "thinking"): void;
  onDelta(index: number, kind: "text" | "thinking", text: string): void;
  onBlockStop(index: number): void;
}

export interface ToolUse {
  id: string;
  name: string;
  input: unknown;
  invalid?: string; // raw input that could not be parsed
}

export interface TurnResult {
  content: ContentBlockParam[]; // append verbatim as the assistant message
  stopReason: string;
  toolUses: ToolUse[];
  usage: Usage;
  notice?: string;
}

export class ProviderError extends Error {}

interface Provider {
  runTurn(req: TurnRequest, cb: TurnCallbacks): Promise<TurnResult>;
}

// Models on the current API surface: adaptive thinking, effort, server-side compaction.
const MODERN = /^claude-(fable|mythos|opus|sonnet|haiku)-(5|4-[6-9])/;
// Models that accept server-side refusal fallbacks with `fallbacks: "default"`.
const FALLBACKS = /^claude-(fable-5-1|opus-5-5|opus-5|sonnet-5-5)$/;

class AnthropicProvider implements Provider {
  constructor(
    private cfg: ProviderConfig,
    private apiKey: () => string | undefined,
  ) {}

  async runTurn(req: TurnRequest, cb: TurnCallbacks): Promise<TurnResult> {
    // A new client per turn picks up rotated keys immediately. With no key in the secrets
    // store the SDK falls back to its own resolution (ANTHROPIC_API_KEY, `ant auth login`).
    let client: Anthropic;
    try {
      client = new Anthropic({ apiKey: this.apiKey(), baseURL: this.cfg.baseURL, maxRetries: 3 });
    } catch (e) {
      throw new ProviderError(`No Anthropic credentials: add ${this.cfg.apiKeySecret ?? "ANTHROPIC_API_KEY"} to secrets.yaml (read live, no restart needed). ${errMsg(e)}`);
    }
    const modern = MODERN.test(req.model);
    const officialApi = !this.cfg.baseURL;
    const betas: Anthropic.Beta.AnthropicBeta[] = [];
    if (modern) betas.push("compact-2026-01-12");
    const fallbacks = officialApi && FALLBACKS.test(req.model);
    if (fallbacks) betas.push("server-side-fallback-2026-07-01");

    const params: Anthropic.Beta.MessageCreateParamsStreaming = {
      model: req.model,
      max_tokens: req.maxTokens,
      stream: true,
      system: [{ type: "text", text: req.system }],
      tools: req.tools.map((t) => ({
        name: t.name,
        description: t.description,
        input_schema: t.inputSchema as Anthropic.Beta.BetaTool.InputSchema,
        // Stream large inputs (file bodies) as generated; every input is validated before running.
        ...(officialApi ? { eager_input_streaming: true } : {}),
      })),
      messages: req.messages,
      cache_control: { type: "ephemeral" },
      ...(modern
        ? {
            thinking: { type: "adaptive", display: "summarized" },
            output_config: { effort: req.effort ?? "high" },
            context_management: { edits: [{ type: "compact_20260112" }] },
          }
        : {}),
      ...(fallbacks ? { fallbacks: "default" } : {}),
      ...(betas.length ? { betas } : {}),
    };

    for (let attempt = 0; ; attempt++) {
      try {
        const stream = client.beta.messages.stream(params, { signal: req.signal });
        for await (const ev of stream) {
          if (ev.type === "content_block_start") {
            const t = ev.content_block.type;
            if (t === "text" || t === "thinking") cb.onBlockStart(ev.index, t);
          } else if (ev.type === "content_block_delta") {
            if (ev.delta.type === "text_delta") cb.onDelta(ev.index, "text", ev.delta.text);
            else if (ev.delta.type === "thinking_delta") cb.onDelta(ev.index, "thinking", ev.delta.thinking);
          } else if (ev.type === "content_block_stop") {
            cb.onBlockStop(ev.index);
          }
        }
        const msg = await stream.finalMessage();
        const toolUses: ToolUse[] = [];
        for (const b of msg.content) if (b.type === "tool_use") toolUses.push({ id: b.id, name: b.name, input: b.input });
        let notice: string | undefined;
        if (msg.stop_reason === "refusal") {
          const d = msg.stop_details;
          notice = `The model declined this request${d?.category ? ` (${d.category})` : ""}.${d?.explanation ? ` ${d.explanation}` : ""}`;
        } else if (msg.content.some((b) => b.type === "fallback")) {
          notice = `A fallback model (${msg.model}) completed this turn after a refusal.`;
        }
        return {
          content: msg.content as unknown as ContentBlockParam[],
          stopReason: msg.stop_reason ?? "end_turn",
          toolUses,
          usage: {
            inputTokens: msg.usage.input_tokens,
            outputTokens: msg.usage.output_tokens,
            cacheReadTokens: msg.usage.cache_read_input_tokens ?? 0,
            cacheWriteTokens: msg.usage.cache_creation_input_tokens ?? 0,
          },
          notice,
        };
      } catch (e) {
        if (req.signal.aborted) throw e;
        if (e instanceof Anthropic.AuthenticationError) throw new ProviderError(`Anthropic rejected the API key (${this.cfg.apiKeySecret}): ${e.message}`);
        if (e instanceof Anthropic.PermissionDeniedError) throw new ProviderError(`Anthropic permission denied: ${e.message}`);
        if (e instanceof Anthropic.RateLimitError) throw new ProviderError(`Rate limited after retries: ${e.message}`);
        if (e instanceof Anthropic.BadRequestError) throw new ProviderError(`Anthropic rejected the request: ${e.message}`);
        if (e instanceof Anthropic.APIError) throw new ProviderError(`Anthropic API error ${e.status ?? ""}: ${e.message}`);
        // Anything else while consuming the stream is a tool input that could not be parsed
        // (eager input streaming). The turn was never appended, so re-issuing is safe.
        if (attempt >= 2) throw new ProviderError(`Model produced unparseable tool input 3 times: ${errMsg(e)}`);
      }
    }
  }
}

class OpenAIProvider implements Provider {
  constructor(
    private cfg: ProviderConfig,
    private apiKey: () => string | undefined,
  ) {}

  private toOpenAI(system: string, messages: MessageParam[]): OpenAI.Chat.ChatCompletionMessageParam[] {
    const out: OpenAI.Chat.ChatCompletionMessageParam[] = [{ role: "system", content: system }];
    for (const m of messages) {
      if (typeof m.content === "string") {
        out.push({ role: m.role, content: m.content } as OpenAI.Chat.ChatCompletionMessageParam);
        continue;
      }
      if (m.role === "assistant") {
        const text = m.content.flatMap((b) => (b.type === "text" ? [b.text] : [])).join("\n");
        const calls = m.content.flatMap((b) =>
          b.type === "tool_use" ? [{ id: b.id, type: "function" as const, function: { name: b.name, arguments: JSON.stringify(b.input ?? {}) } }] : [],
        );
        out.push({ role: "assistant", content: text || null, ...(calls.length ? { tool_calls: calls } : {}) });
      } else {
        const texts: string[] = [];
        for (const b of m.content ?? []) {
          if (b.type === "tool_result") {
            const content =
              typeof b.content === "string"
                ? b.content
                : (b.content ?? []).map((c) => (c.type === "text" ? c.text : `[${c.type} omitted]`)).join("\n");
            out.push({ role: "tool", tool_call_id: b.tool_use_id, content: (b.is_error ? "ERROR: " : "") + content });
          } else if (b.type === "text") texts.push(b.text);
        }
        if (texts.length) out.push({ role: "user", content: texts.join("\n") });
      }
    }
    return out;
  }

  async runTurn(req: TurnRequest, cb: TurnCallbacks): Promise<TurnResult> {
    const client = new OpenAI({ apiKey: this.apiKey() ?? "not-needed", baseURL: this.cfg.baseURL, maxRetries: 2 });
    const isOpenAI = (this.cfg.baseURL ?? "").includes("api.openai.com");
    let stream;
    try {
      stream = await client.chat.completions.create(
        {
          model: req.model,
          messages: this.toOpenAI(req.system, req.messages),
          tools: req.tools.map((t) => ({ type: "function", function: { name: t.name, description: t.description, parameters: t.inputSchema } })),
          stream: true,
          ...(isOpenAI ? { stream_options: { include_usage: true }, max_completion_tokens: req.maxTokens } : { max_tokens: req.maxTokens }),
        },
        { signal: req.signal },
      );
    } catch (e) {
      if (req.signal.aborted) throw e;
      if (e instanceof OpenAI.APIError) throw new ProviderError(`${this.cfg.baseURL}: ${e.status ?? ""} ${e.message}`);
      throw new ProviderError(`cannot reach ${this.cfg.baseURL}: ${errMsg(e)}`);
    }
    let text = "";
    let thinkingOpen = false;
    let textOpen = false;
    let finish = "stop";
    const calls = new Map<number, { id: string; name: string; args: string }>();
    const usage: Usage = { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 };
    for await (const chunk of stream) {
      if (chunk.usage) {
        usage.inputTokens = chunk.usage.prompt_tokens ?? 0;
        usage.outputTokens = chunk.usage.completion_tokens ?? 0;
        usage.cacheReadTokens = chunk.usage.prompt_tokens_details?.cached_tokens ?? 0;
      }
      const choice = chunk.choices[0];
      if (!choice) continue;
      const delta = choice.delta as typeof choice.delta & { reasoning_content?: string; reasoning?: string };
      const reasoning = delta.reasoning_content ?? delta.reasoning;
      if (reasoning) {
        if (!thinkingOpen) cb.onBlockStart(0, "thinking");
        thinkingOpen = true;
        cb.onDelta(0, "thinking", reasoning);
      }
      if (delta.content) {
        if (thinkingOpen) {
          cb.onBlockStop(0);
          thinkingOpen = false;
        }
        if (!textOpen) cb.onBlockStart(1, "text");
        textOpen = true;
        text += delta.content;
        cb.onDelta(1, "text", delta.content);
      }
      for (const tc of delta.tool_calls ?? []) {
        const cur = calls.get(tc.index) ?? { id: "", name: "", args: "" };
        if (tc.id) cur.id = tc.id;
        if (tc.function?.name) cur.name += tc.function.name;
        if (tc.function?.arguments) cur.args += tc.function.arguments;
        calls.set(tc.index, cur);
      }
      if (choice.finish_reason) finish = choice.finish_reason;
    }
    if (thinkingOpen) cb.onBlockStop(0);
    if (textOpen) cb.onBlockStop(1);

    const content: ContentBlockParam[] = [];
    if (text) content.push({ type: "text", text });
    const toolUses: ToolUse[] = [];
    for (const [i, c] of [...calls.entries()].sort((a, b) => a[0] - b[0])) {
      const id = c.id || `call_${i}_${Date.now()}`;
      let input: unknown = {};
      let invalid: string | undefined;
      try {
        input = c.args ? JSON.parse(c.args) : {};
      } catch {
        invalid = c.args;
      }
      content.push({ type: "tool_use", id, name: c.name, input: invalid ? {} : (input as Record<string, unknown>) });
      toolUses.push({ id, name: c.name, input, invalid });
    }
    const stopReason = toolUses.length ? "tool_use" : finish === "length" ? "max_tokens" : "end_turn";
    return { content, stopReason, toolUses, usage };
  }
}

export class ProviderRegistry {
  constructor(
    private settings: Settings,
    private secrets: SecretStore,
  ) {}

  private make(name: string): Provider {
    const cfg = this.settings.providers[name];
    if (!cfg) throw new ProviderError(`unknown provider "${name}"`);
    // Provider keys are used host-side only; fall back to the harness's own environment.
    const key = () => (cfg.apiKeySecret ? (this.secrets.value(cfg.apiKeySecret) ?? process.env[cfg.apiKeySecret]) : undefined);
    return cfg.type === "anthropic" ? new AnthropicProvider(cfg, key) : new OpenAIProvider(cfg, key);
  }

  runTurn(provider: string, req: TurnRequest, cb: TurnCallbacks) {
    return this.make(provider).runTurn(req, cb);
  }

  status(): ProviderStatus[] {
    return Object.entries(this.settings.providers).map(([name, cfg]) => ({
      name,
      type: cfg.type,
      baseURL: cfg.baseURL,
      apiKeySecret: cfg.apiKeySecret,
      ready: cfg.apiKeySecret ? !!(this.secrets.value(cfg.apiKeySecret) ?? process.env[cfg.apiKeySecret]) : true,
    }));
  }
}
