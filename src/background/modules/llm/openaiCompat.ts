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
  /** Field name for the token limit (`max_completion_tokens` on OpenAI). */
  maxTokensParam?: "max_tokens" | "max_completion_tokens";
  /** DeepSeek-style thinking toggle (used only by `reasoningKind: "deepseek"`). */
  thinking?: boolean;
  reasoningEffort?: "low" | "medium" | "high";
  reasoningKind?: ReasoningKind;
  /** Extra request headers (merged on top of the defaults). */
  headers?: Record<string, string>;
  /** When true, adds `stream: true` for SSE responses. */
  stream?: boolean;
  /** Extra streaming options (e.g. `{ include_usage: true }` for OpenAI). */
  streamOptions?: Record<string, unknown>;
  signal?: AbortSignal;
}

export interface BuiltOpenAiRequest {
  url: string;
  body: Record<string, unknown>;
  init: FetchOptionsWithSignal;
}

/** Build a `/chat/completions` request for an OpenAI-compatible provider. */
export function buildOpenAiChatRequest(input: OpenAiChatRequestInput): BuiltOpenAiRequest {
  const tokenParam = input.maxTokensParam ?? "max_tokens";
  const body: Record<string, unknown> = {
    model: input.model,
    [tokenParam]: input.maxTokens,
    messages: input.messages,
  };

  const kind = input.reasoningKind ?? "openai-effort";
  if (kind === "deepseek") {
    // Only reasoning-capable DeepSeek models accept the thinking toggle.
    if (input.thinking) {
      body.thinking = { type: "enabled" };
      body.reasoning_effort = input.reasoningEffort ?? "high";
    }
  } else if (kind === "openai-effort" && input.reasoningEffort) {
    body.reasoning_effort = input.reasoningEffort;
  }

  if (input.stream) {
    body.stream = true;
    if (input.streamOptions) body.stream_options = input.streamOptions;
  }

  return {
    url: `${input.baseUrl.replace(/\/+$/, "")}/chat/completions`,
    body,
    init: {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${input.apiKey}`,
        ...(input.headers ?? {}),
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
      prompt_tokens_details?: { cached_tokens?: number };
    };
  };
  const message = body?.choices?.[0]?.message;
  const cacheHit =
    body?.usage?.prompt_cache_hit_tokens ??
    body?.usage?.prompt_tokens_details?.cached_tokens;
  return {
    text: message?.content ?? null,
    reasoning: message?.reasoning_content ?? message?.reasoning ?? null,
    usage: {
      inputTokens: body?.usage?.prompt_tokens ?? 0,
      outputTokens: body?.usage?.completion_tokens ?? 0,
      cacheHitTokens: cacheHit,
    },
  };
}

/** Non-retryable HTTP statuses that should skip retry and fall back. */
export const NON_RETRYABLE_STATUSES = [400, 401, 402, 422, 429, 503];

/**
 * Map an HTTP failure to a user-facing message + retry policy.
 * `label` keeps the provider name in the message (e.g. "OpenAI").
 */
export function describeOpenAiError(
  status: number,
  errorMsg: string,
  label = "Provider",
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
      error = `${label}: Rate limit reached. Switching to the validator.`;
      break;
    case 500:
      error = `${label}: Server error. ${errorMsg}`;
      break;
    case 503:
      error = `${label}: Server overloaded. Switching to the validator.`;
      break;
    default:
      error = `${label} API Error (${status}): ${errorMsg}`;
      break;
  }

  return { error, skipRetry };
}
