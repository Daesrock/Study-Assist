import { beforeEach, describe, expect, it, vi } from "vitest";
import { mockStorage } from "../setup";
import { readFileSync } from "node:fs";

beforeEach(() => {
  vi.resetModules();
  for (const key of Object.keys(mockStorage)) delete mockStorage[key];
  mockStorage.securitySchema = 2;
});

describe("1.3.1 release diagnostics", () => {
  it("clears a persisted development debug setting on worker startup", async () => {
    mockStorage.debugMode = true;
    await import("../../src/background/background");
    await vi.waitFor(() => expect(mockStorage.debugMode).toBe(false));
    const { DEBUG_MODE } = await import("../../src/background/modules/constants");
    expect(DEBUG_MODE).toBe(false);
  });

  it("ships disabled logging and no required HTTP development host", async () => {
    const { DEV_LOGGING } = await import("../../src/background/modules/logger");
    const manifest = JSON.parse(readFileSync("manifest.json", "utf8"));
    expect(DEV_LOGGING).toBe(false);
    expect(manifest.host_permissions.some((host: string) => host.startsWith("http://"))).toBe(false);
    expect(manifest.version).toBe("1.3.1");
  });
});
