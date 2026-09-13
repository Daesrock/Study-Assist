/**
 * Background Service Worker - Usage Tracking
 * Tracks API usage, tokens, costs, and provides statistics
 */

import { log } from "./constants.js";
import { findPreset, ensureRegistry, resolvePresetForModel } from "./llm/registry.js";
import { resolveModelInfo, computeUsageCost } from "./llm/pricing.js";

// ============================================
// Cost Calculation (LiteLLM-driven)
// ============================================

/** Map a legacy usage `source` to a provider preset id. */
function providerFromSource(source: string): string | undefined {
  if (source === "claude") return "anthropic";
  if (source === "deepseek") return "deepseek";
  if (source === "openai") return "openai";
  return undefined;
}

export interface UsageTokensInput {
  inputTokens: number;
  outputTokens: number;
  cacheHitTokens?: number;
  cacheWriteTokens?: number;
}

/**
 * Cost in USD for a request, or null when the model has no LiteLLM price data
 * (in which case no cost is recorded). Anthropic reports non-cached input
 * separately; OpenAI-compatible providers include cached tokens in `inputTokens`.
 */
export async function estimateCost(
  providerId: string | undefined,
  model: string,
  usage: UsageTokensInput,
): Promise<number | null> {
  if (!providerId) return null;
  await ensureRegistry();
  const info = await resolveModelInfo(providerId, model);
  if (!info) return null;

  const excludesCache = resolvePresetForModel(providerId, model)?.dialect === "anthropic";
  const cacheHit = usage.cacheHitTokens ?? 0;
  const missInput = excludesCache
    ? usage.inputTokens
    : Math.max(usage.inputTokens - cacheHit, 0);

  return computeUsageCost(info, { ...usage, inputTokens: missInput });
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
  source: "deepseek" | "claude" | "openai" | "question-bank";
  /** Preset id of the provider that produced the answer (Step B). */
  provider?: string;
  /** Pipeline role that produced the answer (Step B). */
  role?: "primary" | "validator";
  model: string;
  inputTokens: number;
  outputTokens: number;
  cacheHitTokens?: number;
  cacheWriteTokens?: number;
  /** USD cost. Omitted when the model has no LiteLLM price data. */
  costUsd?: number;
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
  thinkingEnabled?: boolean;
  claudeCorrection?: string;
  reasoningText?: string;
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
  /** Per-provider breakdown keyed by preset id (falls back to `source`). */
  byProvider: Record<string, AiStats>;
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
// Track Usage
// ============================================

export async function trackUsage(
  record: Omit<UsageRecord, "id" | "costUsd">,
): Promise<UsageRecord> {
  const providerId = record.provider ?? providerFromSource(record.source);
  const cost = await estimateCost(providerId, record.model, {
    inputTokens: record.inputTokens,
    outputTokens: record.outputTokens,
    cacheHitTokens: record.cacheHitTokens,
    cacheWriteTokens: record.cacheWriteTokens,
  });
  const fullRecord: UsageRecord = {
    ...record,
    id: `${Date.now()}-${Math.random().toString(36).substr(2, 9)}`,
    ...(cost === null ? {} : { costUsd: cost }),
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
      cost === null ? "(no price data)" : `$${cost.toFixed(6)}`,
      `${fullRecord.inputTokens}+${fullRecord.outputTokens} tokens`,
      fullRecord.deepseekReasoning
        ? `reasoning:${fullRecord.deepseekReasoning.length}`
        : "reasoning:none",
      fullRecord.reasoningText ? `thinking:${fullRecord.reasoningText.length}` : "thinking:none",
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
    byProvider: {},
  };

  let totalLatency = 0;
  let successCount = 0;

  for (const r of records) {
    stats.totalInputTokens += r.inputTokens;
    stats.totalOutputTokens += r.outputTokens;
    stats.totalCostUsd += r.costUsd ?? 0;

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
    stats.byDay[day].cost += r.costUsd ?? 0;
    stats.byDay[day].tokens += r.inputTokens + r.outputTokens;

    const isToday = day === today;

    if (isToday) {
      stats.todayRequests++;
      stats.todayCost += r.costUsd ?? 0;
      stats.todayTokens += r.inputTokens + r.outputTokens;
    }

    // Per-AI accumulation
    const ai = r.source === "deepseek" ? stats.deepseek
      : r.source === "claude" ? stats.claude : null;
    if (ai) {
      ai.totalRequests++;
      ai.totalInputTokens += r.inputTokens;
      ai.totalOutputTokens += r.outputTokens;
      ai.totalCostUsd += r.costUsd ?? 0;
      if (isToday) {
        ai.todayRequests++;
        ai.todayInputTokens += r.inputTokens;
        ai.todayOutputTokens += r.outputTokens;
        ai.todayCostUsd += r.costUsd ?? 0;
      }
    }

    // Per-provider accumulation (excludes the local question bank)
    if (r.source !== "question-bank") {
      const providerId = r.provider ?? r.source;
      const provider = stats.byProvider[providerId] ?? (stats.byProvider[providerId] = emptyAi());
      provider.totalRequests++;
      provider.totalInputTokens += r.inputTokens;
      provider.totalOutputTokens += r.outputTokens;
      provider.totalCostUsd += r.costUsd ?? 0;
      if (isToday) {
        provider.todayRequests++;
        provider.todayInputTokens += r.inputTokens;
        provider.todayOutputTokens += r.outputTokens;
        provider.todayCostUsd += r.costUsd ?? 0;
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
