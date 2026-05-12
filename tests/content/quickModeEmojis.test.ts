/**
 * Vitest — QuickMode Emoji Indicators Tests
 * Verifies emoji display during pipeline status transitions.
 */

import { describe, it, expect, beforeEach, vi } from "vitest";
import { JSDOM } from "jsdom";

// Set up jsdom with a button
const dom = new JSDOM(`<!DOCTYPE html><div id="study-assist-quick"><span>SA</span></div>`);
const { document } = dom.window;
// @ts-expect-error - mock global document for getElementById
globalThis.document = document;

// Import the module under test (needs DOM to exist first)
const { __testOnlyQuickMode } = await import("../../src/content/modules/api.js");
const { showQuickEmoji, STATUS_EMOJIS } = __testOnlyQuickMode;

describe("STATUS_EMOJIS mapping", () => {
  it("should map DEEPSEEK_RETRY to ⚠️", () => {
    expect(STATUS_EMOJIS.DEEPSEEK_RETRY).toBe("⚠️");
  });

  it("should map CLAUDING_FALLBACK to 🔄", () => {
    expect(STATUS_EMOJIS.CLAUDING_FALLBACK).toBe("🔄");
  });

  it("should map CLAUDING_VALIDATING to 🔍", () => {
    expect(STATUS_EMOJIS.CLAUDING_VALIDATING).toBe("🔍");
  });
});

describe("showQuickEmoji", () => {
  let btn: HTMLElement;

  beforeEach(() => {
    btn = document.getElementById("study-assist-quick")!;
    if (!btn) return;
    btn.innerHTML = `<span>SA</span>`;
  });

  it("should show ⚠️ on button for DEEPSEEK_RETRY", () => {
    showQuickEmoji("DEEPSEEK_RETRY");
    expect(btn.innerHTML).toContain("⚠️");
  });

  it("should show 🔄 on button for CLAUDING_FALLBACK", () => {
    showQuickEmoji("CLAUDING_FALLBACK");
    expect(btn.innerHTML).toContain("🔄");
  });

  it("should show 🔍 on button for CLAUDING_VALIDATING", () => {
    showQuickEmoji("CLAUDING_VALIDATING");
    expect(btn.innerHTML).toContain("🔍");
  });

  it("should not change button when status is unknown", () => {
    showQuickEmoji("UNKNOWN_STATUS");
    expect(btn.innerHTML).toBe(`<span>SA</span>`);
  });

  it("should not throw when button does not exist", () => {
    // Temporarily remove the button
    btn.remove();
    expect(() => showQuickEmoji("CLAUDING_FALLBACK")).not.toThrow();
  });
});
