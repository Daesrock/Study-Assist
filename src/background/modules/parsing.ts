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
export function extractClaudeQuickAnswer(result: string): string {
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
