/**
 * Study Assist - Background Service Worker (Entry Point)
 * Routes messages and manages lifecycle events
 */

import { log, logProviders, setDebugMode } from "./modules/constants.js";
import { devLog, DEV_LOGGING } from "./modules/logger.js";
import type { ExtensionMessage, MessageResponse } from "./modules/constants.js";
import type { AnalysisResponse } from "../types/index.js";
import { analyzeQuestion, analyzeQuestionStreaming, testProviderKey, testProviderConnection } from "./modules/api.js";
import { handleDisguiseMode, restoreDisguiseMode } from "./modules/extensionState.js";
import { getUsageStats, getRecentHistory, clearUsageData, getStorageInfo, trimHistory, updateStorageBadge, redactHistory } from "./modules/usageTracker.js";
import { getProviderState, saveProviderKey, clearProviderKey, setModelVision, setModelSelected, setModelEndpoint, setSelectionMode, addCustomModel, saveRoles, saveProfile, getProviderKey, applyDetectedModels, saveQaModel, saveCustomProvider, deleteCustomProvider } from "./modules/llm/profiles.js";
import { fetchModels } from "./modules/llm/catalog.js";
import { getPreset, ensureRegistry, resetRegistry } from "./modules/llm/registry.js";
import { getPriceIndex, lookupModelInfo, refreshPrices } from "./modules/llm/pricing.js";
import { CONTENT_SETTINGS, isExtensionPage, senderKey, validateAnalysis, qaTabs } from "./modules/security.js";
import { AnalysisSession } from "./modules/analysisSession.js";

const storageReady = chrome.storage.local.setAccessLevel({ accessLevel: "TRUSTED_CONTEXTS" }).then(async () => {
  const { securitySchema, providerProfiles } = await chrome.storage.local.get(["securitySchema", "providerProfiles"]);
  if (securitySchema !== 2) {
    await redactHistory();
    await chrome.storage.local.set({ debugMode: false });
    for (const id of Object.keys(providerProfiles ?? {})) {
      try { await getProviderKey(id); } catch { /* Invalid credentials remain for explicit user replacement. */ }
    }
    await chrome.storage.local.set({ securitySchema: 2 });
  }
});
const sessions = new Map<string, AnalysisSession>();

function newSession(sender: chrome.runtime.MessageSender): AnalysisSession {
  const key = senderKey(sender);
  sessions.get(key)?.cancel();
  const session = new AnalysisSession();
  sessions.set(key, session);
  return session;
}

