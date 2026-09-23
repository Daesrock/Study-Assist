/**
 * Shared output-token budget policy for non-streaming and streaming calls.
 *
 * Reasoning tokens and visible answer tokens share a provider's output budget,
 * so a fixed 2K/8K/16K cap could end before the model emitted ANSWER. The
 * budget now follows the model's own `max_output_tokens` (LiteLLM), capped by
 * a safety ceiling so a huge catalog value never requests an unbounded budget.
 */

import { resolveModelInfo } from "./pricing.js";

/** Upper bound for any requested output budget. */
export const OUTPUT_BUDGET_CEILING = 65536;
/** Conservative fallback when LiteLLM has no `maxOutput` for the model. */
export const DEFAULT_OUTPUT_BUDGET = 16384;
export const REASONING_OUTPUT_BUDGET = 32768;

/**
 * Pick a safe requested budget.
 *
 * A known model limit always wins (capped by the ceiling); unknown models fall
 * back to the reasoning-aware defaults. `reasoningEnabled` only affects the
 * fallback, since reasoning tokens consume budget whenever the model can reason.
 */
export function computeOutputBudget(
  modelMaxOutput: number | undefined,
  reasoningEnabled: boolean,
): number {
  if (
    typeof modelMaxOutput === "number" &&
    Number.isFinite(modelMaxOutput) &&
    modelMaxOutput > 0
  ) {
    return Math.min(Math.floor(modelMaxOutput), OUTPUT_BUDGET_CEILING);
  }
  return reasoningEnabled ? REASONING_OUTPUT_BUDGET : DEFAULT_OUTPUT_BUDGET;
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
