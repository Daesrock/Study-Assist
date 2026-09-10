/**
 * Tests for the normalized LLM layer (Step A):
 * dialect adapters, transport injection, and the model catalog.
 */

import { describe, it, expect, afterEach, vi } from "vitest";

import {
  buildOpenAiChatRequest,
  parseOpenAiChatResponse,
  describeOpenAiError,
} from "../../src/background/modules/llm/openaiCompat";
import {
  buildAnthropicMessagesRequest,
  parseAnthropicMessagesResponse,
} from "../../src/background/modules/llm/anthropic";
import { getPreset, DEEPSEEK_PRESET_ID, ANTHROPIC_PRESET_ID } from "../../src/background/modules/llm/registry";
import { fetchModels } from "../../src/background/modules/llm/catalog";
import { setLlmFetch } from "../../src/background/modules/llm/transport";

afterEach(() => {
  setLlmFetch(undefined);
  vi.restoreAllMocks();
});

describe("openaiCompat.buildOpenAiChatRequest", () => {
  it("builds a DeepSeek-style request (thinking + reasoning_effort)", () => {
    const { url, body, init } = buildOpenAiChatRequest({
      baseUrl: "https://api.deepseek.com",
      apiKey: "sk-test",
      model: "deepseek-v4-flash",
      messages: [{ role: "user", content: "hi" }],
      maxTokens: 2048,
      thinking: true,
      reasoningEffort: "high",
      reasoningKind: "deepseek",
    });

    expect(url).toBe("https://api.deepseek.com/chat/completions");
    expect((init.headers as Record<string, string>).Authorization).toBe("Bearer sk-test");
    expect(body).toMatchObject({
      model: "deepseek-v4-flash",
      max_tokens: 2048,
      thinking: { type: "enabled" },
      reasoning_effort: "high",
    });
  });

  it("disables thinking when thinking=false", () => {
    const { body } = buildOpenAiChatRequest({
      baseUrl: "https://api.deepseek.com/",
      apiKey: "sk-test",
      model: "deepseek-v4-flash",
      messages: [{ role: "user", content: "hi" }],
      maxTokens: 2048,
      thinking: false,
      reasoningKind: "deepseek",
    });
    expect((body as { thinking: { type: string } }).thinking).toEqual({ type: "disabled" });
  });

  it("omits thinking for the openai-effort kind", () => {
    const { body } = buildOpenAiChatRequest({
      baseUrl: "https://api.openai.com/v1",
      apiKey: "sk-test",
      model: "gpt-5.1",
      messages: [{ role: "user", content: "hi" }],
      maxTokens: 1024,
      reasoningEffort: "medium",
      reasoningKind: "openai-effort",
    });
    expect(body).not.toHaveProperty("thinking");
    expect((body as { reasoning_effort: string }).reasoning_effort).toBe("medium");
  });

  it("strips trailing slashes from baseUrl", () => {
    const { url } = buildOpenAiChatRequest({
      baseUrl: "https://api.deepseek.com///",
      apiKey: "k",
      model: "m",
      messages: [{ role: "user", content: "x" }],
      maxTokens: 10,
      reasoningKind: "none",
    });
    expect(url).toBe("https://api.deepseek.com/chat/completions");
  });
});

describe("openaiCompat.parseOpenAiChatResponse", () => {
  it("extracts text, reasoning_content and usage", () => {
    const parsed = parseOpenAiChatResponse({
      choices: [{ message: { content: "ANSWER: B", reasoning_content: "thinking..." } }],
      usage: { prompt_tokens: 120, completion_tokens: 30, prompt_cache_hit_tokens: 40 },
    });
    expect(parsed.text).toBe("ANSWER: B");
    expect(parsed.reasoning).toBe("thinking...");
    expect(parsed.usage).toEqual({
      inputTokens: 120,
      outputTokens: 30,
      cacheHitTokens: 40,
    });
  });

  it("accepts `reasoning` as an alias and defaults missing usage to 0", () => {
    const parsed = parseOpenAiChatResponse({
      choices: [{ message: { content: "x", reasoning: "r" } }],
    });
    expect(parsed.reasoning).toBe("r");
    expect(parsed.usage.inputTokens).toBe(0);
    expect(parsed.usage.outputTokens).toBe(0);
  });

  it("returns nulls for an empty payload", () => {
    const parsed = parseOpenAiChatResponse({});
    expect(parsed.text).toBeNull();
    expect(parsed.reasoning).toBeNull();
  });
});

describe("openaiCompat.describeOpenAiError", () => {
  it("marks 4xx/503 as non-retryable and 500 as retryable", () => {
    expect(describeOpenAiError(401, "", "DeepSeek").skipRetry).toBe(true);
    expect(describeOpenAiError(429, "", "DeepSeek").skipRetry).toBe(true);
    expect(describeOpenAiError(503, "", "DeepSeek").skipRetry).toBe(true);
    expect(describeOpenAiError(500, "", "DeepSeek").skipRetry).toBe(false);
  });

  it("keeps the provider label in the message", () => {
    expect(describeOpenAiError(401, "", "DeepSeek").error).toContain("DeepSeek");
    expect(describeOpenAiError(401, "", "OpenAI").error).toContain("OpenAI");
  });
});

