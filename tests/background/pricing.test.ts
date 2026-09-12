/**
 * Tests for the LiteLLM-derived price index: trimming, lookup and matching.
 */

import { describe, it, expect, beforeEach } from "vitest";
import { mockStorage } from "../setup";

import {
  buildPriceIndex,
  lookupModelInfo,
  toPriceInfo,
  resolveModelInfo,
  computeUsageCost,
  __setPriceIndexForTests,
} from "../../src/background/modules/llm/pricing";
import type { PriceIndex } from "../../src/background/modules/llm/pricing";

function clearStorage() {
  for (const key of Object.keys(mockStorage)) delete mockStorage[key];
}

describe("toPriceInfo", () => {
  it("converts per-token costs to per-1M and keeps vision/context", () => {
    const info = toPriceInfo({
      litellm_provider: "anthropic",
      input_cost_per_token: 0.000001,
      output_cost_per_token: 0.000005,
      supports_vision: true,
      max_input_tokens: 200000,
      max_output_tokens: 64000,
      mode: "chat",
    });

    expect(info).toEqual({
      inputPer1M: 1,
      outputPer1M: 5,
      cacheReadPer1M: null,
      cacheWritePer1M: null,
      vision: true,
      reasoning: null,
      adaptive: null,
      deprecationDate: null,
      maxInput: 200000,
      maxOutput: 64000,
      provider: "anthropic",
      mode: "chat",
    });
  });

  it("keeps reasoning and deprecation metadata", () => {
    const info = toPriceInfo({
      litellm_provider: "openai",
      input_cost_per_token: 0.000001,
      output_cost_per_token: 0.00001,
      supports_reasoning: true,
      deprecation_date: "2027-02-05",
    });
    expect(info?.reasoning).toBe(true);
    expect(info?.deprecationDate).toBe("2027-02-05");
  });

  it("maps an absent supports_vision to null", () => {
    const info = toPriceInfo({
      litellm_provider: "deepseek",
      input_cost_per_token: 0.00000044,
      output_cost_per_token: 0.00000132,
    });
    expect(info?.vision).toBeNull();
  });

  it("ignores unsupported providers and entries without pricing", () => {
    expect(toPriceInfo({ litellm_provider: "bedrock", input_cost_per_token: 1 })).toBeNull();
    expect(toPriceInfo({ litellm_provider: "openai" })).toBeNull();
    expect(toPriceInfo(null)).toBeNull();
  });
});

describe("buildPriceIndex", () => {
  it("keeps only the supported providers", () => {
    const index = buildPriceIndex({
      "claude-haiku-4-5-20251001": {
        litellm_provider: "anthropic",
        input_cost_per_token: 0.000001,
        output_cost_per_token: 0.000005,
      },
      "some-bedrock-model": {
        litellm_provider: "bedrock",
        input_cost_per_token: 0.000001,
        output_cost_per_token: 0.000001,
      },
    });

    expect(Object.keys(index)).toEqual(["claude-haiku-4-5-20251001"]);
  });
});

describe("lookupModelInfo", () => {
  const index: PriceIndex = {
    "claude-haiku-4-5-20251001": { inputPer1M: 1, outputPer1M: 5, vision: true, provider: "anthropic" },
    "deepseek/deepseek-v4-flash": { inputPer1M: 0.44, outputPer1M: 1.32, vision: false, provider: "deepseek" },
    "gpt-5.1": { inputPer1M: 1.25, outputPer1M: 10, vision: true, provider: "openai" },
  };

  it("matches an exact key", () => {
    expect(lookupModelInfo(index, "anthropic", "claude-haiku-4-5-20251001")?.inputPer1M).toBe(1);
  });

  it("matches a provider-prefixed key", () => {
    expect(lookupModelInfo(index, "deepseek", "deepseek-v4-flash")?.outputPer1M).toBe(1.32);
  });

  it("matches ignoring a date suffix", () => {
    expect(lookupModelInfo(index, "anthropic", "claude-haiku-4-5")?.provider).toBe("anthropic");
  });

  it("returns null for unknown models", () => {
    expect(lookupModelInfo(index, "openai", "totally-unknown")).toBeNull();
  });
});

describe("resolveModelInfo", () => {
  beforeEach(() => {
    clearStorage();
    __setPriceIndexForTests(null);
  });

  it("reads from the injected index", async () => {
    __setPriceIndexForTests({
      "gpt-5.1": { inputPer1M: 1.25, outputPer1M: 10, vision: true, provider: "openai" },
    });
    const info = await resolveModelInfo("openai", "gpt-5.1");
    expect(info?.vision).toBe(true);
  });
});

describe("computeUsageCost", () => {
  it("prices non-cached input, cache read/write and output", () => {
    const info = {
      inputPer1M: 1,
      outputPer1M: 5,
      cacheReadPer1M: 0.1,
      cacheWritePer1M: 1.25,
      vision: true,
    };
    const cost = computeUsageCost(info, {
      inputTokens: 1000,
      outputTokens: 500,
      cacheHitTokens: 2000,
      cacheWriteTokens: 100,
    });
    // (1000*1 + 2000*0.1 + 100*1.25 + 500*5) / 1e6
    expect(cost).toBeCloseTo(0.003825, 10);
  });

  it("falls back to the input price when cache rates are missing", () => {
    const info = {
      inputPer1M: 2,
      outputPer1M: 4,
      cacheReadPer1M: null,
      cacheWritePer1M: null,
      vision: true,
    };
    const cost = computeUsageCost(info, {
      inputTokens: 0,
      outputTokens: 0,
      cacheHitTokens: 1000,
      cacheWriteTokens: 1000,
    });
    expect(cost).toBeCloseTo(0.004, 10);
  });
});
