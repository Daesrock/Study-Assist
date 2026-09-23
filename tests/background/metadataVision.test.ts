/**
 * Capability-metadata regressions.
 *
 * One shared vision resolver feeds detection, public provider state and role
 * resolution; refreshed LiteLLM metadata must win over a stale stored
 * `visionModels` list, while explicit user overrides always win. Reasoning is
 * only blocked when metadata explicitly says the model cannot reason.
 */

import { beforeEach, describe, expect, it } from "vitest";
import { mockStorage } from "../setup";
import { encryptApiKey } from "../../src/background/modules/crypto";
import {
  applyDetectedModels,
  getProviderState,
  resolveModelVision,
  resolveRole,
  setModelVision,
} from "../../src/background/modules/llm/profiles";
import { __setPriceIndexForTests } from "../../src/background/modules/llm/pricing";
import { __resetRegistryForTests } from "../../src/background/modules/llm/registry";
import type { ModelPriceInfo } from "../../src/background/modules/constants";

const info = (over: Partial<ModelPriceInfo> = {}): ModelPriceInfo => ({
  inputPer1M: 1,
  outputPer1M: 2,
  vision: null,
  ...over,
});

function clearStorage() {
  for (const key of Object.keys(mockStorage)) delete mockStorage[key];
}

beforeEach(() => {
  clearStorage();
  __resetRegistryForTests();
  __setPriceIndexForTests({});
});

describe("resolveModelVision precedence", () => {
  it("lets an explicit override win over metadata in both directions", () => {
    expect(resolveModelVision({ visionOverrides: { m: true } }, "m", info({ vision: false }))).toBe(true);
    expect(resolveModelVision({ visionOverrides: { m: false } }, "m", info({ vision: true }))).toBe(false);
  });

  it("uses explicit metadata when no override exists", () => {
    expect(resolveModelVision({}, "m", info({ vision: true }))).toBe(true);
    expect(resolveModelVision({}, "m", info({ vision: false }))).toBe(false);
  });

  it("falls back to the legacy vision list only when metadata is unknown", () => {
    expect(resolveModelVision({ visionModels: ["m"] }, "m", info({ vision: null }))).toBe(true);
    expect(resolveModelVision({ visionModels: ["m"] }, "m", null)).toBe(true);
    expect(resolveModelVision({ visionModels: ["m"] }, "m", info({ vision: false }))).toBe(false);
    expect(resolveModelVision({ visionModels: [] }, "m", info({ vision: null }))).toBe(false);
    expect(resolveModelVision(undefined, "m", null)).toBe(false);
  });
});

