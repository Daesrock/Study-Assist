/**
 * Tests for Step B1: unified provider execution (runProvider).
 */

import { describe, it, expect, afterEach, vi } from "vitest";

import { runProvider } from "../../src/background/modules/llm/execute";
import { setLlmFetch } from "../../src/background/modules/llm/transport";
import { getPreset } from "../../src/background/modules/llm/registry";

afterEach(() => {
  setLlmFetch(undefined);
  vi.restoreAllMocks();
});

function jsonResponse(body: unknown, ok = true, status = 200) {
  return {
    ok,
    status,
    clone: () => ({ json: async () => body }),
    json: async () => body,
  } as unknown as Response;
}

describe("runProvider — Anthropic dialect", () => {
  it("posts to /v1/messages with x-api-key and parses text + thinking", async () => {
    const fetchFn = vi.fn(async () =>
      jsonResponse({
        content: [
          { type: "thinking", thinking: "reasoning here" },
          { type: "text", text: "ANSWER: A" },
        ],
        usage: { input_tokens: 100, output_tokens: 20 },
      }),
    );
    setLlmFetch(fetchFn as unknown as typeof fetch);

    const run = await runProvider({
      preset: getPreset("anthropic"),
      apiKey: "sk-ant-test",
      model: "claude-haiku-4-5-20251001",
      content: "hello",
      maxTokens: 1024,
      thinking: false,
      retries: 0,
    });

    expect(run.result.success).toBe(true);
    expect(run.result.text).toBe("ANSWER: A");
    expect(run.result.reasoning).toBe("reasoning here");
    expect(run.result.usage).toMatchObject({ inputTokens: 100, outputTokens: 20 });

    const [url, init] = fetchFn.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("https://api.anthropic.com/v1/messages");
    expect((init.headers as Record<string, string>)["x-api-key"]).toBe("sk-ant-test");
  });

  it("maps auth errors with an Anthropic message", async () => {
    setLlmFetch((async () => jsonResponse({ error: { message: "bad key" } }, false, 401)) as unknown as typeof fetch);

    const run = await runProvider({
      preset: getPreset("anthropic"),
      apiKey: "x",
      model: "m",
      content: "hi",
      maxTokens: 10,
      retries: 0,
    });

    expect(run.result.success).toBe(false);
    expect(run.result.error?.message).toBeTruthy();
    expect(run.status).toBe(401);
  });
});

describe("runProvider — OpenAI-compatible dialect", () => {
  it("builds a DeepSeek request with thinking + reasoning_effort", async () => {
    const fetchFn = vi.fn(async () =>
      jsonResponse({
        choices: [{ message: { content: "ANSWER: B", reasoning_content: "r" } }],
        usage: { prompt_tokens: 50, completion_tokens: 10, prompt_cache_hit_tokens: 5 },
      }),
    );
    setLlmFetch(fetchFn as unknown as typeof fetch);

    const run = await runProvider({
      preset: getPreset("deepseek"),
      apiKey: "sk-test",
      model: "deepseek-v4-flash",
      content: "prompt",
      maxTokens: 2048,
      thinking: true,
      retries: 0,
    });

    expect(run.result.success).toBe(true);
    expect(run.result.text).toBe("ANSWER: B");
    expect(run.result.reasoning).toBe("r");
    expect(run.result.usage.cacheHitTokens).toBe(5);

    const [url, init] = fetchFn.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("https://api.deepseek.com/chat/completions");
    const body = JSON.parse(init.body as string);
    expect(body.thinking).toEqual({ type: "enabled" });
    expect(body.reasoning_effort).toBe("high");
  });

  it("marks 5xx as retryable and 4xx as non-retryable", async () => {
    setLlmFetch((async () => jsonResponse({ error: { message: "boom" } }, false, 500)) as unknown as typeof fetch);
    const retryable = await runProvider({
      preset: getPreset("openai"),
      apiKey: "k",
      model: "gpt-5.1",
      content: "hi",
      maxTokens: 10,
      retries: 0,
    });
    expect(retryable.result.error?.retryable).toBe(true);

    setLlmFetch((async () => jsonResponse({ error: { message: "bad" } }, false, 400)) as unknown as typeof fetch);
    const notRetryable = await runProvider({
      preset: getPreset("openai"),
      apiKey: "k",
      model: "gpt-5.1",
      content: "hi",
      maxTokens: 10,
      retries: 0,
    });
    expect(notRetryable.result.error?.retryable).toBe(false);
    expect(notRetryable.result.error?.message).toContain("OpenAI");
  });

  it("treats a thrown abort as cancelled", async () => {
    const abortError = new Error("aborted");
    abortError.name = "AbortError";
    setLlmFetch((async () => {
      throw abortError;
    }) as unknown as typeof fetch);

    const run = await runProvider({
      preset: getPreset("openai"),
      apiKey: "k",
      model: "gpt-5.1",
      content: "hi",
      maxTokens: 10,
      retries: 0,
    });

    expect(run.result.cancelled).toBe(true);
    expect(run.status).toBeNull();
  });
});
