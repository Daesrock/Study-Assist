/**
 * Provider profiles & role assignments
 *
 * Step B storage layer. Provider credentials live in `providerProfiles`
 * (keyed by preset id) and the pipeline roles in `roles`. A schema
 * migration seeds both from the legacy per-provider keys without deleting
 * them (safe rollback).
 *
 * The migration is also run lazily via `ensureProviderConfig()` so the
 * pipeline never depends on `onInstalled`/`onStartup` firing (unreliable
 * on unpacked reloads and MV3 service-worker wake-ups).
 */

import type {
  ProviderProfile,
  ProviderRoles,
  RoleAssignment,
} from "../constants.js";
import { encryptApiKey, decryptApiKey, isPlainTextKey } from "../crypto.js";
import type { ProviderPreset } from "./contract.js";
import { LLM_PRESETS } from "./registry.js";

const PROFILES_KEY = "providerProfiles";
const ROLES_KEY = "roles";
const SCHEMA_KEY = "schemaVersion";

export const CURRENT_SCHEMA_VERSION = 2;

export const DEFAULT_ROLES: ProviderRoles = { primary: null, validator: null };

/** Legacy storage keys, used as a fallback while the popup still writes them. */
const LEGACY_KEY_MAP: Record<string, string> = {
  anthropic: "claudeApiKey",
  deepseek: "deepseekApiKey",
};

// ============================================
// Profiles
// ============================================

export async function getProviderProfiles(): Promise<Record<string, ProviderProfile>> {
  const result = await chrome.storage.local.get([PROFILES_KEY]);
  return (result[PROFILES_KEY] as Record<string, ProviderProfile>) ?? {};
}

export async function getProfile(presetId: string): Promise<ProviderProfile | null> {
  const profiles = await getProviderProfiles();
  return profiles[presetId] ?? null;
}

export async function saveProfile(
  presetId: string,
  patch: Partial<ProviderProfile>,
): Promise<void> {
  const profiles = await getProviderProfiles();
  profiles[presetId] = { ...(profiles[presetId] ?? {}), ...patch };
  await chrome.storage.local.set({ [PROFILES_KEY]: profiles });
}

/**
 * Decrypted API key for a provider, or null.
 * - Prefers the profile key.
 * - Falls back to the legacy key while the popup still writes it.
 * - Transparently migrates plain-text values to encrypted.
 */
export async function getProviderKey(presetId: string): Promise<string | null> {
  const profile = await getProfile(presetId);
  let stored = profile?.apiKey;

  if (!stored) {
    const legacyName = LEGACY_KEY_MAP[presetId];
    if (legacyName) {
      const legacy = (await chrome.storage.local.get([legacyName])) as Record<string, unknown>;
      const value = legacy[legacyName] as string | undefined;
      if (value) {
        stored = isPlainTextKey(value) ? await encryptApiKey(value) : value;
        await saveProfile(presetId, { apiKey: stored });
      }
    }
  }

  if (!stored) return null;

  if (isPlainTextKey(stored)) {
    const encrypted = await encryptApiKey(stored);
    await saveProfile(presetId, { apiKey: encrypted });
    return stored;
  }
  return decryptApiKey(stored);
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
}

/** Effective vision-capable model list: user override, else curated. */
export async function getEffectiveVisionModels(presetId: string): Promise<string[]> {
  const profile = await getProfile(presetId);
  return profile?.visionModels ?? LLM_PRESETS[presetId]?.visionModels ?? [];
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
  const preset = LLM_PRESETS[role.provider];
  if (!preset) return null;

  const apiKey = await getProviderKey(role.provider);
  if (!apiKey) return null;

  const profile = await getProfile(role.provider);
  const thinking = profile?.thinking ?? preset.defaultThinking;
  const model = role.model || preset.defaultModels[0];
  const visionModels = profile?.visionModels ?? preset.visionModels;
  const vision = visionModels.includes(model);

  return { preset, model, apiKey, thinking, vision };
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
  lastSync: number | null;
}

export interface ProviderState {
  presets: ProviderPreset[];
  profiles: PublicProviderProfile[];
  roles: ProviderRoles;
}

/** State for the providers page / popup. Never includes API keys. */
export async function getProviderState(): Promise<ProviderState> {
  const stored = await getProviderProfiles();
  const profiles: PublicProviderProfile[] = Object.values(LLM_PRESETS).map((preset) => {
    const profile = stored[preset.id];
    return {
      id: preset.id,
      hasKey: !!profile?.apiKey,
      thinking: profile?.thinking ?? preset.defaultThinking,
      models: profile?.models ?? [],
      customModels: profile?.customModels ?? [],
      visionModels: profile?.visionModels ?? preset.visionModels,
      lastSync: profile?.lastSync ?? null,
    };
  });
  return {
    presets: Object.values(LLM_PRESETS),
    profiles,
    roles: await getRoles(),
  };
}

