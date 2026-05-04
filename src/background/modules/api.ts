/**
 * Background Service Worker - API Communication
 * Handles Claude and DeepSeek API calls, streaming, rate limiting, and usage tracking
 */

import type { AnalysisContext, AnalysisResponse } from "../../types/index.js";
import {
  log,
  DEBUG_MODE,
  CLAUDE_API_BASE,
  DEFAULT_MODEL,
  ANTHROPIC_VERSION,
  DEEPSEEK_API_BASE,
  DEEPSEEK_V4_FLASH,
  DEEPSEEK_V4_PRO,
  activeDeepSeekController,
  setActiveDeepSeekController,
} from "./constants.js";
import type {
  StorageData,
  MessageResponse,
  ClaudeRequestBody,
  ClaudeMessage,
  ClaudeApiResponse,
  DeepSeekRequestBody,
  DeepSeekApiResponse,
  DeepSeekAnalysisResult,
  DeepSeekAnalysisForClaude,
} from "./constants.js";
import { fetchWithRetry } from "./fetchUtils.js";
import { logError } from "./fetchUtils.js";
import { findMatchingQuestion, normalizeForSearch, calculateSimilarity, calculateContainment } from "./questionBank.js";
import {
  buildDeepSeekPrompt,
  buildClaudeValidationPrompt,
  buildAnalysisPrompt,
  buildMatchingPrompt,
  buildMessageContent,
} from "./prompts.js";
import {
  parseDeepSeekResponse,
  extractClaudeQuickAnswer,
  handleApiError,
} from "./parsing.js";
import { getDecryptedApiKey } from "./crypto.js";
import { trackUsage, calculateCost } from "./usageTracker.js";
import { checkRateLimit, recordRequest } from "./rateLimiter.js";
import { streamClaudeResponse } from "./streaming.js";

const QA_CLAUDE_MODEL = "claude-haiku-4-5-20251001";

// ============================================
// Platform Detection
// ============================================

function detectPlatform(pageUrl?: string): string {
  if (!pageUrl) return "other";
  const url = pageUrl.toLowerCase();
  
  // NetAcad platforms
  if (url.includes("netacad")) return "netacad";
  if (url.includes("skillsforall")) return "skillsforall";
  
  // Educational institutions
  if (url.includes("educa-t") || url.includes("unach.mx")) return "educa-t";
  if (url.includes("tecnm.mx") || url.includes("ead.tuxtla.tecnm")) return "tecnm";
  if (url.includes("educat")) return "educat";
  
  // Generic Moodle (fallback)
  if (url.includes("moodle")) return "moodle";
  
  // Other platforms
  if (url.includes("contenidosdigitales")) return "contenidosdigitales";

  // QA Manual sandbox
  if (url.includes("example.com")) return "qa-manual";
  
  return "other";
}

// ============================================
// API Key Testing
// ============================================

export async function testApiKey(apiKey: string): Promise<MessageResponse> {
  const url = CLAUDE_API_BASE;

  try {
    const requestBody: ClaudeRequestBody = {
      model: DEFAULT_MODEL,
      max_tokens: 10,
      messages: [{ role: "user", content: "Hello, respond with just OK to confirm." }],
    };

    const response = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": apiKey,
        "anthropic-version": ANTHROPIC_VERSION,
        "anthropic-dangerous-direct-browser-access": "true",
      },
      body: JSON.stringify(requestBody),
    });

    let responseBody: ClaudeApiResponse | null = null;
    try {
      responseBody = await response.clone().json() as ClaudeApiResponse;
    } catch (e) {
      responseBody = { parseError: (e as Error).message };
    }

    await logError({
      type: "testApiKey",
      url,
      status: response.status,
      statusText: response.statusText,
      responseBody,
    });

    if (response.ok) return { success: true };

    const errorMessage = responseBody?.error?.message || "Invalid API key";

    if (response.status === 400) return { success: false, error: `Bad Request (400): ${errorMessage}` };
    if (response.status === 401) return { success: false, error: `Unauthorized (401): ${errorMessage}` };
    if (response.status === 403) return { success: false, error: `Forbidden (403): ${errorMessage}` };
    if (response.status === 429) {
      return { success: true, warning: "API key is valid but rate limited. It will work when the limit resets." };
    }

    return { success: false, error: `API Error (${response.status}): ${errorMessage}` };
  } catch (error) {
    console.error("[Study Assist] API test error:", error);
    await logError({ type: "testApiKey_exception", url, error: (error as Error).message, stack: (error as Error).stack });

    if ((error as Error).message.includes("Failed to fetch")) {
      return { success: false, error: "Network error. Check your internet connection." };
    }
    return { success: false, error: `Exception: ${(error as Error).message}` };
  }
}

