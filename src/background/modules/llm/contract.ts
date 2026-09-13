/**
 * LLM Provider Contract (normalized)
 *
 * Provider-agnostic shapes consumed by the orchestrator. Wire-specific
 * details (auth headers, request body, SSE event names) live in the
 * dialect adapters: `anthropic.ts` and `openaiCompat.ts`.
 */

/** The two model slots in the hybrid pipeline. */
export type LlmRole = "primary" | "validator";

/** The wire dialects the extension speaks. */
export type LlmDialect = "anthropic" | "openai-compatible" | "openai-responses";

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

/** One wire endpoint of a provider (a gateway may expose several). */
export interface ProviderEndpoint {
  id: string;
  dialect: LlmDialect;
  baseUrl: string;
  headers?: Record<string, string>;
}

/** Prefix-based routing rule: model ids starting with `prefix` use `endpoint`. */
export interface RouteRule {
  prefix: string;
  endpoint: string;
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
  reasoningKind: ReasoningKind;
  /** Default thinking/reasoning state for this provider. */
  defaultThinking: boolean;
  /**
   * Token-limit field name for OpenAI-compatible providers. Newer OpenAI
   * models reject `max_tokens` and require `max_completion_tokens`.
   */
  maxTokensParam?: "max_tokens" | "max_completion_tokens";
  capabilities: ProviderCapabilities;
  /** Extra request headers (merged on top of the defaults). */
  headers?: Record<string, string>;
  /** Multi-endpoint gateway: the provider may expose several dialects. */
  endpoints?: ProviderEndpoint[];
  /** Endpoint id used when no explicit route matches. */
  defaultEndpoint?: string;
  /** Explicit model id → endpoint id mapping. */
  modelRoutes?: Record<string, string>;
  /** Prefix-based routing for models without an explicit mapping. */
  routeRules?: RouteRule[];
  /** True for user-defined providers (added from the Providers page). */
  custom?: boolean;
}

/** User-provided configuration for a custom provider. */
export interface CustomProviderConfig {
  id: string;
  label: string;
  dialect: LlmDialect;
  baseUrl: string;
  reasoningKind?: ReasoningKind;
  defaultThinking?: boolean;
  maxTokensParam?: "max_tokens" | "max_completion_tokens";
  capabilities?: Partial<ProviderCapabilities>;
  headers?: Record<string, string>;
  endpoints?: ProviderEndpoint[];
  defaultEndpoint?: string;
  modelRoutes?: Record<string, string>;
  routeRules?: RouteRule[];
}

/** A preset resolved with the user's chosen model for a given role. */
export interface ResolvedModel {
  role: LlmRole;
  preset: ProviderPreset;
  model: string;
}
