/**
 * Provider-agnostic streaming (SSE) for the full/overlay mode.
 *
 * `streamProvider` dispatches to the right dialect adapter:
 * - Anthropic: `message_start` / `content_block_delta` / `message_delta` / `message_stop`
 * - OpenAI-compatible: `choices[].delta` chunks, `usage`, `[DONE]`
 *
 * Reasoning is gated exactly like the non-streaming path: `thinking` /
 * `reasoning_effort` are only sent when the model actually supports them.
 */

import type { ClaudeContentBlock, ClaudeMessage } from "../constants.js";
import { getClaudeThinkingConfig, log } from "../constants.js";
import { hasReportedTokenCounts } from "./contract.js";
import type { ProviderErrorKind, ProviderPreset } from "./contract.js";
import { llmRequest } from "./transport.js";
import { toChatContent } from "./multimodal.js";
import { buildAnthropicMessagesRequest } from "./anthropic.js";
import { buildOpenAiChatRequest, describeOpenAiError } from "./openaiCompat.js";
import { buildOpenAiResponsesRequest } from "./openaiResponses.js";

export interface StreamCallbacks {
  onChunk: (text: string) => void;
  onInputTokens: (count: number) => void;
  onComplete: (outputTokens: number) => void;
  onError: (error: string) => void;
  onThinking?: (thinking: string) => void;
}

export interface StreamProviderOptions {
  preset: ProviderPreset;
  apiKey: string;
  model: string;
  content: string | ClaudeContentBlock[];
  maxTokens: number;
  thinking?: boolean;
  supportsReasoning?: boolean;
  supportsAdaptiveThinking?: boolean;
  reasoningEffort?: "low" | "medium" | "high";
  signal?: AbortSignal;
}

export interface StreamResult {
  fullText: string;
  inputTokens: number;
  outputTokens: number;
  cacheHitTokens?: number;
  cacheWriteTokens?: number;
  thinkingText?: string;
  /** True when the provider stopped because of the token limit. */
  truncated: boolean;
  /** Both token counts were reported, so cost can be computed. */
  usageReported: boolean;
  /** Terminal failure reported by the provider despite HTTP 200. */
  errorKind?: ProviderErrorKind;
}

/** Read an SSE response body and forward each `data:` payload. */
async function consumeSse(
  response: Response,
  callbacks: StreamCallbacks,
  onData: (data: string) => void,
): Promise<void> {
  const body = response.body;
  if (!body) {
    throw new Error("Empty response body");
  }

  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let dataLines: string[] = [];

  const handleLine = (line: string) => {
    const trimmed = line.trim();
    if (!trimmed) {
      if (dataLines.length) onData(dataLines.join("\n"));
      dataLines = [];
      return;
    }
    if (!trimmed.startsWith("data:")) return;
    const data = trimmed.slice(5).trim();
    if (data) dataLines.push(data);
  };

  try {
    while (true) {
      let timer: ReturnType<typeof setTimeout> | undefined;
      const idle = new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error("Stream idle timeout")), 60000); });
      const { done, value } = await Promise.race([reader.read(), idle]).finally(() => clearTimeout(timer));
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      if (buffer.length > 1024 * 1024) throw new Error("SSE event exceeds limit");
      const lines = buffer.split("\n");
      buffer = lines.pop() || "";
      for (const line of lines) handleLine(line);
    }
    if (buffer) handleLine(buffer);
    handleLine("");
  } catch (error) {
    if ((error as Error).name === "AbortError") throw error;
    callbacks.onError((error as Error).message);
    throw error;
  } finally {
    await reader.cancel().catch(() => {});
    reader.releaseLock();
  }
}

async function errorMessageFromResponse(
  response: Response,
  fallback: string,
): Promise<string> {
  try {
    const text = await response.text();
    const parsed = JSON.parse(text) as { error?: { message?: string } };
    return parsed.error?.message || fallback;
  } catch {
    return fallback;
  }
}