export async function testDeepSeekApiKey(apiKey: string): Promise<MessageResponse> {
  try {
    const response = await fetch(DEEPSEEK_API_BASE, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${apiKey}` },
      body: JSON.stringify({
        model: DEEPSEEK_V4_FLASH,
        max_tokens: 10,
        messages: [{ role: "user", content: "Hello, respond with just OK." }],
      }),
    });

    let responseBody: DeepSeekApiResponse | null = null;
    try {
      responseBody = await response.clone().json() as DeepSeekApiResponse;
    } catch (e) {
      responseBody = { parseError: (e as Error).message };
    }

    await logError({ type: "testDeepSeekApiKey", status: response.status, responseBody });

    if (response.ok) return { success: true };

    const errorMessage = responseBody?.error?.message || "Invalid API key";
    return { success: false, error: `DeepSeek Error (${response.status}): ${errorMessage}` };
  } catch (error) {
    console.error("[Study Assist] DeepSeek API test error:", error);
    return { success: false, error: `Exception: ${(error as Error).message}` };
  }
}

// ============================================
// Question Bank → Letter Matching
// ============================================

import type { QuestionOption } from "../../types/index.js";

function hasCommandLikeText(text: string): boolean {
  return /\bconfig\b|\binterface\b|\bswitchport\b|\bip\b|\brouter\b|\bvlan\b/.test(text);
}

function getTokenCount(text: string): number {
  return text.split(" ").filter(Boolean).length;
}

/**
 * Match a single correctAnswer text from the question bank to the option letter (A, B, C...)
 * from the current page's detected options.
 * Uses normalized text comparison to handle accent/case differences.
 */
function matchSingleAnswerToLetter(
  correctAnswer: string,
  pageOptions: QuestionOption[],
): string | null {
  const normalizedCorrect = normalizeForSearch(correctAnswer);
  const correctTokenCount = getTokenCount(normalizedCorrect);
  const correctIsCommandLike = hasCommandLikeText(normalizedCorrect);

  // 1. Exact normalized match
  for (const opt of pageOptions) {
    const normalizedOpt = normalizeForSearch(opt.text);
    if (normalizedOpt === normalizedCorrect) {
      return opt.letter;
    }
  }

  // 2. Contains match (prefer option containing the bank answer).
  // Avoid mapping long answers to short snippets like "ip routing".
  for (const opt of pageOptions) {
    const normalizedOpt = normalizeForSearch(opt.text);
    if (normalizedOpt.includes(normalizedCorrect)) {
      return opt.letter;
    }

    if (normalizedCorrect.includes(normalizedOpt)) {
      const optTokenCount = getTokenCount(normalizedOpt);
      const lengthRatio = normalizedOpt.length / Math.max(normalizedCorrect.length, 1);
      const tokenRatio = optTokenCount / Math.max(correctTokenCount, 1);
      // Only accept reverse contains if texts are near-equivalent in size/content.
      if (lengthRatio >= 0.8 || tokenRatio >= 0.8) {
        return opt.letter;
      }
    }
  }

  // 3. High word-overlap similarity (>= 70% for code/command options, >= 80% for regular text)
  let bestMatch: { letter: string; similarity: number } | null = null;
  
  for (const opt of pageOptions) {
    const normalizedOpt = normalizeForSearch(opt.text);
    const similarity = calculateSimilarity(normalizedCorrect, normalizedOpt);
    
    // Track best match
    if (!bestMatch || similarity > bestMatch.similarity) {
      bestMatch = { letter: opt.letter, similarity };
    }
    
    // Accept match based on context
    const threshold = correctIsCommandLike ? 0.7 : 0.8;
    
    if (similarity >= threshold) {
      return opt.letter;
    }
  }

  // 4. If we have a decent match (>= 60%) and it's the best option, use it
  const fallbackThreshold = correctIsCommandLike ? 0.62 : 0.6;
  if (bestMatch && bestMatch.similarity >= fallbackThreshold) {
    log(`[Study Assist] Using best match with ${(bestMatch.similarity * 100).toFixed(1)}% similarity`);
    return bestMatch.letter;
  }

  return null;
}

/**
 * Match correctAnswer(s) from question bank to page option letters.
 * Handles both single answer (correctAnswer) and multiple answers (correctAnswers).
 * Returns comma-separated letters like "A" or "A, C, E".
 */
function matchCorrectAnswerToLetter(
  bankMatch: { correctAnswer?: string; correctAnswers?: string[] },
  pageOptions?: QuestionOption[],
): string | null {
  if (!pageOptions || pageOptions.length === 0) return null;

  // Determine all correct answers
  const answers: string[] = bankMatch.correctAnswers
    ? bankMatch.correctAnswers
    : bankMatch.correctAnswer
      ? [bankMatch.correctAnswer]
      : [];

  if (answers.length === 0) return null;

  const matchedLetters: string[] = [];
  const usedLetters = new Set<string>();

  for (const answer of answers) {
    const availableOptions = pageOptions.filter((opt) => !usedLetters.has(opt.letter));
    const letter = matchSingleAnswerToLetter(answer, availableOptions);
    if (letter) {
      matchedLetters.push(letter);
      usedLetters.add(letter);
    } else {
      log(`[Study Assist] Could not match correctAnswer "${answer}" to any page option`);
    }
  }

  if (answers.length > 1 && matchedLetters.length > 0 && matchedLetters.length < answers.length) {
    console.warn("[Study Assist] Partial multi-answer match from question bank", {
      expectedAnswers: answers.length,
      matchedAnswers: matchedLetters.length,
      matchedLetters: [...matchedLetters],
    });
  }

  if (matchedLetters.length === 0) return null;

  // Sort alphabetically and deduplicate
  const unique = [...new Set(matchedLetters)].sort();
  return unique.join(", ");
}

export const __testOnlyApiMatching = {
  matchSingleAnswerToLetter,
  matchCorrectAnswerToLetter,
  validateMatchingAnswer,
};

// ============================================
// Question Analysis (Main Orchestrator)
// ============================================

export async function analyzeQuestion(context: AnalysisContext): Promise<AnalysisResponse> {
  const startTime = Date.now();

  try {
    // ============================================
    // Question Bank Instant Match (skip AI entirely)
    // ============================================
    const bankMatch = await findMatchingQuestion(
      context.questionText,
      (context as AnalysisContext & { moduleInfo?: string }).moduleInfo || context.pageTitle,
      context.pageUrl,
    );

    if (bankMatch && (bankMatch.correctAnswer || bankMatch.correctAnswers) && bankMatch.similarity >= 80) {
      const answerLetter = matchCorrectAnswerToLetter(bankMatch, context.options);
      if (answerLetter) {
        log(`[Study Assist] INSTANT ANSWER from ${bankMatch.bankModel} (${bankMatch.similarity}% match): ${answerLetter}`);
        const bankConflictTelemetry = bankMatch.bankConflictDetected
          ? {
            bankConflictDetected: true,
            bankConflictType: bankMatch.bankConflictType,
            bankConflictAnswerSimilarity: bankMatch.bankConflictAnswerSimilarity,
            bankSecondaryModel: bankMatch.bankSecondaryModel,
          }
          : {};
        await trackUsage({
          timestamp: Date.now(),
          questionText: context.questionText.substring(0, 200),
          questionType: context.questionType,
          answer: answerLetter,
          source: "question-bank",
          model: bankMatch.bankModel,
          inputTokens: 0,
          outputTokens: 0,
          responseMode: context.responseMode,
          success: true,
          latencyMs: Date.now() - startTime,
          platform: detectPlatform(context.pageUrl),
          confidence: "HIGH",
          ...bankConflictTelemetry,
        });
        return { success: true, result: answerLetter, source: "question-bank" };
      }
    }

    // Rate limiting check
    const rateLimitError = checkRateLimit(context.questionText);
    if (rateLimitError) {
      return { success: false, error: rateLimitError };
    }
    recordRequest(context.questionText);

    const storageResult = await chrome.storage.local.get([
      "claudeApiKey", "claudeModel", "useDeepSeek", "deepseekApiKey", "deepseekOnly", "deepseekModel", "deepseekThinking", "claudeThinking",
    ]) as StorageData;

    // Decrypt API keys
    const claudeApiKey = await getDecryptedApiKey("claudeApiKey");
    const deepseekApiKey = await getDecryptedApiKey("deepseekApiKey");
    const { claudeModel, useDeepSeek, deepseekOnly, deepseekModel, deepseekThinking, claudeThinking } = storageResult;
    const selectedClaudeModel = context.qaMode ? QA_CLAUDE_MODEL : (claudeModel || DEFAULT_MODEL);
    const isDeepSeekOnlyMode = useDeepSeek && deepseekOnly && deepseekApiKey;

    if (!claudeApiKey && !isDeepSeekOnlyMode) {
      return { success: false, error: "Claude API key not configured." };
    }

    const hasImages = context.images && context.images.length > 0;
    const isMatching = context.questionType === "matching";
    const skipDeepSeek = context.skipDeepSeek === true;

    if (skipDeepSeek) {
      log("[Study Assist] CTRL+SHIFT: Using Claude directly");
      if (isDeepSeekOnlyMode) {
        return { success: false, error: "⚠️ DeepSeek Only mode: CTRL+SHIFT (use Claude) is not available. Disable 'DeepSeek Only' or press CTRL without SHIFT." };
      }
    }

    let deepseekAnalysisForClaude: DeepSeekAnalysisForClaude | null = null;
    let claudeFallbackReason: string | undefined;
    let deepseekRetried = false; // Track if DeepSeek was retried
    let claudeFallback = false; // Track if Claude is used as fallback after DeepSeek failure

    if (isDeepSeekOnlyMode && hasImages) {
      return { success: false, error: "⚠️ DeepSeek Only mode: Images are not supported. Disable 'DeepSeek Only' to use Claude for image questions." };
    }

    if (isDeepSeekOnlyMode && isMatching) {
      return { success: false, error: "⚠️ DeepSeek Only mode: Matching questions are not supported. Disable 'DeepSeek Only' to use Claude for matching questions." };
    }

    if (useDeepSeek && deepseekApiKey && !hasImages && !isMatching && !skipDeepSeek) {
      const selectedDeepSeekModel = deepseekModel || DEEPSEEK_V4_FLASH;
      const thinkingEnabled = deepseekThinking !== false;

      log(`[Study Assist] Using DeepSeek ${selectedDeepSeekModel} (thinking: ${thinkingEnabled ? "ON" : "OFF"})...`);

      let deepseekResult = await analyzeWithDeepSeek(context, deepseekApiKey, selectedDeepSeekModel, thinkingEnabled);

      if (deepseekResult.cancelled) {
        log("[Study Assist] DeepSeek cancelled → Claude");
        if (isDeepSeekOnlyMode) return { success: false, error: "Analysis cancelled." };
      } else if (!deepseekResult.success) {
        if (deepseekResult.skipRetry) {
          log(`[Study Assist] DeepSeek failed (non-retryable) → Claude fallback: ${deepseekResult.error}`);
          claudeFallback = true;
        } else {
          log("[Study Assist] DeepSeek failed, retrying...");
          deepseekRetried = true; // Mark that we're retrying
          await new Promise((r) => setTimeout(r, 1000));
          deepseekResult = await analyzeWithDeepSeek(context, deepseekApiKey);
        }

        if (!deepseekResult.success && !deepseekResult.cancelled) {
          log("[Study Assist] DeepSeek failed → Claude fallback");
          claudeFallbackReason = "deepseek_error";
          claudeFallback = true; // Mark Claude as fallback
          if (isDeepSeekOnlyMode) {
            return { success: false, error: `⚠️ DeepSeek Only mode: ${deepseekResult.error || "API failed after retry. No Claude fallback available."}` };
          }
        }
      }

      if (deepseekResult.success && deepseekResult.confidence === "HIGH") {
        log("[Study Assist] DeepSeek HIGH → Answer:", deepseekResult.result);
        // Track usage with real token counts from DeepSeek API
        await trackUsage({
          timestamp: Date.now(),
          questionText: context.questionText.substring(0, 200),
          questionType: context.questionType,
          answer: deepseekResult.result,
          source: "deepseek",
          model: selectedDeepSeekModel,
          inputTokens: deepseekResult.inputTokens || 0,
          outputTokens: deepseekResult.outputTokens || 0,
          cacheHitTokens: deepseekResult.cacheHitTokens,
          responseMode: context.responseMode,
          success: true,
          latencyMs: Date.now() - startTime,
          platform: detectPlatform(context.pageUrl),
          confidence: "HIGH",
          deepseekReasoning: deepseekResult.deepseekReasoning ?? undefined,
          deepseekThinkingEnabled: thinkingEnabled,
        });
        return deepseekResult;
      } else if (deepseekResult.success) {
        if (isDeepSeekOnlyMode) {
          log(`[Study Assist] DeepSeek ${deepseekResult.confidence} → Returning (DeepSeek Only mode)`);
          deepseekResult.explanation = `⚠️ **Low confidence (${deepseekResult.confidence})** - No Claude validation in DeepSeek Only mode.\n\n${deepseekResult.explanation || ""}`;
          // Track usage with real token counts from DeepSeek API
          await trackUsage({
            timestamp: Date.now(),
            questionText: context.questionText.substring(0, 200),
            questionType: context.questionType,
            answer: deepseekResult.result,
            source: "deepseek",
            model: selectedDeepSeekModel,
            inputTokens: deepseekResult.inputTokens || 0,
            outputTokens: deepseekResult.outputTokens || 0,
            cacheHitTokens: deepseekResult.cacheHitTokens,
            responseMode: context.responseMode,
            success: true,
            latencyMs: Date.now() - startTime,
            platform: detectPlatform(context.pageUrl),
            confidence: deepseekResult.confidence,
            deepseekReasoning: deepseekResult.deepseekReasoning ?? undefined,
            deepseekThinkingEnabled: thinkingEnabled,
          });
          return deepseekResult;
        }

        log(`[Study Assist] DeepSeek ${deepseekResult.confidence} → Claude validation`);
        deepseekAnalysisForClaude = {
          answer: deepseekResult.result!,
          confidence: deepseekResult.confidence!,
          analysis: deepseekResult.deepseekAnalysis!,
          reasoning: deepseekResult.deepseekReasoning ?? null,
        };
      }
    } else if (useDeepSeek && hasImages) {
      log("[Study Assist] Images detected → Claude (DeepSeek no soporta imágenes)");
      claudeFallbackReason = "images";
    }

    if (isDeepSeekOnlyMode) {
      return { success: false, error: "⚠️ DeepSeek Only mode: Unable to analyze. Check your DeepSeek API key." };
    }

    // When falling back to Claude after DeepSeek attempt, let Claude track its own latency.
    // Only pass original startTime if Claude is the primary (no DeepSeek attempt was made).
    const claudeStartTime = deepseekAnalysisForClaude ? Date.now() : startTime;
    const claudeResponse = await analyzeWithClaude(context, claudeApiKey!, selectedClaudeModel, deepseekAnalysisForClaude, claudeStartTime, claudeFallbackReason, claudeThinking, isMatching);

    // Add status flags to response for visual feedback
    if (deepseekRetried) claudeResponse.deepseekRetried = true;
    if (claudeFallback) claudeResponse.claudeFallback = true;

    return claudeResponse;
  } catch (error) {
    await logError({ type: "analyzeQuestion_exception", error: (error as Error).message, stack: (error as Error).stack });

    if ((error as Error).message.includes("Failed to fetch")) {
      return { success: false, error: "Network error." };
    }
    return { success: false, error: `Analysis failed: ${(error as Error).message}` };
  }
}

// ============================================
// DeepSeek Analysis
// ============================================

export async function analyzeWithDeepSeek(
  context: AnalysisContext,
  apiKey: string,
  model: string = DEEPSEEK_V4_FLASH,
  thinkingEnabled: boolean = true,
): Promise<DeepSeekAnalysisResult> {
  try {
    const matchedQuestion = await findMatchingQuestion(
      context.questionText,
      (context as AnalysisContext & { moduleInfo?: string }).moduleInfo || context.pageTitle,
      context.pageUrl,
    );

    const prompt = buildDeepSeekPrompt(context, matchedQuestion);

    log("[Study Assist] Calling DeepSeek API...");

    const controller = new AbortController();
    setActiveDeepSeekController(controller);
    const signal = controller.signal;

    const response = await fetchWithRetry(
      DEEPSEEK_API_BASE,
      {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${apiKey}` },
        body: JSON.stringify({
          model,
          max_tokens: 2048,
          messages: [{ role: "user", content: prompt }],
          thinking: { type: thinkingEnabled ? "enabled" : "disabled" },
          reasoning_effort: "high",
        } as DeepSeekRequestBody),
        signal,
      },
      2,
      60000,
    );

    let responseBody: DeepSeekApiResponse | null = null;
    try {
      responseBody = await response.clone().json() as DeepSeekApiResponse;
    } catch (e) {
      responseBody = { parseError: (e as Error).message };
    }

    await logError({ type: "analyzeWithDeepSeek", status: response.status, responseBody });

    // Save full API request/response for developer mode in dashboard
    try {
      await chrome.storage.local.set({
        lastApiRequestData: {
          timestamp: Date.now(),
          type: "analyzeWithDeepSeek",
          url: DEEPSEEK_API_BASE,
          status: response.status,
          hasImages: false,
          requestBody: {
            model,
            max_tokens: 2048,
            messages: [{ role: "user", content: prompt }],
            thinking: { type: thinkingEnabled ? "enabled" : "disabled" },
          },
          responseBody,
        },
      });
    } catch (_e) { /* silent */ }

    if (!response.ok) {
      const status = response.status;
      const errorMsg = responseBody?.error?.message || "";

      // Non-retryable errors: skip retry and go directly to Claude fallback
      const nonRetryableStatuses = [400, 401, 402, 422, 429, 503];
      const skipRetry = nonRetryableStatuses.includes(status);

      let errorDescription: string;
      switch (status) {
        case 400:
          errorDescription = `DeepSeek: Invalid request format. ${errorMsg}`;
          break;
        case 401:
          errorDescription = `DeepSeek: Authentication failed. Check your API key.`;
          break;
        case 402:
          errorDescription = `DeepSeek: Insufficient balance. Please top up your account.`;
          break;
        case 422:
          errorDescription = `DeepSeek: Invalid parameters. ${errorMsg}`;
          break;
        case 429:
          errorDescription = `DeepSeek: Rate limit reached. Switching to Claude.`;
          break;
        case 500:
          errorDescription = `DeepSeek: Server error. ${errorMsg}`;
          break;
        case 503:
          errorDescription = `DeepSeek: Server overloaded. Switching to Claude.`;
          break;
        default:
          errorDescription = `DeepSeek API Error (${status}): ${errorMsg}`;
          break;
      }

      log(`[Study Assist] DeepSeek error ${status}${skipRetry ? " (non-retryable)" : ""}: ${errorDescription}`);
      return { success: false, error: errorDescription, skipRetry };
    }

    const message = responseBody?.choices?.[0]?.message;
    const reasoningContent = message?.reasoning_content || null;
    const result = message?.content;

    if (!result) {
      return { success: false, error: "No response from DeepSeek" };
    }

    // Extract real token counts from API response
    const apiInputTokens = responseBody?.usage?.prompt_tokens ?? 0;
    const apiOutputTokens = responseBody?.usage?.completion_tokens ?? 0;
    const apiCacheHitTokens = responseBody?.usage?.prompt_cache_hit_tokens ?? undefined;

    if (DEBUG_MODE) {
      console.log("[Study Assist] ====== DeepSeek Response =====");
      console.log(`[Study Assist] Model: ${model} | Thinking: ${thinkingEnabled ? "ON" : "OFF"}`);
      if (reasoningContent) console.log("[Study Assist] DeepSeek REASONING:", reasoningContent);
      console.log("[Study Assist] DeepSeek ANSWER:", result);
      console.log("[Study Assist] DeepSeek TOKENS:", apiInputTokens, "+", apiOutputTokens);
      if (apiCacheHitTokens !== undefined) console.log("[Study Assist] DeepSeek CACHE HIT:", apiCacheHitTokens);
      console.log("[Study Assist] ================================");
    }

    setActiveDeepSeekController(null);
    const parsed = parseDeepSeekResponse(result, context, reasoningContent);
    // Attach real token counts
    parsed.inputTokens = apiInputTokens;
    parsed.outputTokens = apiOutputTokens;
    parsed.cacheHitTokens = apiCacheHitTokens;
    return parsed;
  } catch (error) {
    setActiveDeepSeekController(null);
    if ((error as Error).name === "AbortError") {
      log("[Study Assist] DeepSeek request cancelled");
      return { success: false, error: "DeepSeek cancelled", cancelled: true };
    }
    return { success: false, error: `DeepSeek error: ${(error as Error).message}` };
  }
}

