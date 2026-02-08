/**
 * Study Assist - Type Definitions
 * Central type definitions for the extension
 */

// ============================================
// Question Types
// ============================================

export type QuestionType = 
  | "multiple-choice" 
  | "true-false" 
  | "fill-blank" 
  | "matching" 
  | "unknown";

export type QuestionPlatform = "moodle" | "netacad" | "general";

export type MatchingStyle = "drag-drop" | "dropdown" | "object-dropdown";

export interface QuestionOption {
  letter: string;
  text: string;
  image?: ImageData | null;
}

export interface MatchingCategory {
  letter: string;
  text: string;
}

export interface MatchingOption {
  index: number;
  text: string;
}

export interface ImageData {
  url?: string;
  base64?: string;
  mediaType: string;
  alt?: string;
  location?: "question" | "option";
}

export interface DetectedQuestion {
  id: string;
  element: Element;
  text: string;
  type: QuestionType;
  options: QuestionOption[];
  confidence: number;
  platform?: QuestionPlatform;
  questionNumber?: number;
  images?: ImageData[];
  courseName?: string; // Academic course name (e.g., "Sistemas Operativos")
  // For matching questions
  matchingStyle?: MatchingStyle;
  categories?: MatchingCategory[];
  matchingOptions?: MatchingOption[];
}

// ============================================
// State Types
// ============================================

export interface Settings {
  responseMode: "quick" | "guided" | "detailed" | "explanation";
  autoDetect: boolean;
  highlightQuestions: boolean;
  quickMode: boolean;
  sendImages: boolean;
  buttonPosition: "bottom-right" | "bottom-left" | "top-right" | "top-left";
}

export interface State {
  isActive: boolean;
  isDomainAllowed: boolean;
  isInitialized: boolean;
  settings: Settings;
  detectedQuestions: DetectedQuestion[];
  currentVisibleQuestion: DetectedQuestion | null;
  overlayVisible: boolean;
  contentObserver: MutationObserver | null;
  lastAnsweredQuestionNum: number | null;
  questionChangeObserver: MutationObserver | null;
  questionChangeInterval: ReturnType<typeof setInterval> | null;
  isRequestInProgress: boolean;
  hasValidAnswer: boolean;
  skipDeepSeek: boolean;
  slowConnectionTimer: ReturnType<typeof setTimeout> | null;
  requestCancelled: boolean;
  pendingQuestionChange: number | null;
}

// ============================================
// API Types
// ============================================

export interface AnalysisContext {
  questionText: string;
  questionType: string;
  options?: QuestionOption[];
  categories?: MatchingCategory[];
  matchingOptions?: MatchingOption[];
  matchingStyle?: MatchingStyle;
  images?: ImageData[];
  pageTitle: string;
  pageUrl: string;
  responseMode: string;
  skipDeepSeek?: boolean;
  courseName?: string; // Academic course name for better context
}

export interface AnalysisResponse {
  success: boolean;
  result?: string;
  error?: string;
  source?: "deepseek" | "claude" | "question-bank";
}

// ============================================
// Message Types
// ============================================

export type MessageType =
  | "EXTENSION_STATE_CHANGED"
  | "SETTINGS_CHANGED"
  | "ANALYZE_PAGE"
  | "CLEAR_RESULTS"
  | "ANALYSIS_RESULT"
  | "ANALYZE_QUESTION"
  | "PAGE_LOADED"
  | "CANCEL_DEEPSEEK"
  | "STREAM_CHUNK"
  | "STREAM_STATUS"
  | "STREAM_COMPLETE"
  | "STREAM_ERROR";

export interface ExtensionMessage {
  type: MessageType;
  [key: string]: unknown;
}

// ============================================
// Callback Types
// ============================================

export interface KeyboardCallbacks {
  triggerQuickAnalysis: () => void;
  reloadQuickMode: () => void;
  toggleSAButtonVisibility: () => void;
  cancelCurrentRequest: () => void;
}

export interface QuickClickCallbacks {
  detectVisibleQuestion: () => Promise<DetectedQuestion | null>;
  startQuestionChangeObserver: () => void;
}

export interface UICallbacks {
  frameHasQuizContent?: () => boolean;
  waitForQuizContent?: (callback: (found: boolean) => void) => void;
  handleQuickClick?: (e: MouseEvent) => void;
  refreshCurrentQuestion?: () => Promise<void>;
  analyzeQuestion?: (question: DetectedQuestion) => Promise<void>;
  detectVisibleQuestion?: () => Promise<DetectedQuestion | null>;
  showQuestionsSummary?: () => Promise<void>;
}

// ============================================
// Detection Types
// ============================================

export interface QuestionPatterns {
  questionMarkers: RegExp;
  multipleChoice: RegExp[];
  trueFalse: RegExp[];
  fillBlank: RegExp[];
}

export interface QuestionMapEntry {
  type: "mcq" | "matching";
  question: DetectedQuestion;
  score: number;
  element: Element;
}

export interface QuestionMap {
  [questionNumber: number]: QuestionMapEntry;
}

export interface DetectionResult {
  found: boolean;
  count: number;
  retryCount: number;
}

export interface DetectionCallbacks {
  highlightDetectedQuestions?: () => void;
  isChildOfProcessed?: (element: Element) => boolean;
}

// ============================================
// Question Bank Types
// ============================================

export interface QuestionBankEntry {
  question: string;
  answer: string;
  type?: QuestionType;
  options?: string[];
}

export interface QuestionBank {
  version: string;
  questions: QuestionBankEntry[];
}
