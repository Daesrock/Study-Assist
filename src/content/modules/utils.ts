/**
 * Study Assist - Utility Functions Module
 * Common utility functions for DOM traversal, text extraction, and formatting
 */

import type { DetectedQuestion, QuestionType } from "../../types/index.js";
import { log } from "./state.js";

// ============================================
// DOM Traversal Utilities
// ============================================

/**
 * Query selector that traverses into shadow DOMs
 * @param selector - CSS selector
 * @param root - Root element to start from
 * @returns All matching elements including those in nested shadow DOMs
 */
export function querySelectorAllDeep(
  selector: string,
  root: Element | Document | ShadowRoot = document
): Element[] {
  const results: Element[] = [];

  /**
   * Helper function to recursively traverse
   */
  function traverse(node: Element): void {
    // If this node has a shadow root, search inside it
    if (node.shadowRoot) {
      try {
        const shadowMatches = node.shadowRoot.querySelectorAll(selector);
        results.push(...Array.from(shadowMatches));
      } catch (e) {
        // Ignore errors from invalid selectors in shadow DOM
      }

      // Also traverse all elements inside the shadow root
      const shadowElements = node.shadowRoot.querySelectorAll("*");
      for (const el of shadowElements) {
        traverse(el);
      }
    }
  }

  // First, search in the root itself
  try {
    const rootMatches = root.querySelectorAll(selector);
    results.push(...Array.from(rootMatches));
  } catch (e) {
    // Ignore errors from invalid selectors
  }

  // If root is an Element with its own shadow root, traverse it first.
  // This handles the case where root is a custom element (e.g. mcq-view)
  // whose content lives entirely in its shadow DOM.
  if ("shadowRoot" in root && (root as Element).shadowRoot) {
    traverse(root as Element);
  }

  // Then traverse all elements to find shadow roots
  try {
    const allElements = root.querySelectorAll("*");
    for (const el of allElements) {
      traverse(el);
    }
  } catch (e) {
    // Ignore errors
  }

  return results;
}

/**
 * Shadow root information for debugging
 */
interface ShadowRootInfo {
  element: string;
  shadowRoot: ShadowRoot;
}

/**
 * Find all shadow roots in the document (for debugging)
 * @param root - Root element to start from
 * @returns Array of shadow root info
 */
export function findAllShadowRoots(
  root: Element | Document = document
): ShadowRootInfo[] {
  const shadowRoots: ShadowRootInfo[] = [];

  function traverse(node: Element): void {
    if (node.shadowRoot) {
      shadowRoots.push({ element: node.tagName, shadowRoot: node.shadowRoot });
      const shadowElements = node.shadowRoot.querySelectorAll("*");
      for (const el of shadowElements) {
        traverse(el);
      }
    }
  }

  const allElements = root.querySelectorAll("*");
  for (const el of allElements) {
    traverse(el);
  }

  return shadowRoots;
}

// ============================================
// Text Extraction Utilities
// ============================================

/**
 * Get all text content from an element, traversing into shadow roots
 * @param element - The element to extract text from
 * @returns Combined text content with normalized whitespace
 */
export function getDeepTextContent(element: Element): string {
  let text = "";

  function traverse(node: Node): void {
    if (node.nodeType === Node.TEXT_NODE) {
      text += node.textContent + " ";
    } else if (node.nodeType === Node.ELEMENT_NODE) {
      const elementNode = node as Element;
      // First traverse shadow root if exists
      if (elementNode.shadowRoot) {
        for (const child of elementNode.shadowRoot.childNodes) {
          traverse(child);
        }
      }
      // Then traverse regular children
      for (const child of node.childNodes) {
        traverse(child);
      }
    }
  }

  traverse(element);
  return text.replace(/\s+/g, " ").trim();
}

/**
 * Get direct text content of an element (excluding text from children)
 * @param element - The element to extract text from
 * @returns Direct text content only
 */
export function getDirectTextContent(element: Element): string {
  let text = "";
  for (const node of element.childNodes) {
    if (node.nodeType === Node.TEXT_NODE) {
      text += node.textContent;
    }
  }
  return text;
}

