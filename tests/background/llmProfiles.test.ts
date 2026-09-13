/**
 * Tests for Step B1: provider profiles, roles, migration and capability gating.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mockStorage } from "../setup";

import {
  resolveRole,
  canPresetHandle,
  canRoleHandle,
  getRoles,
  getProviderKey,
  getProviderState,
  clearProviderKey,
  setModelVision,
  setModelSelected,
  applyDetectedModels,
  addCustomModel,
  resolveQaModel,
  saveQaModel,
  saveProfile,
  saveCustomProvider,
  deleteCustomProvider,
} from "../../src/background/modules/llm/profiles";
import { getPreset, findPreset, __resetRegistryForTests, OPENAI_PRESET_ID } from "../../src/background/modules/llm/registry";
import { __setPriceIndexForTests } from "../../src/background/modules/llm/pricing";

function clearStorage() {
  for (const key of Object.keys(mockStorage)) delete mockStorage[key];
}

describe("thinking default", () => {
  beforeEach(clearStorage);

  it("defaults thinking to true when no value is stored", async () => {
    const state = await getProviderState();
    for (const id of ["anthropic", "deepseek", "openai"]) {
      const profile = state.profiles.find((p) => p.id === id);
      expect(profile?.thinking).toBe(true);
    }
  });
});

describe("resolveRole", () => {
  beforeEach(clearStorage);

  it("resolves a configured provider into preset + model + key", async () => {
    mockStorage.providerProfiles = { deepseek: { apiKey: "enc", thinking: true } };

    const resolved = await resolveRole({ provider: "deepseek", model: "deepseek-v4-flash" });

    expect(resolved?.preset.id).toBe("deepseek");
    expect(resolved?.model).toBe("deepseek-v4-flash");
    expect(resolved?.thinking).toBe(true);
  });

  it("returns null when the role has no model (no shipped fallback)", async () => {
    mockStorage.providerProfiles = { anthropic: { apiKey: "enc" } };

    expect(await resolveRole({ provider: "anthropic", model: "" })).toBeNull();
  });

  it("returns null when the role is unset or the key is missing", async () => {
    expect(await resolveRole(null)).toBeNull();
    expect(await resolveRole({ provider: OPENAI_PRESET_ID, model: "gpt-5.1" })).toBeNull();
  });

  it("getRoles returns the default when storage is empty", async () => {
    expect(await getRoles()).toEqual({ primary: null, validator: null });
  });
});

describe("canPresetHandle", () => {
  it("blocks DeepSeek for images and matching", () => {
    const deepseek = getPreset("deepseek");
    expect(canPresetHandle(deepseek, true, false)).toBe(false);
    expect(canPresetHandle(deepseek, false, true)).toBe(false);
    expect(canPresetHandle(deepseek, false, false)).toBe(true);
  });

  it("allows Anthropic for images and matching", () => {
    const anthropic = getPreset("anthropic");
    expect(canPresetHandle(anthropic, true, true)).toBe(true);
  });

  it("allows OpenAI for matching but not images yet", () => {
    const openai = getPreset(OPENAI_PRESET_ID);
    expect(canPresetHandle(openai, false, true)).toBe(true);
    expect(canPresetHandle(openai, true, false)).toBe(false);
  });
});

describe("getProviderKey", () => {
  beforeEach(clearStorage);

  it("returns null when no profile is stored", async () => {
    expect(await getProviderKey("openai")).toBeNull();
  });

  it("returns the stored key value", async () => {
    mockStorage.providerProfiles = { openai: { apiKey: "enc-openai" } };
    expect(await getProviderKey("openai")).toBe("enc-openai");
  });
});

describe("vision capabilities", () => {
  beforeEach(clearStorage);

  it("resolveRole derives vision from the detected list", async () => {
    mockStorage.providerProfiles = {
      anthropic: { apiKey: "enc", visionModels: ["claude-haiku-4-5-20251001"] },
    };
    const anthropic = await resolveRole({
      provider: "anthropic",
      model: "claude-haiku-4-5-20251001",
    });
    expect(anthropic?.vision).toBe(true);

    mockStorage.providerProfiles = { deepseek: { apiKey: "enc", visionModels: [] } };
    const deepseek = await resolveRole({
      provider: "deepseek",
      model: "deepseek-v4-flash",
    });
    expect(deepseek?.vision).toBe(false);
  });

  it("setModelVision toggles a model and feeds resolveRole", async () => {
    mockStorage.providerProfiles = { deepseek: { apiKey: "enc" } };

    await setModelVision("deepseek", "deepseek-v4-flash", true);
    const withVision = await resolveRole({ provider: "deepseek", model: "deepseek-v4-flash" });
    expect(withVision?.vision).toBe(true);

    await setModelVision("deepseek", "deepseek-v4-flash", false);
    const withoutVision = await resolveRole({ provider: "deepseek", model: "deepseek-v4-flash" });
    expect(withoutVision?.vision).toBe(false);
  });

  it("canRoleHandle uses the model vision for images and provider capability for matching", () => {
    const anthropic = getPreset("anthropic");
    const noVision = { preset: anthropic, model: "m", apiKey: "k", thinking: false, vision: false };
    const vision = { ...noVision, vision: true };

    expect(canRoleHandle(noVision, true, false)).toBe(false);
    expect(canRoleHandle(vision, true, false)).toBe(true);

    const deepseek = getPreset("deepseek");
    const ds = { preset: deepseek, model: "m", apiKey: "k", thinking: false, vision: true };
    expect(canRoleHandle(ds, false, true)).toBe(false); // matching unsupported
    expect(canRoleHandle(ds, false, false)).toBe(true);
  });
});

describe("getProviderState", () => {
  beforeEach(clearStorage);

  it("never exposes the API key", async () => {
    mockStorage.providerProfiles = { anthropic: { apiKey: "enc-secret-key", thinking: true } };

    const state = await getProviderState();

    expect(JSON.stringify(state)).not.toContain("enc-secret-key");
    const anthropic = state.profiles.find((p) => p.id === "anthropic");
    expect(anthropic?.hasKey).toBe(true);
    expect(state.presets.length).toBeGreaterThanOrEqual(3);
  });
});

describe("clearProviderKey", () => {
  beforeEach(clearStorage);

  it("removes the key but keeps other metadata", async () => {
    mockStorage.providerProfiles = { openai: { apiKey: "enc", models: ["m"], thinking: true } };

    await clearProviderKey("openai");

    const profiles = mockStorage.providerProfiles as Record<string, { apiKey?: string; models?: string[]; thinking?: boolean }>;
    expect(profiles.openai.apiKey).toBeUndefined();
    expect(profiles.openai.models).toEqual(["m"]);
    expect(profiles.openai.thinking).toBe(true);
  });
});

describe("providerProfiles shape guard", () => {
  beforeEach(clearStorage);

  it("recovers from a legacy Array and persists named profiles", async () => {
    // Older builds stored an Array with a foreign schema; writing named
    // properties onto it was silently dropped by structured serialization.
    mockStorage.providerProfiles = [
      { id: "claude", name: "Claude" },
      { id: "deepseek", name: "DeepSeek" },
    ];

    await saveProfile("anthropic", { apiKey: "enc" });

    const profiles = mockStorage.providerProfiles as Record<string, { apiKey?: string }>;
    expect(Array.isArray(profiles)).toBe(false);
    expect(profiles.anthropic.apiKey).toBe("enc");
  });

  it("treats a non-object value as empty", async () => {
    mockStorage.providerProfiles = "corrupted";
    expect(await getProviderState()).toBeDefined();

    await saveProfile("openai", { apiKey: "enc" });
    const profiles = mockStorage.providerProfiles as Record<string, { apiKey?: string }>;
    expect(profiles.openai.apiKey).toBe("enc");
  });
});

describe("model selection", () => {
  beforeEach(() => {
    clearStorage();
    __setPriceIndexForTests(null);
  });

  it("auto-selects the most recent models plus the cheapest", async () => {
    mockStorage.providerProfiles = { openai: { apiKey: "enc" } };
    const candidates = [
      { id: "new1", created: 5000, info: { inputPer1M: 2, outputPer1M: 2, vision: true, reasoning: true, mode: "chat" } },
      { id: "new2", created: 4000, info: { inputPer1M: 3, outputPer1M: 3, vision: false, reasoning: false, mode: "chat" } },
      { id: "new3", created: 3000, info: { inputPer1M: 4, outputPer1M: 4, vision: false, reasoning: false, mode: "chat" } },
      { id: "old", created: 1000, info: { inputPer1M: 5, outputPer1M: 5, vision: false, reasoning: false, mode: "chat" } },
      { id: "cheap", created: 500, info: { inputPer1M: 0.01, outputPer1M: 0.01, vision: false, reasoning: false, mode: "chat" } },
      { id: "dep", created: 9000, info: { inputPer1M: 1, outputPer1M: 1, mode: "chat", deprecationDate: "2000-01-01" } },
    ];

    await applyDetectedModels("openai", candidates);

    const profiles = mockStorage.providerProfiles as Record<string, { selectedModels?: string[] }>;
    expect(profiles.openai.selectedModels).toEqual(
      expect.arrayContaining(["new1", "new2", "new3", "old", "cheap"]),
    );
    expect(profiles.openai.selectedModels).not.toContain("dep");
  });

  it("preserves a manual selection on re-detection", async () => {
    mockStorage.providerProfiles = {
      openai: { apiKey: "enc", selectionMode: "manual", models: ["a"], selectedModels: ["a"] },
    };

    await applyDetectedModels("openai", [
      { id: "a", created: 1 },
      { id: "b", created: 2 },
    ]);

    const profiles = mockStorage.providerProfiles as Record<string, { selectedModels?: string[] }>;
    expect(profiles.openai.selectedModels).toEqual(["a"]);
  });

  it("keeps a model assigned to a role", async () => {
    mockStorage.providerProfiles = { openai: { apiKey: "enc" } };
    mockStorage.roles = {
      primary: { provider: "openai", model: "assigned-x" },
      validator: null,
    };

    await applyDetectedModels("openai", [
      { id: "assigned-x", created: 1 },
      { id: "other", created: 2 },
    ]);

    const profiles = mockStorage.providerProfiles as Record<string, { selectedModels?: string[] }>;
    expect(profiles.openai.selectedModels).toContain("assigned-x");
  });

  it("setModelSelected switches the provider to manual mode", async () => {
    mockStorage.providerProfiles = {
      openai: { apiKey: "enc", selectedModels: ["a", "b"] },
    };

    await setModelSelected("openai", "b", false);

    const profiles = mockStorage.providerProfiles as Record<string, { selectedModels?: string[]; selectionMode?: string }>;
    expect(profiles.openai.selectedModels).toEqual(["a"]);
    expect(profiles.openai.selectionMode).toBe("manual");
  });

  it("defaults selectedModels to all models for legacy profiles", async () => {
    mockStorage.providerProfiles = {
      openai: { apiKey: "enc", models: ["a"], customModels: ["z"] },
    };

    const state = await getProviderState();
    const openai = state.profiles.find((p) => p.id === "openai");
    expect(openai?.selectedModels).toEqual(["a", "z"]);
    expect(openai?.selectionMode).toBe("auto");
  });
});

describe("addCustomModel", () => {
  beforeEach(clearStorage);

  it("adds a model once and exposes it in getProviderState", async () => {
    mockStorage.providerProfiles = { openai: { apiKey: "enc" } };

    await addCustomModel("openai", "my-custom-model");
    await addCustomModel("openai", "my-custom-model");
    await addCustomModel("openai", "  spaced-model  ");

    const profiles = mockStorage.providerProfiles as Record<string, { customModels?: string[] }>;
    expect(profiles.openai.customModels).toEqual(["my-custom-model", "spaced-model"]);

    const state = await getProviderState();
    const openai = state.profiles.find((p) => p.id === "openai");
    expect(openai?.customModels).toEqual(["my-custom-model", "spaced-model"]);
  });
});

describe("resolveQaModel", () => {
  beforeEach(() => {
    clearStorage();
    __setPriceIndexForTests(null);
  });

  it("prefers an explicit QA selection", async () => {
    await saveQaModel({ provider: "openai", model: "gpt-5.1" });
    expect(await resolveQaModel()).toEqual({ provider: "openai", model: "gpt-5.1" });
  });

  it("auto-selects the cheapest selected model of the primary provider", async () => {
    __setPriceIndexForTests({
      "claude-haiku-4-5-20251001": { inputPer1M: 1, outputPer1M: 5, vision: true, provider: "anthropic" },
      "claude-opus-4-6": { inputPer1M: 5, outputPer1M: 25, vision: true, provider: "anthropic" },
    });
    mockStorage.providerProfiles = {
      anthropic: {
        apiKey: "enc",
        models: ["claude-haiku-4-5-20251001", "claude-opus-4-6"],
        // The cheaper model is detected but NOT selected → must be ignored.
        selectedModels: ["claude-opus-4-6"],
      },
    };
    mockStorage.roles = {
      primary: { provider: "anthropic", model: "claude-opus-4-6" },
      validator: null,
    };

    expect(await resolveQaModel()).toEqual({
      provider: "anthropic",
      model: "claude-opus-4-6",
    });
  });

  it("falls back to detected models when selection is absent (legacy)", async () => {
    __setPriceIndexForTests({
      "claude-haiku-4-5-20251001": { inputPer1M: 1, outputPer1M: 5, vision: true, provider: "anthropic" },
      "claude-opus-4-6": { inputPer1M: 5, outputPer1M: 25, vision: true, provider: "anthropic" },
    });
    mockStorage.providerProfiles = {
      anthropic: {
        apiKey: "enc",
        models: ["claude-haiku-4-5-20251001", "claude-opus-4-6"],
      },
    };
    mockStorage.roles = {
      primary: { provider: "anthropic", model: "claude-opus-4-6" },
      validator: null,
    };

    expect(await resolveQaModel()).toEqual({
      provider: "anthropic",
      model: "claude-haiku-4-5-20251001",
    });
  });

  it("returns null when nothing is detected", async () => {
    mockStorage.providerProfiles = {};
    expect(await resolveQaModel()).toBeNull();
  });
});

describe("custom providers", () => {
  beforeEach(() => {
    clearStorage();
    __resetRegistryForTests();
  });

  afterEach(__resetRegistryForTests);

  const config = {
    id: "custom-x",
    label: "X",
    dialect: "openai-compatible" as const,
    baseUrl: "https://api.x.com/v1",
  };

  it("exposes a saved custom provider in getProviderState", async () => {
    await saveCustomProvider(config);

    const state = await getProviderState();
    expect(state.presets.some((p) => p.id === "custom-x")).toBe(true);
    expect(findPreset("custom-x")?.label).toBe("X");
  });

  it("deletes a custom provider, its profile and any role using it", async () => {
    await saveCustomProvider(config);
    mockStorage.roles = {
      primary: { provider: "custom-x", model: "m" },
      validator: null,
    };
    mockStorage.providerProfiles = { "custom-x": { apiKey: "enc" } };

    await deleteCustomProvider("custom-x");

    expect(findPreset("custom-x")).toBeUndefined();
    const roles = mockStorage.roles as { primary: unknown };
    expect(roles.primary).toBeNull();
    const profiles = mockStorage.providerProfiles as Record<string, unknown>;
    expect(profiles["custom-x"]).toBeUndefined();
  });
});

