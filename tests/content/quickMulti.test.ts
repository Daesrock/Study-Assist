/**
 * Tests for QuickMode multi-question flow:
 * formatQuickToken, buildQuickContext, sendQuickAnalysis, handleQuickMulti.
 */

import { describe, it, expect, beforeEach, vi } from "vitest";
import type {
  DetectedQuestion,
  AnalysisResponse,
} from "../../src/types/index";

const { __testOnlyQuickMode } = await import(
  "../../src/content/modules/api.js"
);
const {
  formatQuickToken,
  buildQuickContext,
  sendQuickAnalysis,
  handleQuickMulti,
} = __testOnlyQuickMode;

const { state } = await import("../../src/content/modules/state.js");

function makeQuestion(
  over: Partial<DetectedQuestion> = {},
): DetectedQuestion {
  return {
    id: "t-1",
    element: document.createElement("div"),
    text: "Sample question?",
    type: "multiple-choice",
    options: [
      { letter: "A", text: "Alpha" },
      { letter: "B", text: "Beta" },
    ],
    confidence: 95,
    questionNumber: 1,
    ...over,
  };
}

function stubQuickPort(
  script: Array<{ status?: string; result: AnalysisResponse }>,
) {
  const queue = [...script];
  const posted: unknown[] = [];
  const chromeMock = (globalThis as Record<string, any>).chrome;
  chromeMock.runtime.connect = vi.fn(() => {
    let listener: ((msg: any) => void) | null = null;
    return {
      onMessage: {
        removeListener: vi.fn(),
        addListener: (cb: (msg: any) => void) => {
          listener = cb;
        },
      },
      onDisconnect: { addListener: vi.fn(), removeListener: vi.fn() },
      disconnect: vi.fn(),
      postMessage: (msg: unknown) => {
        posted.push(msg);
        const next = queue.shift();
        if (!next || !listener) return;
        if (next.status) listener({ type: "STATUS", status: next.status });
        listener({ type: "RESULT", result: next.result });
      },
    };
  });
  return posted;
}

describe("formatQuickToken", () => {
  it("passes matching pairs through uppercased (multi-digit safe)", () => {
    const q = makeQuestion({ type: "matching" });
    expect(formatQuickToken(q, "a-10, b-5")).toBe("A-10, B-5");
  });

  it("maps true-false answers to V/F", () => {
    const q = makeQuestion({
      type: "true-false",
      options: [
        { letter: "V", text: "Verdadero" },
        { letter: "F", text: "Falso" },
      ],
    });
    expect(formatQuickToken(q, "La respuesta es Verdadero")).toBe("V");
    expect(formatQuickToken(q, "Falso")).toBe("F");
  });

  it("extracts single MCQ letters", () => {
    const q = makeQuestion();
    expect(formatQuickToken(q, "Creo que es la B")).toBe("B");
  });

  it("extracts multi-letter MCQ answers", () => {
    const q = makeQuestion();
    expect(formatQuickToken(q, "A, C")).toBe("A,C");
    expect(formatQuickToken(q, "A / C")).toBe("A,C");
  });

  it("returns ? when no letter found", () => {
    const q = makeQuestion();
    expect(formatQuickToken(q, "no tengo idea")).toBe("?");
  });

  it("passes gap-fill answers through untouched", () => {
    const q = makeQuestion({ type: "select-missing-words" });
    expect(formatQuickToken(q, "[[1]]=HTTP, [[2]]=80")).toBe(
      "[[1]]=HTTP, [[2]]=80",
    );
  });

  it("truncates long free-text answers", () => {
    const q = makeQuestion({ type: "short-answer" });
    const token = formatQuickToken(q, "x".repeat(60));
    expect(token.length).toBeLessThanOrEqual(48);
    expect(token.endsWith("…")).toBe(true);
  });

  it("returns ? for empty free-text answers", () => {
    const q = makeQuestion({ type: "short-answer" });
    expect(formatQuickToken(q, "   ")).toBe("?");
  });
});

