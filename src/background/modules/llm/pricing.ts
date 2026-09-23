/**
 * Model pricing & capability metadata
 *
 * Prices/vision/context come from LiteLLM's community-maintained
 * `model_prices_and_context_window.json`. We keep a trimmed snapshot bundled
 * in `data/model-prices.json` (offline default) and can refresh it live from
 * GitHub on demand. No AI is involved: it is a straight id → entry lookup.
 */

import type { ModelPriceInfo } from "../constants.js";
import { logProviders } from "../constants.js";
import { llmRequest } from "./transport.js";

export type PriceIndex = Record<string, ModelPriceInfo>;

const SNAPSHOT_FILE = "data/model-prices.json";
const STORAGE_KEY = "modelPrices";
const FETCHED_KEY = "modelPricesFetchedAt";

const SOURCE_URL =
  "https://raw.githubusercontent.com/BerriAI/litellm/main/model_prices_and_context_window.json";

/** Providers we care about. Entries from other back-ends are ignored. */
const WANTED_PROVIDERS = new Set(["anthropic", "openai", "deepseek"]);

/**
 * Live-refresh budget. Metadata drives pricing, vision and reasoning gates, so
 * callers wait at most this long before falling back to cached metadata.
 */
export const PRICE_REFRESH_TIMEOUT_MS = 15_000;

let cached: PriceIndex | null = null;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function toNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

/** Reduce a raw LiteLLM entry to the fields we need, or null if unusable. */
export function toPriceInfo(entry: unknown): ModelPriceInfo | null {
  if (!isRecord(entry)) return null;
  const provider = entry.litellm_provider;
  if (typeof provider !== "string" || !WANTED_PROVIDERS.has(provider)) return null;

  const input = toNumber(entry.input_cost_per_token);
  const output = toNumber(entry.output_cost_per_token);
  if (input === undefined && output === undefined) return null;

  const cacheRead = toNumber(entry.cache_read_input_token_cost);
  const cacheWrite = toNumber(entry.cache_creation_input_token_cost);

  const vision =
    entry.supports_vision === true
      ? true
      : entry.supports_vision === false
        ? false
        : null;

  const reasoning =
    entry.supports_reasoning === true
      ? true
      : entry.supports_reasoning === false
        ? false
        : null;

  const adaptive =
    entry.supports_adaptive_thinking === true
      ? true
      : entry.supports_adaptive_thinking === false
        ? false
        : null;

  return {
    inputPer1M: (input ?? 0) * 1_000_000,
    outputPer1M: (output ?? 0) * 1_000_000,
    cacheReadPer1M: cacheRead === undefined ? null : cacheRead * 1_000_000,
    cacheWritePer1M: cacheWrite === undefined ? null : cacheWrite * 1_000_000,
    vision,
    reasoning,
    adaptive,
    deprecationDate:
      typeof entry.deprecation_date === "string" ? entry.deprecation_date : null,
    maxInput: toNumber(entry.max_input_tokens),
    maxOutput: toNumber(entry.max_output_tokens),
    provider,
    mode: typeof entry.mode === "string" ? entry.mode : undefined,
  };
}

/** Token counts used to price a single request. */
export interface UsageTokens {
  inputTokens: number;
  outputTokens: number;
  cacheHitTokens?: number;
  cacheWriteTokens?: number;
}

/**
 * Cost in USD for a request given the model's price info.
 * `inputTokens` must already exclude cached reads/writes (non-cached input).
 */
export function computeUsageCost(info: ModelPriceInfo, usage: UsageTokens): number {
  const cacheHit = Math.max(usage.cacheHitTokens ?? 0, 0);
  const cacheWrite = Math.max(usage.cacheWriteTokens ?? 0, 0);
  const missInput = Math.max(usage.inputTokens, 0);
  const output = Math.max(usage.outputTokens, 0);

  const cacheReadRate = info.cacheReadPer1M ?? info.inputPer1M;
  const cacheWriteRate = info.cacheWritePer1M ?? info.inputPer1M;

  return (
    (missInput * info.inputPer1M +
      cacheHit * cacheReadRate +
      cacheWrite * cacheWriteRate +
      output * info.outputPer1M) /
    1_000_000
  );
}

/** Build a compact `{ modelId: ModelPriceInfo }` index from the raw JSON. */
export function buildPriceIndex(raw: unknown): PriceIndex {
  if (!isRecord(raw)) return {};
  const index: PriceIndex = {};
  for (const key of Object.keys(raw)) {
    const info = toPriceInfo(raw[key]);
    if (info) index[key] = info;
  }
  return index;
}

function normalizeModelId(id: string): string {
  return id
    .trim()
    .toLowerCase()
    .replace(/-v\d+(?::\d+)?$/, "")
    .replace(/-\d{8}$/, "");
}

/**
 * Look up a model by id inside the index.
 * Order: exact key → `provider/id` → normalized id (ignoring date suffixes).
 */
