/**
 * Background Service Worker - Usage Tracking
 * Tracks API usage, tokens, costs, and provides statistics
 */

import { log } from "./constants.js";

// ============================================
// Pricing (per million tokens, USD)
// ============================================
const PRICING: Record<string, { input: number; output: number }> = {
  // Claude Haiku
  "claude-3-haiku-20240307": { input: 0.25, output: 1.25 },
  "claude-3-5-haiku-20241022": { input: 1.0, output: 5.0 },

  // Claude Sonnet
  "claude-sonnet-4-20250514": { input: 3.0, output: 15.0 },
  "claude-sonnet-4-5-20250929": { input: 3.0, output: 15.0 },

  // Claude Opus
  "claude-opus-4-5-20251101": { input: 15.0, output: 75.0 },

  // DeepSeek (thinking)
  "deepseek-reasoner": { input: 0.28, output: 0.42 },
};

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
  claudeCorrection?: string;
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

export function calculateCost(model: string, inputTokens: number, outputTokens: number): number {
  const pricing = PRICING[model] || { input: 1.0, output: 5.0 };
  return (inputTokens * pricing.input) / 1_000_000 + (outputTokens * pricing.output) / 1_000_000;
}

// ============================================
// Track Usage
// ============================================

export async function trackUsage(
  record: Omit<UsageRecord, "id" | "costUsd">,
): Promise<UsageRecord> {
  const cost = calculateCost(record.model, record.inputTokens, record.outputTokens);
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
}
