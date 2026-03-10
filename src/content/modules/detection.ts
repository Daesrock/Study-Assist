/**
 * Study Assist - Question Detection Module
 * Functions for detecting and extracting questions from various quiz platforms
 * Supports NetAcad, Moodle, and general quiz formats
 */

import type {
  DetectedQuestion,
  QuestionType,
  QuestionOption,
  QuestionPatterns,
  QuestionMap,
  QuestionMapEntry,
  DetectionResult,
  DetectionCallbacks,
  ImageData,
  MatchingCategory,
  MatchingOption,
  MatchingStyle,
  SelectGap,
} from "../../types/index.js";

import { log, state } from "./state.js";
import {
  querySelectorAllDeep,
  getDeepTextContent,
  getVisibilityScore,
  getVisibleText,
  isChildOfProcessed,
  getDirectTextContent,
  findAllShadowRoots,
  extractAccessibilityDescriptions,
} from "./utils.js";
import { imageToBase64, extractImagesAsBase64, isPublicImageUrl } from "./images.js";

// ============================================
// Question Detection Patterns
// ============================================
export const QUESTION_PATTERNS: QuestionPatterns = {
  // Question indicators (English and Spanish)
  questionMarkers:
    /\?|what|which|how|why|when|where|who|whose|whom|explain|describe|define|identify|select|choose|pick|determine|calculate|compute|find|solve|analyze|evaluate|compare|contrast|list|name|state|qué|cuál|cómo|por\s*qué|cuándo|dónde|quién|pregunta\s*\d+/i,

  // Multiple choice patterns
  multipleChoice: [
    /^\s*[A-Da-d][\.\)\:]?\s+.+/m, // A. Answer or A) Answer or A: Answer
    /^\s*\([A-Da-d]\)\s+.+/m, // (A) Answer
    /^\s*[1-4][\.\)\:]?\s+.+/m, // 1. Answer or 1) Answer
    /\b(?:option|choice|answer)\s*[A-Da-d1-4]/i, // Option A, Choice B, Answer 1
    /<input[^>]*type=["']?radio["']?[^>]*>/i, // Radio button inputs
    /\bselect\s+(?:one|all|the\s+(?:correct|best|right))/i, // "Select one", "Select the correct"
    /radio_button_(?:checked|unchecked)/i, // Material Design icons (NetAcad)
    /pregunta\s*\d+/i, // "Pregunta 1", "Pregunta 2" (NetAcad Spanish)
  ],

  // True/False patterns
  trueFalse: [
    /\b(?:true|false)\b.*\b(?:true|false)\b/i,
    /^\s*(?:True|False|T|F)[\.\)\s]/m,
    /\b(?:is\s+this|this\s+is)\s+(?:true|false|correct|incorrect)\b/i,
    /\b(?:verdadero|falso)\b/i, // Spanish
  ],

  // Fill in the blank
  fillBlank: [
    /_{2,}|\.{3,}|\[?\s*blank\s*\]?/i,
    /fill\s+(?:in\s+)?(?:the\s+)?(?:blank|gap)/i,
    /complete\s+(?:la|el|los|las)/i, // Spanish
  ],
};

// ============================================
// Text Cleaning Helpers
// ============================================

/**
 * Clean question text by extracting only the actual question part
 * Removes context like routing tables, code snippets, etc. that appear before the question
 */
function cleanQuestionText(rawText: string): string {
  if (!rawText || rawText.length < 100) {
    return rawText; // Short text, probably already clean
  }

  // Patterns that typically indicate the start of the actual question
  const questionStartPatterns = [
    /(?:consulte\s+(?:la\s+)?(?:imagen|ilustraci[oó]n|exhibici[oó]n|figura|tabla|gr[aá]fic[ao]))[.:,]?\s*/i,
    /(?:refer\s+to\s+the\s+(?:exhibit|figure|diagram|image|table|graphic))[.:,]?\s*/i,
    /(?:see\s+the\s+(?:exhibit|figure|diagram|image|table|graphic))[.:,]?\s*/i,
  ];

  // Try to find where the actual question starts
  for (const pattern of questionStartPatterns) {
    const match = rawText.match(pattern);
    if (match && match.index !== undefined) {
      // Extract from this point to the end
      const questionPart = rawText.substring(match.index).trim();
      
      // Make sure we got a substantial question (has a question mark)
      if (questionPart.includes('?')) {
        log(`[Study Assist] Cleaned question text: "${rawText.substring(0, 50)}..." → "${questionPart.substring(0, 100)}..."`);
        return questionPart;
      }
    }
  }

  // If no "Consulte..." pattern found, check if there's a lot of non-question text
  // (like routing tables with many lines starting with letters/numbers and network addresses)
  const lines = rawText.split('\n').map(l => l.trim()).filter(l => l.length > 0);
  
  // Detect if many lines look like routing table entries or code
  const tableLinePatt = /^[A-Z]\s+[\d\.:/]+|^\w+\([^)]+\)\s*#|^[\d\.]+ \[|gateway\s+of\s+last\s+resort/i;
  const tableLines = lines.filter(l => tableLinePatt.test(l));
  
  // If more than 30% of lines look like tables/code, extract just the last sentence with "?"
  if (tableLines.length > lines.length * 0.3) {
    // Find the last substantial sentence with a question mark
    const sentences = rawText.split(/[.!¿]\s+/).filter(s => s.includes('?'));
    if (sentences.length > 0) {
      const lastQuestion = sentences[sentences.length - 1].trim();
      
      // Include any "Consulte..." prefix if present
      const contextMatch = rawText.match(/(consulte\s+(?:la\s+)?(?:imagen|ilustraci[oó]n|exhibici[oó]n)[.:,]?\s+[^¿?]+\?)/i);
      if (contextMatch) {
        log(`[Study Assist] Cleaned question text (table detected): "${rawText.substring(0, 50)}..." → "${contextMatch[1].trim().substring(0, 100)}..."`);
        return contextMatch[1].trim();
      }
      
      log(`[Study Assist] Cleaned question text (table detected): "${rawText.substring(0, 50)}..." → "${lastQuestion.substring(0, 100)}..."`);
      return lastQuestion;
    }
  }

  // No cleaning needed - return original
  return rawText;
}

// ============================================
// Internal Types
// ============================================

interface NetAcadQuestionData {
  questionText: string;
  options: QuestionOption[];
}

interface AnalysisResult {
  isQuestion: boolean;
  type: QuestionType;
  options: QuestionOption[] | string[];
  confidence: number;
}

interface PreguntaCandidate {
  num: number;
  top: number;
  fontSize: number;
  area: number;
  score: number;
  text: string;
}

interface PreguntaElement {
  num: number;
  rect: DOMRect;
  element: Element;
}

interface VisibleMatchResult {
  matchingView: Element;
  rect: DOMRect;
  centerDist: number;
}

// ============================================
// Main Detection Functions
// ============================================

/**
 * Main function to detect all questions on the page
 * Tries multiple detection strategies in order of specificity
 * @param retryCount - Number of retry attempts (for lazy-loaded content)
 */
export async function detectQuestionsOnPage(retryCount: number = 0): Promise<DetectionResult | undefined> {
  if (!state.isActive) return;

  state.detectedQuestions = [];

  // First, try to detect Moodle questions
  await detectMoodleQuestions();

  // If no Moodle questions, try NetAcad-style questions (Pregunta 1, Pregunta 2, etc.)
  if (state.detectedQuestions.length === 0) {
    detectNetAcadQuestions();
  }

  // If still no questions found, use general detection
  if (state.detectedQuestions.length === 0) {
    detectGeneralQuestions();
  }

  // Return results for external handlers
  return {
    found: state.detectedQuestions.length > 0,
    count: state.detectedQuestions.length,
    retryCount,
  };
}

// ============================================
// Moodle Question Detection
// ============================================

/**
 * Detect Moodle quiz questions
 * Moodle uses standard HTML with classes like .que.multichoice
 */
export async function detectMoodleQuestions(): Promise<void> {
  // Look for Moodle question containers (all supported types)
  const moodleQuestions = document.querySelectorAll(
    ".que.multichoice, .que.truefalse, .que.match, .que.shortanswer, .que.numerical, .que.gapselect",
  );

  if (moodleQuestions.length === 0) {
    return;
  }

  for (const [index, questionEl] of Array.from(moodleQuestions).entries()) {
    if (questionEl.classList.contains("match")) {
      const questionData = await extractMoodleMatchQuestion(questionEl);
      if (questionData) {
        questionData.id = `moodle-q-${index}`;
        state.detectedQuestions.push(questionData);
      }
    } else if (questionEl.classList.contains("shortanswer")) {
      const questionData = await extractMoodleShortAnswerQuestion(questionEl, "short-answer");
      if (questionData) {
        questionData.id = `moodle-q-${index}`;
        state.detectedQuestions.push(questionData);
      }
    } else if (questionEl.classList.contains("numerical")) {
      const questionData = await extractMoodleShortAnswerQuestion(questionEl, "numerical");
      if (questionData) {
        questionData.id = `moodle-q-${index}`;
        state.detectedQuestions.push(questionData);
      }
    } else if (questionEl.classList.contains("gapselect")) {
      const questionData = await extractMoodleSelectMissingWords(questionEl);
      if (questionData) {
        questionData.id = `moodle-q-${index}`;
        state.detectedQuestions.push(questionData);
      }
    } else {
      // multichoice or truefalse
      const questionData = await extractMoodleQuestionData(questionEl);
      if (questionData) {
        state.detectedQuestions.push({
          id: `moodle-q-${index}`,
          element: questionEl,
          text: questionData.text,
          type: questionData.type,
          options: questionData.options,
          questionNumber: questionData.questionNumber,
          images: questionData.images,
          confidence: 95,
          platform: "moodle",
          courseName: questionData.courseName,
        });
      }
    }
  }
}

