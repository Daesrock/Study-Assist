/**
 * Tests for provider-agnostic streaming (SSE) — Anthropic + OpenAI-compatible.
 */

import { describe, it, expect, afterEach, vi } from "vitest";

import { streamProvider } from "../../src/background/modules/llm/stream";
import type { StreamCallbacks } from "../../src/background/modules/llm/stream";
import { setLlmFetch } from "../../src/background/modules/llm/transport";
import { getPreset } from "../../src/background/modules/llm/registry";

afterEach(() => {
  setLlmFetch(undefined);
  vi.restoreAllMocks();
});

function sseResponse(events: string[]): Response {
  const payload = events.map((event) => `data: ${event}\n\n`).join("");
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(new TextEncoder().encode(payload));
      controller.close();
    },
  });
  return { ok: true, status: 200, body: stream } as unknown as Response;
}

function collect(): { callbacks: StreamCallbacks; state: Record<string, unknown> } {
  const state: Record<string, unknown> = { chunks: [] as string[], thinking: [] as string[] };
  const callbacks: StreamCallbacks = {
    onChunk: (text) => (state.chunks as string[]).push(text),
    onThinking: (text) => (state.thinking as string[]).push(text),
    onInputTokens: (n) => (state.inputTokens = n),
    onComplete: (n) => (state.outputTokens = n),
    onError: (e) => (state.error = e),
  };
  return { callbacks, state };
}

function anthropicEvents(stopReason = "end_turn"): string[] {
  return [
    JSON.stringify({
      type: "message_start",
      message: {
        usage: { input_tokens: 100, cache_read_input_tokens: 20, cache_creation_input_tokens: 5 },
      },
    }),
    JSON.stringify({ type: "content_block_delta", delta: { type: "thinking_delta", thinking: "hmm" } }),
    JSON.stringify({ type: "content_block_delta", delta: { type: "text_delta", text: "OK" } }),
    JSON.stringify({
      type: "message_delta",
      usage: { output_tokens: 3 },
      delta: { stop_reason: stopReason },
    }),
    JSON.stringify({ type: "message_stop" }),
  ];
}

describe("streamProvider — Anthropic", () => {
  it("streams text, thinking and usage", async () => {
    setLlmFetch((async () => sseResponse(anthropicEvents())) as unknown as typeof fetch);
    const { callbacks, state } = collect();

    const result = await streamProvider(
      {
        preset: getPreset("anthropic"),
        apiKey: "sk-ant",
        model: "claude-haiku-4-5-20251001",
        content: "hi",
        maxTokens: 2048,
        thinking: true,
        supportsReasoning: true,
        supportsAdaptiveThinking: false,
      },
      callbacks,
    );

    expect(result.fullText).toBe("OK");
    expect(result.thinkingText).toBe("hmm");
    expect(result.inputTokens).toBe(100);
    expect(result.outputTokens).toBe(3);
    expect(result.cacheHitTokens).toBe(20);
    expect(result.cacheWriteTokens).toBe(5);
    expect(result.truncated).toBe(false);
    expect(state.chunks).toEqual(["OK"]);
    expect(state.thinking).toEqual(["hmm"]);
    expect(state.inputTokens).toBe(100);
    expect(state.outputTokens).toBe(3);
  });

  it("flags truncation when the model hits max_tokens", async () => {
    setLlmFetch((async () => sseResponse(anthropicEvents("max_tokens"))) as unknown as typeof fetch);
    const { callbacks } = collect();

    const result = await streamProvider(
      {
        preset: getPreset("anthropic"),
        apiKey: "sk-ant",
        model: "claude-haiku-4-5-20251001",
        content: "hi",
        maxTokens: 2048,
        thinking: false,
        supportsReasoning: false,
      },
      callbacks,
    );

    expect(result.truncated).toBe(true);
  });

  it("omits thinking for models that do not support it", async () => {
    const fetchFn = vi.fn(async () => sseResponse(anthropicEvents()));
    setLlmFetch(fetchFn as unknown as typeof fetch);
    const { callbacks } = collect();

    await streamProvider(
      {
        preset: getPreset("anthropic"),
        apiKey: "sk-ant",
        model: "claude-3-haiku-20240307",
        content: "hi",
        maxTokens: 2048,
        thinking: true,
        supportsReasoning: false,
      },
      callbacks,
    );

    const init = (fetchFn.mock.calls[0] as unknown as [string, RequestInit])[1];
    const body = JSON.parse(init.body as string);
    expect(body.stream).toBe(true);
    expect(body).not.toHaveProperty("thinking");
  });
});

