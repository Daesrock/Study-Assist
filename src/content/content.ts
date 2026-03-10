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
    showQuestionsSummary: showQuestionsSummaryWithCallbacks,
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
    showQuestionsSummary: showQuestionsSummaryWithCallbacks,
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
  
  if (result && result.found) {
    if (state.settings.highlightQuestions) {
      highlightDetectedQuestions(analyzeQuestionWithCallbacks);
    }
    // In non-quick mode, auto-show the overlay with the detected question
    if (!state.settings.quickMode) {
      await showQuestionsSummaryWithCallbacks();
    }
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
  | "moodle-match"
  | "moodle-shortanswer"
  | "moodle-numerical"
  | "moodle-gapselect"
  | "moodle-quiz"
  | "netacad-mcq"
  | "netacad-matching"
  | "netacad-quiz";

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

function injectMoodleShortAnswer(target: HTMLElement): void {
  target.innerHTML = `
    <div class="qa-block">
      <h3>Moodle Simulado — Respuesta corta (Short Answer)</h3>
      <p class="qa-tip">La IA responderá con texto libre. Respuesta esperada: <strong>HyperText Transfer Protocol</strong>.</p>
      <div class="que shortanswer">
        <div class="info"><h3 class="no">Pregunta <span class="qno">1</span></h3></div>
        <div class="content">
          <div class="formulation clearfix">
            <div class="qtext">¿Qué significa el acrónimo <strong>HTTP</strong> en el contexto de la World Wide Web?</div>
            <div class="answer">
              <input type="text" class="form-control d-inline" size="30" placeholder="Escribe tu respuesta aquí" />
            </div>
          </div>
        </div>
      </div>
    </div>
  `;
}

function injectMoodleNumerical(target: HTMLElement): void {
  target.innerHTML = `
    <div class="qa-block">
      <h3>Moodle Simulado — Numérica (Numerical)</h3>
      <p class="qa-tip">La IA responderá con un número. Respuesta esperada: <strong>32</strong>.</p>
      <div class="que numerical">
        <div class="info"><h3 class="no">Pregunta <span class="qno">1</span></h3></div>
        <div class="content">
          <div class="formulation clearfix">
            <div class="qtext">¿Cuántos bits tiene una dirección IPv4?</div>
            <div class="answer">
              <input type="text" class="form-control d-inline" size="15" placeholder="Respuesta numérica" />
            </div>
          </div>
        </div>
      </div>
    </div>
  `;
}

function injectMoodleGapSelect(target: HTMLElement): void {
  target.innerHTML = `
    <div class="qa-block">
      <h3>Moodle Simulado — Selecciona las palabras faltantes (Select Missing Words)</h3>
      <p class="qa-tip">Respuesta esperada: <strong>[[1]]=HTTP, [[2]]=80, [[3]]=HTTPS, [[4]]=443</strong>.</p>
      <div class="que gapselect">
        <div class="info"><h3 class="no">Pregunta <span class="qno">1</span></h3></div>
        <div class="content">
          <div class="formulation clearfix">
            <div class="qtext">El protocolo
              <select name="resp_1">
                <option value="0">Elegir...</option>
                <option value="1">HTTP</option>
                <option value="2">FTP</option>
                <option value="3">SSH</option>
              </select>
              utiliza el puerto
              <select name="resp_2">
                <option value="0">Elegir...</option>
                <option value="1">80</option>
                <option value="2">21</option>
                <option value="3">22</option>
              </select>
              para comunicación no cifrada, mientras que
              <select name="resp_3">
                <option value="0">Elegir...</option>
                <option value="1">HTTP</option>
                <option value="2">HTTPS</option>
                <option value="3">FTP</option>
              </select>
              usa el puerto
              <select name="resp_4">
                <option value="0">Elegir...</option>
                <option value="1">80</option>
                <option value="2">443</option>
                <option value="3">8080</option>
              </select>
              para comunicación cifrada.
            </div>
          </div>
        </div>
      </div>
    </div>
  `;
}

function injectMoodleMatch(target: HTMLElement): void {
  target.innerHTML = `
    <div class="qa-block">
      <h3>Moodle Simulado — Relacionar (Match)</h3>
      <p class="qa-tip">Respuesta esperada: <strong>A-2, B-1, C-3</strong> (categoría-opción).</p>
      <div class="que match">
        <div class="info"><h3 class="no">Pregunta <span class="qno">1</span></h3></div>
        <div class="content">
          <div class="formulation clearfix">
            <div class="qtext">Relaciona cada capa del modelo OSI con su función principal.</div>
            <div class="ablock">
              <table class="answer">
                <tbody>
                  <tr class="r0">
                    <td class="text">Enrutamiento lógico de paquetes</td>
                    <td class="control">
                      <select>
                        <option value="0">Elegir...</option>
                        <option value="1">Capa Física</option>
                        <option value="2">Capa de Red</option>
                        <option value="3">Capa de Transporte</option>
                      </select>
                    </td>
                  </tr>
                  <tr class="r1">
                    <td class="text">Transmisión de bits por el medio físico</td>
                    <td class="control">
                      <select>
                        <option value="0">Elegir...</option>
                        <option value="1">Capa Física</option>
                        <option value="2">Capa de Red</option>
                        <option value="3">Capa de Transporte</option>
                      </select>
                    </td>
                  </tr>
                  <tr class="r0">
                    <td class="text">Control de flujo y segmentación extremo a extremo</td>
                    <td class="control">
                      <select>
                        <option value="0">Elegir...</option>
                        <option value="1">Capa Física</option>
                        <option value="2">Capa de Red</option>
                        <option value="3">Capa de Transporte</option>
                      </select>
                    </td>
                  </tr>
                </tbody>
              </table>
            </div>
          </div>
        </div>
      </div>
    </div>
  `;
}

/**
 * Attaches prev/next navigation logic to a quiz container that has .qa-slide elements.
 * Dispatches 'study-assist-navigate' on window after each slide change so the content
 * script re-runs detection automatically.
 */
function attachQANavigation(container: HTMLElement): void {
  const slides = Array.from(container.querySelectorAll<HTMLElement>(".qa-slide"));
  if (slides.length === 0) return;

  let current = 0;

  const prevBtn = container.querySelector<HTMLButtonElement>("#qa-nav-prev");
  const nextBtn = container.querySelector<HTMLButtonElement>("#qa-nav-next");
  const progressEl = container.querySelector<HTMLElement>(".qa-quiz-progress");

  function update(): void {
    slides.forEach((slide, i) => {
      slide.style.display = i === current ? "" : "none";
    });
    if (prevBtn) prevBtn.disabled = current <= 0;
    if (nextBtn) nextBtn.disabled = current >= slides.length - 1;
    if (progressEl) progressEl.textContent = `Pregunta ${current + 1} de ${slides.length}`;
    window.dispatchEvent(new CustomEvent("study-assist-navigate"));
  }

  if (prevBtn) prevBtn.addEventListener("click", () => { if (current > 0) { current--; update(); } });
  if (nextBtn) nextBtn.addEventListener("click", () => { if (current < slides.length - 1) { current++; update(); } });
}

function injectNetAcadQuiz(target: HTMLElement): void {
  target.innerHTML = `
    <div class="qa-quiz-header">
      <span class="qa-quiz-platform">🔵 NetAcad — Quiz Real</span>
      <div class="qa-quiz-nav">
        <button class="qa-sandbox-nav-btn" id="qa-nav-prev" disabled>← Anterior</button>
        <span class="qa-quiz-progress">Pregunta 1 de 2</span>
        <button class="qa-sandbox-nav-btn" id="qa-nav-next">Siguiente →</button>
      </div>
    </div>
    <p class="qa-tip">La detección se actualiza automáticamente al navegar.</p>

    <div class="qa-slide" data-slide="0">
      <div class="qa-block">
        <h3>Pregunta 1 — Opción múltiple (MCQ)</h3>
        <div class="qa-question-title">Pregunta 1</div>
        <mcq-view id="qa-netacad-quiz-mcq"></mcq-view>
      </div>
    </div>

    <div class="qa-slide" data-slide="1" style="display:none">
      <div class="qa-block">
        <h3>Pregunta 2 — Relacionar (Matching)</h3>
        <p class="qa-tip">En quick mode la respuesta se mostrará como pares (ej. <strong>A-2</strong>).</p>
        <div class="qa-question-title">Pregunta 2</div>
        <object-matching-view id="qa-netacad-quiz-matching"></object-matching-view>
      </div>
    </div>
  `;

  // MCQ shadow DOM
  const mcqView = target.querySelector("#qa-netacad-quiz-mcq") as HTMLElement | null;
  if (mcqView) {
    const sr = mcqView.attachShadow({ mode: "open" });
    sr.innerHTML = `
      <style>
        .mcq__body-inner { font-size: 16px; margin-bottom: 12px; color: #1f2937; }
        .mcq__item { margin: 8px 0; padding: 10px; border: 1px solid #e5e7eb; border-radius: 8px; background: #fff; }
        .mcq__item-text-inner { font-size: 14px; color: #111827; }
      </style>
      <div class="mcq__body-inner">¿Cuál capa del modelo OSI se encarga del enrutamiento lógico de paquetes?</div>
      <div class="mcq__item"><div class="mcq__item-text-inner">Capa Física</div></div>
      <div class="mcq__item"><div class="mcq__item-text-inner">Capa de Enlace de Datos</div></div>
      <div class="mcq__item"><div class="mcq__item-text-inner">Capa de Red</div></div>
      <div class="mcq__item"><div class="mcq__item-text-inner">Capa de Transporte</div></div>
    `;
  }

  // Matching shadow DOM
  const matchingView = target.querySelector("#qa-netacad-quiz-matching") as HTMLElement | null;
  if (matchingView) {
    const sr = matchingView.attachShadow({ mode: "open" });
    sr.innerHTML = `
      <style>
        .component__body-inner { font-size: 16px; margin-bottom: 12px; color: #1f2937; }
        .objectMatching-category-item,
        .objectMatching-option-item {
          display: flex; align-items: center; gap: 8px;
          margin: 6px 0; padding: 8px;
          border: 1px solid #e5e7eb; border-radius: 8px; background: #fff;
        }
        .category-item-number { font-weight: 700; min-width: 20px; }
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

  attachQANavigation(target);
}

function injectMoodleQuiz(target: HTMLElement): void {
  target.innerHTML = `
    <div class="qa-quiz-header">
      <span class="qa-quiz-platform">🟣 Moodle — Quiz Real</span>
      <div class="qa-quiz-nav">
        <button class="qa-sandbox-nav-btn" id="qa-nav-prev" disabled>← Anterior</button>
        <span class="qa-quiz-progress">Pregunta 1 de 6</span>
        <button class="qa-sandbox-nav-btn" id="qa-nav-next">Siguiente →</button>
      </div>
    </div>
    <p class="qa-tip">La detección se actualiza automáticamente al navegar.</p>

    <div class="qa-slide" data-slide="0">
      <div class="qa-block">
        <h3>Pregunta 1 — Opción múltiple (MCQ)</h3>
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
    </div>

    <div class="qa-slide" data-slide="1" style="display:none">
      <div class="qa-block">
        <h3>Pregunta 2 — Verdadero/Falso</h3>
        <div class="que truefalse">
          <div class="info"><h3 class="no">Pregunta <span class="qno">2</span></h3></div>
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
    </div>

    <div class="qa-slide" data-slide="2" style="display:none">
      <div class="qa-block">
        <h3>Pregunta 3 — Relacionar (Match)</h3>
        <div class="que match">
          <div class="info"><h3 class="no">Pregunta <span class="qno">3</span></h3></div>
          <div class="content">
            <div class="formulation clearfix">
              <div class="qtext">Relaciona cada capa del modelo OSI con su función principal.</div>
              <div class="ablock">
                <table class="answer">
                  <tbody>
                    <tr class="r0">
                      <td class="text">Enrutamiento lógico de paquetes</td>
                      <td class="control">
                        <select>
                          <option value="0">Elegir...</option>
                          <option value="1">Capa Física</option>
                          <option value="2">Capa de Red</option>
                          <option value="3">Capa de Transporte</option>
                        </select>
                      </td>
                    </tr>
                    <tr class="r1">
                      <td class="text">Transmisión de bits por el medio físico</td>
                      <td class="control">
                        <select>
                          <option value="0">Elegir...</option>
                          <option value="1">Capa Física</option>
                          <option value="2">Capa de Red</option>
                          <option value="3">Capa de Transporte</option>
                        </select>
                      </td>
                    </tr>
                    <tr class="r0">
                      <td class="text">Control de flujo y segmentación extremo a extremo</td>
                      <td class="control">
                        <select>
                          <option value="0">Elegir...</option>
                          <option value="1">Capa Física</option>
                          <option value="2">Capa de Red</option>
                          <option value="3">Capa de Transporte</option>
                        </select>
                      </td>
                    </tr>
                  </tbody>
                </table>
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>

    <div class="qa-slide" data-slide="3" style="display:none">
      <div class="qa-block">
        <h3>Pregunta 4 — Respuesta corta (Short Answer)</h3>
        <div class="que shortanswer">
          <div class="info"><h3 class="no">Pregunta <span class="qno">4</span></h3></div>
          <div class="content">
            <div class="formulation clearfix">
              <div class="qtext">¿Cuál es el nombre completo del protocolo cuyas siglas son HTTP?</div>
              <div class="ablock">
                <label for="qa_sa_input">Respuesta:</label>
                <input type="text" id="qa_sa_input" class="form-control d-inline" size="30" placeholder="Escribe tu respuesta..." />
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>

    <div class="qa-slide" data-slide="4" style="display:none">
      <div class="qa-block">
        <h3>Pregunta 5 — Numérica (Numerical)</h3>
        <div class="que numerical">
          <div class="info"><h3 class="no">Pregunta <span class="qno">5</span></h3></div>
          <div class="content">
            <div class="formulation clearfix">
              <div class="qtext">¿Cuántos bits componen una dirección IPv4?</div>
              <div class="ablock">
                <label for="qa_num_input">Respuesta:</label>
                <input type="text" id="qa_num_input" class="form-control d-inline" size="10" placeholder="Número..." />
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>

    <div class="qa-slide" data-slide="5" style="display:none">
      <div class="qa-block">
        <h3>Pregunta 6 — Seleccionar palabras que faltan (Gap Select)</h3>
        <div class="que gapselect">
          <div class="info"><h3 class="no">Pregunta <span class="qno">6</span></h3></div>
          <div class="content">
            <div class="formulation clearfix">
              <div class="qtext">El protocolo
                <select name="resp_1">
                  <option value="0">Elegir...</option>
                  <option value="1">HTTP</option>
                  <option value="2">FTP</option>
                  <option value="3">SMTP</option>
                </select>
                utiliza el puerto
                <select name="resp_2">
                  <option value="0">Elegir...</option>
                  <option value="1">80</option>
                  <option value="2">21</option>
                  <option value="3">25</option>
                </select>
                para tráfico no cifrado, mientras que
                <select name="resp_3">
                  <option value="0">Elegir...</option>
                  <option value="1">HTTPS</option>
                  <option value="2">SFTP</option>
                  <option value="3">SMTPS</option>
                </select>
                utiliza el puerto
                <select name="resp_4">
                  <option value="0">Elegir...</option>
                  <option value="1">443</option>
                  <option value="2">22</option>
                  <option value="3">465</option>
                </select>
                para comunicaciones seguras.
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>
  `;

  attachQANavigation(target);
}

function injectQAScenario(scenario: QAScenarioType): void {

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
      #study-assist-qa-sandbox .qa-quiz-header {
        display: flex;
        flex-wrap: wrap;
        align-items: center;
        gap: 10px;
        margin-bottom: 12px;
        padding-bottom: 10px;
        border-bottom: 1px solid #cbd5e1;
      }
      #study-assist-qa-sandbox .qa-quiz-platform {
        font-weight: 700;
        color: #1d4ed8;
        font-size: 15px;
        flex: 1;
      }
      #study-assist-qa-sandbox .qa-quiz-nav {
        display: flex;
        align-items: center;
        gap: 8px;
      }
      #study-assist-qa-sandbox .qa-quiz-progress {
        font-size: 13px;
        color: #334155;
        min-width: 80px;
        text-align: center;
      }
      #study-assist-qa-sandbox .qa-sandbox-nav-btn {
        padding: 4px 10px;
        font-size: 13px;
        background: #3b82f6;
        color: white;
        border: none;
        border-radius: 6px;
        cursor: pointer;
      }
      #study-assist-qa-sandbox .qa-sandbox-nav-btn:disabled {
        background: #94a3b8;
        cursor: default;
      }
      #study-assist-qa-sandbox table.answer {
        width: 100%;
        border-collapse: collapse;
      }
      #study-assist-qa-sandbox table.answer td {
        padding: 8px;
        border: 1px solid #e2e8f0;
        vertical-align: middle;
      }
      #study-assist-qa-sandbox table.answer td.control select {
        padding: 4px 6px;
        border: 1px solid #cbd5e1;
        border-radius: 6px;
        background: white;
        font-size: 13px;
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
  } else if (scenario === "moodle-shortanswer") {
    injectMoodleShortAnswer(content);
  } else if (scenario === "moodle-numerical") {
    injectMoodleNumerical(content);
  } else if (scenario === "moodle-gapselect") {
    injectMoodleGapSelect(content);
  } else if (scenario === "netacad-mcq") {
    injectNetAcadMcq(content);
  } else if (scenario === "moodle-match") {
    injectMoodleMatch(content);
  } else if (scenario === "netacad-quiz") {
    injectNetAcadQuiz(content);
  } else if (scenario === "moodle-quiz") {
    injectMoodleQuiz(content);
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
          if (state.settings.quickMode) {
            initKeyboardHandlers();
          }
          initOverlayContainer();
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
          // Run full page detection (refreshes state.detectedQuestions, updates highlights)
          // then open the overlay showing the currently visible question so the user
          // can read it and trigger the AI analysis — this is the non-quick mode flow.
          (async () => {
            await runDetection();
            await showQuestionsSummaryWithCallbacks();
          })();
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

// Re-detect when QA quiz navigation changes the visible question
window.addEventListener("study-assist-navigate", () => {
  if (state.isActive && state.isDomainAllowed) {
    runDetection();
  }
});

initialize();
