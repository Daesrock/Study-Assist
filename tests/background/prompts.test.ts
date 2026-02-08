/**
 * Tests for Background - Prompt Building
 * Covers: DeepSeek prompts, Claude prompts, matching prompts, multi-answer detection
 */

import { describe, it, expect } from "vitest";
import {
  buildDeepSeekPrompt,
  buildDeepSeekMatchingPrompt,
  buildClaudeValidationPrompt,
  buildAnalysisPrompt,
  buildMatchingPrompt,
  buildMessageContent,
  extractRequiredAnswers,
  formatQuestionType,
} from "../../src/background/modules/prompts";
import type { AnalysisContext } from "../../src/types/index";
import type { MatchedQuestion, DeepSeekAnalysisForClaude } from "../../src/background/modules/constants";

// ============================================
// Helper factories
// ============================================

function createMCQContext(overrides: Partial<AnalysisContext> = {}): AnalysisContext {
  return {
    questionText: "What is the default administrative distance of OSPF?",
    questionType: "multiple-choice",
    options: [
      { letter: "A", text: "90" },
      { letter: "B", text: "100" },
      { letter: "C", text: "110" },
      { letter: "D", text: "120" },
    ],
    pageTitle: "CCNA - Cisco NetAcad",
    pageUrl: "https://www.netacad.com/courses/packet-tracer",
    responseMode: "quick",
    ...overrides,
  };
}

function createMatchingContext(
  style: "drag-drop" | "dropdown" | "object-dropdown" = "drag-drop",
  overrides: Partial<AnalysisContext> = {}
): AnalysisContext {
  return {
    questionText: "Match each protocol to its correct port number.",
    questionType: "matching",
    categories: [
      { letter: "A", text: "HTTP" },
      { letter: "B", text: "HTTPS" },
      { letter: "C", text: "SSH" },
    ],
    matchingOptions: [
      { index: 1, text: "Port 80" },
      { index: 2, text: "Port 443" },
      { index: 3, text: "Port 22" },
    ],
    matchingStyle: style,
    pageTitle: "CCNA Module 3 - NetAcad",
    pageUrl: "https://www.netacad.com/quiz",
    responseMode: "quick",
    ...overrides,
  };
}

function createMultiAnswerContext(): AnalysisContext {
  return {
    questionText: "¿Cuáles son dos ventajas de usar NAT? (Elija dos opciones.)",
    questionType: "multiple-choice",
    options: [
      { letter: "A", text: "Conserva direcciones IP públicas" },
      { letter: "B", text: "Elimina la necesidad de enrutamiento" },
      { letter: "C", text: "Proporciona seguridad adicional" },
      { letter: "D", text: "Aumenta el ancho de banda" },
    ],
    pageTitle: "CCNA - NetAcad",
    pageUrl: "https://www.netacad.com/quiz",
    responseMode: "quick",
  };
}

// ============================================
// Tests
// ============================================

describe("extractRequiredAnswers", () => {
  it("should return 1 for normal questions", () => {
    expect(extractRequiredAnswers("What is the default gateway?")).toBe(1);
  });

  it("should detect 'Elija dos' in Spanish", () => {
    expect(extractRequiredAnswers("¿Cuáles son? (Elija dos opciones)")).toBe(2);
  });

  it("should detect 'Choose two' in English", () => {
    expect(extractRequiredAnswers("Select the correct answers. Choose two.")).toBe(2);
  });

  it("should detect 'Select 3'", () => {
    expect(extractRequiredAnswers("Which are valid? Select 3")).toBe(3);
  });

  it("should detect 'Seleccione tres'", () => {
    expect(extractRequiredAnswers("Seleccione tres respuestas correctas")).toBe(3);
  });

  it("should detect 'Escoja cuatro'", () => {
    expect(extractRequiredAnswers("Escoja cuatro opciones válidas")).toBe(4);
  });
});

describe("formatQuestionType", () => {
  it("should format multiple-choice", () => {
    expect(formatQuestionType("multiple-choice")).toBe("Multiple Choice");
  });

  it("should format matching", () => {
    expect(formatQuestionType("matching")).toBe("Matching");
  });

  it("should format true-false", () => {
    expect(formatQuestionType("true-false")).toBe("True/False");
  });

  it("should handle undefined as General Question", () => {
    expect(formatQuestionType(undefined)).toBe("General Question");
  });
});

