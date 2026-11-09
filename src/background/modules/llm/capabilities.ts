import type { ModelCapabilities } from "../constants.js";
import { comparableModelId, comparablePublisher } from "./modelIdentity.js";

export type CapabilityIndex = Record<string, ModelCapabilities>;

/** Retain portable capabilities from every backend, without their tariffs or limits. */
export function buildCapabilityIndex(raw: unknown): CapabilityIndex {
  const index: CapabilityIndex = Object.create(null);
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return index;
  for (const [id, entry] of Object.entries(raw)) {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) continue;
    const value = entry as Record<string, unknown>;
    const vision = typeof value.supports_vision === "boolean" ? value.supports_vision : null;
    const reasoning = typeof value.supports_reasoning === "boolean" ? value.supports_reasoning : null;
    if (vision !== null || reasoning !== null) index[id] = { vision, reasoning };
  }
  return index;
}

export function lookupNvidiaCapabilities(index: CapabilityIndex, model: string): ModelCapabilities | null {
  const exact = index[`nvidia_nim/${model}`];
  if (exact) return exact;
  const id = comparableModelId(model);
  const parts = id.split("/");
  if (parts.length !== 2) return null;
  const [publisher, leaf] = parts;
  const native: ModelCapabilities[] = [];
  const qualified: ModelCapabilities[] = [];
  const unqualified: ModelCapabilities[] = [];
  for (const [key, value] of Object.entries(index)) {
    const path = comparableModelId(key).split("/");
    if (path[path.length - 1] !== leaf) continue;
    if (path.length >= 3) {
      if (comparablePublisher(path[path.length - 2]) === comparablePublisher(publisher)) qualified.push(value);
    } else if (path.length === 2 && comparablePublisher(path[0]) === comparablePublisher(publisher)) {
      native.push(value);
    } else {
      unqualified.push(value);
    }
  }
  if (!native.length && !qualified.length && !unqualified.length) return null;
  const agreed = (field: "vision" | "reasoning"): boolean | null => {
    // The manufacturer's explicit metadata wins over third-party deployments.
    // Unknown fields can fall back, but contradictions at one level stay unknown.
    for (const matches of [native, qualified, unqualified]) {
      const values = new Set(matches.map(value => value[field]).filter(value => typeof value === "boolean"));
      if (values.size > 0) return values.size === 1 ? [...values][0] as boolean : null;
    }
    return null;
  };
  return { vision: agreed("vision"), reasoning: agreed("reasoning") };
}
