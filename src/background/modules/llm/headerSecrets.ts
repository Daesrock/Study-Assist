import { encryptApiKey, decryptApiKey } from "../crypto.js";

// All custom header values are treated as secrets, including unconventional
// gateway authentication names. Public provider state never returns them.
export async function sealHeaders(headers?: Record<string, string>): Promise<Record<string, string> | undefined> {
  if (!headers) return undefined;
  const out: Record<string, string> = {};
  for (const [name, value] of Object.entries(headers)) {
    if (!/^[a-zA-Z0-9!#$%&'*+.^_`|~-]+$/.test(name) || typeof value !== "string" || /[\r\n]/.test(value) || value.length > 8192) throw new Error("Invalid custom header");
    out[name] = value.startsWith("v2:") ? value : await encryptApiKey(value);
  }
  return out;
}

export async function openHeaders(headers?: Record<string, string>): Promise<Record<string, string> | undefined> {
  if (!headers) return undefined;
  return Object.fromEntries(await Promise.all(Object.entries(headers).map(async ([key, value]) => [key, await decryptApiKey(value)])));
}
