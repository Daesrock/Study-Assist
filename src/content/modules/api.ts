/**
 * Study Assist - API Module
 * Handles API requests, question analysis, and quick mode interactions
 */

// Chrome API type declaration
declare const chrome: {
  runtime: {
    sendMessage: <T = unknown>(message: unknown) => Promise<T>;
    connect: (connectInfo: { name: string }) => chrome.runtime.Port;
  };
};

import type {
  DetectedQuestion,
  AnalysisContext,
  AnalysisResponse,
  QuickClickCallbacks,
  ImageData,
} from "../../types/index.js";
import { log, state, DEBUG_MODE } from "./state.js";
import { escapeHtml } from "./utils.js";
import {
  detectVisibleQuestion,
  detectVisibleQuestions,
  findVisibleQuestionNumber,
  frameHasQuizContent,
  waitForQuizContent,
} from "./detection.js";
import { extractImagesAsBase64 } from "./images.js";
import {
  resetQuickAnswer,
  createQuickButton,
  showLoading,
  hideLoading,
  displayAnalysisResult,
  displayAnalysisResultStreaming,
  displayError,
} from "./ui.js";

function isQASandboxActive(): boolean {
  return document.getElementById("study-assist-qa-sandbox") !== null;
}

function mapTrueFalseAnswer(result: string, options: { letter: string; text: string }[] = []): string {
  const normalized = result
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toUpperCase()
    .trim();

  if (/\b(V|TRUE|VERDADERO)\b/.test(normalized)) return "V";
  if (/\b(F|FALSE|FALSO)\b/.test(normalized)) return "F";

  const singleLetter = normalized.match(/\b([A-Z])\b/)?.[1];
  if (singleLetter) {
    const byLetter = options.find((opt) => opt.letter.toUpperCase() === singleLetter);
    if (byLetter) {
      const optText = byLetter.text
        .normalize("NFD")
        .replace(/[\u0300-\u036f]/g, "")
        .toUpperCase();
      if (/\b(TRUE|VERDADERO)\b/.test(optText)) return "V";
      if (/\b(FALSE|FALSO)\b/.test(optText)) return "F";
    }
  }

  return "?";
}

// ============================================
// Request Cancellation
// ============================================
let requestGeneration = 0;
const activePorts = new Set<chrome.runtime.Port>();
const cancelPorts = new Map<chrome.runtime.Port, () => void>();

/**
 * Cancel current API request
 * Called when pressing ALT+X
 */
export function cancelCurrentRequest(): void {
  log("[Study Assist] ALT+X pressed - cancelling current request");

  requestGeneration++;
  for (const cancel of cancelPorts.values()) cancel();
  cancelPorts.clear();
  activePorts.clear();
  const quickBtn = document.getElementById("study-assist-quick");

  // Set cancelled flag
  state.requestCancelled = true;

  // Clear slow connection timer
  if (state.slowConnectionTimer) {
    clearTimeout(state.slowConnectionTimer);
    state.slowConnectionTimer = null;
  }

  // Cancel any pending analysis request
  // Disconnect only this request's ports. A late global cancel message could
  // otherwise abort a newer request from the same frame.

  // Reset UI
  if (quickBtn) {
    quickBtn.innerHTML = `<span>SA</span>`;
    quickBtn.classList.remove("loading", "slow-connection");
  }
  hideLoading();
  state.isRequestInProgress = false;

  log("[Study Assist] Request cancelled by user");
}

// ============================================
// Quick Mode Reload
// ============================================

/**
 * Reload quick mode - recreates the quick button if it doesn't exist
 * Called when pressing ALT+W
 */
export function reloadQuickMode(
  callbacks: QuickClickCallbacks = {
    detectVisibleQuestion,
    startQuestionChangeObserver,
  }
): void {
  log("[Study Assist] ALT+W pressed - reloading quick mode");

  const existingBtn = document.getElementById("study-assist-quick");

  if (existingBtn) {
    // Button exists, just do a visual feedback animation (pulse effect)
    log("[Study Assist] Applying reloading animation to SA button");
    existingBtn.classList.add("reloading");
    setTimeout(() => {
      existingBtn.classList.remove("reloading");
    }, 500);

    // Re-detect the question
    handleQuickReload();
    log("[Study Assist] Quick mode reloaded, question re-detected");
  } else {
    // Button doesn't exist, try to create it
    if (state.settings.quickMode && frameHasQuizContent()) {
      createQuickButton({ handleQuickClick: (e: MouseEvent) => handleQuickClick(e) });
      log("[Study Assist] Quick button created");
    } else if (state.settings.quickMode) {
      // Wait for quiz content
      waitForQuizContent((hasContent: boolean) => {
        if (hasContent) {
          createQuickButton({ handleQuickClick: (e: MouseEvent) => handleQuickClick(e) });
          log("[Study Assist] Quick button created after waiting");
        } else {
          log("[Study Assist] No quiz content found in this frame");
        }
      });
    } else {
      log("[Study Assist] Quick mode is disabled in settings");
    }
  }
}

