/**
 * Tests for Moodle multi-question pages (several .que visible at once).
 * Fixture modeled on a real educa-t exam page with Preguntas 4, 5, 6 (+7 match).
 */

import { describe, it, expect, beforeEach, vi, afterEach } from "vitest";

// We need to mock the state module before importing detection
vi.mock("../../src/content/modules/state", () => ({
  DEBUG_MODE: true,
  log: vi.fn(),
  state: {
    isActive: true,
    isDomainAllowed: true,
    isInitialized: true,
    settings: {
      responseMode: "quick",
      autoDetect: true,
      highlightQuestions: true,
      quickMode: true,
      sendImages: false,
    },
    detectedQuestions: [],
    currentVisibleQuestion: null,
    overlayVisible: false,
    contentObserver: null,
    lastAnsweredQuestionNum: null,
    questionChangeObserver: null,
    questionChangeInterval: null,
    isRequestInProgress: false,
    hasValidAnswer: false,
    skipDeepSeek: false,
    slowConnectionTimer: null,
    requestCancelled: false,
    pendingQuestionChange: null,
  },
  DEFAULT_ALLOWED_DOMAINS: ["netacad.com"],
}));

// Mock images module
vi.mock("../../src/content/modules/images", () => ({
  extractImagesAsBase64: vi.fn(async () => []),
  imageToBase64: vi.fn(async () => null),
  isPublicImageUrl: vi.fn(() => false),
}));

import {
  detectMoodleQuestions,
  detectVisibleQuestions,
} from "../../src/content/modules/detection";
import { state } from "../../src/content/modules/state";

const THREE_QUESTION_PAGE = `
  <div class="que truefalse" id="question-2492727-20">
    <h3 class="no">Pregunta <span class="qno">4</span></h3>
    <div class="qtext"><p>La seguridad activa se utiliza dia a dia para evitar ataques</p></div>
    <div class="answer">
      <div class="r0"><input type="radio" name="q2492727:20_answer" value="1"><label>Verdadero</label></div>
      <div class="r1"><input type="radio" name="q2492727:20_answer" value="0"><label>Falso</label></div>
    </div>
  </div>
  <div class="que multichoice" id="question-2492727-9">
    <h3 class="no">Pregunta <span class="qno">5</span></h3>
    <div class="qtext"><p>Consiste en asegurar los recursos del sistema</p></div>
    <div class="answer">
      <div class="r0"><span class="answernumber">a. </span><div class="flex-fill">Base de datos</div></div>
      <div class="r1"><span class="answernumber">b. </span><div class="flex-fill">Seguridad Informatica</div></div>
      <div class="r0"><span class="answernumber">c. </span><div class="flex-fill">Derecho Informatico</div></div>
      <div class="r1"><span class="answernumber">d. </span><div class="flex-fill">Auditoria Informatica</div></div>
    </div>
  </div>
  <div class="que multichoice" id="question-2492727-6">
    <h3 class="no">Pregunta <span class="qno">6</span></h3>
    <div class="qtext"><p>Las acciones de esta fase deben darse regularmente</p></div>
    <div class="answer">
      <div class="r0"><span class="answernumber">a. </span><div class="flex-fill">Verificar</div></div>
      <div class="r1"><span class="answernumber">b. </span><div class="flex-fill">Hacer</div></div>
      <div class="r0"><span class="answernumber">c. </span><div class="flex-fill">Actuar</div></div>
      <div class="r1"><span class="answernumber">d. </span><div class="flex-fill">Planificar</div></div>
    </div>
  </div>
  <div class="que match" id="question-2492727-7">
    <h3 class="no">Pregunta <span class="qno">7</span></h3>
    <div class="qtext"><p>Relaciona cada concepto con su respuesta</p></div>
    <div class="ablock"><table class="answer"><tbody>
      <tr><td class="text">Concepto uno</td><td class="control"><select><option value="0">Elegir...</option><option value="1">Definicion uno</option><option value="2">Definicion dos</option></select></td></tr>
      <tr><td class="text">Concepto dos</td><td class="control"><select><option value="0">Elegir...</option><option value="1">Definicion uno</option><option value="2">Definicion dos</option></select></td></tr>
    </tbody></table></div>
  </div>
`;

describe("Moodle multi-question pages", () => {
  beforeEach(() => {
    document.body.innerHTML = "";
    state.detectedQuestions = [];
    state.isActive = true;
    Object.defineProperty(window, "innerHeight", {
      value: 800,
      configurable: true,
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("detects all questions with real numbers and types", async () => {
    document.body.innerHTML = THREE_QUESTION_PAGE;
    await detectMoodleQuestions();

    expect(state.detectedQuestions).toHaveLength(4);
    expect(state.detectedQuestions.map((q) => q.questionNumber)).toEqual([
      4, 5, 6, 7,
    ]);
    expect(state.detectedQuestions.map((q) => q.type)).toEqual([
      "true-false",
      "multiple-choice",
      "multiple-choice",
      "matching",
    ]);
  });

  it("detectVisibleQuestions returns all in DOM order (jsdom fallback)", async () => {
    document.body.innerHTML = THREE_QUESTION_PAGE;
    const results = await detectVisibleQuestions();

    expect(results.map((q) => q.questionNumber)).toEqual([4, 5, 6, 7]);
  });

  it("orders by vertical position and excludes off-viewport questions", async () => {
    document.body.innerHTML = THREE_QUESTION_PAGE;
    const tops: Record<string, number> = {
      "question-2492727-20": 500,
      "question-2492727-9": 100,
      "question-2492727-6": 300,
      // question-2492727-7 below the 800px viewport -> excluded
      "question-2492727-7": 950,
    };
    vi.spyOn(Element.prototype, "getBoundingClientRect").mockImplementation(
      function (this: Element) {
        const top = tops[(this as HTMLElement).id];
        if (top === undefined) {
          return {
            width: 0, height: 0, top: 0, bottom: 0,
            left: 0, right: 0, x: 0, y: 0, toJSON: () => ({}),
          } as DOMRect;
        }
        return {
          width: 600, height: 200, top, bottom: top + 200,
          left: 0, right: 600, x: 0, y: top, toJSON: () => ({}),
        } as DOMRect;
      },
    );

    const results = await detectVisibleQuestions();

    // Sorted top-to-bottom: q5 (100), q6 (300), q4 (500); q7 excluded
    expect(results.map((q) => q.questionNumber)).toEqual([5, 6, 4]);
  });

  it("returns [] when no .que elements exist", async () => {
    document.body.innerHTML = `<div class="no-quiz-here"><p>Hello</p></div>`;
    const results = await detectVisibleQuestions();
    expect(results).toEqual([]);
  });

  it("extracts matching categories and multi-digit option values", async () => {
    document.body.innerHTML = THREE_QUESTION_PAGE;
    const results = await detectVisibleQuestions();
    const match = results.find((q) => q.type === "matching");

    expect(match).toBeDefined();
    expect(match!.categories!.map((c) => c.letter)).toEqual(["A", "B"]);
    expect(match!.matchingOptions!.map((o) => o.index)).toEqual([1, 2]);
  });
});
