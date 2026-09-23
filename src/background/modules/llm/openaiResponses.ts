/**
 * OpenAI Responses API dialect adapter (`/responses`).
 *
 * Used by gateways that expose some models only through the Responses API
 * (e.g. OpenCode Go for Grok / GPT Luna / Muse Spark). Distinct from the
 * Chat Completions dialect: the request uses `input` and the response uses
 * `output` items instead of `choices`.
 */

import { hasReportedTokenCounts } from "./contract.js";
import type { NormalizedUsage } from "./contract.js";
import type { FetchOptionsWithSignal } from "../constants.js";
import type { ClaudeContentBlock } from "../constants.js";
import { toResponsesContent } from "./multimodal.js";

export interface OpenAiResponsesRequestInput {
  baseUrl: string;
  apiKey: string;
  model: string;
  /** Plain text prompt. */
  input: string | ClaudeContentBlock[];
  stream?: boolean;
  maxTokens: number;
  headers?: Record<string, string>;
  signal?: AbortSignal;
}

export interface BuiltOpenAiResponsesRequest {
  url: string;
  body: Record<string, unknown>;
  init: FetchOptionsWithSignal;
}

/** Build a `/responses` request for an OpenAI-compatible gateway. */
export function buildOpenAiResponsesRequest(
  input: OpenAiResponsesRequestInput,
): BuiltOpenAiResponsesRequest {
  const body: Record<string, unknown> = {
    model: input.model,
    input: [
      {
        role: "user",
        content: toResponsesContent(input.input),
      },
    ],
    max_output_tokens: input.maxTokens,
    store: false,
    ...(input.stream ? { stream: true } : {}),
  };

  return {
    url: `${input.baseUrl.replace(/\/+$/, "")}/responses`,
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

export interface ParsedOpenAiResponses {
  text: string | null;
  reasoning: string | null;
  usage: NormalizedUsage;
  usageReported: boolean;
  /** Responses API lifecycle status (e.g. `completed` or `incomplete`). */
  status?: string | null;
  /** Explicit reason supplied when the Responses API marks output incomplete. */
  incompleteReason?: string | null;
}

/** Extract text, reasoning and usage from a `/responses` response. */
export function parseOpenAiResponsesResponse(json: unknown): ParsedOpenAiResponses {
  const body = json as {
    output?: Array<{
      type?: string;
      content?: Array<{ type?: string; text?: string }>;
      summary?: Array<{ type?: string; text?: string }>;
    }>;
    output_text?: string;
    status?: string | null;
    incomplete_details?: { reason?: string | null } | null;
    usage?: {
      input_tokens?: number;
      output_tokens?: number;
      input_tokens_details?: { cached_tokens?: number };
    };
  };

  let text = "";
  let reasoning = "";
  for (const item of body?.output ?? []) {
    if (item.type === "message") {
      for (const part of item.content ?? []) {
        if (part.type === "output_text" && typeof part.text === "string") {
          text += part.text;
        }
      }
    } else if (item.type === "reasoning") {
      for (const part of item.summary ?? []) {
        if (typeof part.text === "string") reasoning += part.text;
      }
    }
  }
  if (!text && typeof body?.output_text === "string") text = body.output_text;

  return {
    text: text || null,
    reasoning: reasoning || null,
    status: body?.status ?? null,
    incompleteReason: body?.incomplete_details?.reason ?? null,
    usageReported: hasReportedTokenCounts(body?.usage?.input_tokens, body?.usage?.output_tokens),
    usage: {
      inputTokens: body?.usage?.input_tokens ?? 0,
      outputTokens: body?.usage?.output_tokens ?? 0,
      cacheHitTokens: body?.usage?.input_tokens_details?.cached_tokens,
    },
  };
}
