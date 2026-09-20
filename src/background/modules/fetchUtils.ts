/**
 * Background Service Worker - Fetch Utilities
 * Timeout, retry, and error logging helpers
 */

import type { FetchOptionsWithSignal, ErrorLogObject } from "./constants.js";
import { diagnosticMetadata } from "./security.js";
let logChain: Promise<void> = Promise.resolve();

// ============================================
// Error Logging
// ============================================

export async function logError(logObj: ErrorLogObject): Promise<void> {
  const run = logChain.then(async () => {
    const { debugMode } = await chrome.storage.local.get("debugMode");
    if (debugMode !== true) return;
    const logText = `[${new Date().toISOString()}] ${JSON.stringify(diagnosticMetadata({ ...logObj }))}\n`;
    const { errorLog } = await chrome.storage.local.get("errorLog") as { errorLog?: string };
    const newLog = ((errorLog || "") + logText).slice(-64000);
    await chrome.storage.local.set({ errorLog: newLog });
  });
  logChain = run.catch(() => {});
  await logChain;
}

// ============================================
// Fetch with Timeout
// ============================================

export async function fetchWithTimeout(
  url: string,
  options: FetchOptionsWithSignal,
  timeout: number = 30000,
  fetchFn: typeof fetch = fetch
): Promise<Response> {
  const timeoutController = new AbortController();
  const timeoutId = setTimeout(() => timeoutController.abort(), timeout);
  let abortExternal: (() => void) | undefined;
  const cleanup = () => {
    clearTimeout(timeoutId);
    if (abortExternal) options.signal?.removeEventListener("abort", abortExternal);
  };

  let combinedSignal: AbortSignal = timeoutController.signal;
  const externalSignal = options.signal;

  if (externalSignal) {
    const combinedController = new AbortController();

    if (externalSignal.aborted) {
      combinedController.abort();
    } else {
      abortExternal = () => combinedController.abort();
      externalSignal.addEventListener("abort", abortExternal, { once: true });
    }

    timeoutController.signal.addEventListener("abort", () => combinedController.abort());
    combinedSignal = combinedController.signal;
  }

  const { signal: _, ...optionsWithoutSignal } = options;

  try {
  const response = await fetchFn(url, {
    ...optionsWithoutSignal,
    signal: combinedSignal,
  });
  if (!response.body) { cleanup(); return response; }
  const reader = response.body.getReader();
  let received = 0;
  const body = new ReadableStream<Uint8Array>({
    async pull(controller) {
      try {
        if (combinedSignal.aborted) throw new DOMException("Request aborted", "AbortError");
        const { done, value } = await reader.read();
        if (done) { cleanup(); reader.releaseLock(); controller.close(); return; }
        received += value.byteLength;
        if (received > 16 * 1024 * 1024) throw new Error("Provider response exceeds 16 MiB");
        controller.enqueue(value);
      } catch (error) { cleanup(); await reader.cancel().catch(() => {}); controller.error(error); }
    },
    async cancel() { cleanup(); await reader.cancel().catch(() => {}); },
  });
  return new Response(body, { status: response.status, statusText: response.statusText, headers: response.headers });
  } catch (error) { cleanup(); throw error; }
}

// ============================================
// Fetch with Retry
// ============================================

export async function fetchWithRetry(
  url: string,
  options: FetchOptionsWithSignal,
  maxRetries: number = 2,
  timeout: number = 30000,
  fetchFn: typeof fetch = fetch
): Promise<Response> {
  let lastError: Error | undefined;

  for (let attempt = 1; attempt <= maxRetries + 1; attempt++) {
    if (options.signal?.aborted) throw new DOMException("Analysis cancelled", "AbortError");
    try {
      return await fetchWithTimeout(url, options, timeout, fetchFn);
    } catch (error) {
      if (options.signal?.aborted) throw error;
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
