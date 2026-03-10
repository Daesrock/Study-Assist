/**
 * Background Service Worker - Response Parsing
 * Parses DeepSeek and Claude API responses
 */

import type { AnalysisContext, AnalysisResponse } from "../../types/index.js";
import type {
  ConfidenceLevel,
  DeepSeekAnalysisResult,
  ClaudeApiResponse,
} from "./constants.js";

// ============================================
// DeepSeek Response Parsing
// ============================================

export function parseDeepSeekResponse(
  response: string,
  context: AnalysisContext,
  reasoningContent: string | null = null
): DeepSeekAnalysisResult {
  const isMatching = context.questionType === "matching";
  const isTrueFalse = context.questionType === "true-false";
  const isShortAnswer = context.questionType === "short-answer";
  const isNumerical = context.questionType === "numerical";
  const isSelectMissingWords = context.questionType === "select-missing-words";

  // Extract CONFIDENCE level
  const confidenceMatch = response.match(/CONFIDENCE:\s*(HIGH|MEDIUM|LOW)/i);
  const confidence: ConfidenceLevel = confidenceMatch
    ? (confidenceMatch[1].toUpperCase() as ConfidenceLevel)
    : "LOW";

  // Extract ANSWER
  let answer: string | null = null;

  if (isMatching) {
    const answerMatch = response.match(/ANSWER:\s*([A-Z]-\d[\s,]*)+/i);
    if (answerMatch) {
      const pairsMatch = answerMatch[0].match(/[A-Z]-\d/gi);
      if (pairsMatch) {
        answer = pairsMatch.join(", ").toUpperCase();
      }
    }

    if (!answer) {
      const allPairs = response.match(/([A-Z]-\d[\s,\n]*){2,}/gi);
      if (allPairs && allPairs.length > 0) {
        const lastBlock = allPairs[allPairs.length - 1];
        const pairs = lastBlock.match(/[A-Z]-\d/gi);
        if (pairs && pairs.length >= 2) {
          answer = pairs.join(", ").toUpperCase();
        }
      }
    }
  } else if (isTrueFalse) {
    const tfMatch = response.match(/ANSWER:\s*(V|F|TRUE|FALSE|VERDADERO|FALSO)\b/i);
    if (tfMatch) {
      const value = tfMatch[1].toUpperCase();
      answer = value.startsWith("V") || value === "TRUE" ? "V" : "F";
    }

    if (!answer) {
      const fallbackTf = response.match(/\b(TRUE|FALSE|VERDADERO|FALSO|V|F)\b/i);
      if (fallbackTf) {
        const value = fallbackTf[1].toUpperCase();
        answer = value.startsWith("V") || value === "TRUE" ? "V" : "F";
      }
    }
  } else if (isSelectMissingWords) {
    // Extract gap-fill answer: ANSWER: [[1]]=word, [[2]]=word, ...
    const gapMatch = response.match(/ANSWER:\s*(\[\[\d+\]\]=[^\n,]+(?:,\s*\[\[\d+\]\]=[^\n,]+)*)/i);
    if (gapMatch) {
      answer = gapMatch[1].trim();
    }
  } else if (isNumerical) {
    // Extract numerical answer: accept digits (with optional units), strip unit words
    const numMatch = response.match(/ANSWER:\s*([\d.,]+(?:\s*\w+)?)/i);
    if (numMatch) {
      // Keep only the numeric part — strip trailing words like "bits", "km", etc.
      answer = numMatch[1].trim().replace(/^([\d.,]+).*$/, "$1").trim();
    }
  } else if (isShortAnswer) {
    // Extract free-text answer: everything after "ANSWER:" up to newline
    const freeMatch = response.match(/ANSWER:\s*([^\n]+)/i);
    if (freeMatch) {
      answer = freeMatch[1].trim();
    }
  } else {
    const answerMatch = response.match(/ANSWER:\s*([A-J](?:\s*,\s*[A-J])*)/i);
    if (answerMatch) {
      answer = answerMatch[1].toUpperCase().replace(/\s/g, "");
    }
  }

  if (!answer) {
    return { success: false, error: "Could not parse DeepSeek answer" };
  }

  return {
    success: true,
    result: answer,
    confidence,
    deepseekAnalysis: response,
    deepseekReasoning: reasoningContent,
    source: "deepseek",
  };
}

