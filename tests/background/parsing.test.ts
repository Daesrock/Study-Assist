/**
 * Tests for API Response Parsing
 * Covers: DeepSeek response parsing, Claude answer extraction, error handling
 */

import { describe, it, expect } from "vitest";
import {
  parseDeepSeekResponse,
  extractClaudeQuickAnswer,
  handleApiError,
} from "../../src/background/modules/parsing";
import type { AnalysisContext } from "../../src/types/index";

// ============================================
// Helper factories
// ============================================

function mcqContext(overrides: Partial<AnalysisContext> = {}): AnalysisContext {
  return {
    questionText: "What is OSPF admin distance?",
    questionType: "multiple-choice",
    options: [
      { letter: "A", text: "90" },
      { letter: "B", text: "110" },
    ],
    pageTitle: "CCNA",
    pageUrl: "https://netacad.com",
    responseMode: "quick",
    ...overrides,
  };
}

function matchingContext(): AnalysisContext {
  return {
    questionText: "Match protocols to ports",
    questionType: "matching",
    categories: [{ letter: "A", text: "HTTP" }, { letter: "B", text: "SSH" }],
    matchingOptions: [{ index: 1, text: "80" }, { index: 2, text: "22" }],
    matchingStyle: "drag-drop",
    pageTitle: "CCNA",
    pageUrl: "https://netacad.com",
    responseMode: "quick",
  };
}

function trueFalseContext(overrides: Partial<AnalysisContext> = {}): AnalysisContext {
  return {
    questionText: "La entropía es la progresiva desorganización de los sistemas.",
    questionType: "true-false",
    options: [
      { letter: "V", text: "Verdadero" },
      { letter: "F", text: "Falso" },
    ],
    pageTitle: "Sistemas Operativos",
    pageUrl: "https://www.educa-t.unach.mx/mod/quiz",
    responseMode: "quick",
    ...overrides,
  };
}

// ============================================
// DeepSeek Response Parsing
// ============================================

describe("parseDeepSeekResponse", () => {
  describe("Multiple Choice", () => {
    it("should parse a clean single answer with HIGH confidence", () => {
      const response = "Based on my analysis...\nANSWER: C\nCONFIDENCE: HIGH";
      const result = parseDeepSeekResponse(response, mcqContext());

      expect(result.success).toBe(true);
      expect(result.result).toBe("C");
      expect(result.confidence).toBe("HIGH");
      expect(result.source).toBe("deepseek");
    });

    it("should parse multiple comma-separated answers", () => {
      const response = "ANSWER: A,C\nCONFIDENCE: MEDIUM";
      const result = parseDeepSeekResponse(response, mcqContext());

      expect(result.success).toBe(true);
      expect(result.result).toBe("A,C");
      expect(result.confidence).toBe("MEDIUM");
    });

    it("should parse answers with spaces around commas", () => {
      const response = "ANSWER: A, C, D\nCONFIDENCE: HIGH";
      const result = parseDeepSeekResponse(response, mcqContext());

      expect(result.success).toBe(true);
      expect(result.result).toBe("A,C,D");
    });

    it("should default to LOW confidence when missing", () => {
      const response = "ANSWER: B\nSome other text";
      const result = parseDeepSeekResponse(response, mcqContext());

      expect(result.success).toBe(true);
      expect(result.result).toBe("B");
      expect(result.confidence).toBe("LOW");
    });

    it("should handle lowercase answer and confidence", () => {
      const response = "answer: d\nconfidence: high";
      const result = parseDeepSeekResponse(response, mcqContext());

      expect(result.success).toBe(true);
      expect(result.result).toBe("D");
      expect(result.confidence).toBe("HIGH");
    });

    it("should fail when no answer found", () => {
      const response = "I think the answer might be related to OSPF but I'm not sure.";
      const result = parseDeepSeekResponse(response, mcqContext());

      expect(result.success).toBe(false);
      expect(result.error).toContain("Could not parse");
    });

    it("should preserve reasoning content", () => {
      const response = "ANSWER: B\nCONFIDENCE: HIGH";
      const reasoning = "Let me think step by step. OSPF has admin distance 110...";
      const result = parseDeepSeekResponse(response, mcqContext(), reasoning);

      expect(result.deepseekReasoning).toBe(reasoning);
      expect(result.deepseekAnalysis).toBe(response);
    });
  });

  describe("True/False", () => {
    it("should parse V/F format for true-false", () => {
      const response = "ANSWER: V\nCONFIDENCE: HIGH";
      const result = parseDeepSeekResponse(response, trueFalseContext());

      expect(result.success).toBe(true);
      expect(result.result).toBe("V");
      expect(result.confidence).toBe("HIGH");
    });

    it("should parse VERDADERO/FALSO format for true-false", () => {
      const response = "ANSWER: FALSO\nCONFIDENCE: MEDIUM";
      const result = parseDeepSeekResponse(response, trueFalseContext());

      expect(result.success).toBe(true);
      expect(result.result).toBe("F");
      expect(result.confidence).toBe("MEDIUM");
    });
  });

  describe("Matching Questions", () => {
    it("should parse matching pairs from ANSWER line", () => {
      const response = "ANSWER: A-1, B-2\nCONFIDENCE: HIGH";
      const result = parseDeepSeekResponse(response, matchingContext());

      expect(result.success).toBe(true);
      expect(result.result).toBe("A-1, B-2");
      expect(result.confidence).toBe("HIGH");
    });

    it("should parse matching with more pairs", () => {
      const response = "ANSWER: A-3, B-1, C-2, D-4, E-5\nCONFIDENCE: MEDIUM";
      const result = parseDeepSeekResponse(response, matchingContext());

      expect(result.success).toBe(true);
      expect(result.result).toBe("A-3, B-1, C-2, D-4, E-5");
    });

    it("should extract matching pairs from response body as fallback", () => {
      const response = `Let me analyze each protocol...
HTTP uses port 80, SSH uses port 22.

Therefore:
A-1, B-2

CONFIDENCE: HIGH`;
      const result = parseDeepSeekResponse(response, matchingContext());

      expect(result.success).toBe(true);
      expect(result.result).toBe("A-1, B-2");
    });

    it("should fail when no matching pairs found", () => {
      const response = "I'm not sure about this matching question.\nCONFIDENCE: LOW";
      const result = parseDeepSeekResponse(response, matchingContext());

      expect(result.success).toBe(false);
    });
  });
});

