/**
 * Study Assist - Content Script Entry Point
 * Initializes the extension and wires modules together
 */

// ============================================
// Module Imports
// ============================================
import { log, state, DEFAULT_ALLOWED_DOMAINS } from "./modules/state.js";
import {
  detectQuestionsOnPage,
  detectVisibleQuestion,
  refreshCurrentQuestion,
  frameHasQuizContent,
  waitForQuizContent,
} from "./modules/detection.js";
import {
  showReloadPrompt,
  createOverlayContainer,
  createQuickButton,
  highlightDetectedQuestions,
  clearAllHighlights,
  hideOverlay,
  displayAnalysisResult,
  resetQuickAnswer,
  toggleSAButtonVisibility,
  displaySingleQuestion,
  showQuestionsSummary,
} from "./modules/ui.js";
import { setupKeyboardHandlers } from "./modules/keyboard.js";
import {
  handleQuickClick,
  reloadQuickMode,
  triggerQuickAnalysis,
  cancelCurrentRequest,
  analyzeQuestion,
  startQuestionChangeObserver,
} from "./modules/api.js";

import type { DetectedQuestion, Settings } from "../types/index.js";

// ============================================
// Domain Check
// ============================================
async function checkDomainAllowed(): Promise<boolean> {
  try {
    const result = await chrome.storage.local.get(["allowedDomains"]);
    const allowedDomains: string[] = result.allowedDomains ?? DEFAULT_ALLOWED_DOMAINS;

    const currentHostname = window.location.hostname.toLowerCase();

    const isAllowed = allowedDomains.some((domain: string) => {
      return (
        currentHostname === domain || currentHostname.endsWith("." + domain)
      );
    });

    state.isDomainAllowed = isAllowed;
    return isAllowed;
  } catch (error) {
    console.error("[Study Assist] Error checking domain:", error);
    return false;
  }
}

// ============================================
// Content Observer
// ============================================
function setupContentObserver(): void {
  if (state.contentObserver) return;

  let debounceTimer: ReturnType<typeof setTimeout> | null = null;

  state.contentObserver = new MutationObserver((_mutations: MutationRecord[]) => {
    if (debounceTimer) clearTimeout(debounceTimer);
    debounceTimer = setTimeout(() => {
      if (
        state.settings.quickMode &&
        !document.getElementById("study-assist-quick-container")
      ) {
        if (frameHasQuizContent()) {
          initQuickButton();
        }
      }
    }, 500);
  });

  state.contentObserver.observe(document.body ?? document.documentElement, {
    childList: true,
    subtree: true,
  });
}

// ============================================
// Quick Button Initialization with Callbacks
// ============================================
function initQuickButton(): void {
  createQuickButton({
    handleQuickClick: (e: MouseEvent) =>
      handleQuickClick(e, {
        detectVisibleQuestion,
        startQuestionChangeObserver,
      }),
  });
}

// ============================================
// Callback wrappers
// ============================================

/** Analyze a question with proper callback wiring */
function analyzeQuestionWithCallbacks(question: DetectedQuestion): Promise<void> {
  return analyzeQuestion(question, {
    detectVisibleQuestion,
    startQuestionChangeObserver,
  });
}

/** Show questions summary with proper callback wiring */
function showQuestionsSummaryWithCallbacks(): Promise<void> {
  return showQuestionsSummary(detectVisibleQuestion, analyzeQuestionWithCallbacks);
}

// ============================================
// Overlay Container Initialization with Callbacks
// ============================================
function initOverlayContainer(): void {
  createOverlayContainer({
    frameHasQuizContent,
    waitForQuizContent,
    handleQuickClick: (e: MouseEvent) =>
      handleQuickClick(e, {
        detectVisibleQuestion,
        startQuestionChangeObserver,
      }),
  });
}

// ============================================
// Keyboard Setup with Callbacks
// ============================================
function initKeyboardHandlers(): void {
  setupKeyboardHandlers({
    triggerQuickAnalysis: () =>
      triggerQuickAnalysis({
        detectVisibleQuestion,
        startQuestionChangeObserver,
      }),
    reloadQuickMode: () =>
      reloadQuickMode({
        detectVisibleQuestion,
        startQuestionChangeObserver,
      }),
    toggleSAButtonVisibility,
    cancelCurrentRequest,
  });
}

// ============================================
// Detection with Callbacks
// ============================================
async function runDetection(): Promise<void> {
  const result = await detectQuestionsOnPage();
  
  if (result && result.found && state.settings.highlightQuestions) {
    highlightDetectedQuestions(analyzeQuestionWithCallbacks);
  }
}

