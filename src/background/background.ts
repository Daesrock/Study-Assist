/**
 * Study Assist - Background Service Worker (Entry Point)
 * Routes messages and manages lifecycle events
 */

import { log, logProviders, setDebugMode, activeProviderController, setActiveProviderController } from "./modules/constants.js";
import { devLog, DEV_LOGGING } from "./modules/logger.js";
import type { ExtensionMessage, MessageResponse } from "./modules/constants.js";
import type { AnalysisResponse } from "../types/index.js";
import { analyzeQuestion, analyzeQuestionStreaming, testProviderKey, testProviderConnection } from "./modules/api.js";
import { handleToggleExtension, handleDisguiseMode, restoreDisguiseMode } from "./modules/extensionState.js";
import { getUsageStats, getRecentHistory, clearUsageData, getStorageInfo, trimHistory, updateStorageBadge } from "./modules/usageTracker.js";
import { getProviderState, saveProviderKey, clearProviderKey, setModelVision, setModelSelected, setModelEndpoint, setSelectionMode, addCustomModel, saveRoles, saveProfile, getProviderKey, applyDetectedModels, saveQaModel, saveCustomProvider, deleteCustomProvider } from "./modules/llm/profiles.js";
import { fetchModels } from "./modules/llm/catalog.js";
import { getPreset, ensureRegistry, resetRegistry } from "./modules/llm/registry.js";
import { getPriceIndex, lookupModelInfo, refreshPrices } from "./modules/llm/pricing.js";

// ============================================
// Message Handler
// ============================================

/** Success response that always carries the fresh, sanitized provider state. */
async function withState(
  extra: Record<string, unknown> = {},
): Promise<MessageResponse & { state: unknown }> {
  return { success: true, ...extra, state: await getProviderState() };
}

interface DetectedModel {
  id: string;
  price?: unknown;
}

/**
 * Single `/models` call that validates a key, stores the catalog and returns
 * the detected models enriched with LiteLLM price/capability metadata.
 */
async function detectProviderModels(
  provider: string,
  apiKey: string,
): Promise<{ success: boolean; models: DetectedModel[]; error?: string }> {
  const preset = getPreset(provider);
  const result = await fetchModels(preset, apiKey);
  if (!result.success) {
    return { success: false, models: [], error: result.error };
  }

  const index = await getPriceIndex();
  const candidates = result.models.map((model) => ({
    id: model.id,
    created: model.created,
    info: lookupModelInfo(index, provider, model.id),
  }));
  await applyDetectedModels(provider, candidates);

  const models = result.models.map((model) => {
    const price = lookupModelInfo(index, provider, model.id);
    return price ? { id: model.id, price } : { id: model.id };
  });
  return { success: true, models };
}

