/**
 * Metadata refresh regressions.
 *
 * Covers the LiteLLM refresh engine (coalescing, timeout, failure handling)
 * and the background handlers that must refresh before they price, gate or
 * choose a model: provider setup, catalog detection and the connection test.
 *
 * All LiteLLM/provider responses are mocked fixtures; nothing here is a
 * production price table.
 */

import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { mockStorage, chromeRuntime, chromeStorageLocal } from "../setup";
import { setLlmFetch } from "../../src/background/modules/llm/transport";
import { encryptApiKey } from "../../src/background/modules/crypto";
import {
  PRICE_REFRESH_TIMEOUT_MS,
  __setPriceIndexForTests,
  getPriceFreshness,
  getPriceIndex,
  refreshPrices,
} from "../../src/background/modules/llm/pricing";

const LITELLM_URL = "model_prices_and_context_window.json";
const ANTHROPIC_MODELS_URL = "api.anthropic.com/v1/models";
const ANTHROPIC_MESSAGES_URL = "api.anthropic.com/v1/messages";

/**
 * Mocked LiteLLM entries. Values are arbitrary fixtures, deliberately not
 * copied from the live catalog.
 */
const LITELLM_FIXTURE = {
  "claude-opus-5-5": {
    litellm_provider: "anthropic",
    input_cost_per_token: 0.000005,
    output_cost_per_token: 0.000025,
    cache_read_input_token_cost: 0.0000005,
    supports_vision: true,
    supports_reasoning: true,
    supports_adaptive_thinking: true,
    max_input_tokens: 200000,
    max_output_tokens: 64000,
    mode: "chat",
  },
  // Deliberately expensive so the "cheapest selected model" choice flips once
  // fresh metadata replaces a stale index.
  "legacy-cheap": {
    litellm_provider: "anthropic",
    input_cost_per_token: 0.0001,
    output_cost_per_token: 0.0001,
    supports_vision: false,
    supports_reasoning: true,
    mode: "chat",
  },
};

const ANTHROPIC_CATALOG = {
  data: [
    { id: "claude-opus-5-5", display_name: "Claude Opus 5.5", created_at: "2026-09-01T00:00:00Z" },
    { id: "legacy-cheap", display_name: "Legacy Cheap", created_at: "2024-01-01T00:00:00Z" },
  ],
};

const ANTHROPIC_OK = {
  content: [{ type: "text", text: "OK" }],
  stop_reason: "end_turn",
  usage: { input_tokens: 10, output_tokens: 2 },
};