describe("streamProvider — OpenAI-compatible", () => {
  it("streams text, reasoning and usage", async () => {
    setLlmFetch(
      (async () =>
        sseResponse([
          JSON.stringify({ choices: [{ delta: { reasoning_content: "r" } }] }),
          JSON.stringify({ choices: [{ delta: { content: "OK" } }] }),
          JSON.stringify({
            choices: [],
            usage: {
              prompt_tokens: 50,
              completion_tokens: 2,
              prompt_tokens_details: { cached_tokens: 10 },
            },
          }),
          "[DONE]",
        ])) as unknown as typeof fetch,
    );
    const { callbacks, state } = collect();

    const result = await streamProvider(
      {
        preset: getPreset("openai"),
        apiKey: "sk",
        model: "gpt-5.1",
        content: "hi",
        maxTokens: 8192,
        thinking: true,
        supportsReasoning: true,
      },
      callbacks,
    );

    expect(result.fullText).toBe("OK");
    expect(result.thinkingText).toBe("r");
    expect(result.inputTokens).toBe(50);
    expect(result.outputTokens).toBe(2);
    expect(result.cacheHitTokens).toBe(10);
    expect(result.truncated).toBe(false);
    expect(state.chunks).toEqual(["OK"]);
    expect(state.inputTokens).toBe(50);
  });

  it("flags truncation on finish_reason=length", async () => {
    setLlmFetch(
      (async () =>
        sseResponse([
          JSON.stringify({ choices: [{ delta: { content: "partial" }, finish_reason: "length" }] }),
          "[DONE]",
        ])) as unknown as typeof fetch,
    );
    const { callbacks } = collect();

    const result = await streamProvider(
      {
        preset: getPreset("openai"),
        apiKey: "sk",
        model: "gpt-5.1",
        content: "hi",
        maxTokens: 8192,
        thinking: false,
      },
      callbacks,
    );

    expect(result.truncated).toBe(true);
    expect(result.fullText).toBe("partial");
    expect(result.usageReported).toBe(false);
  });

  it("uses max_completion_tokens and include_usage, gating reasoning", async () => {
    const fetchFn = vi.fn(async () => sseResponse(["[DONE]"]));
    setLlmFetch(fetchFn as unknown as typeof fetch);
    const { callbacks } = collect();

    await streamProvider(
      {
        preset: getPreset("openai"),
        apiKey: "sk",
        model: "gpt-4o",
        content: "hi",
        maxTokens: 4096,
        thinking: true,
        supportsReasoning: false,
      },
      callbacks,
    );

    const init = (fetchFn.mock.calls[0] as unknown as [string, RequestInit])[1];
    const body = JSON.parse(init.body as string);
    expect(body.stream).toBe(true);
    expect(body.stream_options).toEqual({ include_usage: true });
    expect(body).toHaveProperty("max_completion_tokens", 4096);
    expect(body).not.toHaveProperty("max_tokens");
    expect(body).not.toHaveProperty("reasoning_effort");
  });
});

describe("streamProvider — Responses incomplete", () => {
  it.each([
    ["max_output_tokens", "output_limit"],
    ["content_filter", "content_filter"],
    [null, "incomplete"],
  ] as const)("preserves terminal reason %s and reported tokens", async (reason, expectedKind) => {
    setLlmFetch((async () => sseResponse([
      JSON.stringify({ type: "response.output_text.delta", delta: "partial" }),
      JSON.stringify({ type: "response.reasoning_text.delta", delta: "thinking" }),
      JSON.stringify({ type: "response.incomplete", response: {
        incomplete_details: { reason }, usage: { input_tokens: 80, output_tokens: 40 },
      } }),
    ])) as unknown as typeof fetch);
    const { callbacks, state } = collect();
    const result = await streamProvider({
      preset: { ...getPreset("openai"), dialect: "openai-responses" },
      apiKey: "sk", model: "test", content: "hi", maxTokens: 128,
    }, callbacks);
    expect(result).toMatchObject({
      fullText: "partial", thinkingText: "thinking", errorKind: expectedKind,
      inputTokens: 80, outputTokens: 40, usageReported: true,
      truncated: expectedKind === "output_limit",
    });
    expect(state).not.toHaveProperty("outputTokens");
  });

  it("does not infer a zero-token cost when terminal usage is omitted", async () => {
    setLlmFetch((async () => sseResponse([
      JSON.stringify({ type: "response.incomplete", response: { incomplete_details: { reason: "max_output_tokens" } } }),
    ])) as unknown as typeof fetch);
    const { callbacks } = collect();
    const result = await streamProvider({
      preset: { ...getPreset("openai"), dialect: "openai-responses" },
      apiKey: "sk", model: "test", content: "hi", maxTokens: 128,
    }, callbacks);
    expect(result).toMatchObject({ errorKind: "output_limit", usageReported: false, inputTokens: 0, outputTokens: 0 });
  });
});