// ============================================
// Matching Answer Validation
// ============================================

interface MatchingValidationResult {
  valid: boolean;
  reason?: string;
  answer?: string; // normalized answer
}

/**
 * Validate a matching answer against the expected structure from the context.
 * Checks that every category is answered exactly once with a valid option index.
 */
function validateMatchingAnswer(
  result: string,
  context: AnalysisContext,
): MatchingValidationResult {
  if (!context.categories || !context.matchingOptions) {
    return { valid: true }; // Can't validate without structure — accept
  }

  const categoryLetters = context.categories.map((c) => c.letter);
  const validIndices = new Set(context.matchingOptions.map((o) => o.index));

  // Extract pairs from response — try ANSWER: prefix first, then bare pairs
  let pairs: string[] = [];
  const answerMatch = result.match(/ANSWER:\s*([A-Z]-\d[\s,]*)+/i);
  if (answerMatch) {
    const pairsMatch = answerMatch[0].match(/[A-Z]-\d/gi);
    if (pairsMatch) pairs = pairsMatch.map((p) => p.toUpperCase());
  }

  if (pairs.length === 0) {
    // Try bare pairs in the whole response
    const allPairs = result.match(/[A-Z]-\d/gi);
    if (allPairs && allPairs.length >= 2) {
      pairs = allPairs.map((p) => p.toUpperCase());
    }
  }

  if (pairs.length === 0) {
    return { valid: false, reason: "No matching pairs found in response" };
  }

  // Check every required category is answered
  const answeredCategories = new Set(pairs.map((p) => p.split("-")[0]));
  const categorySet = new Set(categoryLetters);

  // Catch duplicates: more pairs than distinct categories, or same count but
  // duplicate letters (e.g., A appears twice, B never appears)
  if (pairs.length > categoryLetters.length ||
      (pairs.length === categoryLetters.length && answeredCategories.size < categoryLetters.length)) {
    return { valid: false, reason: "Answer has duplicate or unexpected categories" };
  }

  // Catch missing categories
  for (const letter of categoryLetters) {
    if (!answeredCategories.has(letter)) {
      return { valid: false, reason: `Missing answer for category ${letter}` };
    }
  }

  // Catch unexpected extra categories (e.g. answer has letter that doesn't exist)
  for (const letter of answeredCategories) {
    if (!categorySet.has(letter)) {
      return { valid: false, reason: `Unexpected category ${letter} in answer` };
    }
  }

  // Check every target index is in range
  for (const pair of pairs) {
    const targetNum = parseInt(pair.split("-")[1]);
    if (!validIndices.has(targetNum)) {
      return { valid: false, reason: `Option index ${targetNum} is not in the available options` };
    }
  }

  // Normalize: sort by category letter, return clean answer
  const normalized = pairs.sort().join(", ");

  return { valid: true, answer: normalized };
}

