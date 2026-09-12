/**
 * Tests for Step B1: provider profiles, roles, migration and capability gating.
 */

import { describe, it, expect, beforeEach } from "vitest";
import { mockStorage } from "../setup";

import {
  migrateProviderConfig,
  resolveRole,
  canPresetHandle,
  canRoleHandle,
  getRoles,
  getProviderKey,
  ensureProviderConfig,
  getProviderState,
  clearProviderKey,
  setModelVision,
  CURRENT_SCHEMA_VERSION,
} from "../../src/background/modules/llm/profiles";
import { getPreset, OPENAI_PRESET_ID } from "../../src/background/modules/llm/registry";

function clearStorage() {
  for (const key of Object.keys(mockStorage)) delete mockStorage[key];
}

describe("migrateProviderConfig", () => {
  beforeEach(clearStorage);

  it("seeds profiles and roles from legacy Claude + DeepSeek config", async () => {
    Object.assign(mockStorage, {
      claudeApiKey: "enc-claude",
      claudeModel: "claude-sonnet-4-6",
      claudeThinking: true,
      deepseekApiKey: "enc-deepseek",
      deepseekModel: "deepseek-v4-pro",
      deepseekThinking: true,
      useDeepSeek: true,
      deepseekOnly: false,
    });

    await migrateProviderConfig();

    const profiles = mockStorage.providerProfiles as Record<string, { apiKey?: string; thinking?: boolean }>;
    expect(profiles.anthropic.apiKey).toBe("enc-claude");
    expect(profiles.anthropic.thinking).toBe(true);
    expect(profiles.deepseek.apiKey).toBe("enc-deepseek");
    expect(profiles.deepseek.thinking).toBe(true);

    const roles = mockStorage.roles as { primary: unknown; validator: unknown };
    expect(roles.primary).toEqual({ provider: "deepseek", model: "deepseek-v4-pro" });
    expect(roles.validator).toEqual({ provider: "anthropic", model: "claude-sonnet-4-6" });
    expect(mockStorage.schemaVersion).toBe(CURRENT_SCHEMA_VERSION);
  });

  it("maps deepseekOnly to a null validator", async () => {
    Object.assign(mockStorage, {
      claudeApiKey: "enc-claude",
      deepseekApiKey: "enc-deepseek",
      useDeepSeek: true,
      deepseekOnly: true,
    });

    await migrateProviderConfig();

    const roles = mockStorage.roles as { primary: unknown; validator: unknown };
    expect(roles.primary).toEqual({ provider: "deepseek", model: "deepseek-v4-flash" });
    expect(roles.validator).toBeNull();
  });

  it("defaults the primary to Anthropic when DeepSeek is off", async () => {
    Object.assign(mockStorage, {
      claudeApiKey: "enc-claude",
      claudeModel: "claude-opus-4-6",
      useDeepSeek: false,
    });

    await migrateProviderConfig();

    const roles = mockStorage.roles as { primary: { provider: string; model: string } };
    expect(roles.primary).toEqual({ provider: "anthropic", model: "claude-opus-4-6" });
  });

  it("is idempotent once the schema version is current", async () => {
    Object.assign(mockStorage, {
      schemaVersion: CURRENT_SCHEMA_VERSION,
      roles: { primary: { provider: "openai", model: "gpt-5.1" }, validator: null },
    });

    await migrateProviderConfig();

    const roles = mockStorage.roles as { primary: { provider: string } };
    expect(roles.primary.provider).toBe("openai");
    expect(mockStorage.providerProfiles).toBeUndefined();
  });

  it("self-heals: re-seeds roles when the schema is current but roles are empty", async () => {
    Object.assign(mockStorage, {
      schemaVersion: CURRENT_SCHEMA_VERSION,
      claudeApiKey: "enc-claude",
      claudeModel: "claude-opus-4-6",
    });

    await migrateProviderConfig();

    const roles = mockStorage.roles as { primary: unknown; validator: unknown };
    expect(roles.primary).toEqual({ provider: "anthropic", model: "claude-opus-4-6" });
    expect(roles.validator).toEqual({ provider: "anthropic", model: "claude-opus-4-6" });
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

  it("falls back to the preset default model", async () => {
    mockStorage.providerProfiles = { anthropic: { apiKey: "enc" } };

    const resolved = await resolveRole({ provider: "anthropic", model: "" });
    expect(resolved?.model).toBe(getPreset("anthropic").defaultModels[0]);
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

  it("falls back to the legacy key and persists it into the profile", async () => {
    mockStorage.claudeApiKey = "enc-legacy-claude";

    const key = await getProviderKey("anthropic");

    expect(key).toBe("enc-legacy-claude");
    const profiles = mockStorage.providerProfiles as Record<string, { apiKey?: string }>;
    expect(profiles.anthropic.apiKey).toBe("enc-legacy-claude");
  });
});

describe("ensureProviderConfig", () => {
  beforeEach(clearStorage);

  it("seeds roles lazily when they are empty", async () => {
    mockStorage.claudeApiKey = "enc-claude";

    await ensureProviderConfig();

    const roles = mockStorage.roles as { primary: { provider: string } | null };
    expect(roles.primary?.provider).toBe("anthropic");
  });
});

describe("vision capabilities", () => {
  beforeEach(clearStorage);

  it("resolveRole derives vision from the curated list", async () => {
    mockStorage.providerProfiles = { anthropic: { apiKey: "enc" } };
    const anthropic = await resolveRole({
      provider: "anthropic",
      model: "claude-haiku-4-5-20251001",
    });
    expect(anthropic?.vision).toBe(true);

    mockStorage.providerProfiles = { deepseek: { apiKey: "enc" } };
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