interface Route {
  match: string;
  json?: unknown;
  status?: number;
  rawText?: string;
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

/** Install an injected fetch that routes by URL substring and records calls. */
function installFetch(routes: Route[]) {
  const calls: Array<{ url: string; init: RequestInit; body: any }> = [];
  const fetcher = vi.fn(async (input: any, init: any = {}) => {
    const url = String(input);
    calls.push({
      url,
      init,
      body: typeof init.body === "string" ? JSON.parse(init.body) : undefined,
    });
    const route = routes.find((r) => url.includes(r.match));
    if (!route) return jsonResponse({ error: { message: `unrouted ${url}` } }, 404);
    if (route.rawText !== undefined) {
      return new Response(route.rawText, { status: route.status ?? 200 });
    }
    const status = route.status ?? 200;
    return jsonResponse(route.json ?? {}, status);
  });
  setLlmFetch(fetcher as unknown as typeof fetch);
  return { fetcher, calls };
}

const litellmRoute = (overrides: Partial<Route> = {}): Route => ({
  match: LITELLM_URL,
  json: LITELLM_FIXTURE,
  ...overrides,
});

function clearStorage() {
  for (const key of Object.keys(mockStorage)) delete mockStorage[key];
}

const extensionSender = {
  id: "mock-id",
  url: "chrome-extension://mock-id/popup/providers.html",
  frameId: 0,
  tab: { id: 1 },
};

let handler: Function;

function send(message: unknown): Promise<any> {
  return new Promise((resolve) => handler(message, extensionSender, resolve));
}

beforeAll(async () => {
  mockStorage.securitySchema = 2;
  await import("../../src/background/background");
  handler = chromeRuntime.onMessage.addListener.mock.calls.at(-1)![0];
});

beforeEach(() => {
  clearStorage();
  __setPriceIndexForTests(null);
});

afterEach(() => {
  setLlmFetch(undefined);
});

describe("refreshPrices", () => {
  it("persists index and timestamp together, then publishes to memory", async () => {
    const { fetcher } = installFetch([litellmRoute()]);

    const result = await refreshPrices();

    expect(result.success).toBe(true);
    expect(result.count).toBe(2);
    expect(String(fetcher.mock.calls[0][0])).toContain(LITELLM_URL);
    expect(mockStorage.modelPrices).toBeDefined();
    expect(mockStorage.modelPricesFetchedAt).toBe(result.fetchedAt);
    expect(await getPriceFreshness()).toBe(result.fetchedAt);
    const index = await getPriceIndex();
    expect(index["claude-opus-5-5"]?.vision).toBe(true);
  });

  it("coalesces concurrent callers into a single request", async () => {
    const { fetcher } = installFetch([litellmRoute()]);

    const results = await Promise.all([refreshPrices(), refreshPrices(), refreshPrices()]);

    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(results.every((r) => r.success)).toBe(true);
  });

  it("gives up after a single 15s attempt and releases the lock", async () => {
    vi.useFakeTimers();
    try {
      expect(PRICE_REFRESH_TIMEOUT_MS).toBe(15000);
      const fetcher = vi.fn(
        (_url: string, init: RequestInit) =>
          new Promise<Response>((_resolve, reject) => {
            init.signal?.addEventListener("abort", () =>
              reject(new DOMException("aborted", "AbortError")),
            );
          }),
      );
      setLlmFetch(fetcher as unknown as typeof fetch);

      const pending = refreshPrices();
      await vi.advanceTimersByTimeAsync(PRICE_REFRESH_TIMEOUT_MS);
      const result = await pending;

      expect(result.success).toBe(false);
      // `retries: 0`: the timed-out request is never repeated.
      expect(fetcher).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it("keeps previous metadata on an HTTP failure and retries later", async () => {
    const previous = {
      "claude-opus-5-5": { inputPer1M: 1, outputPer1M: 5, vision: false, provider: "anthropic" },
    };
    __setPriceIndexForTests(previous);
    mockStorage.modelPrices = previous;
    mockStorage.modelPricesFetchedAt = 111;

    installFetch([litellmRoute({ status: 500, json: { error: "boom" } })]);
    const failed = await refreshPrices();

    expect(failed.success).toBe(false);
    expect(failed.error).toContain("500");
    expect(failed.stale).toBe(true);
    expect(mockStorage.modelPricesFetchedAt).toBe(111);
    expect((await getPriceIndex())["claude-opus-5-5"]?.vision).toBe(false);

    installFetch([litellmRoute()]);
    const retry = await refreshPrices();
    expect(retry.success).toBe(true);
    expect((await getPriceIndex())["claude-opus-5-5"]?.vision).toBe(true);
  });

  it("rejects invalid JSON and an empty index without touching metadata", async () => {
    __setPriceIndexForTests({ previous: { inputPer1M: 1, outputPer1M: 1, vision: true } });
    mockStorage.modelPrices = { previous: { inputPer1M: 1, outputPer1M: 1, vision: true } };

    installFetch([litellmRoute({ rawText: "not-json" })]);
    const badJson = await refreshPrices();
    expect(badJson.success).toBe(false);
    expect(badJson.error).toMatch(/invalid json/i);

    installFetch([litellmRoute({ json: { "some-entry": { litellm_provider: "bedrock" } } })]);
    const empty = await refreshPrices();
    expect(empty.success).toBe(false);
    expect(empty.error).toMatch(/empty/i);

    expect(mockStorage.modelPrices).toEqual({
      previous: { inputPer1M: 1, outputPer1M: 1, vision: true },
    });
    expect((await getPriceIndex()).previous).toBeDefined();
  });

  it("does not publish a refresh whose storage write failed", async () => {
    const previous = { "claude-opus-5-5": { inputPer1M: 1, outputPer1M: 5, vision: false } };
    __setPriceIndexForTests(previous);
    mockStorage.modelPrices = previous;
    installFetch([litellmRoute()]);
    chromeStorageLocal.set.mockRejectedValueOnce(new Error("quota exceeded"));

    const result = await refreshPrices();

    expect(result.success).toBe(false);
    expect(result.error).toContain("quota exceeded");
    expect(mockStorage.modelPrices).toEqual(previous);
    const index = await getPriceIndex();
    expect(index["claude-opus-5-5"]?.vision).toBe(false);
  });
});

describe("provider setup and detection refresh metadata first", () => {
  it("prices a fresh model during detection (the claude-opus-5-5 repro)", async () => {
    mockStorage.providerProfiles = { anthropic: { apiKey: await encryptApiKey("fake-key") } };
    const { fetcher } = installFetch([
      litellmRoute(),
      { match: ANTHROPIC_MODELS_URL, json: ANTHROPIC_CATALOG },
    ]);

    const res = await send({ type: "FETCH_PROVIDER_MODELS", provider: "anthropic" });

    expect(res.success).toBe(true);
    // LiteLLM ran before the catalog enrichment, not after.
    expect(String(fetcher.mock.calls[0][0])).toContain(LITELLM_URL);
    const detected = res.models.find((m: any) => m.id === "claude-opus-5-5");
    expect(detected.price.inputPer1M).toBe(5);
    expect(detected.price.vision).toBe(true);

    const profile = res.state.profiles.find((p: any) => p.id === "anthropic");
    expect(profile.modelInfo["claude-opus-5-5"].maxInput).toBe(200000);
    expect(profile.visionModels).toContain("claude-opus-5-5");
    expect(profile.visionModels).not.toContain("legacy-cheap");
    // The index is now persisted for later cache-only reads.
    expect(mockStorage.modelPricesFetchedAt).toBeTypeOf("number");
  });

  it("refreshes on first key setup with validation", async () => {
    installFetch([litellmRoute(), { match: ANTHROPIC_MODELS_URL, json: ANTHROPIC_CATALOG }]);

    const res = await send({
      type: "SAVE_PROVIDER_KEY",
      provider: "anthropic",
      rawKey: "fake-key",
      test: true,
    });

    expect(res.success).toBe(true);
    expect(res.warning).toBeUndefined();
    const detected = res.models.find((m: any) => m.id === "claude-opus-5-5");
    expect(detected.price.vision).toBe(true);
    const profile = res.state.profiles.find((p: any) => p.id === "anthropic");
    expect(profile.modelInfo["claude-opus-5-5"]).not.toBeNull();
  });

  it("still validates a key when the metadata refresh fails, with a warning", async () => {
    installFetch([
      litellmRoute({ status: 500, json: { error: "boom" } }),
      { match: ANTHROPIC_MODELS_URL, json: ANTHROPIC_CATALOG },
    ]);

    const res = await send({
      type: "SAVE_PROVIDER_KEY",
      provider: "anthropic",
      rawKey: "fake-key",
      test: true,
    });

    expect(res.success).toBe(true);
    expect(res.warning).toContain("cached");
    expect(res.models.map((m: any) => m.id)).toContain("claude-opus-5-5");
    const profile = res.state.profiles.find((p: any) => p.id === "anthropic");
    // Models are still unknown to metadata, not silently dropped.
    expect(profile.modelInfo["claude-opus-5-5"]).toBeNull();
    expect(profile.visionModels).toEqual([]);
  });

  it("surfaces the metadata warning when detection proceeds on cached data", async () => {
    mockStorage.providerProfiles = {
      anthropic: { apiKey: await encryptApiKey("fake-key") },
    };
    installFetch([
      litellmRoute({ status: 500, json: { error: "boom" } }),
      { match: ANTHROPIC_MODELS_URL, json: ANTHROPIC_CATALOG },
    ]);

    const res = await send({ type: "FETCH_PROVIDER_MODELS", provider: "anthropic" });

    expect(res.success).toBe(true);
    expect(res.warning).toContain("cached");
    expect(res.models.map((m: any) => m.id)).toContain("claude-opus-5-5");
  });

  it("surfaces the metadata warning when auto selection re-detects", async () => {
    mockStorage.providerProfiles = {
      anthropic: {
        apiKey: await encryptApiKey("fake-key"),
        selectionMode: "manual",
      },
    };
    installFetch([
      litellmRoute({ status: 500, json: { error: "boom" } }),
      { match: ANTHROPIC_MODELS_URL, json: ANTHROPIC_CATALOG },
    ]);

    const res = await send({
      type: "SET_SELECTION_MODE",
      provider: "anthropic",
      selectionMode: "auto",
    });

    expect(res.success).toBe(true);
    expect(res.warning).toContain("cached");
    expect(res.models.map((m: any) => m.id)).toContain("claude-opus-5-5");
  });
});

describe("connection test", () => {
  it("refreshes before choosing the model and returns fresh state on success", async () => {
    mockStorage.providerProfiles = {
      anthropic: {
        apiKey: await encryptApiKey("fake-key"),
        models: ["claude-opus-5-5", "legacy-cheap"],
        selectedModels: ["claude-opus-5-5", "legacy-cheap"],
        thinking: true,
      },
    };
    // Stale metadata makes legacy-cheap look cheapest; fresh metadata reverses it.
    __setPriceIndexForTests({
      "legacy-cheap": { inputPer1M: 0.1, outputPer1M: 0.1, vision: false, provider: "anthropic" },
    });
    const { calls } = installFetch([
      litellmRoute(),
      { match: ANTHROPIC_MESSAGES_URL, json: ANTHROPIC_OK },
    ]);

    const res = await send({ type: "TEST_PROVIDER_CONNECTION", provider: "anthropic" });

    expect(res.success).toBe(true);
    expect(res.model).toBe("claude-opus-5-5");
    const messages = calls.find((c) => c.url.includes(ANTHROPIC_MESSAGES_URL));
    expect(messages?.body.model).toBe("claude-opus-5-5");
    expect(res.costUsd).toBeGreaterThan(0);
    expect(res.state.profiles.find((p: any) => p.id === "anthropic").visionModels).toContain(
      "claude-opus-5-5",
    );
  });

  it("returns refreshed state even when the model call fails", async () => {
    mockStorage.providerProfiles = {
      anthropic: { apiKey: await encryptApiKey("fake-key"), models: ["claude-opus-5-5"] },
    };
    installFetch([
      litellmRoute(),
      {
        match: ANTHROPIC_MESSAGES_URL,
        status: 400,
        json: { error: { type: "invalid_request_error", message: "bad model" } },
      },
    ]);

    const res = await send({
      type: "TEST_PROVIDER_CONNECTION",
      provider: "anthropic",
      model: "claude-opus-5-5",
    });

    expect(res.success).toBe(false);
    expect(res.error).toBeTruthy();
    const profile = res.state.profiles.find((p: any) => p.id === "anthropic");
    expect(profile.modelInfo["claude-opus-5-5"].vision).toBe(true);
    expect(profile.visionModels).toContain("claude-opus-5-5");
  });

  it("reports a metadata warning without hiding an independent test result", async () => {
    mockStorage.providerProfiles = {
      anthropic: { apiKey: await encryptApiKey("fake-key"), models: ["claude-opus-5-5"] },
    };
    installFetch([
      litellmRoute({ status: 503, json: { error: "unavailable" } }),
      { match: ANTHROPIC_MESSAGES_URL, json: ANTHROPIC_OK },
    ]);

    const res = await send({
      type: "TEST_PROVIDER_CONNECTION",
      provider: "anthropic",
      model: "claude-opus-5-5",
    });

    expect(res.success).toBe(true);
    expect(res.text).toBe("OK");
    expect(res.warning).toContain("cached");
    expect(res.state).toBeDefined();
  });
});

describe("manual refresh and cache-only reads", () => {
  it("makes refreshed capabilities effective immediately", async () => {
    mockStorage.providerProfiles = {
      anthropic: {
        apiKey: await encryptApiKey("fake-key"),
        models: ["claude-opus-5-5"],
        selectedModels: ["claude-opus-5-5"],
        visionModels: [],
      },
    };
    __setPriceIndexForTests({
      "claude-opus-5-5": { inputPer1M: 1, outputPer1M: 2, vision: false, provider: "anthropic" },
    });
    installFetch([litellmRoute()]);

    const res = await send({ type: "UPDATE_MODEL_PRICES" });

    expect(res.success).toBe(true);
    const profile = res.state.profiles.find((p: any) => p.id === "anthropic");
    expect(profile.modelInfo["claude-opus-5-5"].vision).toBe(true);
    expect(profile.visionModels).toContain("claude-opus-5-5");
  });

  it("serves GET_PROVIDER_STATE from cache without any network call", async () => {
    mockStorage.providerProfiles = {
      anthropic: {
        apiKey: await encryptApiKey("fake-key"),
        models: ["claude-opus-5-5"],
        selectedModels: ["claude-opus-5-5"],
      },
    };
    __setPriceIndexForTests({
      "claude-opus-5-5": { inputPer1M: 5, outputPer1M: 25, vision: true, provider: "anthropic" },
    });
    const { fetcher } = installFetch([litellmRoute()]);

    const res = await send({ type: "GET_PROVIDER_STATE" });

    expect(res.success).toBe(true);
    expect(fetcher).not.toHaveBeenCalled();
    const profile = res.state.profiles.find((p: any) => p.id === "anthropic");
    expect(profile.modelInfo["claude-opus-5-5"].inputPer1M).toBe(5);
    expect(profile.visionModels).toContain("claude-opus-5-5");
  });

  it("does not refresh metadata during an ordinary analysis", async () => {
    mockStorage.allowedDomains = ["quiz.test"];
    mockStorage.providerProfiles = {
      anthropic: {
        apiKey: await encryptApiKey("fake-key"),
        thinking: false,
        models: ["claude-opus-5-5"],
        selectedModels: ["claude-opus-5-5"],
      },
    };
    mockStorage.roles = {
      primary: { provider: "anthropic", model: "claude-opus-5-5" },
      validator: null,
    };
    __setPriceIndexForTests({
      "claude-opus-5-5": { inputPer1M: 5, outputPer1M: 25, vision: true, provider: "anthropic" },
    });
    const { calls } = installFetch([
      litellmRoute(),
      {
        match: ANTHROPIC_MESSAGES_URL,
        json: { content: [{ type: "text", text: "ANSWER: A\nCONFIDENCE: HIGH" }], stop_reason: "end_turn" },
      },
    ]);

    const res = await new Promise((resolve) =>
      handler(
        {
          type: "ANALYZE_QUESTION",
          context: {
            questionText: "Which one?",
            questionType: "multiple-choice",
            options: [{ letter: "A", text: "one" }, { letter: "B", text: "two" }],
            pageTitle: "Quiz",
            pageUrl: "https://quiz.test/exam",
            responseMode: "quick",
          },
        },
        { id: "mock-id", url: "https://quiz.test/exam", frameId: 0, tab: { id: 7 } },
        resolve,
      ),
    );

    expect(res.success).toBe(true);
    expect(calls.map((c) => c.url).some((url) => url.includes(LITELLM_URL))).toBe(false);
  });
});
