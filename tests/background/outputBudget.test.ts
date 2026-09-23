import { describe, expect, it, beforeEach } from "vitest";
import {
  computeOutputBudget,
  DEFAULT_OUTPUT_BUDGET,
  OUTPUT_BUDGET_CEILING,
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
    "deepseek-v4-flash": {
      inputPer1M: 1,
      outputPer1M: 1,
      vision: false,
      reasoning: true,
      maxOutput: 393216,
      provider: "deepseek",
    },
  });
});

describe("output budget policy", () => {
  it("uses model-aware defaults when the model limit is unknown", () => {
    expect(DEFAULT_OUTPUT_BUDGET).toBe(16384);
    expect(REASONING_OUTPUT_BUDGET).toBe(32768);
    expect(computeOutputBudget(undefined, true)).toBe(REASONING_OUTPUT_BUDGET);
    expect(computeOutputBudget(undefined, false)).toBe(DEFAULT_OUTPUT_BUDGET);
  });

  it("follows the known model output limit", () => {
    expect(computeOutputBudget(4096, true)).toBe(4096);
    expect(computeOutputBudget(4096, false)).toBe(4096);
    expect(computeOutputBudget(8192, false)).toBe(8192);
  });

  it("caps huge catalog limits at the safety ceiling", () => {
    expect(OUTPUT_BUDGET_CEILING).toBe(65536);
    expect(computeOutputBudget(393216, true)).toBe(OUTPUT_BUDGET_CEILING);
    expect(computeOutputBudget(65536, true)).toBe(65536);
  });

  it("keeps a valid positive budget for small models", () => {
    expect(computeOutputBudget(512, true)).toBe(512);
  });

  it("resolves the cached model cap for a provider role", async () => {
    await expect(resolveOutputBudget("deepseek", "deepseek-reasoner", true)).resolves.toBe(4096);
  });

  it("does not truncate a large-output reasoning model (deepseek-v4 repro)", async () => {
    await expect(resolveOutputBudget("deepseek", "deepseek-v4-flash", true)).resolves.toBe(
      OUTPUT_BUDGET_CEILING,
    );
  });
});
