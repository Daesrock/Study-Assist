/**
 * Provider profiles & role assignments
 *
 * Provider credentials live in `providerProfiles` (keyed by preset id) and the
 * pipeline roles in `roles`. There is no legacy migration: the UI is the only
 * writer of provider credentials.
 */

import type {
  ProviderProfile,
  ProviderRoles,
  RoleAssignment,
  ModelPriceInfo,
} from "../constants.js";
import { logProviders } from "../constants.js";
import { encryptApiKey, decryptApiKey } from "../crypto.js";
import type { ProviderPreset, ProviderEndpoint, CustomProviderConfig } from "./contract.js";
import { findPreset, listPresets, listTemplates, ensureRegistry, resetRegistry, resolvePresetForModel, resolveEndpointId } from "./registry.js";
import { getPriceIndex, lookupModelInfo, resolveModelInfo } from "./pricing.js";
import { computeAutoSelection } from "./selection.js";
import { assertSafeProviderUrl } from "../security.js";
import { sealHeaders } from "./headerSecrets.js";
import type { SelectionCandidate } from "./selection.js";

const PROFILES_KEY = "providerProfiles";
const ROLES_KEY = "roles";
const QA_MODEL_KEY = "qaModel";

export const DEFAULT_ROLES: ProviderRoles = { primary: null, validator: null };

/** True when the value is a non-null, non-array plain object. */
function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

// ============================================
// Profiles
// ============================================

export async function getProviderProfiles(): Promise<Record<string, ProviderProfile>> {
  const result = await chrome.storage.local.get([PROFILES_KEY]);
  const value = result[PROFILES_KEY];
  if (value === undefined || value === null) return {};

  // Guard against corrupted/legacy shapes (e.g. an Array from an older build).
  // A non-object value can never hold a key, and writing named props onto an
  // Array is silently dropped by structured serialization — reset it to {}.
  if (!isPlainObject(value)) {
    logProviders("providerProfiles has an invalid shape; treating as empty", {
      type: Array.isArray(value) ? "array" : typeof value,
    });
    return {};
  }
  return value as Record<string, ProviderProfile>;
}

export async function getProfile(presetId: string): Promise<ProviderProfile | null> {
  const profiles = await getProviderProfiles();
  return profiles[presetId] ?? null;
}

// Serialize profile writes so concurrent patches never clobber each other and
// so a corrupted (non-object) store is always replaced by a real object.
let profileWriteChain: Promise<void> = Promise.resolve();

export async function saveProfile(
  presetId: string,
  patch: Partial<ProviderProfile>,
): Promise<void> {
  if (!/^[a-z0-9][a-z0-9_-]{0,100}$/i.test(presetId) || ["__proto__", "constructor", "prototype"].includes(presetId)) throw new Error("Invalid provider id");
  const run = profileWriteChain.then(async () => {
    const profiles = await getProviderProfiles();
    profiles[presetId] = { ...(profiles[presetId] ?? {}), ...patch };
    await chrome.storage.local.set({ [PROFILES_KEY]: profiles });
  });
  profileWriteChain = run.catch(() => {});
  return run;
}

/**
 * Decrypted API key for a provider, or null.
 */
export async function getProviderKey(presetId: string): Promise<string | null> {
  const profile = await getProfile(presetId);
  const stored = profile?.apiKey;
  if (!stored) return null;
  const key = await decryptApiKey(stored);
  if (!stored.startsWith("v2:")) await saveProviderKey(presetId, key);
  return key;
}

export async function saveProviderKey(presetId: string, plainKey: string): Promise<void> {
  const encrypted = await encryptApiKey(plainKey);
  await saveProfile(presetId, { apiKey: encrypted });
}

// ============================================
// Roles
// ============================================

export async function getRoles(): Promise<ProviderRoles> {
  const result = await chrome.storage.local.get([ROLES_KEY]);
  return (result[ROLES_KEY] as ProviderRoles) ?? { ...DEFAULT_ROLES };
}

export async function saveRoles(roles: ProviderRoles): Promise<void> {
  await chrome.storage.local.set({ [ROLES_KEY]: roles });
}

export interface ResolvedRole {
  preset: ProviderPreset;
  model: string;
  apiKey: string;
  thinking: boolean;
  vision: boolean;
  /** Whether the model itself supports reasoning/effort parameters. */
  reasoning: boolean;
  /** Whether the model supports Anthropic adaptive thinking. */
  adaptiveThinking: boolean;
}

/**
 * Whether a provider can handle a question's features (images / matching).
 * Matching is a provider-level capability; images depend on the model's vision.
 */
