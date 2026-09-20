/**
 * Tests for the OpenAI Responses API adapter (`/responses`).
 */

import { describe, it, expect } from "vitest";
import {
  buildOpenAiResponsesRequest,
  parseOpenAiResponsesResponse,
} from "../../src/background/modules/llm/openaiResponses";

describe("buildOpenAiResponsesRequest", () => {
  it("builds a /responses request with auth, input and headers", () => {
    const { url, body, init } = buildOpenAiResponsesRequest({
      baseUrl: "https://gw.test/v1/",
      apiKey: "sk-test",
      model: "grok-4.6",
      input: "hi",
      maxTokens: 64,
      headers: { "x-opencode-session": "sess" },
    });

    expect(url).toBe("https://gw.test/v1/responses");
    expect(body).toMatchObject({ model: "grok-4.6", max_output_tokens: 64 });
    expect((body.input as Array<Record<string, unknown>>)[0]).toEqual({
      role: "user",
      content: [{ type: "input_text", text: "hi" }],
    });

    const headers = init.headers as Record<string, string>;
    expect(headers.Authorization).toBe("Bearer sk-test");
    expect(headers["x-opencode-session"]).toBe("sess");
  });
});

describe("parseOpenAiResponsesResponse", () => {
  it("extracts text, reasoning and usage from output items", () => {
    const parsed = parseOpenAiResponsesResponse({
      output: [
        { type: "reasoning", summary: [{ text: "thinking..." }] },
        { type: "message", content: [{ type: "output_text", text: "ANSWER: A" }] },
      ],
      status: "completed",
      usage: { input_tokens: 120, output_tokens: 30 },
    });

    expect(parsed.text).toBe("ANSWER: A");
    expect(parsed.reasoning).toBe("thinking...");
    expect(parsed.status).toBe("completed");
    expect(parsed.usage.inputTokens).toBe(120);
    expect(parsed.usage.outputTokens).toBe(30);
  });

  it("returns nulls for an empty payload", () => {
    const parsed = parseOpenAiResponsesResponse({});
    expect(parsed.text).toBeNull();
    expect(parsed.reasoning).toBeNull();
    expect(parsed.usage.inputTokens).toBe(0);
  });

  it("exposes an incomplete response status", () => {
    const parsed = parseOpenAiResponsesResponse({
      status: "incomplete",
      incomplete_details: { reason: "max_output_tokens" },
      output: [{ type: "reasoning", summary: [{ text: "partial reasoning" }] }],
    });
    expect(parsed.text).toBeNull();
    expect(parsed.status).toBe("incomplete");
    expect(parsed.incompleteReason).toBe("max_output_tokens");
  });
});
