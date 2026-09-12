/**
 * Tests for the hybrid auto-selection heuristic.
 */

import { describe, it, expect } from "vitest";
import {
  computeAutoSelection,
  isEligible,
} from "../../src/background/modules/llm/selection";
import type { SelectionCandidate } from "../../src/background/modules/llm/selection";

function cand(
  id: string,
  created: number | undefined,
  info: Partial<SelectionCandidate["info"]> = {},
): SelectionCandidate {
  return {
    id,
    created,
    info: {
      inputPer1M: info?.inputPer1M ?? 1,
      outputPer1M: info?.outputPer1M ?? 1,
      vision: info?.vision ?? false,
      reasoning: info?.reasoning ?? false,
      mode: info?.mode ?? "chat",
      deprecationDate: info?.deprecationDate ?? null,
    },
  };
}

describe("isEligible", () => {
  it("rejects non-chat and deprecated models", () => {
    const now = Date.parse("2026-01-01");
    expect(isEligible(cand("text-embedding-3-small", 1), now)).toBe(false);
    expect(isEligible(cand("gpt-4o-audio-preview", 1), now)).toBe(false);
    expect(
      isEligible(cand("old-model", 1, { deprecationDate: "2020-01-01" }), now),
    ).toBe(false);
    expect(isEligible(cand("gpt-5.1", 1), now)).toBe(true);
  });
});

describe("computeAutoSelection", () => {
  it("picks the most recent models", () => {
    const selected = computeAutoSelection(
      [cand("a", 1000), cand("b", 3000), cand("c", 2000)],
      { count: 2 },
    );
    expect(selected.slice(0, 2)).toEqual(["b", "c"]);
  });

  it("always includes the cheapest eligible model", () => {
    const selected = computeAutoSelection(
      [
        cand("recent1", 5000, { inputPer1M: 10, outputPer1M: 10 }),
        cand("recent2", 4000, { inputPer1M: 8, outputPer1M: 8 }),
        cand("recent3", 3000, { inputPer1M: 6, outputPer1M: 6 }),
        cand("recent4", 2000, { inputPer1M: 5, outputPer1M: 5 }),
        cand("cheap", 100, { inputPer1M: 0.1, outputPer1M: 0.1 }),
      ],
      { count: 4 },
    );
    expect(selected).toContain("cheap");
    expect(selected).toHaveLength(5);
  });

  it("falls back to capability when there are no timestamps", () => {
    const selected = computeAutoSelection([
      cand("plain", undefined, { reasoning: false, maxInput: 8000 }),
      cand("smart", undefined, { reasoning: true, maxInput: 200000 }),
    ]);
    expect(selected[0]).toBe("smart");
  });

  it("returns an empty list when nothing is eligible", () => {
    expect(computeAutoSelection([cand("text-embedding-3-large", 1)])).toEqual([]);
  });
});
