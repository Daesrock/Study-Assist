/**
 * Tests for Moodle Question Detection
 * Covers: multiple-choice, true/false, with images, multi-answer
 */

import { describe, it, expect, beforeEach, vi } from "vitest";

// We need to mock the state module before importing detection
vi.mock("../../src/content/modules/state", () => ({
  DEBUG_MODE: false,
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
  isPublicImageUrl: vi.fn((src: string) => {
    if (!src) return false;
    try {
      const url = new URL(src);
      if (url.protocol !== "https:" && url.protocol !== "http:") return false;
      const host = url.hostname.toLowerCase();
      if (host === "localhost" || host === "127.0.0.1") return false;
      return true;
    } catch {
      return false;
    }
  }),
}));

import { detectQuestionsOnPage, detectMoodleQuestions } from "../../src/content/modules/detection";
import { state } from "../../src/content/modules/state";

describe("Moodle Question Detection", () => {
  beforeEach(() => {
    // Reset DOM
    document.body.innerHTML = "";
    // Reset detected questions
    state.detectedQuestions = [];
    state.isActive = true;
  });

  describe("Multiple Choice Questions", () => {
    it("should detect a basic multiple-choice question", async () => {
      document.body.innerHTML = `
        <div class="que multichoice">
          <span class="qno">1</span>
          <div class="qtext">What layer of the OSI model handles routing?</div>
          <div class="answer">
            <div class="r0">
              <span class="answernumber">a.</span>
              <div class="flex-fill">Physical Layer</div>
            </div>
            <div class="r1">
              <span class="answernumber">b.</span>
              <div class="flex-fill">Data Link Layer</div>
            </div>
            <div class="r0">
              <span class="answernumber">c.</span>
              <div class="flex-fill">Network Layer</div>
            </div>
            <div class="r1">
              <span class="answernumber">d.</span>
              <div class="flex-fill">Transport Layer</div>
            </div>
          </div>
        </div>
      `;

      await detectMoodleQuestions();

      expect(state.detectedQuestions).toHaveLength(1);
      const q = state.detectedQuestions[0];
      expect(q.platform).toBe("moodle");
      expect(q.type).toBe("multiple-choice");
      expect(q.text).toContain("OSI model");
      expect(q.options).toHaveLength(4);
      expect(q.options[0].letter).toBe("A");
      expect(q.options[0].text).toBe("Physical Layer");
      expect(q.options[2].letter).toBe("C");
      expect(q.options[2].text).toBe("Network Layer");
      expect(q.questionNumber).toBe(1);
      expect(q.confidence).toBe(95);
    });

    it("should detect multiple questions on the same page", async () => {
      document.body.innerHTML = `
        <div class="que multichoice">
          <span class="qno">1</span>
          <div class="qtext">Question 1?</div>
          <div class="answer">
            <div class="r0"><span class="answernumber">a.</span><div class="flex-fill">A</div></div>
            <div class="r1"><span class="answernumber">b.</span><div class="flex-fill">B</div></div>
          </div>
        </div>
        <div class="que multichoice">
          <span class="qno">2</span>
          <div class="qtext">Question 2?</div>
          <div class="answer">
            <div class="r0"><span class="answernumber">a.</span><div class="flex-fill">X</div></div>
            <div class="r1"><span class="answernumber">b.</span><div class="flex-fill">Y</div></div>
          </div>
        </div>
      `;

      await detectMoodleQuestions();

      expect(state.detectedQuestions).toHaveLength(2);
      expect(state.detectedQuestions[0].questionNumber).toBe(1);
      expect(state.detectedQuestions[1].questionNumber).toBe(2);
    });

    it("should handle questions with data-region answer labels", async () => {
      document.body.innerHTML = `
        <div class="que multichoice">
          <span class="qno">1</span>
          <div class="qtext">Which protocol uses port 80?</div>
          <div class="answer">
            <div class="r0">
              <span class="answernumber">a.</span>
              <div data-region="answer-label"><div>HTTP</div></div>
            </div>
            <div class="r1">
              <span class="answernumber">b.</span>
              <div data-region="answer-label"><div>HTTPS</div></div>
            </div>
          </div>
        </div>
      `;

      await detectMoodleQuestions();

      expect(state.detectedQuestions).toHaveLength(1);
      const q = state.detectedQuestions[0];
      expect(q.options).toHaveLength(2);
      expect(q.options[0].text).toBe("HTTP");
      expect(q.options[1].text).toBe("HTTPS");
    });
  });

  describe("True/False Questions", () => {
    it("should detect a true/false question", async () => {
      document.body.innerHTML = `
        <div class="que truefalse">
          <span class="qno">3</span>
          <div class="qtext">A switch operates at Layer 2 of the OSI model.</div>
          <div class="answer">
            <div class="r0">
              <span class="answernumber">a.</span>
              <div class="flex-fill">True</div>
            </div>
            <div class="r1">
              <span class="answernumber">b.</span>
              <div class="flex-fill">False</div>
            </div>
          </div>
        </div>
      `;

      await detectMoodleQuestions();

      expect(state.detectedQuestions).toHaveLength(1);
      const q = state.detectedQuestions[0];
      expect(q.type).toBe("true-false");
      expect(q.text).toContain("Layer 2");
      expect(q.options).toHaveLength(2);
      expect(q.options[0].letter).toBe("V");
      expect(q.options[1].letter).toBe("F");
      expect(q.options[0].text).toBe("True");
      expect(q.options[1].text).toBe("False");
      expect(q.questionNumber).toBe(3);
    });

    it("should detect Moodle true/false format with label-only options", async () => {
      document.body.innerHTML = `
        <div class="que truefalse">
          <span class="qno">14</span>
          <div class="qtext">Entrada o insumo o impulso (input) no es la fuerza de arranque del sistema.</div>
          <div class="answer">
            <div class="r0">
              <input type="radio" name="q14_answer" value="1" id="q14_answertrue">
              <label for="q14_answertrue" class="ms-1">Verdadero</label>
            </div>
            <div class="r1">
              <input type="radio" name="q14_answer" value="0" id="q14_answerfalse">
              <label for="q14_answerfalse" class="ms-1">Falso</label>
            </div>
          </div>
        </div>
      `;

      await detectMoodleQuestions();

      expect(state.detectedQuestions).toHaveLength(1);
      const q = state.detectedQuestions[0];
      expect(q.type).toBe("true-false");
      expect(q.options).toHaveLength(2);
      expect(q.options[0].letter).toBe("V");
      expect(q.options[0].text).toBe("Verdadero");
      expect(q.options[1].letter).toBe("F");
      expect(q.options[1].text).toBe("Falso");
    });
  });

  describe("Questions with Images", () => {
    it("should detect question with image in qtext", async () => {
      document.body.innerHTML = `
        <div class="que multichoice">
          <span class="qno">5</span>
          <div class="qtext">
            Refer to the exhibit. What is the IP address of the router?
            <img src="data:image/png;base64,iVBOR..." width="400" height="300" alt="Network diagram">
          </div>
          <div class="answer">
            <div class="r0"><span class="answernumber">a.</span><div class="flex-fill">192.168.1.1</div></div>
            <div class="r1"><span class="answernumber">b.</span><div class="flex-fill">10.0.0.1</div></div>
          </div>
        </div>
      `;

      await detectMoodleQuestions();

      expect(state.detectedQuestions).toHaveLength(1);
      const q = state.detectedQuestions[0];
      expect(q.text).toContain("Refer to the exhibit");
      // Images array should exist (though may be empty since imageToBase64 is mocked)
      expect(q.options).toHaveLength(2);
    });
  });

  describe("Mixed Question Types on Same Page", () => {
    it("should detect both multichoice and truefalse questions", async () => {
      document.body.innerHTML = `
        <div class="que multichoice">
          <span class="qno">1</span>
          <div class="qtext">Which is a routing protocol?</div>
          <div class="answer">
            <div class="r0"><span class="answernumber">a.</span><div class="flex-fill">OSPF</div></div>
            <div class="r1"><span class="answernumber">b.</span><div class="flex-fill">ARP</div></div>
          </div>
        </div>
        <div class="que truefalse">
          <span class="qno">2</span>
          <div class="qtext">DHCP uses UDP.</div>
          <div class="answer">
            <div class="r0"><span class="answernumber">a.</span><div class="flex-fill">True</div></div>
            <div class="r1"><span class="answernumber">b.</span><div class="flex-fill">False</div></div>
          </div>
        </div>
      `;

      await detectMoodleQuestions();

      expect(state.detectedQuestions).toHaveLength(2);
      expect(state.detectedQuestions[0].type).toBe("multiple-choice");
      expect(state.detectedQuestions[1].type).toBe("true-false");
    });
  });

  describe("detectQuestionsOnPage integration", () => {
    it("should return detection result with found=true when questions exist", async () => {
      document.body.innerHTML = `
        <div class="que multichoice">
          <span class="qno">1</span>
          <div class="qtext">Test question?</div>
          <div class="answer">
            <div class="r0"><span class="answernumber">a.</span><div class="flex-fill">A</div></div>
            <div class="r1"><span class="answernumber">b.</span><div class="flex-fill">B</div></div>
          </div>
        </div>
      `;

      const result = await detectQuestionsOnPage();

      expect(result).toBeDefined();
      expect(result!.found).toBe(true);
      expect(result!.count).toBe(1);
    });

    it("should return found=false when no questions exist", async () => {
      document.body.innerHTML = "<div>No questions here</div>";

      const result = await detectQuestionsOnPage();

      expect(result).toBeDefined();
      expect(result!.found).toBe(false);
      expect(result!.count).toBe(0);
    });

    it("should return undefined when extension is inactive", async () => {
      state.isActive = false;

      const result = await detectQuestionsOnPage();
      expect(result).toBeUndefined();
    });
  });

  describe("Edge Cases", () => {
    it("should skip question with fewer than 2 options", async () => {
      document.body.innerHTML = `
        <div class="que multichoice">
          <span class="qno">1</span>
          <div class="qtext">A question with no answers div</div>
        </div>
      `;

      await detectMoodleQuestions();

      // Source requires at least 2 options to consider it a valid question
      expect(state.detectedQuestions).toHaveLength(0);
    });

    it("should handle question with no qno element", async () => {
      document.body.innerHTML = `
        <div class="que multichoice">
          <div class="qtext">Question without number?</div>
          <div class="answer">
            <div class="r0"><span class="answernumber">a.</span><div class="flex-fill">A</div></div>
            <div class="r1"><span class="answernumber">b.</span><div class="flex-fill">B</div></div>
          </div>
        </div>
      `;

      await detectMoodleQuestions();

      expect(state.detectedQuestions).toHaveLength(1);
      // questionNumber defaults to 1 when no qno element
      expect(state.detectedQuestions[0].questionNumber).toBe(1);
    });

    it("should handle empty qtext", async () => {
      document.body.innerHTML = `
        <div class="que multichoice">
          <span class="qno">1</span>
          <div class="qtext"></div>
          <div class="answer">
            <div class="r0"><span class="answernumber">a.</span><div class="flex-fill">Option A</div></div>
            <div class="r1"><span class="answernumber">b.</span><div class="flex-fill">Option B</div></div>
          </div>
        </div>
      `;

      await detectMoodleQuestions();
      // Empty qtext with no images = no valid content, should not detect
      expect(state.detectedQuestions).toHaveLength(0);
    });
  });

  describe("Course Name Extraction", () => {
    const createBasicQuestion = () => {
      document.body.innerHTML = `
        <div class="que multichoice">
          <span class="qno">1</span>
          <div class="qtext">Sample question text</div>
          <div class="answer">
            <div class="r0"><span class="answernumber">a.</span><div class="flex-fill">Option A</div></div>
            <div class="r1"><span class="answernumber">b.</span><div class="flex-fill">Option B</div></div>
          </div>
        </div>
      `;
    };

    it("should extract course name from document.title with standard format", async () => {
      document.title = "Cuestionario 3. UBUNTU: Sistemas Operativos";
      createBasicQuestion();

      await detectMoodleQuestions();

      expect(state.detectedQuestions).toHaveLength(1);
      expect(state.detectedQuestions[0].courseName).toBe("Sistemas Operativos");
    });

    it("should extract course name with multiple colons (use last one)", async () => {
      document.title = "Quiz 2: TCP/IP: Redes de Computadoras";
      createBasicQuestion();

      await detectMoodleQuestions();

      expect(state.detectedQuestions).toHaveLength(1);
      expect(state.detectedQuestions[0].courseName).toBe("Redes de Computadoras");
    });

    it("should return undefined when title has no colon", async () => {
      document.title = "Just a title without course";
      createBasicQuestion();

      await detectMoodleQuestions();

      expect(state.detectedQuestions).toHaveLength(1);
      expect(state.detectedQuestions[0].courseName).toBeUndefined();
    });

    it("should return undefined when course name is too short", async () => {
      document.title = "Quiz: AB";
      createBasicQuestion();

      await detectMoodleQuestions();

      expect(state.detectedQuestions).toHaveLength(1);
      expect(state.detectedQuestions[0].courseName).toBeUndefined();
    });

    it("should trim whitespace from course name", async () => {
      document.title = "Examen:   Programación Avanzada   ";
      createBasicQuestion();

      await detectMoodleQuestions();

      expect(state.detectedQuestions).toHaveLength(1);
      expect(state.detectedQuestions[0].courseName).toBe("Programación Avanzada");
    });

    it("should handle course name with special characters", async () => {
      document.title = "Quiz: Sistemas Operativos I - GNU/Linux";
      createBasicQuestion();

      await detectMoodleQuestions();

      expect(state.detectedQuestions).toHaveLength(1);
      expect(state.detectedQuestions[0].courseName).toBe("Sistemas Operativos I - GNU/Linux");
    });

    it("should return undefined when colon is at the end", async () => {
      document.title = "Quiz title:";
      createBasicQuestion();

      await detectMoodleQuestions();

      expect(state.detectedQuestions).toHaveLength(1);
      expect(state.detectedQuestions[0].courseName).toBeUndefined();
    });

    it("should work with different Moodle title formats", async () => {
      document.title = "Intento de cuestionario: Fundamentos de Redes";
      createBasicQuestion();

      await detectMoodleQuestions();

      expect(state.detectedQuestions).toHaveLength(1);
      expect(state.detectedQuestions[0].courseName).toBe("Fundamentos de Redes");
    });

    it("should work with English course names", async () => {
      document.title = "Quiz attempt: Operating Systems";
      createBasicQuestion();

      await detectMoodleQuestions();

      expect(state.detectedQuestions).toHaveLength(1);
      expect(state.detectedQuestions[0].courseName).toBe("Operating Systems");
    });
  });
});
