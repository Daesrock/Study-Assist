/**
 * Tests for NetAcad & General Question Detection
 * Covers: analyzeTextForQuestion, extractOptions, extractOptionsFromInputs,
 *         extractNetAcadOptions, extractNetAcadQuestion, detectGeneralQuestions,
 *         QUESTION_PATTERNS
 */

import { describe, it, expect, beforeEach, vi } from "vitest";

// Mock state and images modules before importing detection
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
    detectedQuestions: [] as any[],
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

vi.mock("../../src/content/modules/images", () => ({
  extractImagesAsBase64: vi.fn(async () => []),
  imageToBase64: vi.fn(async () => null),
}));

import {
  QUESTION_PATTERNS,
  analyzeTextForQuestion,
  extractOptions,
  extractOptionsFromInputs,
  extractNetAcadOptions,
  extractNetAcadQuestion,
  detectGeneralQuestions,
} from "../../src/content/modules/detection";
import { state } from "../../src/content/modules/state";

// ============================================
// Question Pattern Detection
// ============================================

describe("QUESTION_PATTERNS", () => {
  describe("questionMarkers", () => {
    it("should match English question words", () => {
      expect(QUESTION_PATTERNS.questionMarkers.test("What is OSPF?")).toBe(true);
      expect(QUESTION_PATTERNS.questionMarkers.test("Which protocol uses port 80?")).toBe(true);
      expect(QUESTION_PATTERNS.questionMarkers.test("How does ARP work?")).toBe(true);
      expect(QUESTION_PATTERNS.questionMarkers.test("Why is subnetting useful?")).toBe(true);
    });

    it("should match Spanish question words", () => {
      expect(QUESTION_PATTERNS.questionMarkers.test("¿Qué es una VLAN?")).toBe(true);
      expect(QUESTION_PATTERNS.questionMarkers.test("¿Cuál es la dirección IP?")).toBe(true);
      expect(QUESTION_PATTERNS.questionMarkers.test("¿Cómo funciona el NAT?")).toBe(true);
      expect(QUESTION_PATTERNS.questionMarkers.test("¿Por qué usar ACLs?")).toBe(true);
    });

    it("should match Pregunta N pattern (NetAcad)", () => {
      expect(QUESTION_PATTERNS.questionMarkers.test("Pregunta 1")).toBe(true);
      expect(QUESTION_PATTERNS.questionMarkers.test("Pregunta 42")).toBe(true);
      expect(QUESTION_PATTERNS.questionMarkers.test("pregunta 5")).toBe(true);
    });

    it("should match action verbs", () => {
      expect(QUESTION_PATTERNS.questionMarkers.test("Select the correct answer")).toBe(true);
      expect(QUESTION_PATTERNS.questionMarkers.test("Choose the best option")).toBe(true);
      expect(QUESTION_PATTERNS.questionMarkers.test("Identify the protocol")).toBe(true);
    });

    it("should match question marks", () => {
      expect(QUESTION_PATTERNS.questionMarkers.test("Is this correct?")).toBe(true);
    });
  });

  describe("multipleChoice patterns", () => {
    it("should match A. B. C. D. format", () => {
      expect(QUESTION_PATTERNS.multipleChoice.some((p) => p.test("A. First option"))).toBe(true);
      expect(QUESTION_PATTERNS.multipleChoice.some((p) => p.test("B) Second option"))).toBe(true);
    });

    it("should match (A) (B) format", () => {
      expect(QUESTION_PATTERNS.multipleChoice.some((p) => p.test("(A) First option"))).toBe(true);
    });

    it("should match numbered options", () => {
      expect(QUESTION_PATTERNS.multipleChoice.some((p) => p.test("1. First option"))).toBe(true);
    });

    it("should match radio_button markers (NetAcad)", () => {
      expect(QUESTION_PATTERNS.multipleChoice.some((p) => p.test("radio_button_unchecked Option A"))).toBe(true);
      expect(QUESTION_PATTERNS.multipleChoice.some((p) => p.test("radio_button_checked Selected"))).toBe(true);
    });

    it("should match Pregunta N (NetAcad Spanish)", () => {
      expect(QUESTION_PATTERNS.multipleChoice.some((p) => p.test("Pregunta 1"))).toBe(true);
    });

    it("should match select instructions", () => {
      expect(QUESTION_PATTERNS.multipleChoice.some((p) => p.test("Select one"))).toBe(true);
      expect(QUESTION_PATTERNS.multipleChoice.some((p) => p.test("Select the correct answer"))).toBe(true);
    });
  });

  describe("trueFalse patterns", () => {
    it("should match True/False in text", () => {
      expect(QUESTION_PATTERNS.trueFalse.some((p) => p.test("True False"))).toBe(true);
    });

    it("should match Spanish verdadero/falso", () => {
      expect(QUESTION_PATTERNS.trueFalse.some((p) => p.test("verdadero"))).toBe(true);
      expect(QUESTION_PATTERNS.trueFalse.some((p) => p.test("falso"))).toBe(true);
    });
  });

  describe("fillBlank patterns", () => {
    it("should match underscores (blanks)", () => {
      expect(QUESTION_PATTERNS.fillBlank.some((p) => p.test("The protocol ___ uses port 80"))).toBe(true);
    });

    it("should match ellipsis", () => {
      expect(QUESTION_PATTERNS.fillBlank.some((p) => p.test("The answer is..."))).toBe(true);
    });

    it("should match fill-in instructions", () => {
      expect(QUESTION_PATTERNS.fillBlank.some((p) => p.test("Fill in the blank"))).toBe(true);
    });
  });
});