async function streamAnthropic(
  opts: StreamProviderOptions,
  callbacks: StreamCallbacks,
): Promise<StreamResult> {
  const reasoning = opts.thinking === true && opts.supportsReasoning === true;
  const messages: ClaudeMessage[] = [{ role: "user", content: opts.content }];
  const built = buildAnthropicMessagesRequest({
    baseUrl: opts.preset.baseUrl,
    apiKey: opts.apiKey,
    model: opts.model,
    messages,
    maxTokens: opts.maxTokens,
    thinking: reasoning
      ? getClaudeThinkingConfig(opts.model, opts.supportsAdaptiveThinking)
      : undefined,
    headers: opts.preset.headers,
    stream: true,
    signal: opts.signal,
  });

  const response = await llmRequest({
    url: built.url,
    init: built.init,
    retries: 0,
    timeout: opts.thinking ? 600000 : 300000,
  });

  if (!response.ok) {
    const message = await errorMessageFromResponse(
      response,
      `Anthropic API Error (${response.status})`,
    );
    log(`[Study Assist] Anthropic stream HTTP ${response.status}:`, message);
    throw new Error(message);
  }

  let fullText = "";
  let thinkingText = "";
  let inputTokens = 0;
  let outputTokens = 0;
  let cacheHitTokens: number | undefined;
  let cacheWriteTokens: number | undefined;
  let truncated = false;
  let completed = false;
  let inputUsageReported = false;
  let outputUsageReported = false;

  await consumeSse(response, callbacks, (data) => {
    let event: Record<string, unknown>;
    try {
      event = JSON.parse(data) as Record<string, unknown>;
    } catch {
      return;
    }

    switch (event.type) {
      case "message_start": {
        const message = event.message as { usage?: Record<string, number> } | undefined;
        const usage = message?.usage;
        if (usage) {
          inputUsageReported = hasReportedTokenCounts(usage.input_tokens, 0);
          inputTokens = usage.input_tokens ?? 0;
          cacheHitTokens = usage.cache_read_input_tokens;
          cacheWriteTokens = usage.cache_creation_input_tokens;
          if (inputTokens) callbacks.onInputTokens(inputTokens);
        }
        break;
      }
      case "content_block_delta": {
        const delta = event.delta as Record<string, unknown> | undefined;
        if (delta?.type === "text_delta" && typeof delta.text === "string") {
          fullText += delta.text;
          callbacks.onChunk(delta.text);
        } else if (delta?.type === "thinking_delta" && typeof delta.thinking === "string") {
          thinkingText += delta.thinking;
          callbacks.onThinking?.(delta.thinking);
        }
        break;
      }
      case "message_delta": {
        const usage = event.usage as Record<string, number> | undefined;
        if (usage && hasReportedTokenCounts(0, usage.output_tokens)) {
          outputUsageReported = true;
          outputTokens = usage.output_tokens;
        }
        const delta = event.delta as { stop_reason?: string } | undefined;
        if (delta?.stop_reason === "max_tokens") truncated = true;
        break;
      }
      case "message_stop":
        completed = true;
        break;
      case "error": {
        const error = event.error as { message?: string } | undefined;
        throw new Error(error?.message || "Stream error");
      }
    }
  });

  if (!completed) throw new Error("Incomplete Anthropic stream");
  callbacks.onComplete(outputTokens);
  return {
    fullText,
    inputTokens,
    outputTokens,
    cacheHitTokens,
    cacheWriteTokens,
    thinkingText: thinkingText || undefined,
    truncated,
    usageReported: inputUsageReported && outputUsageReported,
  };
}