describe("anthropic.buildAnthropicMessagesRequest", () => {
  it("builds a Messages API request with x-api-key and anthropic-version", () => {
    const { url, body, init } = buildAnthropicMessagesRequest({
      baseUrl: "https://api.anthropic.com",
      apiKey: "sk-ant-test",
      model: "claude-haiku-4-5-20251001",
      messages: [{ role: "user", content: "hi" }],
      maxTokens: 1024,
      thinking: { type: "enabled", budget_tokens: 1024 },
    });

    expect(url).toBe("https://api.anthropic.com/v1/messages");
    const headers = init.headers as Record<string, string>;
    expect(headers["x-api-key"]).toBe("sk-ant-test");
    expect(headers["anthropic-version"]).toBe("2023-06-01");
    expect(body).toMatchObject({
      model: "claude-haiku-4-5-20251001",
      max_tokens: 1024,
      thinking: { type: "enabled", budget_tokens: 1024 },
    });
  });

  it("omits thinking when not provided", () => {
    const { body } = buildAnthropicMessagesRequest({
      baseUrl: "https://api.anthropic.com",
      apiKey: "k",
      model: "m",
      messages: [{ role: "user", content: "x" }],
      maxTokens: 10,
    });
    expect(body).not.toHaveProperty("thinking");
  });
});

describe("anthropic.parseAnthropicMessagesResponse", () => {
  it("extracts text, thinking and usage", () => {
    const parsed = parseAnthropicMessagesResponse({
      content: [
        { type: "thinking", thinking: "let me think" },
        { type: "text", text: "ANSWER: A" },
      ],
      usage: {
        input_tokens: 200,
        output_tokens: 50,
        cache_read_input_tokens: 150,
      },
    });
    expect(parsed.text).toBe("ANSWER: A");
    expect(parsed.reasoning).toBe("let me think");
    expect(parsed.usage.inputTokens).toBe(200);
    expect(parsed.usage.cacheHitTokens).toBe(150);
  });

  it("returns nulls when blocks are missing", () => {
    const parsed = parseAnthropicMessagesResponse({ content: [] });
    expect(parsed.text).toBeNull();
    expect(parsed.reasoning).toBeNull();
  });
});

describe("registry", () => {
  it("exposes the anthropic and deepseek presets", () => {
    expect(getPreset(ANTHROPIC_PRESET_ID).dialect).toBe("anthropic");
    expect(getPreset(DEEPSEEK_PRESET_ID).dialect).toBe("openai-compatible");
    expect(getPreset(DEEPSEEK_PRESET_ID).capabilities.images).toBe(false);
  });

  it("throws for an unknown preset", () => {
    expect(() => getPreset("nope")).toThrow(/Unknown LLM preset/);
  });
});

describe("catalog.fetchModels", () => {
  function fakeResponse(body: unknown, ok = true, status = 200) {
    return { ok, status, json: async () => body } as unknown as Response;
  }

  it("lists OpenAI-compatible models via the injected fetch", async () => {
    const fetchFn = vi.fn(async () =>
      fakeResponse({ data: [{ id: "deepseek-v4-flash" }, { id: "deepseek-v4-pro" }] }),
    );
    setLlmFetch(fetchFn as unknown as typeof fetch);

    const result = await fetchModels(getPreset(DEEPSEEK_PRESET_ID), "sk-test");

    expect(result.success).toBe(true);
    expect(result.models.map((m) => m.id)).toEqual(["deepseek-v4-flash", "deepseek-v4-pro"]);
    const calledUrl = (fetchFn.mock.calls[0] as unknown[])[0] as string;
    expect(calledUrl).toBe("https://api.deepseek.com/models");
  });

  it("lists Anthropic models using display_name", async () => {
    const fetchFn = vi.fn(async () =>
      fakeResponse({ data: [{ id: "claude-haiku-4-5-20251001", display_name: "Haiku 4.5" }] }),
    );
    setLlmFetch(fetchFn as unknown as typeof fetch);

    const result = await fetchModels(getPreset(ANTHROPIC_PRESET_ID), "sk-ant-test");

    expect(result.success).toBe(true);
    expect(result.models[0]).toEqual({ id: "claude-haiku-4-5-20251001", name: "Haiku 4.5" });
  });

  it("returns a failure result instead of throwing on HTTP errors", async () => {
    setLlmFetch((async () => fakeResponse({}, false, 401)) as unknown as typeof fetch);

    const result = await fetchModels(getPreset(DEEPSEEK_PRESET_ID), "bad");

    expect(result.success).toBe(false);
    expect(result.models).toEqual([]);
    expect(result.error).toContain("401");
  });
});
