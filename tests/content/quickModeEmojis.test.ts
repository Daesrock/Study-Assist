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
  it("should map PRIMARY_RETRY to ⚠️", () => {
    expect(STATUS_EMOJIS.PRIMARY_RETRY).toBe("⚠️");
  });

  it("should map VALIDATOR_FALLBACK to 🔄", () => {
    expect(STATUS_EMOJIS.VALIDATOR_FALLBACK).toBe("🔄");
  });

  it("should map VALIDATOR_VALIDATING to 🔍", () => {
    expect(STATUS_EMOJIS.VALIDATOR_VALIDATING).toBe("🔍");
  });
});

describe("showQuickEmoji", () => {
  let btn: HTMLElement;

  beforeEach(() => {
    btn = document.getElementById("study-assist-quick")!;
    if (!btn) return;
    btn.innerHTML = `<span>SA</span>`;
  });

  it("should show ⚠️ on button for PRIMARY_RETRY", () => {
    showQuickEmoji("PRIMARY_RETRY");
    expect(btn.innerHTML).toContain("⚠️");
  });

  it("should show 🔄 on button for VALIDATOR_FALLBACK", () => {
    showQuickEmoji("VALIDATOR_FALLBACK");
    expect(btn.innerHTML).toContain("🔄");
  });

  it("should show 🔍 on button for VALIDATOR_VALIDATING", () => {
    showQuickEmoji("VALIDATOR_VALIDATING");
    expect(btn.innerHTML).toContain("🔍");
  });

  it("should not change button when status is unknown", () => {
    showQuickEmoji("UNKNOWN_STATUS");
    expect(btn.innerHTML).toBe(`<span>SA</span>`);
  });

  it("should not throw when button does not exist", () => {
    // Temporarily remove the button
    btn.remove();
    expect(() => showQuickEmoji("VALIDATOR_FALLBACK")).not.toThrow();
  });
});
