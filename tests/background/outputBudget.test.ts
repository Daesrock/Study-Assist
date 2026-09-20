import { describe, expect, it, beforeEach } from "vitest";
import {
  computeOutputBudget,
  DEFAULT_OUTPUT_BUDGET,
  REASONING_OUTPUT_BUDGET,
  resolveOutputBudget,
} from "../../src/background/modules/llm/outputBudget";
import { __setPriceIndexForTests } from "../../src/background/modules/llm/pricing";

beforeEach(() => {
  __setPriceIndexForTests({
    "deepseek-reasoner": {
      inputPer1M: 1,
      outputPer1M: 1,
      vision: false,
      reasoning: true,
      maxOutput: 4096,
      provider: "deepseek",
    },
  });
});

describe("output budget policy", () => {
  it("allocates the larger budget when reasoning is enabled", () => {
    expect(computeOutputBudget(undefined, true)).toBe(REASONING_OUTPUT_BUDGET);
    expect(computeOutputBudget(undefined, false)).toBe(DEFAULT_OUTPUT_BUDGET);
  });

  it("never exceeds the known model output limit", () => {
    expect(computeOutputBudget(4096, true)).toBe(4096);
    expect(computeOutputBudget(4096, false)).toBe(4096);
  });

  it("keeps a valid positive budget for small models", () => {
    expect(computeOutputBudget(512, true)).toBe(512);
  });

  it("resolves the cached model cap for a provider role", async () => {
    await expect(resolveOutputBudget("deepseek", "deepseek-reasoner", true)).resolves.toBe(4096);
  });
});
