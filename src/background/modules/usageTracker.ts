/**
 * Background Service Worker - Usage Tracking
 * Tracks API usage, tokens, costs, and provides statistics
 */

import { log } from "./constants.js";

// ============================================
// Pricing (per million tokens, USD)
// ============================================
interface ModelPricing {
  input: number;       // cache miss input
  inputCacheHit: number;
  output: number;
}

const PRICING: Record<string, ModelPricing> = {
  // Claude Haiku
  "claude-haiku-4-5-20251001": { input: 1.0, inputCacheHit: 0.10, output: 5.0 },

  // Claude Sonnet
  "claude-sonnet-4-6": { input: 3.0, inputCacheHit: 0.30, output: 15.0 },

  // Claude Opus
  "claude-opus-4-6": { input: 5.0, inputCacheHit: 0.50, output: 25.0 },

  // DeepSeek V4 Flash
  "deepseek-v4-flash": { input: 0.14, inputCacheHit: 0.0028, output: 0.28 },

  // DeepSeek V4 Pro (with discount auto-expiry)
  "deepseek-v4-pro": { input: 0.435, inputCacheHit: 0.003625, output: 0.87 },
};

/**
 * Get effective pricing for a model, applying time-limited discounts.
 * DeepSeek V4 Pro has a 75% discount until 2026-05-31.
 */
function getEffectivePricing(model: string): ModelPricing {
  const p = PRICING[model];
  if (!p) return { input: 1.0, inputCacheHit: 1.0, output: 5.0 };

  // No discount for non-pro models
  if (model !== "deepseek-v4-pro") return p;

  // Discount expires 2026-05-31 (after that, full price applies)
  const DISCOUNT_END = new Date("2026-06-01T00:00:00Z").getTime();
  const now = Date.now();
  if (now < DISCOUNT_END) return p; // Discount still active

  // Full price after discount ends
  return { input: 1.74, inputCacheHit: 0.0145, output: 3.48 };
}

// ============================================
// Types
// ============================================

export interface UsageRecord {
  id: string;
  timestamp: number;
  questionText: string;
  questionType: string;
  answer?: string;
  source: "deepseek" | "claude" | "question-bank";
  model: string;
  inputTokens: number;
  outputTokens: number;
  cacheHitTokens?: number;
  costUsd: number;
  responseMode: string;
  success: boolean;
  latencyMs: number;
  platform?: string;
  // Routing metadata (v2)
  validated?: boolean;
  fallbackReason?: string;
  trigger?: string;
  confidence?: string;
  deepseekReasoning?: string;
  deepseekThinkingEnabled?: boolean;
  claudeCorrection?: string;
  claudeThinking?: string;
  bankConflictDetected?: boolean;
  bankConflictType?: "semantic-equivalent" | "real-conflict";
  bankConflictAnswerSimilarity?: number;
  bankSecondaryModel?: string;
}

export interface UsageStats {
  totalRequests: number;
  totalInputTokens: number;
  totalOutputTokens: number;
  totalCostUsd: number;
  questionsAnswered: number;
  successRate: number;
  avgLatencyMs: number;
  bySource: Record<string, number>;
  byModel: Record<string, number>;
  byDay: Record<string, { requests: number; cost: number; tokens: number }>;
  byPlatform: Record<string, number>;
  todayRequests: number;
  todayCost: number;
  todayTokens: number;
  // Per-AI breakdowns
  deepseek: AiStats;
  claude: AiStats;
}

export interface AiStats {
  totalRequests: number;
  totalInputTokens: number;
  totalOutputTokens: number;
  totalCostUsd: number;
  todayRequests: number;
  todayInputTokens: number;
  todayOutputTokens: number;
  todayCostUsd: number;
}

// ============================================
// Constants
// ============================================

const MAX_RECORDS = 500;
const STORAGE_KEY = "usageRecords";

// ============================================
// Cost Calculation
// ============================================