// ============================================
// NetAcad-specific Question Detection
// ============================================

/**
 * Detect NetAcad-style questions
 * Uses shadow DOM traversal to find mcq-view and matching components
 */
export function detectNetAcadQuestions(): void {
  // Find all shadow roots in document
  const shadowRoots = findAllShadowRoots();

  // Method 1: Search through Shadow DOMs for mcq-view components (NetAcad specific)
  const mcqViews = querySelectorAllDeep("mcq-view");

  if (mcqViews.length > 0) {
    mcqViews.forEach((mcqView, index) => {
      // Get the shadow root content
      const shadowRoot = mcqView.shadowRoot;
      if (!shadowRoot) {
        return;
      }

      // Find question text - it's nested in base-view > shadow > .mcq__body-inner
      // Use deep search to find it
      let questionText = "";
      const questionBodyEls = querySelectorAllDeep(
        ".mcq__body-inner",
        shadowRoot,
      );
      if (questionBodyEls.length > 0) {
        const rawText = questionBodyEls[0].textContent?.trim() || "";
        questionText = cleanQuestionText(rawText);
      }

      // If still not found, try getting all text from the header
      if (!questionText) {
        const headerEls = querySelectorAllDeep(
          ".mcq__header, .component__body",
          shadowRoot,
        );
        if (headerEls.length > 0) {
          const rawText = headerEls[0].textContent?.trim() || "";
          questionText = cleanQuestionText(rawText);
        }
      }

      // Last resort: get text content from mcq-view itself
      if (!questionText) {
        questionText = getDeepTextContent(mcqView);
        // Take first part before any option-like text
        const lines = questionText
          .split("\n")
          .filter((l) => l.trim().length > 10);
        if (lines.length > 0) {
          questionText = lines[0].trim();
        }
      }

      // Find answer options - they're in .mcq__item-text-inner (deep search)
      const optionEls = querySelectorAllDeep(
        ".mcq__item-text-inner",
        shadowRoot,
      );
      const options: QuestionOption[] = [];

      optionEls.forEach((optEl, optIndex) => {
        const optText = optEl.textContent?.trim() || "";
        if (optText && optText.length > 0) {
          options.push({
            letter: String.fromCharCode(65 + optIndex), // A, B, C, D
            text: optText,
          });
        }
      });

      // Try to extract actual question number from nearby "Pregunta X" text
      let questionNumber = index + 1; // default to array index
      const fullText = getDeepTextContent(mcqView);
      const preguntaMatch = fullText.match(/pregunta\s*(\d+)/i);
      if (preguntaMatch) {
        questionNumber = parseInt(preguntaMatch[1]);
      }

      // Only require options - question text might be empty if extraction fails
      if (options.length >= 2) {
        state.detectedQuestions.push({
          id: `q-${index}`,
          questionNumber: questionNumber,
          element: mcqView,
          text: questionText || `Question ${questionNumber}`,
          type: "multiple-choice",
          options: options,
          confidence: 95,
        });
      }
    });

    if (state.detectedQuestions.length > 0) {
      return;
    }
  }

  // Method 2: Try finding mcq classes directly with deep search
  const mcqItems = querySelectorAllDeep(".mcq__item-text-inner");

  if (mcqItems.length > 0) {
    // Group options by their parent question container
    const questionMap = new Map<Element, string[]>();

    mcqItems.forEach((item) => {
      // Find the mcq-view parent
      let parent: Element | null = item;
      while (parent && parent.tagName !== "MCQ-VIEW") {
        parent = (parent.parentElement || (parent as unknown as { host: Element }).host) as Element | null;
      }

      if (parent) {
        if (!questionMap.has(parent)) {
          questionMap.set(parent, []);
        }
        questionMap.get(parent)!.push(item.textContent?.trim() || "");
      }
    });

    let index = 0;
    questionMap.forEach((optionTexts, container) => {
      // Try to get question text
      const questionBody = querySelectorAllDeep(
        ".mcq__body-inner",
        container.shadowRoot || container,
      )[0];
      const rawText = questionBody
        ? questionBody.textContent?.trim() || `Question ${index + 1}`
        : `Question ${index + 1}`;
      const questionText = cleanQuestionText(rawText);

      const options: QuestionOption[] = optionTexts.map((text, i) => ({
        letter: String.fromCharCode(65 + i),
        text: text,
      }));

      if (options.length >= 2) {
        state.detectedQuestions.push({
          id: `q-${index}`,
          element: container,
          text: questionText,
          type: "multiple-choice",
          options: options,
          confidence: 90,
        });
        index++;
      }
    });

    if (state.detectedQuestions.length > 0) {
      return;
    }
  }

  // Method 3: Fallback - look for regular DOM elements
  const allClasses = new Set<string>();
  document.querySelectorAll("*").forEach((el) => {
    if (el.className && typeof el.className === "string") {
      el.className.split(/\s+/).forEach((cls) => {
        if (cls.length > 0) allClasses.add(cls);
      });
    }
  });

  // Look for classes that might indicate questions/answers
  const relevantClasses = Array.from(allClasses).filter((cls) =>
    /mcq|question|answer|option|choice|radio|check|select|quiz|item/i.test(cls),
  );

  // Method 4: Look for radio buttons or checkboxes (universal quiz detection)
  const radioButtons = document.querySelectorAll(
    'input[type="radio"], input[type="checkbox"]',
  ) as NodeListOf<HTMLInputElement>;

  if (radioButtons.length >= 2) {
    // Group radio buttons by their name attribute (each group = one question)
    const questionGroups = new Map<string, HTMLInputElement[]>();

    radioButtons.forEach((radio) => {
      const name = radio.name || radio.id || "unnamed";
      if (!questionGroups.has(name)) {
        questionGroups.set(name, []);
      }
      questionGroups.get(name)!.push(radio);
    });

    let index = 0;
    questionGroups.forEach((radios, groupName) => {
      if (radios.length >= 2) {
        // Find the container that holds all these radio buttons
        let container: Element | null = radios[0].closest(
          'form, fieldset, [role="group"], [role="radiogroup"]',
        );
        if (!container) {
          // Go up to find common parent
          container = radios[0].parentElement;
          for (let i = 0; i < 10; i++) {
            if (!container || !container.parentElement) break;
            const containsAll = radios.every((r) => container!.contains(r));
            if (
              containsAll &&
              (container as HTMLElement).innerText &&
              (container as HTMLElement).innerText.length > 50
            ) {
              break;
            }
            container = container.parentElement;
          }
        }

        if (container) {
          const options: QuestionOption[] = radios
            .map((radio, i) => {
              // Find the label text for this radio
              let labelText = "";
              const label =
                radio.closest("label") ||
                document.querySelector(`label[for="${radio.id}"]`);
              if (label) {
                labelText = (label as HTMLElement).innerText?.trim() || "";
              } else {
                // Try to get text from parent or next sibling
                const parent = radio.parentElement;
                labelText = (parent as HTMLElement)?.innerText?.trim() || "";
              }
              return {
                letter: String.fromCharCode(65 + i),
                text: labelText,
              };
            })
            .filter((opt) => opt.text.length > 0);

          // Extract question text (text before the options)
          const fullText = (container as HTMLElement).innerText || "";
          let questionText = fullText;
          options.forEach((opt) => {
            questionText = questionText.replace(opt.text, "");
          });
          questionText = questionText.replace(/\s+/g, " ").trim();

          if (questionText.length > 10 && options.length >= 2) {
            state.detectedQuestions.push({
              id: `q-${index}`,
              element: container,
              text: questionText.substring(0, 500),
              type: "multiple-choice",
              options: options,
              confidence: 85,
            });
            index++;
          }
        }
      }
    });

    if (state.detectedQuestions.length > 0) {
      return;
    }
  }

  // Method 5: Look for mcq classes in regular DOM (fallback)
  const regularMcqItems = document.querySelectorAll(
    '.mcq__item-text, .mcq__item-text-inner, [class*="mcq__"], [class*="mcq-"]',
  );

  if (regularMcqItems.length > 0) {
    // Find all question containers by going up from mcq items
    const questionContainers = new Set<Element>();

    regularMcqItems.forEach((item) => {
      // Go up to find the question container
      let container: Element | null = item;
      for (let i = 0; i < 15; i++) {
        if (!container.parentElement) break;
        container = container.parentElement;

        // Check if this container has question text and multiple mcq items
        const mcqCount = container.querySelectorAll(
          '.mcq__item, [class*="mcq__item"]',
        ).length;
        const text = (container as HTMLElement).innerText || "";

        // If we have 2+ options and question-like text, this is likely the question container
        if (mcqCount >= 2 && text.length > 50 && text.length < 5000) {
          // Check if it looks like a question
          if (
            /\?|pregunta|qué|cuál|cómo|dónde|which|what|how|where/i.test(text)
          ) {
            questionContainers.add(container);
            break;
          }
        }
      }
    });

    // Process each question container
    let index = 0;
    questionContainers.forEach((container) => {
      const questionData = extractNetAcadQuestion(container);
      if (questionData) {
        state.detectedQuestions.push({
          id: `q-${index}`,
          element: container,
          text: questionData.questionText,
          type: "multiple-choice",
          options: questionData.options,
          confidence: 90,
        });
        index++;
      }
    });

    if (state.detectedQuestions.length > 0) {
      return;
    }
  }

  // Method 6: Fallback - Look for "Pregunta X" patterns in the page
  const fallbackElements = document.body.querySelectorAll("*");
  const questionContainersList: Element[] = [];

  // Find elements containing "Pregunta X"
  fallbackElements.forEach((el) => {
    const text = el.textContent || "";
    if (/pregunta\s*\d+/i.test(text) && text.length < 500) {
      // Find the parent container that holds the full question
      let container: Element = el;
      while (
        container.parentElement &&
        container.parentElement !== document.body
      ) {
        const parentText = container.parentElement.textContent || "";
        // If parent contains radio buttons or options, use it
        if (
          /radio_button|checkbox/i.test(parentText) ||
          container.parentElement.querySelectorAll('input[type="radio"]')
            .length > 0
        ) {
          container = container.parentElement;
          break;
        }
        // Don't go too far up
        if (parentText.length > 3000) break;
        container = container.parentElement;
      }

      // Avoid duplicates
      if (!questionContainersList.includes(container)) {
        questionContainersList.push(container);
      }
    }
  });

  // Also look for containers with radio_button text (Material icons)
  const bodyText = document.body.innerText || "";
  if (/radio_button_(?:checked|unchecked)/i.test(bodyText)) {
    // Find all text nodes with radio_button
    const walker = document.createTreeWalker(
      document.body,
      NodeFilter.SHOW_TEXT,
    );
    let node: Text | null;
    const radioContainers = new Set<Element>();

    while ((node = walker.nextNode() as Text | null)) {
      if (/radio_button/i.test(node.textContent || "")) {
        let parent: Element | null = node.parentElement;
        // Go up to find a reasonable container
        for (let i = 0; i < 10 && parent; i++) {
          if (/pregunta/i.test(parent.textContent || "")) {
            radioContainers.add(parent);
            break;
          }
          parent = parent.parentElement;
        }
      }
    }

    radioContainers.forEach((container) => {
      if (!questionContainersList.includes(container)) {
        questionContainersList.push(container);
      }
    });
  }

  // Process found containers
  questionContainersList.forEach((container, index) => {
    const text = getVisibleText(container);
    if (text && text.length > 30) {
      const options = extractNetAcadOptions(text, container);
      state.detectedQuestions.push({
        id: `q-${index}`,
        element: container,
        text: text,
        type: "multiple-choice",
        options: options,
        confidence: 80,
      });
    }
  });
}

