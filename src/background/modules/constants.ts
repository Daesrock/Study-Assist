/**
 * Background Service Worker - Constants & Shared State
 */

import { devLog, DEV_LOGGING } from "./logger.js";
import type { CustomProviderConfig } from "./llm/contract.js";

// ============================================
// Debug Mode
// ============================================
/**
 * Global debug flag, backed by the `debugMode` storage key. It is loaded on
 * service-worker start and updated on `chrome.storage.onChanged`, so the same
 * switch controls logs in both the background and the extension pages.
 * Defaults to `DEV_LOGGING` (on while developing).
 */
export let DEBUG_MODE = DEV_LOGGING;

export function setDebugMode(enabled: boolean): void {
  DEBUG_MODE = enabled;
}

function emit(level: string, args: unknown[]): void {
  if (!DEBUG_MODE) return;
  console.log(...args);
  const [first, ...rest] = args;
  devLog(
    "background",
    level,
    typeof first === "string" ? first : JSON.stringify(first),
    rest.length ? rest : undefined,
  );
}

export const log = (...args: unknown[]): void => {
  emit("log", args);
};

/** Provider-config debug logger; silenced unless the global flag is on. */
export const logProviders = (...args: unknown[]): void => {
  emit("providers", args);
};

// ============================================
// API Constants
// ============================================
export const ANTHROPIC_VERSION = "2023-06-01";

// ============================================
// Thinking Mode Helpers
// ============================================

export function isAdaptiveThinkingModel(model: string): boolean {
  return model.includes("sonnet-4-6") || model.includes("opus-4-6") || model.includes("opus-4-7") || model.includes("mythos");
}

export function getClaudeThinkingConfig(
  model: string,
  supportsAdaptive?: boolean,
): { type: string; budget_tokens?: number } {
  const adaptive = supportsAdaptive ?? isAdaptiveThinkingModel(model);
  if (adaptive) {
    return { type: "adaptive" };
  }
  return { type: "enabled", budget_tokens: 1024 };
}

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
  version?: string;
  generated?: string;
  source?: string;
  course?: string;
  modules: {
    [moduleKey: string]: {
      moduleRange?: string;
      title?: string;
      url?: string;
      questionCount?: number;
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
  bankModel: "questions-bank.json" | "questions-bank-ccnadesdecero.json";
  bankConflictDetected?: boolean;
  bankConflictType?: "semantic-equivalent" | "real-conflict";
  bankConflictAnswerSimilarity?: number;
  bankSecondaryModel?: "questions-bank.json" | "questions-bank-ccnadesdecero.json";
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

/** Price/capability metadata for a single model id (LiteLLM-derived). */
export interface ModelPriceInfo {
  /** USD per 1M input tokens. */
  inputPer1M: number;
  /** USD per 1M output tokens. */
  outputPer1M: number;
  /** USD per 1M cache-read (hit) input tokens (null = unknown). */
  cacheReadPer1M?: number | null;
  /** USD per 1M cache-write (creation) input tokens (null = unknown). */
  cacheWritePer1M?: number | null;
  /** Whether the model accepts image input (null when unknown). */
  vision: boolean | null;
  /** Whether the model supports reasoning/thinking (null when unknown). */
  reasoning?: boolean | null;
  /** Whether the model supports Anthropic adaptive thinking. */
  adaptive?: boolean | null;
  /** ISO date after which the model is deprecated (null when none). */
  deprecationDate?: string | null;
  maxInput?: number;
  maxOutput?: number;
  provider?: string;
  mode?: string;
}

/** Per-provider configuration, keyed by preset id. */
export interface ProviderProfile {
  /** AES-GCM encrypted API key. */
  apiKey?: string;
  /** Last detected model ids from the provider catalog. */
  models?: string[];
  /** Model ids added manually by the user. */
  customModels?: string[];
  /** User-overridden model ids that accept image input (vision). */
  visionModels?: string[];
  /** Explicit per-model vision overrides (win over detected capabilities). */
  visionOverrides?: Record<string, boolean>;
  /** Model ids the user chose to expose in the popup role selectors. */
  selectedModels?: string[];
  /** Whether `selectedModels` is auto-curated or manually managed. */
  selectionMode?: "auto" | "manual";
  /** Epoch ms of the last catalog sync. */
  lastSync?: number;
  /** Whether thinking/reasoning mode is enabled for this provider. */
  thinking?: boolean;
}

export interface RoleAssignment {
  provider: string;
  model: string;
}

export interface ProviderRoles {
  primary: RoleAssignment | null;
  validator: RoleAssignment | null;
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
  content?: Array<{ type: string; text?: string; thinking?: string; signature?: string }>;
  usage?: {
    input_tokens?: number;
    output_tokens?: number;
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
  cacheHitTokens?: number;
  cacheWriteTokens?: number;
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
  | "TEST_PROVIDER_KEY"
  | "TEST_PROVIDER_CONNECTION"
  | "ANALYZE_QUESTION"
  | "CANCEL_DEEPSEEK"
  | "TOGGLE_DISGUISE_MODE"
  | "PAGE_LOADED"
  | "GET_USAGE_STATS"
  | "GET_USAGE_HISTORY"
  | "CLEAR_USAGE_DATA"
  | "GET_STORAGE_INFO"
  | "TRIM_HISTORY"
  | "GET_PROVIDER_STATE"
  | "SAVE_PROVIDER_KEY"
  | "DELETE_PROVIDER_KEY"
  | "SET_PROVIDER_THINKING"
  | "SET_MODEL_VISION"
  | "SET_MODEL_SELECTED"
  | "SET_MODEL_ENDPOINT"
  | "SET_SELECTION_MODE"
  | "ADD_PROVIDER_MODEL"
  | "FETCH_PROVIDER_MODELS"
  | "UPDATE_MODEL_PRICES"
  | "SAVE_QA_MODEL"
  | "SAVE_ROLES"
  | "SAVE_CUSTOM_PROVIDER"
  | "DELETE_CUSTOM_PROVIDER"
  | "DEV_LOG";

export interface ExtensionMessage {
  type: ExtensionMessageType;
  active?: boolean;
  apiKey?: string;
  enabled?: boolean;
  provider?: string;
  model?: string;
  thinking?: boolean;
  vision?: boolean;
  selected?: boolean;
  endpoint?: string;
  selectionMode?: "auto" | "manual";
  test?: boolean;
  roles?: ProviderRoles;
  qaModel?: RoleAssignment | null;
  customProvider?: CustomProviderConfig;
  context?: import("../../types/index").AnalysisContext;
  url?: string;
  rawKey?: string;
  limit?: number;
  keepLast?: number;
  keepDays?: number;
  /** DEV_LOG payload. */
  level?: string;
  message?: string;
  data?: unknown;
  file?: string;
}