export function calculateCost(model: string, inputTokens: number, outputTokens: number, cacheHitTokens?: number): number {
  const pricing = getEffectivePricing(model);
  const cacheMissTokens = inputTokens - (cacheHitTokens ?? 0);
  const cacheHitCost = (Math.max(cacheHitTokens ?? 0, 0) * pricing.inputCacheHit) / 1_000_000;
  const cacheMissCost = (Math.max(cacheMissTokens, 0) * pricing.input) / 1_000_000;
  const outputCost = (outputTokens * pricing.output) / 1_000_000;
  return cacheHitCost + cacheMissCost + outputCost;
}

// ============================================
// Track Usage
// ============================================

export async function trackUsage(
  record: Omit<UsageRecord, "id" | "costUsd">,
): Promise<UsageRecord> {
  const cost = calculateCost(record.model, record.inputTokens, record.outputTokens, record.cacheHitTokens);
  const fullRecord: UsageRecord = {
    ...record,
    id: `${Date.now()}-${Math.random().toString(36).substr(2, 9)}`,
    costUsd: cost,
  };

  try {
    const result = await chrome.storage.local.get([STORAGE_KEY]);
    const records: UsageRecord[] = result[STORAGE_KEY] || [];

    records.push(fullRecord);

    // Keep only last MAX_RECORDS
    if (records.length > MAX_RECORDS) {
      records.splice(0, records.length - MAX_RECORDS);
    }

    await chrome.storage.local.set({ [STORAGE_KEY]: records });

    // Also save as lastAiResponse for the inspector
    await chrome.storage.local.set({ lastAiResponse: fullRecord });

    // Update storage badge asynchronously (non-blocking)
    updateStorageBadge().catch(() => {});

    log(
      "[Study Assist] Usage tracked:",
      fullRecord.source,
      fullRecord.model,
      `$${cost.toFixed(6)}`,
      `${fullRecord.inputTokens}+${fullRecord.outputTokens} tokens`,
    );
  } catch (error) {
    console.error("[Study Assist] Error tracking usage:", error);
  }

  return fullRecord;
}

// ============================================
// Retrieve Records & Stats
// ============================================

export async function getUsageRecords(): Promise<UsageRecord[]> {
  const result = await chrome.storage.local.get([STORAGE_KEY]);
  return result[STORAGE_KEY] || [];
}

export async function getUsageStats(): Promise<UsageStats> {
  const records = await getUsageRecords();
  const today = new Date().toISOString().split("T")[0];

  const emptyAi = (): AiStats => ({
    totalRequests: 0, totalInputTokens: 0, totalOutputTokens: 0, totalCostUsd: 0,
    todayRequests: 0, todayInputTokens: 0, todayOutputTokens: 0, todayCostUsd: 0,
  });

  const stats: UsageStats = {
    totalRequests: records.length,
    totalInputTokens: 0,
    totalOutputTokens: 0,
    totalCostUsd: 0,
    questionsAnswered: 0,
    successRate: 0,
    avgLatencyMs: 0,
    bySource: {},
    byModel: {},
    byDay: {},
    byPlatform: {},
    todayRequests: 0,
    todayCost: 0,
    todayTokens: 0,
    deepseek: emptyAi(),
    claude: emptyAi(),
  };

  let totalLatency = 0;
  let successCount = 0;

  for (const r of records) {
    stats.totalInputTokens += r.inputTokens;
    stats.totalOutputTokens += r.outputTokens;
    stats.totalCostUsd += r.costUsd;

    if (r.success) {
      successCount++;
      stats.questionsAnswered++;
    }
    totalLatency += r.latencyMs;

    stats.bySource[r.source] = (stats.bySource[r.source] || 0) + 1;
    stats.byModel[r.model] = (stats.byModel[r.model] || 0) + 1;

    const plat = r.platform || "other";
    stats.byPlatform[plat] = (stats.byPlatform[plat] || 0) + 1;

    const day = new Date(r.timestamp).toISOString().split("T")[0];
    if (!stats.byDay[day]) stats.byDay[day] = { requests: 0, cost: 0, tokens: 0 };
    stats.byDay[day].requests++;
    stats.byDay[day].cost += r.costUsd;
    stats.byDay[day].tokens += r.inputTokens + r.outputTokens;

    const isToday = day === today;

    if (isToday) {
      stats.todayRequests++;
      stats.todayCost += r.costUsd;
      stats.todayTokens += r.inputTokens + r.outputTokens;
    }

    // Per-AI accumulation
    const ai = r.source === "deepseek" ? stats.deepseek
      : r.source === "claude" ? stats.claude : null;
    if (ai) {
      ai.totalRequests++;
      ai.totalInputTokens += r.inputTokens;
      ai.totalOutputTokens += r.outputTokens;
      ai.totalCostUsd += r.costUsd;
      if (isToday) {
        ai.todayRequests++;
        ai.todayInputTokens += r.inputTokens;
        ai.todayOutputTokens += r.outputTokens;
        ai.todayCostUsd += r.costUsd;
      }
    }
  }

  stats.successRate = records.length > 0 ? (successCount / records.length) * 100 : 0;
  stats.avgLatencyMs = records.length > 0 ? totalLatency / records.length : 0;

  return stats;
}

