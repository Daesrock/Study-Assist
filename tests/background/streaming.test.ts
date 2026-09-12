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