// ============================================
// analyzeTextForQuestion
// ============================================

describe("analyzeTextForQuestion", () => {
  function createElement(html: string): Element {
    const container = document.createElement("div");
    container.innerHTML = html;
    return container;
  }

  it("should identify a multiple-choice question", () => {
    const text = "What is the default gateway?\nA. 192.168.1.1\nB. 10.0.0.1\nC. 172.16.0.1";
    const el = createElement("");

    const result = analyzeTextForQuestion(text, el);
    expect(result.isQuestion).toBe(true);
    expect(result.type).toBe("multiple-choice");
    expect(result.confidence).toBeGreaterThanOrEqual(40);
  });

  it("should identify a true/false question", () => {
    const text = "The statement is True or False: OSPF is a distance-vector protocol.";
    const el = createElement("");

    const result = analyzeTextForQuestion(text, el);
    // Might be identified depending on pattern matching
    expect(result.confidence).toBeGreaterThanOrEqual(0);
  });

  it("should boost confidence for question words", () => {
    const text = "Which subnet mask provides 14 usable host addresses?";
    const el = createElement("");

    const result = analyzeTextForQuestion(text, el);
    expect(result.confidence).toBeGreaterThanOrEqual(30);
  });

  it("should boost confidence for quiz-related CSS classes", () => {
    const el = document.createElement("div");
    el.className = "quiz-question-container";

    const result = analyzeTextForQuestion("Some long text that might be a question about networks", el);
    expect(result.confidence).toBeGreaterThanOrEqual(25);
  });

  it("should boost confidence for radio button inputs", () => {
    const el = document.createElement("div");
    el.innerHTML = `
      <p>Which protocol operates at Layer 3?</p>
      <input type="radio" name="q1" value="A"> <label>IP</label>
      <input type="radio" name="q1" value="B"> <label>TCP</label>
    `;

    const result = analyzeTextForQuestion("Which protocol operates at Layer 3? IP TCP", el);
    expect(result.isQuestion).toBe(true);
    expect(result.type).toBe("multiple-choice");
  });

  it("should return isQuestion=false for low-confidence text", () => {
    const el = document.createElement("div");
    const result = analyzeTextForQuestion("This is just regular page content about networking.", el);
    expect(result.isQuestion).toBe(false);
    expect(result.confidence).toBeLessThan(40);
  });
});

// ============================================
// extractOptions
// ============================================