async function streamOpenAi(
  opts: StreamProviderOptions,
  callbacks: StreamCallbacks,
): Promise<StreamResult> {
  const reasoning = opts.thinking === true && opts.supportsReasoning === true;
  const built = buildOpenAiChatRequest({
    baseUrl: opts.preset.baseUrl,
    apiKey: opts.apiKey,
    model: opts.model,
    messages: [{ role: "user", content: toChatContent(opts.content) }],
    maxTokens: opts.maxTokens,
    maxTokensParam: opts.preset.maxTokensParam,
    thinking: reasoning,
    reasoningEffort: reasoning ? (opts.reasoningEffort ?? "high") : undefined,
    reasoningKind: opts.preset.reasoningKind,
    headers: opts.preset.headers,
    stream: true,
    streamOptions:
      opts.preset.id === "openai" ? { include_usage: true } : undefined,
    signal: opts.signal,
  });

  log(`[Study Assist] ${opts.preset.label} streaming reasoning gate`, {
    model: opts.model,
    thinking: opts.thinking === true,
    supportsReasoning: opts.supportsReasoning === true,
    reasoningKind: opts.preset.reasoningKind ?? null,
    sent: built.body.reasoning_effort ?? built.body.thinking ?? null,
  });

  const response = await llmRequest({
    url: built.url,
    init: built.init,
    retries: 0,
    timeout: opts.thinking ? 600000 : 300000,
  });

  if (!response.ok) {
    const raw = await errorMessageFromResponse(response, "");
    const { error } = describeOpenAiError(response.status, raw, opts.preset.label);
    log(`[Study Assist] ${opts.preset.label} stream HTTP ${response.status}:`, error);
    throw new Error(error);
  }

  let fullText = "";
  let thinkingText = "";
  let inputTokens = 0;
  let outputTokens = 0;
  let cacheHitTokens: number | undefined;
  let truncated = false;
  let inputReported = false;
  let completed = false;
  let usageReported = false;

  await consumeSse(response, callbacks, (data) => {
    if (data === "[DONE]") { completed = true; return; }

    let event: Record<string, unknown>;
    try {
      event = JSON.parse(data) as Record<string, unknown>;
    } catch {
      return;
    }

    if (event.error) throw new Error((event.error as { message?: string }).message || "Stream error");
    const usage = event.usage as
      | {
          prompt_tokens?: number;
          completion_tokens?: number;
          prompt_cache_hit_tokens?: number;
          prompt_tokens_details?: { cached_tokens?: number };
        }
      | undefined;
    if (usage) {
      usageReported = hasReportedTokenCounts(usage.prompt_tokens, usage.completion_tokens);
      inputTokens = usage.prompt_tokens ?? inputTokens;
      outputTokens = usage.completion_tokens ?? outputTokens;
      cacheHitTokens =
        usage.prompt_cache_hit_tokens ??
        usage.prompt_tokens_details?.cached_tokens ??
        cacheHitTokens;
      if (inputTokens && !inputReported) {
        inputReported = true;
        callbacks.onInputTokens(inputTokens);
      }
    }

    const choices = event.choices as
      | Array<{
          delta?: {
            content?: string | null;
            reasoning_content?: string | null;
            reasoning?: string | null;
          };
          finish_reason?: string | null;
        }>
      | undefined;
    const choice = choices?.[0];
    if (!choice) return;

    const delta = choice.delta;
    if (typeof delta?.content === "string" && delta.content) {
      fullText += delta.content;
      callbacks.onChunk(delta.content);
    }
    const reasoningChunk = delta?.reasoning_content ?? delta?.reasoning;
    if (typeof reasoningChunk === "string" && reasoningChunk) {
      thinkingText += reasoningChunk;
      callbacks.onThinking?.(reasoningChunk);
    }
    if (choice.finish_reason === "length") truncated = true;
  });

  if (!completed) throw new Error("Incomplete OpenAI stream");
  callbacks.onComplete(outputTokens);

  return {
    fullText,
    inputTokens,
    outputTokens,
    cacheHitTokens,
    thinkingText: thinkingText || undefined,
    truncated,
    usageReported,
  };
}