// ============================================
// Quick Analysis Trigger
// ============================================

/**
 * Trigger quick analysis - same as clicking the SA button
 * Called when pressing SHIFT key
 */
export function triggerQuickAnalysis(
  callbacks: QuickClickCallbacks = {
    detectVisibleQuestion,
    startQuestionChangeObserver,
  }
): void {
  log("[Study Assist] SHIFT pressed - triggering quick analysis");

  const quickBtn = document.getElementById("study-assist-quick");

  if (quickBtn) {
    // Check if already loading
    if (quickBtn.classList.contains("loading")) {
      log("[Study Assist] Already loading, ignoring");
      return;
    }

    // Trigger the quick click handler
    handleQuickClick();
  } else {
    log("[Study Assist] Quick button not found, trying to create first");
    // Try to create button first, then click it
    if (state.settings.quickMode && frameHasQuizContent()) {
      createQuickButton({ handleQuickClick: (e: MouseEvent) => handleQuickClick(e) });
      // Wait a bit for button to be created, then trigger
      setTimeout(() => {
        const btn = document.getElementById("study-assist-quick");
        if (btn) {
          handleQuickClick();
        }
      }, 100);
    }
  }
}

// ============================================
// Question Change Observer
// ============================================

/**
 * Start observing for question changes to reset the answer
 * Uses both MutationObserver and periodic checks for robustness
 */
export function startQuestionChangeObserver(): void {
  // Stop any existing observer
  if (state.questionChangeObserver) {
    state.questionChangeObserver.disconnect();
    state.questionChangeObserver = null;
  }

  // Also clear any existing interval
  if (state.questionChangeInterval) {
    clearInterval(state.questionChangeInterval);
    state.questionChangeInterval = null;
  }

  // Periodic check for question changes (more reliable for NetAcad's slide-based navigation)
  // Use a simple approach: just check the visible question number text, not full detection
  state.questionChangeInterval = setInterval(() => {
    if (state.lastAnsweredQuestionNum === null) {
      // No answer displayed, stop checking
      if (state.questionChangeInterval) {
        clearInterval(state.questionChangeInterval);
        state.questionChangeInterval = null;
      }
      return;
    }

    try {
      // Quick check: just find the visible question number without full detection
      const currentNum = findVisibleQuestionNumber();

      // Log current state for debugging
      if (DEBUG_MODE) {
        log(`[Observer] lastAnswered: ${state.lastAnsweredQuestionNum}, currentNum: ${currentNum}, pending: ${state.pendingQuestionChange}`);
      }

      // Only reset if we found a DIFFERENT question number (not null)
      // If currentNum is null, we couldn't detect the number - don't reset
      // Also require at least 2 consecutive detections of a different number
      // to avoid false positives from scroll/resize causing different scores
      if (currentNum !== null && currentNum !== state.lastAnsweredQuestionNum) {
        // First detection of change - store and wait for confirmation
        if (
          !state.pendingQuestionChange ||
          state.pendingQuestionChange !== currentNum
        ) {
          state.pendingQuestionChange = currentNum;
          log(`[Observer] Question change detected: ${state.lastAnsweredQuestionNum} → ${currentNum}, waiting for confirmation...`);
          return; // Wait for next interval to confirm
        }

        // Confirmed change (same different number detected twice)
        log(
          "[Study Assist] Question changed from",
          state.lastAnsweredQuestionNum,
          "to",
          currentNum
        );
        state.pendingQuestionChange = null;
        resetQuickAnswer();
        if (state.questionChangeInterval) {
          clearInterval(state.questionChangeInterval);
          state.questionChangeInterval = null;
        }
      } else if (currentNum === state.lastAnsweredQuestionNum) {
        // Same question - clear any pending change
        state.pendingQuestionChange = null;
      }
      // Note: if currentNum is null, we DON'T clear pendingQuestionChange
      // This way if we temporarily lose sight of the question number,
      // we don't reset the pending state
    } catch (e) {
      // Ignore errors during detection
    }
  }, 1000); // Check every 1 second (reduced frequency)
}

// ============================================
// Quick Reload Handler
// ============================================

/**
 * Handle quick reload button click
 */
export async function handleQuickReload(): Promise<void> {
  const quickBtn = document.getElementById("study-assist-quick");
  const container = document.getElementById("study-assist-quick-container");
  if (!quickBtn) return;

  // Show reloading animation on button
  quickBtn.classList.add("reloading");

  // Reset valid answer flag - allow new requests after reload
  state.hasValidAnswer = false;

  // Reset the main button
  quickBtn.innerHTML = `<span>SA</span>`;
  quickBtn.classList.remove(
    "has-answer",
    "multi-answer",
    "multi-answer-large",
    "matching-answer"
  );

  // Reset container alignment
  if (container) {
    container.classList.remove("matching-mode");
  }

  // Re-detect the question to verify (async now)
  detectVisibleQuestion().then((question: DetectedQuestion | null) => {
    // Small delay to show the refresh action
    setTimeout(() => {
      quickBtn.classList.remove("reloading");
    }, 500);
  });
}