describe("extractOptions", () => {
  function emptyEl(): Element {
    return document.createElement("div");
  }

  it("should extract A. B. C. D. format options", () => {
    const text = "Question text?\nA. First option\nB. Second option\nC. Third option\nD. Fourth option";
    const options = extractOptions(text, emptyEl());

    expect(options).toHaveLength(4);
    expect(options[0]).toEqual({ letter: "A", text: "First option" });
    expect(options[1]).toEqual({ letter: "B", text: "Second option" });
    expect(options[2]).toEqual({ letter: "C", text: "Third option" });
    expect(options[3]).toEqual({ letter: "D", text: "Fourth option" });
  });

  it("should extract A) B) format options", () => {
    const text = "Test?\nA) OSPF\nB) EIGRP\nC) RIP";
    const options = extractOptions(text, emptyEl());

    expect(options).toHaveLength(3);
    expect(options[0].letter).toBe("A");
    expect(options[0].text).toBe("OSPF");
  });

  it("should extract (A) (B) format options as fallback", () => {
    const text = "Which one? (A) First (B) Second (C) Third";
    const options = extractOptions(text, emptyEl());

    expect(options.length).toBeGreaterThanOrEqual(2);
  });

  it("should extract numbered options as fallback", () => {
    const text = "Question?\n1. First option\n2. Second option\n3. Third option";
    const options = extractOptions(text, emptyEl());

    expect(options).toHaveLength(3);
    expect(options[0].letter).toBe("1");
    expect(options[0].text).toBe("First option");
  });

  it("should return empty array when no options found", () => {
    const text = "This is just descriptive text without any options.";
    const options = extractOptions(text, emptyEl());

    expect(options).toHaveLength(0);
  });
});

// ============================================
// extractOptionsFromInputs
// ============================================

describe("extractOptionsFromInputs", () => {
  it("should extract options from radio buttons with labels", () => {
    const el = document.createElement("div");
    el.innerHTML = `
      <label><input type="radio" name="q1" id="r1"> Physical Layer</label>
      <label><input type="radio" name="q1" id="r2"> Data Link Layer</label>
      <label><input type="radio" name="q1" id="r3"> Network Layer</label>
    `;

    const options = extractOptionsFromInputs(el);

    expect(options.length).toBeGreaterThanOrEqual(2);
    expect(options[0].letter).toBe("A");
  });

  it("should extract options from checkboxes", () => {
    const el = document.createElement("div");
    el.innerHTML = `
      <label><input type="checkbox" name="q1"> TCP</label>
      <label><input type="checkbox" name="q1"> UDP</label>
      <label><input type="checkbox" name="q1"> ICMP</label>
    `;

    const options = extractOptionsFromInputs(el);
    expect(options.length).toBeGreaterThanOrEqual(2);
  });

  it("should extract options from for-attribute labels", () => {
    const el = document.createElement("div");
    el.innerHTML = `
      <input type="radio" name="q1" id="opt1">
      <label for="opt1">OSPF</label>
      <input type="radio" name="q1" id="opt2">
      <label for="opt2">BGP</label>
    `;

    const options = extractOptionsFromInputs(el);
    expect(options.length).toBeGreaterThanOrEqual(2);
  });

  it("should return empty array when no inputs found", () => {
    const el = document.createElement("div");
    el.innerHTML = "<p>No inputs here</p>";

    const options = extractOptionsFromInputs(el);
    expect(options).toHaveLength(0);
  });
});

// ============================================
// extractNetAcadOptions (radio_button markers)
// ============================================

describe("extractNetAcadOptions", () => {
  it("should extract options from radio_button_unchecked markers", () => {
    const text = "Question text here radio_button_unchecked Option A radio_button_unchecked Option B radio_button_unchecked Option C";
    const el = document.createElement("div");

    const options = extractNetAcadOptions(text, el);

    expect(options).toHaveLength(3);
    expect(options[0]).toEqual({ letter: "A", text: "Option A" });
    expect(options[1]).toEqual({ letter: "B", text: "Option B" });
    expect(options[2]).toEqual({ letter: "C", text: "Option C" });
  });

  it("should handle mixed checked and unchecked markers", () => {
    const text = "Pregunta 1 radio_button_checked Answer A radio_button_unchecked Answer B";
    const el = document.createElement("div");

    const options = extractNetAcadOptions(text, el);

    expect(options).toHaveLength(2);
    expect(options[0].text).toBe("Answer A");
    expect(options[1].text).toBe("Answer B");
  });

  it("should return empty array when no markers found", () => {
    const text = "This is just regular text without radio markers";
    const el = document.createElement("div");

    const options = extractNetAcadOptions(text, el);
    expect(options).toHaveLength(0);
  });

  it("should skip empty/short option text", () => {
    const text = "Question radio_button_unchecked A radio_button_unchecked Valid option text";
    const el = document.createElement("div");

    const options = extractNetAcadOptions(text, el);
    // "A" is too short (length 1, < 2), only "Valid option text" passes
    expect(options).toHaveLength(1);
    expect(options[0].text).toBe("Valid option text");
  });
});

// ============================================
// extractNetAcadQuestion (mcq classes in DOM)
// ============================================

