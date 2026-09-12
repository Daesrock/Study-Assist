/**
 * Tests for LiteLLM-driven cost calculation and usage tracking.
 */

import { describe, it, expect, beforeEach } from "vitest";
import { mockStorage } from "../setup";

import { estimateCost, trackUsage } from "../../src/background/modules/usageTracker";
import { __setPriceIndexForTests } from "../../src/background/modules/llm/pricing";

function clearStorage() {
  for (const key of Object.keys(mockStorage)) delete mockStorage[key];
}

const INDEX = {
  "claude-haiku-4-5-20251001": {
    inputPer1M: 1,
    outputPer1M: 5,
    cacheReadPer1M: 0.1,
    cacheWritePer1M: 1.25,
    vision: true,
    provider: "anthropic",
  },
  "deepseek-v4-flash": {
    inputPer1M: 0.44,
    outputPer1M: 1.32,
    cacheReadPer1M: 0.014,
    cacheWritePer1M: 0,
    vision: false,
    provider: "deepseek",
  },
};

describe("estimateCost", () => {
  beforeEach(() => {
    clearStorage();
    __setPriceIndexForTests(INDEX);
  });

  it("treats Anthropic input as already excluding cached tokens", async () => {
    const cost = await estimateCost("anthropic", "claude-haiku-4-5-20251001", {
      inputTokens: 1000,
      outputTokens: 500,
      cacheHitTokens: 2000,
      cacheWriteTokens: 100,
    });
    // 1000*1 + 2000*0.1 + 100*1.25 + 500*5 = 3825 / 1e6
    expect(cost).toBeCloseTo(0.003825, 10);
  });

  it("subtracts cached tokens from input for OpenAI-compatible providers", async () => {
    const cost = await estimateCost("deepseek", "deepseek-v4-flash", {
      inputTokens: 1000,
      outputTokens: 100,
      cacheHitTokens: 400,
    });
    // miss 600*0.44 + 400*0.014 + 100*1.32 = 401.6 / 1e6
    expect(cost).toBeCloseTo(0.0004016, 10);
  });

  it("returns null when the model has no price data", async () => {
    const cost = await estimateCost("openai", "custom-unknown-model", {
      inputTokens: 10,
      outputTokens: 10,
    });
    expect(cost).toBeNull();
  });
});

describe("trackUsage", () => {
  beforeEach(() => {
    clearStorage();
    __setPriceIndexForTests(INDEX);
  });

  it("stores the LiteLLM-computed cost", async () => {
    const record = await trackUsage({
      timestamp: Date.now(),
      questionText: "q",
      questionType: "multiple-choice",
      source: "claude",
      provider: "anthropic",
      role: "primary",
      model: "claude-haiku-4-5-20251001",
      inputTokens: 1000,
      outputTokens: 500,
      responseMode: "quick",
      success: true,
      latencyMs: 10,
    });
    expect(record.costUsd).toBeCloseTo((1000 * 1 + 500 * 5) / 1e6, 10);
  });

  it("omits costUsd for an unpriced model", async () => {
    const record = await trackUsage({
      timestamp: Date.now(),
      questionText: "q",
      questionType: "multiple-choice",
      source: "openai",
      provider: "openai",
      role: "primary",
      model: "custom-unknown-model",
      inputTokens: 10,
      outputTokens: 10,
      responseMode: "quick",
      success: true,
      latencyMs: 10,
    });
    expect(record.costUsd).toBeUndefined();
  });
});