export function canPresetHandle(
  preset: ProviderPreset,
  hasImages: boolean,
  isMatching: boolean,
): boolean {
  if (hasImages && !preset.capabilities.images) return false;
  if (isMatching && !preset.capabilities.matching) return false;
  return true;
}

/** Role-aware capability check (uses the resolved model's vision). */
export function canRoleHandle(
  role: ResolvedRole,
  hasImages: boolean,
  isMatching: boolean,
): boolean {
  if (hasImages && !role.vision) return false;
  if (isMatching && !role.preset.capabilities.matching) return false;
  return true;
}

/**
 * Resolve a role assignment into a usable provider (preset + model + key).
 * Returns null when the role is unset, the preset is unknown, or the
 * provider has no API key configured.
 */
export async function resolveRole(
  role: RoleAssignment | null | undefined,
): Promise<ResolvedRole | null> {
  if (!role) return null;
  await ensureRegistry();
  // Models come exclusively from the provider catalog (or user input); there
  // is no shipped fallback. An unassigned model makes the role unusable.
  const model = role.model?.trim();
  if (!model) return null;

  // Resolve the endpoint for this model (a gateway may expose several).
  const preset = resolvePresetForModel(role.provider, model);
  if (!preset) return null;

  const apiKey = await getProviderKey(role.provider);
  if (!apiKey) return null;

  const profile = await getProfile(role.provider);
  const thinking = profile?.thinking ?? preset.defaultThinking;
  const visionModels = profile?.visionModels ?? [];
  const vision = visionModels.includes(model);
  const info = await resolveModelInfo(role.provider, model);
  // If LiteLLM doesn't know the model (custom providers), trust the user's
  // thinking toggle; only block when LiteLLM explicitly says it can't reason.
  const reasoning = info ? info.reasoning === true : true;
  const adaptiveThinking = info?.adaptive === true;

  if (thinking) {
    logProviders("role thinking resolved", {
      provider: role.provider,
      model,
      knownToLitellm: !!info,
      litellmReasoning: info?.reasoning ?? null,
      reasoning,
    });
  }

  return { preset, model, apiKey, thinking, vision, reasoning, adaptiveThinking };
}

// ============================================
// Provider state (sanitized for the UI)
// ============================================

export interface PublicProviderProfile {
  id: string;
  hasKey: boolean;
  thinking: boolean;
  models: string[];
  customModels: string[];
  visionModels: string[];
  selectedModels: string[];
  selectionMode: "auto" | "manual";
  lastSync: number | null;
  /** LiteLLM price/capability info per visible model id (null when unknown). */
  modelInfo: Record<string, ModelPriceInfo | null>;
  /** Gateway endpoints (empty for single-endpoint providers). */
  endpoints: ProviderEndpoint[];
  /** Resolved endpoint id per visible model (for the UI tag/selector). */
  modelEndpoints: Record<string, string>;
}

export interface ProviderState {
  presets: ProviderPreset[];
  templates: ProviderPreset[];
  profiles: PublicProviderProfile[];
  roles: ProviderRoles;
}

/** State for the providers page / popup. Never includes API keys. */
export async function getProviderState(): Promise<ProviderState> {
  await ensureRegistry();
  const presets = listPresets();
  const stored = await getProviderProfiles();
  const index = await getPriceIndex();
  const profiles: PublicProviderProfile[] = presets.map((preset) => {
    const profile = stored[preset.id];
    const models = profile?.models ?? [];
    const customModels = profile?.customModels ?? [];
    const visible = [...new Set([...models, ...customModels])];
    const modelInfo: Record<string, ModelPriceInfo | null> = {};
    const modelEndpoints: Record<string, string> = {};
    for (const id of visible) {
      modelInfo[id] = lookupModelInfo(index, preset.id, id);
      const endpoint = resolveEndpointId(preset.id, id);
      if (endpoint) modelEndpoints[id] = endpoint;
    }
    return {
      id: preset.id,
      hasKey: !!profile?.apiKey,
      thinking: profile?.thinking ?? preset.defaultThinking,
      models,
      customModels,
      visionModels: profile?.visionModels ?? [],
      selectedModels:
        profile?.selectedModels ?? [...new Set([...models, ...customModels])],
      selectionMode: profile?.selectionMode ?? "auto",
      lastSync: profile?.lastSync ?? null,
      modelInfo,
      endpoints: (preset.endpoints ?? []).map(({ headers: _headers, ...endpoint }) => endpoint),
      modelEndpoints,
    };
  });
  return {
    presets: presets.map(({ headers: _headers, ...preset }) => ({ ...preset, endpoints: preset.endpoints?.map(({ headers: _headers, ...endpoint }) => endpoint) })),
    templates: listTemplates(),
    profiles,
    roles: await getRoles(),
  };
}

