/**
 * Study Assist - Background Service Worker (Entry Point)
 * Routes messages and manages lifecycle events
 */

import { log, activeDeepSeekController, setActiveDeepSeekController } from "./modules/constants.js";
import type { ExtensionMessage, MessageResponse } from "./modules/constants.js";
import type { AnalysisResponse } from "../types/index.js";
import { analyzeQuestion, analyzeQuestionStreaming, testApiKey, testDeepSeekApiKey } from "./modules/api.js";
import { handleToggleExtension, handleDisguiseMode, restoreDisguiseMode } from "./modules/extensionState.js";
import { encryptAndSaveKey } from "./modules/crypto.js";
import { getUsageStats, getRecentHistory, clearUsageData } from "./modules/usageTracker.js";

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
// Port-based Streaming (full mode only)
// ============================================

chrome.runtime.onConnect.addListener((port) => {
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
      theme: "system",
      buttonPosition: "bottom-right",
      errorLog: "",
    });
    await chrome.action.setBadgeText({ text: "" });
  }
  await restoreDisguiseMode();
});

chrome.runtime.onStartup.addListener(async () => {
  await restoreDisguiseMode();
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
