import { describe, it, expect } from "vitest";
import { __testOnlyApiMatching } from "../../src/background/modules/api";
import type { AnalysisContext } from "../../src/types/index";

const { matchSingleAnswerToLetter, matchCorrectAnswerToLetter, validateMatchingAnswer } = __testOnlyApiMatching;

const FINAL_EXAM_005_OPTIONS = [
  {
    letter: "A",
    text: "(config)# interface vlan 1\n(config-if)# ip address 192.168.1.2 255.255.255.0\n(config-if)# no shutdown",
  },
  {
    letter: "B",
    text: "(config)# interface gigabitethernet 1/1\n(config-if)# no switchport\n(config-if)# ip address 192.168.1.2 255.255.255.252",
  },
  {
    letter: "C",
    text: "(config)# ip routing",
  },
  {
    letter: "D",
    text: "(config)# interface gigabitethernet1/1\n(config-if)# switchport mode trunk",
  },
  {
    letter: "E",
    text: "(config)# interface fastethernet0/4\n(config-if)# switchport mode trunk",
  },
];

describe("api multi-answer option matching", () => {
  it("should match final-exam_005 answers as B, C", () => {
    const result = matchCorrectAnswerToLetter(
      {
        correctAnswers: [
          "(config)# interface gigabitethernet 1/1\n(config-if)# no switchport\n(config-if)# ip address 192.168.1.2 255.255.255.252",
          "(config)# ip routing",
        ],
      },
      FINAL_EXAM_005_OPTIONS,
    );

    expect(result).toBe("B, C");
  });

  it("should not map long command blocks to short command snippets", () => {
    const mergedAnswer = "(config)# interface gigabitethernet 1/1\n(config-if)# no switchport\n(config-if)# ip address 192.168.1.2 255.255.255.252\n(config)# ip routing";

    const letter = matchSingleAnswerToLetter(mergedAnswer, FINAL_EXAM_005_OPTIONS);

    expect(letter).toBe("B");
  });

  it("should avoid reusing the same option letter for multi-answer mappings", () => {
    const mergedAnswer = "(config)# interface gigabitethernet 1/1\n(config-if)# no switchport\n(config-if)# ip address 192.168.1.2 255.255.255.252\n(config)# ip routing";

    const result = matchCorrectAnswerToLetter(
      {
        correctAnswers: [mergedAnswer, "(config)# ip routing"],
      },
      FINAL_EXAM_005_OPTIONS,
    );

    expect(result).toBe("B, C");
  });
});

// ============================================
// Matching Answer Validation
// ============================================

function makeMatchingContext(overrides: Partial<AnalysisContext> = {}): AnalysisContext {
  return {
    questionText: "Match each concept to its definition.",
    questionType: "matching",
    categories: [
      { letter: "A", text: "Concepto uno" },
      { letter: "B", text: "Concepto dos" },
      { letter: "C", text: "Concepto tres" },
    ],
    matchingOptions: [
      { index: 1, text: "Definición primera" },
      { index: 2, text: "Definición segunda" },
      { index: 3, text: "Definición tercera" },
    ],
    matchingStyle: "drag-drop",
    pageTitle: "Moodle Quiz",
    pageUrl: "https://www.educa-t.unach.mx/mod/quiz",
    responseMode: "quick",
    ...overrides,
  };
}

describe("validateMatchingAnswer", () => {
  it("should accept valid matching answer with ANSWER prefix", () => {
    const result = validateMatchingAnswer(
      "ANSWER: A-1, B-2, C-3\nCONFIDENCE: HIGH",
      makeMatchingContext(),
    );
    expect(result.valid).toBe(true);
    expect(result.answer).toBe("A-1, B-2, C-3");
  });

  it("should accept bare matching pairs without ANSWER prefix", () => {
    const result = validateMatchingAnswer(
      "A-1, B-2, C-3",
      makeMatchingContext(),
    );
    expect(result.valid).toBe(true);
  });

  it("should reject answer missing a category", () => {
    const result = validateMatchingAnswer(
      "ANSWER: A-1, C-3",
      makeMatchingContext(),
    );
    expect(result.valid).toBe(false);
    expect(result.reason).toContain("Missing answer for category B");
  });

  it("should reject answer with out-of-range option index", () => {
    const result = validateMatchingAnswer(
      "ANSWER: A-1, B-5, C-3",
      makeMatchingContext(),
    );
    expect(result.valid).toBe(false);
    expect(result.reason).toContain("not in the available options");
  });

  it("should reject answer with duplicate category", () => {
    const result = validateMatchingAnswer(
      "ANSWER: A-1, A-2, C-3",
      makeMatchingContext(),
    );
    expect(result.valid).toBe(false);
    expect(result.reason).toContain("duplicate");
  });

  it("should reject empty response", () => {
    const result = validateMatchingAnswer(
      "I'm not sure about the answer",
      makeMatchingContext(),
    );
    expect(result.valid).toBe(false);
    expect(result.reason).toContain("No matching pairs");
  });

  it("should accept valid answer even when pairs are out of order", () => {
    const result = validateMatchingAnswer(
      "ANSWER: C-3, A-1, B-2",
      makeMatchingContext(),
    );
    expect(result.valid).toBe(true);
    expect(result.answer).toBe("A-1, B-2, C-3");
  });
});
