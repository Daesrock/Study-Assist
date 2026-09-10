/**
 * Tests for Step B1: provider profiles, roles, migration and capability gating.
 */

import { describe, it, expect, beforeEach } from "vitest";
import { mockStorage } from "../setup";

import {
  migrateProviderConfig,
  resolveRole,
  canPresetHandle,
  getRoles,
  getProviderKey,
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
});
