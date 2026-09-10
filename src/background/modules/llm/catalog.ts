/**
 * Provider model catalog
 *
 * Fetches the live model list from a provider's `/models` endpoint.
 * The popup's "Detect models" button calls this; the three-layer merge
 * (baseline + detected + user selection) lives in the popup layer.
 */

import { ANTHROPIC_VERSION } from "../constants.js";
import type { ProviderPreset } from "./contract.js";
import { llmRequest } from "./transport.js";

export interface CatalogModel {
  id: string;
  name?: string;
}

export interface CatalogResult {
  success: boolean;
  models: CatalogModel[];
  error?: string;
}

function stripTrailingSlashes(url: string): string {
  return url.replace(/\/+$/, "");
}

/**
 * List the models available to the user's key for a given preset.
 * Never throws; failures are returned as `{ success: false, error }`.
 */
export async function fetchModels(
  preset: ProviderPreset,
  apiKey: string,
  signal?: AbortSignal,
): Promise<CatalogResult> {
  const base = stripTrailingSlashes(preset.baseUrl);

  try {
    if (preset.dialect === "anthropic") {
      const response = await llmRequest({
        url: `${base}/v1/models`,
        init: {
          method: "GET",
          headers: {
            "x-api-key": apiKey,
            "anthropic-version": ANTHROPIC_VERSION,
            "anthropic-dangerous-direct-browser-access": "true",
          },
          signal,
        },
        retries: 1,
        timeout: 30000,
      });
      if (!response.ok) {
        return { success: false, models: [], error: `Anthropic /models ${response.status}` };
      }
      const json = (await response.json()) as {
        data?: Array<{ id: string; display_name?: string }>;
      };
      return {
        success: true,
        models: (json.data ?? []).map((model) => ({
          id: model.id,
          name: model.display_name,
        })),
      };
    }

    // OpenAI-compatible dialect
    const response = await llmRequest({
      url: `${base}/models`,
      init: {
        method: "GET",
        headers: { Authorization: `Bearer ${apiKey}` },
        signal,
      },
      retries: 1,
      timeout: 30000,
    });
    if (!response.ok) {
      return { success: false, models: [], error: `${preset.label} /models ${response.status}` };
    }
    const json = (await response.json()) as {
      data?: Array<{ id: string; name?: string }>;
    };
    return {
      success: true,
      models: (json.data ?? []).map((model) => ({ id: model.id, name: model.name })),
    };
  } catch (error) {
    return { success: false, models: [], error: (error as Error).message };
  }
}