// ============================================
// Extract NetAcad Options
// ============================================

/**
 * Extract options from NetAcad question text
 * @param text - The question text
 * @param element - The question element
 * @returns Array of option objects with letter and text
 */
export function extractNetAcadOptions(text: string, element: Element): QuestionOption[] {
  const options: QuestionOption[] = [];

  // Split by radio_button markers
  const parts = text.split(/radio_button_(?:checked|unchecked)/i);

  // First part is the question, rest are options
  if (parts.length > 1) {
    parts.slice(1).forEach((part, index) => {
      const optionText = part.trim().split("\n")[0].trim();
      if (optionText && optionText.length > 2) {
        options.push({
          letter: String.fromCharCode(65 + index), // A, B, C, D...
          text: optionText,
        });
      }
    });
  }

  return options;
}

// ============================================
// Extract NetAcad Question (using mcq classes)
// ============================================

/**
 * Extract question data from a NetAcad container using mcq classes
 * @param container - The question container element
 * @returns Question data or null if extraction fails
 */
export function extractNetAcadQuestion(container: Element): NetAcadQuestionData | null {
  const options: QuestionOption[] = [];

  // Find all answer options using mcq classes
  const mcqItems = container.querySelectorAll(
    '.mcq__item, [class*="mcq__item"]',
  );

  if (mcqItems.length === 0) {
    // Try alternative: look for mcq__item-text directly
    const textItems = container.querySelectorAll(
      ".mcq__item-text, .mcq__item-text-inner",
    );
    textItems.forEach((item, index) => {
      const text = (item as HTMLElement).innerText?.trim();
      if (text && text.length > 1) {
        options.push({
          letter: String.fromCharCode(65 + index),
          text: text,
        });
      }
    });
  } else {
    mcqItems.forEach((item, index) => {
      const textEl =
        item.querySelector(".mcq__item-text-inner, .mcq__item-text") || item;
      const text = (textEl as HTMLElement).innerText?.trim();
      if (text && text.length > 1) {
        options.push({
          letter: String.fromCharCode(65 + index),
          text: text,
        });
      }
    });
  }

  // Extract the question text (everything that's not an option)
  let questionText = (container as HTMLElement).innerText || "";

  // Remove option texts from question text to get clean question
  options.forEach((opt) => {
    questionText = questionText.replace(opt.text, "");
  });

  // Clean up the question text
  questionText = questionText
    .replace(/radio_button_(?:checked|unchecked)/gi, "")
    .replace(/\s+/g, " ")
    .trim();

  if (questionText.length < 10 || options.length < 2) {
    return null;
  }

  return {
    questionText: questionText,
    options: options,
  };
}

// ============================================
// General Question Detection
// ============================================

/**
 * Detect questions using general patterns
 * Works across various quiz platforms
 */
export function detectGeneralQuestions(): void {
  // Get all text-containing elements
  const textElements = document.querySelectorAll(
    "p, div, span, li, td, th, label, h1, h2, h3, h4, h5, h6, " +
      "article, section, blockquote, .question, .quiz-question, " +
      '[class*="question"], [class*="quiz"], [class*="exam"], ' +
      '[data-question], [role="listitem"]',
  );

  const processedTexts = new Set<string>();

  textElements.forEach((element, index) => {
    const text = getVisibleText(element);

    // Skip empty, too short, or duplicate texts
    if (!text || text.length < 20 || processedTexts.has(text)) return;

    // Skip if parent already processed (avoid duplicates)
    if (isChildOfProcessed(element, state.detectedQuestions)) return;

    const questionInfo = analyzeTextForQuestion(text, element);

    if (questionInfo.isQuestion) {
      processedTexts.add(text);
      state.detectedQuestions.push({
        id: `q-${state.detectedQuestions.length}`,
        element: element,
        text: text,
        type: questionInfo.type,
        options: questionInfo.options as QuestionOption[],
        confidence: questionInfo.confidence,
      });
    }
  });
}

// ============================================
// Question Analysis
// ============================================

/**
 * Analyze text to determine if it's a question and extract metadata
 * @param text - The text to analyze
 * @param element - The element containing the text
 * @returns Analysis result with isQuestion, type, options, confidence
 */
export function analyzeTextForQuestion(text: string, element: Element): AnalysisResult {
  let isQuestion = false;
  let type: QuestionType = "unknown";
  let options: QuestionOption[] | string[] = [];
  let confidence = 0;

  // Check for question markers
  if (QUESTION_PATTERNS.questionMarkers.test(text)) {
    confidence += 30;
  }

  // Check for multiple choice
  for (const pattern of QUESTION_PATTERNS.multipleChoice) {
    if (pattern.test(text)) {
      type = "multiple-choice";
      confidence += 40;
      options = extractOptions(text, element);
      break;
    }
  }

  // Check for true/false
  if (type === "unknown") {
    for (const pattern of QUESTION_PATTERNS.trueFalse) {
      if (pattern.test(text)) {
        type = "true-false";
        confidence += 35;
        options = ["True", "False"];
        break;
      }
    }
  }

  // Check for fill in the blank
  if (type === "unknown") {
    for (const pattern of QUESTION_PATTERNS.fillBlank) {
      if (pattern.test(text)) {
        type = "fill-blank";
        confidence += 30;
        break;
      }
    }
  }

  // Check element classes/attributes for question indicators
  const classList = (element.className || "").toString().toLowerCase();
  const dataAttrs = Array.from(element.attributes)
    .map((a) => a.name.toLowerCase())
    .join(" ");

  if (/question|quiz|exam|test|assessment/i.test(classList + " " + dataAttrs)) {
    confidence += 25;
  }

  // Check for radio/checkbox inputs
  const hasInputs =
    element.querySelectorAll('input[type="radio"], input[type="checkbox"]')
      .length > 0;
  if (hasInputs) {
    type = type === "unknown" ? "multiple-choice" : type;
    confidence += 35;
    if (options.length === 0) {
      options = extractOptionsFromInputs(element);
    }
  }

  // Determine if it's a question based on confidence
  isQuestion = confidence >= 40;

  return { isQuestion, type, options, confidence };
}

// ============================================
// Option Extraction
// ============================================

/**
 * Extract options from question text using various patterns
 * @param text - The question text
 * @param element - The question element
 * @returns Array of option objects with letter and text
 */