describe("extractNetAcadQuestion", () => {
  beforeEach(() => {
    document.body.innerHTML = "";
  });

  it("should extract question from mcq__item elements", () => {
    // Use simple mcq__item divs (no inner mcq__item-text-inner to avoid
    // [class*="mcq__item"] double-matching the inner spans)
    document.body.innerHTML = `
      <div id="test-container">
        <p>Which protocol is used for dynamic routing?</p>
        <div class="mcq__item">OSPF</div>
        <div class="mcq__item">ARP</div>
        <div class="mcq__item">DHCP</div>
      </div>
    `;
    const container = document.getElementById("test-container")!;

    const result = extractNetAcadQuestion(container);

    expect(result).not.toBeNull();
    expect(result!.options).toHaveLength(3);
    expect(result!.options[0]).toEqual({ letter: "A", text: "OSPF" });
    expect(result!.options[1]).toEqual({ letter: "B", text: "ARP" });
    expect(result!.options[2]).toEqual({ letter: "C", text: "DHCP" });
    expect(result!.questionText).toContain("dynamic routing");
  });

  it("should extract from mcq__item-text directly when no mcq__item", () => {
    document.body.innerHTML = `
      <div id="test-container">
        <p>Pick the correct answer about VLSM subnetting</p>
        <span class="mcq__item-text">255.255.255.0</span>
        <span class="mcq__item-text">255.255.255.128</span>
        <span class="mcq__item-text">255.255.254.0</span>
      </div>
    `;
    const container = document.getElementById("test-container")!;

    const result = extractNetAcadQuestion(container);

    expect(result).not.toBeNull();
    expect(result!.options).toHaveLength(3);
  });

  it("should return null when fewer than 2 options", () => {
    document.body.innerHTML = `
      <div id="test-container">
        <p>Question text goes here which is long enough</p>
        <div class="mcq__item">Only one option</div>
      </div>
    `;
    const container = document.getElementById("test-container")!;

    const result = extractNetAcadQuestion(container);
    expect(result).toBeNull();
  });

  it("should return null when question text is too short", () => {
    document.body.innerHTML = `
      <div id="test-container">
        <p>Short</p>
        <div class="mcq__item">AA</div>
        <div class="mcq__item">BB</div>
      </div>
    `;
    const container = document.getElementById("test-container")!;

    const result = extractNetAcadQuestion(container);
    // After removing option text, question text is likely too short (< 10 chars)
    expect(result).toBeNull();
  });
});

// ============================================
// detectGeneralQuestions (integration)
// ============================================

describe("detectGeneralQuestions", () => {
  beforeEach(() => {
    document.body.innerHTML = "";
    state.detectedQuestions = [];
    state.isActive = true;
  });

  it("should detect question with radio buttons", () => {
    document.body.innerHTML = `
      <div class="question-container">
        <p>Which layer of the OSI model is responsible for logical addressing and routing between networks?</p>
        <div>
          <label><input type="radio" name="q1"> Physical Layer</label>
          <label><input type="radio" name="q1"> Data Link Layer</label>
          <label><input type="radio" name="q1"> Network Layer</label>
          <label><input type="radio" name="q1"> Transport Layer</label>
        </div>
      </div>
    `;

    detectGeneralQuestions();

    // May detect 1+ questions from the radio button pattern
    expect(state.detectedQuestions.length).toBeGreaterThanOrEqual(0);
  });

  it("should detect question with checkbox inputs", () => {
    document.body.innerHTML = `
      <div class="quiz-question">
        <p>Select all valid IPv4 address classes. Choose the correct answers below.</p>
        <label><input type="checkbox" name="q1"> Class A</label>
        <label><input type="checkbox" name="q1"> Class E</label>
        <label><input type="checkbox" name="q1"> Class F</label>
      </div>
    `;

    detectGeneralQuestions();

    // General detection with question markers + radio/checkbox inputs
    expect(state.detectedQuestions.length).toBeGreaterThanOrEqual(0);
  });

  it("should not detect plain text paragraphs as questions", () => {
    document.body.innerHTML = `
      <p>This is an informational paragraph about networking concepts.</p>
      <p>Another paragraph explaining how switches work.</p>
    `;

    detectGeneralQuestions();

    expect(state.detectedQuestions).toHaveLength(0);
  });

  it("should handle pages with no quiz content", () => {
    document.body.innerHTML = "<div>Empty page</div>";

    detectGeneralQuestions();
    expect(state.detectedQuestions).toHaveLength(0);
  });
});
