import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { setupKeyboardHandlers } from "../../src/content/modules/keyboard.js";
import { state } from "../../src/content/modules/state.js";

describe("validator keyboard shortcut", () => {
  let keydown: (event: KeyboardEvent) => Promise<void>;
  const triggerQuickAnalysis = vi.fn();

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  beforeEach(() => {
    vi.restoreAllMocks();
    vi.clearAllMocks();
    document.documentElement.removeAttribute("study-assist-keyboard-injected");
    document.body.innerHTML = '<button id="study-assist-quick"></button>';
    Object.assign(state, { isActive: true, isDomainAllowed: true, skipPrimary: false });
    vi.stubGlobal("MutationObserver", class {
      observe() {}
      disconnect() {}
    });
    vi.spyOn(document, "addEventListener").mockImplementation((type, listener) => {
      if (type === "keydown") keydown = listener as typeof keydown;
    });
    vi.spyOn(window, "addEventListener").mockImplementation(() => {});
    setupKeyboardHandlers({
      triggerQuickAnalysis,
      reloadQuickMode: vi.fn(),
      toggleSAButtonVisibility: vi.fn(),
      cancelCurrentRequest: vi.fn(),
    });
  });

  function pressShift(ctrlKey = true) {
    // Invoke the registered handler with a trusted-event fixture; jsdom events are untrusted.
    return keydown({ key: "Shift", ctrlKey, isTrusted: true, repeat: false,
      preventDefault: vi.fn() } as unknown as KeyboardEvent);
  }

  it.each([false, true])("does nothing without a validator (loading=%s)", async (loading) => {
    document.getElementById("study-assist-quick")!.classList.toggle("loading", loading);
    vi.mocked(chrome.runtime.sendMessage).mockResolvedValue({ settings: { hasValidator: false } });
    await pressShift();
    expect(triggerQuickAnalysis).not.toHaveBeenCalled();
    expect(state.skipPrimary).toBe(false);
    expect(chrome.runtime.sendMessage).not.toHaveBeenCalledWith(expect.objectContaining({ type: "CANCEL_ANALYSIS" }));
  });

  it("uses current validator selection for each shortcut", async () => {
    vi.mocked(chrome.runtime.sendMessage).mockResolvedValue({ settings: { hasValidator: true } });
    await pressShift();
    expect(triggerQuickAnalysis).toHaveBeenCalledTimes(1);
    expect(state.skipPrimary).toBe(true);
    state.skipPrimary = false;
    vi.mocked(chrome.runtime.sendMessage).mockResolvedValue({ settings: { hasValidator: false } });
    await pressShift();
    expect(triggerQuickAnalysis).toHaveBeenCalledTimes(1);
    expect(state.skipPrimary).toBe(false);
  });

  it("still switches an active request to a selected validator", async () => {
    document.getElementById("study-assist-quick")!.classList.add("loading");
    vi.mocked(chrome.runtime.sendMessage).mockResolvedValue({ settings: { hasValidator: true } });
    await pressShift();
    expect(chrome.runtime.sendMessage).toHaveBeenCalledWith({ type: "CANCEL_ANALYSIS", skipPrimary: true });
    expect(triggerQuickAnalysis).not.toHaveBeenCalled();
  });

  it("keeps plain Shift working without a validator", async () => {
    await pressShift(false);
    expect(triggerQuickAnalysis).toHaveBeenCalledTimes(1);
    expect(state.skipPrimary).toBe(false);
    expect(chrome.runtime.sendMessage).not.toHaveBeenCalled();
  });

  it("does nothing if reading the selection fails", async () => {
    vi.mocked(chrome.runtime.sendMessage).mockRejectedValue(new Error("Unavailable"));
    await pressShift();
    expect(triggerQuickAnalysis).not.toHaveBeenCalled();
    expect(state.skipPrimary).toBe(false);
  });
});
