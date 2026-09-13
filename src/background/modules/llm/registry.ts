/**
 * Provider registry
 *
 * Static presets for the built-in providers plus a runtime cache of
 * user-defined providers (`customProviders` in storage). Adding a provider is
 * a data change — no new transport code.
 */

import type { CustomProviderConfig, ProviderPreset } from "./contract.js";

export const ANTHROPIC_PRESET_ID = "anthropic";
export const DEEPSEEK_PRESET_ID = "deepseek";
export const OPENAI_PRESET_ID = "openai";
export const OPENROUTER_PRESET_ID = "openrouter";
export const GROQ_PRESET_ID = "groq";
export const MISTRAL_PRESET_ID = "mistral";
export const XAI_PRESET_ID = "xai";

export const LLM_PRESETS: Record<string, ProviderPreset> = {
  [ANTHROPIC_PRESET_ID]: {
    id: ANTHROPIC_PRESET_ID,
    label: "Anthropic",
    dialect: "anthropic",
    baseUrl: "https://api.anthropic.com",
    keyPrefixes: ["sk-ant-"],
    reasoningKind: "anthropic-thinking",
    defaultThinking: true,
    capabilities: { images: true, matching: true, reasoning: true },
  },
  [DEEPSEEK_PRESET_ID]: {
    id: DEEPSEEK_PRESET_ID,
    label: "DeepSeek",
    dialect: "openai-compatible",
    baseUrl: "https://api.deepseek.com",
    keyPrefixes: ["sk-"],
    reasoningKind: "deepseek",
    defaultThinking: true,
    capabilities: { images: false, matching: false, reasoning: true },
  },
  [OPENAI_PRESET_ID]: {
    id: OPENAI_PRESET_ID,
    label: "OpenAI",
    dialect: "openai-compatible",
    baseUrl: "https://api.openai.com/v1",
    keyPrefixes: ["sk-"],
    reasoningKind: "openai-effort",
    defaultThinking: true,
    maxTokensParam: "max_completion_tokens",
    // Image support for the OpenAI-compatible adapter is pending (see image_url
    // content blocks); images currently route to a capable validator instead.
    capabilities: { images: false, matching: true, reasoning: true },
  },
  [OPENROUTER_PRESET_ID]: {
    id: OPENROUTER_PRESET_ID,
    label: "OpenRouter",
    dialect: "openai-compatible",
    baseUrl: "https://openrouter.ai/api/v1",
    keyPrefixes: ["sk-or-"],
    reasoningKind: "openai-effort",
    defaultThinking: false,
    maxTokensParam: "max_tokens",
    capabilities: { images: false, matching: true, reasoning: true },
  },
  [GROQ_PRESET_ID]: {
    id: GROQ_PRESET_ID,
    label: "Groq",
    dialect: "openai-compatible",
    baseUrl: "https://api.groq.com/openai/v1",
    keyPrefixes: ["gsk_"],
    reasoningKind: "openai-effort",
    defaultThinking: false,
    maxTokensParam: "max_tokens",
    capabilities: { images: false, matching: true, reasoning: true },
  },
  [MISTRAL_PRESET_ID]: {
    id: MISTRAL_PRESET_ID,
    label: "Mistral",
    dialect: "openai-compatible",
    baseUrl: "https://api.mistral.ai/v1",
    keyPrefixes: [],
    reasoningKind: "openai-effort",
    defaultThinking: false,
    maxTokensParam: "max_tokens",
    capabilities: { images: false, matching: true, reasoning: true },
  },
  [XAI_PRESET_ID]: {
    id: XAI_PRESET_ID,
    label: "xAI",
    dialect: "openai-compatible",
    baseUrl: "https://api.x.ai/v1",
    keyPrefixes: ["xai-"],
    reasoningKind: "openai-effort",
    defaultThinking: false,
    maxTokensParam: "max_tokens",
    capabilities: { images: false, matching: true, reasoning: true },
  },
};

// ============================================
// User-defined providers
// ============================================

let customPresets: Record<string, ProviderPreset> = {};
let registryPromise: Promise<void> | null = null;

/** Fill a custom provider config with dialect-aware defaults. */
export function normalizeCustomProvider(config: CustomProviderConfig): ProviderPreset {
  const anthropic = config.dialect === "anthropic";
  return {
    id: config.id,
    label: config.label,
    dialect: config.dialect,
    baseUrl: config.baseUrl.replace(/\/+$/, ""),
    keyPrefixes: config.keyPrefixes ?? [],
    reasoningKind:
      config.reasoningKind ?? (anthropic ? "anthropic-thinking" : "openai-effort"),
    defaultThinking: config.defaultThinking ?? anthropic,
    maxTokensParam: config.maxTokensParam ?? "max_tokens",
    capabilities: {
      images: config.capabilities?.images ?? false,
      matching: config.capabilities?.matching ?? true,
      reasoning: config.capabilities?.reasoning ?? true,
    },
    custom: true,
  };
}

export function setCustomPresets(configs: CustomProviderConfig[]): void {
  const next: Record<string, ProviderPreset> = {};
  for (const config of configs) {
    if (!config?.id || !config.baseUrl || !config.dialect) continue;
    next[config.id] = normalizeCustomProvider(config);
  }
  customPresets = next;
}

/** Load custom providers from storage (once per service-worker lifetime). */
export function ensureRegistry(): Promise<void> {
  if (!registryPromise) {
    registryPromise = (async () => {
      try {
        const result = await chrome.storage.local.get(["customProviders"]);
        const map = result.customProviders as
          | Record<string, CustomProviderConfig>
          | undefined;
        setCustomPresets(map && typeof map === "object" ? Object.values(map) : []);
      } catch {
        setCustomPresets([]);
      }
    })().catch(() => {
      registryPromise = null;
    });
  }
  return registryPromise;
}

/** Drop the cache so the next `ensureRegistry()` re-reads storage. */
export function resetRegistry(): void {
  registryPromise = null;
  customPresets = {};
}

export function getPreset(id: string): ProviderPreset {
  const preset = LLM_PRESETS[id] ?? customPresets[id];
  if (!preset) {
    throw new Error(`Unknown LLM preset: ${id}`);
  }
  return preset;
}

export function findPreset(id: string): ProviderPreset | undefined {
  return LLM_PRESETS[id] ?? customPresets[id];
}

/** Built-in presets followed by user-defined ones. */
export function listPresets(): ProviderPreset[] {
  return [...Object.values(LLM_PRESETS), ...Object.values(customPresets)];
}

/** Test seam: clear the cached custom providers. */
export function __resetRegistryForTests(): void {
  resetRegistry();
}