export function extractOptions(text: string, element: Element): QuestionOption[] {
  const options: QuestionOption[] = [];

  // Pattern 1: A. Answer, B. Answer, etc.
  const letterPattern = /(?:^|\n)\s*([A-Da-d])[\.\)\:]?\s*([^\n]+)/gm;
  let match: RegExpExecArray | null;

  while ((match = letterPattern.exec(text)) !== null) {
    options.push({
      letter: match[1].toUpperCase(),
      text: match[2].trim(),
    });
  }

  // Pattern 2: (A) Answer, (B) Answer, etc.
  if (options.length === 0) {
    const parenPattern = /\(([A-Da-d])\)\s*([^\n\(]+)/gm;
    while ((match = parenPattern.exec(text)) !== null) {
      options.push({
        letter: match[1].toUpperCase(),
        text: match[2].trim(),
      });
    }
  }

  // Pattern 3: Numbered options
  if (options.length === 0) {
    const numberPattern = /(?:^|\n)\s*([1-4])[\.\)\:]?\s*([^\n]+)/gm;
    while ((match = numberPattern.exec(text)) !== null) {
      options.push({
        letter: match[1],
        text: match[2].trim(),
      });
    }
  }

  return options;
}

/**
 * Extract options from input elements (radio/checkbox)
 * @param element - The container element with inputs
 * @returns Array of option objects with letter and text
 */
export function extractOptionsFromInputs(element: Element): QuestionOption[] {
  const options: QuestionOption[] = [];
  const inputs = element.querySelectorAll(
    'input[type="radio"], input[type="checkbox"]',
  ) as NodeListOf<HTMLInputElement>;

  inputs.forEach((input, index) => {
    const label =
      element.querySelector(`label[for="${input.id}"]`) ||
      input.closest("label");

    const text = label
      ? getVisibleText(label)
      : input.value || `Option ${index + 1}`;

    options.push({
      letter: String.fromCharCode(65 + index), // A, B, C, D...
      text: (text || "").replace(/^[A-Da-d][\.\)\:]\s*/, "").trim(),
    });
  });

  return options;
}

// ============================================
// Quiz Content Detection
// ============================================

/**
 * Check if this frame contains quiz content (NetAcad or Moodle)
 * Used to only show UI in the correct frame
 * @returns True if quiz content is detected
 */
export function frameHasQuizContent(): boolean {
  // NetAcad detection
  const mcqViews = querySelectorAllDeep("mcq-view");
  const matchingViews = querySelectorAllDeep("object-matching-view");
  const dropdownMatchingViews = querySelectorAllDeep("matching-view");
  if (
    mcqViews.length > 0 ||
    matchingViews.length > 0 ||
    dropdownMatchingViews.length > 0
  ) {
    return true;
  }

  // Moodle detection - look for quiz question containers
  const moodleQuestions = document.querySelectorAll(
    ".que.multichoice, .que.truefalse, .que.shortanswer, .que.numerical, .que.essay, .que.match, .que.gapselect",
  );
  if (moodleQuestions.length > 0) {
    return true;
  }

  return false;
}

/**
 * Delayed check for quiz content - content may load after script
 * @param callback - Callback function with boolean result
 * @param maxAttempts - Maximum number of check attempts
 * @param interval - Interval between checks in milliseconds
 */
export function waitForQuizContent(
  callback: (found: boolean) => void,
  maxAttempts: number = 10,
  interval: number = 500
): void {
  let attempts = 0;

  function check(): void {
    attempts++;
    if (frameHasQuizContent()) {
      callback(true);
    } else if (attempts < maxAttempts) {
      setTimeout(check, interval);
    } else {
      callback(false);
    }
  }

  check();
}

// ============================================
// Visible Question Detection
// ============================================

/**
 * Detect visible matching question (object-matching-view)
 * Returns a question object if found, null otherwise
 * @returns Matching question object or null
 */
export function detectVisibleMatchingQuestion(): DetectedQuestion | null {
  const matchingViews = querySelectorAllDeep("object-matching-view");

  if (matchingViews.length === 0) return null;

  // Find all visible matching views and score by proximity to center of viewport
  const visibleMatches: VisibleMatchResult[] = [];
  const viewportCenter = window.innerHeight / 2;
  for (const matchingView of matchingViews) {
    const rect = matchingView.getBoundingClientRect();
    const hasSize = rect.width > 0 && rect.height > 0;
    if (!hasSize) continue;
    // Score by distance to center
    const centerDist = Math.abs((rect.top + rect.bottom) / 2 - viewportCenter);
    visibleMatches.push({ matchingView, rect, centerDist });
  }
  if (visibleMatches.length === 0) return null;
  // Pick the one closest to center
  visibleMatches.sort((a, b) => a.centerDist - b.centerDist);
  const bestMatch = visibleMatches[0].matchingView;
  const bestRect = visibleMatches[0].rect;
  const bestCenter = (bestRect.top + bestRect.bottom) / 2;
  if (Math.abs(bestCenter - viewportCenter) > 200) return null;
  const shadowRoot = bestMatch.shadowRoot;
  if (!shadowRoot) return null;

  // Extract question text
  let questionText = "";
  const bodyEls = querySelectorAllDeep(
    ".component__body-inner, .objectMatching__body-inner",
    shadowRoot,
  );
  if (bodyEls.length > 0) {
    questionText = bodyEls[0].textContent?.trim() || "";
  }

  // Extract categories (left side - A, B, C...)
  const categories: MatchingCategory[] = [];
  const categoryItems = querySelectorAllDeep(
    ".objectMatching-category-item",
    shadowRoot,
  );
  categoryItems.forEach((item, index) => {
    const textEl = item.querySelector(".category-item-text");
    const letterEl = item.querySelector(".category-item-number");
    if (textEl) {
      const text = textEl.textContent?.trim() || "";
      const letter = letterEl
        ? letterEl.textContent?.trim() || String.fromCharCode(65 + index)
        : String.fromCharCode(65 + index);
      categories.push({
        letter: letter,
        text: text,
      });
    }
  });

  // Extract options (right side - to be matched)
  const matchingOptions: MatchingOption[] = [];
  const optionItems = querySelectorAllDeep(
    ".objectMatching-option-item",
    shadowRoot,
  );
  optionItems.forEach((item, index) => {
    const textEl = item.querySelector(".category-item-text");
    if (textEl) {
      const text = textEl.textContent?.trim() || "";
      matchingOptions.push({
        index: index + 1,
        text: text,
      });
    }
  });

  if (categories.length >= 2 && matchingOptions.length >= 2) {
    return {
      id: "matching-visible",
      type: "matching",
      text: questionText,
      categories: categories,
      matchingOptions: matchingOptions,
      element: bestMatch,
      options: [], // Required by interface but not used for matching
      confidence: 95,
    };
  }
  return null;
}

/**
 * Find the visible question number on the page
 * Searches for "Pregunta X" text and returns the most prominent one
 * @returns The question number or null if not found
 */
export function findVisibleQuestionNumber(): number | null {
  const candidates: PreguntaCandidate[] = [];

  // Search for "Pregunta X" text in the page (including shadow DOMs)
  function collectTextNodes(root: Element | Document | ShadowRoot): void {
    const walker = document.createTreeWalker(root as Node, NodeFilter.SHOW_TEXT);
    let node: Text | null;
    while ((node = walker.nextNode() as Text | null)) {
      if (node.textContent && /pregunta\s*\d+/i.test(node.textContent)) {
        const match = node.textContent.match(/pregunta\s*(\d+)/i);
        if (match) {
          const num = parseInt(match[1]);
          const parent = node.parentElement;
          if (parent) {
            const rect = parent.getBoundingClientRect();
            // Check if element is in viewport
            if (
              rect.top >= -100 &&
              rect.top <= window.innerHeight &&
              rect.width > 0 &&
              rect.height > 0
            ) {
              // Calculate a "prominence" score - larger elements are more likely the main indicator
              const fontSize =
                parseFloat(window.getComputedStyle(parent).fontSize) || 12;
              const area = rect.width * rect.height;
              // Prefer elements closer to center-top of screen (main content area)
              const centerDistance = Math.abs(
                rect.left + rect.width / 2 - window.innerWidth / 2,
              );
              const score = fontSize * 10 + area / 100 - centerDistance / 10;

              candidates.push({
                num: num,
                top: rect.top,
                fontSize: fontSize,
                area: area,
                score: score,
                text: node.textContent.trim(),
              });
            }
          }
        }
      }
    }
    // Also check shadow roots
    const elements = root.querySelectorAll("*");
    elements.forEach((el) => {
      if (el.shadowRoot) {
        collectTextNodes(el.shadowRoot);
      }
    });
  }

  collectTextNodes(document);

  if (candidates.length === 0) {
    return null;
  }

  // Sort by score (highest first) - this prefers larger, centered elements
  candidates.sort((a, b) => b.score - a.score);

  // Return the question number with highest score
  return candidates[0].num;
}

/**
 * Re-detect and refresh the current question
 * @param displayCallback - Optional callback to display the question (for UI integration)
 * @returns The detected question or null
 */
export async function refreshCurrentQuestion(
  displayCallback: ((question: DetectedQuestion) => void) | null = null
): Promise<DetectedQuestion | null> {
  // Re-detect the visible question from scratch (async for image extraction)
  const question = await detectVisibleQuestion();
  if (question && displayCallback) {
    displayCallback(question);
  }
  return question;
}

/**
 * Detect only the currently visible question on screen
 * Uses a question map approach to handle mixed mcq/matching questions
 * @returns The detected question or null
 */
