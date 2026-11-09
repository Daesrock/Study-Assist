import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mockStorage } from "../setup";
import { buildCapabilityIndex, lookupNvidiaCapabilities } from "../../src/background/modules/llm/capabilities";
import { __setPriceIndexForTests, lookupModelInfo, refreshPrices, resolveModelCapabilities } from "../../src/background/modules/llm/pricing";
import { __resetRegistryForTests, ensureRegistry } from "../../src/background/modules/llm/registry";
import { setLlmFetch } from "../../src/background/modules/llm/transport";
import { estimateCost } from "../../src/background/modules/usageTracker";
import { resolveOutputBudget } from "../../src/background/modules/llm/outputBudget";
import { getProviderState, resolveRole, setModelVision } from "../../src/background/modules/llm/profiles";
import { encryptApiKey } from "../../src/background/modules/crypto";

const MODEL = "deepseek-ai/deepseek-v4.1-flash";
const PRICE = { provider: "deepseek", inputPer1M: 1, outputPer1M: 2, vision: true, reasoning: true, maxOutput: 60000 };
const raw = {
  "deepseek/known": { litellm_provider: "deepseek", input_cost_per_token: 0.000001, output_cost_per_token: 0.000002 },
  "together_ai/deepseek-ai/DeepSeek-V4.1-Flash": { litellm_provider: "together_ai", supports_vision: true, supports_reasoning: true, input_cost_per_token: 0.1, max_output_tokens: 60000 },
};

beforeEach(async () => {
  for (const key of Object.keys(mockStorage)) delete mockStorage[key];
  __resetRegistryForTests();
  __setPriceIndexForTests({});
  mockStorage.customProviders = { nim: { id: "nim", label: "Existing NIM", baseUrl: "https://integrate.api.nvidia.com/v1", dialect: "openai-compatible" } };
  await ensureRegistry();
});
afterEach(() => setLlmFetch(undefined));

