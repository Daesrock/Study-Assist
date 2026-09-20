import { beforeEach, describe, expect, it, vi } from "vitest";
import { mockStorage } from "../setup";
import { encryptApiKey, decryptApiKey } from "../../src/background/modules/crypto";
import { assertSafeProviderUrl, validateAnalysis, qaTabs } from "../../src/background/modules/security";
import { getProviderKey, saveCustomProvider, getProviderState } from "../../src/background/modules/llm/profiles";
import { __resetRegistryForTests, getPreset } from "../../src/background/modules/llm/registry";
import { __setPriceIndexForTests } from "../../src/background/modules/llm/pricing";
import { trackUsage, clearUsageData, redactHistory } from "../../src/background/modules/usageTracker";
import { logError, fetchWithRetry } from "../../src/background/modules/fetchUtils";
import type { AnalysisContext } from "../../src/types/index";

beforeEach(() => {
  for (const key of Object.keys(mockStorage)) delete mockStorage[key];
  __resetRegistryForTests();
  __setPriceIndexForTests({});
  qaTabs.clear();
});

describe("credential storage", () => {
  it("persists a random key, uses fresh nonces and decrypts", async () => {
    const [first, second] = await Promise.all([encryptApiKey("fake-secret"), encryptApiKey("fake-secret")]);
    expect(first).toMatch(/^v2:/);
    expect(first).not.toBe(second);
    expect(await decryptApiKey(first)).toBe("fake-secret");
    expect(await decryptApiKey(second)).toBe("fake-secret");
    expect(mockStorage.credentialWrappingKeyV2).toBeTypeOf("string");
  });
  it("fails closed on plaintext and tampering", async () => {
    await expect(decryptApiKey("sk-fake-plaintext")).rejects.toThrow("Cannot decrypt");
    const encrypted = await encryptApiKey("fake-secret");
    await expect(decryptApiKey(encrypted.slice(0, -5) + "AAAA=")).rejects.toThrow("Cannot decrypt");
  });
  it("migrates existing AES-GCM credentials without losing their value", async () => {
    const material = await crypto.subtle.importKey("raw", new TextEncoder().encode(chrome.runtime.id), "PBKDF2", false, ["deriveKey"]);
    const key = await crypto.subtle.deriveKey({ name: "PBKDF2", salt: new TextEncoder().encode("study-assist-v1-salt"), iterations: 100000, hash: "SHA-256" }, material, { name: "AES-GCM", length: 256 }, false, ["encrypt"]);
    const iv = crypto.getRandomValues(new Uint8Array(12));
    const ciphertext = await crypto.subtle.encrypt({ name: "AES-GCM", iv }, key, new TextEncoder().encode("legacy-fake"));
    mockStorage.providerProfiles = { openai: { apiKey: btoa(String.fromCharCode(...iv, ...new Uint8Array(ciphertext))) } };
    expect(await getProviderKey("openai")).toBe("legacy-fake");
    expect((mockStorage.providerProfiles as any).openai.apiKey).toMatch(/^v2:/);
  });
  it("encrypts all custom header values and omits them from public state", async () => {
    await saveCustomProvider({ id: "custom-test", label: "Test", baseUrl: "https://gateway.test/v1", dialect: "openai-compatible", headers: { "x-unusual-secret": "fake-header-token" }, endpoints: [{ id: "alternate", baseUrl: "https://gateway.test/v2", dialect: "openai-responses", headers: { Authorization: "Bearer fake-other" } }] });
    expect(JSON.stringify(mockStorage.customProviders)).not.toContain("fake-header-token");
    expect(JSON.stringify(mockStorage.customProviders)).not.toContain("fake-other");
    expect(getPreset("custom-test").headers?.["x-unusual-secret"]).toBe("fake-header-token");
    expect(JSON.stringify(await getProviderState())).not.toContain("fake-header-token");
    expect(JSON.stringify(await getProviderState())).not.toContain("fake-other");
  });
});

describe("provider transport boundary", () => {
  it.each(["http://evil.test/v1", "http://localhost.evil.test", "https://user:secret@api.test", "https://api.test?key=secret", "file:///secret", "https://api.test/#secret"])("rejects %s", value => {
    expect(() => assertSafeProviderUrl(value)).toThrow();
  });
  it.each(["https://api.test/v1", "http://localhost:11434/v1", "http://127.0.0.1:8080", "http://[::1]:8080"])("allows %s", value => {
    expect(() => assertSafeProviderUrl(value)).not.toThrow();
  });
  it("does not retry an externally cancelled request", async () => {
    const controller = new AbortController();
    const fetcher = vi.fn(async () => { controller.abort(); throw new DOMException("Cancelled", "AbortError"); });
    await expect(fetchWithRetry("https://api.test", { signal: controller.signal }, 3, 1000, fetcher)).rejects.toThrow();
    expect(fetcher).toHaveBeenCalledTimes(1);
  });
});

