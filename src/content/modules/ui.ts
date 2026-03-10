/**
 * Study Assist - UI Module
 * Handles overlay, quick button, highlighting, and display functions
 */

import type { DetectedQuestion, UICallbacks } from "../../types/index.js";
import { log, state } from "./state.js";
import {
  escapeHtml,
  formatQuestionType,
  truncateText,
  formatAnalysisResult,
  getVisibilityScore,
} from "./utils.js";

// ============================================
// Reload Prompt
// ============================================

/**
 * Show a prompt asking user to reload the page
 */
export function showReloadPrompt(): void {
  // Only show in main frame, not iframes
  if (window.self !== window.top) return;

  // Remove existing prompt if any
  const existing = document.getElementById("study-assist-reload-prompt");
  if (existing) existing.remove();

  const prompt = document.createElement("div");
  prompt.id = "study-assist-reload-prompt";
  prompt.innerHTML = `
    <div style="
      position: fixed;
      bottom: 20px;
      right: 20px;
      background: #333;
      color: #fff;
      padding: 16px 20px;
      border-radius: 8px;
      box-shadow: 0 4px 12px rgba(0,0,0,0.3);
      z-index: 999999;
      font-family: 'Segoe UI', Roboto, Arial, sans-serif;
      font-size: 14px;
      display: flex;
      align-items: center;
      gap: 12px;
      animation: slideIn 0.3s ease;
    ">
      <span>📚 Study Assist activated. Reload to enable.</span>
      <button id="study-assist-reload-btn" style="
        background: #4285f4;
        color: white;
        border: none;
        padding: 8px 16px;
        border-radius: 4px;
        cursor: pointer;
        font-weight: 600;
        font-size: 13px;
      ">Reload</button>
      <button id="study-assist-dismiss-btn" style="
        background: transparent;
        color: #999;
        border: none;
        padding: 4px 8px;
        cursor: pointer;
        font-size: 16px;
      ">✕</button>
    </div>
    <style>
      @keyframes slideIn {
        from { transform: translateX(100%); opacity: 0; }
        to { transform: translateX(0); opacity: 1; }
      }
    </style>
  `;

  document.body.appendChild(prompt);

  const reloadBtn = document.getElementById("study-assist-reload-btn") as HTMLButtonElement | null;
  if (reloadBtn) {
    reloadBtn.onclick = (): void => {
      window.location.reload();
    };
  }

  const dismissBtn = document.getElementById("study-assist-dismiss-btn") as HTMLButtonElement | null;
  if (dismissBtn) {
    dismissBtn.onclick = (): void => {
      prompt.remove();
    };
  }

  // Auto-dismiss after 10 seconds
  setTimeout((): void => {
    if (document.getElementById("study-assist-reload-prompt")) {
      prompt.remove();
    }
  }, 10000);
}

// ============================================
// Overlay & Container
// ============================================

/**
 * Create the overlay container (quick mode or full overlay)
 * @param callbacks - UI callbacks for quiz content detection and handling
 */
export function createOverlayContainer(callbacks: UICallbacks): void {
  const { frameHasQuizContent, waitForQuizContent, handleQuickClick } = callbacks;

  // Remove existing overlays
  const existing = document.getElementById("study-assist-overlay");
  if (existing) existing.remove();
  const existingQuick = document.getElementById("study-assist-quick-container");
  if (existingQuick) existingQuick.remove();
  const existingQuickBtn = document.getElementById("study-assist-quick");
  if (existingQuickBtn) existingQuickBtn.remove();

  if (state.settings.quickMode) {
    // Only create quick button in frame with quiz content
    // Check immediately first, then wait for content to load
    if (frameHasQuizContent && frameHasQuizContent()) {
      createQuickButton({ handleQuickClick });
    } else if (waitForQuizContent) {
      // Wait for content to load, then create button
      waitForQuizContent((hasContent: boolean): void => {
        if (hasContent) {
          createQuickButton({ handleQuickClick });
        }
      });
    }
  } else {
    // Full overlay can be shown in any frame
    createFullOverlay(callbacks.showQuestionsSummary);
  }
}

