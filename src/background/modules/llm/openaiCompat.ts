/**
 * OpenAI-compatible dialect adapter.
 *
 * Handles the `/chat/completions` wire shape shared by OpenAI, DeepSeek,
 * xAI, Groq, Mistral, Together, OpenRouter and most gateways. In the
 * current pipeline DeepSeek is the only consumer; OpenAI et al. reuse it
 * by adding a preset.
 */

import type { NormalizedUsage, ReasoningKind } from "./contract.js";
import type { FetchOptionsWithSignal } from "../constants.js";

export interface OpenAiChatMessage {
  role: "system" | "user" | "assistant";
  content: string;
}

export interface OpenAiChatRequestInput {
  baseUrl: string;
  apiKey: string;
  model: string;
  messages: OpenAiChatMessage[];
  maxTokens: number;
  /** DeepSeek-style thinking toggle (used only by `reasoningKind: "deepseek"`). */
  thinking?: boolean;
  reasoningEffort?: "low" | "medium" | "high";
  reasoningKind?: ReasoningKind;
  signal?: AbortSignal;
}

export interface BuiltOpenAiRequest {
  url: string;
  body: Record<string, unknown>;
  init: FetchOptionsWithSignal;
}

/** Build a `/chat/completions` request for an OpenAI-compatible provider. */
export function buildOpenAiChatRequest(input: OpenAiChatRequestInput): BuiltOpenAiRequest {
  const body: Record<string, unknown> = {
    model: input.model,
    max_tokens: input.maxTokens,
    messages: input.messages,
  };

  const kind = input.reasoningKind ?? "openai-effort";
  if (kind === "deepseek") {
    body.thinking = { type: input.thinking === false ? "disabled" : "enabled" };
    body.reasoning_effort = input.reasoningEffort ?? "high";
  } else if (kind === "openai-effort" && input.reasoningEffort) {
    body.reasoning_effort = input.reasoningEffort;
  }

  return {
    url: `${input.baseUrl.replace(/\/+$/, "")}/chat/completions`,
    body,
    init: {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${input.apiKey}`,
      },
      body: JSON.stringify(body),
      signal: input.signal,
    },
  };
}

export interface ParsedOpenAiResponse {
  text: string | null;
  reasoning: string | null;
  usage: NormalizedUsage;
}

/** Extract text, reasoning and usage from a `/chat/completions` response. */
export function parseOpenAiChatResponse(json: unknown): ParsedOpenAiResponse {
  const body = json as {
    choices?: Array<{
      message?: {
        content?: string | null;
        reasoning_content?: string | null;
        reasoning?: string | null;
      };
    }>;
    usage?: {
      prompt_tokens?: number;
      completion_tokens?: number;
      prompt_cache_hit_tokens?: number;
    };
  };
  const message = body?.choices?.[0]?.message;
  return {
    text: message?.content ?? null,
    reasoning: message?.reasoning_content ?? message?.reasoning ?? null,
    usage: {
      inputTokens: body?.usage?.prompt_tokens ?? 0,
      outputTokens: body?.usage?.completion_tokens ?? 0,
      cacheHitTokens: body?.usage?.prompt_cache_hit_tokens,
    },
  };
}

/** Non-retryable HTTP statuses that should skip retry and fall back. */
export const NON_RETRYABLE_STATUSES = [400, 401, 402, 422, 429, 503];

/**
 * Map an HTTP failure to a user-facing message + retry policy.
 * `label` keeps the provider name in the message (e.g. "DeepSeek").
 */
export function describeOpenAiError(
  status: number,
  errorMsg: string,
  label = "DeepSeek",
): { error: string; skipRetry: boolean } {
  const skipRetry = NON_RETRYABLE_STATUSES.includes(status);
  let error: string;

  switch (status) {
    case 400:
      error = `${label}: Invalid request format. ${errorMsg}`;
      break;
    case 401:
      error = `${label}: Authentication failed. Check your API key.`;
      break;
    case 402:
      error = `${label}: Insufficient balance. Please top up your account.`;
      break;
    case 422:
      error = `${label}: Invalid parameters. ${errorMsg}`;
      break;
    case 429:
      error = `${label}: Rate limit reached. Switching to Claude.`;
      break;
    case 500:
      error = `${label}: Server error. ${errorMsg}`;
      break;
    case 503:
      error = `${label}: Server overloaded. Switching to Claude.`;
      break;
    default:
      error = `${label} API Error (${status}): ${errorMsg}`;
      break;
  }

  return { error, skipRetry };
}