// ============================================
// Quick Mode Shared Helpers
// ============================================

/** Max chars per answer token in multi-question mode (keeps button compact) */
export const QUICK_MULTI_TOKEN_MAXLEN = 48;

/**
 * Extract images for a single question, honoring the sendImages setting.
 * Extracted verbatim from handleQuickClick so single and multi paths share it.
 */
export async function extractImagesForQuestion(
  question: DetectedQuestion,
): Promise<ImageData[]> {
  let images: ImageData[] = [];
  log("[Study Assist] sendImages setting:", state.settings.sendImages);

  if (state.settings.sendImages) {
    if (question.platform === "moodle") {
      // For Moodle, images are already extracted in the question object
      if (question.images && question.images.length > 0) {
        images = [...question.images];
        log("[Study Assist] Moodle images found:", images.length);
      }
      // Also add images from options (when answers are images)
      if (question.options) {
        for (const opt of question.options) {
          if (opt.image) {
            images.push({
              ...opt.image,
              location: `option_${opt.letter}` as "question" | "option",
            });
          }
        }
      }
    } else if (question.element) {
      // For NetAcad, extract from shadow DOM
      // querySelectorAllDeep traverses shadow roots automatically
      try {
        log(
          "[Study Assist] Extracting images from NetAcad element:",
          question.element.tagName
        );
        images = await extractImagesAsBase64(question.element);
        log("[Study Assist] NetAcad images extracted:", images.length);
      } catch (imgError) {
        console.error("[Study Assist] Image extraction error:", imgError);
      }
    }
  } else {
    log("[Study Assist] sendImages is OFF - no images will be sent");
  }

  log("[Study Assist] Total images to send:", images.length);
  return images;
}

/**
 * Build the quick-mode AnalysisContext for a single question.
 * Extracted verbatim from handleQuickClick so single and multi paths share it.
 */
export function buildQuickContext(
  question: DetectedQuestion,
  images: ImageData[],
  skipPrimary: boolean,
): AnalysisContext {
  if (question.type === "matching") {
    // Matching question context
    return {
      questionText: question.text,
      questionType: "matching",
      matchingStyle: question.matchingStyle || "drag-drop", // "dropdown" or "drag-drop"
      categories: question.categories,
      matchingOptions: question.matchingOptions,
      images: images,
      pageTitle: document.title,
      pageUrl: window.location.href,
      responseMode: "quick",
      skipPrimary,
      courseName: question.courseName, // Academic course for context
      qaMode: isQASandboxActive(),
    };
  } else if (question.type === "select-missing-words") {
    return {
      questionText: question.text,
      questionType: "select-missing-words",
      selectGaps: question.selectGaps,
      selectChoices: question.selectChoices,
      images: images,
      pageTitle: document.title,
      pageUrl: window.location.href,
      responseMode: "quick",
      skipPrimary,
      courseName: question.courseName,
      qaMode: isQASandboxActive(),
    };
  } else if (question.type === "short-answer" || question.type === "numerical") {
    return {
      questionText: question.text,
      questionType: question.type,
      images: images,
      pageTitle: document.title,
      pageUrl: window.location.href,
      responseMode: "quick",
      skipPrimary,
      courseName: question.courseName,
      qaMode: isQASandboxActive(),
    };
  } else {
    // Regular multiple choice context
    return {
      questionText: question.text,
      questionType: question.type === "true-false" ? "true-false" : "multiple-choice",
      options: question.options,
      images: images,
      pageTitle: document.title,
      pageUrl: window.location.href,
      responseMode: "quick",
      skipPrimary,
      courseName: question.courseName, // Academic course for context
      qaMode: isQASandboxActive(),
    };
  }
}

/**
 * Send one quick-mode analysis request over the quick-analysis port.
 * Shows pipeline status emojis on the button while waiting.
 */
export function sendQuickAnalysis(
  context: AnalysisContext,
): Promise<AnalysisResponse> {
  return new Promise((resolve, reject) => {
    const port = chrome.runtime.connect({ name: "quick-analysis" });
    activePorts.add(port);
    let settled = false;
    const finish = (result?: AnalysisResponse, error?: Error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      activePorts.delete(port);
      cancelPorts.delete(port);
      port.onMessage.removeListener(onMessage);
      port.onDisconnect.removeListener(onDisconnect);
      port.disconnect();
      if (error) reject(error); else resolve(result!);
    };
    const timer = setTimeout(() => finish(undefined, new Error("Analysis timeout")), 360000);
    cancelPorts.set(port, () => finish(undefined, new Error("Analysis cancelled")));
    const onDisconnect = () => finish(undefined, new Error("Analysis connection lost or cancelled"));
    const onMessage = (msg: { type: string; status?: string; result?: AnalysisResponse }) => {
      if (settled) return;
      if (msg.type === "STATUS" && msg.status) {
        showQuickEmoji(msg.status);
      } else if (msg.type === "RESULT" && msg.result) {
        finish(msg.result);
      }
    };
    port.onMessage.addListener(onMessage);
    port.onDisconnect.addListener(onDisconnect);
    try { port.postMessage({ type: "ANALYZE_QUESTION", context }); }
    catch (error) { finish(undefined, error as Error); }
  });
}