// ============================================
// Initialization
// ============================================
async function initialize(): Promise<void> {
  try {
    const domainAllowed = await checkDomainAllowed();
    if (!domainAllowed) {
      return;
    }

    const result = await chrome.storage.local.get([
      "extensionActive",
      "responseMode",
      "autoDetect",
      "highlightQuestions",
      "quickMode",
      "sendImages",
      "buttonPosition",
    ]);

    state.isActive = result.extensionActive ?? false;

    if (!state.isActive) {
      return;
    }

    state.settings.responseMode = result.responseMode ?? "guided";
    state.settings.autoDetect = result.autoDetect ?? true;
    state.settings.highlightQuestions = result.highlightQuestions ?? true;
    state.settings.quickMode = result.quickMode ?? false;
    state.settings.sendImages = result.sendImages ?? false;
    state.settings.buttonPosition = result.buttonPosition ?? "bottom-right";

    state.isInitialized = true;

    try {
      if (state.settings.quickMode) {
        initKeyboardHandlers();
      }
    } catch (kbErr) {
      console.error("[Study Assist] Keyboard init error:", kbErr);
    }

    try {
      initOverlayContainer();
    } catch (ovErr) {
      console.error("[Study Assist] Overlay init error:", ovErr);
    }

    if (state.isActive && state.settings.autoDetect) {
      setTimeout(() => runDetection(), 1000);
    }

    try {
      setupContentObserver();
    } catch (obsErr) {
      console.error("[Study Assist] Observer init error:", obsErr);
    }
  } catch (error) {
    console.error("[Study Assist] Initialization error:", error);
  }
}

// ============================================
// QA Sandbox (Manual Testing)
// ============================================

type QAScenarioType =
  | "moodle-mcq"
  | "moodle-truefalse"
  | "netacad-mcq"
  | "netacad-matching";

function clearQASandbox(): void {
  const sandbox = document.getElementById("study-assist-qa-sandbox");
  if (sandbox) sandbox.remove();
}

function injectNetAcadMcq(target: HTMLElement): void {
  target.innerHTML = `
    <div class="qa-block">
      <h3>NetAcad Simulado — Opción múltiple</h3>
      <p class="qa-tip">Usa <strong>SHIFT</strong> para quick mode, o clic en badge para análisis completo.</p>
      <div class="qa-question-title">Pregunta 1</div>
      <mcq-view id="qa-netacad-mcq"></mcq-view>
    </div>
  `;

  const mcqView = target.querySelector("#qa-netacad-mcq") as HTMLElement | null;
  if (!mcqView) return;

  const shadowRoot = mcqView.attachShadow({ mode: "open" });
  shadowRoot.innerHTML = `
    <style>
      .mcq__body-inner { font-size: 16px; margin-bottom: 12px; color: #1f2937; }
      .mcq__item { margin: 8px 0; padding: 10px; border: 1px solid #e5e7eb; border-radius: 8px; background: #fff; }
      .mcq__item-text-inner { font-size: 14px; color: #111827; }
    </style>
    <div class="mcq__body-inner">¿Cuál capa del modelo OSI se encarga del enrutamiento?</div>
    <div class="mcq__item"><div class="mcq__item-text-inner">Capa Física</div></div>
    <div class="mcq__item"><div class="mcq__item-text-inner">Capa de Enlace</div></div>
    <div class="mcq__item"><div class="mcq__item-text-inner">Capa de Red</div></div>
    <div class="mcq__item"><div class="mcq__item-text-inner">Capa de Aplicación</div></div>
  `;
}

