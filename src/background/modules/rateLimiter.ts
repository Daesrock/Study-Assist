/**
 * Background Service Worker - Smart Rate Limiting
 * Prevents abuse without blocking normal usage patterns
 *
 * Philosophy: Don't penalise a user who clicks quickly between different questions.
 * Only kick in when the same question is re-sent repeatedly, or overall volume is
 * unreasonably high.
 */

import { log } from "./constants.js";

// ============================================
// Internal State
// ============================================

interface RateLimitState {
  /** question hash → array of request timestamps */
  questionRequests: Record<string, number[]>;
  /** global request timestamps */
  globalRequests: number[];
  /** cooldown-until timestamp (0 = no cooldown) */
  cooldownUntil: number;
}

const state: RateLimitState = {
  questionRequests: {},
  globalRequests: [],
  cooldownUntil: 0,
};

// ============================================
// Configuration
// ============================================

/** Max times the *same* question can be asked within the window */
const SAME_QUESTION_MAX = 3;
/** Window for same-question tracking (2 minutes) */
const SAME_QUESTION_WINDOW_MS = 120_000;

/** Max total requests in the global window */
const GLOBAL_MAX = 15;
/** Global window (1 minute) */
const GLOBAL_WINDOW_MS = 60_000;

/** How long the cooldown lasts once triggered */
const COOLDOWN_DURATION_MS = 30_000;

// ============================================
// Helpers
// ============================================

function hashQuestion(text: string): string {
  const normalised = text
    .toLowerCase()
    .trim()
    .replace(/\s+/g, " ")
    .substring(0, 200);
  let hash = 0;
  for (let i = 0; i < normalised.length; i++) {
    hash = (hash << 5) - hash + normalised.charCodeAt(i);
    hash = hash & hash; // 32-bit int
  }
  return hash.toString(36);
}

function pruneOld(timestamps: number[], windowMs: number): number[] {
  const cutoff = Date.now() - windowMs;
  return timestamps.filter((t) => t > cutoff);
}

// ============================================
// Public API
// ============================================

/**
 * Check whether a request should be rate-limited.
 * @returns `null` if OK, or an error string if blocked.
 */
export function checkRateLimit(questionText: string): string | null {
  const now = Date.now();

  // Active cooldown?
  if (state.cooldownUntil > now) {
    const sec = Math.ceil((state.cooldownUntil - now) / 1000);
    log(`[Study Assist] Rate limit: cooldown, ${sec}s left`);
    return `⏳ Rate limited. Please wait ${sec} seconds.`;
  }

  const qHash = hashQuestion(questionText);

  // Prune stale entries
  state.globalRequests = pruneOld(state.globalRequests, GLOBAL_WINDOW_MS);
  if (state.questionRequests[qHash]) {
    state.questionRequests[qHash] = pruneOld(state.questionRequests[qHash], SAME_QUESTION_WINDOW_MS);
  }

  // Same-question check
  const qCount = state.questionRequests[qHash]?.length ?? 0;
  if (qCount >= SAME_QUESTION_MAX) {
    state.cooldownUntil = now + COOLDOWN_DURATION_MS;
    log(`[Study Assist] Rate limit: same question ×${qCount}`);
    return `⏳ You've asked this question ${qCount} times. Wait 30 s.`;
  }

  // Global volume check
  if (state.globalRequests.length >= GLOBAL_MAX) {
    state.cooldownUntil = now + COOLDOWN_DURATION_MS;
    log(`[Study Assist] Rate limit: ${state.globalRequests.length} reqs / min`);
    return `⏳ Too many requests. Wait 30 s.`;
  }

  return null; // OK
}

/**
 * Record that a request was actually sent (call after `checkRateLimit` returns null).
 */
export function recordRequest(questionText: string): void {
  const now = Date.now();
  const qHash = hashQuestion(questionText);

  if (!state.questionRequests[qHash]) {
    state.questionRequests[qHash] = [];
  }
  state.questionRequests[qHash].push(now);
  state.globalRequests.push(now);
}

/**
 * Hard-reset (mostly useful for testing).
 */
export function resetRateLimit(): void {
  state.questionRequests = {};
  state.globalRequests = [];
  state.cooldownUntil = 0;
}
