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
  getClaudeThinkingConfig,
} from "./constants.js";
import type {
  StorageData,
  MessageResponse,
  ClaudeRequestBody,
  ClaudeMessage,
  ClaudeApiResponse,
  DeepSeekApiResponse,
  DeepSeekAnalysisResult,
  DeepSeekAnalysisForClaude,
} from "./constants.js";
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
} from "./parsing.js";
import { getDecryptedApiKey } from "./crypto.js";
import { trackUsage, calculateCost } from "./usageTracker.js";
import { checkRateLimit, recordRequest } from "./rateLimiter.js";
import { streamClaudeResponse } from "./streaming.js";
import { runProvider } from "./llm/execute.js";
import { getRoles, resolveRole, canPresetHandle, ensureProviderConfig } from "./llm/profiles.js";
import type { ResolvedRole } from "./llm/profiles.js";
import { getPreset } from "./llm/registry.js";
import type { ProviderPreset } from "./llm/contract.js";

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

/**
 * Map a provider preset to the legacy UsageRecord.source value used by the
 * dashboard until Step B2 switches it to provider/role.
 */
function legacySource(preset: ProviderPreset): "claude" | "deepseek" | "openai" {
  if (preset.dialect === "anthropic" || preset.id === "anthropic") return "claude";
  if (preset.id === "deepseek") return "deepseek";
  return "openai";
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
// Generic Provider Key Testing (Step B)
// ============================================

export async function testProviderKey(
  providerId: string,
  apiKey: string,
): Promise<MessageResponse> {
  let preset: ProviderPreset;
  try {
    preset = getPreset(providerId);
  } catch {
    return { success: false, error: `Unknown provider: ${providerId}` };
  }

  if (!apiKey) return { success: false, error: "Missing API key" };

  try {
    const run = await runProvider({
      preset,
      apiKey,
      model: preset.defaultModels[0],
      content: "Hello, respond with just OK to confirm.",
      maxTokens: 10,
      thinking: false,
      retries: 0,
      timeout: 30000,
    });

    await logError({
      type: "testProviderKey",
      url: run.url,
      status: run.status ?? undefined,
      responseBody: run.raw,
    });

    if (run.result.success) return { success: true };

    if (run.status === 429) {
      return { success: true, warning: "API key is valid but rate limited. It will work when the limit resets." };
    }

    return {
      success: false,
      error: run.result.error?.message || `API Error (${run.status ?? "network"})`,
    };
  } catch (error) {
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

export async function analyzeQuestion(context: AnalysisContext, onStatus?: (status: string) => void): Promise<AnalysisResponse> {
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

    const hasImages = !!(context.images && context.images.length > 0);
    const isMatching = context.questionType === "matching";
    const skipPrimary = context.skipDeepSeek === true;

    // Resolve the configured pipeline roles (primary → validator).
    // Lazily self-heal the provider config in case the lifecycle migration
    // did not run (unpacked reloads / MV3 worker wake-ups).
    await ensureProviderConfig();
    const roles = await getRoles();
    const primary = await resolveRole(roles.primary);
    const validator = await resolveRole(roles.validator);

    if (!primary && !validator) {
      return { success: false, error: "No provider configured. Add an API key in the dashboard." };
    }

    const canHandle = (
      resolved: ResolvedRole | null,
    ): resolved is ResolvedRole =>
      !!resolved && canPresetHandle(resolved.preset, hasImages, isMatching);

    const effectivePrimary = !skipPrimary && canHandle(primary) ? primary : null;
    const effectiveValidator = canHandle(validator) ? validator : null;

    if (!effectivePrimary && !effectiveValidator) {
      const reason = hasImages ? "images" : isMatching ? "matching questions" : "this request";
      return { success: false, error: `No configured provider supports ${reason}.` };
    }

    let primaryAnalysisForValidator: DeepSeekAnalysisForClaude | null = null;
    let fallbackReason: string | undefined;
    let primaryRetried = false;
    let validatorFallback = false;

    if (!effectivePrimary && effectiveValidator) {
      fallbackReason = hasImages ? "images" : isMatching ? "matching" : undefined;
      log("[Study Assist] Primary unavailable/incapable → validator handles the request");
    }

    if (skipPrimary) {
      log("[Study Assist] CTRL+SHIFT: using validator directly");
    }

    if (effectivePrimary) {
      let primaryResult = await analyzeWithPrimary(context, effectivePrimary);

      if (primaryResult.cancelled) {
        log("[Study Assist] Primary cancelled");
        if (!effectiveValidator) {
          return { success: false, error: "Analysis cancelled." };
        }
      } else if (!primaryResult.success) {
        if (primaryResult.skipRetry) {
          log(`[Study Assist] Primary failed (non-retryable) → validator fallback: ${primaryResult.error}`);
          validatorFallback = true;
        } else {
          log("[Study Assist] Primary failed, retrying...");
          onStatus?.("DEEPSEEK_RETRY");
          primaryRetried = true;
          await new Promise((r) => setTimeout(r, 1000));
          primaryResult = await analyzeWithPrimary(context, effectivePrimary);
        }

        if (!primaryResult.success && !primaryResult.cancelled) {
          log("[Study Assist] Primary failed → validator fallback");
          onStatus?.("CLAUDING_FALLBACK");
          fallbackReason = "primary_error";
          validatorFallback = true;
          if (!effectiveValidator) {
            return { success: false, error: primaryResult.error || "Primary API failed and no validator is available." };
          }
        }
      }

      if (primaryResult.success && primaryResult.confidence === "HIGH") {
        log("[Study Assist] Primary HIGH → Answer:", primaryResult.result);
        await trackUsage({
          timestamp: Date.now(),
          questionText: context.questionText.substring(0, 200),
          questionType: context.questionType,
          answer: primaryResult.result,
          source: legacySource(effectivePrimary.preset),
          provider: effectivePrimary.preset.id,
          role: "primary",
          model: effectivePrimary.model,
          inputTokens: primaryResult.inputTokens || 0,
          outputTokens: primaryResult.outputTokens || 0,
          cacheHitTokens: primaryResult.cacheHitTokens,
          responseMode: context.responseMode,
          success: true,
          latencyMs: Date.now() - startTime,
          platform: detectPlatform(context.pageUrl),
          confidence: "HIGH",
          deepseekReasoning: primaryResult.deepseekReasoning ?? undefined,
          deepseekThinkingEnabled: effectivePrimary.thinking,
        });
        return primaryResult;
      } else if (primaryResult.success) {
        if (!effectiveValidator) {
          log(`[Study Assist] Primary ${primaryResult.confidence} → Returning (no validator)`);
          primaryResult.explanation = `⚠️ **Low confidence (${primaryResult.confidence})** - No validator configured.\n\n${primaryResult.explanation || ""}`;
          await trackUsage({
            timestamp: Date.now(),
            questionText: context.questionText.substring(0, 200),
            questionType: context.questionType,
            answer: primaryResult.result,
            source: legacySource(effectivePrimary.preset),
            provider: effectivePrimary.preset.id,
            role: "primary",
            model: effectivePrimary.model,
            inputTokens: primaryResult.inputTokens || 0,
            outputTokens: primaryResult.outputTokens || 0,
            cacheHitTokens: primaryResult.cacheHitTokens,
            responseMode: context.responseMode,
            success: true,
            latencyMs: Date.now() - startTime,
            platform: detectPlatform(context.pageUrl),
            confidence: primaryResult.confidence,
            deepseekReasoning: primaryResult.deepseekReasoning ?? undefined,
            deepseekThinkingEnabled: effectivePrimary.thinking,
          });
          return primaryResult;
        }

        log(`[Study Assist] Primary ${primaryResult.confidence} → validator validation`);
        onStatus?.("CLAUDING_VALIDATING");
        primaryAnalysisForValidator = {
          answer: primaryResult.result!,
          confidence: primaryResult.confidence!,
          analysis: primaryResult.deepseekAnalysis!,
          reasoning: primaryResult.deepseekReasoning ?? null,
        };
      }
    }

    if (!effectiveValidator) {
      return { success: false, error: "No validator available to complete this request." };
    }

    // When validating/falling back after a primary attempt, let the validator
    // track its own latency. Pass the original startTime only when the
    // validator is primary (no primary attempt was made).
    const validatorStartTime = primaryAnalysisForValidator ? Date.now() : startTime;
    const validatorResponse = await analyzeWithValidator(
      context,
      effectiveValidator,
      primaryAnalysisForValidator,
      validatorStartTime,
      fallbackReason,
    );

    // Add status flags to response for visual feedback
    if (primaryRetried) validatorResponse.deepseekRetried = true;
    if (validatorFallback) validatorResponse.claudeFallback = true;

    return validatorResponse;
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

export async function analyzeWithPrimary(
  context: AnalysisContext,
  role: ResolvedRole,
): Promise<DeepSeekAnalysisResult> {
  try {
    const matchedQuestion = await findMatchingQuestion(
      context.questionText,
      (context as AnalysisContext & { moduleInfo?: string }).moduleInfo || context.pageTitle,
      context.pageUrl,
    );

    const prompt = buildDeepSeekPrompt(context, matchedQuestion);

    log(`[Study Assist] Calling ${role.preset.label} (primary)...`);

    const controller = new AbortController();
    setActiveDeepSeekController(controller);

    const run = await runProvider({
      preset: role.preset,
      apiKey: role.apiKey,
      model: role.model,
      content: prompt,
      maxTokens: 2048,
      thinking: role.thinking,
      reasoningEffort: "high",
      retries: 0,
      timeout: role.thinking ? 120000 : 60000,
      signal: controller.signal,
    });

    setActiveDeepSeekController(null);

    await logError({
      type: "analyzeWithPrimary",
      url: run.url,
      status: run.status ?? undefined,
      responseBody: run.raw,
    });

    // Save full API request/response for developer mode in dashboard
    try {
      await chrome.storage.local.set({
        lastApiRequestData: {
          timestamp: Date.now(),
          type: "analyzeWithPrimary",
          url: run.url,
          status: run.status,
          hasImages: false,
          requestBody: run.requestBody,
          responseBody: run.raw,
        },
      });
    } catch (_e) { /* silent */ }

    const result = run.result;

    if (result.cancelled) {
      log("[Study Assist] Primary request cancelled");
      return { success: false, error: `${role.preset.label} cancelled`, cancelled: true };
    }

    if (!result.success) {
      const skipRetry = result.error ? !result.error.retryable : false;
      const errorDescription = result.error?.message || `${role.preset.label} API error`;
      log(`[Study Assist] ${role.preset.label} error${skipRetry ? " (non-retryable)" : ""}: ${errorDescription}`);
      return { success: false, error: errorDescription, skipRetry };
    }

    const reasoningContent = result.reasoning ?? null;
    const text = result.text;

    if (!text) {
      return { success: false, error: `No response from ${role.preset.label}` };
    }

    if (DEBUG_MODE) {
      console.log(`[Study Assist] ====== ${role.preset.label} (primary) response ======`);
      console.log(`[Study Assist] Model: ${role.model} | Thinking: ${role.thinking ? "ON" : "OFF"}`);
      if (reasoningContent) console.log("[Study Assist] REASONING:", reasoningContent);
      console.log("[Study Assist] ANSWER:", text);
      console.log("[Study Assist] TOKENS:", result.usage.inputTokens, "+", result.usage.outputTokens);
      console.log("[Study Assist] ================================");
    }

    const parsed = parseDeepSeekResponse(text, context, reasoningContent);
    // Attach real token counts
    parsed.inputTokens = result.usage.inputTokens;
    parsed.outputTokens = result.usage.outputTokens;
    parsed.cacheHitTokens = result.usage.cacheHitTokens;
    return parsed;
  } catch (error) {
    setActiveDeepSeekController(null);
    if ((error as Error).name === "AbortError") {
      log("[Study Assist] Primary request cancelled");
      return { success: false, error: "Primary cancelled", cancelled: true };
    }
    return { success: false, error: `Primary error: ${(error as Error).message}` };
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
  const answerMatch = result.match(/ANSWER:\s*([A-Z]-\d+[\s,]*)+/i);
  if (answerMatch) {
    const pairsMatch = answerMatch[0].match(/[A-Z]-\d+/gi);
    if (pairsMatch) pairs = pairsMatch.map((p) => p.toUpperCase());
  }

  if (pairs.length === 0) {
    // Try bare pairs in the whole response
    const allPairs = result.match(/[A-Z]-\d+/gi);
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

export async function analyzeWithValidator(
  context: AnalysisContext,
  role: ResolvedRole,
  primaryAnalysis: DeepSeekAnalysisForClaude | null = null,
  startTime: number = Date.now(),
  fallbackReasonOverride?: string,
): Promise<AnalysisResponse> {
  let matchedQuestion = null;
  if (!primaryAnalysis) {
    matchedQuestion = await findMatchingQuestion(
      context.questionText,
      (context as AnalysisContext & { moduleInfo?: string }).moduleInfo || context.pageTitle,
      context.pageUrl,
    );
  }

  const prompt = primaryAnalysis
    ? buildClaudeValidationPrompt(context, primaryAnalysis)
    : buildAnalysisPrompt(context, matchedQuestion);

  log("[Study Assist] Validator analysis...", primaryAnalysis ? "(validating primary)" : "");

  const messageContent = buildMessageContent(prompt, context.images);

  const isQuickMode = context.responseMode === "quick";
  const isMatching = context.questionType === "matching";
  const hasImages = !!(context.images && context.images.length > 0);
  let maxTokens = primaryAnalysis ? 2048 : 1024;

  const shouldUseThinking = role.thinking === true;

  if (shouldUseThinking) {
    maxTokens = 4096;
  }

  log("[Study Assist] Validator config:", { model: role.model, maxTokens, hasImages, hasPrimaryAnalysis: !!primaryAnalysis, thinking: shouldUseThinking });

  const run = await runProvider({
    preset: role.preset,
    apiKey: role.apiKey,
    model: role.model,
    content: messageContent,
    maxTokens,
    thinking: shouldUseThinking,
    retries: 2,
    timeout: 45000,
  });

  await logError({
    type: "analyzeWithValidator",
    url: run.url,
    status: run.status ?? undefined,
    responseBody: run.raw,
    hasImages: hasImages || false,
  });

  // Save full API request/response for developer mode in dashboard
  try {
    await chrome.storage.local.set({
      lastApiRequestData: {
        timestamp: Date.now(),
        type: "analyzeWithValidator",
        url: run.url,
        status: run.status,
        hasImages: hasImages || false,
        requestBody: run.requestBody,
        responseBody: run.raw,
      },
    });
  } catch (_e) { /* silent */ }

  const runResult = run.result;
  if (runResult.cancelled) {
    return { success: false, error: `${role.preset.label} cancelled` };
  }
  if (!runResult.success) {
    return { success: false, error: runResult.error?.message || `${role.preset.label} API error` };
  }

  const claudeThinking = runResult.reasoning ?? undefined;
  let result = runResult.text;
  if (!result) return { success: false, error: "No response generated." };

  log("[Study Assist] Validator response:", result);

  // Validate matching answers structurally
  if (isMatching && !primaryAnalysis) {
    const validation = validateMatchingAnswer(result, context);
    if (!validation.valid) {
      log(`[Study Assist] Matching validation failed: ${validation.reason}. Retrying with stricter prompt...`);
      // Build a stricter prompt that demands structural output
      const strictPrompt = buildMatchingPrompt(context) + `

YOUR PREVIOUS RESPONSE WAS REJECTED because: ${validation.reason}

PLEASE RESPOND AGAIN with the CORRECT matches. Only output the match pairs — no extra text.`;
      const strictMessageContent = buildMessageContent(strictPrompt, context.images);

      const retryRun = await runProvider({
        preset: role.preset,
        apiKey: role.apiKey,
        model: role.model,
        content: strictMessageContent,
        maxTokens,
        thinking: shouldUseThinking,
        retries: 2,
        timeout: 45000,
      });

      if (retryRun.result.success && retryRun.result.text) {
        const retryResult = retryRun.result.text;
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
      // Note: if retry also fails, we continue with original result so user sees something
    } else if (validation.answer && validation.answer !== result.trim()) {
      // Answer is valid but could be normalized — use the clean version
      result = validation.answer;
    }
  }

  // Use real token counts from the provider, fall back to estimates
  const usage = runResult.usage;
  const realInputTokens = usage.inputTokens || Math.ceil((prompt?.length || 0) / 4);
  const realOutputTokens = usage.outputTokens || Math.ceil((result?.length || 0) / 4);
  const isValidation = !!primaryAnalysis;
  const fallbackReason = fallbackReasonOverride || ((!primaryAnalysis && hasImages) ? "images" : undefined);
  await trackUsage({
    timestamp: Date.now(),
    questionText: context.questionText.substring(0, 200),
    questionType: context.questionType,
    answer: result,
    source: legacySource(role.preset),
    provider: role.preset.id,
    role: "validator",
    model: role.model,
    inputTokens: realInputTokens,
    outputTokens: realOutputTokens,
    cacheHitTokens: usage.cacheHitTokens,
    responseMode: context.responseMode,
    success: true,
    latencyMs: Date.now() - startTime,
    platform: detectPlatform(context.pageUrl),
    validated: isValidation,
    fallbackReason,
    confidence: primaryAnalysis?.confidence,
    deepseekReasoning: primaryAnalysis?.reasoning ?? undefined,
    claudeThinking: claudeThinking,
  });

  // For quick mode, extract the final answer
  if (isQuickMode && !isMatching) {
    result = extractClaudeQuickAnswer(result, context.questionType);
  }

  return { success: true, result, source: legacySource(role.preset) };
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

    if (!claudeApiKey) {
      port.postMessage({ type: "STREAM_ERROR", error: "Claude API key not configured." });
      return;
    }

    const matchedQuestion = bankMatch;

    const prompt = buildAnalysisPrompt(context, matchedQuestion);
    const messageContent = buildMessageContent(prompt, context.images);
    let maxTokens = 1024;
    if (claudeThinkingEnabled) maxTokens = 4096;
    const messages: ClaudeMessage[] = [{ role: "user", content: messageContent }];

    // Build request body with model-aware thinking for streaming
    const requestBody: Record<string, unknown> = { model, max_tokens: maxTokens, messages };
    if (claudeThinkingEnabled) {
      requestBody.thinking = getClaudeThinkingConfig(model);
    }

    port.postMessage({ type: "STREAM_STATUS", status: "started" });

    let claudeThinkingText = "";
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
        onThinking(thinking: string) {
          claudeThinkingText += thinking;
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
      claudeThinking: claudeThinkingText || result.thinkingText || undefined,
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
