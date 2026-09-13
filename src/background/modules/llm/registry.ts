/**
 * Provider registry
 *
 * Built-in presets (Anthropic, DeepSeek, OpenAI), user-defined providers
 * (`customProviders` in storage) and selectable templates for the
 * "Add provider" form. A provider may expose several endpoints (dialects);
 * `resolvePresetForModel` picks the right one for a given model.
 */

import type {
  CustomProviderConfig,
  ProviderEndpoint,
  ProviderPreset,
} from "./contract.js";

export const ANTHROPIC_PRESET_ID = "anthropic";
export const DEEPSEEK_PRESET_ID = "deepseek";
export const OPENAI_PRESET_ID = "openai";

export const LLM_PRESETS: Record<string, ProviderPreset> = {
  [ANTHROPIC_PRESET_ID]: {
    id: ANTHROPIC_PRESET_ID,
    label: "Anthropic",
    dialect: "anthropic",
    baseUrl: "https://api.anthropic.com",
    reasoningKind: "anthropic-thinking",
    defaultThinking: true,
    capabilities: { images: true, matching: true, reasoning: true },
  },
  [DEEPSEEK_PRESET_ID]: {
    id: DEEPSEEK_PRESET_ID,
    label: "DeepSeek",
    dialect: "openai-compatible",
    baseUrl: "https://api.deepseek.com",
    reasoningKind: "deepseek",
    defaultThinking: true,
    capabilities: { images: false, matching: false, reasoning: true },
  },
  [OPENAI_PRESET_ID]: {
    id: OPENAI_PRESET_ID,
    label: "OpenAI",
    dialect: "openai-compatible",
    baseUrl: "https://api.openai.com/v1",
    reasoningKind: "openai-effort",
    defaultThinking: true,
    maxTokensParam: "max_completion_tokens",
    // Image support for the OpenAI-compatible adapter is pending (see image_url
    // content blocks); images currently route to a capable validator instead.
    capabilities: { images: false, matching: true, reasoning: true },
  },
};

// ============================================
// Templates (prefill for "Add provider")
// ============================================

export const PROVIDER_TEMPLATES: ProviderPreset[] = [
  {
    id: "openrouter",
    label: "OpenRouter",
    dialect: "openai-compatible",
    baseUrl: "https://openrouter.ai/api/v1",
    reasoningKind: "openai-effort",
    defaultThinking: false,
    maxTokensParam: "max_tokens",
    capabilities: { images: false, matching: true, reasoning: true },
  },
  {
    id: "groq",
    label: "Groq",
    dialect: "openai-compatible",
    baseUrl: "https://api.groq.com/openai/v1",
    reasoningKind: "openai-effort",
    defaultThinking: false,
    maxTokensParam: "max_tokens",
    capabilities: { images: false, matching: true, reasoning: true },
  },
  {
    id: "mistral",
    label: "Mistral",
    dialect: "openai-compatible",
    baseUrl: "https://api.mistral.ai/v1",
    reasoningKind: "openai-effort",
    defaultThinking: false,
    maxTokensParam: "max_tokens",
    capabilities: { images: false, matching: true, reasoning: true },
  },
  {
    id: "xai",
    label: "xAI",
    dialect: "openai-compatible",
    baseUrl: "https://api.x.ai/v1",
    reasoningKind: "openai-effort",
    defaultThinking: false,
    maxTokensParam: "max_tokens",
    capabilities: { images: false, matching: true, reasoning: true },
  },
  {
    id: "commandcode-goat",
    label: "Command Code GOAT",
    dialect: "openai-compatible",
    baseUrl: "https://api.commandcode.ai/provider/v1",
    reasoningKind: "openai-effort",
    defaultThinking: false,
    maxTokensParam: "max_tokens",
    capabilities: { images: false, matching: true, reasoning: true },
  },
  {
    id: "opencode-go",
    label: "OpenCode Go",
    dialect: "openai-compatible",
    baseUrl: "https://opencode.ai/zen/go/v1",
    reasoningKind: "openai-effort",
    defaultThinking: false,
    maxTokensParam: "max_tokens",
    capabilities: { images: false, matching: true, reasoning: true },
  },
];

export function listTemplates(): ProviderPreset[] {
  return PROVIDER_TEMPLATES;
}

// ============================================
// User-defined providers
// ============================================

const OPENCODE_SESSION_KEY = "opencodeGoSession";

let customPresets: Record<string, ProviderPreset> = {};
let registryPromise: Promise<void> | null = null;

