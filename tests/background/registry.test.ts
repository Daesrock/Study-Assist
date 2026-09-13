/**
 * Tests for the dynamic provider registry (built-ins + custom providers).
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mockStorage } from "../setup";

import {
  getPreset,
  findPreset,
  listPresets,
  normalizeCustomProvider,
  ensureRegistry,
  __resetRegistryForTests,
} from "../../src/background/modules/llm/registry";

function clearStorage() {
  for (const key of Object.keys(mockStorage)) delete mockStorage[key];
}

describe("built-in presets", () => {
  it("includes the extra OpenAI-compatible providers", () => {
    for (const id of ["anthropic", "deepseek", "openai", "openrouter", "groq", "mistral", "xai"]) {
      expect(findPreset(id)).toBeTruthy();
    }
  });

  it("throws for unknown providers", () => {
    expect(() => getPreset("does-not-exist")).toThrow();
  });
});

describe("normalizeCustomProvider", () => {
  it("defaults OpenAI-compatible providers", () => {
    const preset = normalizeCustomProvider({
      id: "custom-x",
      label: "X",
      dialect: "openai-compatible",
      baseUrl: "https://api.x.com/v1/",
    });
    expect(preset.baseUrl).toBe("https://api.x.com/v1");
    expect(preset.custom).toBe(true);
    expect(preset.reasoningKind).toBe("openai-effort");
    expect(preset.maxTokensParam).toBe("max_tokens");
    expect(preset.defaultThinking).toBe(false);
    expect(preset.capabilities.images).toBe(false);
    expect(preset.capabilities.matching).toBe(true);
  });

  it("defaults Anthropic-compatible providers", () => {
    const preset = normalizeCustomProvider({
      id: "custom-a",
      label: "A",
      dialect: "anthropic",
      baseUrl: "https://api.a.com",
    });
    expect(preset.reasoningKind).toBe("anthropic-thinking");
    expect(preset.defaultThinking).toBe(true);
  });
});

describe("custom provider registry", () => {
  beforeEach(() => {
    clearStorage();
    __resetRegistryForTests();
  });

  afterEach(() => {
    __resetRegistryForTests();
  });

  it("resolves custom providers after ensureRegistry", async () => {
    mockStorage.customProviders = {
      "custom-x": {
        id: "custom-x",
        label: "X",
        dialect: "openai-compatible",
        baseUrl: "https://api.x.com/v1",
      },
    };

    await ensureRegistry();

    expect(getPreset("custom-x").label).toBe("X");
    expect(listPresets().some((p) => p.id === "custom-x")).toBe(true);
  });
});
