/**
 * Study Assist - Content Script Entry Point
 * Initializes the extension and wires modules together
 */

// ============================================
// Module Imports
// ============================================
import { log, state, DEFAULT_ALLOWED_DOMAINS } from "./modules/state.js";
import {
  detectQuestionsOnPage,
  detectVisibleQuestion,
  refreshCurrentQuestion,
  frameHasQuizContent,
  waitForQuizContent,
} from "./modules/detection.js";
import {
  showReloadPrompt,
  createOverlayContainer,
  createQuickButton,
  highlightDetectedQuestions,
  clearAllHighlights,
  hideOverlay,
  displayAnalysisResult,
  resetQuickAnswer,
  toggleSAButtonVisibility,
  displaySingleQuestion,
  showQuestionsSummary,
} from "./modules/ui.js";
import { setupKeyboardHandlers } from "./modules/keyboard.js";
import {
  handleQuickClick,
  reloadQuickMode,
  triggerQuickAnalysis,
  cancelCurrentRequest,
  analyzeQuestion,
  startQuestionChangeObserver,
} from "./modules/api.js";

import type { DetectedQuestion, Settings } from "../types/index.js";

// ============================================
// Domain Check
// ============================================
async function checkDomainAllowed(): Promise<boolean> {
  try {
    const result = await chrome.storage.local.get(["allowedDomains"]);
    const allowedDomains: string[] = result.allowedDomains ?? DEFAULT_ALLOWED_DOMAINS;

    const currentHostname = window.location.hostname.toLowerCase();

    const isAllowed = allowedDomains.some((domain: string) => {
      return (
        currentHostname === domain || currentHostname.endsWith("." + domain)
      );
    });

    state.isDomainAllowed = isAllowed;
    return isAllowed;
  } catch (error) {
    console.error("[Study Assist] Error checking domain:", error);
    return false;
  }
}

// ============================================
// Content Observer
// ============================================
function setupContentObserver(): void {
  if (state.contentObserver) return;

  let debounceTimer: ReturnType<typeof setTimeout> | null = null;

  state.contentObserver = new MutationObserver((_mutations: MutationRecord[]) => {
    if (debounceTimer) clearTimeout(debounceTimer);
    debounceTimer = setTimeout(() => {
      if (
        state.settings.quickMode &&
        !document.getElementById("study-assist-quick-container")
      ) {
        if (frameHasQuizContent()) {
          initQuickButton();
        }
      }
    }, 500);
  });

  state.contentObserver.observe(document.body ?? document.documentElement, {
    childList: true,
    subtree: true,
  });
}

// ============================================
// Quick Button Initialization with Callbacks
// ============================================
function initQuickButton(): void {
  createQuickButton({
    handleQuickClick: (e: MouseEvent) =>
      handleQuickClick(e, {
        detectVisibleQuestion,
        startQuestionChangeObserver,
      }),
  });
}

// ============================================
// Callback wrappers
// ============================================

/** Analyze a question with proper callback wiring */
function analyzeQuestionWithCallbacks(question: DetectedQuestion): Promise<void> {
  return analyzeQuestion(question, {
    detectVisibleQuestion,
    startQuestionChangeObserver,
  });
}

/** Show questions summary with proper callback wiring */
function showQuestionsSummaryWithCallbacks(): Promise<void> {
  return showQuestionsSummary(detectVisibleQuestion, analyzeQuestionWithCallbacks);
}

// ============================================
// Overlay Container Initialization with Callbacks
// ============================================
function initOverlayContainer(): void {
  createOverlayContainer({
    frameHasQuizContent,
    waitForQuizContent,
    handleQuickClick: (e: MouseEvent) =>
      handleQuickClick(e, {
        detectVisibleQuestion,
        startQuestionChangeObserver,
      }),
  });
}

// ============================================
// Keyboard Setup with Callbacks
// ============================================
function initKeyboardHandlers(): void {
  setupKeyboardHandlers({
    triggerQuickAnalysis: () =>
      triggerQuickAnalysis({
        detectVisibleQuestion,
        startQuestionChangeObserver,
      }),
    reloadQuickMode: () =>
      reloadQuickMode({
        detectVisibleQuestion,
        startQuestionChangeObserver,
      }),
    toggleSAButtonVisibility,
    cancelCurrentRequest,
  });
}

// ============================================
// Detection with Callbacks
// ============================================
async function runDetection(): Promise<void> {
  const result = await detectQuestionsOnPage();
  
  if (result && result.found && state.settings.highlightQuestions) {
    highlightDetectedQuestions(analyzeQuestionWithCallbacks);
  }
}