function injectNetAcadMatching(target: HTMLElement): void {
  target.innerHTML = `
    <div class="qa-block">
      <h3>NetAcad Simulado — Matching</h3>
      <p class="qa-tip">En quick mode la respuesta se mostrará como pares (ej. <strong>A-2</strong>).</p>
      <div class="qa-question-title">Pregunta 1</div>
      <object-matching-view id="qa-netacad-matching"></object-matching-view>
    </div>
  `;

  const matchingView = target.querySelector("#qa-netacad-matching") as HTMLElement | null;
  if (!matchingView) return;

  const shadowRoot = matchingView.attachShadow({ mode: "open" });
  shadowRoot.innerHTML = `
    <style>
      .component__body-inner { font-size: 16px; margin-bottom: 12px; color: #1f2937; }
      .objectMatching-category-item,
      .objectMatching-option-item {
        display: flex;
        align-items: center;
        gap: 8px;
        margin: 6px 0;
        padding: 8px;
        border: 1px solid #e5e7eb;
        border-radius: 8px;
        background: #fff;
      }
      .category-item-number { font-weight: 700; min-width: 20px; }
      .category-item-text { color: #111827; }
    </style>
    <div class="component__body-inner">Relaciona cada protocolo con su puerto por defecto.</div>
    <div class="objectMatching-category-item"><span class="category-item-number">A</span><span class="category-item-text">HTTP</span></div>
    <div class="objectMatching-category-item"><span class="category-item-number">B</span><span class="category-item-text">HTTPS</span></div>
    <div class="objectMatching-category-item"><span class="category-item-number">C</span><span class="category-item-text">SSH</span></div>
    <hr />
    <div class="objectMatching-option-item"><span class="category-item-text">443</span></div>
    <div class="objectMatching-option-item"><span class="category-item-text">22</span></div>
    <div class="objectMatching-option-item"><span class="category-item-text">80</span></div>
  `;
}

function injectQAScenario(scenario: QAScenarioType): void {
  clearQASandbox();

  const styleId = "study-assist-qa-sandbox-style";
  if (!document.getElementById(styleId)) {
    const style = document.createElement("style");
    style.id = styleId;
    style.textContent = `
      #study-assist-qa-sandbox {
        position: relative;
        z-index: 9997;
        margin: 20px;
        padding: 16px;
        border: 2px dashed #3b82f6;
        border-radius: 12px;
        background: #f8fafc;
        box-shadow: 0 2px 10px rgba(0,0,0,0.08);
        font-family: Arial, sans-serif;
      }
      #study-assist-qa-sandbox h2 { margin: 0 0 8px; color: #1d4ed8; }
      #study-assist-qa-sandbox .qa-meta { margin: 0 0 12px; color: #334155; font-size: 13px; }
      #study-assist-qa-sandbox .qa-block { margin-top: 10px; }
      #study-assist-qa-sandbox .qa-question-title { font-weight: 700; margin: 10px 0; }
      #study-assist-qa-sandbox .qa-tip { color: #475569; font-size: 13px; margin-bottom: 8px; }
      #study-assist-qa-sandbox .que {
        border: 1px solid #e2e8f0;
        border-radius: 10px;
        padding: 12px;
        background: white;
      }
      #study-assist-qa-sandbox .qtext { margin: 8px 0; color: #111827; }
      #study-assist-qa-sandbox .answer .r0,
      #study-assist-qa-sandbox .answer .r1 {
        margin: 6px 0;
        display: flex;
        align-items: center;
        gap: 8px;
      }
    `;
    document.head.appendChild(style);
  }

  const wrapper = document.createElement("section");
  wrapper.id = "study-assist-qa-sandbox";
  wrapper.innerHTML = `
    <h2>🧪 Study Assist QA Sandbox</h2>
    <p class="qa-meta">
      Escenario: <strong>${scenario}</strong> · Usa ALT+W para recargar detección y SHIFT para quick analysis.
    </p>
  `;

  const content = document.createElement("div");
  wrapper.appendChild(content);

  if (scenario === "moodle-mcq") {
    content.innerHTML = `
      <div class="qa-block">
        <h3>Moodle Simulado — Opción múltiple</h3>
        <div class="que multichoice">
          <div class="info"><h3 class="no">Pregunta <span class="qno">1</span></h3></div>
          <div class="qtext">¿Qué protocolo utiliza el puerto 443 por defecto?</div>
          <div class="answer">
            <div class="r0"><span class="answernumber">a.</span><div class="flex-fill">HTTP</div></div>
            <div class="r1"><span class="answernumber">b.</span><div class="flex-fill">HTTPS</div></div>
            <div class="r0"><span class="answernumber">c.</span><div class="flex-fill">FTP</div></div>
            <div class="r1"><span class="answernumber">d.</span><div class="flex-fill">Telnet</div></div>
          </div>
        </div>
      </div>
    `;
  } else if (scenario === "moodle-truefalse") {
    content.innerHTML = `
      <div class="qa-block">
        <h3>Moodle Simulado — Verdadero/Falso</h3>
        <div class="que truefalse">
          <div class="info"><h3 class="no">Pregunta <span class="qno">1</span></h3></div>
          <div class="qtext">La entropía representa la tendencia natural de un sistema a desorganizarse.</div>
          <div class="answer">
            <div class="r0">
              <input type="radio" name="qa_tf" value="1" id="qa_tf_true" />
              <label for="qa_tf_true" class="ms-1">Verdadero</label>
            </div>
            <div class="r1">
              <input type="radio" name="qa_tf" value="0" id="qa_tf_false" />
              <label for="qa_tf_false" class="ms-1">Falso</label>
            </div>
          </div>
        </div>
      </div>
    `;
  } else if (scenario === "netacad-mcq") {
    injectNetAcadMcq(content);
  } else {
    injectNetAcadMatching(content);
  }

  document.body.prepend(wrapper);
}

