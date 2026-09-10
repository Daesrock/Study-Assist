/**
 * Provider profiles & role assignments
 *
 * Step B storage layer. Provider credentials live in `providerProfiles`
 * (keyed by preset id) and the pipeline roles in `roles`. A schema
 * migration seeds both from the legacy per-provider keys without deleting
 * them (safe rollback).
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

/** Decrypted API key for a provider, or null. Handles plain-text migration. */
export async function getProviderKey(presetId: string): Promise<string | null> {
  const profile = await getProfile(presetId);
  const stored = profile?.apiKey;
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
}

/**
 * Whether a provider can handle a question's features (images / matching).
 * Used by the orchestrator to route around incapable providers.
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

  return { preset, model, apiKey, thinking };
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

  if (stored[SCHEMA_KEY] === CURRENT_SCHEMA_VERSION) return;

  const profiles =
    (stored[PROFILES_KEY] as Record<string, ProviderProfile>) ?? {};
  const roles = (stored[ROLES_KEY] as ProviderRoles) ?? { ...DEFAULT_ROLES };

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
  if (!roles.primary && !roles.validator) {
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
