/**
 * LLM Provider Contract (normalized)
 *
 * Provider-agnostic shapes consumed by the orchestrator. Wire-specific
 * details (auth headers, request body, SSE event names) live in the
 * dialect adapters: `anthropic.ts` and `openaiCompat.ts`.
 */

/** The two model slots in the hybrid pipeline. */
export type LlmRole = "primary" | "validator";

/** The two wire dialects the extension speaks. */
export type LlmDialect = "anthropic" | "openai-compatible";

export type ProviderErrorKind =
  | "auth"
  | "rate_limit"
  | "timeout"
  | "bad_request"
  | "network"
  | "overloaded"
  | "insufficient_balance"
  | "unknown";

export interface ProviderError {
  kind: ProviderErrorKind;
  message: string;
  retryable: boolean;
  status?: number;
}

export interface NormalizedUsage {
  inputTokens: number;
  outputTokens: number;
  /** Tokens served from a provider prompt cache (when reported). */
  cacheHitTokens?: number;
  /** Tokens written to a provider prompt cache (when reported). */
  cacheWriteTokens?: number;
  /** True when the counts are estimated instead of reported. */
  estimated?: boolean;
}

/**
 * Normalized result of a single (non-streaming) provider call.
 * The orchestrator consumes this instead of provider-specific shapes.
 */
export interface ProviderResult {
  success: boolean;
  text?: string;
  reasoning?: string | null;
  usage: NormalizedUsage;
  error?: ProviderError;
  cancelled?: boolean;
}

/** Normalized streaming callbacks both dialects emit into. */
export interface NormalizedStreamCallbacks {
  onText: (chunk: string) => void;
  onReasoning: (chunk: string) => void;
  onInputTokens: (count: number) => void;
  onComplete: (outputTokens: number) => void;
  onError: (message: string) => void;
}

/** How a provider exposes reasoning / thinking controls. */
export type ReasoningKind =
  | "anthropic-thinking"
  | "deepseek"
  | "openai-effort"
  | "none";

export interface ProviderCapabilities {
  images: boolean;
  matching: boolean;
  reasoning: boolean;
}

/** Static description of a provider (data, not code). */
export interface ProviderPreset {
  /** Stable id used in storage and the UI. */
  id: string;
  /** Human-readable label. */
  label: string;
  dialect: LlmDialect;
  /** API root, without the endpoint path (the adapter appends it). */
  baseUrl: string;
  /** Accepted API key prefixes, used for validation. */
  keyPrefixes: string[];
  reasoningKind: ReasoningKind;
  /** Default thinking/reasoning state for this provider. */
  defaultThinking: boolean;
  capabilities: ProviderCapabilities;
  /** Shipped fallback models when the live catalog is unavailable. */
  defaultModels: string[];
  /** Curated models known to accept image input (vision). */
  visionModels: string[];
}

/** A preset resolved with the user's chosen model for a given role. */
export interface ResolvedModel {
  role: LlmRole;
  preset: ProviderPreset;
  model: string;
}