/**
 * Create the full overlay UI
 * @param refreshCurrentQuestionCallback - Optional callback for refresh button
 */
export function createFullOverlay(refreshCurrentQuestionCallback?: () => Promise<void>): void {
  const overlay = document.createElement("div");
  overlay.id = "study-assist-overlay";
  overlay.innerHTML = `
    <div class="study-assist-header">
      <span class="study-assist-logo">SA</span>
      <div class="study-assist-controls">
        <button class="study-assist-refresh" title="Re-detect question">↻</button>
        <button class="study-assist-minimize" title="Minimize">−</button>
        <button class="study-assist-close" title="Close">×</button>
      </div>
    </div>
    <div class="study-assist-content">
      <div class="study-assist-loading" style="display: none;">
        <div class="study-assist-spinner"></div>
        <span>Analyzing...</span>
      </div>
      <div class="study-assist-results"></div>
    </div>
  `;

  document.body.appendChild(overlay);

  // Setup overlay controls
  const closeBtn = overlay.querySelector(".study-assist-close") as HTMLButtonElement | null;
  if (closeBtn) {
    closeBtn.addEventListener("click", hideOverlay);
  }

  const minimizeBtn = overlay.querySelector(".study-assist-minimize") as HTMLButtonElement | null;
  if (minimizeBtn) {
    minimizeBtn.addEventListener("click", toggleMinimize);
  }

  if (refreshCurrentQuestionCallback) {
    const refreshBtn = overlay.querySelector(".study-assist-refresh") as HTMLButtonElement | null;
    if (refreshBtn) {
      refreshBtn.addEventListener("click", refreshCurrentQuestionCallback);
    }
  }

  // Make draggable
  makeDraggable(overlay);
}

/**
 * Show the overlay
 */
export function showOverlay(): void {
  const overlay = document.getElementById("study-assist-overlay") as HTMLDivElement | null;
  if (overlay) {
    overlay.classList.add("study-assist-visible");
    state.overlayVisible = true;
  }
}

/**
 * Hide the overlay
 */
export function hideOverlay(): void {
  const overlay = document.getElementById("study-assist-overlay") as HTMLDivElement | null;
  if (overlay) {
    overlay.classList.remove("study-assist-visible");
    state.overlayVisible = false;
  }
}

/**
 * Toggle minimized state of overlay
 */
export function toggleMinimize(): void {
  const overlay = document.getElementById("study-assist-overlay") as HTMLDivElement | null;
  if (overlay) {
    overlay.classList.toggle("study-assist-minimized");
  }
}

/**
 * Make an element draggable by its header
 * @param element - The element to make draggable
 */
export function makeDraggable(element: HTMLElement): void {
  const header = element.querySelector(".study-assist-header") as HTMLElement | null;
  if (!header) return;

  let isDragging = false;
  let currentX: number;
  let currentY: number;
  let initialX: number;
  let initialY: number;

  header.addEventListener("mousedown", (e: MouseEvent): void => {
    const target = e.target as HTMLElement;
    if (target.tagName === "BUTTON") return;
    isDragging = true;
    initialX = e.clientX - (element.offsetLeft || 0);
    initialY = e.clientY - (element.offsetTop || 0);
  });

  document.addEventListener("mousemove", (e: MouseEvent): void => {
    if (!isDragging) return;
    e.preventDefault();
    currentX = e.clientX - initialX;
    currentY = e.clientY - initialY;
    element.style.left = `${currentX}px`;
    element.style.top = `${currentY}px`;
    element.style.right = "auto";
    element.style.bottom = "auto";
  });

  document.addEventListener("mouseup", (): void => {
    isDragging = false;
  });
}

// ============================================
// Quick Button
// ============================================

/**
 * Toggle SA button visibility
 * Called when pressing ALT+Q
 */
