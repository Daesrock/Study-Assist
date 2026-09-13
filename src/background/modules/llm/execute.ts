/**
 * Unified provider execution
 *
 * `runProvider` dispatches to the right dialect adapter (Anthropic vs
 * OpenAI-compatible), performs the request through the injectable
 * transport, normalizes usage and maps HTTP failures to `ProviderError`.
 * The orchestrator consumes `ProviderResult` and never touches wire shapes.
 */

import { getClaudeThinkingConfig, log } from "../constants.js";
import type { ClaudeApiResponse, ClaudeContentBlock, ClaudeMessage } from "../constants.js";
import { handleApiError } from "../parsing.js";
import type {
  NormalizedUsage,
  ProviderError,
  ProviderErrorKind,
  ProviderPreset,
  ProviderResult,
} from "./contract.js";
import { llmRequest } from "./transport.js";
import {
  buildOpenAiChatRequest,
  parseOpenAiChatResponse,
  describeOpenAiError,
} from "./openaiCompat.js";
import {
  buildAnthropicMessagesRequest,
  parseAnthropicMessagesResponse,
} from "./anthropic.js";
import {
  buildOpenAiResponsesRequest,
  parseOpenAiResponsesResponse,
} from "./openaiResponses.js";

const EMPTY_USAGE: NormalizedUsage = { inputTokens: 0, outputTokens: 0 };

export interface ProviderRunOptions {
  preset: ProviderPreset;
  apiKey: string;
  model: string;
  content: string | ClaudeContentBlock[];
  maxTokens: number;
  thinking?: boolean;
  /** Whether the resolved model actually supports reasoning/effort params. */
  supportsReasoning?: boolean;
  /** Whether the model supports Anthropic adaptive thinking. */
  supportsAdaptiveThinking?: boolean;
  reasoningEffort?: "low" | "medium" | "high";
  retries?: number;
  timeout?: number;
  signal?: AbortSignal;
}

export interface ProviderRunResult {
  result: ProviderResult;
  /** HTTP status, or null when the request never completed. */
  status: number | null;
  /** Raw parsed JSON body (dev trace). */
  raw: unknown;
  /** Request body actually sent (dev trace). */
  requestBody: Record<string, unknown>;
  url: string;
}

function blocksToText(content: string | ClaudeContentBlock[]): string {
  if (typeof content === "string") return content;
  return content
    .filter((block): block is Extract<ClaudeContentBlock, { type: "text" }> => block.type === "text")
    .map((block) => block.text)
    .join("\n");
}

function buildRequest(opts: ProviderRunOptions): {
  url: string;
  body: Record<string, unknown>;
  init: import("../constants.js").FetchOptionsWithSignal;
} {
  const { preset } = opts;
  const reasoning = opts.thinking === true && opts.supportsReasoning === true;

  if (preset.dialect === "anthropic") {
    const messages: ClaudeMessage[] = [{ role: "user", content: opts.content }];
    return buildAnthropicMessagesRequest({
      baseUrl: preset.baseUrl,
      apiKey: opts.apiKey,
      model: opts.model,
      messages,
      maxTokens: opts.maxTokens,
      thinking: reasoning
        ? getClaudeThinkingConfig(opts.model, opts.supportsAdaptiveThinking)
        : undefined,
      headers: preset.headers,
      signal: opts.signal,
    });
  }

  if (preset.dialect === "openai-responses") {
    return buildOpenAiResponsesRequest({
      baseUrl: preset.baseUrl,
      apiKey: opts.apiKey,
      model: opts.model,
      input: blocksToText(opts.content),
      maxTokens: opts.maxTokens,
      headers: preset.headers,
      signal: opts.signal,
    });
  }

  return buildOpenAiChatRequest({
    baseUrl: preset.baseUrl,
    apiKey: opts.apiKey,
    model: opts.model,
    messages: [{ role: "user", content: blocksToText(opts.content) }],
    maxTokens: opts.maxTokens,
    maxTokensParam: preset.maxTokensParam,
    thinking: reasoning,
    reasoningEffort: reasoning ? (opts.reasoningEffort ?? "high") : undefined,
    reasoningKind: preset.reasoningKind,
    headers: preset.headers,
    signal: opts.signal,
  });
}

