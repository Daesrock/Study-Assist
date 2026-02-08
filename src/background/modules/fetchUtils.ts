/**
 * Background Service Worker - Fetch Utilities
 * Timeout, retry, and error logging helpers
 */

import type { FetchOptionsWithSignal, ErrorLogObject } from "./constants.js";

// ============================================
// Error Logging
// ============================================

export async function logError(logObj: ErrorLogObject): Promise<void> {
  try {
    const logText = `[${new Date().toISOString()}] ${JSON.stringify(logObj, null, 2)}\n`;
    const { errorLog } = await chrome.storage.local.get("errorLog") as { errorLog?: string };
    const newLog = (errorLog || "") + logText;
    await chrome.storage.local.set({ errorLog: newLog });
  } catch (_e) {
    // Silent fail
  }
}

// ============================================
// Fetch with Timeout
// ============================================

export function fetchWithTimeout(
  url: string,
  options: FetchOptionsWithSignal,
  timeout: number = 30000
): Promise<Response> {
  const timeoutController = new AbortController();
  const timeoutId = setTimeout(() => timeoutController.abort(), timeout);

  let combinedSignal: AbortSignal = timeoutController.signal;
  const externalSignal = options.signal;

  if (externalSignal) {
    const combinedController = new AbortController();

    if (externalSignal.aborted) {
      combinedController.abort();
    } else {
      externalSignal.addEventListener("abort", () => combinedController.abort());
    }

    timeoutController.signal.addEventListener("abort", () => combinedController.abort());
    combinedSignal = combinedController.signal;
  }

  const { signal: _, ...optionsWithoutSignal } = options;

  return fetch(url, {
    ...optionsWithoutSignal,
    signal: combinedSignal,
  }).finally(() => clearTimeout(timeoutId));
}

// ============================================
// Fetch with Retry
// ============================================

export async function fetchWithRetry(
  url: string,
  options: FetchOptionsWithSignal,
  maxRetries: number = 2,
  timeout: number = 30000
): Promise<Response> {
  let lastError: Error | undefined;

  for (let attempt = 1; attempt <= maxRetries + 1; attempt++) {
    try {
      return await fetchWithTimeout(url, options, timeout);
    } catch (error) {
      lastError = error as Error;
      if ((error as Error).name === "AbortError") {
        console.warn(`[Study Assist] Request timeout (attempt ${attempt}/${maxRetries + 1})`);
      } else {
        console.warn(`[Study Assist] Request failed (attempt ${attempt}/${maxRetries + 1}):`, (error as Error).message);
      }

      if (attempt <= maxRetries) {
        await new Promise((r) => setTimeout(r, 1000 * attempt));
      }
    }
  }

  throw lastError;
}