export function toggleSAButtonVisibility(): void {
  log("[Study Assist] ALT+Q pressed - toggling SA button visibility");
  const container = document.getElementById("study-assist-quick-container") as HTMLDivElement | null;

  if (container) {
    const isHidden = container.style.display === "none";
    container.style.display = isHidden ? "" : "none";
    log(`[Study Assist] SA button ${isHidden ? "shown" : "hidden"}`);
  } else {
    log("[Study Assist] SA button container not found");
  }
}

/**
 * Reset the quick answer button to default state
 */
export function resetQuickAnswer(): void {
  const quickBtn = document.getElementById("study-assist-quick") as HTMLDivElement | null;
  const container = document.getElementById("study-assist-quick-container") as HTMLDivElement | null;

  if (quickBtn) {
    quickBtn.innerHTML = `<span>SA</span>`;
    quickBtn.classList.remove(
      "has-answer",
      "matching-answer",
      "multi-answer",
      "multi-answer-large",
    );
  }
  if (container) {
    container.classList.remove("matching-mode");
  }

  state.lastAnsweredQuestionNum = null;
  state.hasValidAnswer = false; // Allow new requests after reset
}

/**
 * Callbacks for quick button creation
 */
interface QuickButtonCallbacks {
  handleQuickClick?: (e: MouseEvent) => void;
}

/**
 * Create the quick button for quick mode
 * @param callbacks - Object containing click handler
 */
export function createQuickButton(callbacks: QuickButtonCallbacks): void {
  const { handleQuickClick } = callbacks;

  // Create container for button
  const container = document.createElement("div");
  container.id = "study-assist-quick-container";

  // Apply button position from settings
  const pos = state.settings.buttonPosition || "bottom-right";
  container.setAttribute("data-position", pos);

  // Create main quick button
  const quickBtn = document.createElement("div");
  quickBtn.id = "study-assist-quick";
  quickBtn.innerHTML = `<span>SA</span>`;
  quickBtn.title =
    "Click to get answer | SHIFT: Analyze | ALT+W: Re-detect | ALT+Q: Hide | ALT+X: Cancel";
  container.appendChild(quickBtn);

  document.body.appendChild(container);

  if (handleQuickClick) {
    quickBtn.addEventListener("click", handleQuickClick);
  }

  // Setup Ctrl toggle for Webex button
  injectWebexToggleWithCtrl();
}

/**
 * Inject Webex button toggle functionality with Ctrl key
 * @private
 */