async function runQAPreview(): Promise<number> {
  const result = await detectQuestionsOnPage();
  if (result?.found) {
    highlightDetectedQuestions(analyzeQuestionWithCallbacks);
  }
  return result?.count ?? 0;
}

// ============================================
// Message Listener
// ============================================
interface ContentMessage {
  type: string;
  active?: boolean;
  settings?: Partial<Settings>;
  result?: string;
  question?: DetectedQuestion;
  scenario?: QAScenarioType;
}

chrome.runtime.onMessage.addListener(
  (
    message: ContentMessage,
    _sender: chrome.runtime.MessageSender,
    sendResponse: (response: { success: boolean; error?: string }) => void
  ): boolean => {
    switch (message.type) {
      case "EXTENSION_STATE_CHANGED":
        state.isActive = message.active ?? false;
        if (!state.isActive) {
          clearAllHighlights();
          hideOverlay();
        } else if (!state.isInitialized) {
          checkDomainAllowed().then((allowed) => {
            if (allowed) {
              showReloadPrompt();
            }
          });
        } else if (state.isDomainAllowed && state.settings.autoDetect) {
          runDetection();
        }
        sendResponse({ success: true });
        break;

      case "SETTINGS_CHANGED":
        if (!state.isDomainAllowed) {
          sendResponse({ success: false, error: "Domain not allowed" });
          break;
        }
        const oldQuickMode = state.settings.quickMode;
        state.settings = { ...state.settings, ...message.settings } as Settings;

        if (oldQuickMode !== state.settings.quickMode) {
          initOverlayContainer();
          if (state.settings.quickMode) {
            initKeyboardHandlers();
          }
        }

        if (state.settings.highlightQuestions && state.isActive) {
          highlightDetectedQuestions(analyzeQuestionWithCallbacks);
        } else {
          clearAllHighlights();
        }
        sendResponse({ success: true });
        break;

      case "ANALYZE_PAGE":
        if (!state.isDomainAllowed) {
          sendResponse({ success: false, error: "Domain not allowed" });
          break;
        }
        if (state.isActive) {
          runDetection();
        }
        sendResponse({ success: true });
        break;

      case "CLEAR_RESULTS":
        clearAllHighlights();
        hideOverlay();
        state.detectedQuestions = [];
        sendResponse({ success: true });
        break;

      case "FORCE_STATE_RESET":
        // Reset all processing locks without clearing UI or history
        state.isRequestInProgress = false;
        state.hasValidAnswer = false;
        state.skipDeepSeek = false;
        state.requestCancelled = false;
        state.pendingQuestionChange = null;
        if (state.slowConnectionTimer) {
          clearTimeout(state.slowConnectionTimer);
          state.slowConnectionTimer = null;
        }
        log("[Study Assist] Force state reset complete");
        sendResponse({ success: true });
        break;

      case "ANALYSIS_RESULT":
        if (message.result && message.question) {
          displayAnalysisResult(
            message.result,
            message.question,
            showQuestionsSummaryWithCallbacks
          );
        }
        sendResponse({ success: true });
        break;

      case "QA_INJECT_SCENARIO":
        (async () => {
          try {
            const scenario = message.scenario ?? "moodle-truefalse";
            injectQAScenario(scenario);

            // Allow QA usage even if current domain is not in allowlist
            state.isDomainAllowed = true;
            state.isActive = true;
            state.settings.quickMode = true;
            state.settings.highlightQuestions = true;

            initKeyboardHandlers();
            initOverlayContainer();
            const detectedCount = await runQAPreview();

            log("[Study Assist] QA preview detected questions:", detectedCount);
            sendResponse({ success: true });
          } catch (error) {
            sendResponse({ success: false, error: (error as Error).message });
          }
        })();
        return true;

      case "QA_CLEAR_SCENARIO":
        clearQASandbox();
        clearAllHighlights();
        hideOverlay();
        resetQuickAnswer();
        state.detectedQuestions = [];
        sendResponse({ success: true });
        break;
    }

    return true; // Keep the message channel open for async response
  }
);

// ============================================
// Start
// ============================================
initialize();
