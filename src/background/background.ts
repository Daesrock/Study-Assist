/**
 * Study Assist - Background Service Worker (Entry Point)
 * Routes messages and manages lifecycle events
 */

import { log, activeDeepSeekController, setActiveDeepSeekController } from "./modules/constants.js";
import type { ExtensionMessage, MessageResponse } from "./modules/constants.js";
import type { AnalysisResponse } from "../types/index.js";
import { analyzeQuestion, analyzeQuestionStreaming, testApiKey, testDeepSeekApiKey, testProviderKey } from "./modules/api.js";
import { handleToggleExtension, handleDisguiseMode, restoreDisguiseMode } from "./modules/extensionState.js";
import { encryptAndSaveKey } from "./modules/crypto.js";
import { getUsageStats, getRecentHistory, clearUsageData, getStorageInfo, trimHistory, updateStorageBadge } from "./modules/usageTracker.js";
import { migrateProviderConfig, getProviderState, saveProviderKey, clearProviderKey, setModelVision, addCustomModel, saveRoles, saveProfile, getProviderKey } from "./modules/llm/profiles.js";
import { fetchModels } from "./modules/llm/catalog.js";
import { getPreset } from "./modules/llm/registry.js";

// ============================================
// Message Handler
// ============================================

async function handleMessage(
  message: ExtensionMessage,
  _sender: chrome.runtime.MessageSender
): Promise<MessageResponse | AnalysisResponse> {
  switch (message.type) {
    case "TOGGLE_EXTENSION":
      return handleToggleExtension(message.active ?? false);

    case "TEST_API_KEY":
      return testApiKey(message.apiKey ?? "");

    case "TEST_DEEPSEEK_API_KEY":
      return testDeepSeekApiKey(message.apiKey ?? "");

    case "TEST_PROVIDER_KEY":
      return testProviderKey(message.provider ?? "anthropic", message.apiKey ?? "");

    case "ANALYZE_QUESTION":
      return analyzeQuestion(message.context!);

    case "CANCEL_DEEPSEEK":
      if (activeDeepSeekController) {
        log("[Study Assist] Cancelling DeepSeek...");
        activeDeepSeekController.abort();
        setActiveDeepSeekController(null);
        return { success: true, cancelled: true };
      }
      return { success: true, cancelled: false };

    case "TOGGLE_DISGUISE_MODE":
      return handleDisguiseMode(message.enabled ?? false);

    case "ENCRYPT_AND_SAVE_KEY":
      try {
        const storageKey = message.keyType === "deepseek" ? "deepseekApiKey" : "claudeApiKey";
        await encryptAndSaveKey(storageKey, message.rawKey ?? "");
        return { success: true };
      } catch (error) {
        return { success: false, error: (error as Error).message };
      }

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
        const state = await getProviderState();
        return { success: true, state } as MessageResponse & { state: unknown };
      } catch (error) {
        return { success: false, error: (error as Error).message };
      }

    case "SAVE_PROVIDER_KEY":
      try {
        const provider = message.provider ?? "";
        const rawKey = message.rawKey ?? "";
        if (!provider || !rawKey) return { success: false, error: "Missing provider or key." };

        if (message.test) {
          const result = await testProviderKey(provider, rawKey);
          if (!result.success) return result;
          await saveProviderKey(provider, rawKey);
          return result;
        }

        await saveProviderKey(provider, rawKey);
        return { success: true };
      } catch (error) {
        return { success: false, error: (error as Error).message };
      }

    case "DELETE_PROVIDER_KEY":
      try {
        await clearProviderKey(message.provider ?? "");
        return { success: true };
      } catch (error) {
        return { success: false, error: (error as Error).message };
      }

    case "SET_PROVIDER_THINKING":
      try {
        await saveProfile(message.provider ?? "", { thinking: message.thinking === true });
        return { success: true };
      } catch (error) {
        return { success: false, error: (error as Error).message };
      }

    case "SET_MODEL_VISION":
      try {
        await setModelVision(message.provider ?? "", message.model ?? "", message.vision === true);
        return { success: true };
      } catch (error) {
        return { success: false, error: (error as Error).message };
      }

    case "ADD_PROVIDER_MODEL":
      try {
        await addCustomModel(message.provider ?? "", message.model ?? "");
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

    case "FETCH_PROVIDER_MODELS":
      try {
        const provider = message.provider ?? "";
        const preset = getPreset(provider);
        const apiKey = message.rawKey || (await getProviderKey(provider));
        if (!apiKey) return { success: false, error: "No API key for provider." };

        const result = await fetchModels(preset, apiKey);
        if (result.success) {
          await saveProfile(provider, {
            models: result.models.map((m) => m.id),
            lastSync: Date.now(),
          });
        }
        return { success: result.success, models: result.models, error: result.error } as MessageResponse & { models: unknown };
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
      deepseekModel: "deepseek-v4-flash",
      deepseekThinking: true,
      theme: "system",
      buttonPosition: "bottom-right",
      errorLog: "",
    });
    await chrome.action.setBadgeText({ text: "" });
  }
  await restoreDisguiseMode();
  await updateStorageBadge();
  try {
    await migrateProviderConfig();
  } catch (error) {
    console.error("[Study Assist] Provider migration error:", error);
  }
});

chrome.runtime.onStartup.addListener(async () => {
  try {
    await migrateProviderConfig();
  } catch (error) {
    console.error("[Study Assist] Provider migration error:", error);
  }
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