export async function detectVisibleQuestion(): Promise<DetectedQuestion | null> {
  // First, try to detect Moodle questions (they have a simpler structure)
  const moodleQuestion = await detectMoodleQuestion();
  if (moodleQuestion) {
    return moodleQuestion;
  }

  // Then try NetAcad detection (uses Shadow DOM and question maps)
  // Find visible question number first
  const visibleQuestionNum = findVisibleQuestionNumber();

  // Build a map of all questions (both mcq and matching) with their proximity scores
  const questionMap = buildQuestionMap();

  // Debug logging
  log("[Study Assist] detectVisibleQuestion:", {
    visibleQuestionNum,
    questionMapKeys: Object.keys(questionMap),
    questionMapDetails: Object.entries(questionMap).map(([k, v]) => ({
      num: k,
      type: v.question?.type,
      score: v.score,
      text: v.question?.text?.substring(0, 50),
    })),
  });

  // If we have a visible question number, try to find it in the map
  if (visibleQuestionNum !== null && questionMap[visibleQuestionNum]) {
    const entry = questionMap[visibleQuestionNum];
    return entry.question;
  }

  // Fallback: select the question with the highest visibility score
  let bestEntry: QuestionMapEntry | null = null;
  let bestScore = -Infinity;

  for (const num in questionMap) {
    const entry = questionMap[num];
    if (entry.score > bestScore) {
      bestScore = entry.score;
      bestEntry = entry;
    }
  }

  if (bestEntry) {
    return bestEntry.question;
  }

  return null;
}

/**
 * Detect Moodle quiz questions (for visible question detection)
 * Moodle uses standard HTML with classes like .que.multichoice
 * @returns The detected question or null
 */
export async function detectMoodleQuestion(): Promise<DetectedQuestion | null> {
  // Look for Moodle question containers (all supported types)
  const moodleQuestions = document.querySelectorAll(
    ".que.multichoice, .que.truefalse, .que.match, .que.shortanswer, .que.numerical, .que.gapselect",
  );

  if (moodleQuestions.length === 0) {
    return null;
  }

  // Find the most visible question (closest to viewport center)
  const viewportCenterY = window.innerHeight / 2;
  let bestQuestion: Element | null = null;
  let bestScore = -Infinity;

  for (const questionEl of moodleQuestions) {
    const rect = questionEl.getBoundingClientRect();
    if (rect.width === 0 || rect.height === 0) continue;

    const isInViewport = rect.top < window.innerHeight && rect.bottom > 0;
    if (!isInViewport) continue;

    const centerDist = Math.abs((rect.top + rect.bottom) / 2 - viewportCenterY);
    const score = 10000 - centerDist;

    if (score > bestScore) {
      bestScore = score;
      bestQuestion = questionEl;
    }
  }

  if (!bestQuestion) {
    // Fallback for zero-dimension contexts (iframes, jsdom)
    bestQuestion = moodleQuestions[0] ?? null;
  }

  if (!bestQuestion) {
    return null;
  }

  // Route to correct extractor based on question type
  if (bestQuestion.classList.contains("match")) {
    return await extractMoodleMatchQuestion(bestQuestion);
  }
  if (bestQuestion.classList.contains("shortanswer")) {
    return await extractMoodleShortAnswerQuestion(bestQuestion, "short-answer");
  }
  if (bestQuestion.classList.contains("numerical")) {
    return await extractMoodleShortAnswerQuestion(bestQuestion, "numerical");
  }
  if (bestQuestion.classList.contains("gapselect")) {
    return await extractMoodleSelectMissingWords(bestQuestion);
  }
  return await extractMoodleQuestionData(bestQuestion);
}

/**
 * Extract course name from Moodle page title
 * Moodle format: "Quiz Title: Course Name" or just "Course Name"
 * @returns Course name or undefined
 */
function extractMoodleCourseName(): string | undefined {
  const title = document.title.trim();
  
  // Moodle typically uses format "Activity: Course Name"
  // Example: "Cuestionario 3. UBUNTU: Sistemas Operativos"
  const colonIndex = title.lastIndexOf(':');
  
  if (colonIndex !== -1 && colonIndex < title.length - 1) {
    const courseName = title.substring(colonIndex + 1).trim();
    // Only return if it's not empty and not too short
    if (courseName.length > 3) {
      return courseName;
    }
  }
  
  return undefined;
}

/**
 * Extract question data from a Moodle question element
 * Now async to handle image extraction
 * @param questionEl - The Moodle question element
 * @returns Question data or null
 */
export async function extractMoodleQuestionData(questionEl: Element): Promise<DetectedQuestion | null> {
  // Extract course name from page title
  const courseName = extractMoodleCourseName();
  const isTrueFalse = questionEl.classList.contains("truefalse");
  
  // Get question number from span.qno
  const qnoEl = questionEl.querySelector(".qno");
  const questionNumber = qnoEl ? parseInt(qnoEl.textContent?.trim() || "1") : 1;

  // Get question text from div.qtext
  const qtextEl = questionEl.querySelector(".qtext");
  let questionText = "";
  const questionImages: ImageData[] = [];

  if (qtextEl) {
    // Get all text, excluding hidden elements
    questionText = qtextEl.textContent?.trim() || "";

    // Extract images from question text (exclude flag images)
    const imgs = qtextEl.querySelectorAll("img:not(.questionflagimage)") as NodeListOf<HTMLImageElement>;
    for (const img of imgs) {
      // Skip tiny images (likely icons)
      if (img.width < 50 || img.height < 50) continue;

      // Prefer public URL (saves tokens) over base64
      if (isPublicImageUrl(img.src)) {
        questionImages.push({
          url: img.src,
          mediaType: "image/jpeg",
          alt: img.alt || "Question image",
          location: "question",
        });
      } else {
        const base64Data = await imageToBase64(img);
        if (base64Data) {
          questionImages.push({
            base64: base64Data.base64,
            mediaType: base64Data.mediaType,
            alt: img.alt || "Question image",
            location: "question",
          });
        }
      }
    }
  }

  // Get answer options from div.answer
  const answerContainer = questionEl.querySelector(".answer");
  const options: QuestionOption[] = [];

  if (answerContainer) {
    // Each option is in a div with class r0 or r1 (alternating)
    const optionDivs = answerContainer.querySelectorAll(
      ":scope > div.r0, :scope > div.r1",
    );

    for (const optDiv of optionDivs) {
      // Get the letter from span.answernumber (e.g., "a. ", "b. ")
      const letterEl = optDiv.querySelector(".answernumber");
      let letter = "";
      if (letterEl) {
        letter = (letterEl.textContent?.trim() || "").replace(".", "").toUpperCase();
      }

      // Get the option text - it's in the flex-fill div after answernumber
      const textContainer = optDiv.querySelector(
        ".flex-fill, [data-region='answer-label'] > div:not(.answernumber)",
      );
      let optionText = "";
      let optionImage: ImageData | null = null;

      if (textContainer) {
        optionText = textContainer.textContent?.trim() || "";

        // Check for image in this option (some answers are images)
        const optImg = textContainer.querySelector(
          "img:not(.questionflagimage)",
        ) as HTMLImageElement | null;
        if (optImg && optImg.width >= 50 && optImg.height >= 50) {
          // Prefer public URL over base64
          if (isPublicImageUrl(optImg.src)) {
            optionImage = {
              url: optImg.src,
              mediaType: "image/jpeg",
              alt: optImg.alt || `Option ${letter} image`,
            };
          } else {
            const base64Data = await imageToBase64(optImg);
            if (base64Data) {
              optionImage = {
                base64: base64Data.base64,
                mediaType: base64Data.mediaType,
                alt: optImg.alt || `Option ${letter} image`,
              };
            }
          }
        }
      } else {
        // Fallback: get text from the label div, excluding the letter
        const labelDiv = optDiv.querySelector("[data-region='answer-label']");
        if (labelDiv) {
          optionText = labelDiv.textContent?.trim() || "";
          // Remove the letter prefix
          if (letterEl) {
            optionText = optionText.replace(letterEl.textContent || "", "").trim();
          }

          // Check for image in label
          const optImg = labelDiv.querySelector("img:not(.questionflagimage)") as HTMLImageElement | null;
          if (optImg && optImg.width >= 50 && optImg.height >= 50) {
            // Prefer public URL over base64
            if (isPublicImageUrl(optImg.src)) {
              optionImage = {
                url: optImg.src,
                mediaType: "image/jpeg",
                alt: optImg.alt || `Option ${letter} image`,
              };
            } else {
              const base64Data = await imageToBase64(optImg);
              if (base64Data) {
                optionImage = {
                  base64: base64Data.base64,
                  mediaType: base64Data.mediaType,
                  alt: optImg.alt || `Option ${letter} image`,
                };
              }
            }
          }
        }
      }

      // Moodle true/false often uses <label> (without .answernumber / .flex-fill)
      if (!optionText) {
        const labelEl = optDiv.querySelector("label");
        if (labelEl) {
          optionText = labelEl.textContent?.trim() || "";
        }
      }

      // Last-resort text extraction from option container
      if (!optionText) {
        optionText = optDiv.textContent?.trim() || "";
        if (letterEl && letterEl.textContent) {
          optionText = optionText.replace(letterEl.textContent, "").trim();
        }
      }

      // For true/false, normalize option letters to V/F for quick mode UX
      if (isTrueFalse) {
        const normalized = optionText
          .normalize("NFD")
          .replace(/[\u0300-\u036f]/g, "")
          .toLowerCase();

        if (/(^|\b)(true|verdadero)(\b|$)/i.test(normalized)) {
          letter = "V";
        } else if (/(^|\b)(false|falso)(\b|$)/i.test(normalized)) {
          letter = "F";
        }
      }

      // Fallback letter for non true/false options that don't expose answernumber
      if (!letter) {
        letter = String.fromCharCode(65 + options.length); // A, B, C...
      }

      // Accept option if it has text OR an image
      if (optionText || optionImage) {
        options.push({
          letter: letter,
          text: optionText || `[Image: ${optionImage?.alt || "option"}]`,
          image: optionImage,
        });
      }
    }
  }

  // Check if we have valid data (text or images count as valid)
  const hasContent = questionText || questionImages.length > 0;
  if (!hasContent || options.length < 2) {
    return null;
  }

  return {
    id: `moodle-q-${questionNumber}`,
    type: isTrueFalse ? "true-false" : "multiple-choice",
    text: questionText,
    options: options,
    element: questionEl,
    questionNumber: questionNumber,
    platform: "moodle",
    images: questionImages, // Array of images from question text
    confidence: 95,
    courseName: courseName, // Academic course name for context
  };
}

