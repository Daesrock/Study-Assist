import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { setLlmFetch } from "../../src/background/modules/llm/transport";
import { __setPriceIndexForTests } from "../../src/background/modules/llm/pricing";
import { AnalysisSession } from "../../src/background/modules/analysisSession";
const mocks = vi.hoisted(() => ({ run: vi.fn(), track: vi.fn(), primary: true }));
vi.mock("../../src/background/modules/llm/execute", () => ({ runProvider: mocks.run }));
vi.mock("../../src/background/modules/usageTracker", () => ({ trackUsage: mocks.track, estimateCost: vi.fn() }));
vi.mock("../../src/background/modules/questionBank", () => ({ findMatchingQuestion: vi.fn(async () => null) }));
vi.mock("../../src/background/modules/rateLimiter", () => ({ checkRateLimit: vi.fn(() => null), recordRequest: vi.fn() }));
vi.mock("../../src/background/modules/llm/profiles", async () => {
  const { getPreset } = await import("../../src/background/modules/llm/registry");
  return {
    getRoles: async () => ({ primary: mocks.primary ? { provider: "openai", model: "primary" } : null, validator: { provider: "openai", model: "validator" } }),
    resolveRole: async (role: any) => role ? { ...role, preset: getPreset("openai"), apiKey: "fake", vision: true, thinking: false, reasoning: false } : null,
    canRoleHandle: () => true, resolveQaModel: async () => null,
  };
});
import { analyzeQuestion, analyzeQuestionStreaming } from "../../src/background/modules/api";
const context = { questionText: "What?", questionType: "multiple-choice", options: [{ letter: "A", text: "yes" }], pageTitle: "Quiz", pageUrl: "https://quiz.test", responseMode: "quick" };
const result = (text: string) => ({ result: { success: true, text, usage: { inputTokens: 10, outputTokens: 3 } }, raw: {}, requestBody: {}, url: "https://api.test", status: 200 });
beforeEach(() => { mocks.run.mockReset(); mocks.track.mockReset().mockResolvedValue({}); mocks.primary = true; });
afterEach(() => setLlmFetch(undefined));

describe("pipeline cancellation and accounting", () => {
  it("records a failed stream without inventing its missing cost and sends one terminal error", async () => {
    __setPriceIndexForTests({});
    setLlmFetch(async () => new Response('data: {"error":{"message":"failure"}}\n\n'));
    const port = { postMessage: vi.fn() };
    await analyzeQuestionStreaming(context, port as any);
    expect(mocks.track).toHaveBeenCalledTimes(1);
    expect(mocks.track.mock.calls[0][0]).toMatchObject({ success: false, usageComplete: false });
    expect(port.postMessage.mock.calls.filter(([message]) => message.type === "STREAM_ERROR")).toHaveLength(1);
    expect(port.postMessage.mock.calls.some(([message]) => message.type === "STREAM_COMPLETE")).toBe(false);
  });
  it("records both the medium-confidence primary and its validation", async () => {
    mocks.run.mockResolvedValueOnce(result("ANSWER: A\nCONFIDENCE: MEDIUM")).mockResolvedValueOnce(result("ANSWER: A"));
    expect((await analyzeQuestion(context)).success).toBe(true);
    expect(mocks.track).toHaveBeenCalledTimes(2);
    expect(mocks.track.mock.calls.map(([record]) => record.role)).toEqual(["primary", "validator"]);
    expect(mocks.track.mock.calls[0][0].analysisId).toBe(mocks.track.mock.calls[1][0].analysisId);
  });
  it.each([false, true])("cancellation skipPrimary=%s has the intended scope", async skip => {
    const session = new AnalysisSession();
    let started!: () => void;
    const ready = new Promise<void>(resolve => { started = resolve; });
    mocks.run.mockImplementationOnce((options: any) => new Promise(resolve => {
      options.signal.addEventListener("abort", () => resolve({ result: { success: false, cancelled: true, usage: { inputTokens: 0, outputTokens: 0 } }, raw: null, requestBody: {}, url: "https://api.test", status: null }), { once: true });
      started();
    })).mockResolvedValue(result("ANSWER: A"));
    const pending = analyzeQuestion(context, undefined, session);
    await ready;
    if (skip) session.skip(); else session.cancel();
    const answer = await pending;
    expect(answer.success).toBe(skip);
    expect(mocks.run).toHaveBeenCalledTimes(skip ? 2 : 1);
  });
  it("records both structural-validation attempts", async () => {
    mocks.primary = false;
    mocks.run.mockResolvedValueOnce(result("invalid")).mockResolvedValueOnce(result("A-1, B-2"));
    await analyzeQuestion({ ...context, questionType: "matching", categories: [{ letter: "A", text: "one" }, { letter: "B", text: "two" }], matchingOptions: [{ index: 1, text: "one" }, { index: 2, text: "two" }] });
    expect(mocks.run).toHaveBeenCalledTimes(2);
    expect(mocks.track).toHaveBeenCalledTimes(2);
    expect(mocks.track.mock.calls.map(([record]) => record.inputTokens)).toEqual([10, 10]);
  });
  it("cancelling one session does not cancel another", () => {
    const first = new AnalysisSession(), second = new AnalysisSession();
    first.cancel();
    expect(() => first.check()).toThrow();
    expect(() => second.check()).not.toThrow();
  });
});
