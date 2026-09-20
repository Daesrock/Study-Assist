/**
 * Shared output-token budget policy for non-streaming and streaming calls.
 *
 * Reasoning tokens and visible answer tokens share a provider's output budget,
 * so the old 2K quick-path limit could end before the model emitted ANSWER.
 */

import { resolveModelInfo } from "./pricing.js";

export const DEFAULT_OUTPUT_BUDGET = 8192;
export const REASONING_OUTPUT_BUDGET = 16384;

/** Pick a safe requested budget, respecting known model limits. */
export function computeOutputBudget(
  modelMaxOutput: number | undefined,
  reasoningEnabled: boolean,
): number {
  const desired = reasoningEnabled ? REASONING_OUTPUT_BUDGET : DEFAULT_OUTPUT_BUDGET;
  if (typeof modelMaxOutput !== "number" || !Number.isFinite(modelMaxOutput) || modelMaxOutput <= 0) {
    return desired;
  }
  return Math.min(desired, Math.floor(modelMaxOutput));
}

/** Resolve a model-aware budget from the cached LiteLLM capability index. */
export async function resolveOutputBudget(
  providerId: string,
  model: string,
  reasoningEnabled: boolean,
): Promise<number> {
  const info = await resolveModelInfo(providerId, model);
  return computeOutputBudget(info?.maxOutput, reasoningEnabled);
}