describe("buildQuickContext", () => {
  it("builds matching context with categories and options", () => {
    const q = makeQuestion({
      type: "matching",
      categories: [{ letter: "A", text: "Uno" }],
      matchingOptions: [{ index: 1, text: "One" }],
    });
    const ctx = buildQuickContext(q, [], false);
    expect(ctx.questionType).toBe("matching");
    expect(ctx.categories).toEqual([{ letter: "A", text: "Uno" }]);
    expect(ctx.responseMode).toBe("quick");
    expect(ctx.skipPrimary).toBe(false);
  });

  it("maps true-false and multiple-choice types", () => {
    expect(
      buildQuickContext(makeQuestion({ type: "true-false" }), [], false)
        .questionType,
    ).toBe("true-false");
    expect(
      buildQuickContext(makeQuestion({ type: "multiple-choice" }), [], false)
        .questionType,
    ).toBe("multiple-choice");
    expect(
      buildQuickContext(makeQuestion({ type: "short-answer" }), [], false)
        .questionType,
    ).toBe("short-answer");
  });

  it("passes skipPrimary through", () => {
    const ctx = buildQuickContext(makeQuestion(), [], true);
    expect(ctx.skipPrimary).toBe(true);
  });
});

describe("sendQuickAnalysis", () => {
  beforeEach(() => {
    document.body.innerHTML = `<div id="study-assist-quick-container"><div id="study-assist-quick"><span>SA</span></div></div>`;
  });

  it("resolves with RESULT and shows STATUS emoji on the button", async () => {
    stubQuickPort([
      {
        status: "VALIDATOR_FALLBACK",
        result: { success: true, result: "B" },
      },
    ]);
    const ctx = buildQuickContext(makeQuestion(), [], false);
    const response = await sendQuickAnalysis(ctx);

    expect(response).toEqual({ success: true, result: "B" });
    const btn = document.getElementById("study-assist-quick")!;
    expect(btn.innerHTML).toContain("🔄");
  });
});

describe("handleQuickMulti", () => {
  const callbacks = {
    detectVisibleQuestion: async () => null,
    startQuestionChangeObserver: vi.fn(),
  };

  beforeEach(() => {
    document.body.innerHTML = `<div id="study-assist-quick-container"><div id="study-assist-quick"><span>SA</span></div></div>`;
    state.isRequestInProgress = true; // caller holds the lock
    state.hasValidAnswer = false;
    state.requestCancelled = false;
    state.slowConnectionTimer = null;
    state.lastAnsweredQuestionNum = null;
    state.skipPrimary = false;
    state.pendingQuestionChange = null;
    callbacks.startQuestionChangeObserver.mockClear();
  });

  it("renders QNUM:TOKEN lines vertically with matching style", async () => {
    stubQuickPort([
      { result: { success: true, result: "Verdadero" } },
      { result: { success: true, result: "B" } },
      { result: { success: true, result: "C" } },
    ]);
    const questions = [
      makeQuestion({
        type: "true-false",
        questionNumber: 4,
        text: "Q4?",
        options: [
          { letter: "V", text: "Verdadero" },
          { letter: "F", text: "Falso" },
        ],
      }),
      makeQuestion({ type: "multiple-choice", questionNumber: 5, text: "Q5?" }),
      makeQuestion({ type: "multiple-choice", questionNumber: 6, text: "Q6?" }),
    ];

    await handleQuickMulti(questions, callbacks as any);

    const btn = document.getElementById("study-assist-quick")!;
    const lines = btn.textContent!.split("\n");
    expect(lines).toEqual(["4:V", "5:B", "6:C"]);
    expect(btn.classList.contains("has-answer")).toBe(true);
    expect(btn.classList.contains("matching-answer")).toBe(true);
    expect(state.hasValidAnswer).toBe(true);
    expect(state.lastAnsweredQuestionNum).toBe(4);
    expect(callbacks.startQuestionChangeObserver).toHaveBeenCalled();
  });

  it("marks failed questions with ? but still shows the rest", async () => {
    stubQuickPort([
      { result: { success: true, result: "B" } },
      { result: { success: false, error: "boom" } },
    ]);
    const questions = [
      makeQuestion({ type: "multiple-choice", questionNumber: 5 }),
      makeQuestion({ type: "multiple-choice", questionNumber: 6 }),
    ];

    await handleQuickMulti(questions, callbacks as any);

    const btn = document.getElementById("study-assist-quick")!;
    expect(btn.textContent!.split("\n")).toEqual(["5:B", "6:?"]);
    expect(state.hasValidAnswer).toBe(true);
  });

  it("shows ! when every question fails", async () => {
    stubQuickPort([{ result: { success: false, error: "boom" } }]);
    await handleQuickMulti(
      [makeQuestion({ questionNumber: 5 })],
      callbacks as any,
    );

    const btn = document.getElementById("study-assist-quick")!;
    expect(btn.innerHTML).toContain("!");
    expect(state.hasValidAnswer).toBe(false);
  });
});
