import type { AnalysisContext } from "../../types/index.js";
import { isPublicImageUrl } from "../../shared/imageUrls.js";

export const CONTENT_SETTINGS = ["allowedDomains", "responseMode", "autoDetect", "highlightQuestions", "quickMode", "sendImages", "buttonPosition", "saButtonHidden"];
export const qaTabs = new Set<number>();

export function assertSafeProviderUrl(value: string): void {
  const url = new URL(value);
  const loopback = ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname);
  if (url.username || url.password || url.search || url.hash ||
      (url.protocol !== "https:" && !(url.protocol === "http:" && loopback))) {
    throw new Error("Provider URLs require HTTPS (HTTP is allowed only on loopback), without credentials, query or fragment.");
  }
}

export function isExtensionPage(sender: chrome.runtime.MessageSender): boolean {
  return sender.id === chrome.runtime.id && !!sender.url?.startsWith(chrome.runtime.getURL("popup/"));
}

export function senderKey(sender: chrome.runtime.MessageSender): string {
  return `${sender.tab?.id ?? "extension"}:${sender.frameId ?? 0}`;
}

export async function validateAnalysis(context: AnalysisContext, sender: chrome.runtime.MessageSender): Promise<void> {
  if (sender.id !== chrome.runtime.id || !sender.tab || !sender.url) throw new Error("Untrusted analysis sender");
  if (!context || typeof context.questionText !== "string" || !context.questionText.trim() ||
      context.questionText.length > 50000 || JSON.stringify(context).length > 12000000) throw new Error("Invalid or oversized analysis");
  if (!["multiple-choice", "true-false", "fill-blank", "matching", "short-answer", "numerical", "select-missing-words", "unknown"].includes(context.questionType) ||
      !["quick", "guided", "direct", "hints", "explanation"].includes(context.responseMode)) throw new Error("Invalid analysis mode");
  for (const items of [context.options, context.categories, context.matchingOptions]) {
    if (items !== undefined && (!Array.isArray(items) || items.length > 200 || items.some(item => !item || typeof item.text !== "string" || item.text.length > 10000))) throw new Error("Invalid question options");
  }
  if (typeof context.pageTitle !== "string" || context.pageTitle.length > 2000 || (context.courseName !== undefined && (typeof context.courseName !== "string" || context.courseName.length > 2000))) throw new Error("Invalid page metadata");
  const url = new URL(sender.url);
  if (context.images !== undefined && (!Array.isArray(context.images) || context.images.length > 10)) throw new Error("Invalid images");
  for (const image of context.images ?? []) {
    if (!image || (image.url ? !isPublicImageUrl(image.url) :
        typeof image.base64 !== "string" || !/^[A-Za-z0-9+/]*={0,2}$/.test(image.base64) ||
        !["image/png", "image/jpeg", "image/gif", "image/webp"].includes(image.mediaType))) throw new Error("Unsafe image source");
  }
  if (!["https:", "http:"].includes(url.protocol)) throw new Error("Unsupported page URL");
  const { allowedDomains = [] } = await chrome.storage.local.get("allowedDomains");
  const qaAllowed = context.qaMode === true && qaTabs.has(sender.tab.id!) && url.origin === "https://example.com";
  if (!qaAllowed && (!Array.isArray(allowedDomains) || !allowedDomains.some(domain => typeof domain === "string" &&
      (url.hostname === domain || url.hostname.endsWith("." + domain))))) throw new Error("Domain not allowed");
  context.qaMode = qaAllowed;
  // Page metadata is not authority: bind routing to the actual sending frame.
  context.pageUrl = sender.url;
}

/** Traces never keep prompts, responses, headers, URLs or arbitrary error text. */
export function diagnosticMetadata(value: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(Object.entries(value).filter(([key, val]) =>
    ["timestamp", "type", "status", "hasImages", "errorKind"].includes(key) &&
    ["string", "number", "boolean"].includes(typeof val)).map(([key, val]) =>
      [key, typeof val === "string" ? val.slice(0, 100) : val]));
}