function injectWebexToggleWithCtrl(): void {
  // Hold Ctrl to hide Webex, release to show
  // Uses postMessage to communicate between frames

  const styleId = "study-assist-webex-hide-style";
  const isMainFrame = window.self === window.top;

  // Don't inject twice
  if (document.getElementById(styleId)) return;

  const style = document.createElement("style");
  style.id = styleId;
  style.textContent = `
    /* Class to hide Webex button */
    .webex-hidden-by-sa {
      visibility: hidden !important;
    }
    /* Set Webex button icon size */
    .fabActionBtnIconContainer--RPrZH img {
      width: 65px !important;
      height: 65px !important;
    }
  `;
  document.head.appendChild(style);

  // Apply icon size to existing button if present
  const existingWebexBtn = document.querySelector(
    "#webexFabActionBtn, .fabActionBtn--WND8X",
  ) as HTMLElement | null;
  if (existingWebexBtn) {
    applyWebexIconSize(existingWebexBtn);
  }

  // Observe for Webex button appearing dynamically
  const webexObserver = new MutationObserver((mutations: MutationRecord[]): void => {
    mutations.forEach((mutation: MutationRecord): void => {
      mutation.addedNodes.forEach((node: Node): void => {
        if (node.nodeType === Node.ELEMENT_NODE) {
          const element = node as Element;
          // Check if the added node is the Webex button
          if (
            element.id === "webexFabActionBtn" ||
            element.classList.contains("fabActionBtn--WND8X")
          ) {
            applyWebexIconSize(element as HTMLElement);
          }
          // Also check descendants
          const webexBtn = element.querySelector?.(
            "#webexFabActionBtn, .fabActionBtn--WND8X"
          ) as HTMLElement | null;
          if (webexBtn) {
            applyWebexIconSize(webexBtn);
          }
        }
      });
    });
  });

  webexObserver.observe(document.body, {
    childList: true,
    subtree: true,
  });

  function applyWebexIconSize(webexBtn: HTMLElement | null): void {
    if (!webexBtn) return;
    const webexImg = webexBtn.querySelector(
      ".fabActionBtnIconContainer--RPrZH img",
    ) as HTMLImageElement | null;
    if (webexImg) {
      webexImg.style.setProperty("width", "55px", "important");
      webexImg.style.setProperty("height", "55px", "important");
    }
  }

  function hideWebex(): void {
    const webexBtn = document.querySelector(
      "#webexFabActionBtn, .fabActionBtn--WND8X",
    ) as HTMLElement | null;
    if (webexBtn) {
      webexBtn.classList.add("webex-hidden-by-sa");
    }
  }

  function showWebex(): void {
    const webexBtn = document.querySelector(
      "#webexFabActionBtn, .fabActionBtn--WND8X",
    ) as HTMLElement | null;
    if (webexBtn) {
      webexBtn.classList.remove("webex-hidden-by-sa");
    }
  }

  // MAIN FRAME: Listen for messages from iframes
  if (isMainFrame) {
    window.addEventListener("message", (e: MessageEvent): void => {
      if (e.data === "study-assist-hide-webex") {
        hideWebex();
      } else if (e.data === "study-assist-show-webex") {
        showWebex();
      }
    });
  }

  // ALL FRAMES: Listen for Ctrl key and send message to parent
  document.addEventListener("keydown", (e: KeyboardEvent): void => {
    if (e.key === "Control") {
      // Try locally first
      hideWebex();
      // Also send to parent frame (in case Webex is there)
      if (!isMainFrame) {
        try {
          window.parent.postMessage("study-assist-hide-webex", "*");
        } catch (err) {
          // Ignore cross-origin errors
        }
      }
    }
  });

  document.addEventListener("keyup", (e: KeyboardEvent): void => {
    if (e.key === "Control") {
      // Show Webex when Ctrl is released
      showWebex();
      // Also send to parent frame
      if (!isMainFrame) {
        try {
          window.parent.postMessage("study-assist-show-webex", "*");
        } catch (err) {
          // Ignore cross-origin errors
        }
      }
    }
  });
}

// ============================================
// Question Highlighting
// ============================================

/**
 * Highlight detected questions on the page
 * @param analyzeQuestionCallback - Callback to analyze a question when badge is clicked
 */
export function highlightDetectedQuestions(
  analyzeQuestionCallback?: (question: DetectedQuestion) => Promise<void>
): void {
  clearAllHighlights();

  state.detectedQuestions.forEach((question: DetectedQuestion, index: number): void => {
    const element = question.element as HTMLElement;

    // Add highlight class
    element.classList.add("study-assist-question-highlight");
    element.dataset.studyAssistId = question.id;

    // Add question number badge
    const badge = document.createElement("div");
    badge.className = "study-assist-question-badge";
    badge.textContent = String(index + 1);
    badge.title = `Question ${index + 1} - Click to analyze`;
    badge.addEventListener("click", (e: MouseEvent): void => {
      e.stopPropagation();
      if (analyzeQuestionCallback) {
        analyzeQuestionCallback(question);
      }
    });

    // Position badge
    element.style.position = element.style.position || "relative";
    element.appendChild(badge);
  });
}

/**
 * Clear all question highlights from the page
 */
export function clearAllHighlights(): void {
  document
    .querySelectorAll(".study-assist-question-highlight")
    .forEach((el: Element): void => {
      el.classList.remove("study-assist-question-highlight");
      delete (el as HTMLElement).dataset.studyAssistId;
    });

  document.querySelectorAll(".study-assist-question-badge").forEach((el: Element): void => {
    el.remove();
  });
}

// ============================================
// Display Functions
// ============================================

/**
 * Display a single question in the overlay
 * @param question - The question object to display
 * @param analyzeQuestionCallback - Callback to analyze the question
 */