export function lookupModelInfo(
  index: PriceIndex,
  presetId: string,
  modelId: string,
): ModelPriceInfo | null {
  const id = modelId.trim();
  if (!id) return null;

  for (const candidate of [id, `${presetId}/${id}`]) {
    const hit = index[candidate];
    if (hit) return hit;
  }

  const norm = normalizeModelId(id);
  let fallback: ModelPriceInfo | null = null;
  for (const key of Object.keys(index)) {
    const entry = index[key];
    const leaf = key.includes("/") ? key.slice(key.lastIndexOf("/") + 1) : key;
    if (normalizeModelId(key) !== norm && normalizeModelId(leaf) !== norm) continue;
    if (!entry.provider || entry.provider === presetId) return entry;
    fallback = fallback ?? entry;
  }
  return fallback;
}

async function loadSnapshot(): Promise<PriceIndex> {
  try {
    if (typeof fetch !== "function") return {};
    const response = await fetch(chrome.runtime.getURL(SNAPSHOT_FILE));
    if (!response.ok) return {};
    const json = (await response.json()) as { models?: unknown };
    return isRecord(json?.models) ? (json.models as PriceIndex) : {};
  } catch (error) {
    logProviders("price snapshot load failed", (error as Error).message);
    return {};
  }
}

/** Current price index: storage cache → bundled snapshot → empty. */
export async function getPriceIndex(): Promise<PriceIndex> {
  if (cached) return cached;

  const stored = await chrome.storage.local.get([STORAGE_KEY]);
  const value = stored[STORAGE_KEY];
  if (isRecord(value)) {
    cached = value as PriceIndex;
    return cached;
  }

  cached = await loadSnapshot();
  return cached;
}

/** Resolve price/capability info for a single model (or null when unknown). */
export async function resolveModelInfo(
  presetId: string,
  modelId: string,
): Promise<ModelPriceInfo | null> {
  const index = await getPriceIndex();
  return lookupModelInfo(index, presetId, modelId);
}

/** Epoch ms of the last successful live refresh, or null. */
export async function getPriceFreshness(): Promise<number | null> {
  const stored = await chrome.storage.local.get([FETCHED_KEY]);
  const value = stored[FETCHED_KEY];
  return typeof value === "number" ? value : null;
}

export interface RefreshPricesResult {
  success: boolean;
  count: number;
  error?: string;
  fetchedAt?: number;
  /** True when a failed refresh still leaves usable (older) metadata in place. */
  stale?: boolean;
}

/**
 * True when a previous index is available, so a failed refresh can keep
 * serving it instead of leaving every model unpriced.
 */
async function hasUsableMetadata(): Promise<boolean> {
  if (cached && Object.keys(cached).length > 0) return true;
  try {
    const stored = await chrome.storage.local.get([STORAGE_KEY]);
    const value = stored[STORAGE_KEY];
    return isRecord(value) && Object.keys(value).length > 0;
  } catch {
    return false;
  }
}

function refreshFailure(error: string, stale: boolean): RefreshPricesResult {
  logProviders("price refresh failed", { error, stale });
  return { success: false, count: 0, error, stale };
}

async function runPriceRefresh(): Promise<RefreshPricesResult> {
  // Snapshot the "is there anything to fall back to?" answer before touching
  // storage: a failed write must not count as usable metadata.
  const stale = await hasUsableMetadata();

  try {
    const response = await llmRequest({
      url: SOURCE_URL,
      init: { method: "GET" },
      // A single attempt: metadata is a nice-to-have and retries would keep
      // the caller (setup/detection/test) waiting.
      retries: 0,
      timeout: PRICE_REFRESH_TIMEOUT_MS,
    });
    if (!response.ok) {
      return refreshFailure(`HTTP ${response.status}`, stale);
    }

    let raw: unknown;
    try {
      raw = await response.json();
    } catch (error) {
      return refreshFailure(`Invalid JSON (${(error as Error).message})`, stale);
    }

    const index = buildPriceIndex(raw);
    const count = Object.keys(index).length;
    if (count === 0) {
      return refreshFailure("Empty price index", stale);
    }

    const fetchedAt = Date.now();
    // Persist index + timestamp together first, then publish to memory: a
    // failed write must never leave the in-memory cache ahead of storage.
    await chrome.storage.local.set({ [STORAGE_KEY]: index, [FETCHED_KEY]: fetchedAt });
    cached = index;
    logProviders("prices refreshed", { count, fetchedAt });
    return { success: true, count, fetchedAt };
  } catch (error) {
    return refreshFailure((error as Error).message, stale);
  }
}

/** In-flight refresh shared by concurrent callers (one request at a time). */
let inFlight: Promise<RefreshPricesResult> | null = null;

/**
 * Fetch the live LiteLLM index, trim it and cache it in storage.
 *
 * Concurrent callers coalesce into a single request. Every failure path keeps
 * the previously stored metadata and releases the lock so a later caller can
 * retry; the caller decides how to surface `error`/`stale`.
 */
export function refreshPrices(): Promise<RefreshPricesResult> {
  if (!inFlight) {
    inFlight = runPriceRefresh().finally(() => {
      inFlight = null;
    });
  }
  return inFlight;
}

/** Test seam: inject a price index and skip storage/snapshot. */
export function __setPriceIndexForTests(index: PriceIndex | null): void {
  cached = index;
}