// ============================================
// Claude Response Extraction
// ============================================

/**
 * Extract the answer from Claude's response for quick mode
 */
export function extractClaudeQuickAnswer(result: string, questionType?: string): string {
  // Gap-fill answer: [[1]]=word, [[2]]=word
  if (questionType === "select-missing-words") {
    const gapMatch = result.match(/ANSWER:\s*(\[\[\d+\]\]=[^\n,]+(?:,\s*\[\[\d+\]\]=[^\n,]+)*)/i);
    if (gapMatch) return gapMatch[1].trim();
    return result.trim();
  }

  // Numerical answer: strip unit words, keep only the number
  if (questionType === "numerical") {
    const numMatch = result.match(/ANSWER:\s*([\d.,]+(?:\s*\w+)?)/i);
    if (numMatch) return numMatch[1].trim().replace(/^([\d.,]+).*$/, "$1").trim();
    return result.trim();
  }

  // Short-answer: plain text after ANSWER:
  if (questionType === "short-answer") {
    const freeMatch = result.match(/ANSWER:\s*([^\n]+)/i);
    if (freeMatch) return freeMatch[1].trim();
    return result.trim();
  }

  const tfAnswerMatch = result.match(/ANSWER:\s*(V|F|TRUE|FALSE|VERDADERO|FALSO)\b/i);
  if (tfAnswerMatch) {
    const value = tfAnswerMatch[1].toUpperCase();
    return value.startsWith("V") || value === "TRUE" ? "V" : "F";
  }

  const answerMatch = result.match(/ANSWER:\s*([A-J](?:\s*,\s*[A-J])*)/i);
  if (answerMatch) {
    return answerMatch[1].toUpperCase().replace(/\s/g, "");
  }

  // Fallback: check last line
  const lines = result.trim().split("\n");
  const lastLine = lines[lines.length - 1].trim();
  const tfLastLine = lastLine.match(/^(V|F|TRUE|FALSE|VERDADERO|FALSO)$/i);
  if (tfLastLine) {
    const value = tfLastLine[1].toUpperCase();
    return value.startsWith("V") || value === "TRUE" ? "V" : "F";
  }

  const letterMatch = lastLine.match(/^([A-J](?:\s*,\s*[A-J])*)$/i);
  if (letterMatch) {
    return letterMatch[1].toUpperCase().replace(/\s/g, "");
  }

  return result;
}

// ============================================
// API Error Handling
// ============================================

export function handleApiError(
  status: number,
  errorData: ClaudeApiResponse | null
): AnalysisResponse {
  const errorMessage = errorData?.error?.message || "Unknown error";

  switch (status) {
    case 400:
      return { success: false, error: `Bad Request: ${errorMessage}` };
    case 401:
      return { success: false, error: `Invalid API key: ${errorMessage}` };
    case 403:
      return { success: false, error: `Access denied: ${errorMessage}` };
    case 404:
      return { success: false, error: "API endpoint not found." };
    case 413:
      return { success: false, error: "Request too large. Max request size is 32 MB." };
    case 429:
      return { success: false, error: "Rate limit exceeded. Please wait and try again." };
    case 500:
      return { success: false, error: `Claude internal server error. ${errorMessage}` };
    case 502:
      return { success: false, error: "Claude service temporarily unavailable (502)." };
    case 503:
      return { success: false, error: "Claude service temporarily unavailable (503)." };
    case 529:
      return { success: false, error: "Claude API is overloaded. Please try again later." };
    default:
      return { success: false, error: `API error (${status}): ${errorMessage}` };
  }
}
