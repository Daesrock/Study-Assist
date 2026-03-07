/**
 * Background Service Worker - Constants & Shared State
 */

// ============================================
// Debug Mode
// ============================================
export const DEBUG_MODE: boolean = true;
export const log = (...args: unknown[]): void => {
  if (DEBUG_MODE) console.log(...args);
};

// ============================================
// API Constants
// ============================================
export const CLAUDE_API_BASE = "https://api.anthropic.com/v1/messages";
export const DEFAULT_MODEL = "claude-3-haiku-20240307";
export const ANTHROPIC_VERSION = "2023-06-01";

export const DEEPSEEK_API_BASE = "https://api.deepseek.com/v1/chat/completions";
export const DEEPSEEK_REASONER_MODEL = "deepseek-reasoner";

// ============================================
// Mutable Shared State
// ============================================

/** Active DeepSeek AbortController for cancellation */
export let activeDeepSeekController: AbortController | null = null;

export function setActiveDeepSeekController(ctrl: AbortController | null): void {
  activeDeepSeekController = ctrl;
}

/** Cached questions bank */
export let questionsBank: QuestionsBank | null = null;

export function setQuestionsBank(bank: QuestionsBank | null): void {
  questionsBank = bank;
}

// ============================================
// Type Definitions
// ============================================

export interface QuestionsBank {
  modules: {
    [moduleKey: string]: {
      questions: QuestionBankQuestion[];
    };
  };
}

export interface QuestionBankQuestion {
  text: string;
  textNormalized: string;
  options: string[];
  explanation?: string;
  correctAnswer?: string;
  correctAnswers?: string[];
}

export interface MatchedQuestion extends QuestionBankQuestion {
  moduleRange: string;
  similarity: number;
}

export type ConfidenceLevel = "HIGH" | "MEDIUM" | "LOW";

export interface NumberWordMap {
  [key: string]: number;
}

export interface ErrorLogObject {
  type: string;
  url?: string;
  status?: number;
  statusText?: string;
  responseBody?: unknown;
  error?: string;
  stack?: string;
  hasImages?: boolean;
}

export interface StorageData {
  claudeApiKey?: string;
  claudeModel?: string;
  useDeepSeek?: boolean;
  deepseekApiKey?: string;
  deepseekOnly?: boolean;
  extensionActive?: boolean;
  disguiseMode?: boolean;
  responseMode?: string;
  autoDetect?: boolean;
  highlightQuestions?: boolean;
  errorLog?: string;
}

export interface MessageResponse {
  success: boolean;
  error?: string;
  warning?: string;
  cancelled?: boolean;
}

export interface FetchOptionsWithSignal extends RequestInit {
  signal?: AbortSignal;
}

// Claude types
export interface ClaudeRequestBody {
  model: string;
  max_tokens: number;
  messages: ClaudeMessage[];
}

export interface ClaudeMessage {
  role: "user" | "assistant";
  content: string | ClaudeContentBlock[];
}

export type ClaudeContentBlock = ClaudeTextBlock | ClaudeImageBlock;

export interface ClaudeTextBlock {
  type: "text";
  text: string;
}

export interface ClaudeImageBlock {
  type: "image";
  source: ClaudeImageSourceBase64 | ClaudeImageSourceUrl;
}

export interface ClaudeImageSourceBase64 {
  type: "base64";
  media_type: string;
  data: string;
}

export interface ClaudeImageSourceUrl {
  type: "url";
  url: string;
}

export interface ClaudeApiResponse {
  content?: Array<{ type: string; text?: string }>;
  usage?: {
    input_tokens?: number;
    output_tokens?: number;
  };
  error?: { message: string; type?: string };
  parseError?: string;
}

// DeepSeek types
export interface DeepSeekRequestBody {
  model: string;
  max_tokens: number;
  messages: DeepSeekMessage[];
}

export interface DeepSeekMessage {
  role: "user" | "assistant" | "system";
  content: string;
}

export interface DeepSeekApiResponse {
  choices?: Array<{
    message?: {
      content?: string;
      reasoning_content?: string;
    };
  }>;
  usage?: {
    prompt_tokens?: number;
    completion_tokens?: number;
    total_tokens?: number;
  };
  error?: { message: string; type?: string };
  parseError?: string;
}

export interface DeepSeekAnalysisResult {
  success: boolean;
  result?: string;
  error?: string;
  source?: "deepseek" | "claude" | "question-bank";
  confidence?: ConfidenceLevel;
  deepseekAnalysis?: string;
  deepseekReasoning?: string | null;
  cancelled?: boolean;
  /** When true, the orchestrator should NOT retry — go directly to Claude fallback */
  skipRetry?: boolean;
  explanation?: string;
  inputTokens?: number;
  outputTokens?: number;
}

export interface DeepSeekAnalysisForClaude {
  answer: string;
  confidence: ConfidenceLevel;
  analysis: string;
  reasoning: string | null;
}

// Message types
export type ExtensionMessageType =
  | "TOGGLE_EXTENSION"
  | "TEST_API_KEY"
  | "TEST_DEEPSEEK_API_KEY"
  | "ANALYZE_QUESTION"
  | "CANCEL_DEEPSEEK"
  | "TOGGLE_DISGUISE_MODE"
  | "PAGE_LOADED"
  | "ENCRYPT_AND_SAVE_KEY"
  | "GET_USAGE_STATS"
  | "GET_USAGE_HISTORY"
  | "CLEAR_USAGE_DATA"
  | "GET_STORAGE_INFO"
  | "TRIM_HISTORY";

export interface ExtensionMessage {
  type: ExtensionMessageType;
  active?: boolean;
  apiKey?: string;
  enabled?: boolean;
  context?: import("../../types/index").AnalysisContext;
  url?: string;
  keyType?: string;
  rawKey?: string;
  limit?: number;
  keepLast?: number;
  keepDays?: number;
}