describe("sender and domain checks", () => {
  const sender = { id: "mock-id", url: "https://quiz.test/exam", tab: { id: 1 }, frameId: 0 } as chrome.runtime.MessageSender;
  const context = (): AnalysisContext => ({ questionText: "Question", questionType: "short-answer", pageTitle: "", pageUrl: "https://spoofed.test", responseMode: "quick" });
  it("uses the real sender URL and checks current permissions every time", async () => {
    mockStorage.allowedDomains = ["quiz.test"];
    const ctx = context();
    await validateAnalysis(ctx, sender);
    expect(ctx.pageUrl).toBe(sender.url);
    mockStorage.allowedDomains = [];
    await expect(validateAnalysis(ctx, sender)).rejects.toThrow("Domain not allowed");
  });
  it("does not trust a QA flag or a lookalike domain", async () => {
    mockStorage.allowedDomains = ["quiz.test"];
    await expect(validateAnalysis({ ...context(), qaMode: true }, { ...sender, url: "https://quiz.test.evil.test" })).rejects.toThrow();
  });
  it("allows QA only in an explicitly registered example.com tab", async () => {
    qaTabs.add(1);
    await validateAnalysis({ ...context(), qaMode: true }, { ...sender, url: "https://example.com/" });
    await expect(validateAnalysis({ ...context(), qaMode: true }, { ...sender, url: "https://evil.test/" })).rejects.toThrow();
  });
  it("rejects oversized text and foreign senders", async () => {
    await expect(validateAnalysis({ ...context(), questionText: "a".repeat(50001) }, sender)).rejects.toThrow("Invalid");
    await expect(validateAnalysis(context(), { ...sender, id: "foreign" })).rejects.toThrow("Untrusted");
  });
});

describe("privacy and concurrent accounting", () => {
  const record = { timestamp: Date.now(), questionText: "private question", questionType: "short-answer", answer: "private answer", reasoningText: "private reasoning", source: "openai" as const, model: "unpriced", inputTokens: 3, outputTokens: 2, responseMode: "quick", success: true, latencyMs: 1 };
  it("keeps every concurrent record without retaining content when disabled", async () => {
    mockStorage.historyContent = false;
    await Promise.all(Array.from({ length: 25 }, () => trackUsage(record)));
    expect((mockStorage.usageRecords as any[])).toHaveLength(25);
    expect(JSON.stringify(mockStorage.usageRecords)).not.toContain("private");
  });
  it("retains bounded content by default for dashboard details", async () => {
    await trackUsage(record);
    expect((mockStorage.usageRecords as any[])[0].questionText).toBe("private question");
    expect((mockStorage.usageRecords as any[])[0].answer).toBe("private answer");
    expect((mockStorage.usageRecords as any[])[0].reasoningText).toBe("private reasoning");
  });
  it("retains bounded text only with consent, and can redact it", async () => {
    mockStorage.historyContent = true;
    await trackUsage({ ...record, answer: "x".repeat(20000) });
    expect((mockStorage.usageRecords as any[])[0].answer).toHaveLength(4000);
    await redactHistory();
    expect(JSON.stringify(mockStorage.usageRecords)).not.toContain("private");
    expect((mockStorage.usageRecords as any[])[0].inputTokens).toBe(3);
  });
  it("never records error payloads or credential-bearing URLs", async () => {
    await logError({ type: "failure", responseBody: "secret" });
    expect(mockStorage.errorLog).toBeUndefined();
    mockStorage.debugMode = true;
    await logError({ type: "failure", status: 500, responseBody: "secret", url: "https://test?key=secret", error: "secret" });
    expect(mockStorage.errorLog).not.toContain("secret");
    expect(mockStorage.errorLog).toContain("500");
  });
  it("clears usage and all retained diagnostics together", async () => {
    await trackUsage(record);
    mockStorage.errorLog = "old";
    mockStorage.lastApiRequestData = { old: true };
    await clearUsageData();
    expect(mockStorage.usageRecords).toEqual([]);
    expect(mockStorage.errorLog).toBeUndefined();
    expect(mockStorage.lastApiRequestData).toBeUndefined();
    expect(mockStorage.lastAiResponse).toBeUndefined();
  });
});