/**
 * Reduce a raw API result to the short display token for one question.
 * Mirrors the single-question display branches below (matching pairs,
 * true-false V/F mapping, MCQ letter extraction, free-text passthrough).
 * Used by multi-question mode; the single path keeps its inline rendering.
 */
export function formatQuickToken(
  question: DetectedQuestion,
  rawResult: string,
): string {
  const result = rawResult.trim();
  if (question.type === "matching" || question.type === "select-missing-words") {
    return result.toUpperCase().trim().slice(0, QUICK_MULTI_TOKEN_MAXLEN);
  }
  if (question.type === "short-answer" || question.type === "numerical") {
    const displayAnswer = result || "?";
    return displayAnswer.length > QUICK_MULTI_TOKEN_MAXLEN
      ? displayAnswer.slice(0, QUICK_MULTI_TOKEN_MAXLEN - 1) + "…"
      : displayAnswer;
  }

  const upperResult = result.toUpperCase();

  if (question.type === "true-false") {
    return mapTrueFalseAnswer(result, question.options || []);
  }

  // Multiple answers (e.g., "A,D" or "A / C")
  const multiMatch = upperResult.match(
    /^([A-Z])\s*,\s*([A-Z])(?:\s*,\s*([A-Z]))?(?:\s*,\s*([A-Z]))?(?:\s*,\s*([A-Z]))?$/
  );
  const altMultiMatch = !multiMatch
    ? upperResult.match(/^([A-Z])\s*\/\s*([A-Z])(?:\s*\/\s*([A-Z]))?(?:\s*\/\s*([A-Z]))?(?:\s*\/\s*([A-Z]))?$/)
    : null;

  if (multiMatch || altMultiMatch) {
    const source = multiMatch || altMultiMatch!;
    const letters = [
      source[1],
      source[2],
      source[3],
      source[4],
      source[5],
    ].filter(Boolean);
    return letters.join(",");
  }

  const singleMatch = upperResult.match(/\b([A-Z])\b/);
  return singleMatch ? singleMatch[1] : "?";
}

/**
 * QuickMode multi-question flow: analyze each visible question sequentially
 * and render "QNUM:TOKEN" pairs vertically, reusing the matching-answer
 * button style (no new CSS needed).
 */
export async function handleQuickMulti(
  questions: DetectedQuestion[],
  callbacks: QuickClickCallbacks = {
    detectVisibleQuestion,
    startQuestionChangeObserver,
  },
): Promise<void> {
  const generation = requestGeneration;
  const quickBtn = document.getElementById("study-assist-quick");
  if (!quickBtn) return;
  const container = document.getElementById("study-assist-quick-container");

  // Capture the one-shot force-validator flag once for the whole batch
  const forceValidator = state.skipPrimary;
  state.skipPrimary = false;

  const pairs: string[] = [];
  let anySuccess = false;

  for (let i = 0; i < questions.length; i++) {
    const q = questions[i];
    if (state.requestCancelled || generation !== requestGeneration) {
      log("[Study Assist] Multi request cancelled, stopping batch");
      break;
    }

    log("[Study Assist] Multi analyzing question:", {
      index: i + 1,
      total: questions.length,
      questionNumber: q.questionNumber,
      questionType: q.type,
    });

    try {
      const images = await extractImagesForQuestion(q);
      if (generation !== requestGeneration) return;
      const context = buildQuickContext(q, images, forceValidator);
      const response = await sendQuickAnalysis(context);

      if (state.requestCancelled || generation !== requestGeneration) {
        log("[Study Assist] Multi request cancelled, ignoring response");
        break;
      }

      const num = q.questionNumber ?? i + 1;
      if (response.success && response.result) {
        anySuccess = true;
        pairs.push(`${num}:${formatQuickToken(q, response.result)}`);
      } else {
        pairs.push(`${num}:?`);
      }
    } catch (error) {
      console.error("[Study Assist] Multi analysis error:", error);
      const num = q.questionNumber ?? i + 1;
      pairs.push(`${num}:?`);
    }
  }

  // Clear slow connection timer
  if (state.slowConnectionTimer) {
    clearTimeout(state.slowConnectionTimer);
    state.slowConnectionTimer = null;
  }

  // Check if request was cancelled while waiting
  if (state.requestCancelled || generation !== requestGeneration) {
    log("[Study Assist] Multi request was cancelled, ignoring response");
    return;
  }

  quickBtn.classList.remove("loading", "slow-connection");
  state.isRequestInProgress = false;

  if (!anySuccess || pairs.length === 0) {
    quickBtn.innerHTML = `<span>!</span>`;
    setTimeout(() => {
      quickBtn.innerHTML = `<span>SA</span>`;
    }, 2000);
    return;
  }

  // Render vertically with the matching-answer style (white-space: pre-line)
  quickBtn.innerHTML = `<span class="study-assist-quick-answer study-assist-matching-answer">${escapeHtml(pairs.join("\n"))}</span>`;
  quickBtn.classList.add("has-answer", "matching-answer");
  if (container) container.classList.add("matching-mode");

  // Track the topmost answered question so the change observer resets on page nav
  state.lastAnsweredQuestionNum = questions[0].questionNumber ?? null;

  const observerFn =
    callbacks.startQuestionChangeObserver ?? startQuestionChangeObserver;
  observerFn();

  // Mark as valid answer - block new requests until reload
  state.hasValidAnswer = true;
}

