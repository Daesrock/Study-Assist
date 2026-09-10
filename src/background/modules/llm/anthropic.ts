/**
 * Anthropic Messages dialect adapter.
 *
 * Handles the native Anthropic `/v1/messages` wire shape: `x-api-key`
 * auth, content blocks, and `thinking` configuration.
 */

import type { ClaudeMessage } from "../constants.js";
import { ANTHROPIC_VERSION } from "../constants.js";
import type { FetchOptionsWithSignal } from "../constants.js";
import type { NormalizedUsage } from "./contract.js";

export interface AnthropicMessagesRequestInput {
  baseUrl: string;
  apiKey: string;
  model: string;
  messages: ClaudeMessage[];
  maxTokens: number;
  thinking?: { type: string; budget_tokens?: number };
  signal?: AbortSignal;
}

export interface BuiltAnthropicRequest {
  url: string;
  body: Record<string, unknown>;
  init: FetchOptionsWithSignal;
}

/** Build an Anthropic Messages API request. */
export function buildAnthropicMessagesRequest(
  input: AnthropicMessagesRequestInput,
): BuiltAnthropicRequest {
  const body: Record<string, unknown> = {
    model: input.model,
    max_tokens: input.maxTokens,
    messages: input.messages,
  };
  if (input.thinking) {
    body.thinking = input.thinking;
  }

  return {
    url: `${input.baseUrl.replace(/\/+$/, "")}/v1/messages`,
    body,
    init: {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": input.apiKey,
        "anthropic-version": ANTHROPIC_VERSION,
        "anthropic-dangerous-direct-browser-access": "true",
      },
      body: JSON.stringify(body),
      signal: input.signal,
    },
  };
}

export interface ParsedAnthropicResponse {
  text: string | null;
  reasoning: string | null;
  usage: NormalizedUsage;
}

/** Extract text, thinking and usage from an Anthropic Messages response. */
export function parseAnthropicMessagesResponse(json: unknown): ParsedAnthropicResponse {
  const body = json as {
    content?: Array<{ type?: string; text?: string; thinking?: string }>;
    usage?: {
      input_tokens?: number;
      output_tokens?: number;
      cache_read_input_tokens?: number;
      cache_creation_input_tokens?: number;
    };
  };
  const blocks = body?.content ?? [];
  const textBlock = blocks.find((block) => block.type === "text");
  const thinkingBlock = blocks.find((block) => block.type === "thinking");

  return {
    text: textBlock?.text ?? null,
    reasoning: thinkingBlock?.thinking ?? null,
    usage: {
      inputTokens: body?.usage?.input_tokens ?? 0,
      outputTokens: body?.usage?.output_tokens ?? 0,
      cacheHitTokens: body?.usage?.cache_read_input_tokens,
      cacheWriteTokens: body?.usage?.cache_creation_input_tokens,
    },
  };
}

// Streaming wrapper: the Anthropic SSE parser currently lives in
// `../streaming.js`; re-exported here so the orchestrator has a single
// dialect entry point. It will move fully into this module in a later step.
export { streamClaudeResponse as streamAnthropicMessages } from "../streaming.js";
export type { StreamCallbacks as AnthropicStreamCallbacks } from "../streaming.js";
