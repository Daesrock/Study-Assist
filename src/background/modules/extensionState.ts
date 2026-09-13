/**
 * Background Service Worker - Extension State Management
 * Handles disguise mode and lifecycle events
 */

import { log } from "./constants.js";
import type { MessageResponse } from "./constants.js";

// ============================================
// Disguise Mode (uBlock Origin)
// ============================================

export async function handleDisguiseMode(enabled: boolean): Promise<MessageResponse> {
  log("[Study Assist] handleDisguiseMode called with:", enabled);
  try {
    if (enabled) {
      log("[Study Assist] Setting uBlock icon...");
      await chrome.action.setIcon({
        path: {
          16: chrome.runtime.getURL("icons/ublock/icon_16.png"),
          32: chrome.runtime.getURL("icons/ublock/icon_32.png"),
          48: chrome.runtime.getURL("icons/ublock/icon_64.png"),
          128: chrome.runtime.getURL("icons/ublock/icon_128.png"),
        },
      });
      log("[Study Assist] Setting uBlock title...");
      await chrome.action.setTitle({ title: "uBlock Origin" });
      await chrome.action.setBadgeText({ text: "" });
      log("[Study Assist] Disguise mode enabled (uBlock Origin)");
    } else {
      log("[Study Assist] Restoring original icon...");
      await chrome.action.setIcon({
        path: {
          16: chrome.runtime.getURL("icons/icon16.png"),
          32: chrome.runtime.getURL("icons/icon32.png"),
          48: chrome.runtime.getURL("icons/icon48.png"),
          128: chrome.runtime.getURL("icons/icon128.png"),
        },
      });
      log("[Study Assist] Restoring original title...");
      await chrome.action.setTitle({ title: "Study Assist" });
      await chrome.action.setBadgeText({ text: "" });

      log("[Study Assist] Disguise mode disabled");
    }
    return { success: true };
  } catch (error) {
    console.error("[Study Assist] Disguise mode error:", error);
    return { success: false, error: (error as Error).message };
  }
}

// ============================================
// Restore Disguise Mode
// ============================================

export async function restoreDisguiseMode(): Promise<void> {
  try {
    const { disguiseMode } = await chrome.storage.local.get("disguiseMode") as { disguiseMode?: boolean };
    if (disguiseMode) {
      await handleDisguiseMode(true);
    }
  } catch (error) {
    console.error("[Study Assist] Error restoring disguise mode:", error);
  }
}