async function streamOpenAiResponses(
  opts: StreamProviderOptions,
  callbacks: StreamCallbacks,
): Promise<StreamResult> {
  const built = buildOpenAiResponsesRequest({
    baseUrl: opts.preset.baseUrl,
    apiKey: opts.apiKey,
    model: opts.model,
    input: opts.content,
    stream: true,
    maxTokens: opts.maxTokens,
    headers: opts.preset.headers,
    signal: opts.signal,
  });

  const response = await llmRequest({
    url: built.url,
    init: built.init,
    retries: 0,
    timeout: opts.thinking ? 600000 : 300000,
  });

  if (!response.ok) {
    const raw = await errorMessageFromResponse(response, "");
    const { error } = describeOpenAiError(response.status, raw, opts.preset.label);
    log(`[Study Assist] ${opts.preset.label} responses HTTP ${response.status}:`, error);
    throw new Error(error);
  }

  let fullText = "";
  let thinkingText = "";
  let inputTokens = 0;
  let outputTokens = 0;
  let truncated = false;
  let inputReported = false;
  let completed = false;
  let usageReported = false;
  let errorKind: ProviderErrorKind | undefined;

  await consumeSse(response, callbacks, (data) => {
    if (data === "[DONE]") return;

    let event: Record<string, unknown>;
    try {
      event = JSON.parse(data) as Record<string, unknown>;
    } catch {
      return;
    }

    const type = event.type as string | undefined;
    switch (type) {
      case "response.output_text.delta":
        if (typeof event.delta === "string" && event.delta) {
          fullText += event.delta;
          callbacks.onChunk(event.delta);
        }
        break;
      case "response.reasoning_summary_text.delta":
      case "response.reasoning_text.delta":
        if (typeof event.delta === "string" && event.delta) {
          thinkingText += event.delta;
          callbacks.onThinking?.(event.delta);
        }
        break;
      case "response.completed":
      case "response.incomplete": {
        const payload = event.response as
          | {
              usage?: { input_tokens?: number; output_tokens?: number };
              incomplete_details?: { reason?: string | null };
            }
          | undefined;
        const usage = payload?.usage ?? (event.usage as { input_tokens?: number; output_tokens?: number } | undefined);
        if (usage) {
          usageReported = hasReportedTokenCounts(usage.input_tokens, usage.output_tokens);
          inputTokens = usage.input_tokens ?? inputTokens;
          outputTokens = usage.output_tokens ?? outputTokens;
          if (inputTokens && !inputReported) {
            inputReported = true;
            callbacks.onInputTokens(inputTokens);
          }
        }
        if (type === "response.incomplete") {
          const reason = payload?.incomplete_details?.reason;
          errorKind = reason === "max_output_tokens" ? "output_limit"
            : reason === "content_filter" ? "content_filter" : "incomplete";
          truncated = errorKind === "output_limit";
        }
        completed = true;
        break;
      }
      case "response.failed":
      case "error": {
        const responseError = (event.response as { error?: { message?: string } } | undefined)?.error;
        const directError = event.error as { message?: string } | undefined;
        throw new Error(
          responseError?.message || directError?.message || "Responses stream error",
        );
      }
    }
  });

  if (!completed) throw new Error("Incomplete Responses stream");
  if (!errorKind) callbacks.onComplete(outputTokens);

  return {
    fullText,
    inputTokens,
    outputTokens,
    thinkingText: thinkingText || undefined,
    truncated,
    usageReported,
    errorKind,
  };
}

/** Stream a request through the provider's dialect. */
export async function streamProvider(
  opts: StreamProviderOptions,
  callbacks: StreamCallbacks,
): Promise<StreamResult> {
  const count = (value: unknown): number => typeof value === "number" && Number.isFinite(value) ? Math.max(0, Math.floor(value)) : 0;
  const safeCallbacks = { ...callbacks, onInputTokens: (value: number) => callbacks.onInputTokens(count(value)), onComplete: (value: number) => callbacks.onComplete(count(value)) };
  const result = await (opts.preset.dialect === "anthropic" ? streamAnthropic(opts, safeCallbacks)
    : opts.preset.dialect === "openai-responses" ? streamOpenAiResponses(opts, safeCallbacks)
    : streamOpenAi(opts, safeCallbacks));
  return { ...result, inputTokens: count(result.inputTokens), outputTokens: count(result.outputTokens), cacheHitTokens: result.cacheHitTokens === undefined ? undefined : count(result.cacheHitTokens), cacheWriteTokens: result.cacheWriteTokens === undefined ? undefined : count(result.cacheWriteTokens) };
}