function releaseSession(sender: chrome.runtime.MessageSender, session: AnalysisSession): void {
  if (sessions.get(senderKey(sender)) === session) sessions.delete(senderKey(sender));
}

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
  sender: chrome.runtime.MessageSender
): Promise<MessageResponse | AnalysisResponse> {
  await storageReady;
  if (!message || typeof message.type !== "string" || sender.id !== chrome.runtime.id) throw new Error("Invalid message sender");
  if (message.type !== "ANALYZE_QUESTION" && JSON.stringify(message).length > 65536) throw new Error("Oversized message");
  if (!isExtensionPage(sender) && !["ANALYZE_QUESTION", "CANCEL_ANALYSIS", "GET_CONTENT_SETTINGS", "SET_CONTENT_PREFERENCE"].includes(message.type)) {
    throw new Error("This operation requires an extension page");
  }
  await ensureRegistry();
  switch (message.type) {
    case "REGISTER_QA_TAB": {
      const tab = await chrome.tabs.get(message.tabId!);
      if (new URL(tab.url ?? "").origin !== "https://example.com") throw new Error("Invalid QA tab");
      qaTabs.add(tab.id!);
      return { success: true };
    }
    case "GET_CONTENT_SETTINGS":
      return { success: true, settings: await chrome.storage.local.get(CONTENT_SETTINGS) } as MessageResponse;
    case "SET_CONTENT_PREFERENCE":
      await chrome.storage.local.set({ saButtonHidden: message.enabled === true });
      return { success: true };
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

    case "ANALYZE_QUESTION": {
      await validateAnalysis(message.context!, sender);
      const session = newSession(sender);
      try { return await analyzeQuestion(message.context!, undefined, session); }
      finally { releaseSession(sender, session); }
    }

    case "CANCEL_ANALYSIS":
      if (sessions.has(senderKey(sender))) {
        const session = sessions.get(senderKey(sender))!;
        if (message.skipPrimary) session.skip(); else session.cancel();
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

    case "REDACT_HISTORY":
      await redactHistory();
      return { success: true };

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
  if (!port.sender || port.sender.id !== chrome.runtime.id) { port.disconnect(); return; }
  let active: AnalysisSession | undefined;
  let used = false;
  let disconnected = false;
  port.onDisconnect.addListener(() => {
    disconnected = true;
    active?.cancel();
    if (active) releaseSession(port.sender!, active);
  });
  if (port.name === "quick-analysis") {
    port.onMessage.addListener(async (msg: { context: import("../types/index.js").AnalysisContext }) => {
      if (used) return;
      used = true;
      try {
        await storageReady;
        await validateAnalysis(msg.context, port.sender!);
        if (disconnected) return;
        active = newSession(port.sender!);
        const result = await analyzeQuestion(msg.context, (status: string) => {
          try { port.postMessage({ type: "STATUS", status }); } catch { /* port disconnected */ }
        }, active);
        try { port.postMessage({ type: "RESULT", result }); } catch { /* port disconnected */ }
      } catch (error) {
        try {
          port.postMessage({ type: "STATUS", status: "ERROR" });
          port.postMessage({ type: "RESULT", result: { success: false, error: (error as Error).message } });
        } catch {
          // Port may have been disconnected
        }
      } finally { if (active) releaseSession(port.sender!, active); }
    });
    return;
  }

  if (port.name !== "stream-analysis") return;

  port.onMessage.addListener(async (msg: { context: import("../types/index.js").AnalysisContext }) => {
    if (used) return;
    used = true;
    try {
      await storageReady;
      await validateAnalysis(msg.context, port.sender!);
      if (disconnected) return;
      active = newSession(port.sender!);
      await analyzeQuestionStreaming(msg.context, port, active);
    } catch (error) {
      try {
        port.postMessage({ type: "STREAM_ERROR", error: (error as Error).message });
      } catch {
        // Port may have been disconnected
      }
    } finally { if (active) releaseSession(port.sender!, active); }
  });
});

// ============================================
// Lifecycle Events
// ============================================

chrome.runtime.onInstalled.addListener(async (details: chrome.runtime.InstalledDetails) => {
  if (details.reason === "install") {
    await chrome.storage.local.set({
      responseMode: "direct",
      autoDetect: true,
      highlightQuestions: true,
      quickMode: true,
      sendImages: false,
      disguiseMode: false,
      saButtonHidden: false,
      buttonPosition: "bottom-right",
      errorLog: "",
    });
    await chrome.action.setBadgeText({ text: "" });
  } else {
    // The global on/off switch was removed; clean up its storage key.
    await chrome.storage.local.remove(["extensionActive"]).catch(() => {});
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
    if (changeInfo.status === "loading" || changeInfo.url) qaTabs.delete(tabId);
    if (changeInfo.status === "complete") {
      chrome.tabs.sendMessage(tabId, { type: "PAGE_LOADED", url: tab.url }).catch(() => {});
    }
  }
);

// ============================================
// Global debug flag
// ============================================

async function loadDebugMode(): Promise<void> {
  try {
    await storageReady;
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
    if ("allowedDomains" in changes) {
      for (const session of sessions.values()) session.cancel();
      chrome.tabs.query({}).then(tabs => {
        for (const tab of tabs) if (tab.id !== undefined) chrome.tabs.sendMessage(tab.id, { type: "DOMAIN_SETTINGS_CHANGED" }).catch(() => {});
      }).catch(() => {});
    }
  });
}
