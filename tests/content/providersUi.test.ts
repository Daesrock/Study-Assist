/**
 * Providers-page UI regressions.
 *
 * The page must consume the fresh state that setup/detection/test/manual
 * refresh return, update effective capabilities in place (no reload), keep the
 * user's filters and selections, and show a metadata warning next to - not
 * instead of - the independent result.
 *
 * `popup/providers.js` is a plain script (no module exports), so it is read
 * and evaluated per test with the captured DOMContentLoaded boot handler.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";
import { promises as fs } from "fs";
import path from "path";

const PROVIDERS_HTML = await fs.readFile(
  path.join(process.cwd(), "popup/providers.html"),
  "utf8",
);
const PROVIDERS_JS = await fs.readFile(
  path.join(process.cwd(), "popup/providers.js"),
  "utf8",
);

const WARNING = "Could not refresh prices and capabilities (HTTP 500). Using cached data.";

function bodyFragment(): string {
  const start = PROVIDERS_HTML.indexOf("<body>");
  const end = PROVIDERS_HTML.indexOf("</body>");
  return PROVIDERS_HTML.slice(start + "<body>".length, end);
}

interface StateOverrides {
  models?: string[];
  selectedModels?: string[];
  visionModels?: string[];
  modelInfo?: Record<string, unknown>;
}

function providerState(over: StateOverrides = {}) {
  const models = over.models ?? ["claude-opus-5-5", "legacy-cheap"];
  const selectedModels = over.selectedModels ?? ["claude-opus-5-5"];
  return {
    presets: [
      {
        id: "anthropic",
        label: "Anthropic",
        dialect: "anthropic",
        baseUrl: "https://api.anthropic.com",
        defaultThinking: true,
        capabilities: { images: true, matching: true, reasoning: true },
      },
    ],
    templates: [],
    profiles: [
      {
        id: "anthropic",
        hasKey: true,
        thinking: true,
        models,
        customModels: [],
        visionModels: over.visionModels ?? [],
        selectedModels,
        selectionMode: "auto",
        lastSync: null,
        modelInfo: over.modelInfo ?? {
          "claude-opus-5-5": { inputPer1M: 5, outputPer1M: 25, vision: false },
          "legacy-cheap": { inputPer1M: 1, outputPer1M: 1, vision: false },
        },
        endpoints: [],
        modelEndpoints: {},
      },
    ],
    roles: { primary: null, validator: null },
  };
}

const freshState = () =>
  providerState({
    visionModels: ["claude-opus-5-5"],
    modelInfo: {
      "claude-opus-5-5": { inputPer1M: 5, outputPer1M: 25, vision: true },
      "legacy-cheap": { inputPer1M: 1, outputPer1M: 1, vision: false },
    },
  });

const flush = async () => {
  for (let i = 0; i < 4; i++) await new Promise((resolve) => setTimeout(resolve, 0));
};

function ensureCssEscape() {
  const g = globalThis as any;
  if (!g.CSS) g.CSS = {};
  if (!g.CSS.escape) {
    g.CSS.escape = (value: string) =>
      String(value).replace(/[^a-zA-Z0-9_-]/g, (char: string) => `\\${char}`);
  }
}

/** Load the page with canned responses and run its DOMContentLoaded boot. */
async function bootProviders(responses: Record<string, unknown>) {
  document.body.innerHTML = bodyFragment();
  ensureCssEscape();

  const chromeMock = (globalThis as any).chrome;
  chromeMock.i18n = { getMessage: (key: string) => key };
  chromeMock.storage = {
    local: { get: vi.fn(async () => ({})), set: vi.fn(async () => {}) },
  };
  chromeMock.runtime.sendMessage = vi.fn(async (message: { type: string }) =>
    message.type in responses
      ? responses[message.type]
      : { success: false, error: `unmocked ${message.type}` },
  );

  // Capture the boot handler instead of leaving it attached to the shared
  // jsdom document, so each test boots exactly once.
  const captured: Array<[string, any]> = [];
  const addSpy = vi
    .spyOn(document, "addEventListener")
    .mockImplementation((type: string, listener: any) => {
      captured.push([type, listener]);
    });
  try {
    new Function(PROVIDERS_JS)();
  } finally {
    addSpy.mockRestore();
  }

  const boot = captured.find(([type]) => type === "DOMContentLoaded")?.[1];
  expect(boot, "boot handler registered").toBeTypeOf("function");
  await boot();
  await flush();
}

function card(provider = "anthropic"): HTMLElement {
  const element = document.querySelector<HTMLElement>(
    `.provider-card[data-provider="${provider}"]`,
  );
  expect(element, `card ${provider}`).toBeTruthy();
  return element!;
}

function row(model: string, provider = "anthropic"): HTMLElement {
  const element = card(provider).querySelector<HTMLElement>(
    `.model-row[data-model="${model}"]`,
  );
  expect(element, `row ${model}`).toBeTruthy();
  return element!;
}