// ============================================
// Initialization
// ============================================
async function initialize(): Promise<void> {
  try {
    const domainAllowed = await checkDomainAllowed();
    if (!domainAllowed) {
      return;
    }

    const result = await chrome.storage.local.get([
      "extensionActive",
      "responseMode",
      "autoDetect",
      "highlightQuestions",
      "quickMode",
      "sendImages",
      "buttonPosition",
    ]);

    state.isActive = result.extensionActive ?? false;

    if (!state.isActive) {
      return;
    }

    state.settings.responseMode = result.responseMode ?? "guided";
    state.settings.autoDetect = result.autoDetect ?? true;
    state.settings.highlightQuestions = result.highlightQuestions ?? true;
    state.settings.quickMode = result.quickMode ?? false;
    state.settings.sendImages = result.sendImages ?? false;
    state.settings.buttonPosition = result.buttonPosition ?? "bottom-right";

    state.isInitialized = true;

    try {
      if (state.settings.quickMode) {
        initKeyboardHandlers();
      }
    } catch (kbErr) {
      console.error("[Study Assist] Keyboard init error:", kbErr);
    }

    try {
      initOverlayContainer();
    } catch (ovErr) {
      console.error("[Study Assist] Overlay init error:", ovErr);
    }

    if (state.isActive && state.settings.autoDetect) {
      setTimeout(() => runDetection(), 1000);
    }

    try {
      setupContentObserver();
    } catch (obsErr) {
      console.error("[Study Assist] Observer init error:", obsErr);
    }
  } catch (error) {
    console.error("[Study Assist] Initialization error:", error);
  }
}

// ============================================
// Message Listener
// ============================================
interface ContentMessage {
  type: string;
  active?: boolean;
  settings?: Partial<Settings>;
  result?: string;
  question?: DetectedQuestion;
}

chrome.runtime.onMessage.addListener(
  (
    message: ContentMessage,
    _sender: chrome.runtime.MessageSender,
    sendResponse: (response: { success: boolean; error?: string }) => void
  ): boolean => {
    switch (message.type) {
      case "EXTENSION_STATE_CHANGED":
        state.isActive = message.active ?? false;
        if (!state.isActive) {
          clearAllHighlights();
          hideOverlay();
        } else if (!state.isInitialized) {
          checkDomainAllowed().then((allowed) => {
            if (allowed) {
              showReloadPrompt();
            }
          });
        } else if (state.isDomainAllowed && state.settings.autoDetect) {
          runDetection();
        }
        sendResponse({ success: true });
        break;

      case "SETTINGS_CHANGED":
        if (!state.isDomainAllowed) {
          sendResponse({ success: false, error: "Domain not allowed" });
          break;
        }
        const oldQuickMode = state.settings.quickMode;
        state.settings = { ...state.settings, ...message.settings } as Settings;

        if (oldQuickMode !== state.settings.quickMode) {
          initOverlayContainer();
          if (state.settings.quickMode) {
            initKeyboardHandlers();
          }
        }

        if (state.settings.highlightQuestions && state.isActive) {
          highlightDetectedQuestions(analyzeQuestionWithCallbacks);
        } else {
          clearAllHighlights();
        }
        sendResponse({ success: true });
        break;

      case "ANALYZE_PAGE":
        if (!state.isDomainAllowed) {
          sendResponse({ success: false, error: "Domain not allowed" });
          break;
        }
        if (state.isActive) {
          runDetection();
        }
        sendResponse({ success: true });
        break;

      case "CLEAR_RESULTS":
        clearAllHighlights();
        hideOverlay();
        state.detectedQuestions = [];
        sendResponse({ success: true });
        break;

      case "FORCE_STATE_RESET":
        // Reset all processing locks without clearing UI or history
        state.isRequestInProgress = false;
        state.hasValidAnswer = false;
        state.skipDeepSeek = false;
        state.requestCancelled = false;
        state.pendingQuestionChange = null;
        if (state.slowConnectionTimer) {
          clearTimeout(state.slowConnectionTimer);
          state.slowConnectionTimer = null;
        }
        log("[Study Assist] Force state reset complete");
        sendResponse({ success: true });
        break;

      case "ANALYSIS_RESULT":
        if (message.result && message.question) {
          displayAnalysisResult(
            message.result,
            message.question,
            showQuestionsSummaryWithCallbacks
          );
        }
        sendResponse({ success: true });
        break;
    }

    return true; // Keep the message channel open for async response
  }
);

// ============================================
// Start
// ============================================
initialize();
