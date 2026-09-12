/**
 * Provider registry
 *
 * Static presets for the supported providers. Adding a provider is a data
 * change here plus a popup entry — not new transport code.
 */

import type { ProviderPreset } from "./contract.js";

export const ANTHROPIC_PRESET_ID = "anthropic";
export const DEEPSEEK_PRESET_ID = "deepseek";
export const OPENAI_PRESET_ID = "openai";

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
};

export function getPreset(id: string): ProviderPreset {
  const preset = LLM_PRESETS[id];
  if (!preset) {
    throw new Error(`Unknown LLM preset: ${id}`);
  }
  return preset;
}
