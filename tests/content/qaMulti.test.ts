/**
 * Tests for the QA Manual "moodle-multi" scenario:
 * several Moodle questions visible at once (mirrors a real educa-t page).
 */

import { describe, it, expect, beforeEach, vi } from "vitest";
import { chromeRuntime } from "../setup";

const { __testOnlyQA } = await import("../../src/content/content.js");
const { detectVisibleQuestions } = await import(
  "../../src/content/modules/detection.js"
);
const { state } = await import("../../src/content/modules/state.js");

describe("QA moodle-multi scenario", () => {
  beforeEach(() => {
    document.body.innerHTML = "";
    state.detectedQuestions = [];
    state.isActive = true;
    state.isDomainAllowed = true;
  });

  it("injects 3 visible questions with real numbers and mixed types", () => {
    const target = document.createElement("div");
    document.body.appendChild(target);

    __testOnlyQA.injectMoodleMulti(target);

    const blocks = target.querySelectorAll(".que");
    expect(blocks).toHaveLength(3);
    expect(
      Array.from(blocks).map(
        (el) => el.querySelector(".qno")?.textContent?.trim(),
      ),
    ).toEqual(["4", "5", "6"]);
    expect(
      Array.from(blocks).map((el) =>
        el.classList.contains("truefalse") ? "true-false" : "multiple-choice",
      ),
    ).toEqual(["true-false", "multiple-choice", "multiple-choice"]);
  });

  it("detectVisibleQuestions returns all 3 in order (scenario -> multi path)", async () => {
    const target = document.createElement("div");
    document.body.appendChild(target);
    __testOnlyQA.injectMoodleMulti(target);

    const results = await detectVisibleQuestions();

    expect(results.map((q) => q.questionNumber)).toEqual([4, 5, 6]);
    expect(results.map((q) => q.type)).toEqual([
      "true-false",
      "multiple-choice",
      "multiple-choice",
    ]);
  });

  it("QA_INJECT_SCENARIO dispatcher routes moodle-multi and highlights", async () => {
    const addListener = chromeRuntime.onMessage
      .addListener as unknown as ReturnType<typeof vi.fn>;
    expect(addListener.mock.calls.length).toBeGreaterThan(0);
    const listener = addListener.mock.calls[addListener.mock.calls.length - 1][0] as (
      message: Record<string, unknown>,
      sender: unknown,
      sendResponse: (r: unknown) => void,
    ) => boolean;

    const sendResponse = vi.fn();
    listener(
      { type: "QA_INJECT_SCENARIO", scenario: "moodle-multi" },
      {},
      sendResponse,
    );
    await new Promise((r) => setTimeout(r, 100));

    expect(document.getElementById("study-assist-qa-sandbox")).not.toBeNull();
    expect(document.querySelectorAll("#study-assist-qa-sandbox .que")).toHaveLength(3);
    // runQAPreview highlights every detected question with a numbered badge
    expect(
      document.querySelectorAll(".study-assist-question-badge"),
    ).toHaveLength(3);
    expect(sendResponse).toHaveBeenCalledWith({ success: true });
  });
});