// ============================================
// Claude Analysis
// ============================================

export async function analyzeWithClaude(
  context: AnalysisContext,
  apiKey: string,
  model: string,
  deepseekAnalysis: DeepSeekAnalysisForClaude | null = null,
  startTime: number = Date.now(),
  fallbackReasonOverride?: string,
  claudeThinkingEnabled?: boolean,
  matchingQuestion?: boolean,
): Promise<AnalysisResponse> {
  let matchedQuestion = null;
  if (!deepseekAnalysis) {
    matchedQuestion = await findMatchingQuestion(
      context.questionText,
      (context as AnalysisContext & { moduleInfo?: string }).moduleInfo || context.pageTitle,
      context.pageUrl,
    );
  }

  const prompt = deepseekAnalysis
    ? buildClaudeValidationPrompt(context, deepseekAnalysis)
    : buildAnalysisPrompt(context, matchedQuestion);

  log("[Study Assist] Claude analysis...", deepseekAnalysis ? "(validating DeepSeek)" : "");

  const messageContent = buildMessageContent(prompt, context.images);

  const questionText = context.questionText || "";
  const multiAnswerPattern = /elija\s*(dos|tres|cuatro|cinco|2|3|4|5)|escoja\s*(dos|tres|cuatro|cinco|2|3|4|5)|seleccione\s*(dos|tres|cuatro|cinco|2|3|4|5)|select\s*(two|three|four|five|2|3|4|5)|choose\s*(two|three|four|five|2|3|4|5)|\(\s*(dos|tres|cuatro|two|three|four|2|3|4|5)\s*opciones?\s*\)/i;
  const isMultipleAnswer = multiAnswerPattern.test(questionText);
  const isQuickMode = context.responseMode === "quick";
  const isMatching = context.questionType === "matching";
  const hasImages = context.images && context.images.length > 0;
  const maxTokens = deepseekAnalysis ? 2048 : 1024;

  log("[Study Assist] Claude config:", { maxTokens, hasImages, isMultipleAnswer, hasDeepSeekAnalysis: !!deepseekAnalysis, claudeThinking: claudeThinkingEnabled });

  const isMatchingQuestion = matchingQuestion || context.questionType === "matching";
  const shouldUseThinking = claudeThinkingEnabled === true;

  const messages: ClaudeMessage[] = [{ role: "user", content: messageContent }];

  // Build request body — matching forces "enabled", general uses "adaptive"
  const requestBody: Record<string, unknown> = { model, max_tokens: maxTokens, messages };
  if (shouldUseThinking) {
    requestBody.thinking = { type: isMatchingQuestion ? "enabled" : "adaptive" };
  }

  const response = await fetchWithRetry(
    CLAUDE_API_BASE,
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": apiKey,
        "anthropic-version": ANTHROPIC_VERSION,
        "anthropic-dangerous-direct-browser-access": "true",
      },
      body: JSON.stringify(requestBody as unknown as ClaudeRequestBody),
    },
    2,
    45000,
  );

  let responseBody: ClaudeApiResponse | null = null;
  try {
    responseBody = await response.clone().json() as ClaudeApiResponse;
  } catch (e) {
    responseBody = { parseError: (e as Error).message };
  }

  await logError({
    type: "analyzeWithClaude",
    url: CLAUDE_API_BASE,
    status: response.status,
    statusText: response.statusText,
    responseBody,
    hasImages: hasImages || false,
  });

  // Save full API request/response for developer mode in dashboard
  try {
    await chrome.storage.local.set({
      lastApiRequestData: {
        timestamp: Date.now(),
        type: "analyzeWithClaude",
        url: CLAUDE_API_BASE,
        status: response.status,
        statusText: response.statusText,
        hasImages: hasImages || false,
        requestBody: { model, max_tokens: maxTokens, messages },
        responseBody,
      },
    });
  } catch (_e) { /* silent */ }

  if (!response.ok) {
    return handleApiError(response.status, responseBody);
  }

  let result = responseBody?.content?.[0]?.text;
  if (!result) return { success: false, error: "No response generated." };

  log("[Study Assist] Claude response:", result);

  // Validate matching answers structurally
  if ((isMatching || context.questionType === "matching") && !deepseekAnalysis) {
    const validation = validateMatchingAnswer(result, context);
    if (!validation.valid) {
      log(`[Study Assist] Matching validation failed: ${validation.reason}. Retrying with stricter prompt...`);
      // Build a stricter prompt that demands structural output
      const strictPrompt = buildMatchingPrompt(context) + `

YOUR PREVIOUS RESPONSE WAS REJECTED because: ${validation.reason}

PLEASE RESPOND AGAIN with the CORRECT matches. Only output the match pairs — no extra text.`;
      const strictMessageContent = buildMessageContent(strictPrompt, context.images);
      const strictMessages: ClaudeMessage[] = [{ role: "user", content: strictMessageContent }];

      // Build request body with thinking
      const strictRequestBody: Record<string, unknown> = { model, max_tokens: maxTokens, messages: strictMessages };
      if (shouldUseThinking) {
        strictRequestBody.thinking = { type: "enabled" }; // Force enabled for retry
      }

      const retryResponse = await fetchWithRetry(
        CLAUDE_API_BASE,
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "x-api-key": apiKey,
            "anthropic-version": ANTHROPIC_VERSION,
            "anthropic-dangerous-direct-browser-access": "true",
          },
          body: JSON.stringify(strictRequestBody as unknown as ClaudeRequestBody),
        },
        2,
        45000,
      );

      if (retryResponse.ok) {
        let retryBody: ClaudeApiResponse | null = null;
        try { retryBody = await retryResponse.clone().json() as ClaudeApiResponse; } catch { /* keep null */ }
        const retryResult = retryBody?.content?.[0]?.text;
        if (retryResult) {
          const retryValidation = validateMatchingAnswer(retryResult, context);
          if (retryValidation.valid && retryValidation.answer) {
            log("[Study Assist] Matching retry successful:", retryValidation.answer);
            result = retryResult;
          } else if (retryValidation.answer) {
            // Structural pass but accept anyway with normalized answer
            log("[Study Assist] Matching retry partially valid, accepting:", retryValidation.answer);
            result = retryResult;
          }
        }
      }
      // Note: if retry also fails, we continue with original result so user sees something
    } else if (validation.answer && validation.answer !== result.trim()) {
      // Answer is valid but could be normalized — use the clean version
      result = validation.answer;
    }
  }

  // Use real token counts from Claude API response, fall back to estimates
  const realInputTokens = responseBody?.usage?.input_tokens ?? Math.ceil((prompt?.length || 0) / 4);
  const realOutputTokens = responseBody?.usage?.output_tokens ?? Math.ceil((result?.length || 0) / 4);
  const isValidation = !!deepseekAnalysis;
  const fallbackReason = fallbackReasonOverride || ((!deepseekAnalysis && hasImages) ? "images" : undefined);
  await trackUsage({
    timestamp: Date.now(),
    questionText: context.questionText.substring(0, 200),
    questionType: context.questionType,
    answer: result,
    source: "claude",
    model,
    inputTokens: realInputTokens,
    outputTokens: realOutputTokens,
    responseMode: context.responseMode,
    success: true,
    latencyMs: Date.now() - startTime,
    platform: detectPlatform(context.pageUrl),
    validated: isValidation,
    fallbackReason,
    confidence: deepseekAnalysis?.confidence,
    deepseekReasoning: deepseekAnalysis?.reasoning ?? undefined,
  });

  // For quick mode, extract the final answer
  if (isQuickMode && !isMatching) {
    result = extractClaudeQuickAnswer(result, context.questionType);
  }

  return { success: true, result, source: "claude" };
}