/**
 * Get visible text from an element, skipping hidden elements
 * @param element - The element to extract text from
 * @returns Visible text content with normalized whitespace
 */
export function getVisibleText(element: Element): string {
  // Skip hidden elements
  const style = window.getComputedStyle(element);
  if (
    style.display === "none" ||
    style.visibility === "hidden" ||
    style.opacity === "0"
  ) {
    return "";
  }

  // Get text content, preserving some structure
  let text = "";
  const walker = document.createTreeWalker(element, NodeFilter.SHOW_TEXT, {
    acceptNode: (node: Node): number => {
      const parent = node.parentElement;
      if (!parent) return NodeFilter.FILTER_REJECT;

      const parentStyle = window.getComputedStyle(parent);
      if (
        parentStyle.display === "none" ||
        parentStyle.visibility === "hidden"
      ) {
        return NodeFilter.FILTER_REJECT;
      }

      return NodeFilter.FILTER_ACCEPT;
    },
  });

  let currentNode: Node | null;
  while ((currentNode = walker.nextNode())) {
    text += currentNode.textContent + " ";
  }

  return text.replace(/\s+/g, " ").trim();
}

/**
 * Extract accessibility descriptions from dynamic graphics (SVG diagrams)
 * NetAcad uses a11y_description divs to describe topology images
 * @param root - Root element to search
 * @returns Combined accessibility descriptions
 */
export function extractAccessibilityDescriptions(
  root: Element | ShadowRoot
): string {
  const descriptions: string[] = [];
  const seenTexts = new Set<string>();

  function addDescription(text: string | null | undefined): void {
    const trimmed = text?.trim();
    if (trimmed && trimmed.length > 20 && !seenTexts.has(trimmed)) {
      seenTexts.add(trimmed);
      descriptions.push(trimmed);
    }
  }

  /**
   * Deep recursive search for a11y_description elements
   */
  function searchInElement(element: Element | ShadowRoot | null): void {
    if (!element) return;

    // Search in the element's own content (only for Element, not ShadowRoot)
    if (element instanceof Element && element.classList?.contains("a11y_description")) {
      addDescription(element.textContent);
    }

    // Search children
    const children = element.querySelectorAll?.(".a11y_description");
    if (children) {
      for (const el of children) {
        addDescription(el.textContent);
      }
    }

    // Search in shadow root if exists (only for Element)
    if (element instanceof Element && element.shadowRoot) {
      const shadowA11y =
        element.shadowRoot.querySelectorAll(".a11y_description");
      for (const el of shadowA11y) {
        addDescription(el.textContent);
      }

      // Recursively search elements inside shadow root
      const shadowElements = element.shadowRoot.querySelectorAll("*");
      for (const el of shadowElements) {
        searchInElement(el);
      }
    }
  }

  // Search in the provided root
  searchInElement(root);

  // Also search for aria-labelledby references
  const figureElements = querySelectorAllDeep("[role='figure']", root);
  for (const fig of figureElements) {
    const ariaLabel = fig.getAttribute("aria-labelledby");
    if (ariaLabel) {
      const labelEl = querySelectorAllDeep(`#${ariaLabel}`, root)[0];
      if (labelEl) {
        addDescription(labelEl.textContent);
      }
    }
  }

  // Search for dynamic-graphic-view elements specifically
  const dynamicGraphics = querySelectorAllDeep("dynamic-graphic-view", root);
  for (const graphic of dynamicGraphics) {
    searchInElement(graphic);
  }

  // Search for tabs-view and inline-svg-viewer elements
  const tabsViews = querySelectorAllDeep("tabs-view", root);
  for (const tabs of tabsViews) {
    searchInElement(tabs);
  }

  if (descriptions.length > 0) {
    log(
      "[Study Assist] Found accessibility descriptions:",
      descriptions.length
    );
  }

  return descriptions.join("\n\n");
}

// ============================================
// Visibility Utilities
// ============================================