// ============================================
// Quick Click Handler
// ============================================

/**
 * Main quick click handler - handles SA button clicks
 * Detects question, sends to API, and displays answer.
 * Automatically switches to multi-question mode when more than
 * one question is visible on screen.
 */
export async function handleQuickClick(
  e?: MouseEvent,
  callbacks: QuickClickCallbacks = {
    detectVisibleQuestion,
    detectVisibleQuestions,
    startQuestionChangeObserver,
  }
): Promise<void> {
  const quickBtn = document.getElementById("study-assist-quick");
  if (!quickBtn) return;

  // SECURITY: Block if already has valid answer (must use ALT+W to reload)
  if (state.hasValidAnswer) {
    log(
      "[Study Assist] Valid answer already displayed, use ALT+W to re-detect and request again"
    );
    return;
  }

  // SECURITY: Prevent simultaneous requests (global lock)
  if (state.isRequestInProgress) {
    log("[Study Assist] Request already in progress, ignoring");
    return;
  }

  // SECURITY: Also check loading state on button (double protection)
  if (quickBtn.classList.contains("loading")) {
    log("[Study Assist] Already loading (button state), ignoring");
    return;
  }

  // Set global lock
  state.isRequestInProgress = true;
  const generation = ++requestGeneration;
  state.requestCancelled = false; // Reset cancel flag

  // Reset any previous answer state before processing new request
  // This ensures we don't carry over state from previous questions
  if (state.questionChangeInterval) {
    clearInterval(state.questionChangeInterval);
    state.questionChangeInterval = null;
  }
  state.lastAnsweredQuestionNum = null;

  // Clear any previous slow connection timer
  if (state.slowConnectionTimer) {
    clearTimeout(state.slowConnectionTimer);
    state.slowConnectionTimer = null;
  }

  // Also reset visual state
  const container = document.getElementById("study-assist-quick-container");
  if (container) {
    container.classList.remove("matching-mode");
  }
  quickBtn.classList.remove(
    "has-answer",
    "multi-answer",
    "multi-answer-large",
    "matching-answer",
    "slow-connection"
  );

  // Show loading state
  quickBtn.innerHTML = `<span class="study-assist-quick-loading"></span>`;
  quickBtn.classList.add("loading");

  // Start slow connection timer (reasoning models can take 15-20s normally)
  state.slowConnectionTimer = setTimeout(() => {
    if (state.isRequestInProgress && quickBtn.classList.contains("loading")) {
      quickBtn.classList.add("slow-connection");
      quickBtn.innerHTML = `<span class="study-assist-slow-indicator">⏳</span>`;
    }
  }, 20000);

  try {
  // Detection can fail too: it must release the same lock as network failures.
  const detectFn = callbacks.detectVisibleQuestion ?? detectVisibleQuestion;
  const question = await detectFn();
  if (generation !== requestGeneration) return;

  if (!question) {
    quickBtn.innerHTML = `<span>?</span>`;
    quickBtn.classList.remove("loading");
    state.isRequestInProgress = false; // Release lock
    setTimeout(() => {
      quickBtn.innerHTML = `<span>SA</span>`;
    }, 1500);
    return;
  }

  // Multi-question mode: when more than one question is visible on screen
  // (e.g., Moodle pages showing several questions at once), answer all of
  // them sequentially. Single-question pages keep the flow below unchanged.
  const detectAllFn = callbacks.detectVisibleQuestions ?? detectVisibleQuestions;
  const visibleQuestions = await detectAllFn();
  if (generation !== requestGeneration) return;
  if (visibleQuestions.length > 1) {
    log("[Study Assist] Multi-question page detected:", visibleQuestions.length);
    await handleQuickMulti(visibleQuestions, callbacks);
    return;
  }

  // Get quick answer from API
    const images = await extractImagesForQuestion(question);
    if (generation !== requestGeneration) return;

    // Build context based on question type (shared with multi-question mode)
    const context = buildQuickContext(question, images, state.skipPrimary);

    // Reset skipPrimary flag after use
    state.skipPrimary = false;

    // Debug: Log what we're sending to API
    log("[Study Assist] Sending to API:", {
      questionNumber: question.questionNumber,
      questionType: question.type,
      questionText: question.text
        ? question.text.substring(0, 80)
        : "(no text)",
      optionsCount: question.options ? question.options.length : 0,
      options: question.options
        ? question.options.map(
            (o) => `${o.letter}: ${o.text ? o.text.substring(0, 30) : ""}`
          )
        : [],
    });

    const response: AnalysisResponse = await sendQuickAnalysis(context);

    // Clear slow connection timer
    if (state.slowConnectionTimer) {
      clearTimeout(state.slowConnectionTimer);
      state.slowConnectionTimer = null;
    }

    // Check if request was cancelled while waiting
    if (state.requestCancelled || generation !== requestGeneration) {
      log("[Study Assist] Request was cancelled, ignoring response");
      return;
    }

    quickBtn.classList.remove("loading", "slow-connection");
    state.isRequestInProgress = false;

    if (response.success && response.result) {
      const result = response.result.trim();

      // Get container for matching answer alignment
      const container = document.getElementById("study-assist-quick-container");

      // Save current question number to detect question changes
      state.lastAnsweredQuestionNum = question.questionNumber || null;

      // Start observing for question changes to reset the answer (for ALL question types)
      const observerFn =
        callbacks.startQuestionChangeObserver ?? startQuestionChangeObserver;
      observerFn();

      // Check if this is a matching question response
      if (question.type === "matching") {
        // Matching response format: 1-A, 2-B, 3-A or A-1, B-3, C-2
        // Convert comma-separated to vertical (newlines)
        const cleanResult = result.toUpperCase().trim().replace(/,\s*/g, "\n");

        // Show matching results vertically
        quickBtn.innerHTML = `<span class="study-assist-quick-answer study-assist-matching-answer">${escapeHtml(cleanResult)}</span>`;
        quickBtn.classList.add("has-answer", "matching-answer");
        if (container) container.classList.add("matching-mode");

        // Mark as valid answer - block new requests until reload
        state.hasValidAnswer = true;
      } else if (question.type === "select-missing-words") {
        // Gap-fill answer: [[1]]=HTTP, [[2]]=80, ...
        // Show on button vertically: one gap per line
        const cleanResult = result.trim().replace(/,\s*/g, "\n");
        quickBtn.innerHTML = `<span class="study-assist-quick-answer study-assist-matching-answer">${escapeHtml(cleanResult)}</span>`;
        quickBtn.classList.add("has-answer", "matching-answer");
        if (container) container.classList.add("matching-mode");
        state.hasValidAnswer = true;
      } else if (question.type === "short-answer" || question.type === "numerical") {
        // Free-text answer — display as-is on the button
        const displayAnswer = result.trim() || "?";
        quickBtn.innerHTML = `<span class="study-assist-quick-answer study-assist-matching-answer">${escapeHtml(displayAnswer)}</span>`;
        quickBtn.classList.add("has-answer", "matching-answer");
        if (container) container.classList.add("matching-mode");
        if (displayAnswer !== "?") {
          state.hasValidAnswer = true;
        }
      } else {
        // Regular multiple choice handling
        const upperResult = result.toUpperCase();

        if (question.type === "true-false") {
          const answer = mapTrueFalseAnswer(result, question.options || []);
          quickBtn.innerHTML = `<span class="study-assist-quick-answer">${answer}</span>`;
          quickBtn.classList.add("has-answer");

          if (answer !== "?") {
            state.hasValidAnswer = true;
          }
          return;
        }

        // Check for multiple answers (e.g., "A,D" or "A, D" or "B,C,E" or "A,E,G")
        // Support letters A-Z (up to 26 options)
        const multiMatch = upperResult.match(
          /^([A-Z])\s*,\s*([A-Z])(?:\s*,\s*([A-Z]))?(?:\s*,\s*([A-Z]))?(?:\s*,\s*([A-Z]))?$/
        );

        // Also detect "A / C" or "A and C" or "A y C" formats
        const altMultiMatch = !multiMatch
          ? upperResult.match(/^([A-Z])\s*\/\s*([A-Z])(?:\s*\/\s*([A-Z]))?(?:\s*\/\s*([A-Z]))?(?:\s*\/\s*([A-Z]))?$/)
          : null;

        let answer: string;
        let isMultiple = false;
        let isSingleSelectMulti = false; // Single-select questions with multiple correct answers

        // Detect if this is a single-select (radio) question with multiple correct answers
        if (multiMatch || altMultiMatch) {
          const element = question.element;
          const hasRadios = element instanceof HTMLElement
            && element.querySelectorAll('input[type="radio"]').length > 0;
          const hasCheckboxes = element instanceof HTMLElement
            && element.querySelectorAll('input[type="checkbox"]').length > 0;

          if (hasRadios && !hasCheckboxes) {
            // Single-select with multiple correct answers → use A / C format
            isSingleSelectMulti = true;
          }
        }

        if (multiMatch || altMultiMatch) {
          const source = multiMatch || altMultiMatch!;
          const letters = [
            source[1],
            source[2],
            source[3],
            source[4],
            source[5],
          ].filter(Boolean);

          if (isSingleSelectMulti) {
            answer = letters.join(" / ");
          } else {
            answer = letters.join(",");
          }
          isMultiple = true;
        } else {
          // Single answer
          const singleMatch = upperResult.match(/\b([A-Z])\b/);
          answer = singleMatch ? singleMatch[1] : "?";
        }

        quickBtn.innerHTML = `<span class="study-assist-quick-answer">${answer}</span>`;
        quickBtn.classList.add("has-answer");
        if (isMultiple) {
          if (isSingleSelectMulti) {
            quickBtn.classList.add("multi-answer");
          } else {
            quickBtn.classList.add("multi-answer");
            // Add extra-small class for 3+ answers
            const answerCount = answer.split(",").length;
            if (answerCount >= 3) {
              quickBtn.classList.add("multi-answer-large");
            }
          }
        }

        // Mark as valid answer ONLY if we got a real answer (not "?")
        if (answer !== "?") {
          state.hasValidAnswer = true;
        }

        // No timeout - answer persists until question changes
      }
    } else {
      quickBtn.innerHTML = `<span>!</span>`;
      quickBtn.classList.remove("slow-connection");
      state.isRequestInProgress = false; // Release lock
      setTimeout(() => {
        quickBtn.innerHTML = `<span>SA</span>`;
      }, 2000);
    }
  } catch (error) {
    if (generation !== requestGeneration) return;
    console.error("[Study Assist] Quick analysis error:", error);

    // Clear slow connection timer
    if (state.slowConnectionTimer) {
      clearTimeout(state.slowConnectionTimer);
      state.slowConnectionTimer = null;
    }

    quickBtn.classList.remove("loading", "slow-connection");
    quickBtn.innerHTML = `<span>!</span>`;
    state.isRequestInProgress = false; // Release lock
    setTimeout(() => {
      if (generation !== requestGeneration) return;
      quickBtn.innerHTML = `<span>SA</span>`;
    }, 2000);
  } finally {
    if (generation === requestGeneration && !state.isRequestInProgress && state.slowConnectionTimer) {
      clearTimeout(state.slowConnectionTimer);
      state.slowConnectionTimer = null;
    }
  }
}