/** Fill a custom provider config with dialect-aware defaults. */
export function normalizeCustomProvider(config: CustomProviderConfig): ProviderPreset {
  const anthropic = config.dialect === "anthropic";
  const endpoints = (config.endpoints ?? []).map((endpoint) => ({
    id: endpoint.id,
    dialect: endpoint.dialect,
    baseUrl: endpoint.baseUrl.replace(/\/+$/, ""),
    headers: endpoint.headers,
  }));
  return {
    id: config.id,
    label: config.label,
    dialect: config.dialect,
    baseUrl: config.baseUrl.replace(/\/+$/, ""),
    reasoningKind:
      config.reasoningKind ?? (anthropic ? "anthropic-thinking" : "openai-effort"),
    defaultThinking: config.defaultThinking ?? anthropic,
    maxTokensParam: config.maxTokensParam ?? "max_tokens",
    capabilities: {
      images: config.capabilities?.images ?? false,
      matching: config.capabilities?.matching ?? true,
      reasoning: config.capabilities?.reasoning ?? true,
    },
    headers: config.headers,
    endpoints: endpoints.length ? endpoints : undefined,
    defaultEndpoint: config.defaultEndpoint,
    modelRoutes: config.modelRoutes,
    routeRules: config.routeRules,
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

function isOpencodeHost(url: string): boolean {
  try {
    return new URL(url).hostname.endsWith("opencode.ai");
  } catch {
    return false;
  }
}

function withSession(
  headers: Record<string, string> | undefined,
  session: string,
): Record<string, string> {
  const next = { ...(headers ?? {}) };
  const has = Object.keys(next).some((h) => h.toLowerCase() === "x-opencode-session");
  if (!has) next["x-opencode-session"] = session;
  return next;
}

/**
 * Load custom providers from storage (once per service-worker lifetime) and
 * inject the stable OpenCode Go session header where needed.
 */
export function ensureRegistry(): Promise<void> {
  if (!registryPromise) {
    registryPromise = (async () => {
      try {
        const result = await chrome.storage.local.get([
          "customProviders",
          OPENCODE_SESSION_KEY,
        ]);
        const map = result.customProviders as
          | Record<string, CustomProviderConfig>
          | undefined;
        setCustomPresets(map && typeof map === "object" ? Object.values(map) : []);

        const needsSession = Object.values(customPresets).some(
          (preset) =>
            isOpencodeHost(preset.baseUrl) ||
            (preset.endpoints ?? []).some((endpoint) => isOpencodeHost(endpoint.baseUrl)),
        );
        if (needsSession) {
          let session =
            typeof result[OPENCODE_SESSION_KEY] === "string"
              ? (result[OPENCODE_SESSION_KEY] as string)
              : "";
          if (!session) {
            session =
              typeof crypto?.randomUUID === "function"
                ? crypto.randomUUID()
                : `${Date.now()}-${Math.random().toString(36).slice(2)}`;
            await chrome.storage.local.set({ [OPENCODE_SESSION_KEY]: session });
          }
          for (const preset of Object.values(customPresets)) {
            if (isOpencodeHost(preset.baseUrl)) {
              preset.headers = withSession(preset.headers, session);
            }
            for (const endpoint of preset.endpoints ?? []) {
              if (isOpencodeHost(endpoint.baseUrl)) {
                endpoint.headers = withSession(endpoint.headers, session);
              }
            }
          }
        }
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

function pickEndpoint(preset: ProviderPreset, model: string): ProviderEndpoint | undefined {
  const endpoints = preset.endpoints;
  if (!endpoints || endpoints.length === 0) return undefined;

  const explicit = preset.modelRoutes?.[model];
  if (explicit) {
    const found = endpoints.find((e) => e.id === explicit);
    if (found) return found;
  }

  const lower = model.toLowerCase();
  for (const rule of preset.routeRules ?? []) {
    if (lower.startsWith(rule.prefix.toLowerCase())) {
      const found = endpoints.find((e) => e.id === rule.endpoint);
      if (found) return found;
    }
  }

  const byDefault = endpoints.find((e) => e.id === preset.defaultEndpoint);
  return byDefault ?? endpoints[0];
}

/**
 * Effective preset for a specific model: for single-endpoint providers this is
 * the preset itself; for gateways it is resolved to the right endpoint.
 */
export function resolvePresetForModel(
  providerId: string,
  model: string,
): ProviderPreset | undefined {
  const preset = findPreset(providerId);
  if (!preset) return undefined;

  const endpoint = pickEndpoint(preset, model);
  if (!endpoint) return preset;

  return {
    ...preset,
    dialect: endpoint.dialect,
    baseUrl: endpoint.baseUrl,
    headers: { ...(preset.headers ?? {}), ...(endpoint.headers ?? {}) },
    endpoints: undefined,
    defaultEndpoint: undefined,
    modelRoutes: undefined,
    routeRules: undefined,
  };
}

/** Endpoint id a model resolves to (for the UI tag/select). */
export function resolveEndpointId(providerId: string, model: string): string | undefined {
  const preset = findPreset(providerId);
  if (!preset?.endpoints?.length) return undefined;
  return pickEndpoint(preset, model)?.id;
}

/** Test seam: clear the cached custom providers. */
export function __resetRegistryForTests(): void {
  resetRegistry();
}