describe("DeepSeek Prompt Building", () => {
  describe("Standard MCQ", () => {
    it("should include NetAcad expert context for Cisco pages", () => {
      const prompt = buildDeepSeekPrompt(createMCQContext());
      expect(prompt).toContain("CCNA/CCNP");
      expect(prompt).toContain("networking expert");
    });

    it("should use generic context for non-NetAcad pages", () => {
      const prompt = buildDeepSeekPrompt(createMCQContext({
        pageTitle: "Biology Quiz - University",
        pageUrl: "https://example.com/quiz",
      }));
      expect(prompt).toContain("expert exam analyst");
      expect(prompt).not.toContain("CCNA");
    });

    it("should list all options", () => {
      const prompt = buildDeepSeekPrompt(createMCQContext());
      expect(prompt).toContain("A) 90");
      expect(prompt).toContain("B) 100");
      expect(prompt).toContain("C) 110");
      expect(prompt).toContain("D) 120");
    });

    it("should include question text", () => {
      const prompt = buildDeepSeekPrompt(createMCQContext());
      expect(prompt).toContain("administrative distance of OSPF");
    });

    it("should request ANSWER and CONFIDENCE format", () => {
      const prompt = buildDeepSeekPrompt(createMCQContext());
      expect(prompt).toContain("ANSWER:");
      expect(prompt).toContain("CONFIDENCE:");
    });
  });

  describe("Multi-answer MCQ", () => {
    it("should specify exact number of required answers", () => {
      const prompt = buildDeepSeekPrompt(createMultiAnswerContext());
      expect(prompt).toContain("EXACTLY 2 correct answers");
      expect(prompt).toContain("Select exactly 2 options");
    });

    it("should format ANSWER as comma-separated", () => {
      const prompt = buildDeepSeekPrompt(createMultiAnswerContext());
      expect(prompt).toContain("e.g., A,C");
    });
  });

  describe("With Question Bank Match", () => {
    it("should include reference section when match provided", () => {
      const match: MatchedQuestion = {
        text: "What is OSPF admin distance?",
        textNormalized: "what ospf admin distance",
        options: ["90", "100", "110", "120"],
        explanation: "OSPF has an admin distance of 110 by default.",
        moduleRange: "7-9",
        similarity: 85,
      };

      const prompt = buildDeepSeekPrompt(createMCQContext(), match);
      expect(prompt).toContain("REFERENCE MATERIAL");
      expect(prompt).toContain("85% match");
      expect(prompt).toContain("admin distance of 110");
    });
  });

  describe("Matching Questions", () => {
    it("should build dropdown matching prompt correctly", () => {
      const prompt = buildDeepSeekPrompt(createMatchingContext("dropdown"));
      expect(prompt).toContain("MATCHING question");
      expect(prompt).toContain("A: HTTP");
      expect(prompt).toContain("1. Port 80");
      expect(prompt).toContain("CONFIDENCE:");
    });

    it("should build drag-drop matching prompt correctly", () => {
      const prompt = buildDeepSeekPrompt(createMatchingContext("drag-drop"));
      expect(prompt).toContain("MATCHING question");
      expect(prompt).toContain("CATEGORIES:");
      expect(prompt).toContain("OPTIONS:");
    });
  });
});

describe("Claude Validation Prompt", () => {
  it("should include DeepSeek analysis", () => {
    const deepseek: DeepSeekAnalysisForClaude = {
      answer: "C",
      confidence: "MEDIUM",
      analysis: "OSPF default admin distance is 110.",
      reasoning: "I know EIGRP is 90, OSPF is 110...",
    };

    const prompt = buildClaudeValidationPrompt(createMCQContext(), deepseek);
    expect(prompt).toContain("DEEPSEEK'S ANALYSIS");
    expect(prompt).toContain("DeepSeek's Answer: C");
    expect(prompt).toContain("MEDIUM confidence");
    expect(prompt).toContain("Chain-of-Thought Reasoning");
    expect(prompt).toContain("I know EIGRP is 90");
  });

  it("should handle matching questions in validation", () => {
    const deepseek: DeepSeekAnalysisForClaude = {
      answer: "A-1, B-2, C-3",
      confidence: "LOW",
      analysis: "HTTP=80, HTTPS=443, SSH=22",
      reasoning: null,
    };

    const prompt = buildClaudeValidationPrompt(createMatchingContext("dropdown"), deepseek);
    expect(prompt).toContain("AVAILABLE OPTIONS:");
    expect(prompt).toContain("DESCRIPTIONS TO MATCH:");
    expect(prompt).toContain("A-1, B-2, C-3");
  });
});