/** Remove a provider's API key (keeps models/vision metadata). */
export async function clearProviderKey(presetId: string): Promise<void> {
  const run = profileWriteChain.then(async () => {
  const profiles = await getProviderProfiles();
  if (!profiles[presetId]) return;
  delete profiles[presetId].apiKey;
  await chrome.storage.local.set({ [PROFILES_KEY]: profiles });
  });
  profileWriteChain = run.catch(() => {});
  return run;
}

/** Toggle whether a model accepts image input (records a manual override). */
export async function setModelVision(
  presetId: string,
  model: string,
  vision: boolean,
): Promise<void> {
  const profile = await getProfile(presetId);
  const overrides = { ...(profile?.visionOverrides ?? {}), [model]: vision };
  const current = new Set(profile?.visionModels ?? []);
  if (vision) current.add(model);
  else current.delete(model);
  await saveProfile(presetId, {
    visionOverrides: overrides,
    visionModels: [...current],
  });
}

/**
 * Store a fresh catalog sync. Vision is derived from LiteLLM `supports_vision`
 * (manual overrides always win). Selection is auto-curated with the hybrid
 * heuristic unless the user has switched this provider to manual mode, in
 * which case their list is preserved. Models assigned to a role are always
 * kept so a configured role never disappears.
 */
export async function applyDetectedModels(
  presetId: string,
  candidates: SelectionCandidate[],
): Promise<void> {
  const profile = await getProfile(presetId);
  const overrides = profile?.visionOverrides ?? {};
  const modelIds = candidates.map((c) => c.id);

  const visionModels = candidates
    .filter((c) => {
      const override = overrides[c.id];
      if (override !== undefined) return override;
      return c.info?.vision === true;
    })
    .map((c) => c.id);

  const mode = profile?.selectionMode ?? "auto";
  const custom = new Set(profile?.customModels ?? []);
  const present = new Set(modelIds);
  const previous = profile?.selectedModels ?? [];

  let selectedModels: string[];
  if (mode === "manual") {
    // Keep the user's list, restricted to models that still exist, plus custom.
    selectedModels = previous.filter(
      (id) => present.has(id) || custom.has(id),
    );
  } else {
    const customSelected = [...custom];
    selectedModels = [
      ...new Set([...computeAutoSelection(candidates), ...customSelected]),
    ];
  }

  // Never drop a model that a role is using.
  const roles = await getRoles();
  for (const role of [roles.primary, roles.validator]) {
    if (role && role.provider === presetId && role.model) {
      if (!selectedModels.includes(role.model)) selectedModels.push(role.model);
    }
  }

  await saveProfile(presetId, {
    models: modelIds,
    visionModels,
    selectedModels,
    lastSync: Date.now(),
  });
  logProviders("detected models stored", {
    provider: presetId,
    total: modelIds.length,
    vision: visionModels.length,
    selected: selectedModels.length,
    mode,
  });
}

/** Toggle whether a model is exposed in the popup role selectors. */
export async function setModelSelected(
  presetId: string,
  model: string,
  selected: boolean,
): Promise<void> {
  const profile = await getProfile(presetId);
  const current = new Set(
    profile?.selectedModels ??
      [...(profile?.models ?? []), ...(profile?.customModels ?? [])],
  );
  if (selected) current.add(model);
  else current.delete(model);
  // Any manual edit switches the provider to manual selection.
  await saveProfile(presetId, {
    selectedModels: [...current],
    selectionMode: "manual",
  });
}

/** Switch a provider between auto-curated and manual model selection. */
export async function setSelectionMode(
  presetId: string,
  mode: "auto" | "manual",
): Promise<void> {
  await saveProfile(presetId, { selectionMode: mode });
}

/** Add a manually-entered model id to a provider. */
export async function addCustomModel(presetId: string, model: string): Promise<void> {
  const trimmed = model.trim();
  if (!trimmed) return;
  const profile = await getProfile(presetId);
  const current = profile?.customModels ?? [];
  if (current.includes(trimmed)) return;
  const selected = new Set(
    profile?.selectedModels ??
      [...(profile?.models ?? []), ...(profile?.customModels ?? [])],
  );
  selected.add(trimmed);
  await saveProfile(presetId, {
    customModels: [...current, trimmed],
    selectedModels: [...selected],
  });
}

// ============================================
// QA model selection
// ============================================

/** Model used by the QA sandbox, or null to use the configured roles. */
export async function getQaModel(): Promise<RoleAssignment | null> {
  const result = await chrome.storage.local.get([QA_MODEL_KEY]);
  const value = result[QA_MODEL_KEY] as RoleAssignment | null | undefined;
  if (!value || !value.provider || !value.model) return null;
  return { provider: value.provider, model: value.model };
}

