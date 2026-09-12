/**
 * Auto-selection of models for the popup role selectors.
 *
 * Hybrid heuristic (no AI): among the chat-capable, non-deprecated models,
 * pick the N most recent, always include the cheapest (cost anchor) and any
 * model already assigned to a role. Providers without creation timestamps
 * (DeepSeek) fall back to a capability score.
 */

import type { ModelPriceInfo } from "../constants.js";

export interface SelectionCandidate {
  id: string;
  /** Creation time in epoch ms, when the provider reports it. */
  created?: number;
  /** LiteLLM price/capability metadata, when known. */
  info?: ModelPriceInfo | null;
}

export interface AutoSelectionOptions {
  /** How many "recent/best" models to include. Default 4. */
  count?: number;
  /** Epoch ms used for deprecation checks (test seam). */
  now?: number;
}

export const DEFAULT_AUTO_SELECTION_COUNT = 4;

/** Service/tool models that must never be offered for question analysis. */
const NON_CHAT_PATTERN =
  /embed|tts|whisper|moderation|dall-e|audio|realtime|transcribe|image|rerank|sora/i;

function isDeprecated(info: ModelPriceInfo | null | undefined, now: number): boolean {
  if (!info?.deprecationDate) return false;
  const t = Date.parse(info.deprecationDate);
  return Number.isFinite(t) && t < now;
}

/** Eligible = chat-capable and not deprecated. */
export function isEligible(candidate: SelectionCandidate, now = Date.now()): boolean {
  if (NON_CHAT_PATTERN.test(candidate.id)) return false;
  const info = candidate.info;
  if (!info) return true;
  if (info.mode && info.mode !== "chat") return false;
  return !isDeprecated(info, now);
}

function capabilityScore(info: ModelPriceInfo | null | undefined): number {
  if (!info) return 0;
  let score = 0;
  if (info.reasoning) score += 3;
  if (info.vision) score += 1;
  score += Math.min((info.maxInput ?? 0) / 200_000, 2);
  return score;
}

function totalCost(info: ModelPriceInfo | null | undefined): number | null {
  if (!info) return null;
  return (info.inputPer1M ?? 0) + (info.outputPer1M ?? 0);
}

/**
 * Return the selected model ids, in priority order. The result is always a
 * subset of the input candidates.
 */
export function computeAutoSelection(
  candidates: SelectionCandidate[],
  options: AutoSelectionOptions = {},
): string[] {
  const count = options.count ?? DEFAULT_AUTO_SELECTION_COUNT;
  const now = options.now ?? Date.now();

  const eligible = candidates.filter((c) => isEligible(c, now));
  if (eligible.length === 0) return [];

  const ranked = [...eligible].sort((a, b) => {
    const createdA = a.created ?? -Infinity;
    const createdB = b.created ?? -Infinity;
    if (createdB !== createdA) return createdB - createdA;
    return capabilityScore(b.info) - capabilityScore(a.info);
  });

  const selected: string[] = [];
  const add = (id: string) => {
    if (!selected.includes(id)) selected.push(id);
  };

  for (const candidate of ranked.slice(0, Math.max(count, 1))) add(candidate.id);

  const priced = eligible
    .map((c) => ({ id: c.id, cost: totalCost(c.info) }))
    .filter((x): x is { id: string; cost: number } => x.cost !== null);
  if (priced.length > 0) {
    const cheapest = priced.reduce((best, x) => (x.cost < best.cost ? x : best));
    add(cheapest.id);
  }

  return selected;
}