function statusToKind(status: number): ProviderErrorKind {
  switch (status) {
    case 401:
    case 403:
      return "auth";
    case 429:
      return "rate_limit";
    case 400:
    case 404:
    case 422:
      return "bad_request";
    case 402:
      return "insufficient_balance";
    case 500:
    case 502:
    case 503:
    case 529:
      return "overloaded";
    default:
      return "unknown";
  }
}

function mapError(preset: ProviderPreset, status: number, raw: unknown): ProviderError {
  const kind = statusToKind(status);

  if (preset.dialect === "anthropic") {
    const response = handleApiError(status, raw as ClaudeApiResponse | null);
    return {
      kind,
      message: response.error || `Anthropic API Error (${status})`,
      retryable: false,
      status,
    };
  }

  const errorMsg =
    ((raw as { error?: { message?: string } } | null)?.error?.message) || "";
  const { error, skipRetry } = describeOpenAiError(status, errorMsg, preset.label);
  return { kind, message: error, retryable: !skipRetry, status };
}

function parseResponse(preset: ProviderPreset, raw: unknown) {
  if (preset.dialect === "anthropic") return parseAnthropicMessagesResponse(raw);
  if (preset.dialect === "openai-responses") return parseOpenAiResponsesResponse(raw);
  return parseOpenAiChatResponse(raw);
}

export async function runProvider(opts: ProviderRunOptions): Promise<ProviderRunResult> {
  const built = buildRequest(opts);

  log(`[Study Assist] ${opts.preset.label} reasoning gate`, {
    model: opts.model,
    dialect: opts.preset.dialect,
    thinking: opts.thinking === true,
    supportsReasoning: opts.supportsReasoning === true,
    reasoningKind: opts.preset.reasoningKind ?? null,
    sent: built.body.reasoning_effort ?? built.body.thinking ?? null,
  });

  let response: Response;
  try {
    response = await llmRequest({
      url: built.url,
      init: built.init,
      retries: opts.retries ?? 2,
      timeout: opts.timeout ?? 30000,
    });
  } catch (error) {
    if ((error as Error).name === "AbortError") {
      return {
        result: {
          success: false,
          usage: { ...EMPTY_USAGE },
          cancelled: true,
          error: { kind: "timeout", message: "Request aborted", retryable: false },
        },
        status: null,
        raw: null,
        requestBody: built.body,
        url: built.url,
      };
    }
    log(
      `[Study Assist] ${opts.preset.label} request failed for ${opts.model}:`,
      (error as Error).message,
    );
    return {
      result: {
        success: false,
        usage: { ...EMPTY_USAGE },
        error: { kind: "network", message: (error as Error).message, retryable: true },
      },
      status: null,
      raw: null,
      requestBody: built.body,
      url: built.url,
    };
  }

  let raw: unknown = null;
  try {
    raw = await response.clone().json();
  } catch (error) {
    raw = { parseError: (error as Error).message };
  }

  if (!response.ok) {
    log(
      `[Study Assist] ${opts.preset.label} HTTP ${response.status} for ${opts.model}:`,
      raw,
    );
    return {
      result: {
        success: false,
        usage: { ...EMPTY_USAGE },
        error: mapError(opts.preset, response.status, raw),
      },
      status: response.status,
      raw,
      requestBody: built.body,
      url: built.url,
    };
  }

  const parsed = parseResponse(opts.preset, raw);
  return {
    result: {
      success: true,
      text: parsed.text ?? undefined,
      reasoning: parsed.reasoning,
      usage: parsed.usage,
    },
    status: response.status,
    raw,
    requestBody: built.body,
    url: built.url,
  };
}