/**
 * Check how much of an element is visible in viewport (0-1)
 * @param element - The element to check
 * @returns Visibility score from 0 (not visible) to 1 (fully visible and centered)
 */
export function getVisibilityScore(element: Element): number {
  const rect = element.getBoundingClientRect();
  const windowHeight = window.innerHeight;
  const windowWidth = window.innerWidth;

  // Element is completely outside viewport
  if (
    rect.bottom < 0 ||
    rect.top > windowHeight ||
    rect.right < 0 ||
    rect.left > windowWidth
  ) {
    return 0;
  }

  // Calculate visible area
  const visibleTop = Math.max(0, rect.top);
  const visibleBottom = Math.min(windowHeight, rect.bottom);
  const visibleLeft = Math.max(0, rect.left);
  const visibleRight = Math.min(windowWidth, rect.right);

  const visibleHeight = visibleBottom - visibleTop;
  const visibleWidth = visibleRight - visibleLeft;
  const visibleArea = visibleHeight * visibleWidth;

  const elementArea = rect.width * rect.height;
  if (elementArea === 0) return 0;

  // Favor elements closer to center of screen
  const centerY = (rect.top + rect.bottom) / 2;
  const screenCenterY = windowHeight / 2;
  const centerBonus = 1 - Math.abs(centerY - screenCenterY) / windowHeight;

  return (visibleArea / elementArea) * 0.7 + centerBonus * 0.3;
}

// ============================================
// Element Relationship Utilities
// ============================================

/**
 * Check if an element is a child of any processed question element
 * @param element - The element to check
 * @param detectedQuestions - Array of detected question objects with element property
 * @returns True if element is contained within a processed question
 */
export function isChildOfProcessed(
  element: Element,
  detectedQuestions: DetectedQuestion[]
): boolean {
  for (const q of detectedQuestions) {
    if (q.element.contains(element) && q.element !== element) {
      return true;
    }
  }
  return false;
}

// ============================================
// Text Formatting Utilities
// ============================================

/**
 * Format question type for display with emoji
 * @param type - The question type identifier
 * @returns Formatted question type with emoji
 */
export function formatQuestionType(type: QuestionType | string): string {
  const types: Record<string, string> = {
    "multiple-choice": "📋 Multiple Choice",
    "true-false": "✓✗ True/False",
    "fill-blank": "📝 Fill in the Blank",
    unknown: "❓ Question",
  };
  return types[type] || types["unknown"];
}

/**
 * Truncate text to a maximum length with ellipsis
 * @param text - The text to truncate
 * @param maxLength - Maximum length before truncation
 * @returns Truncated text with ellipsis if needed
 */
export function truncateText(text: string, maxLength: number): string {
  if (text.length <= maxLength) return text;
  return text.substring(0, maxLength).trim() + "...";
}

/**
 * Escape HTML special characters to prevent XSS
 * @param text - The text to escape
 * @returns HTML-escaped text
 */
export function escapeHtml(text: string): string {
  const div = document.createElement("div");
  div.textContent = text;
  return div.innerHTML;
}

/**
 * Format AI analysis result with basic markdown-to-HTML conversion
 * Converts bold, italic, and line breaks to HTML
 * @param result - The analysis result text with markdown formatting
 * @returns HTML-formatted result
 */
export function formatAnalysisResult(result: string): string {
  // Convert markdown-style formatting to HTML
  let formatted = escapeHtml(result);

  // Bold text: **text** or __text__
  formatted = formatted.replace(/\*\*(.+?)\*\*/g, "<strong>$1</strong>");
  formatted = formatted.replace(/__(.+?)__/g, "<strong>$1</strong>");

  // Italic text: *text* or _text_
  formatted = formatted.replace(/\*(.+?)\*/g, "<em>$1</em>");
  formatted = formatted.replace(/_(.+?)_/g, "<em>$1</em>");

  // Line breaks
  formatted = formatted.replace(/\n\n/g, "</p><p>");
  formatted = formatted.replace(/\n/g, "<br>");

  // Wrap in paragraph
  formatted = `<p>${formatted}</p>`;

  return formatted;
}
