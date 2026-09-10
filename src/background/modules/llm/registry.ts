/**
 * Provider registry
 *
 * Static presets for the supported providers. Adding a provider is a data
 * change here plus a popup entry — not new transport code.
 */

import type { ProviderPreset } from "./contract.js";

export const ANTHROPIC_PRESET_ID = "anthropic";
export const DEEPSEEK_PRESET_ID = "deepseek";

export const LLM_PRESETS: Record<string, ProviderPreset> = {
  [ANTHROPIC_PRESET_ID]: {
    id: ANTHROPIC_PRESET_ID,
    label: "Anthropic",
    dialect: "anthropic",
    baseUrl: "https://api.anthropic.com",
    keyPrefixes: ["sk-ant-"],
    reasoningKind: "anthropic-thinking",
    capabilities: { images: true, reasoning: true },
    defaultModels: [
      "claude-haiku-4-5-20251001",
      "claude-sonnet-4-6",
      "claude-opus-4-6",
    ],
  },
  [DEEPSEEK_PRESET_ID]: {
    id: DEEPSEEK_PRESET_ID,
    label: "DeepSeek",
    dialect: "openai-compatible",
    baseUrl: "https://api.deepseek.com",
    keyPrefixes: ["sk-"],
    reasoningKind: "deepseek",
    capabilities: { images: false, reasoning: true },
    defaultModels: ["deepseek-v4-flash", "deepseek-v4-pro"],
  },
};

export function getPreset(id: string): ProviderPreset {
  const preset = LLM_PRESETS[id];
  if (!preset) {
    throw new Error(`Unknown LLM preset: ${id}`);
  }
  return preset;
}
