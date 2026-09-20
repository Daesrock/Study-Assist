import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { handleQuickClick, sendQuickAnalysis, cancelCurrentRequest } from "../../src/content/modules/api";
import { createQuickButton } from "../../src/content/modules/ui";
import { state } from "../../src/content/modules/state";
import type { DetectedQuestion } from "../../src/types/index";

function fakePort() {
  const messages = new Set<Function>(), disconnects = new Set<Function>();
  const port = {
    onMessage: { addListener: (cb: Function) => messages.add(cb), removeListener: (cb: Function) => messages.delete(cb) },
    onDisconnect: { addListener: (cb: Function) => disconnects.add(cb), removeListener: (cb: Function) => disconnects.delete(cb) },
    postMessage: vi.fn(), disconnect: vi.fn(),
    emit: (msg: unknown) => { for (const cb of [...messages]) cb(msg); },
    loseConnection: () => { for (const cb of [...disconnects]) cb(); },
  };
  (chrome.runtime as any).connect = vi.fn(() => port);
  return port;
}
beforeEach(() => {
  document.body.innerHTML = '<div id="study-assist-quick-container"><div id="study-assist-quick">SA</div></div>';
  state.isActive = true; state.isDomainAllowed = true; state.isRequestInProgress = false;
  state.hasValidAnswer = false; state.requestCancelled = false; state.settings.sendImages = false;
});
afterEach(() => { cancelCurrentRequest(); vi.useRealTimers(); });

describe("content entry points", () => {
  it("rejects synthetic clicks on the actual quick button", () => {
    document.body.innerHTML = "";
    const handler = vi.fn();
    createQuickButton({ handleQuickClick: handler });
    document.getElementById("study-assist-quick")!.click();
    expect(handler).not.toHaveBeenCalled();
  });
  it("renders a model answer as text, never as page markup", async () => {
    const port = fakePort();
    const payload = '<img src=x data-injected="yes">';
    port.postMessage.mockImplementation(() => port.emit({ type: "RESULT", result: { success: true, result: payload } }));
    const question = { text: "What?", type: "short-answer", questionNumber: 1, element: document.createElement("div") } as DetectedQuestion;
    await handleQuickClick(undefined, { detectVisibleQuestion: async () => question, detectVisibleQuestions: async () => [question], startQuestionChangeObserver: vi.fn() });
    expect(document.querySelector("[data-injected]")).toBeNull();
    expect(document.getElementById("study-assist-quick")!.textContent).toContain("<img");
  });
  it("releases the lock when detection throws", async () => {
    vi.useFakeTimers();
    await handleQuickClick(undefined, { detectVisibleQuestion: async () => { throw new Error("Detection failed"); } });
    expect(state.isRequestInProgress).toBe(false);
    expect(document.getElementById("study-assist-quick")!.classList.contains("loading")).toBe(false);
  });
});

describe("port cleanup", () => {
  it("rejects disconnects promptly", async () => {
    const port = fakePort();
    const pending = sendQuickAnalysis({} as any);
    port.loseConnection();
    await expect(pending).rejects.toThrow("connection lost");
    expect(port.disconnect).toHaveBeenCalledTimes(1);
  });
  it("settles cancellation without waiting for a disconnect event on the local side", async () => {
    const port = fakePort();
    const pending = sendQuickAnalysis({} as any);
    cancelCurrentRequest();
    await expect(pending).rejects.toThrow("cancelled");
    expect(port.disconnect).toHaveBeenCalledTimes(1);
  });
  it("closes completed ports and ignores late status messages", async () => {
    const port = fakePort();
    const pending = sendQuickAnalysis({} as any);
    port.emit({ type: "RESULT", result: { success: true, result: "A" } });
    await pending;
    port.emit({ type: "STATUS", status: "VALIDATOR_FALLBACK" });
    expect(document.getElementById("study-assist-quick")!.textContent).toBe("SA");
    expect(port.disconnect).toHaveBeenCalledTimes(1);
  });
});

describe("dashboard rendering", () => {
  it("escapes model names, labels and history metadata", () => {
    // Evaluate the shipped vanilla-JS functions, omitting only the boot code.
    let source = readFileSync("popup/dashboard.js", "utf8");
    const boot = source.indexOf('document.getElementById("refresh-btn")');
    const endBoot = source.indexOf("let cachedQaModel", boot);
    source = source.slice(0, boot) + source.slice(endBoot);
    source = source.replace(/loadData\(\);\s*$/, "");
    const render = new Function("document", source + "; return renderDashboard;")(document);
    const attack = '<img src=x data-injected="yes">';
    const html = render({ byModel: { [attack]: 1 }, bySource: {}, byProvider: {}, byDay: {}, byPlatform: {} }, [{ timestamp: Date.now(), model: attack, provider: attack, platform: attack, trigger: attack, questionText: attack, inputTokens: 1, outputTokens: 2, latencyMs: 0, success: true }], { roles: { primary: { provider: attack, model: attack } } }, false, null);
    document.body.innerHTML = html;
    expect(document.querySelector("[data-injected]")).toBeNull();
    expect(document.body.textContent).toContain(attack);
  });
});
