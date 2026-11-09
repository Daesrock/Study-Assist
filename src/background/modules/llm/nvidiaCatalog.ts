import { llmRequest } from "./transport.js";
import { comparableModelId } from "./modelIdentity.js";

export const NVIDIA_CATALOG_ORIGIN = "https://api.ngc.nvidia.com/*";
const CATALOG_URL = "https://api.ngc.nvidia.com/v2/search/catalog/resources/ENDPOINT";
const STORAGE_KEY = "nvidiaFreeEndpointCatalog";

interface FreeEndpoint {
  publisher: string;
  name: string;
  /** Only explicit image-input labels establish vision; absence is unknown. */
  vision?: true;
}

export interface NvidiaCatalog {
  entries: FreeEndpoint[];
  fetchedAt: number | null;
  refreshFailed: boolean;
}

export interface NvidiaModelStatus {
  freeEndpoints: Record<string, true | null>;
  fetchedAt: number | null;
  refreshFailed: boolean;
}

function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

/** Reads only; the saved classification has no expiry or automatic refresh. */
export async function getNvidiaCatalog(): Promise<NvidiaCatalog> {
  const saved = (await chrome.storage.local.get(STORAGE_KEY))[STORAGE_KEY];
  if (!record(saved) || !Array.isArray(saved.entries)) {
    return { entries: [], fetchedAt: null, refreshFailed: false };
  }
  return {
    entries: saved.entries.filter((entry): entry is FreeEndpoint =>
      record(entry) && typeof entry.publisher === "string" && typeof entry.name === "string"),
    fetchedAt: typeof saved.fetchedAt === "number" ? saved.fetchedAt : null,
    refreshFailed: saved.refreshFailed === true,
  };
}

function matchingEntry(catalog: NvidiaCatalog, model: string, models: string[] = [model]): FreeEndpoint | undefined {
  const key = comparableModelId(model);
  const exact = catalog.entries.filter(entry => `${entry.publisher}/${entry.name}` === model);
  const matches = exact.length ? exact : catalog.entries.filter(entry =>
    comparableModelId(`${entry.publisher}/${entry.name}`) === key);
  // Distinct catalog identities collapsing to the same comparison key are ambiguous.
  const identities = new Set(matches.map(entry => `${entry.publisher}/${entry.name}`));
  const uniqueModel = new Set(models.filter(id => comparableModelId(id) === key)).size === 1;
  return identities.size === 1 && (exact.length > 0 || uniqueModel) ? matches[0] : undefined;
}

/** NVIDIA's own image-input evidence takes precedence over other hosts' metadata. */
export function lookupNvidiaCatalogVision(catalog: NvidiaCatalog, model: string): true | null {
  return matchingEntry(catalog, model)?.vision === true ? true : null;
}

export function classifyNvidiaModels(catalog: NvidiaCatalog, models: string[]): NvidiaModelStatus {
  const freeEndpoints: Record<string, true | null> = Object.create(null);
  for (const model of models) freeEndpoints[model] = matchingEntry(catalog, model, models) ? true : null;
  return { freeEndpoints, fetchedAt: catalog.fetchedAt, refreshFailed: catalog.refreshFailed };
}

let pending: Promise<boolean> | null = null;

async function refresh(): Promise<boolean> {
  try {
    if (!await chrome.permissions.contains({ origins: [NVIDIA_CATALOG_ORIGIN] })) {
      throw new Error("NVIDIA catalog permission not granted");
    }
    const entries: FreeEndpoint[] = [];
    let pages = 1;
    for (let page = 0; page < pages; page++) {
      const response = await llmRequest({
        url: CATALOG_URL,
        query: { q: JSON.stringify({ filters: [{ field: "label", value: "nim_type_preview" }], page, pageSize: 100, query: "*" }) },
        init: { method: "GET" },
        retries: 0,
        timeout: 15000,
      });
      if (!response.ok) throw new Error(`Catalog HTTP ${response.status}`);
      const json: unknown = await response.json();
      if (!record(json) || !Array.isArray(json.results) || !Number.isInteger(json.resultPageTotal) ||
          (json.resultPageTotal as number) < 0 || (json.resultPageTotal as number) > 100) {
        throw new Error("Invalid NVIDIA catalog");
      }
      pages = json.resultPageTotal as number;
      const group = json.results.find(item => record(item) && item.groupValue === "ENDPOINT");
      if (!record(group) || !Array.isArray(group.resources)) throw new Error("Missing NVIDIA catalog resources");
      for (const resource of group.resources) {
        if (!record(resource) || typeof resource.name !== "string" || !Array.isArray(resource.labels)) {
          throw new Error("Invalid NVIDIA catalog resource");
        }
        const labels = resource.labels.filter(record);
        const free = labels.some(label => Array.isArray(label.unresolvedValues) && label.unresolvedValues.includes("nim_type_preview"));
        const publisher = labels.find(label => label.key === "publisher");
        const publishers = publisher?.values;
        if (!free || !Array.isArray(publishers) || publishers.length !== 1 || typeof publishers[0] !== "string") continue;
        const imageInput = labels.filter(label => label.key === "general").some(label =>
          [...(Array.isArray(label.values) ? label.values : []), ...(Array.isArray(label.unresolvedValues) ? label.unresolvedValues : [])]
            .some(value => typeof value === "string" && /^(image[-_\s]to[-_\s]text|vision[-_\s]language[-_\s]model)$/i.test(value.trim())));
        entries.push({ publisher: publishers[0], name: resource.name, ...(imageInput ? { vision: true as const } : {}) });
      }
    }
    const unique = [...new Map(entries.map(entry => [`${entry.publisher}/${entry.name}`, entry])).values()];
    await chrome.storage.local.set({ [STORAGE_KEY]: { entries: unique, fetchedAt: Date.now(), refreshFailed: false } });
    return true;
  } catch {
    try {
      const previous = await getNvidiaCatalog();
      await chrome.storage.local.set({ [STORAGE_KEY]: { ...previous, refreshFailed: true } });
    } catch { /* Storage failure must not turn /models detection into a failure. */ }
    return false;
  }
}

/** Called only by explicit model detection. No key or provider headers leave here. */
export function refreshNvidiaCatalog(): Promise<boolean> {
  if (!pending) pending = refresh().finally(() => { pending = null; });
  return pending;
}