/**
 * Extract question data from a Moodle "match" question element.
 * These use a table layout where each row has a concept (td.text) and a
 * <select> dropdown with shared answer options (td.control).
 *
 * The extracted question uses:
 *   categories (A, B, C...) = the row concepts
 *   matchingOptions (1, 2, 3...) = the dropdown option values
 * which produces the answer format: A-1, B-3, C-2
 */
async function extractMoodleMatchQuestion(questionEl: Element): Promise<DetectedQuestion | null> {
  const courseName = extractMoodleCourseName();

  const qnoEl = questionEl.querySelector(".qno");
  const questionNumber = qnoEl ? parseInt(qnoEl.textContent?.trim() || "1") : 1;

  const qtextEl = questionEl.querySelector(".qtext");
  const questionText = qtextEl?.textContent?.trim() || "";

  if (!questionText) return null;

  const rows = questionEl.querySelectorAll("table.answer tbody tr");
  if (rows.length === 0) return null;

  const categories: MatchingCategory[] = [];
  let matchingOptions: MatchingOption[] | null = null;

  for (const [rowIndex, row] of Array.from(rows).entries()) {
    const textCell = row.querySelector("td.text");
    const conceptText = textCell?.textContent?.trim() || "";

    if (conceptText) {
      categories.push({
        letter: String.fromCharCode(65 + rowIndex), // A, B, C...
        text: conceptText,
      });
    }

    // Options are identical across all rows — extract once from the first select
    if (!matchingOptions) {
      const selectEl = row.querySelector("td.control select");
      if (selectEl) {
        matchingOptions = [];
        for (const opt of Array.from(selectEl.querySelectorAll("option"))) {
          const value = parseInt(opt.getAttribute("value") || "0");
          if (value > 0) { // Skip the "Elegir..." placeholder (value="0")
            matchingOptions.push({
              index: value,
              text: opt.textContent?.trim() || "",
            });
          }
        }
      }
    }
  }

  if (categories.length === 0 || !matchingOptions || matchingOptions.length === 0) {
    return null;
  }

  return {
    id: `moodle-q-${questionNumber}`,
    type: "matching",
    text: questionText,
    options: [],
    element: questionEl,
    questionNumber,
    platform: "moodle",
    confidence: 95,
    courseName,
    categories,
    matchingOptions,
    // matchingStyle intentionally omitted → falls back to "drag-drop" in api.ts
    // which uses the A-1, B-3, C-2 answer format expected for this question type
  };
}

/**
 * Extract a Moodle Short Answer or Numerical question.
 * These are free-text questions — no predefined options.
 */
async function extractMoodleShortAnswerQuestion(
  questionEl: Element,
  type: "short-answer" | "numerical",
): Promise<DetectedQuestion | null> {
  const courseName = extractMoodleCourseName();

  const qnoEl = questionEl.querySelector(".qno");
  const questionNumber = qnoEl ? parseInt(qnoEl.textContent?.trim() || "1") : 1;

  const qtextEl = questionEl.querySelector(".qtext");
  const questionText = qtextEl?.textContent?.trim() || "";

  if (!questionText) return null;

  return {
    id: `moodle-q-${questionNumber}`,
    type,
    text: questionText,
    options: [],
    element: questionEl,
    questionNumber,
    platform: "moodle",
    confidence: 95,
    courseName,
  };
}

/**
 * Extract a Moodle "Select Missing Words" (gapselect) question.
 * The question text contains inline <select> dropdowns that replace [[n]] placeholders.
 * Each dropdown belongs to a choice group; gaps sharing identical option lists share a group.
 */
async function extractMoodleSelectMissingWords(
  questionEl: Element,
): Promise<DetectedQuestion | null> {
  const courseName = extractMoodleCourseName();

  const qnoEl = questionEl.querySelector(".qno");
  const questionNumber = qnoEl ? parseInt(qnoEl.textContent?.trim() || "1") : 1;

  const qtextEl = questionEl.querySelector(".qtext");
  if (!qtextEl) return null;

  const liveSelects = Array.from(qtextEl.querySelectorAll("select"));
  if (liveSelects.length === 0) return null;

  // Clone to reconstruct text without modifying the live DOM
  const cloned = qtextEl.cloneNode(true) as Element;
  const clonedSelects = Array.from(cloned.querySelectorAll("select"));

  const selectGaps: SelectGap[] = [];
  const selectChoices: Record<string, string[]> = {};

  // fingerprint → groupId, so gaps sharing the same option list reuse the same group
  const choiceFingerprints = new Map<string, string>();
  let groupCounter = 0;

  for (let i = 0; i < liveSelects.length; i++) {
    const liveSelect = liveSelects[i];
    const clonedSelect = clonedSelects[i];
    const gapIndex = i + 1; // 1-based

    // Collect choices (skip the "Choose..." placeholder at value 0)
    const choices: string[] = [];
    for (const opt of Array.from(liveSelect.querySelectorAll("option"))) {
      const value = parseInt(opt.getAttribute("value") || "0");
      if (value > 0) {
        choices.push(opt.textContent?.trim() || "");
      }
    }

    // Determine group by fingerprinting the choice list
    const fingerprint = choices.join("|");
    let groupId: string;
    if (choiceFingerprints.has(fingerprint)) {
      groupId = choiceFingerprints.get(fingerprint)!;
    } else {
      groupId = String.fromCharCode(65 + groupCounter); // A, B, C...
      groupCounter++;
      choiceFingerprints.set(fingerprint, groupId);
      selectChoices[groupId] = choices;
    }

    // Replace the cloned <select> with a plain-text [[n]] marker
    clonedSelect.replaceWith(`[[${gapIndex}]]`);

    selectGaps.push({ index: gapIndex, groupId, leftContext: "", rightContext: "" });
  }

  // Reconstruct question text and fill in gap contexts
  const fullText = (cloned.textContent || "").replace(/\s+/g, " ").trim();

  for (const gap of selectGaps) {
    const marker = `[[${gap.index}]]`;
    const pos = fullText.indexOf(marker);
    if (pos !== -1) {
      gap.leftContext = fullText.substring(0, pos).slice(-60).trim();
      gap.rightContext = fullText.substring(pos + marker.length, pos + marker.length + 60).trim();
    }
  }

  if (!fullText || selectGaps.length === 0) return null;

  return {
    id: `moodle-q-${questionNumber}`,
    type: "select-missing-words",
    text: fullText,
    options: [],
    element: questionEl,
    questionNumber,
    platform: "moodle",
    confidence: 95,
    courseName,
    selectGaps,
    selectChoices,
  };
}

/**
 * Build a map of all questions (mcq and matching) indexed by question number
 * Each entry contains: { type, question, score, element }
 * @returns Map of question number to question data
 */