export async function saveQaModel(role: RoleAssignment | null): Promise<void> {
  await chrome.storage.local.set({ [QA_MODEL_KEY]: role });
}

/**
 * Effective QA model: the explicit user choice, otherwise the cheapest
 * selected model of the primary provider (falling back to any selected model,
 * then to the first available one).
 */
export async function resolveQaModel(): Promise<RoleAssignment | null> {
  const explicit = await getQaModel();
  if (explicit) return explicit;

  const state = await getProviderState();
  const candidates: Array<{ provider: string; model: string; cost: number | null }> = [];
  for (const profile of state.profiles) {
    // Only models the user selected in the Providers page are eligible.
    const ids = new Set(profile.selectedModels ?? []);
    for (const model of ids) {
      const info = profile.modelInfo?.[model] ?? null;
      const cost = info
        ? (info.inputPer1M ?? 0) + (info.outputPer1M ?? 0)
        : null;
      candidates.push({ provider: profile.id, model, cost });
    }
  }
  if (candidates.length === 0) return null;

  const primaryProvider = state.roles.primary?.provider;
  const preferred = primaryProvider
    ? candidates.filter((c) => c.provider === primaryProvider)
    : [];
  const pool = preferred.length ? preferred : candidates;

  const priced = pool.filter((c) => c.cost !== null);
  const chosen =
    priced.length > 0
      ? priced.reduce((best, c) => (c.cost! < best.cost! ? c : best))
      : pool[0];

  logProviders("qa model auto-selected", {
    provider: chosen.provider,
    model: chosen.model,
  });
  return { provider: chosen.provider, model: chosen.model };
}

// ============================================
// Custom providers
// ============================================

const CUSTOM_PROVIDERS_KEY = "customProviders";

async function getCustomProviders(): Promise<Record<string, CustomProviderConfig>> {
  const result = await chrome.storage.local.get([CUSTOM_PROVIDERS_KEY]);
  const value = result[CUSTOM_PROVIDERS_KEY];
  return isPlainObject(value)
    ? (value as Record<string, CustomProviderConfig>)
    : {};
}

/** Add or update a user-defined provider and refresh the registry cache. */
export async function saveCustomProvider(config: CustomProviderConfig): Promise<void> {
  if (!/^[a-z0-9][a-z0-9_-]{0,100}$/i.test(config.id) || ["__proto__", "constructor", "prototype", "anthropic", "openai", "deepseek"].includes(config.id)) throw new Error("Invalid provider id");
  assertSafeProviderUrl(config.baseUrl);
  for (const endpoint of config.endpoints ?? []) assertSafeProviderUrl(endpoint.baseUrl);
  config = { ...config, headers: await sealHeaders(config.headers), endpoints: await Promise.all((config.endpoints ?? []).map(async endpoint => ({ ...endpoint, headers: await sealHeaders(endpoint.headers) }))) };
  const providers = await getCustomProviders();
  providers[config.id] = config;
  await chrome.storage.local.set({ [CUSTOM_PROVIDERS_KEY]: providers });
  resetRegistry();
  await ensureRegistry();
  logProviders("custom provider saved", { id: config.id, dialect: config.dialect });
}

/** Remove a user-defined provider, its profile and any role using it. */
export async function deleteCustomProvider(id: string): Promise<void> {
  const providers = await getCustomProviders();
  if (providers[id]) {
    delete providers[id];
    await chrome.storage.local.set({ [CUSTOM_PROVIDERS_KEY]: providers });
  }

  const profiles = await getProviderProfiles();
  if (profiles[id]) {
    delete profiles[id];
    await chrome.storage.local.set({ [PROFILES_KEY]: profiles });
  }

  const roles = await getRoles();
  let changed = false;
  if (roles.primary?.provider === id) {
    roles.primary = null;
    changed = true;
  }
  if (roles.validator?.provider === id) {
    roles.validator = null;
    changed = true;
  }
  if (changed) await saveRoles(roles);

  resetRegistry();
  await ensureRegistry();
  logProviders("custom provider deleted", { id });
}

/** Override the endpoint a model routes to (multi-endpoint providers). */
export async function setModelEndpoint(
  presetId: string,
  model: string,
  endpoint: string,
): Promise<void> {
  const providers = await getCustomProviders();
  const config = providers[presetId];
  if (!config) return;
  providers[presetId] = {
    ...config,
    modelRoutes: { ...(config.modelRoutes ?? {}), [model]: endpoint },
  };
  await chrome.storage.local.set({ [CUSTOM_PROVIDERS_KEY]: providers });
  resetRegistry();
  await ensureRegistry();
  logProviders("model endpoint set", { provider: presetId, model, endpoint });
}