describe("public provider state vision", () => {
  it("ignores a stale legacy list once metadata says the model has no vision", async () => {
    mockStorage.providerProfiles = {
      anthropic: {
        apiKey: await encryptApiKey("enc"),
        models: ["claude-opus-5-5"],
        selectedModels: ["claude-opus-5-5"],
        visionModels: ["claude-opus-5-5"],
      },
    };
    __setPriceIndexForTests({
      "claude-opus-5-5": info({ vision: true, provider: "anthropic" }),
    });
    const withVision = await getProviderState();
    const profile = withVision.profiles.find((p) => p.id === "anthropic")!;
    expect(profile.visionModels).toContain("claude-opus-5-5");

    // Same stored profile, refreshed metadata now says vision: false.
    __setPriceIndexForTests({
      "claude-opus-5-5": info({ vision: false, provider: "anthropic" }),
    });
    const withoutVision = await getProviderState();
    const updated = withoutVision.profiles.find((p) => p.id === "anthropic")!;
    expect(updated.visionModels).toEqual([]);
    expect(updated.modelInfo["claude-opus-5-5"]?.vision).toBe(false);
  });

  it("flips back when refreshed metadata regains vision", async () => {
    mockStorage.providerProfiles = {
      anthropic: { apiKey: await encryptApiKey("enc"), models: ["m"], selectedModels: ["m"] },
    };
    __setPriceIndexForTests({ m: info({ vision: false, provider: "anthropic" }) });
    expect((await getProviderState()).profiles.find((p) => p.id === "anthropic")!.visionModels).toEqual([]);

    __setPriceIndexForTests({ m: info({ vision: true, provider: "anthropic" }) });
    expect(
      (await getProviderState()).profiles.find((p) => p.id === "anthropic")!.visionModels,
    ).toEqual(["m"]);
  });

  it("honours a manual override on top of refreshed metadata", async () => {
    mockStorage.providerProfiles = { anthropic: { apiKey: await encryptApiKey("enc") } };
    await applyDetectedModels("anthropic", [{ id: "m", info: info({ vision: true, provider: "anthropic" }) }]);
    __setPriceIndexForTests({ m: info({ vision: true, provider: "anthropic" }) });

    await setModelVision("anthropic", "m", false);
    __setPriceIndexForTests({ m: info({ vision: true, provider: "anthropic" }) });

    const state = await getProviderState();
    const profile = state.profiles.find((p) => p.id === "anthropic")!;
    expect(profile.visionModels).toEqual([]);
    expect(profile.modelInfo.m?.vision).toBe(true);
  });

  it("covers selected-only and role-only model ids", async () => {
    mockStorage.providerProfiles = {
      anthropic: {
        apiKey: await encryptApiKey("enc"),
        models: ["detected"],
        selectedModels: ["selected-only"],
      },
    };
    mockStorage.roles = { primary: { provider: "anthropic", model: "role-only" }, validator: null };
    __setPriceIndexForTests({
      "selected-only": info({ vision: true, provider: "anthropic" }),
      "role-only": info({ vision: true, provider: "anthropic" }),
    });

    const state = await getProviderState();
    const profile = state.profiles.find((p) => p.id === "anthropic")!;
    expect(profile.modelInfo["selected-only"]).toBeTruthy();
    expect(profile.modelInfo["role-only"]).toBeTruthy();
    expect(profile.visionModels).toEqual(
      expect.arrayContaining(["selected-only", "role-only"]),
    );
  });

  it("covers custom-provider models with no LiteLLM entry", async () => {
    mockStorage.customProviders = {
      "custom-x": {
        id: "custom-x",
        label: "X",
        dialect: "openai-compatible",
        baseUrl: "https://api.x.test/v1",
      },
    };
    mockStorage.providerProfiles = {
      "custom-x": {
        apiKey: await encryptApiKey("enc"),
        models: ["brand-new"],
        selectedModels: ["brand-new"],
        visionModels: ["brand-new"],
      },
    };
    __resetRegistryForTests();

    const legacy = await getProviderState();
    expect(
      legacy.profiles.find((p) => p.id === "custom-x")!.visionModels,
    ).toEqual(["brand-new"]);

    await setModelVision("custom-x", "brand-new", false);
    const overridden = await getProviderState();
    expect(overridden.profiles.find((p) => p.id === "custom-x")!.visionModels).toEqual([]);
  });
});

describe("resolveRole capability gating", () => {
  async function assignProfile(profile: Record<string, unknown>) {
    mockStorage.providerProfiles = {
      anthropic: { apiKey: await encryptApiKey("enc"), ...profile },
    };
  }

  it("takes vision from refreshed metadata", async () => {
    await assignProfile({ thinking: true });
    __setPriceIndexForTests({ m: info({ vision: true, provider: "anthropic" }) });
    expect((await resolveRole({ provider: "anthropic", model: "m" }))?.vision).toBe(true);

    __setPriceIndexForTests({ m: info({ vision: false, provider: "anthropic" }) });
    expect((await resolveRole({ provider: "anthropic", model: "m" }))?.vision).toBe(false);
  });

  it("keeps an explicit override over refreshed metadata", async () => {
    await assignProfile({ visionOverrides: { m: true } });
    __setPriceIndexForTests({ m: info({ vision: false, provider: "anthropic" }) });
    expect((await resolveRole({ provider: "anthropic", model: "m" }))?.vision).toBe(true);
  });

  it("only blocks reasoning when metadata explicitly says so", async () => {
    await assignProfile({ thinking: true });
    __setPriceIndexForTests({ known: info({ reasoning: null, provider: "anthropic" }) });
    const unknownReasoning = await resolveRole({ provider: "anthropic", model: "known" });
    expect(unknownReasoning?.reasoning).toBe(true);
    expect(unknownReasoning?.thinking).toBe(true);

    __setPriceIndexForTests({ known: info({ reasoning: false, provider: "anthropic" }) });
    expect((await resolveRole({ provider: "anthropic", model: "known" }))?.reasoning).toBe(false);

    __setPriceIndexForTests({});
    expect((await resolveRole({ provider: "anthropic", model: "unlisted" }))?.reasoning).toBe(true);
  });

  it("uses refreshed adaptive metadata for thinking config", async () => {
    await assignProfile({ thinking: true });
    __setPriceIndexForTests({ m: info({ adaptive: true, provider: "anthropic" }) });
    expect((await resolveRole({ provider: "anthropic", model: "m" }))?.adaptiveThinking).toBe(true);

    __setPriceIndexForTests({ m: info({ adaptive: false, provider: "anthropic" }) });
    expect((await resolveRole({ provider: "anthropic", model: "m" }))?.adaptiveThinking).toBe(false);
  });
});