async function handleMessage(
  message: ExtensionMessage,
  _sender: chrome.runtime.MessageSender
): Promise<MessageResponse | AnalysisResponse> {
  await ensureRegistry();
  switch (message.type) {
    case "TOGGLE_EXTENSION":
      return handleToggleExtension(message.active ?? false);

    case "TEST_PROVIDER_KEY":
      return testProviderKey(message.provider ?? "anthropic", message.apiKey ?? "");

    case "DEV_LOG":
      devLog(
        "content",
        message.level ?? "log",
        message.message ?? "",
        message.data,
      );
      return { success: true };

    case "TEST_PROVIDER_CONNECTION":
      try {
        return (await testProviderConnection(
          message.provider ?? "",
          message.model,
        )) as MessageResponse;
      } catch (error) {
        return { success: false, error: (error as Error).message };
      }

    case "ANALYZE_QUESTION":
      return analyzeQuestion(message.context!);

    case "CANCEL_ANALYSIS":
      if (activeProviderController) {
        log("[Study Assist] Cancelling analysis...");
        activeProviderController.abort();
        setActiveProviderController(null);
        return { success: true, cancelled: true };
      }
      return { success: true, cancelled: false };

    case "TOGGLE_DISGUISE_MODE":
      return handleDisguiseMode(message.enabled ?? false);

    case "GET_USAGE_STATS":
      try {
        const stats = await getUsageStats();
        return { success: true, stats } as MessageResponse & { stats: unknown };
      } catch (error) {
        return { success: false, error: (error as Error).message };
      }

    case "GET_USAGE_HISTORY":
      try {
        const history = await getRecentHistory(message.limit ?? 20);
        return { success: true, history } as MessageResponse & { history: unknown };
      } catch (error) {
        return { success: false, error: (error as Error).message };
      }

    case "CLEAR_USAGE_DATA":
      try {
        await clearUsageData();
        return { success: true };
      } catch (error) {
        return { success: false, error: (error as Error).message };
      }

    case "GET_STORAGE_INFO":
      try {
        const storageInfo = await getStorageInfo();
        return { success: true, storageInfo } as MessageResponse & { storageInfo: unknown };
      } catch (error) {
        return { success: false, error: (error as Error).message };
      }

    case "TRIM_HISTORY":
      try {
        const deleted = await trimHistory({ keepLast: message.keepLast, keepDays: message.keepDays });
        return { success: true, deleted } as MessageResponse & { deleted: unknown };
      } catch (error) {
        return { success: false, error: (error as Error).message };
      }

    // ============================================
    // Provider configuration (Step B)
    // ============================================

    case "GET_PROVIDER_STATE":
      try {
        return await withState();
      } catch (error) {
        return { success: false, error: (error as Error).message };
      }

    case "SAVE_PROVIDER_KEY":
      try {
        const provider = message.provider ?? "";
        const rawKey = message.rawKey ?? "";
        if (!provider || !rawKey) return { success: false, error: "Missing provider or key." };

        let warning: string | undefined;
        let models: DetectedModel[] | undefined;

        // Validate + detect in a single /models request.
        if (message.test) {
          const outcome = await detectProviderModels(provider, rawKey);
          if (outcome.success) {
            models = outcome.models;
          } else {
            const error = outcome.error || `API Error (${provider})`;
            if (error.includes("429")) {
              warning = "API key is valid but rate limited. It will work when the limit resets.";
            } else {
              return { success: false, error };
            }
          }
        }

        await saveProviderKey(provider, rawKey);
        logProviders("key saved", { provider });
        return await withState({ warning, models });
      } catch (error) {
        return { success: false, error: (error as Error).message };
      }

    case "DELETE_PROVIDER_KEY":
      try {
        await clearProviderKey(message.provider ?? "");
        logProviders("key deleted", { provider: message.provider });
        return await withState();
      } catch (error) {
        return { success: false, error: (error as Error).message };
      }

    case "SET_PROVIDER_THINKING":
      try {
        await saveProfile(message.provider ?? "", { thinking: message.thinking === true });
        return await withState();
      } catch (error) {
        return { success: false, error: (error as Error).message };
      }

    case "SET_MODEL_VISION":
      try {
        await setModelVision(message.provider ?? "", message.model ?? "", message.vision === true);
        return await withState();
      } catch (error) {
        return { success: false, error: (error as Error).message };
      }

    case "SET_MODEL_SELECTED":
      try {
        await setModelSelected(message.provider ?? "", message.model ?? "", message.selected === true);
        return await withState();
      } catch (error) {
        return { success: false, error: (error as Error).message };
      }

    case "SET_MODEL_ENDPOINT":
      try {
        await setModelEndpoint(message.provider ?? "", message.model ?? "", message.endpoint ?? "");
        return await withState();
      } catch (error) {
        return { success: false, error: (error as Error).message };
      }

    case "SET_SELECTION_MODE":
      try {
        const provider = message.provider ?? "";
        const mode = message.selectionMode === "manual" ? "manual" : "auto";
        await setSelectionMode(provider, mode);

        // Switching back to auto re-runs detection so the curated list applies.
        if (mode === "auto") {
          const apiKey = await getProviderKey(provider);
          if (apiKey) {
            const outcome = await detectProviderModels(provider, apiKey);
            return {
              success: true,
              models: outcome.models,
              state: await getProviderState(),
            } as MessageResponse & { models: unknown; state: unknown };
          }
        }
        return await withState();
      } catch (error) {
        return { success: false, error: (error as Error).message };
      }

    case "ADD_PROVIDER_MODEL":
      try {
        await addCustomModel(message.provider ?? "", message.model ?? "");
        return await withState();
      } catch (error) {
        return { success: false, error: (error as Error).message };
      }

    case "SAVE_QA_MODEL":
      try {
        await saveQaModel(message.qaModel ?? null);
        return { success: true };
      } catch (error) {
        return { success: false, error: (error as Error).message };
      }

    case "SAVE_ROLES":
      try {
        if (!message.roles) return { success: false, error: "Missing roles." };
        await saveRoles(message.roles);
        return { success: true };
      } catch (error) {
        return { success: false, error: (error as Error).message };
      }

    case "SAVE_CUSTOM_PROVIDER":
      try {
        const config = message.customProvider;
        if (!config || !config.id || !config.label || !config.baseUrl || !config.dialect) {
          return { success: false, error: "Missing provider fields." };
        }
        if (
          config.dialect !== "anthropic" &&
          config.dialect !== "openai-compatible" &&
          config.dialect !== "openai-responses"
        ) {
          return { success: false, error: "Unsupported dialect." };
        }
        await saveCustomProvider(config);
        return await withState();
      } catch (error) {
        return { success: false, error: (error as Error).message };
      }

    case "DELETE_CUSTOM_PROVIDER":
      try {
        await deleteCustomProvider(message.provider ?? "");
        return await withState();
      } catch (error) {
        return { success: false, error: (error as Error).message };
      }

    case "FETCH_PROVIDER_MODELS":
      try {
        const provider = message.provider ?? "";
        const apiKey = message.rawKey || (await getProviderKey(provider));
        if (!apiKey) return { success: false, error: "No API key for provider." };

        const outcome = await detectProviderModels(provider, apiKey);
        return {
          success: outcome.success,
          models: outcome.models,
          error: outcome.error,
          state: await getProviderState(),
        } as MessageResponse & { models: unknown; state: unknown };
      } catch (error) {
        return { success: false, error: (error as Error).message };
      }

    case "UPDATE_MODEL_PRICES":
      try {
        const result = await refreshPrices();
        return {
          success: result.success,
          count: result.count,
          error: result.error,
          fetchedAt: result.fetchedAt,
          state: await getProviderState(),
        } as MessageResponse & { count: number; state: unknown };
      } catch (error) {
        return { success: false, error: (error as Error).message };
      }

    default:
      return { success: false, error: "Unknown message type" };
  }
}