export function displaySingleQuestion(
  question: DetectedQuestion,
  analyzeQuestionCallback?: (question: DetectedQuestion) => Promise<void>
): void {
  const overlay = document.getElementById("study-assist-overlay") as HTMLDivElement | null;
  if (!overlay) return;

  const results = overlay.querySelector(".study-assist-results") as HTMLDivElement | null;
  if (!results) return;

  let contentHtml: string;
  if (question.type === "matching") {
    // Display matching question format
    const categoriesList = (question.categories || [])
      .map(
        (cat) =>
          `<div class="study-assist-matching-item"><strong>${cat.letter}.</strong> ${escapeHtml(cat.text)}</div>`,
      )
      .join("");

    const optionsList = (question.matchingOptions || [])
      .map(
        (opt) =>
          `<div class="study-assist-matching-item"><strong>${opt.index}.</strong> ${escapeHtml(opt.text)}</div>`,
      )
      .join("");

    contentHtml = `
      <div class="study-assist-single-question">
        ${question.questionNumber ? `<div class="study-assist-question-label">Pregunta ${question.questionNumber}</div>` : ""}
        <div class="study-assist-question-box">
          <p>${escapeHtml(question.text)}</p>
          <div class="study-assist-matching-container">
            <div class="study-assist-matching-section">
              <h5>Categories:</h5>
              <div class="study-assist-matching-items">
                ${categoriesList}
              </div>
            </div>
            <div class="study-assist-matching-section">
              <h5>Options:</h5>
              <div class="study-assist-matching-items">
                ${optionsList}
              </div>
            </div>
          </div>
        </div>
        <button class="study-assist-analyze-btn-large">Analyze Question</button>
      </div>
    `;
  } else {
    // Display multiple choice format
    const optionsList = (question.options || [])
      .map(
        (opt) =>
          `<div class="study-assist-option-item"><strong>${opt.letter}.</strong> ${escapeHtml(opt.text)}</div>`,
      )
      .join("");

    contentHtml = `
      <div class="study-assist-single-question">
        ${question.questionNumber ? `<div class="study-assist-question-label">Pregunta ${question.questionNumber}</div>` : ""}
        <div class="study-assist-question-box">
          <p>${escapeHtml(question.text)}</p>
          <div class="study-assist-options">
            ${optionsList}
          </div>
        </div>
        <button class="study-assist-analyze-btn-large">Analyze Question</button>
      </div>
    `;
  }

  results.innerHTML = contentHtml;

  // Store current question for analysis
  state.currentVisibleQuestion = question;

  // Add click handler for analyze button
  const analyzeBtn = results.querySelector(".study-assist-analyze-btn-large") as HTMLButtonElement | null;
  if (analyzeBtn) {
    analyzeBtn.addEventListener("click", (): void => {
      if (analyzeQuestionCallback) {
        analyzeQuestionCallback(question);
      }
    });
  }

  showOverlay();
}

/**
 * Show questions summary in the overlay
 * @param detectVisibleQuestionCallback - Async function to detect the visible question
 * @param analyzeQuestionCallback - Callback to analyze a question
 */
export async function showQuestionsSummary(
  detectVisibleQuestionCallback: () => Promise<DetectedQuestion | null>,
  analyzeQuestionCallback?: (question: DetectedQuestion) => Promise<void>
): Promise<void> {
  const overlay = document.getElementById("study-assist-overlay") as HTMLDivElement | null;
  if (!overlay) return;

  // Detect the currently visible question directly (async for image extraction)
  const currentQuestion = await detectVisibleQuestionCallback();

  if (currentQuestion) {
    displaySingleQuestion(currentQuestion, analyzeQuestionCallback);
    return;
  }

  // Fallback: try to find from pre-detected questions using visibility score
  let fallbackQuestion: DetectedQuestion | null = null;
  let bestScore = -1;
  state.detectedQuestions.forEach((q: DetectedQuestion): void => {
    const score = getVisibilityScore(q.element);
    if (score > bestScore) {
      bestScore = score;
      fallbackQuestion = q;
    }
  });

  // Last fallback: use the first question
  if (!fallbackQuestion && state.detectedQuestions.length > 0) {
    fallbackQuestion = state.detectedQuestions[0];
  }

  if (fallbackQuestion) {
    displaySingleQuestion(fallbackQuestion, analyzeQuestionCallback);
    return;
  }

  showNoQuestionsFound();
}