// ============================================
// Claude Quick Answer Extraction
// ============================================

describe("extractClaudeQuickAnswer", () => {
  it("should extract ANSWER: X format", () => {
    expect(extractClaudeQuickAnswer("Some analysis...\nANSWER: C")).toBe("C");
  });

  it("should extract multi-letter answer", () => {
    expect(extractClaudeQuickAnswer("Analysis...\nANSWER: A,C")).toBe("A,C");
  });

  it("should extract answer with spaces", () => {
    expect(extractClaudeQuickAnswer("ANSWER: A, C, D")).toBe("A,C,D");
  });

  it("should fallback to last line if just a letter", () => {
    expect(extractClaudeQuickAnswer("The correct answer is...\nB")).toBe("B");
  });

  it("should return full text if no answer pattern found", () => {
    const text = "The answer is that OSPF uses Dijkstra algorithm.";
    expect(extractClaudeQuickAnswer(text)).toBe(text);
  });

  it("should handle ANSWER: at end of long response", () => {
    const text = `Let me analyze this step by step.

1. OSPF uses link-state routing
2. Default admin distance is 110

ANSWER: C`;
    expect(extractClaudeQuickAnswer(text)).toBe("C");
  });

  it("should extract true/false answer as V", () => {
    expect(extractClaudeQuickAnswer("Análisis...\nANSWER: VERDADERO")).toBe("V");
  });

  it("should extract true/false answer as F from last line", () => {
    expect(extractClaudeQuickAnswer("Análisis breve\nFALSO")).toBe("F");
  });
});

// ============================================
// API Error Handling
// ============================================

describe("handleApiError", () => {
  it("should handle 400 Bad Request", () => {
    const result = handleApiError(400, { error: { message: "Invalid model" } });
    expect(result.success).toBe(false);
    expect(result.error).toContain("Bad Request");
  });

  it("should handle 401 Unauthorized", () => {
    const result = handleApiError(401, { error: { message: "Invalid key" } });
    expect(result.success).toBe(false);
    expect(result.error).toContain("Invalid API key");
  });

  it("should handle 403 Access Denied", () => {
    const result = handleApiError(403, { error: { message: "Forbidden" } });
    expect(result.success).toBe(false);
    expect(result.error).toContain("Access denied");
  });

  it("should handle 404 Not Found", () => {
    const result = handleApiError(404, null);
    expect(result.success).toBe(false);
    expect(result.error).toContain("not found");
  });

  it("should handle 413 Request Too Large", () => {
    const result = handleApiError(413, null);
    expect(result.success).toBe(false);
    expect(result.error).toContain("too large");
  });

  it("should handle 429 Rate Limit", () => {
    const result = handleApiError(429, null);
    expect(result.success).toBe(false);
    expect(result.error).toContain("Rate limit");
  });

  it("should handle 500 Internal Server Error", () => {
    const result = handleApiError(500, null);
    expect(result.success).toBe(false);
    expect(result.error).toContain("internal server error");
  });

  it("should handle 502 Service Unavailable", () => {
    const result = handleApiError(502, null);
    expect(result.success).toBe(false);
    expect(result.error).toContain("temporarily unavailable");
  });

  it("should handle 503 Service Unavailable", () => {
    const result = handleApiError(503, null);
    expect(result.success).toBe(false);
    expect(result.error).toContain("temporarily unavailable");
  });

  it("should handle 529 Overloaded", () => {
    const result = handleApiError(529, null);
    expect(result.success).toBe(false);
    expect(result.error).toContain("overloaded");
  });

  it("should handle unknown status code", () => {
    const result = handleApiError(418, { error: { message: "I'm a teapot" } });
    expect(result.success).toBe(false);
    expect(result.error).toContain("418");
    expect(result.error).toContain("I'm a teapot");
  });

  it("should handle null error data gracefully", () => {
    const result = handleApiError(400, null);
    expect(result.success).toBe(false);
    expect(result.error).toContain("Unknown error");
  });
});