export function buildQuestionMap(): QuestionMap {
  const questionMap: QuestionMap = {};
  const viewportCenterY = window.innerHeight / 2;
  const viewportCenterX = window.innerWidth / 2;
  let syntheticQuestionNum = 1000000;

  // Collect all mcq-views
  const mcqViews = querySelectorAllDeep("mcq-view");

  // Collect all matching-views (drag-and-drop style)
  const matchingViews = querySelectorAllDeep("object-matching-view");

  // Collect all matching-view (dropdown style - new format)
  const dropdownMatchingViews = querySelectorAllDeep("matching-view");

  // Process mcq-views - find their associated question numbers
  for (const mcqView of mcqViews) {
    const rect = mcqView.getBoundingClientRect();
    const hasSize = rect.width > 0 && rect.height > 0;
    if (!hasSize) continue;

    // Find the question number associated with this mcq-view
    const questionNum = findQuestionNumberForElement(mcqView);
    if (questionNum === null) continue;

    // Calculate visibility score
    const centerDist = Math.sqrt(
      Math.pow(rect.left + rect.width / 2 - viewportCenterX, 2) +
        Math.pow(rect.top + rect.height / 2 - viewportCenterY, 2),
    );
    const score = 10000 - centerDist;

    // Extract question data
    const question = extractQuestionFromMcqView(mcqView, questionNum);
    if (!question || question.options.length < 2) continue;

    // Only add if this question number doesn't exist or has a higher score
    if (!questionMap[questionNum] || questionMap[questionNum].score < score) {
      questionMap[questionNum] = {
        type: "mcq",
        question: question,
        score: score,
        element: mcqView,
      };
    }
  }

  // Process matching-views - find their associated question numbers
  for (const matchingView of matchingViews) {
    const rect = matchingView.getBoundingClientRect();
    const hasSize = rect.width > 0 && rect.height > 0;
    if (!hasSize) continue;

    // Find the question number associated with this matching-view
    const detectedQuestionNum = findQuestionNumberForElement(matchingView);
    const questionNum =
      detectedQuestionNum !== null
        ? detectedQuestionNum
        : syntheticQuestionNum++;

    // Calculate visibility score
    const centerDist = Math.sqrt(
      Math.pow(rect.left + rect.width / 2 - viewportCenterX, 2) +
        Math.pow(rect.top + rect.height / 2 - viewportCenterY, 2),
    );
    const score = 10000 - centerDist;

    // Extract matching question data
    const question = extractMatchingQuestionFromView(matchingView, questionNum);
    if (!question) continue;

    // Only add if this question number doesn't exist or has a higher score
    if (!questionMap[questionNum] || questionMap[questionNum].score < score) {
      questionMap[questionNum] = {
        type: "matching",
        question: question,
        score: score,
        element: matchingView,
      };
    }
  }

  // Process dropdown matching-views (new format with dropdowns)
  for (const matchingView of dropdownMatchingViews) {
    const rect = matchingView.getBoundingClientRect();
    const hasSize = rect.width > 0 && rect.height > 0;
    if (!hasSize) continue;

    // Find the question number associated with this matching-view
    const detectedQuestionNum = findQuestionNumberForElement(matchingView);
    const questionNum =
      detectedQuestionNum !== null
        ? detectedQuestionNum
        : syntheticQuestionNum++;

    // Calculate visibility score
    const centerDist = Math.sqrt(
      Math.pow(rect.left + rect.width / 2 - viewportCenterX, 2) +
        Math.pow(rect.top + rect.height / 2 - viewportCenterY, 2),
    );
    const score = 10000 - centerDist;

    // Extract dropdown matching question data
    const question = extractDropdownMatchingFromView(matchingView, questionNum);
    if (!question) continue;

    // Only add if this question number doesn't exist or has a higher score
    if (!questionMap[questionNum] || questionMap[questionNum].score < score) {
      questionMap[questionNum] = {
        type: "matching",
        question: question,
        score: score,
        element: matchingView,
      };
    }
  }

  return questionMap;
}

/**
 * Find the question number associated with a question element (mcq-view or object-matching-view)
 * by searching for "Pregunta X" text in parent/sibling elements and shadow DOMs
 * @param element - The question element
 * @returns The question number or null
 */
export function findQuestionNumberForElement(element: Element): number | null {
  // Strategy 1: Look in ancestor elements and their shadow roots for "Pregunta X"
  let parent: Element | null = element.parentElement || (element.getRootNode() as ShadowRoot)?.host;
  let depth = 0;
  const maxDepth = 15;

  while (parent && depth < maxDepth) {
    // Check text content of siblings at this level (including shadow roots)
    const siblings = parent.children;
    for (const sibling of siblings) {
      if (sibling === element) continue;

      // Check sibling's text content
      let text = sibling.textContent || "";
      const match = text.match(/pregunta\s*(\d+)/i);
      if (match) {
        return parseInt(match[1]);
      }

      // Check sibling's shadow root if present
      if (sibling.shadowRoot) {
        const shadowText = sibling.shadowRoot.textContent || "";
        const shadowMatch = shadowText.match(/pregunta\s*(\d+)/i);
        if (shadowMatch) {
          return parseInt(shadowMatch[1]);
        }
      }
    }

    // Check parent's own text (excluding children)
    const parentText = getDirectTextContent(parent);
    const parentMatch = parentText.match(/pregunta\s*(\d+)/i);
    if (parentMatch) {
      return parseInt(parentMatch[1]);
    }

    // Check parent's shadow root
    if (parent.shadowRoot) {
      const shadowText = parent.shadowRoot.textContent || "";
      const shadowMatch = shadowText.match(/pregunta\s*(\d+)/i);
      if (shadowMatch) {
        return parseInt(shadowMatch[1]);
      }
    }

    // Move up - handle both regular DOM and shadow DOM
    if (parent.parentElement) {
      parent = parent.parentElement;
    } else if ((parent.getRootNode() as ShadowRoot)?.host) {
      parent = (parent.getRootNode() as ShadowRoot).host;
    } else {
      break;
    }
    depth++;
  }

  // Strategy 2: Look in the element's shadow root for question number
  if (element.shadowRoot) {
    const shadowText = element.shadowRoot.textContent || "";
    const match = shadowText.match(/pregunta\s*(\d+)/i);
    if (match) {
      return parseInt(match[1]);
    }
  }

  // Strategy 3: Use position-based estimation
  // Find all "Pregunta X" elements and match by proximity
  const rect = element.getBoundingClientRect();
  if (rect.width === 0 || rect.height === 0) return null;

  const preguntaElements: PreguntaElement[] = [];

  function collectPreguntaElements(root: Element | Document | ShadowRoot): void {
    const walker = document.createTreeWalker(root as Node, NodeFilter.SHOW_TEXT);
    let node: Text | null;
    while ((node = walker.nextNode() as Text | null)) {
      if (node.textContent && /pregunta\s*\d+/i.test(node.textContent)) {
        const match = node.textContent.match(/pregunta\s*(\d+)/i);
        if (match && node.parentElement) {
          const preguntaRect = node.parentElement.getBoundingClientRect();
          if (preguntaRect.width > 0 && preguntaRect.height > 0) {
            preguntaElements.push({
              num: parseInt(match[1]),
              rect: preguntaRect,
              element: node.parentElement,
            });
          }
        }
      }
    }
    // Check shadow roots
    const elements = root.querySelectorAll("*");
    elements.forEach((el) => {
      if (el.shadowRoot) {
        collectPreguntaElements(el.shadowRoot);
      }
    });
  }

  collectPreguntaElements(document);

  // Find the "Pregunta X" element that is closest vertically and above the question element
  let bestMatch: PreguntaElement | null = null;
  let bestDistance = Infinity;

  for (const pregunta of preguntaElements) {
    // The "Pregunta X" text should be above or at the same level as the question
    const verticalDist = rect.top - pregunta.rect.bottom;
    const horizontalDist = Math.abs(
      rect.left +
        rect.width / 2 -
        (pregunta.rect.left + pregunta.rect.width / 2),
    );

    // Only consider elements that are above the question (with some tolerance)
    if (verticalDist >= -50 && verticalDist < 500) {
      const totalDist = Math.abs(verticalDist) + horizontalDist * 0.5;
      if (totalDist < bestDistance) {
        bestDistance = totalDist;
        bestMatch = pregunta;
      }
    }
  }

  if (bestMatch) {
    return bestMatch.num;
  }

  return null;
}

/**
 * Extract matching question data from an object-matching-view element
 * Supports both drag-drop style and dropdown style within object-matching-view
 * @param matchingView - The matching view element
 * @param questionNumber - The question number
 * @returns Question data or null
 */
