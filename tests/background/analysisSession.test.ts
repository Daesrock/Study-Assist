import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AnalysisSession } from "../../src/background/modules/analysisSession";

const sessions: AnalysisSession[] = [];
function session(): AnalysisSession {
  const result = new AnalysisSession();
  sessions.push(result);
  return result;
}

beforeEach(() => { vi.useFakeTimers(); vi.mocked(chrome.runtime.getPlatformInfo).mockClear(); });
afterEach(() => { for (const s of sessions.splice(0)) s.dispose(); vi.useRealTimers(); });

describe("pending analysis worker lifetime", () => {
  it("does not keep an idle session alive, and starts at most one timer", async () => {
    const active = session();
    await vi.advanceTimersByTimeAsync(45000);
    expect(chrome.runtime.getPlatformInfo).not.toHaveBeenCalled();
    active.startKeepAlive();
    active.startKeepAlive();
    await vi.advanceTimersByTimeAsync(45000);
    expect(chrome.runtime.getPlatformInfo).toHaveBeenCalledTimes(3);
    expect(vi.getTimerCount()).toBe(1);
  });

  it("stops on completion or failure and cannot be restarted", async () => {
    const active = session();
    active.startKeepAlive();
    active.dispose();
    active.startKeepAlive();
    await vi.advanceTimersByTimeAsync(60000);
    expect(chrome.runtime.getPlatformInfo).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("cancels the request and its primary, without leaving a timer", async () => {
    const active = session();
    active.primaryController = new AbortController();
    active.startKeepAlive();
    active.cancel();
    await vi.advanceTimersByTimeAsync(60000);
    expect(active.controller.signal.aborted).toBe(true);
    expect(active.primaryController.signal.aborted).toBe(true);
    expect(chrome.runtime.getPlatformInfo).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("keeps validator fallback alive when skipping only the primary", async () => {
    const active = session();
    active.primaryController = new AbortController();
    active.startKeepAlive();
    active.skip();
    await vi.advanceTimersByTimeAsync(45000);
    expect(active.primaryController.signal.aborted).toBe(true);
    expect(active.controller.signal.aborted).toBe(false);
    expect(chrome.runtime.getPlatformInfo).toHaveBeenCalledTimes(3);
  });

  it("isolates cancellation between concurrent sessions", async () => {
    const first = session(), second = session();
    first.startKeepAlive(); second.startKeepAlive(); first.cancel();
    await vi.advanceTimersByTimeAsync(45000);
    expect(second.controller.signal.aborted).toBe(false);
    expect(chrome.runtime.getPlatformInfo).toHaveBeenCalledTimes(4);
    expect(vi.getTimerCount()).toBe(1);
  });
});