/**
 * Show "no questions found" message in the overlay
 */
export function showNoQuestionsFound(): void {
  // Only show if overlay exists and is already visible (user manually triggered)
  const overlay = document.getElementById("study-assist-overlay") as HTMLDivElement | null;
  if (!overlay || !state.overlayVisible) return;

  const results = overlay.querySelector(".study-assist-results") as HTMLDivElement | null;
  if (!results) return;

  results.innerHTML = `
    <div class="study-assist-empty">
      <p>No question detected. Click ↻ to retry.</p>
    </div>
  `;
}

/**
 * Show loading spinner in the overlay
 */
export function showLoading(): void {
  const overlay = document.getElementById("study-assist-overlay") as HTMLDivElement | null;
  if (!overlay) return;

  const loading = overlay.querySelector(".study-assist-loading") as HTMLDivElement | null;
  if (loading) {
    loading.style.display = "flex";
  }
}

/**
 * Hide loading spinner in the overlay
 */
export function hideLoading(): void {
  const overlay = document.getElementById("study-assist-overlay") as HTMLDivElement | null;
  if (!overlay) return;

  const loading = overlay.querySelector(".study-assist-loading") as HTMLDivElement | null;
  if (loading) {
    loading.style.display = "none";
  }
}

/**
 * Display analysis result in the overlay
 * @param result - The analysis result text
 * @param question - The question object
 * @param showQuestionsSummaryCallback - Callback to show questions summary (for back button)
 */
export function displayAnalysisResult(
  result: string,
  question: DetectedQuestion,
  showQuestionsSummaryCallback?: () => Promise<void>
): void {
  const overlay = document.getElementById("study-assist-overlay") as HTMLDivElement | null;
  if (!overlay) return;

  const results = overlay.querySelector(".study-assist-results") as HTMLDivElement | null;
  if (!results) return;

  results.innerHTML = `
    <div class="study-assist-analysis">
      <button class="study-assist-back-btn">← Back to Questions</button>
      
      <div class="study-assist-question-box">
        <h4>📝 Question</h4>
        <p>${escapeHtml(truncateText(question.text, 300))}</p>
        ${
          question.options && question.options.length > 0
            ? `
          <div class="study-assist-options">
            ${question.options
              .map(
                (o) => `
              <div class="study-assist-option">
                <span class="study-assist-option-letter">${o.letter}</span>
                <span>${escapeHtml(o.text)}</span>
              </div>
            `,
              )
              .join("")}
          </div>
        `
            : ""
        }
      </div>
      
      <div class="study-assist-answer-box">
        <h4>🎓 Learning Guide</h4>
        <div class="study-assist-answer-content">
          ${formatAnalysisResult(result)}
        </div>
      </div>
      
      <div class="study-assist-disclaimer">
        ⚠️ This is an AI-generated learning aid. Always verify information and use it to improve your understanding, not as a substitute for studying.
      </div>
    </div>
  `;

  // Add back button handler
  const backBtn = results.querySelector(".study-assist-back-btn") as HTMLButtonElement | null;
  if (backBtn) {
    backBtn.addEventListener("click", (): void => {
      if (showQuestionsSummaryCallback) {
        showQuestionsSummaryCallback();
      }
    });
  }

  showOverlay();
}

/**
 * Display streaming analysis result - updates in real-time as chunks arrive
 * @param result - The accumulated analysis result text so far
 * @param question - The question object
 * @param showQuestionsSummaryCallback - Callback to show questions summary
 * @param isInitial - Whether this is the initial call (creates the DOM)
 * @param tokenInfo - Token/cost information (shown after completion)
 */