export function extractMatchingQuestionFromView(
  matchingView: Element,
  questionNumber: number
): DetectedQuestion | null {
  const shadowRoot = matchingView.shadowRoot;
  if (!shadowRoot) return null;

  // Extract question text
  let questionText = "";
  const bodyEls = querySelectorAllDeep(
    ".component__body-inner, .objectMatching__body-inner",
    shadowRoot,
  );
  if (bodyEls.length > 0) {
    questionText = bodyEls[0].textContent?.trim() || "";
  }

  // Check if this is the dropdown style (object-matching-dropdown-view)
  const dropdownViews = querySelectorAllDeep(
    "object-matching-dropdown-view",
    shadowRoot,
  );

  if (dropdownViews.length > 0) {
    // Dropdown style matching within object-matching-view
    const categories: MatchingCategory[] = [];
    const availableOptions = new Set<string>();

    dropdownViews.forEach((dropdownView, index) => {
      const dropdownShadow = dropdownView.shadowRoot;
      if (!dropdownShadow) return;

      // Get the category letter and text
      const letterEl = dropdownShadow.querySelector(".category-item-number");
      const titleEl = dropdownShadow.querySelector(
        ".matching__item-title_inner",
      );

      if (titleEl) {
        const letter = letterEl
          ? letterEl.textContent?.trim() || String.fromCharCode(65 + index)
          : String.fromCharCode(65 + index);
        const text = titleEl.textContent?.trim() || "";

        // Skip blank/placeholder items
        if (text && !text.includes("objetivo dejado en blanco")) {
          categories.push({
            letter: letter,
            text: text,
          });
        }
      }

      // Get the dropdown button to find available options
      // The options are shown in a dropdown list or can be inferred from aria-label
      const dropdownBtn = dropdownShadow.querySelector(".dropdown__btn");
      if (dropdownBtn) {
        const selectedText = dropdownShadow
          .querySelector(".dropdown__inner")
          ?.textContent?.trim();
        // If an option is selected (not placeholder), add it to available options
        if (
          selectedText &&
          !selectedText.includes("sélectionner") &&
          !selectedText.includes("Seleccione") &&
          !selectedText.includes("Select")
        ) {
          availableOptions.add(selectedText);
        }
      }

      // Also look for dropdown list items if visible
      const listItems = dropdownShadow.querySelectorAll(
        ".dropdown__item-inner",
      );
      listItems.forEach((item) => {
        const optText = item.textContent?.trim();
        if (
          optText &&
          !optText.includes("sélectionner") &&
          !optText.includes("Seleccione") &&
          !optText.includes("Select")
        ) {
          availableOptions.add(optText);
        }
      });
    });

    // Convert options to array with numbers
    const matchingOptions: MatchingOption[] = Array.from(availableOptions).map((opt, idx) => ({
      index: idx + 1,
      text: opt,
    }));

    if (categories.length >= 2) {
      return {
        id: `matching-${questionNumber}`,
        type: "matching",
        matchingStyle: "object-dropdown" as MatchingStyle, // Flag for object-matching with dropdowns
        questionNumber: questionNumber,
        text: questionText || `Pregunta ${questionNumber || "?"}`,
        categories: categories,
        matchingOptions:
          matchingOptions.length > 0
            ? matchingOptions
            : [{ index: 1, text: "(options in dropdown)" }],
        element: matchingView,
        options: [], // Required by interface
        confidence: 95,
      };
    }
  }

  // Standard drag-drop style matching
  // Extract categories (left side - A, B, C...)
  const categories: MatchingCategory[] = [];
  const categoryItems = querySelectorAllDeep(
    ".objectMatching-category-item",
    shadowRoot,
  );
  categoryItems.forEach((item, index) => {
    const textEl = item.querySelector(".category-item-text");
    const letterEl = item.querySelector(".category-item-number");
    if (textEl) {
      const text = textEl.textContent?.trim() || "";
      const letter = letterEl
        ? letterEl.textContent?.trim() || String.fromCharCode(65 + index)
        : String.fromCharCode(65 + index);
      categories.push({
        letter: letter,
        text: text,
      });
    }
  });

  // Extract options (right side - to be matched)
  const matchingOptions: MatchingOption[] = [];
  const optionItems = querySelectorAllDeep(
    ".objectMatching-option-item",
    shadowRoot,
  );
  optionItems.forEach((item, index) => {
    const textEl = item.querySelector(".category-item-text");
    if (textEl) {
      const text = textEl.textContent?.trim() || "";
      matchingOptions.push({
        index: index + 1,
        text: text,
      });
    }
  });

  if (categories.length >= 2 && matchingOptions.length >= 2) {
    return {
      id: `matching-${questionNumber}`,
      type: "matching",
      questionNumber: questionNumber,
      text: questionText || `Pregunta ${questionNumber || "?"}`,
      categories: categories,
      matchingOptions: matchingOptions,
      element: matchingView,
      options: [], // Required by interface
      confidence: 95,
    };
  }
  return null;
}

/**
 * Extract matching question data from a matching-view element (dropdown style)
 * This is a newer format used in NetAcad's "Mide Tu Conocimiento" assessments
 * Each item has a description and a dropdown to select the matching option (e.g., TCP/UDP)
 * @param matchingView - The matching view element
 * @param questionNumber - The question number
 * @returns Question data or null
 */
export function extractDropdownMatchingFromView(
  matchingView: Element,
  questionNumber: number
): DetectedQuestion | null {
  const shadowRoot = matchingView.shadowRoot;
  if (!shadowRoot) return null;

  // Extract question text (instruction)
  let questionText = "";
  const bodyEls = querySelectorAllDeep(
    ".component__body-inner, .matching__body-inner",
    shadowRoot,
  );
  if (bodyEls.length > 0) {
    questionText = bodyEls[0].textContent?.trim() || "";
  }

  // Extract dropdown items - each has a description that needs to be matched
  // The structure is: matching-dropdown-view elements, each with:
  //   - .matching__item-title_inner (the description to match)
  //   - .dropdown__list with options (what to match to)
  const descriptions: MatchingOption[] = []; // Items to be matched (left side descriptions)
  const availableOptions = new Set<string>(); // Available options (e.g., TCP, UDP)

  // Find all matching-dropdown-view elements
  const dropdownViews = querySelectorAllDeep(
    "matching-dropdown-view",
    shadowRoot,
  );

  dropdownViews.forEach((dropdownView, index) => {
    const dropdownShadow = dropdownView.shadowRoot;
    if (!dropdownShadow) return;

    // Get the description text
    const titleEl = dropdownShadow.querySelector(".matching__item-title_inner");
    if (titleEl) {
      const descText = titleEl.textContent?.trim() || "";
      descriptions.push({
        index: index + 1,
        text: descText,
      });
    }

    // Get the available dropdown options (usually same for all dropdowns)
    const optionItems = dropdownShadow.querySelectorAll(
      ".dropdown__item-inner",
    );
    optionItems.forEach((optEl) => {
      const optText = optEl.textContent?.trim();
      if (optText && optText !== "Seleccione una opción") {
        availableOptions.add(optText);
      }
    });
  });

  // Convert options set to array with letter assignments
  const matchingOptionsAsCategories: MatchingCategory[] = Array.from(availableOptions).map((opt, idx) => ({
    letter: String.fromCharCode(65 + idx), // A, B, C...
    text: opt,
  }));

  // For this type of matching, the "categories" are the possible answers (TCP, UDP, etc.)
  // and the "matchingOptions" are the descriptions that need to be matched
  if (descriptions.length >= 2 && matchingOptionsAsCategories.length >= 1) {
    return {
      id: `matching-dropdown-${questionNumber}`,
      type: "matching",
      matchingStyle: "dropdown" as MatchingStyle, // Flag to indicate dropdown style
      questionNumber: questionNumber,
      text: questionText || `Pregunta ${questionNumber || "?"}`,
      categories: matchingOptionsAsCategories, // The answer options (TCP, UDP)
      matchingOptions: descriptions, // The descriptions to match
      element: matchingView,
      options: [], // Required by interface
      confidence: 95,
    };
  }
  return null;
}

/**
 * Extract question data from a single mcq-view element
 * @param mcqView - The mcq-view element
 * @param questionNumber - The question number
 * @returns Question data or null
 */
export function extractQuestionFromMcqView(
  mcqView: Element,
  questionNumber: number
): DetectedQuestion | null {
  const shadowRoot = mcqView.shadowRoot;
  if (!shadowRoot) return null;

  // Extract question text
  let questionText = "";
  const questionBodyEls = querySelectorAllDeep(".mcq__body-inner", shadowRoot);
  if (questionBodyEls.length > 0) {
    questionText = questionBodyEls[0].textContent?.trim() || "";
  }

  // Try to find accessibility descriptions for images/diagrams
  // These are usually in parent elements (block-view, tabs-view, etc.)
  let accessibilityContext = "";

  // Search in the mcq-view's shadow root first
  accessibilityContext = extractAccessibilityDescriptions(shadowRoot);

  // If not found, search in parent block-view or tabs-view elements
  if (!accessibilityContext) {
    // Try to find parent container that might have the diagram
    let parent: Element | null = mcqView.parentElement;
    let depth = 0;
    while (parent && depth < 10) {
      // Check if this element or its shadow root has accessibility descriptions
      accessibilityContext = extractAccessibilityDescriptions(parent);
      if (accessibilityContext) break;

      // Also check for block-view shadow roots
      if (parent.shadowRoot) {
        accessibilityContext = extractAccessibilityDescriptions(
          parent.shadowRoot,
        );
        if (accessibilityContext) break;
      }

      // Look for specific NetAcad container types
      if (
        parent.tagName &&
        (parent.tagName.toLowerCase().includes("block-view") ||
          parent.tagName.toLowerCase().includes("tabs-view") ||
          parent.classList?.contains("component__container"))
      ) {
        // Search deeply in this container
        const allElements = parent.querySelectorAll("*");
        for (const el of allElements) {
          if (el.shadowRoot) {
            accessibilityContext = extractAccessibilityDescriptions(
              el.shadowRoot,
            );
            if (accessibilityContext) break;
          }
        }
        if (accessibilityContext) break;
      }

      parent = parent.parentElement;
      depth++;
    }
  }

  // Last resort: search the entire document for any a11y_description
  // This handles cases where the diagram is in a sibling component (tabs-view)
  if (!accessibilityContext) {
    log("[Study Assist] Searching entire document for diagram descriptions...");
    accessibilityContext = extractAccessibilityDescriptions(document.body);
  }

  // If we found accessibility context (diagram description), append it to question
  if (accessibilityContext) {
    log("[Study Assist] Adding diagram description to question context");
    questionText =
      questionText + "\n\n[DIAGRAM DESCRIPTION]\n" + accessibilityContext;
  }

  // Extract options
  const optionEls = querySelectorAllDeep(".mcq__item-text-inner", shadowRoot);
  const options: QuestionOption[] = [];
  optionEls.forEach((optEl, optIndex) => {
    const optText = optEl.textContent?.trim() || "";
    if (optText && optText.length > 0) {
      options.push({
        letter: String.fromCharCode(65 + optIndex),
        text: optText,
      });
    }
  });

  if (options.length < 2) return null;

  return {
    id: `mcq-${questionNumber}`,
    type: "multiple-choice",
    questionNumber: questionNumber,
    text: questionText || `Pregunta ${questionNumber || "?"}`,
    options: options,
    element: mcqView,
    confidence: 95,
  };
}
