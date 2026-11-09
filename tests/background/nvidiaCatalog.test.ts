import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mockStorage } from "../setup";
import { classifyNvidiaModels, getNvidiaCatalog, lookupNvidiaCatalogVision, refreshNvidiaCatalog } from "../../src/background/modules/llm/nvidiaCatalog";
import { setLlmFetch } from "../../src/background/modules/llm/transport";
import { isNvidiaNimUrl } from "../../src/background/modules/llm/modelIdentity";

export const resource = (publisher: string, name: string, free = true) => ({
  name,
  labels: [
    { key: "publisher", values: [publisher] },
    { key: "general", values: free ? ["Free Endpoint"] : ["Download Available"], unresolvedValues: free ? ["nim_type_preview"] : ["nim_type_run_anywhere"] },
  ],
});

const page = (resources: unknown[], pages = 1) => ({ resultPageTotal: pages, results: [
  { groupValue: "_scored", resources: [resource("ignored", "duplicate")] },
  { groupValue: "ENDPOINT", resources },
] });

beforeEach(() => {
  for (const key of Object.keys(mockStorage)) delete mockStorage[key];
  vi.mocked(chrome.permissions.contains).mockResolvedValue(true);
});
afterEach(() => setLlmFetch(undefined));

describe("NVIDIA catalog", () => {
  it("recognizes only the official NIM base URL", () => {
    expect(isNvidiaNimUrl("https://integrate.api.nvidia.com/v1/")).toBe(true);
    for (const url of ["https://integrate.api.nvidia.com.evil.test/v1", "http://integrate.api.nvidia.com/v1", "https://other.test/v1", "https://integrate.api.nvidia.com/other"]) {
      expect(isNvidiaNimUrl(url)).toBe(false);
    }
  });

  it("fetches all pages without credentials and deduplicates scored/regular entries", async () => {
    const fetcher = vi.fn(async (input: any, init: any) => {
      const url = new URL(String(input));
      expect(url.origin).toBe("https://api.ngc.nvidia.com");
      expect(init.headers).toBeUndefined();
      expect(init.credentials).toBe("omit");
      expect(init.redirect).toBe("error");
      const query = JSON.parse(url.searchParams.get("q")!);
      expect(query.filters).toEqual([{ field: "label", value: "nim_type_preview" }]);
      return Response.json(page(query.page === 0
        ? [resource("deepseek-ai", "deepseek-v4.1-flash"), resource("other", "download-only", false)]
        : [resource("z-ai", "glm-5-3"), resource("deepseek-ai", "deepseek-v4.1-flash")], 2));
    });
    setLlmFetch(fetcher);
    expect(await refreshNvidiaCatalog()).toBe(true);
    expect(fetcher).toHaveBeenCalledTimes(2);
    const saved = await getNvidiaCatalog();
    expect(saved.entries).toHaveLength(2);
    expect(saved.fetchedAt).toBeTypeOf("number");
    expect(saved.refreshFailed).toBe(false);
    const status = classifyNvidiaModels(saved, ["deepseek-ai/deepseek-v4.1-flash", "z-ai/glm-5.3", "other/download-only", "another/glm-5.3"]);
    expect(status.freeEndpoints).toEqual({
      "deepseek-ai/deepseek-v4.1-flash": true, "z-ai/glm-5.3": true,
      "other/download-only": null, "another/glm-5.3": null,
    });
  });

  it("leaves ambiguous normalized identities unconfirmed and prefers an exact id", () => {
    const saved = { entries: [{ publisher: "z-ai", name: "glm-5-3" }, { publisher: "z-ai", name: "glm-5.3" }], fetchedAt: 1, refreshFailed: false };
    expect(classifyNvidiaModels(saved, ["z-ai/GLM_5_3"]).freeEndpoints["z-ai/GLM_5_3"]).toBeNull();
    expect(classifyNvidiaModels(saved, ["z-ai/glm-5.3"]).freeEndpoints["z-ai/glm-5.3"]).toBe(true);
  });

  it("retains explicit image-input labels without treating all multimodal or text models as vision", async () => {
    const flash = resource("z-ai", "glm-5-3-flash");
    flash.labels[1].values.push("Image-to-Text", "Text-to-Text");
    const normal = resource("z-ai", "glm-5-3");
    normal.labels[1].values.push("Text-to-Text");
    const audio = resource("other", "audio-model");
    audio.labels[1].values.push("Multimodal", "Audio-to-Text");
    setLlmFetch(async () => Response.json(page([flash, normal, audio])));
    expect(await refreshNvidiaCatalog()).toBe(true);
    const saved = await getNvidiaCatalog();
    expect(lookupNvidiaCatalogVision(saved, "z-ai/glm-5.3-flash")).toBe(true);
    expect(lookupNvidiaCatalogVision(saved, "z-ai/glm-5.3")).toBeNull();
    expect(lookupNvidiaCatalogVision(saved, "other/audio-model")).toBeNull();
    expect(lookupNvidiaCatalogVision(saved, "other/glm-5.3-flash")).toBeNull();
  });

  it("keeps the last complete snapshot and date when a later page fails", async () => {
    mockStorage.nvidiaFreeEndpointCatalog = { entries: [{ publisher: "old", name: "model" }], fetchedAt: 123, refreshFailed: false };
    const fetcher = vi.fn(async () => fetcher.mock.calls.length === 1
      ? Response.json(page([resource("new", "partial")], 2)) : new Response("", { status: 503 }));
    setLlmFetch(fetcher);
    expect(await refreshNvidiaCatalog()).toBe(false);
    expect(await getNvidiaCatalog()).toEqual({ entries: [{ publisher: "old", name: "model" }], fetchedAt: 123, refreshFailed: true });
  });

  it("rejects malformed responses and permits retrying explicit detection", async () => {
    setLlmFetch(vi.fn(async () => Response.json({ results: [] })));
    expect(await refreshNvidiaCatalog()).toBe(false);
    expect((await getNvidiaCatalog()).fetchedAt).toBeNull();
    setLlmFetch(vi.fn(async () => Response.json(page([]))));
    expect(await refreshNvidiaCatalog()).toBe(true);
    expect((await getNvidiaCatalog()).refreshFailed).toBe(false);
  });

  it("retains saved labels indefinitely without network reads, including permission denial", async () => {
    mockStorage.nvidiaFreeEndpointCatalog = { entries: [{ publisher: "old", name: "model" }], fetchedAt: 1, refreshFailed: false };
    const fetcher = vi.fn();
    setLlmFetch(fetcher);
    const saved = await getNvidiaCatalog();
    expect(classifyNvidiaModels(saved, ["old/model"]).freeEndpoints["old/model"]).toBe(true);
    expect(fetcher).not.toHaveBeenCalled();
    vi.mocked(chrome.permissions.contains).mockResolvedValue(false);
    expect(await refreshNvidiaCatalog()).toBe(false);
    expect((await getNvidiaCatalog()).fetchedAt).toBe(1);
    expect(fetcher).not.toHaveBeenCalled();
  });
});