export function displayAnalysisResultStreaming(
  result: string,
  question: DetectedQuestion,
  showQuestionsSummaryCallback?: () => Promise<void>,
  isInitial: boolean = false,
  tokenInfo?: { inputTokens: number; outputTokens: number; cost: number },
): void {
  const overlay = document.getElementById("study-assist-overlay") as HTMLDivElement | null;
  if (!overlay) return;

  const results = overlay.querySelector(".study-assist-results") as HTMLDivElement | null;
  if (!results) return;

  if (isInitial) {
    results.innerHTML = `
      <div class="study-assist-analysis">
        <button class="study-assist-back-btn">← Back to Questions</button>
        
        <div class="study-assist-question-box">
          <h4>📝 Question</h4>
          <p>${escapeHtml(truncateText(question.text, 300))}</p>
          ${
            question.options && question.options.length > 0
              ? `
            <div class="study-assist-options">
              ${question.options
                .map(
                  (o) => `
                <div class="study-assist-option">
                  <span class="study-assist-option-letter">${o.letter}</span>
                  <span>${escapeHtml(o.text)}</span>
                </div>
              `,
                )
                .join("")}
            </div>
          `
              : ""
          }
        </div>
        
        <div class="study-assist-answer-box">
          <h4>🎓 Learning Guide</h4>
          <div class="study-assist-answer-content" id="study-assist-stream-content">
            <span class="study-assist-stream-cursor">▊</span>
          </div>
        </div>

        <div class="study-assist-token-info" id="study-assist-token-info" style="display:none;"></div>
        
        <div class="study-assist-disclaimer">
          ⚠️ This is an AI-generated learning aid. Always verify information.
        </div>
      </div>
    `;

    const backBtn = results.querySelector(".study-assist-back-btn") as HTMLButtonElement | null;
    if (backBtn) {
      backBtn.addEventListener("click", (): void => {
        if (showQuestionsSummaryCallback) {
          showQuestionsSummaryCallback();
        }
      });
    }
    showOverlay();
    return;
  }

  // Update the streaming content
  const streamContent = document.getElementById("study-assist-stream-content");
  if (streamContent) {
    const cursorHtml = tokenInfo ? "" : '<span class="study-assist-stream-cursor">▊</span>';
    streamContent.innerHTML = formatAnalysisResult(result) + cursorHtml;
    streamContent.scrollTop = streamContent.scrollHeight;
  }

  // Show token info when complete
  if (tokenInfo) {
    const tokenInfoEl = document.getElementById("study-assist-token-info");
    if (tokenInfoEl) {
      tokenInfoEl.style.display = "block";
      tokenInfoEl.innerHTML = `
        <span title="Input tokens">📥 ${tokenInfo.inputTokens}</span>
        <span title="Output tokens">📤 ${tokenInfo.outputTokens}</span>
        <span title="Estimated cost">💰 $${tokenInfo.cost.toFixed(6)}</span>
      `;
    }
  }
}

/**
 * Display an error message in the overlay
 * @param errorMessage - The error message to display
 * @param showQuestionsSummaryCallback - Callback for retry button
 */
export function displayError(
  errorMessage: string,
  showQuestionsSummaryCallback?: () => Promise<void>
): void {
  const overlay = document.getElementById("study-assist-overlay") as HTMLDivElement | null;
  if (!overlay) return;

  const results = overlay.querySelector(".study-assist-results") as HTMLDivElement | null;
  if (!results) return;

  results.innerHTML = `
    <div class="study-assist-error">
      <span class="study-assist-error-icon">⚠️</span>
      <h3>Analysis Error</h3>
      <p>${escapeHtml(errorMessage)}</p>
      <button class="study-assist-retry-btn">Try Again</button>
    </div>
  `;

  const retryBtn = results.querySelector(".study-assist-retry-btn") as HTMLButtonElement | null;
  if (retryBtn) {
    retryBtn.addEventListener("click", (): void => {
      if (showQuestionsSummaryCallback) {
        showQuestionsSummaryCallback();
      }
    });
  }
}
