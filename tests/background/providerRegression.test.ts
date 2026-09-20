import { afterEach, describe, expect, it, vi } from "vitest";
import { setLlmFetch } from "../../src/background/modules/llm/transport";
import { getPreset } from "../../src/background/modules/llm/registry";
import { runProvider } from "../../src/background/modules/llm/execute";
import { streamProvider } from "../../src/background/modules/llm/stream";
import { parsePrimaryResponse, extractQuickAnswer } from "../../src/background/modules/parsing";
import type { LlmDialect } from "../../src/background/modules/llm/contract";
import type { ClaudeContentBlock } from "../../src/background/modules/constants";

afterEach(() => setLlmFetch(undefined));
const content: ClaudeContentBlock[] = [
  { type: "text", text: "Question" },
  { type: "image", source: { type: "url", url: "https://example.com/image.png" } },
  { type: "image", source: { type: "base64", media_type: "image/png", data: "AAAA" } },
];
const opts = (dialect: LlmDialect) => ({ preset: { ...getPreset("openai"), dialect }, apiKey: "fake-key", model: "vision-model", content, maxTokens: 256 });
const sse = (events: unknown[]) => new Response(events.map(event => `data: ${typeof event === "string" ? event : JSON.stringify(event)}\n\n`).join(""), { headers: { "Content-Type": "text/event-stream" } });
const callbacks = () => ({ onChunk: vi.fn(), onInputTokens: vi.fn(), onComplete: vi.fn(), onError: vi.fn() });

describe("multimodal requests", () => {
  it.each(["openai-compatible", "openai-responses"] as const)("preserves every image in %s", async dialect => {
    const fetcher = vi.fn(async () => new Response(JSON.stringify({ choices: [{ message: { content: "OK" } }], output_text: "OK" })));
    setLlmFetch(fetcher);
    await runProvider(opts(dialect));
    const init = (fetcher.mock.calls as unknown as [string, RequestInit][])[0][1];
    const body = JSON.parse(init.body as string);
    const parts = dialect === "openai-compatible" ? body.messages[0].content : body.input[0].content;
    expect(parts).toHaveLength(3);
    expect(JSON.stringify(parts)).toContain("https://example.com/image.png");
    expect(JSON.stringify(parts)).toContain("data:image/png;base64,AAAA");
    expect(init.redirect).toBe("error");
    expect(init.credentials).toBe("omit");
  });
  it("requests Responses streaming explicitly and disables response storage", async () => {
    const fetcher = vi.fn(async () => sse([{ type: "response.output_text.delta", delta: "OK" }, { type: "response.completed", response: { usage: { input_tokens: 10, output_tokens: 2 } } }]));
    setLlmFetch(fetcher);
    const cb = callbacks();
    await streamProvider(opts("openai-responses"), cb);
    const body = JSON.parse((fetcher.mock.calls as unknown as [string, RequestInit][])[0][1].body as string);
    expect(body.stream).toBe(true);
    expect(body.store).toBe(false);
    expect(body.input[0].content).toHaveLength(3);
    expect(cb.onComplete).toHaveBeenCalledExactlyOnceWith(2);
  });
});

describe("terminal streaming errors", () => {
  it("does not forward untrusted token counters to the UI", async () => {
    setLlmFetch(async () => sse([{ usage: { prompt_tokens: "<img src=x>", completion_tokens: -3 } }, "[DONE]"]));
    const cb = callbacks();
    const result = await streamProvider(opts("openai-compatible"), cb);
    expect(result.inputTokens).toBe(0);
    expect(result.outputTokens).toBe(0);
    expect(cb.onInputTokens).toHaveBeenCalledWith(0);
  });
  it.each([
    ["anthropic", [{ type: "error", error: { message: "denied" } }]],
    ["anthropic", [{ type: "content_block_delta", delta: { type: "text_delta", text: "partial" } }]],
    ["openai-compatible", [{ error: { message: "denied" } }, "[DONE]"]],
    ["openai-compatible", [{ choices: [{ delta: { content: "partial" } }] }]],
    ["openai-responses", [{ type: "response.failed", response: { error: { message: "denied" } } }]],
    ["openai-responses", [{ type: "response.incomplete" }]],
    ["openai-responses", [{ type: "response.output_text.delta", delta: "partial" }]],
  ] as [LlmDialect, unknown[]][])("never completes successfully after %s failure %#", async (dialect, events) => {
    setLlmFetch(async () => sse(events));
    const cb = callbacks();
    await expect(streamProvider(opts(dialect), cb)).rejects.toThrow();
    expect(cb.onComplete).not.toHaveBeenCalled();
  });
  it("rejects invalid JSON instead of returning provider success", async () => {
    setLlmFetch(async () => new Response("not-json"));
    expect((await runProvider(opts("openai-compatible"))).result.success).toBe(false);
  });
});

describe("signed numerical answers", () => {
  it.each(["-12.5", "+3", "1e-6", "-2.4E+10", "0,25", "-.5", "1,234.5"])("preserves %s", value => {
    const context = { questionType: "numerical" } as any;
    expect(parsePrimaryResponse(`ANSWER: ${value}\nCONFIDENCE: HIGH`, context).result).toBe(value);
    expect(extractQuickAnswer(`ANSWER: ${value} meters`, "numerical")).toBe(value);
    expect(extractQuickAnswer(value, "numerical")).toBe(value);
  });
  it("does not extract intermediate numbers from reasoning", () => {
    expect(parsePrimaryResponse("Question 3 has 20 inputs", { questionType: "numerical" } as any).success).toBe(false);
  });
});