function visionChecked(model: string): boolean {
  return (row(model).querySelector(".model-vision") as HTMLInputElement).checked;
}

function includedChecked(model: string): boolean {
  return (row(model).querySelector(".model-include") as HTMLInputElement).checked;
}

beforeEach(() => {
  vi.unstubAllGlobals();
});

describe("providers page metadata refresh", () => {
  it("applies the connection test's fresh capabilities without a reload", async () => {
    await bootProviders({
      GET_PROVIDER_STATE: { success: true, state: providerState() },
      TEST_PROVIDER_CONNECTION: {
        success: true,
        model: "claude-opus-5-5",
        text: "OK",
        inputTokens: 10,
        outputTokens: 2,
        costUsd: 0.001,
        warning: WARNING,
        state: freshState(),
      },
    });

    expect(visionChecked("claude-opus-5-5")).toBe(false);
    expect(includedChecked("claude-opus-5-5")).toBe(true);

    // Narrow the list first: the filter must survive the state swap.
    const search = card().querySelector(".model-search") as HTMLInputElement;
    search.value = "opus";
    search.dispatchEvent(new Event("input"));
    expect(
      (row("legacy-cheap").style.display || "none"),
      "filtered-out row",
    ).toBe("none");

    (card().querySelector(".test-connection") as HTMLButtonElement).click();
    await flush();

    // Fresh vision from the same response, no page reload.
    expect(visionChecked("claude-opus-5-5")).toBe(true);
    // Filter and selection preserved across the re-render.
    expect((card().querySelector(".model-search") as HTMLInputElement).value).toBe("opus");
    expect(row("legacy-cheap").style.display).toBe("none");
    expect(includedChecked("claude-opus-5-5")).toBe(true);
    // The independent test result stays visible next to the metadata warning.
    expect(card().querySelector(".provider-summary")?.textContent).toContain("providerTestOk");
    expect(card().querySelector(".provider-msg")?.textContent).toContain("cached");
  });

  it("shows a failed connection test together with the metadata warning", async () => {
    await bootProviders({
      GET_PROVIDER_STATE: { success: true, state: providerState() },
      TEST_PROVIDER_CONNECTION: {
        success: false,
        model: "claude-opus-5-5",
        error: "bad request",
        warning: WARNING,
        state: providerState(),
      },
    });

    (card().querySelector(".test-connection") as HTMLButtonElement).click();
    await flush();

    expect(card().querySelector(".provider-summary")?.textContent).toContain("providerTestError");
    expect(card().querySelector(".provider-summary")?.textContent).toContain("bad request");
    expect(card().querySelector(".provider-msg")?.textContent).toContain("cached");
  });

  it("updates effective capabilities on manual refresh", async () => {
    await bootProviders({
      GET_PROVIDER_STATE: { success: true, state: providerState() },
      UPDATE_MODEL_PRICES: { success: true, count: 2, state: freshState() },
    });

    expect(visionChecked("claude-opus-5-5")).toBe(false);

    (document.getElementById("refresh-prices") as HTMLButtonElement).click();
    await flush();

    expect(visionChecked("claude-opus-5-5")).toBe(true);
    const status = document.getElementById("providers-status")?.textContent ?? "";
    expect(status).toContain("providerPricesUpdated");
  });

  it("keeps the detection summary visible when metadata warns", async () => {
    await bootProviders({
      GET_PROVIDER_STATE: { success: true, state: providerState() },
      FETCH_PROVIDER_MODELS: {
        success: true,
        models: [
          { id: "claude-opus-5-5", price: { inputPer1M: 5, outputPer1M: 25, vision: true } },
          { id: "legacy-cheap", price: { inputPer1M: 1, outputPer1M: 1, vision: false } },
        ],
        warning: WARNING,
        state: freshState(),
      },
    });

    (card().querySelector(".detect-models") as HTMLButtonElement).click();
    await flush();

    const summary = card().querySelector(".provider-summary")?.textContent ?? "";
    expect(summary).toContain("providerNewLabel");
    expect(summary).toContain("providerTotalLabel");
    expect(card().querySelector(".provider-msg")?.textContent).toContain("cached");
    expect(visionChecked("claude-opus-5-5")).toBe(true);
  });

  it("keeps the saved-key confirmation when metadata warns", async () => {
    await bootProviders({
      GET_PROVIDER_STATE: { success: true, state: providerState() },
      SAVE_PROVIDER_KEY: {
        success: true,
        warning: WARNING,
        models: [
          { id: "claude-opus-5-5", price: { inputPer1M: 5, outputPer1M: 25, vision: true } },
        ],
        state: freshState(),
      },
    });

    (card().querySelector(".provider-key") as HTMLInputElement).value = "fake-key";
    (card().querySelector(".save-key") as HTMLButtonElement).click();
    await flush();

    const message = card().querySelector(".provider-msg")?.textContent ?? "";
    expect(message).toContain("providerSaved");
    expect(message).toContain("cached");
    expect(card().querySelector(".provider-summary")?.textContent).toContain("providerTotalLabel");
  });
});