export async function getRecentHistory(limit: number = 20): Promise<UsageRecord[]> {
  const records = await getUsageRecords();
  return records.slice(-limit).reverse();
}

export async function clearUsageData(): Promise<void> {
  await chrome.storage.local.set({ [STORAGE_KEY]: [] });
  await chrome.storage.local.remove(["lastAiResponse"]);
  await updateStorageBadge();
}

// ============================================
// Storage Limit Management
// ============================================

const STORAGE_LIMIT_BYTES = 5 * 1024 * 1024; // 5 MB
const STORAGE_WARN_THRESHOLD = 0.70;          // 70% → warning badge
const STORAGE_CRIT_THRESHOLD = 0.90;          // 90% → critical badge

export interface StorageInfo {
  bytesUsed: number;
  bytesTotal: number;
  percent: number;
  level: "ok" | "warning" | "critical";
}

export async function getStorageInfo(): Promise<StorageInfo> {
  const bytesUsed = await chrome.storage.local.getBytesInUse(null);
  const percent = bytesUsed / STORAGE_LIMIT_BYTES;
  const level: StorageInfo["level"] =
    percent >= STORAGE_CRIT_THRESHOLD ? "critical"
    : percent >= STORAGE_WARN_THRESHOLD ? "warning"
    : "ok";
  return { bytesUsed, bytesTotal: STORAGE_LIMIT_BYTES, percent, level };
}

export async function updateStorageBadge(): Promise<void> {
  try {
    const info = await getStorageInfo();
    if (info.level === "critical") {
      await chrome.action.setBadgeText({ text: "!" });
      await chrome.action.setBadgeBackgroundColor({ color: "#e53935" });
    } else if (info.level === "warning") {
      await chrome.action.setBadgeText({ text: "!" });
      await chrome.action.setBadgeBackgroundColor({ color: "#FF9800" });
    } else {
      await chrome.action.setBadgeText({ text: "" });
    }
  } catch (_) {
    // Badge update failed silently (e.g. service worker context issue)
  }
}

export async function trimHistory(options: { keepLast?: number; keepDays?: number }): Promise<number> {
  const result = await chrome.storage.local.get([STORAGE_KEY]);
  const records: UsageRecord[] = result[STORAGE_KEY] || [];
  const originalLength = records.length;

  let filtered = [...records];

  if (options.keepDays !== undefined) {
    const cutoff = Date.now() - options.keepDays * 24 * 60 * 60 * 1000;
    filtered = filtered.filter(r => r.timestamp >= cutoff);
  }

  if (options.keepLast !== undefined && filtered.length > options.keepLast) {
    // records are oldest-first; keep the last N (most recent)
    filtered = filtered.slice(filtered.length - options.keepLast);
  }

  await chrome.storage.local.set({ [STORAGE_KEY]: filtered });
  await updateStorageBadge();
  return originalLength - filtered.length;
}
