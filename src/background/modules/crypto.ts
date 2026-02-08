/**
 * Background Service Worker - API Key Encryption
 * Uses Web Crypto API (AES-GCM) to encrypt/decrypt API keys at rest
 */

const SALT = new TextEncoder().encode("study-assist-v1-salt");
const ITERATIONS = 100000;

/**
 * Derive an AES-GCM key from the extension ID (unique per install)
 */
async function getEncryptionKey(): Promise<CryptoKey> {
  const extensionId = chrome.runtime.id;
  const keyMaterial = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(extensionId),
    "PBKDF2",
    false,
    ["deriveKey"],
  );
  return crypto.subtle.deriveKey(
    { name: "PBKDF2", salt: SALT, iterations: ITERATIONS, hash: "SHA-256" },
    keyMaterial,
    { name: "AES-GCM", length: 256 },
    false,
    ["encrypt", "decrypt"],
  );
}

/**
 * Encrypt an API key string → base64-encoded ciphertext
 */
export async function encryptApiKey(plainKey: string): Promise<string> {
  const key = await getEncryptionKey();
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const encoded = new TextEncoder().encode(plainKey);
  const encrypted = await crypto.subtle.encrypt({ name: "AES-GCM", iv }, key, encoded);

  const combined = new Uint8Array(iv.length + encrypted.byteLength);
  combined.set(iv);
  combined.set(new Uint8Array(encrypted), iv.length);
  return btoa(String.fromCharCode(...combined));
}

/**
 * Decrypt a base64-encoded ciphertext back to the plain API key
 */
export async function decryptApiKey(encryptedKey: string): Promise<string> {
  try {
    const key = await getEncryptionKey();
    const combined = Uint8Array.from(atob(encryptedKey), (c) => c.charCodeAt(0));
    const iv = combined.slice(0, 12);
    const ciphertext = combined.slice(12);
    const decrypted = await crypto.subtle.decrypt({ name: "AES-GCM", iv }, key, ciphertext);
    return new TextDecoder().decode(decrypted);
  } catch {
    // If decryption fails, the key might still be stored in plain text (pre-migration)
    return encryptedKey;
  }
}

/**
 * Detect whether a stored value is in plain text or already encrypted
 */
export function isPlainTextKey(value: string): boolean {
  // Claude keys start with "sk-ant-", DeepSeek keys start with "sk-"
  return value.startsWith("sk-ant-") || (value.startsWith("sk-") && !value.startsWith("sk-ant-"));
}

/**
 * Retrieve a decrypted API key from storage.
 * Transparently migrates plain-text keys to encrypted on first access.
 */
export async function getDecryptedApiKey(storageKey: string): Promise<string | null> {
  const result = await chrome.storage.local.get([storageKey]);
  const value = result[storageKey];
  if (!value) return null;

  if (isPlainTextKey(value)) {
    // Migrate: encrypt and re-store
    const encrypted = await encryptApiKey(value);
    await chrome.storage.local.set({ [storageKey]: encrypted });
    return value;
  }

  return decryptApiKey(value);
}

/**
 * Encrypt and save an API key to storage
 */
export async function encryptAndSaveKey(storageKey: string, plainKey: string): Promise<void> {
  const encrypted = await encryptApiKey(plainKey);
  await chrome.storage.local.set({ [storageKey]: encrypted });
}
