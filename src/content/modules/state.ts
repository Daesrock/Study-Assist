/**
 * Study Assist - State Management Module
 * Centralized state for the extension
 */

import type { State, Settings } from "../../types/index.js";

// ============================================
// Debug Mode
// ============================================
export const DEBUG_MODE = true;
export const log = (...args: unknown[]): void => {
  if (DEBUG_MODE) {
    console.log(...args);
  }
};

// ============================================
// State Object
// ============================================
export const state: State = {
  isActive: false,
  isDomainAllowed: false,
  isInitialized: false,
  settings: {
    responseMode: "guided",
    autoDetect: true,
    highlightQuestions: true,
    quickMode: false,
    sendImages: false,
    buttonPosition: "bottom-right",
  } as Settings,
  detectedQuestions: [],
  currentVisibleQuestion: null,
  overlayVisible: false,
  contentObserver: null,
  // Track current question for quick mode answer persistence
  lastAnsweredQuestionNum: null,
  questionChangeObserver: null,
  questionChangeInterval: null,
  // Prevent simultaneous API requests
  isRequestInProgress: false,
  // Block new requests when valid answer is displayed (until reload)
  hasValidAnswer: false,
  // Skip DeepSeek and use Claude directly (CTRL+SHIFT)
  skipDeepSeek: false,
  // Slow connection timer
  slowConnectionTimer: null,
  // Request cancelled by user (ALT+X)
  requestCancelled: false,
  // Pending question change (for double-confirmation)
  pendingQuestionChange: null,
};

// ============================================
// Default Configuration
// ============================================
export const DEFAULT_ALLOWED_DOMAINS: string[] = [];
