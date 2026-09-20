/**
 * Background Service Worker - API Key Encryption
 * Uses Web Crypto API (AES-GCM) to encrypt/decrypt API keys at rest
 */

const SALT = new TextEncoder().encode("study-assist-v1-salt");
const ITERATIONS = 100000;

/**
 * Legacy public-ID derivation, used only to migrate existing ciphertext.
 */
async function getLegacyEncryptionKey(): Promise<CryptoKey> {
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

// Persistent, random wrapping key. This prevents decryption from the public
// extension ID, but does NOT protect against theft of the entire Chrome profile.
const WRAPPING_KEY = "credentialWrappingKeyV2";
let keyWriteChain: Promise<unknown> = Promise.resolve();
function getEncryptionKey(): Promise<CryptoKey> {
  const run = keyWriteChain.then(async () => {
    const stored = await chrome.storage.local.get(WRAPPING_KEY);
    let encoded = stored[WRAPPING_KEY];
    if (encoded === undefined) {
      encoded = btoa(String.fromCharCode(...crypto.getRandomValues(new Uint8Array(32))));
      await chrome.storage.local.set({ [WRAPPING_KEY]: encoded });
    }
    if (typeof encoded !== "string") throw new Error("Invalid credential wrapping key");
    const bytes = Uint8Array.from(atob(encoded), c => c.charCodeAt(0));
    if (bytes.length !== 32) throw new Error("Invalid credential wrapping key");
    return crypto.subtle.importKey("raw", bytes, "AES-GCM", false, ["encrypt", "decrypt"]);
  });
  keyWriteChain = run.catch(() => {});
  return run;
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
  return "v2:" + btoa(String.fromCharCode(...combined));
}

/**
 * Decrypt a base64-encoded ciphertext back to the plain API key
 */
export async function decryptApiKey(encryptedKey: string): Promise<string> {
  try {
    const modern = encryptedKey.startsWith("v2:");
    const key = await (modern ? getEncryptionKey() : getLegacyEncryptionKey());
    const combined = Uint8Array.from(atob(modern ? encryptedKey.slice(3) : encryptedKey), (c) => c.charCodeAt(0));
    if (combined.length < 29) throw new Error("Invalid ciphertext");
    const iv = combined.slice(0, 12);
    const ciphertext = combined.slice(12);
    const decrypted = await crypto.subtle.decrypt({ name: "AES-GCM", iv }, key, ciphertext);
    return new TextDecoder().decode(decrypted);
  } catch {
    throw new Error("Cannot decrypt saved credential. Re-enter it in provider settings.");
  }
}