// ============================================
// Full Analysis (Overlay Mode)
// ============================================

/**
 * Forward a content-script log/error to the background so it lands in
 * `logs/content.log` via the dev log server.
 */
function forwardDevLog(message: string, data?: unknown, level = "log"): void {
  try {
    const result = chrome.runtime.sendMessage({
      type: "DEV_LOG",
      level,
      message,
      data,
    }) as unknown as Promise<unknown> | undefined;
    if (result && typeof result.catch === "function") result.catch(() => {});
  } catch {
    // Ignore (no background / channel closed).
  }
}

/**
 * Full analysis for overlay mode
 * @param question - The question object to analyze
 * @param callbacks - Optional callbacks for dependency injection
 */
export async function analyzeQuestion(
  question: DetectedQuestion,
  callbacks: QuickClickCallbacks = {
    detectVisibleQuestion,
    startQuestionChangeObserver,
  }
): Promise<void> {
  if (!state.isActive || !state.isDomainAllowed || state.isRequestInProgress) return;
  state.isRequestInProgress = true;
  const generation = ++requestGeneration;
  showLoading();
  try {

  // Extract images based on platform
  let images: ImageData[] = [];
  if (state.settings.sendImages) {
    if (question.platform === "moodle") {
      // For Moodle, images are already extracted in the question object
      if (question.images && question.images.length > 0) {
        images = [...question.images];
      }
      // Also add images from options (when answers are images)
      if (question.options) {
        for (const opt of question.options) {
          if (opt.image) {
            images.push({
              ...opt.image,
              location: `option_${opt.letter}` as "question" | "option",
            });
          }
        }
      }
    } else if (question.element) {
      // For NetAcad, extract from shadow DOM
      // querySelectorAllDeep traverses shadow roots automatically
      try {
        images = await extractImagesAsBase64(question.element);
      } catch (imgError) {
        // Silent fail for image extraction
      }
    }
  }

  // Prepare context for analysis
  let context: AnalysisContext;
  if (question.type === "matching") {
    // Matching question context
    context = {
      questionText: question.text,
      questionType: "matching",
      matchingStyle: question.matchingStyle || "drag-drop", // "dropdown" or "drag-drop"
      categories: question.categories,
      matchingOptions: question.matchingOptions,
      images: images,
      pageTitle: document.title,
      pageUrl: window.location.href,
      responseMode: state.settings.responseMode,
      courseName: question.courseName, // Academic course for context
      qaMode: isQASandboxActive(),
    };
  } else if (question.type === "select-missing-words") {
    context = {
      questionText: question.text,
      questionType: "select-missing-words",
      selectGaps: question.selectGaps,
      selectChoices: question.selectChoices,
      images: images,
      pageTitle: document.title,
      pageUrl: window.location.href,
      responseMode: state.settings.responseMode,
      courseName: question.courseName,
      qaMode: isQASandboxActive(),
    };
  } else if (question.type === "short-answer" || question.type === "numerical") {
    context = {
      questionText: question.text,
      questionType: question.type,
      images: images,
      pageTitle: document.title,
      pageUrl: window.location.href,
      responseMode: state.settings.responseMode,
      courseName: question.courseName,
      qaMode: isQASandboxActive(),
    };
  } else {
    // Regular multiple choice context
    context = {
      questionText: question.text,
      questionType: question.type === "true-false" ? "true-false" : "multiple-choice",
      options: question.options,
      images: images,
      pageTitle: document.title,
      pageUrl: window.location.href,
      responseMode: state.settings.responseMode,
      courseName: question.courseName, // Academic course for context
      qaMode: isQASandboxActive(),
    };
  }

    // Send to background script for API processing
    // Use streaming via port for full (non-quick) mode
    if (generation !== requestGeneration) return;
    const port = chrome.runtime.connect({ name: "stream-analysis" });
    activePorts.add(port);

    displayAnalysisResultStreaming("", question, callbacks.showQuestionsSummary, true);

    let fullText = "";
    let streamInputTokens = 0;
    let streamOutputTokens = 0;
    let streamCost = 0;

    await new Promise<void>((resolve, reject) => {
      let settled = false;
      const finish = (error?: Error) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        activePorts.delete(port);
        cancelPorts.delete(port);
        port.onMessage.removeListener(onMessage);
        port.onDisconnect.removeListener(onDisconnect);
        port.disconnect();
        if (error) reject(error); else resolve();
      };
      const timer = setTimeout(() => finish(new Error("Stream timeout")), 360000);
      cancelPorts.set(port, () => finish(new Error("Analysis cancelled")));

      const onMessage = (msg: Record<string, unknown>) => {
        if (settled || generation !== requestGeneration) return;
        switch (msg.type) {
          case "STREAM_CHUNK":
            fullText += msg.chunk as string;
            displayAnalysisResultStreaming(fullText, question, callbacks.showQuestionsSummary, false);
            break;
          case "STREAM_STATUS":
            if (msg.status === "input_tokens") {
              streamInputTokens = msg.inputTokens as number;
            }
            if (msg.status === "complete") {
              streamOutputTokens = msg.outputTokens as number;
            }
            break;
          case "STREAM_COMPLETE":
            streamInputTokens = msg.inputTokens as number || streamInputTokens;
            streamOutputTokens = msg.outputTokens as number || streamOutputTokens;
            streamCost = msg.cost as number || 0;
            hideLoading();
            displayAnalysisResultStreaming(
              fullText,
              question,
              callbacks.showQuestionsSummary,
              false,
              { inputTokens: streamInputTokens, outputTokens: streamOutputTokens, cost: streamCost },
            );
            forwardDevLog("stream complete", {
              questionType: question.type,
              inputTokens: streamInputTokens,
              outputTokens: streamOutputTokens,
              cost: streamCost,
            });
            finish();
            break;
          case "STREAM_ERROR":
            hideLoading();
            forwardDevLog("stream error", { error: msg.error, questionType: question.type }, "error");
            displayError(msg.error as string || "Error de transmisión", callbacks.showQuestionsSummary);
            finish(new Error(msg.error as string));
            break;
        }
      };

      const onDisconnect = () => {
        if (settled) return;
        finish(new Error("Conexión perdida: respuesta incompleta"));
      };
      port.onMessage.addListener(onMessage);
      port.onDisconnect.addListener(onDisconnect);

      try { port.postMessage({ context }); } catch (error) { finish(error as Error); }
    });
  } catch (error) {
    if (generation !== requestGeneration) return;
    hideLoading();
    forwardDevLog("full analysis failed", { error: (error as Error).message }, "error");
    displayError((error as Error).message, callbacks.showQuestionsSummary);
  } finally {
    if (generation === requestGeneration) state.isRequestInProgress = false;
  }
}

// ============================================
// Visual Feedback Helpers
// ============================================

const STATUS_EMOJIS: Record<string, string> = {
  PRIMARY_RETRY: "⚠️",
  VALIDATOR_FALLBACK: "🔄",
  VALIDATOR_VALIDATING: "🔍",
};

/**
 * Show an emoji on the SA button during processing to indicate pipeline status.
 * The emoji is replaced by the actual answer when the final RESULT arrives.
 */
function showQuickEmoji(status: string): void {
  const btn = document.getElementById("study-assist-quick");
  if (!btn) return;
  const emoji = STATUS_EMOJIS[status];
  if (emoji) btn.innerHTML = `<span>${emoji}</span>`;
}

export const __testOnlyQuickMode = {
  showQuickEmoji,
  STATUS_EMOJIS,
  formatQuickToken,
  buildQuickContext,
  extractImagesForQuestion,
  sendQuickAnalysis,
  handleQuickMulti,
  QUICK_MULTI_TOKEN_MAXLEN,
};