describe("Claude Analysis Prompt", () => {
  describe("Quick Mode", () => {
    it("should build quick mode prompt with step-by-step", () => {
      const prompt = buildAnalysisPrompt(createMCQContext());
      expect(prompt).toContain("Think step-by-step");
      expect(prompt).toContain("ANSWER: X");
    });

    it("should include image analysis instructions when images present", () => {
      const ctx = createMCQContext({
        images: [{ base64: "abc123456789", mediaType: "image/png", location: "question" }],
      });
      const prompt = buildAnalysisPrompt(ctx);
      expect(prompt).toContain("MANDATORY IMAGE ANALYSIS");
      expect(prompt).toContain("network topology");
      expect(prompt).toContain("IP addresses");
    });

    it("should NOT include image instructions when no images", () => {
      const prompt = buildAnalysisPrompt(createMCQContext());
      expect(prompt).not.toContain("MANDATORY IMAGE ANALYSIS");
    });

    it("should handle multi-answer in quick mode", () => {
      const prompt = buildAnalysisPrompt(createMultiAnswerContext());
      expect(prompt).toContain("EXACTLY 2 answers");
      expect(prompt).toContain("A,C");
    });
  });

  describe("Educational Modes", () => {
    it("should build guided mode prompt", () => {
      const ctx = createMCQContext({ responseMode: "guided" });
      const prompt = buildAnalysisPrompt(ctx);
      expect(prompt).toContain("educational AI tutor");
      expect(prompt).toContain("Do NOT give the answer directly");
      expect(prompt).toContain("Guide them to understand WHY");
    });

    it("should build direct mode prompt", () => {
      const ctx = createMCQContext({ responseMode: "direct" });
      const prompt = buildAnalysisPrompt(ctx);
      expect(prompt).toContain("correct answer (clearly stated)");
    });

    it("should build hints mode prompt", () => {
      const ctx = createMCQContext({ responseMode: "hints" });
      const prompt = buildAnalysisPrompt(ctx);
      expect(prompt).toContain("Do NOT reveal the correct answer");
      expect(prompt).toContain("reflective question");
    });
  });
});

describe("Matching Prompts", () => {
  it("should build drag-drop matching prompt", () => {
    const prompt = buildMatchingPrompt(createMatchingContext("drag-drop"));
    expect(prompt).toContain("MATCHING question");
    expect(prompt).toContain("Categories to match:");
    expect(prompt).toContain("A: HTTP");
    expect(prompt).toContain("Options available:");
    expect(prompt).toContain("1. Port 80");
    expect(prompt).toContain("CRITICAL OUTPUT FORMAT");
    expect(prompt).toContain("A-[number], B-[number], C-[number]");
  });

  it("should build dropdown matching prompt with reusable options", () => {
    const prompt = buildMatchingPrompt(createMatchingContext("dropdown"));
    expect(prompt).toContain("DROPDOWN selection");
    expect(prompt).toContain("same option can be used for multiple");
    expect(prompt).toContain("1-[letter], 2-[letter], 3-[letter]");
  });

  it("should build object-dropdown matching prompt", () => {
    const prompt = buildMatchingPrompt(createMatchingContext("object-dropdown"));
    expect(prompt).toContain("Match each term");
    expect(prompt).toContain("Terms to match:");
    expect(prompt).toContain("Definitions available:");
    expect(prompt).toContain("A-[number], B-[number], C-[number]");
  });

  it("should include image context in matching when images present", () => {
    const ctx = createMatchingContext("drag-drop", {
      images: [{ base64: "longbase64data1234567890", mediaType: "image/png" }],
    });
    const prompt = buildMatchingPrompt(ctx);
    expect(prompt).toContain("IMAGE ANALYSIS REQUIRED");
  });
});

describe("buildMessageContent", () => {
  it("should return simple string when no images", () => {
    const result = buildMessageContent("Hello", undefined);
    expect(result).toBe("Hello");
  });

  it("should return string when images array is empty", () => {
    const result = buildMessageContent("Hello", []);
    expect(result).toBe("Hello");
  });

  it("should return content array with images", () => {
    const images = [
      { base64: "a".repeat(200), mediaType: "image/png" },
    ];
    const result = buildMessageContent("Analyze this", images);
    expect(Array.isArray(result)).toBe(true);

    const arr = result as Array<{ type: string }>;
    expect(arr).toHaveLength(2); // 1 image + 1 text
    expect(arr[0].type).toBe("image");
    expect(arr[1].type).toBe("text");
  });

  it("should skip images with base64 too short", () => {
    const images = [
      { base64: "short", mediaType: "image/png" }, // < 100 chars, should skip
      { base64: "a".repeat(200), mediaType: "image/jpeg" },
    ];
    const result = buildMessageContent("Analyze", images);
    expect(Array.isArray(result)).toBe(true);

    const arr = result as Array<{ type: string }>;
    expect(arr).toHaveLength(2); // 1 valid image + 1 text
  });
});
