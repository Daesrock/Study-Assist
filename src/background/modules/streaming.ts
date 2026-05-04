/**
 * Background Service Worker - Claude Streaming
 * Parses Server-Sent Events (SSE) from the Claude Messages API
 */

import { log, CLAUDE_API_BASE, ANTHROPIC_VERSION } from "./constants.js";
import type { ClaudeMessage } from "./constants.js";

// ============================================
// Types
// ============================================

export interface StreamCallbacks {
  onChunk: (text: string) => void;
  onInputTokens: (count: number) => void;
  onComplete: (outputTokens: number) => void;
  onError: (error: string) => void;
}

export interface StreamResult {
  fullText: string;
  inputTokens: number;
  outputTokens: number;
}

// ============================================
// Streaming Fetch
// ============================================

/**
 * Make a streaming request to the Claude Messages API and invoke callbacks
 * as SSE events arrive.
 */
export async function streamClaudeResponse(
  apiKey: string,
  model: string,
  messages: ClaudeMessage[],
  maxTokens: number,
  callbacks: StreamCallbacks,
  signal?: AbortSignal,
  thinking?: { type: string },
): Promise<StreamResult> {
  const body: Record<string, unknown> = {
    model,
    max_tokens: maxTokens,
    messages,
    stream: true,
  };
  if (thinking) {
    body.thinking = thinking;
  }
  const response = await fetch(CLAUDE_API_BASE, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-api-key": apiKey,
      "anthropic-version": ANTHROPIC_VERSION,
      "anthropic-dangerous-direct-browser-access": "true",
    },
    body: JSON.stringify(body),
    signal,
  });

  if (!response.ok) {
    const errorBody = await response.text();
    let errorMsg = `API Error (${response.status})`;
    try {
      const parsed = JSON.parse(errorBody);
      errorMsg = parsed.error?.message || errorMsg;
    } catch {
      /* keep generic message */
    }
    throw new Error(errorMsg);
  }

  const reader = response.body!.getReader();
  const decoder = new TextDecoder();
  let fullText = "";
  let inputTokens = 0;
  let outputTokens = 0;
  let buffer = "";

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split("\n");
      buffer = lines.pop() || "";

      for (const line of lines) {
        if (!line.startsWith("data: ")) continue;
        const data = line.slice(6).trim();
        if (!data || data === "[DONE]") continue;

        try {
          const event = JSON.parse(data) as Record<string, unknown>;

          switch (event.type) {
            case "message_start": {
              const msg = event.message as Record<string, unknown> | undefined;
              const usage = msg?.usage as Record<string, number> | undefined;
              if (usage?.input_tokens) {
                inputTokens = usage.input_tokens;
                callbacks.onInputTokens(inputTokens);
              }
              break;
            }

            case "content_block_delta": {
              const delta = event.delta as Record<string, unknown> | undefined;
              if (delta?.type === "text_delta" && typeof delta.text === "string") {
                fullText += delta.text;
                callbacks.onChunk(delta.text);
              }
              break;
            }

            case "message_delta": {
              const usage = event.usage as Record<string, number> | undefined;
              if (usage?.output_tokens) {
                outputTokens = usage.output_tokens;
              }
              break;
            }

            case "message_stop":
              callbacks.onComplete(outputTokens);
              break;

            case "error": {
              const err = event.error as Record<string, string> | undefined;
              callbacks.onError(err?.message || "Stream error");
              break;
            }
          }
        } catch {
          // Skip unparseable SSE lines
        }
      }
    }
  } catch (error) {
    if ((error as Error).name === "AbortError") throw error;
    callbacks.onError((error as Error).message);
    throw error;
  }

  return { fullText, inputTokens, outputTokens };
}
