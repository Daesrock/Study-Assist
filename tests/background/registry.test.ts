/**
 * Tests for the dynamic provider registry (built-ins, templates, custom
 * providers and multi-endpoint routing).
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mockStorage } from "../setup";

import {
  getPreset,
  findPreset,
  listPresets,
  listTemplates,
  normalizeCustomProvider,
  resolvePresetForModel,
  resolveEndpointId,
  ensureRegistry,
  __resetRegistryForTests,
} from "../../src/background/modules/llm/registry";

function clearStorage() {
  for (const key of Object.keys(mockStorage)) delete mockStorage[key];
}

describe("built-in presets", () => {
  it("contains exactly the three built-ins", () => {
    expect(listPresets().map((p) => p.id).sort()).toEqual([
      "anthropic",
      "deepseek",
      "openai",
    ]);
  });

  it("exposes templates for the Add-provider form", () => {
    const ids = listTemplates().map((t) => t.id);
    for (const id of ["openrouter", "groq", "mistral", "xai", "commandcode-goat", "opencode-go"]) {
      expect(ids).toContain(id);
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
    expect(preset.capabilities.images).toBe(false);
  });

  it("keeps headers and endpoints", () => {
    const preset = normalizeCustomProvider({
      id: "custom-gw",
      label: "Gateway",
      dialect: "openai-compatible",
      baseUrl: "https://gw.test/v1",
      headers: { "x-test": "1" },
      endpoints: [
        { id: "chat", dialect: "openai-compatible", baseUrl: "https://gw.test/v1" },
        { id: "messages", dialect: "anthropic", baseUrl: "https://gw.test" },
      ],
      defaultEndpoint: "chat",
      routeRules: [{ prefix: "mm-", endpoint: "messages" }],
    });
    expect(preset.headers).toEqual({ "x-test": "1" });
    expect(preset.endpoints).toHaveLength(2);
    expect(preset.routeRules).toEqual([{ prefix: "mm-", endpoint: "messages" }]);
  });
});

describe("resolvePresetForModel", () => {
  beforeEach(() => {
    clearStorage();
    __resetRegistryForTests();
  });

  afterEach(__resetRegistryForTests);

  it("returns the preset itself for single-endpoint providers", () => {
    expect(resolvePresetForModel("openai", "gpt-5.1")?.dialect).toBe("openai-compatible");
    expect(resolveEndpointId("openai", "gpt-5.1")).toBeUndefined();
  });

  it("routes models to endpoints by prefix (custom multi-endpoint)", async () => {
    mockStorage.customProviders = {
      "custom-go": {
        id: "custom-go",
        label: "Gateway",
        dialect: "openai-compatible",
        baseUrl: "https://gw.test/v1",
        endpoints: [
          { id: "chat", dialect: "openai-compatible", baseUrl: "https://gw.test/v1" },
          { id: "messages", dialect: "anthropic", baseUrl: "https://gw.test" },
          { id: "responses", dialect: "openai-responses", baseUrl: "https://gw.test/v1" },
        ],
        defaultEndpoint: "chat",
        routeRules: [
          { prefix: "grok", endpoint: "responses" },
          { prefix: "minimax", endpoint: "messages" },
        ],
      },
    };
    await ensureRegistry();

    const chat = resolvePresetForModel("custom-go", "deepseek-v4-flash");
    expect(chat?.dialect).toBe("openai-compatible");

    const messages = resolvePresetForModel("custom-go", "minimax-m3");
    expect(messages?.dialect).toBe("anthropic");

    const responses = resolvePresetForModel("custom-go", "grok-4.6");
    expect(responses?.dialect).toBe("openai-responses");

    expect(resolveEndpointId("custom-go", "totally-model")).toBe("chat");
  });
});

describe("custom provider registry", () => {
  beforeEach(() => {
    clearStorage();
    __resetRegistryForTests();
  });

  afterEach(__resetRegistryForTests);

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
    expect(findPreset("custom-x")).toBeTruthy();
  });

  it("injects a stable x-opencode-session for opencode.ai hosts", async () => {
    mockStorage.customProviders = {
      "custom-oc": {
        id: "custom-oc",
        label: "OpenCode",
        dialect: "openai-compatible",
        baseUrl: "https://opencode.ai/zen/go/v1",
      },
    };

    await ensureRegistry();

    const preset = findPreset("custom-oc")!;
    expect(preset.headers?.["x-opencode-session"]).toBeTruthy();
    expect(typeof mockStorage.opencodeGoSession).toBe("string");
  });
});