describe("NVIDIA metadata isolation", () => {
  it("retains portable capabilities without requiring tariffs or copying deployment limits", () => {
    const index = buildCapabilityIndex(raw);
    expect(index["together_ai/deepseek-ai/DeepSeek-V4.1-Flash"]).toEqual({ vision: true, reasoning: true });
    expect(lookupNvidiaCapabilities(index, MODEL)).toEqual({ vision: true, reasoning: true });
    expect(lookupNvidiaCapabilities(index, "deepseek-ai/deepseek-v4.1-pro")).toBeNull();
    expect(lookupNvidiaCapabilities(index, "different-publisher/deepseek-v4.1-flash")).toBeNull();
  });

  it("leaves conflicting capabilities unknown and preserves variant suffixes", () => {
    const index = buildCapabilityIndex({
      ...raw,
      [`another/${MODEL}`]: { supports_vision: false, supports_reasoning: true },
      "another/deepseek-ai/deepseek-v4.1-flash-fast": { supports_vision: true },
    });
    expect(lookupNvidiaCapabilities(index, MODEL)).toEqual({ vision: null, reasoning: true });
    expect(lookupNvidiaCapabilities(index, "deepseek-ai/deepseek-v4.1-flash-fast-fp4")).toBeNull();
  });

  it("recognizes the native Z.ai publisher alias using the already saved metadata", async () => {
    const flash = "z-ai/glm-5.3-flash";
    const normal = "z-ai/glm-5.3";
    mockStorage.modelCapabilities = buildCapabilityIndex({
      "zai/glm-5.3-flash": { supports_vision: true, supports_reasoning: true },
      "inferenceapis/glm-5.3-flash": { supports_vision: false, supports_reasoning: true },
      "aihubmix/glm-5.3-flash": { supports_vision: true, supports_reasoning: true },
      "zai/glm-5.3": { supports_reasoning: true },
      "inferenceapis/glm-5.3": { supports_vision: false, supports_reasoning: true },
    });
    // Older NGC snapshots have the free label but no image-input evidence yet.
    mockStorage.nvidiaFreeEndpointCatalog = {
      entries: [{ publisher: "z-ai", name: "glm-5-3-flash" }, { publisher: "z-ai", name: "glm-5-3" }],
      fetchedAt: 123, refreshFailed: false,
    };
    mockStorage.providerProfiles = { nim: {
      apiKey: await encryptApiKey("fixture-key"), models: [flash, normal], selectedModels: [flash, normal],
      visionModels: [], visionOverrides: { [normal]: false },
    } };
    expect((await resolveModelCapabilities("nim", flash))?.vision).toBe(true);
    const profile = (await getProviderState()).profiles.find(p => p.id === "nim")!;
    expect(profile.visionModels).toEqual([flash]);
    expect(await resolveRole({ provider: "nim", model: flash })).toMatchObject({ model: flash, vision: true });
    expect(await resolveRole({ provider: "nim", model: normal })).toMatchObject({ model: normal, vision: false });
    expect(profile.modelInfo[flash]).toBeNull();
  });

  it("uses NVIDIA image-input evidence for GLM Flash while keeping normal GLM text-only and manual overrides", async () => {
    const flash = "z-ai/glm-5.3-flash";
    const normal = "z-ai/glm-5.3";
    const index = buildCapabilityIndex({
      "inferenceapis/glm-5.3-flash": { supports_vision: false, supports_reasoning: true },
      "aihubmix/glm-5.3-flash": { supports_vision: true, supports_reasoning: true },
      "inferenceapis/glm-5.3": { supports_vision: false, supports_reasoning: true },
    });
    expect(lookupNvidiaCapabilities(index, flash)?.vision).toBeNull();
    mockStorage.modelCapabilities = index;
    mockStorage.nvidiaFreeEndpointCatalog = {
      entries: [{ publisher: "z-ai", name: "glm-5-3-flash", vision: true }, { publisher: "z-ai", name: "glm-5-3" }],
      fetchedAt: 123,
      refreshFailed: false,
    };
    mockStorage.providerProfiles = { nim: { apiKey: await encryptApiKey("fixture-key"), models: [flash, normal], selectedModels: [flash, normal] } };
    expect((await resolveModelCapabilities("nim", flash))?.vision).toBe(true);
    expect((await resolveModelCapabilities("nim", normal))?.vision).toBe(false);
    const profile = (await getProviderState()).profiles.find(p => p.id === "nim")!;
    expect(profile.visionModels).toEqual([flash]);
    expect(profile.modelInfo[flash]).toBeNull();
    expect(await resolveRole({ provider: "nim", model: flash })).toMatchObject({ model: flash, vision: true });
    expect(await resolveRole({ provider: "nim", model: normal })).toMatchObject({ model: normal, vision: false });
    await setModelVision("nim", flash, false);
    expect((await resolveRole({ provider: "nim", model: flash }))?.vision).toBe(false);
  });

  it("never borrows a native or another host's price for NIM", async () => {
    __setPriceIndexForTests({ [MODEL]: PRICE, "deepseek-v4.1-flash": PRICE, [`deepseek/${MODEL}`]: PRICE });
    expect(lookupModelInfo({ [MODEL]: PRICE }, "nim", MODEL)).toBeNull();
    expect(await estimateCost("nim", MODEL, { inputTokens: 10, outputTokens: 2 })).toBeNull();
    expect(await resolveOutputBudget("nim", MODEL, false)).toBe(16384);
  });

  it("accepts actual NIM-specific prices and deployment limits", async () => {
    __setPriceIndexForTests({ [`nvidia_nim/${MODEL}`]: { ...PRICE, provider: "nvidia_nim", inputPer1M: 0, outputPer1M: 0 } });
    expect(await estimateCost("nim", MODEL, { inputTokens: 10, outputTokens: 2 })).toBe(0);
    expect(await resolveOutputBudget("nim", MODEL, false)).toBe(60000);
  });

  it("refreshes capabilities atomically and exposes them without foreign costs", async () => {
    setLlmFetch(async () => Response.json(raw));
    expect((await refreshPrices()).success).toBe(true);
    expect(mockStorage.modelCapabilities).toEqual(buildCapabilityIndex(raw));
    expect(await resolveModelCapabilities("nim", MODEL)).toEqual({ vision: true, reasoning: true });
    mockStorage.providerProfiles = { nim: { apiKey: await encryptApiKey("fixture-key"), models: [MODEL], selectedModels: [MODEL], visionOverrides: { [MODEL]: false } } };
    const profile = (await getProviderState()).profiles.find(p => p.id === "nim")!;
    expect(profile.modelInfo[MODEL]).toBeNull();
    expect(profile.modelCapabilities[MODEL]).toEqual({ vision: true, reasoning: true });
    expect(profile.visionModels).not.toContain(MODEL);
    expect(profile.nvidia?.freeEndpoints[MODEL]).toBeNull();
    const role = await resolveRole({ provider: "nim", model: MODEL });
    expect(role?.model).toBe(MODEL);
    expect(role?.vision).toBe(false);
    expect(role?.reasoning).toBe(true);
    expect(await resolveOutputBudget("nim", MODEL, true)).toBe(32768);
  });
});