chrome.runtime.onMessage.addListener(
  (
    message: ExtensionMessage,
    sender: chrome.runtime.MessageSender,
    sendResponse: (response: MessageResponse | AnalysisResponse) => void
  ): boolean => {
    handleMessage(message, sender)
      .then((response) => sendResponse(response))
      .catch((error: Error) => sendResponse({ success: false, error: error.message }));
    return true;
  }
);

// ============================================
// Port-based Messaging (streaming + quick analysis)
// ============================================

chrome.runtime.onConnect.addListener((port) => {
  if (port.name === "quick-analysis") {
    port.onMessage.addListener(async (msg: { context: import("../types/index.js").AnalysisContext }) => {
      try {
        const result = await analyzeQuestion(msg.context, (status: string) => {
          try { port.postMessage({ type: "STATUS", status }); } catch { /* port disconnected */ }
        });
        try { port.postMessage({ type: "RESULT", result }); } catch { /* port disconnected */ }
      } catch (error) {
        try {
          port.postMessage({ type: "STATUS", status: "ERROR" });
          port.postMessage({ type: "RESULT", result: { success: false, error: (error as Error).message } });
        } catch {
          // Port may have been disconnected
        }
      }
    });
    return;
  }

  if (port.name !== "stream-analysis") return;

  port.onMessage.addListener(async (msg: { context: import("../types/index.js").AnalysisContext }) => {
    try {
      await analyzeQuestionStreaming(msg.context, port);
    } catch (error) {
      try {
        port.postMessage({ type: "STREAM_ERROR", error: (error as Error).message });
      } catch {
        // Port may have been disconnected
      }
    }
  });
});

// ============================================
// Lifecycle Events
// ============================================

chrome.runtime.onInstalled.addListener(async (details: chrome.runtime.InstalledDetails) => {
  if (details.reason === "install") {
    await chrome.storage.local.set({
      extensionActive: false,
      responseMode: "guided",
      autoDetect: true,
      highlightQuestions: true,
      useMultiBank: true,
      theme: "system",
      buttonPosition: "bottom-right",
      errorLog: "",
    });
    await chrome.action.setBadgeText({ text: "" });
  }
  await restoreDisguiseMode();
  await updateStorageBadge();
});

chrome.runtime.onStartup.addListener(async () => {
  await restoreDisguiseMode();
  await updateStorageBadge();
});

// ============================================
// Tab Update Handler
// ============================================

chrome.tabs.onUpdated.addListener(
  async (tabId: number, changeInfo: chrome.tabs.TabChangeInfo, tab: chrome.tabs.Tab) => {
    if (changeInfo.status === "complete") {
      try {
        const { extensionActive } = await chrome.storage.local.get("extensionActive") as { extensionActive?: boolean };
        if (extensionActive) {
          chrome.tabs.sendMessage(tabId, { type: "PAGE_LOADED", url: tab.url }).catch(() => {});
        }
      } catch (_error) {
        // Silent fail
      }
    }
  }
);

// ============================================
// Global debug flag
// ============================================

async function loadDebugMode(): Promise<void> {
  try {
    const { debugMode } = (await chrome.storage.local.get("debugMode")) as {
      debugMode?: boolean;
    };
    if (typeof debugMode === "boolean") {
      setDebugMode(debugMode);
    } else {
      setDebugMode(DEV_LOGGING);
      await chrome.storage.local.set({ debugMode: DEV_LOGGING });
    }
  } catch {
    setDebugMode(DEV_LOGGING);
  }
}

loadDebugMode();

if (chrome.storage.onChanged) {
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== "local") return;
    if ("debugMode" in changes) {
      setDebugMode(changes.debugMode?.newValue === true);
    }
    if ("customProviders" in changes) {
      resetRegistry();
      ensureRegistry().catch(() => {});
    }
  });
}