/** Remove a provider's API key (keeps models/vision metadata). */
export async function clearProviderKey(presetId: string): Promise<void> {
  const profiles = await getProviderProfiles();
  if (!profiles[presetId]) return;
  delete profiles[presetId].apiKey;
  await chrome.storage.local.set({ [PROFILES_KEY]: profiles });
}

/** Toggle whether a model accepts image input. */
export async function setModelVision(
  presetId: string,
  model: string,
  vision: boolean,
): Promise<void> {
  const current = await getEffectiveVisionModels(presetId);
  const next = new Set(current);
  if (vision) next.add(model);
  else next.delete(model);
  await saveProfile(presetId, { visionModels: [...next] });
}

/** Add a manually-entered model id to a provider. */
export async function addCustomModel(presetId: string, model: string): Promise<void> {
  const trimmed = model.trim();
  if (!trimmed) return;
  const profile = await getProfile(presetId);
  const current = profile?.customModels ?? [];
  if (current.includes(trimmed)) return;
  await saveProfile(presetId, { customModels: [...current, trimmed] });
}

// ============================================
// Migration (legacy keys -> profiles + roles)
// ============================================

async function toEncrypted(value: string): Promise<string> {
  return isPlainTextKey(value) ? encryptApiKey(value) : value;
}

export async function migrateProviderConfig(): Promise<void> {
  const stored = (await chrome.storage.local.get([
    SCHEMA_KEY,
    PROFILES_KEY,
    ROLES_KEY,
    "claudeApiKey",
    "claudeModel",
    "deepseekApiKey",
    "deepseekModel",
    "useDeepSeek",
    "deepseekOnly",
    "claudeThinking",
    "deepseekThinking",
  ])) as Record<string, unknown>;

  const profiles =
    (stored[PROFILES_KEY] as Record<string, ProviderProfile>) ?? {};
  const roles = (stored[ROLES_KEY] as ProviderRoles) ?? { ...DEFAULT_ROLES };

  const schemaCurrent = stored[SCHEMA_KEY] === CURRENT_SCHEMA_VERSION;
  const rolesEmpty = !roles.primary && !roles.validator;

  // Self-healing: skip only when the schema is current AND roles exist.
  if (schemaCurrent && !rolesEmpty) return;

  const claudeKey = stored["claudeApiKey"] as string | undefined;
  const deepseekKey = stored["deepseekApiKey"] as string | undefined;

  // Seed provider profiles (never delete the legacy keys).
  const anthropic = profiles.anthropic ?? {};
  if (claudeKey && !anthropic.apiKey) anthropic.apiKey = await toEncrypted(claudeKey);
  if (anthropic.thinking === undefined) {
    anthropic.thinking = stored["claudeThinking"] === true;
  }
  if (anthropic.apiKey || anthropic.thinking !== undefined) {
    profiles.anthropic = anthropic;
  }

  const deepseek = profiles.deepseek ?? {};
  if (deepseekKey && !deepseek.apiKey) deepseek.apiKey = await toEncrypted(deepseekKey);
  if (deepseek.thinking === undefined) {
    deepseek.thinking = stored["deepseekThinking"] !== false;
  }
  if (deepseek.apiKey || deepseek.thinking !== undefined) {
    profiles.deepseek = deepseek;
  }

  // Seed roles only when the user hasn't assigned any yet.
  if (rolesEmpty) {
    const useDeepSeek = stored["useDeepSeek"] === true;
    const deepseekOnly = stored["deepseekOnly"] === true;
    const claudeModel =
      (stored["claudeModel"] as string) ||
      LLM_PRESETS.anthropic.defaultModels[0];
    const deepseekModel =
      (stored["deepseekModel"] as string) ||
      LLM_PRESETS.deepseek.defaultModels[0];

    roles.primary =
      useDeepSeek && deepseekKey
        ? { provider: "deepseek", model: deepseekModel }
        : { provider: "anthropic", model: claudeModel };
    roles.validator = deepseekOnly
      ? null
      : { provider: "anthropic", model: claudeModel };
  }

  await chrome.storage.local.set({
    [PROFILES_KEY]: profiles,
    [ROLES_KEY]: roles,
    [SCHEMA_KEY]: CURRENT_SCHEMA_VERSION,
  });
}

let ensurePromise: Promise<void> | null = null;

/**
 * Run the provider migration at most once per service-worker lifetime.
 * Safe to call on every analysis; never throws.
 */
export function ensureProviderConfig(): Promise<void> {
  if (!ensurePromise) {
    ensurePromise = migrateProviderConfig().catch((error) => {
      console.error("[Study Assist] ensureProviderConfig error:", error);
      ensurePromise = null; // allow a later retry
    });
  }
  return ensurePromise;
}