// ============================================
// Streaming Analysis for Full (non-quick) Mode
// ============================================

export async function analyzeQuestionStreaming(
  context: AnalysisContext,
  port: chrome.runtime.Port,
): Promise<void> {
  const startTime = Date.now();

  try {
    // ============================================
    // Question Bank Instant Match (skip AI entirely)
    // ============================================
    const bankMatch = await findMatchingQuestion(
      context.questionText,
      (context as AnalysisContext & { moduleInfo?: string }).moduleInfo || context.pageTitle,
      context.pageUrl,
    );

    if (bankMatch && (bankMatch.correctAnswer || bankMatch.correctAnswers) && bankMatch.similarity >= 80) {
      const answerLetter = matchCorrectAnswerToLetter(bankMatch, context.options);
      if (answerLetter) {
        const displayAnswer = bankMatch.correctAnswers ? bankMatch.correctAnswers.join(' | ') : bankMatch.correctAnswer || '';
        log(`[Study Assist] INSTANT ANSWER (streaming) from ${bankMatch.bankModel} (${bankMatch.similarity}% match): ${answerLetter}`);
        const bankConflictTelemetry = bankMatch.bankConflictDetected
          ? {
            bankConflictDetected: true,
            bankConflictType: bankMatch.bankConflictType,
            bankConflictAnswerSimilarity: bankMatch.bankConflictAnswerSimilarity,
            bankSecondaryModel: bankMatch.bankSecondaryModel,
          }
          : {};
        await trackUsage({
          timestamp: Date.now(),
          questionText: context.questionText.substring(0, 200),
          questionType: context.questionType,
          answer: answerLetter,
          source: "question-bank",
          model: bankMatch.bankModel,
          inputTokens: 0,
          outputTokens: 0,
          responseMode: context.responseMode,
          success: true,
          latencyMs: Date.now() - startTime,
          platform: detectPlatform(context.pageUrl),
          confidence: "HIGH",
          ...bankConflictTelemetry,
        });
        const bankChunkText = `**Respuesta del banco de preguntas (${bankMatch.similarity}% coincidencia):**\n\n**${answerLetter}** — ${displayAnswer}\n\n${bankMatch.explanation || ""}`;
        try {
          port.postMessage({ type: "STREAM_STATUS", status: "started" });
          port.postMessage({ type: "STREAM_CHUNK", chunk: bankChunkText });
          port.postMessage({ type: "STREAM_COMPLETE", fullText: bankChunkText, inputTokens: 0, outputTokens: 0, cost: 0 });
        } catch { /* port disconnected */ }
        return;
      }
    }

    // Rate limiting
    const rateLimitError = checkRateLimit(context.questionText);
    if (rateLimitError) {
      port.postMessage({ type: "STREAM_ERROR", error: rateLimitError });
      return;
    }
    recordRequest(context.questionText);

    const claudeApiKey = await getDecryptedApiKey("claudeApiKey");
    const storageResult = await chrome.storage.local.get(["claudeModel", "claudeThinking"]) as StorageData;
    const model = context.qaMode ? QA_CLAUDE_MODEL : (storageResult.claudeModel || DEFAULT_MODEL);
    const claudeThinkingEnabled = storageResult.claudeThinking === true;
    const isMatchingQuestion = context.questionType === "matching";

    if (!claudeApiKey) {
      port.postMessage({ type: "STREAM_ERROR", error: "Claude API key not configured." });
      return;
    }

    const matchedQuestion = bankMatch;

    const prompt = buildAnalysisPrompt(context, matchedQuestion);
    const messageContent = buildMessageContent(prompt, context.images);
    const maxTokens = 1024;
    const messages: ClaudeMessage[] = [{ role: "user", content: messageContent }];

    // Build request body with thinking for streaming
    const requestBody: Record<string, unknown> = { model, max_tokens: maxTokens, messages };
    if (claudeThinkingEnabled) {
      requestBody.thinking = { type: isMatchingQuestion ? "enabled" : "adaptive" };
    }

    port.postMessage({ type: "STREAM_STATUS", status: "started" });

    const result = await streamClaudeResponse(
      claudeApiKey,
      model,
      messages,
      maxTokens,
      {
        onChunk(text: string) {
          try {
            port.postMessage({ type: "STREAM_CHUNK", chunk: text });
          } catch { /* port disconnected */ }
        },
        onInputTokens(count: number) {
          try {
            port.postMessage({ type: "STREAM_STATUS", status: "input_tokens", inputTokens: count });
          } catch { /* port disconnected */ }
        },
        onComplete(outputTokens: number) {
          try {
            port.postMessage({ type: "STREAM_STATUS", status: "complete", outputTokens });
          } catch { /* port disconnected */ }
        },
        onError(error: string) {
          try {
            port.postMessage({ type: "STREAM_ERROR", error });
          } catch { /* port disconnected */ }
        },
      },
      undefined,
      requestBody.thinking as { type: string } | undefined,
    );

    // Track usage with real token counts from streaming
    await trackUsage({
      timestamp: Date.now(),
      questionText: context.questionText.substring(0, 200),
      questionType: context.questionType,
      answer: result.fullText.substring(0, 200),
      source: "claude",
      model,
      inputTokens: result.inputTokens,
      outputTokens: result.outputTokens,
      responseMode: context.responseMode,
      success: true,
      latencyMs: Date.now() - startTime,
      platform: detectPlatform(context.pageUrl),
    });

    port.postMessage({
      type: "STREAM_COMPLETE",
      fullText: result.fullText,
      inputTokens: result.inputTokens,
      outputTokens: result.outputTokens,
      cost: calculateCost(model, result.inputTokens, result.outputTokens),
    });
  } catch (error) {
    if ((error as Error).name !== "AbortError") {
      try {
        port.postMessage({ type: "STREAM_ERROR", error: (error as Error).message });
      } catch { /* port disconnected */ }
    }
  }
}
