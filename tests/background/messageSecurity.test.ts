import { beforeAll, expect, it } from "vitest";
import { mockStorage, chromeRuntime, chromeStorageLocal } from "../setup";
import { __setPriceIndexForTests } from "../../src/background/modules/llm/pricing";

let handler: Function;
beforeAll(async () => {
  __setPriceIndexForTests({});
  mockStorage.securitySchema = 2;
  await import("../../src/background/background");
  handler = chromeRuntime.onMessage.addListener.mock.calls.at(-1)![0];
});
const content = { id: "mock-id", url: "https://example.test/", frameId: 0, tab: { id: 1 } };
const send = (message: unknown, sender = content): Promise<any> => new Promise(resolve => handler(message, sender, resolve));

it("restricts direct storage to trusted extension contexts", async () => {
  await send({ type: "GET_CONTENT_SETTINGS" });
  expect(chromeStorageLocal.setAccessLevel).toHaveBeenCalledWith({ accessLevel: "TRUSTED_CONTEXTS" });
});
it("returns only selected preferences to content scripts", async () => {
  mockStorage.providerProfiles = { openai: { apiKey: "do-not-expose" } };
  mockStorage.credentialWrappingKeyV2 = "do-not-expose";
  mockStorage.allowedDomains = ["example.test"];
  const response = await send({ type: "GET_CONTENT_SETTINGS" });
  expect(response.settings.allowedDomains).toEqual(["example.test"]);
  expect(JSON.stringify(response)).not.toContain("do-not-expose");
});
it.each(["SAVE_PROVIDER_KEY", "GET_PROVIDER_STATE", "CLEAR_USAGE_DATA", "GET_USAGE_HISTORY", "REGISTER_QA_TAB", "DEV_LOG"])("rejects %s from content scripts", async type => {
  const response = await send({ type, provider: "openai", rawKey: "fake" });
  expect(response.success).toBe(false);
  expect(response.error).toContain("extension page");
});
it("rejects messages from another extension", async () => {
  expect((await send({ type: "GET_CONTENT_SETTINGS" }, { ...content, id: "foreign" })).success).toBe(false);
});
