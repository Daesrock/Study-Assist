/**
 * Study Assist - Keyboard Module
 * Handles all keyboard interactions and shortcuts
 */

import { KeyboardCallbacks } from "../../types/index.js";
import { log, state } from "./state.js";

// ============================================
// Keyboard Handlers Setup
// ============================================

/**
 * Setup all keyboard handlers for the extension
 * @param callbacks - Callback functions for keyboard actions
 */
export function setupKeyboardHandlers(callbacks: KeyboardCallbacks): void {
  injectWebexToggleWithCtrl(callbacks);
}

/**
 * Inject keyboard handlers for:
 * - Ctrl hold to hide Webex button
 * - Shift click to trigger analysis
 * - Ctrl+Shift click to use Claude directly
 * - Alt+W to reload/re-detect question
 * - Alt+Q to toggle SA button visibility
 * - Alt+X to cancel current request
 *
 * @param callbacks - Callback functions for keyboard actions
 */
export function injectWebexToggleWithCtrl(callbacks: KeyboardCallbacks): void {
  const {
    triggerQuickAnalysis,
    reloadQuickMode,
    toggleSAButtonVisibility,
    cancelCurrentRequest,
  } = callbacks;

  // Hold Ctrl to hide Webex, release to show
  // Uses postMessage to communicate between frames

  const styleId = "study-assist-webex-hide-style";
  const keyboardMarkerId = "study-assist-keyboard-injected";
  const isMainFrame = window.self === window.top;

  // Keyboard handlers can be re-registered when quickMode is toggled on/off.
  // Use a custom attribute on document to track registration separately from the style.
  const keyboardAlreadyInjected = document.documentElement.hasAttribute(keyboardMarkerId);

  // Only inject the style once (shared with ui.ts Ctrl/Webex handler)
  if (!document.getElementById(styleId)) {

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
  (document.head ?? document.documentElement).appendChild(style);
  }

  // Don't re-register keyboard shortcuts if already done
  if (keyboardAlreadyInjected) return;
  document.documentElement.setAttribute(keyboardMarkerId, "1");

  // Apply icon size to existing button if present
  const existingWebexBtn = document.querySelector(
    "#webexFabActionBtn, .fabActionBtn--WND8X",
  );
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
            applyWebexIconSize(element);
          }
          // Also check descendants
          const webexBtn = element.querySelector?.(
            "#webexFabActionBtn, .fabActionBtn--WND8X",
          );
          if (webexBtn) {
            applyWebexIconSize(webexBtn);
          }
        }
      });
    });
  });

  webexObserver.observe(document.body ?? document.documentElement, {
    childList: true,
    subtree: true,
  });

  function applyWebexIconSize(webexBtn: Element): void {
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
    );
    if (webexBtn) {
      webexBtn.classList.add("webex-hidden-by-sa");
    }
  }

  function showWebex(): void {
    const webexBtn = document.querySelector(
      "#webexFabActionBtn, .fabActionBtn--WND8X",
    );
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
      // Also send to top frame
      try {
        window.top?.postMessage("study-assist-hide-webex", "*");
      } catch (err) {
        // Ignore cross-origin errors
      }
    }

    // ALT+W - Reload quick mode detection (re-detect question)
    // ALT+Q - Hide/show SA button
    // Only trigger if:
    // 1. Not a key repeat
    // 2. Not typing in an input field
    // 3. Quick mode is enabled in settings (for ALT+W)
    if (e.altKey && !e.repeat && (e.key === "w" || e.key === "W")) {
      const activeEl = document.activeElement as HTMLElement | null;
      const isTyping = isUserTypingInElement(activeEl);

      if (!isTyping && state.settings.quickMode) {
        e.preventDefault();
        reloadQuickMode();
      }
    }

    // ALT+Q - Hide/show SA button
    if (e.altKey && !e.repeat && (e.key === "q" || e.key === "Q")) {
      const activeEl = document.activeElement as HTMLElement | null;
      const isTyping = isUserTypingInElement(activeEl);

      if (!isTyping) {
        e.preventDefault();
        toggleSAButtonVisibility();
      }
    }

    // ALT+X - Cancel current request
    if (e.altKey && !e.repeat && (e.key === "x" || e.key === "X")) {
      const activeEl = document.activeElement as HTMLElement | null;
      const isTyping = isUserTypingInElement(activeEl);

      if (!isTyping && state.isRequestInProgress) {
        e.preventDefault();
        cancelCurrentRequest();
      }
    }

    // SHIFT key - Send question to API automatically
    // CTRL+SHIFT - Send question directly to Claude (skip DeepSeek)
    // If CTRL+SHIFT while loading - Cancel DeepSeek and use Claude
    // Only trigger if:
    // 1. Not a key repeat (prevents spam from holding key)
    // 2. Not typing in an input field (user may be typing uppercase)
    // 3. This frame has the SA button (avoid duplicate triggers from iframes)
    if (e.key === "Shift" && !e.repeat) {
      const activeEl = document.activeElement as HTMLElement | null;
      const isTyping = isUserTypingInElement(activeEl);

      const quickBtn = document.getElementById("study-assist-quick");
      const isLoading = quickBtn && quickBtn.classList.contains("loading");

      if (!isTyping && quickBtn) {
        e.preventDefault();

        if (isLoading && e.ctrlKey) {
          // CTRL+SHIFT while loading - Cancel DeepSeek request
          log(
            "[Study Assist] CTRL+SHIFT pressed while loading - cancelling DeepSeek request",
          );
          chrome.runtime
            .sendMessage({ type: "CANCEL_DEEPSEEK" })
            .then((result: { cancelled?: boolean } | undefined) => {
              if (result && result.cancelled) {
                log("[Study Assist] DeepSeek cancelled, Claude will take over");
              }
            })
            .catch((err: Error) => {
              log("[Study Assist] Cancel message error:", err);
            });
        } else if (!isLoading) {
          // Not loading - start new analysis
          // If CTRL is also pressed, skip DeepSeek and use Claude directly
          state.skipDeepSeek = e.ctrlKey;
          if (state.skipDeepSeek) {
            log(
              "[Study Assist] CTRL+SHIFT pressed - will skip DeepSeek, use Claude directly",
            );
          }
          triggerQuickAnalysis();
        }
      }
    }
  });

  document.addEventListener("keyup", (e: KeyboardEvent): void => {
    if (e.key === "Control") {
      // Try locally first
      showWebex();
      // Also send to parent frame
      if (!isMainFrame) {
        try {
          window.parent.postMessage("study-assist-show-webex", "*");
        } catch (err) {
          // Ignore cross-origin errors
        }
      }
      // Also send to top frame
      try {
        window.top?.postMessage("study-assist-show-webex", "*");
      } catch (err) {
        // Ignore cross-origin errors
      }
    }
  });

  // Also show when window loses focus
  window.addEventListener("blur", (): void => {
    showWebex();
    try {
      window.top?.postMessage("study-assist-show-webex", "*");
    } catch (err) {
      // Ignore cross-origin errors
    }
  });
}

// ============================================
// Utility: Check if user is typing
// ============================================

/**
 * Helper function to check if user is typing in a specific element
 * @param activeEl - The active element to check
 * @returns True if user is typing in the element
 */
function isUserTypingInElement(activeEl: HTMLElement | null): boolean {
  return !!(
    activeEl &&
    (activeEl.tagName === "INPUT" ||
      activeEl.tagName === "TEXTAREA" ||
      activeEl.isContentEditable ||
      activeEl.closest('[contenteditable="true"]'))
  );
}

/**
 * Check if the user is currently typing in an input field
 * @returns True if user is typing
 */
export function isUserTyping(): boolean {
  const activeEl = document.activeElement as HTMLElement | null;
  return isUserTypingInElement(activeEl);
}
