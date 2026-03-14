"use strict";
(() => {
  // src/content/modules/state.ts
  var DEBUG_MODE = true;
  var log = (...args) => {
    if (DEBUG_MODE) {
      console.log(...args);
    }
  };
  var state = {
    isActive: false,
    isDomainAllowed: false,
    isInitialized: false,
    settings: {
      responseMode: "guided",
      autoDetect: true,
      highlightQuestions: true,
      quickMode: false,
      sendImages: false,
      buttonPosition: "bottom-right"
    },
    detectedQuestions: [],
    currentVisibleQuestion: null,
    overlayVisible: false,
    contentObserver: null,
    // Track current question for quick mode answer persistence
    lastAnsweredQuestionNum: null,
    questionChangeObserver: null,
    questionChangeInterval: null,
    // Prevent simultaneous API requests
    isRequestInProgress: false,
    // Block new requests when valid answer is displayed (until reload)
    hasValidAnswer: false,
    // Skip DeepSeek and use Claude directly (CTRL+SHIFT)
    skipDeepSeek: false,
    // Slow connection timer
    slowConnectionTimer: null,
    // Request cancelled by user (ALT+X)
    requestCancelled: false,
    // Pending question change (for double-confirmation)
    pendingQuestionChange: null
  };
  var DEFAULT_ALLOWED_DOMAINS = [];

  // src/content/modules/utils.ts
  function querySelectorAllDeep(selector, root = document) {
    const results = [];
    function traverse(node) {
      if (node.shadowRoot) {
        try {
          const shadowMatches = node.shadowRoot.querySelectorAll(selector);
          results.push(...Array.from(shadowMatches));
        } catch (e) {
        }
        const shadowElements = node.shadowRoot.querySelectorAll("*");
        for (const el of shadowElements) {
          traverse(el);
        }
      }
    }
    try {
      const rootMatches = root.querySelectorAll(selector);
      results.push(...Array.from(rootMatches));
    } catch (e) {
    }
    if ("shadowRoot" in root && root.shadowRoot) {
      traverse(root);
    }
    try {
      const allElements = root.querySelectorAll("*");
      for (const el of allElements) {
        traverse(el);
      }
    } catch (e) {
    }
    return results;
  }
  function findAllShadowRoots(root = document) {
    const shadowRoots = [];
    function traverse(node) {
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
  function getDeepTextContent(element) {
    let text = "";
    function traverse(node) {
      if (node.nodeType === Node.TEXT_NODE) {
        text += node.textContent + " ";
      } else if (node.nodeType === Node.ELEMENT_NODE) {
        const elementNode = node;
        if (elementNode.shadowRoot) {
          for (const child of elementNode.shadowRoot.childNodes) {
            traverse(child);
          }
        }
        for (const child of node.childNodes) {
          traverse(child);
        }
      }
    }
    traverse(element);
    return text.replace(/\s+/g, " ").trim();
  }
  function getDirectTextContent(element) {
    let text = "";
    for (const node of element.childNodes) {
      if (node.nodeType === Node.TEXT_NODE) {
        text += node.textContent;
      }
    }
    return text;
  }
  function getVisibleText(element) {
    const style = window.getComputedStyle(element);
    if (style.display === "none" || style.visibility === "hidden" || style.opacity === "0") {
      return "";
    }
    let text = "";
    const walker = document.createTreeWalker(element, NodeFilter.SHOW_TEXT, {
      acceptNode: (node) => {
        const parent = node.parentElement;
        if (!parent)
          return NodeFilter.FILTER_REJECT;
        const parentStyle = window.getComputedStyle(parent);
        if (parentStyle.display === "none" || parentStyle.visibility === "hidden") {
          return NodeFilter.FILTER_REJECT;
        }
        return NodeFilter.FILTER_ACCEPT;
      }
    });
    let currentNode;
    while (currentNode = walker.nextNode()) {
      text += currentNode.textContent + " ";
    }
    return text.replace(/\s+/g, " ").trim();
  }
  function extractAccessibilityDescriptions(root) {
    const descriptions = [];
    const seenTexts = /* @__PURE__ */ new Set();
    function addDescription(text) {
      const trimmed = text?.trim();
      if (trimmed && trimmed.length > 20 && !seenTexts.has(trimmed)) {
        seenTexts.add(trimmed);
        descriptions.push(trimmed);
      }
    }
    function searchInElement(element) {
      if (!element)
        return;
      if (element instanceof Element && element.classList?.contains("a11y_description")) {
        addDescription(element.textContent);
      }
      const children = element.querySelectorAll?.(".a11y_description");
      if (children) {
        for (const el of children) {
          addDescription(el.textContent);
        }
      }
      if (element instanceof Element && element.shadowRoot) {
        const shadowA11y = element.shadowRoot.querySelectorAll(".a11y_description");
        for (const el of shadowA11y) {
          addDescription(el.textContent);
        }
        const shadowElements = element.shadowRoot.querySelectorAll("*");
        for (const el of shadowElements) {
          searchInElement(el);
        }
      }
    }
    searchInElement(root);
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
    const dynamicGraphics = querySelectorAllDeep("dynamic-graphic-view", root);
    for (const graphic of dynamicGraphics) {
      searchInElement(graphic);
    }
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
  function getVisibilityScore(element) {
    const rect = element.getBoundingClientRect();
    const windowHeight = window.innerHeight;
    const windowWidth = window.innerWidth;
    if (rect.bottom < 0 || rect.top > windowHeight || rect.right < 0 || rect.left > windowWidth) {
      return 0;
    }
    const visibleTop = Math.max(0, rect.top);
    const visibleBottom = Math.min(windowHeight, rect.bottom);
    const visibleLeft = Math.max(0, rect.left);
    const visibleRight = Math.min(windowWidth, rect.right);
    const visibleHeight = visibleBottom - visibleTop;
    const visibleWidth = visibleRight - visibleLeft;
    const visibleArea = visibleHeight * visibleWidth;
    const elementArea = rect.width * rect.height;
    if (elementArea === 0)
      return 0;
    const centerY = (rect.top + rect.bottom) / 2;
    const screenCenterY = windowHeight / 2;
    const centerBonus = 1 - Math.abs(centerY - screenCenterY) / windowHeight;
    return visibleArea / elementArea * 0.7 + centerBonus * 0.3;
  }
  function isChildOfProcessed(element, detectedQuestions) {
    for (const q of detectedQuestions) {
      if (q.element.contains(element) && q.element !== element) {
        return true;
      }
    }
    return false;
  }
  function truncateText(text, maxLength) {
    if (text.length <= maxLength)
      return text;
    return text.substring(0, maxLength).trim() + "...";
  }
  function escapeHtml(text) {
    const div = document.createElement("div");
    div.textContent = text;
    return div.innerHTML;
  }
  function formatAnalysisResult(result) {
    let formatted = escapeHtml(result);
    formatted = formatted.replace(/\*\*(.+?)\*\*/g, "<strong>$1</strong>");
    formatted = formatted.replace(/__(.+?)__/g, "<strong>$1</strong>");
    formatted = formatted.replace(/\*(.+?)\*/g, "<em>$1</em>");
    formatted = formatted.replace(/_(.+?)_/g, "<em>$1</em>");
    formatted = formatted.replace(/\n\n/g, "</p><p>");
    formatted = formatted.replace(/\n/g, "<br>");
    formatted = `<p>${formatted}</p>`;
    return formatted;
  }

  // src/content/modules/images.ts
  function isPublicImageUrl(src) {
    if (!src)
      return false;
    try {
      const url = new URL(src);
      if (url.protocol !== "https:" && url.protocol !== "http:")
        return false;
      const host = url.hostname.toLowerCase();
      if (host === "localhost" || host === "127.0.0.1" || host === "[::1]")
        return false;
      if (src.startsWith("chrome-extension://") || src.startsWith("moz-extension://"))
        return false;
      return true;
    } catch {
      return false;
    }
  }
  async function extractImagesAsBase64(root) {
    const images = [];
    const imgElements = querySelectorAllDeep("img", root);
    for (const img of imgElements) {
      try {
        const imgSrc = img.src;
        if (imgSrc.startsWith("data:") && imgSrc.length < 500) {
          continue;
        }
        if (imgSrc.includes("icon") || imgSrc.includes("logo") || imgSrc.includes("avatar")) {
          continue;
        }
        if (!img.complete) {
          await new Promise((resolve) => {
            img.onload = () => resolve();
            img.onerror = () => resolve();
            setTimeout(resolve, 3e3);
          });
        }
        const width = img.naturalWidth || img.width || 100;
        const height = img.naturalHeight || img.height || 100;
        if (width < 30 || height < 30) {
          continue;
        }
        if (isPublicImageUrl(imgSrc)) {
          images.push({
            url: imgSrc,
            mediaType: "image/jpeg"
            // Claude doesn't need this for URL type
          });
        } else {
          const base64Data = await imageToBase64(img);
          if (base64Data) {
            images.push(base64Data);
          }
        }
      } catch (error) {
        console.warn("[Study Assist] Failed to extract image:", error);
      }
    }
    return images;
  }
  async function imageToBase64(img) {
    return new Promise((resolve) => {
      try {
        if (!img.complete) {
          img.onload = () => convertToBase64(img, resolve);
          img.onerror = () => resolve(null);
          return;
        }
        convertToBase64(img, resolve);
      } catch (error) {
        console.warn("[Study Assist] Image conversion error:", error);
        resolve(null);
      }
    });
  }
  function convertToBase64(img, resolve) {
    try {
      const canvas = document.createElement("canvas");
      canvas.width = img.naturalWidth || img.width;
      canvas.height = img.naturalHeight || img.height;
      if (canvas.width < 50 || canvas.height < 50) {
        resolve(null);
        return;
      }
      const ctx = canvas.getContext("2d");
      if (!ctx) {
        resolve(null);
        return;
      }
      ctx.drawImage(img, 0, 0);
      const dataUrl = canvas.toDataURL("image/png");
      const base64 = dataUrl.replace(/^data:image\/\w+;base64,/, "");
      resolve({
        base64,
        mediaType: "image/png"
      });
    } catch (error) {
      fetchImageAsBase64(img.src).then(resolve).catch(() => resolve(null));
    }
  }
  async function fetchImageAsBase64(url) {
    try {
      const response = await fetch(url);
      const blob = await response.blob();
      return new Promise((resolve, reject) => {
        const reader = new FileReader();
        reader.onloadend = () => {
          const dataUrl = reader.result;
          const base64 = dataUrl.replace(/^data:image\/\w+;base64,/, "");
          const mediaType = blob.type || "image/png";
          resolve({ base64, mediaType });
        };
        reader.onerror = reject;
        reader.readAsDataURL(blob);
      });
    } catch (error) {
      console.warn("[Study Assist] Failed to fetch image:", error);
      return null;
    }
  }

  // src/content/modules/detection.ts
  var QUESTION_PATTERNS = {
    // Question indicators (English and Spanish)
    questionMarkers: /\?|what|which|how|why|when|where|who|whose|whom|explain|describe|define|identify|select|choose|pick|determine|calculate|compute|find|solve|analyze|evaluate|compare|contrast|list|name|state|qué|cuál|cómo|por\s*qué|cuándo|dónde|quién|pregunta\s*\d+/i,
    // Multiple choice patterns
    multipleChoice: [
      /^\s*[A-Da-d][\.\)\:]?\s+.+/m,
      // A. Answer or A) Answer or A: Answer
      /^\s*\([A-Da-d]\)\s+.+/m,
      // (A) Answer
      /^\s*[1-4][\.\)\:]?\s+.+/m,
      // 1. Answer or 1) Answer
      /\b(?:option|choice|answer)\s*[A-Da-d1-4]/i,
      // Option A, Choice B, Answer 1
      /<input[^>]*type=["']?radio["']?[^>]*>/i,
      // Radio button inputs
      /\bselect\s+(?:one|all|the\s+(?:correct|best|right))/i,
      // "Select one", "Select the correct"
      /radio_button_(?:checked|unchecked)/i,
      // Material Design icons (NetAcad)
      /pregunta\s*\d+/i
      // "Pregunta 1", "Pregunta 2" (NetAcad Spanish)
    ],
    // True/False patterns
    trueFalse: [
      /\b(?:true|false)\b.*\b(?:true|false)\b/i,
      /^\s*(?:True|False|T|F)[\.\)\s]/m,
      /\b(?:is\s+this|this\s+is)\s+(?:true|false|correct|incorrect)\b/i,
      /\b(?:verdadero|falso)\b/i
      // Spanish
    ],
    // Fill in the blank
    fillBlank: [
      /_{2,}|\.{3,}|\[?\s*blank\s*\]?/i,
      /fill\s+(?:in\s+)?(?:the\s+)?(?:blank|gap)/i,
      /complete\s+(?:la|el|los|las)/i
      // Spanish
    ]
  };
  function cleanQuestionText(rawText) {
    if (!rawText || rawText.length < 100) {
      return rawText;
    }
    const questionStartPatterns = [
      /(?:consulte\s+(?:la\s+)?(?:imagen|ilustraci[oó]n|exhibici[oó]n|figura|tabla|gr[aá]fic[ao]))[.:,]?\s*/i,
      /(?:refer\s+to\s+the\s+(?:exhibit|figure|diagram|image|table|graphic))[.:,]?\s*/i,
      /(?:see\s+the\s+(?:exhibit|figure|diagram|image|table|graphic))[.:,]?\s*/i
    ];
    for (const pattern of questionStartPatterns) {
      const match = rawText.match(pattern);
      if (match && match.index !== void 0) {
        const questionPart = rawText.substring(match.index).trim();
        if (questionPart.includes("?")) {
          log(`[Study Assist] Cleaned question text: "${rawText.substring(0, 50)}..." \u2192 "${questionPart.substring(0, 100)}..."`);
          return questionPart;
        }
      }
    }
    const lines = rawText.split("\n").map((l) => l.trim()).filter((l) => l.length > 0);
    const tableLinePatt = /^[A-Z]\s+[\d\.:/]+|^\w+\([^)]+\)\s*#|^[\d\.]+ \[|gateway\s+of\s+last\s+resort/i;
    const tableLines = lines.filter((l) => tableLinePatt.test(l));
    if (tableLines.length > lines.length * 0.3) {
      const sentences = rawText.split(/[.!¿]\s+/).filter((s) => s.includes("?"));
      if (sentences.length > 0) {
        const lastQuestion = sentences[sentences.length - 1].trim();
        const contextMatch = rawText.match(/(consulte\s+(?:la\s+)?(?:imagen|ilustraci[oó]n|exhibici[oó]n)[.:,]?\s+[^¿?]+\?)/i);
        if (contextMatch) {
          log(`[Study Assist] Cleaned question text (table detected): "${rawText.substring(0, 50)}..." \u2192 "${contextMatch[1].trim().substring(0, 100)}..."`);
          return contextMatch[1].trim();
        }
        log(`[Study Assist] Cleaned question text (table detected): "${rawText.substring(0, 50)}..." \u2192 "${lastQuestion.substring(0, 100)}..."`);
        return lastQuestion;
      }
    }
    return rawText;
  }
  async function detectQuestionsOnPage(retryCount = 0) {
    if (!state.isActive)
      return;
    state.detectedQuestions = [];
    await detectMoodleQuestions();
    if (state.detectedQuestions.length === 0) {
      detectNetAcadQuestions();
    }
    if (state.detectedQuestions.length === 0) {
      detectGeneralQuestions();
    }
    return {
      found: state.detectedQuestions.length > 0,
      count: state.detectedQuestions.length,
      retryCount
    };
  }
  async function detectMoodleQuestions() {
    const moodleQuestions = document.querySelectorAll(
      ".que.multichoice, .que.truefalse, .que.match, .que.shortanswer, .que.numerical, .que.gapselect"
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
            courseName: questionData.courseName
          });
        }
      }
    }
  }
  function detectNetAcadQuestions() {
    const shadowRoots = findAllShadowRoots();
    const mcqViews = querySelectorAllDeep("mcq-view");
    if (mcqViews.length > 0) {
      mcqViews.forEach((mcqView, index) => {
        const shadowRoot = mcqView.shadowRoot;
        if (!shadowRoot) {
          return;
        }
        let questionText = "";
        const questionBodyEls = querySelectorAllDeep(
          ".mcq__body-inner",
          shadowRoot
        );
        if (questionBodyEls.length > 0) {
          const rawText = questionBodyEls[0].textContent?.trim() || "";
          questionText = cleanQuestionText(rawText);
        }
        if (!questionText) {
          const headerEls = querySelectorAllDeep(
            ".mcq__header, .component__body",
            shadowRoot
          );
          if (headerEls.length > 0) {
            const rawText = headerEls[0].textContent?.trim() || "";
            questionText = cleanQuestionText(rawText);
          }
        }
        if (!questionText) {
          questionText = getDeepTextContent(mcqView);
          const lines = questionText.split("\n").filter((l) => l.trim().length > 10);
          if (lines.length > 0) {
            questionText = lines[0].trim();
          }
        }
        const optionEls = querySelectorAllDeep(
          ".mcq__item-text-inner",
          shadowRoot
        );
        const options = [];
        optionEls.forEach((optEl, optIndex) => {
          const optText = optEl.textContent?.trim() || "";
          if (optText && optText.length > 0) {
            options.push({
              letter: String.fromCharCode(65 + optIndex),
              // A, B, C, D
              text: optText
            });
          }
        });
        let questionNumber = index + 1;
        const fullText = getDeepTextContent(mcqView);
        const preguntaMatch = fullText.match(/pregunta\s*(\d+)/i);
        if (preguntaMatch) {
          questionNumber = parseInt(preguntaMatch[1]);
        }
        if (options.length >= 2) {
          state.detectedQuestions.push({
            id: `q-${index}`,
            questionNumber,
            element: mcqView,
            text: questionText || `Question ${questionNumber}`,
            type: "multiple-choice",
            options,
            confidence: 95
          });
        }
      });
      if (state.detectedQuestions.length > 0) {
        return;
      }
    }
    const mcqItems = querySelectorAllDeep(".mcq__item-text-inner");
    if (mcqItems.length > 0) {
      const questionMap = /* @__PURE__ */ new Map();
      mcqItems.forEach((item) => {
        let parent = item;
        while (parent && parent.tagName !== "MCQ-VIEW") {
          parent = parent.parentElement || parent.host;
        }
        if (parent) {
          if (!questionMap.has(parent)) {
            questionMap.set(parent, []);
          }
          questionMap.get(parent).push(item.textContent?.trim() || "");
        }
      });
      let index = 0;
      questionMap.forEach((optionTexts, container) => {
        const questionBody = querySelectorAllDeep(
          ".mcq__body-inner",
          container.shadowRoot || container
        )[0];
        const rawText = questionBody ? questionBody.textContent?.trim() || `Question ${index + 1}` : `Question ${index + 1}`;
        const questionText = cleanQuestionText(rawText);
        const options = optionTexts.map((text, i) => ({
          letter: String.fromCharCode(65 + i),
          text
        }));
        if (options.length >= 2) {
          state.detectedQuestions.push({
            id: `q-${index}`,
            element: container,
            text: questionText,
            type: "multiple-choice",
            options,
            confidence: 90
          });
          index++;
        }
      });
      if (state.detectedQuestions.length > 0) {
        return;
      }
    }
    const allClasses = /* @__PURE__ */ new Set();
    document.querySelectorAll("*").forEach((el) => {
      if (el.className && typeof el.className === "string") {
        el.className.split(/\s+/).forEach((cls) => {
          if (cls.length > 0)
            allClasses.add(cls);
        });
      }
    });
    const relevantClasses = Array.from(allClasses).filter(
      (cls) => /mcq|question|answer|option|choice|radio|check|select|quiz|item/i.test(cls)
    );
    const radioButtons = document.querySelectorAll(
      'input[type="radio"], input[type="checkbox"]'
    );
    if (radioButtons.length >= 2) {
      const questionGroups = /* @__PURE__ */ new Map();
      radioButtons.forEach((radio) => {
        const name = radio.name || radio.id || "unnamed";
        if (!questionGroups.has(name)) {
          questionGroups.set(name, []);
        }
        questionGroups.get(name).push(radio);
      });
      let index = 0;
      questionGroups.forEach((radios, groupName) => {
        if (radios.length >= 2) {
          let container = radios[0].closest(
            'form, fieldset, [role="group"], [role="radiogroup"]'
          );
          if (!container) {
            container = radios[0].parentElement;
            for (let i = 0; i < 10; i++) {
              if (!container || !container.parentElement)
                break;
              const containsAll = radios.every((r) => container.contains(r));
              if (containsAll && container.innerText && container.innerText.length > 50) {
                break;
              }
              container = container.parentElement;
            }
          }
          if (container) {
            const options = radios.map((radio, i) => {
              let labelText = "";
              const label = radio.closest("label") || document.querySelector(`label[for="${radio.id}"]`);
              if (label) {
                labelText = label.innerText?.trim() || "";
              } else {
                const parent = radio.parentElement;
                labelText = parent?.innerText?.trim() || "";
              }
              return {
                letter: String.fromCharCode(65 + i),
                text: labelText
              };
            }).filter((opt) => opt.text.length > 0);
            const fullText = container.innerText || "";
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
                options,
                confidence: 85
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
    const regularMcqItems = document.querySelectorAll(
      '.mcq__item-text, .mcq__item-text-inner, [class*="mcq__"], [class*="mcq-"]'
    );
    if (regularMcqItems.length > 0) {
      const questionContainers = /* @__PURE__ */ new Set();
      regularMcqItems.forEach((item) => {
        let container = item;
        for (let i = 0; i < 15; i++) {
          if (!container.parentElement)
            break;
          container = container.parentElement;
          const mcqCount = container.querySelectorAll(
            '.mcq__item, [class*="mcq__item"]'
          ).length;
          const text = container.innerText || "";
          if (mcqCount >= 2 && text.length > 50 && text.length < 5e3) {
            if (/\?|pregunta|qué|cuál|cómo|dónde|which|what|how|where/i.test(text)) {
              questionContainers.add(container);
              break;
            }
          }
        }
      });
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
            confidence: 90
          });
          index++;
        }
      });
      if (state.detectedQuestions.length > 0) {
        return;
      }
    }
    const fallbackElements = document.body.querySelectorAll("*");
    const questionContainersList = [];
    fallbackElements.forEach((el) => {
      const text = el.textContent || "";
      if (/pregunta\s*\d+/i.test(text) && text.length < 500) {
        let container = el;
        while (container.parentElement && container.parentElement !== document.body) {
          const parentText = container.parentElement.textContent || "";
          if (/radio_button|checkbox/i.test(parentText) || container.parentElement.querySelectorAll('input[type="radio"]').length > 0) {
            container = container.parentElement;
            break;
          }
          if (parentText.length > 3e3)
            break;
          container = container.parentElement;
        }
        if (!questionContainersList.includes(container)) {
          questionContainersList.push(container);
        }
      }
    });
    const bodyText = document.body.innerText || "";
    if (/radio_button_(?:checked|unchecked)/i.test(bodyText)) {
      const walker = document.createTreeWalker(
        document.body,
        NodeFilter.SHOW_TEXT
      );
      let node;
      const radioContainers = /* @__PURE__ */ new Set();
      while (node = walker.nextNode()) {
        if (/radio_button/i.test(node.textContent || "")) {
          let parent = node.parentElement;
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
    questionContainersList.forEach((container, index) => {
      const text = getVisibleText(container);
      if (text && text.length > 30) {
        const options = extractNetAcadOptions(text, container);
        state.detectedQuestions.push({
          id: `q-${index}`,
          element: container,
          text,
          type: "multiple-choice",
          options,
          confidence: 80
        });
      }
    });
  }
  function extractNetAcadOptions(text, element) {
    const options = [];
    const parts = text.split(/radio_button_(?:checked|unchecked)/i);
    if (parts.length > 1) {
      parts.slice(1).forEach((part, index) => {
        const optionText = part.trim().split("\n")[0].trim();
        if (optionText && optionText.length > 2) {
          options.push({
            letter: String.fromCharCode(65 + index),
            // A, B, C, D...
            text: optionText
          });
        }
      });
    }
    return options;
  }
  function extractNetAcadQuestion(container) {
    const options = [];
    const mcqItems = container.querySelectorAll(
      '.mcq__item, [class*="mcq__item"]'
    );
    if (mcqItems.length === 0) {
      const textItems = container.querySelectorAll(
        ".mcq__item-text, .mcq__item-text-inner"
      );
      textItems.forEach((item, index) => {
        const text = item.innerText?.trim();
        if (text && text.length > 1) {
          options.push({
            letter: String.fromCharCode(65 + index),
            text
          });
        }
      });
    } else {
      mcqItems.forEach((item, index) => {
        const textEl = item.querySelector(".mcq__item-text-inner, .mcq__item-text") || item;
        const text = textEl.innerText?.trim();
        if (text && text.length > 1) {
          options.push({
            letter: String.fromCharCode(65 + index),
            text
          });
        }
      });
    }
    let questionText = container.innerText || "";
    options.forEach((opt) => {
      questionText = questionText.replace(opt.text, "");
    });
    questionText = questionText.replace(/radio_button_(?:checked|unchecked)/gi, "").replace(/\s+/g, " ").trim();
    if (questionText.length < 10 || options.length < 2) {
      return null;
    }
    return {
      questionText,
      options
    };
  }
  function detectGeneralQuestions() {
    const textElements = document.querySelectorAll(
      'p, div, span, li, td, th, label, h1, h2, h3, h4, h5, h6, article, section, blockquote, .question, .quiz-question, [class*="question"], [class*="quiz"], [class*="exam"], [data-question], [role="listitem"]'
    );
    const processedTexts = /* @__PURE__ */ new Set();
    textElements.forEach((element, index) => {
      const text = getVisibleText(element);
      if (!text || text.length < 20 || processedTexts.has(text))
        return;
      if (isChildOfProcessed(element, state.detectedQuestions))
        return;
      const questionInfo = analyzeTextForQuestion(text, element);
      if (questionInfo.isQuestion) {
        processedTexts.add(text);
        state.detectedQuestions.push({
          id: `q-${state.detectedQuestions.length}`,
          element,
          text,
          type: questionInfo.type,
          options: questionInfo.options,
          confidence: questionInfo.confidence
        });
      }
    });
  }
  function analyzeTextForQuestion(text, element) {
    let isQuestion = false;
    let type = "unknown";
    let options = [];
    let confidence = 0;
    if (QUESTION_PATTERNS.questionMarkers.test(text)) {
      confidence += 30;
    }
    for (const pattern of QUESTION_PATTERNS.multipleChoice) {
      if (pattern.test(text)) {
        type = "multiple-choice";
        confidence += 40;
        options = extractOptions(text, element);
        break;
      }
    }
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
    if (type === "unknown") {
      for (const pattern of QUESTION_PATTERNS.fillBlank) {
        if (pattern.test(text)) {
          type = "fill-blank";
          confidence += 30;
          break;
        }
      }
    }
    const classList = (element.className || "").toString().toLowerCase();
    const dataAttrs = Array.from(element.attributes).map((a) => a.name.toLowerCase()).join(" ");
    if (/question|quiz|exam|test|assessment/i.test(classList + " " + dataAttrs)) {
      confidence += 25;
    }
    const hasInputs = element.querySelectorAll('input[type="radio"], input[type="checkbox"]').length > 0;
    if (hasInputs) {
      type = type === "unknown" ? "multiple-choice" : type;
      confidence += 35;
      if (options.length === 0) {
        options = extractOptionsFromInputs(element);
      }
    }
    isQuestion = confidence >= 40;
    return { isQuestion, type, options, confidence };
  }
  function extractOptions(text, element) {
    const options = [];
    const letterPattern = /(?:^|\n)\s*([A-Da-d])[\.\)\:]?\s*([^\n]+)/gm;
    let match;
    while ((match = letterPattern.exec(text)) !== null) {
      options.push({
        letter: match[1].toUpperCase(),
        text: match[2].trim()
      });
    }
    if (options.length === 0) {
      const parenPattern = /\(([A-Da-d])\)\s*([^\n\(]+)/gm;
      while ((match = parenPattern.exec(text)) !== null) {
        options.push({
          letter: match[1].toUpperCase(),
          text: match[2].trim()
        });
      }
    }
    if (options.length === 0) {
      const numberPattern = /(?:^|\n)\s*([1-4])[\.\)\:]?\s*([^\n]+)/gm;
      while ((match = numberPattern.exec(text)) !== null) {
        options.push({
          letter: match[1],
          text: match[2].trim()
        });
      }
    }
    return options;
  }
  function extractOptionsFromInputs(element) {
    const options = [];
    const inputs = element.querySelectorAll(
      'input[type="radio"], input[type="checkbox"]'
    );
    inputs.forEach((input, index) => {
      const label = element.querySelector(`label[for="${input.id}"]`) || input.closest("label");
      const text = label ? getVisibleText(label) : input.value || `Option ${index + 1}`;
      options.push({
        letter: String.fromCharCode(65 + index),
        // A, B, C, D...
        text: (text || "").replace(/^[A-Da-d][\.\)\:]\s*/, "").trim()
      });
    });
    return options;
  }
  function frameHasQuizContent() {
    const mcqViews = querySelectorAllDeep("mcq-view");
    const matchingViews = querySelectorAllDeep("object-matching-view");
    const dropdownMatchingViews = querySelectorAllDeep("matching-view");
    if (mcqViews.length > 0 || matchingViews.length > 0 || dropdownMatchingViews.length > 0) {
      return true;
    }
    const moodleQuestions = document.querySelectorAll(
      ".que.multichoice, .que.truefalse, .que.shortanswer, .que.numerical, .que.essay, .que.match, .que.gapselect"
    );
    if (moodleQuestions.length > 0) {
      return true;
    }
    return false;
  }
  function waitForQuizContent(callback, maxAttempts = 10, interval = 500) {
    let attempts = 0;
    function check() {
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
  function findVisibleQuestionNumber() {
    const candidates = [];
    function collectTextNodes(root) {
      const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
      let node;
      while (node = walker.nextNode()) {
        if (node.textContent && /pregunta\s*\d+/i.test(node.textContent)) {
          const match = node.textContent.match(/pregunta\s*(\d+)/i);
          if (match) {
            const num = parseInt(match[1]);
            const parent = node.parentElement;
            if (parent) {
              const rect = parent.getBoundingClientRect();
              if (rect.top >= -100 && rect.top <= window.innerHeight && rect.width > 0 && rect.height > 0) {
                const fontSize = parseFloat(window.getComputedStyle(parent).fontSize) || 12;
                const area = rect.width * rect.height;
                const centerDistance = Math.abs(
                  rect.left + rect.width / 2 - window.innerWidth / 2
                );
                const score = fontSize * 10 + area / 100 - centerDistance / 10;
                candidates.push({
                  num,
                  top: rect.top,
                  fontSize,
                  area,
                  score,
                  text: node.textContent.trim()
                });
              }
            }
          }
        }
      }
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
    candidates.sort((a, b) => b.score - a.score);
    return candidates[0].num;
  }
  async function detectVisibleQuestion() {
    const moodleQuestion = await detectMoodleQuestion();
    if (moodleQuestion) {
      return moodleQuestion;
    }
    const visibleQuestionNum = findVisibleQuestionNumber();
    const questionMap = buildQuestionMap();
    log("[Study Assist] detectVisibleQuestion:", {
      visibleQuestionNum,
      questionMapKeys: Object.keys(questionMap),
      questionMapDetails: Object.entries(questionMap).map(([k, v]) => ({
        num: k,
        type: v.question?.type,
        score: v.score,
        text: v.question?.text?.substring(0, 50)
      }))
    });
    if (visibleQuestionNum !== null && questionMap[visibleQuestionNum]) {
      const entry = questionMap[visibleQuestionNum];
      return entry.question;
    }
    let bestEntry = null;
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
  async function detectMoodleQuestion() {
    const moodleQuestions = document.querySelectorAll(
      ".que.multichoice, .que.truefalse, .que.match, .que.shortanswer, .que.numerical, .que.gapselect"
    );
    if (moodleQuestions.length === 0) {
      return null;
    }
    const viewportCenterY = window.innerHeight / 2;
    let bestQuestion = null;
    let bestScore = -Infinity;
    for (const questionEl of moodleQuestions) {
      const rect = questionEl.getBoundingClientRect();
      if (rect.width === 0 || rect.height === 0)
        continue;
      const isInViewport = rect.top < window.innerHeight && rect.bottom > 0;
      if (!isInViewport)
        continue;
      const centerDist = Math.abs((rect.top + rect.bottom) / 2 - viewportCenterY);
      const score = 1e4 - centerDist;
      if (score > bestScore) {
        bestScore = score;
        bestQuestion = questionEl;
      }
    }
    if (!bestQuestion) {
      bestQuestion = moodleQuestions[0] ?? null;
    }
    if (!bestQuestion) {
      return null;
    }
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
  function extractMoodleCourseName() {
    const title = document.title.trim();
    const colonIndex = title.lastIndexOf(":");
    if (colonIndex !== -1 && colonIndex < title.length - 1) {
      const courseName = title.substring(colonIndex + 1).trim();
      if (courseName.length > 3) {
        return courseName;
      }
    }
    return void 0;
  }
  async function extractMoodleQuestionData(questionEl) {
    const courseName = extractMoodleCourseName();
    const isTrueFalse = questionEl.classList.contains("truefalse");
    const qnoEl = questionEl.querySelector(".qno");
    const questionNumber = qnoEl ? parseInt(qnoEl.textContent?.trim() || "1") : 1;
    const qtextEl = questionEl.querySelector(".qtext");
    let questionText = "";
    const questionImages = [];
    if (qtextEl) {
      questionText = qtextEl.textContent?.trim() || "";
      const imgs = qtextEl.querySelectorAll("img:not(.questionflagimage)");
      for (const img of imgs) {
        if (img.width < 50 || img.height < 50)
          continue;
        if (isPublicImageUrl(img.src)) {
          questionImages.push({
            url: img.src,
            mediaType: "image/jpeg",
            alt: img.alt || "Question image",
            location: "question"
          });
        } else {
          const base64Data = await imageToBase64(img);
          if (base64Data) {
            questionImages.push({
              base64: base64Data.base64,
              mediaType: base64Data.mediaType,
              alt: img.alt || "Question image",
              location: "question"
            });
          }
        }
      }
    }
    const answerContainer = questionEl.querySelector(".answer");
    const options = [];
    if (answerContainer) {
      const optionDivs = answerContainer.querySelectorAll(
        ":scope > div.r0, :scope > div.r1"
      );
      for (const optDiv of optionDivs) {
        const letterEl = optDiv.querySelector(".answernumber");
        let letter = "";
        if (letterEl) {
          letter = (letterEl.textContent?.trim() || "").replace(".", "").toUpperCase();
        }
        const textContainer = optDiv.querySelector(
          ".flex-fill, [data-region='answer-label'] > div:not(.answernumber)"
        );
        let optionText = "";
        let optionImage = null;
        if (textContainer) {
          optionText = textContainer.textContent?.trim() || "";
          const optImg = textContainer.querySelector(
            "img:not(.questionflagimage)"
          );
          if (optImg && optImg.width >= 50 && optImg.height >= 50) {
            if (isPublicImageUrl(optImg.src)) {
              optionImage = {
                url: optImg.src,
                mediaType: "image/jpeg",
                alt: optImg.alt || `Option ${letter} image`
              };
            } else {
              const base64Data = await imageToBase64(optImg);
              if (base64Data) {
                optionImage = {
                  base64: base64Data.base64,
                  mediaType: base64Data.mediaType,
                  alt: optImg.alt || `Option ${letter} image`
                };
              }
            }
          }
        } else {
          const labelDiv = optDiv.querySelector("[data-region='answer-label']");
          if (labelDiv) {
            optionText = labelDiv.textContent?.trim() || "";
            if (letterEl) {
              optionText = optionText.replace(letterEl.textContent || "", "").trim();
            }
            const optImg = labelDiv.querySelector("img:not(.questionflagimage)");
            if (optImg && optImg.width >= 50 && optImg.height >= 50) {
              if (isPublicImageUrl(optImg.src)) {
                optionImage = {
                  url: optImg.src,
                  mediaType: "image/jpeg",
                  alt: optImg.alt || `Option ${letter} image`
                };
              } else {
                const base64Data = await imageToBase64(optImg);
                if (base64Data) {
                  optionImage = {
                    base64: base64Data.base64,
                    mediaType: base64Data.mediaType,
                    alt: optImg.alt || `Option ${letter} image`
                  };
                }
              }
            }
          }
        }
        if (!optionText) {
          const labelEl = optDiv.querySelector("label");
          if (labelEl) {
            optionText = labelEl.textContent?.trim() || "";
          }
        }
        if (!optionText) {
          optionText = optDiv.textContent?.trim() || "";
          if (letterEl && letterEl.textContent) {
            optionText = optionText.replace(letterEl.textContent, "").trim();
          }
        }
        if (isTrueFalse) {
          const normalized = optionText.normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase();
          if (/(^|\b)(true|verdadero)(\b|$)/i.test(normalized)) {
            letter = "V";
          } else if (/(^|\b)(false|falso)(\b|$)/i.test(normalized)) {
            letter = "F";
          }
        }
        if (!letter) {
          letter = String.fromCharCode(65 + options.length);
        }
        if (optionText || optionImage) {
          options.push({
            letter,
            text: optionText || `[Image: ${optionImage?.alt || "option"}]`,
            image: optionImage
          });
        }
      }
    }
    const hasContent = questionText || questionImages.length > 0;
    if (!hasContent || options.length < 2) {
      return null;
    }
    return {
      id: `moodle-q-${questionNumber}`,
      type: isTrueFalse ? "true-false" : "multiple-choice",
      text: questionText,
      options,
      element: questionEl,
      questionNumber,
      platform: "moodle",
      images: questionImages,
      // Array of images from question text
      confidence: 95,
      courseName
      // Academic course name for context
    };
  }
  async function extractMoodleMatchQuestion(questionEl) {
    const courseName = extractMoodleCourseName();
    const qnoEl = questionEl.querySelector(".qno");
    const questionNumber = qnoEl ? parseInt(qnoEl.textContent?.trim() || "1") : 1;
    const qtextEl = questionEl.querySelector(".qtext");
    const questionText = qtextEl?.textContent?.trim() || "";
    if (!questionText)
      return null;
    const rows = questionEl.querySelectorAll("table.answer tbody tr");
    if (rows.length === 0)
      return null;
    const categories = [];
    let matchingOptions = null;
    for (const [rowIndex, row] of Array.from(rows).entries()) {
      const textCell = row.querySelector("td.text");
      const conceptText = textCell?.textContent?.trim() || "";
      if (conceptText) {
        categories.push({
          letter: String.fromCharCode(65 + rowIndex),
          // A, B, C...
          text: conceptText
        });
      }
      if (!matchingOptions) {
        const selectEl = row.querySelector("td.control select");
        if (selectEl) {
          matchingOptions = [];
          for (const opt of Array.from(selectEl.querySelectorAll("option"))) {
            const value = parseInt(opt.getAttribute("value") || "0");
            if (value > 0) {
              matchingOptions.push({
                index: value,
                text: opt.textContent?.trim() || ""
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
      matchingOptions
      // matchingStyle intentionally omitted → falls back to "drag-drop" in api.ts
      // which uses the A-1, B-3, C-2 answer format expected for this question type
    };
  }
  async function extractMoodleShortAnswerQuestion(questionEl, type) {
    const courseName = extractMoodleCourseName();
    const qnoEl = questionEl.querySelector(".qno");
    const questionNumber = qnoEl ? parseInt(qnoEl.textContent?.trim() || "1") : 1;
    const qtextEl = questionEl.querySelector(".qtext");
    const questionText = qtextEl?.textContent?.trim() || "";
    if (!questionText)
      return null;
    return {
      id: `moodle-q-${questionNumber}`,
      type,
      text: questionText,
      options: [],
      element: questionEl,
      questionNumber,
      platform: "moodle",
      confidence: 95,
      courseName
    };
  }
  async function extractMoodleSelectMissingWords(questionEl) {
    const courseName = extractMoodleCourseName();
    const qnoEl = questionEl.querySelector(".qno");
    const questionNumber = qnoEl ? parseInt(qnoEl.textContent?.trim() || "1") : 1;
    const qtextEl = questionEl.querySelector(".qtext");
    if (!qtextEl)
      return null;
    const liveSelects = Array.from(qtextEl.querySelectorAll("select"));
    if (liveSelects.length === 0)
      return null;
    const cloned = qtextEl.cloneNode(true);
    const clonedSelects = Array.from(cloned.querySelectorAll("select"));
    const selectGaps = [];
    const selectChoices = {};
    const choiceFingerprints = /* @__PURE__ */ new Map();
    let groupCounter = 0;
    for (let i = 0; i < liveSelects.length; i++) {
      const liveSelect = liveSelects[i];
      const clonedSelect = clonedSelects[i];
      const gapIndex = i + 1;
      const choices = [];
      for (const opt of Array.from(liveSelect.querySelectorAll("option"))) {
        const value = parseInt(opt.getAttribute("value") || "0");
        if (value > 0) {
          choices.push(opt.textContent?.trim() || "");
        }
      }
      const fingerprint = choices.join("|");
      let groupId;
      if (choiceFingerprints.has(fingerprint)) {
        groupId = choiceFingerprints.get(fingerprint);
      } else {
        groupId = String.fromCharCode(65 + groupCounter);
        groupCounter++;
        choiceFingerprints.set(fingerprint, groupId);
        selectChoices[groupId] = choices;
      }
      clonedSelect.replaceWith(`[[${gapIndex}]]`);
      selectGaps.push({ index: gapIndex, groupId, leftContext: "", rightContext: "" });
    }
    const fullText = (cloned.textContent || "").replace(/\s+/g, " ").trim();
    for (const gap of selectGaps) {
      const marker = `[[${gap.index}]]`;
      const pos = fullText.indexOf(marker);
      if (pos !== -1) {
        gap.leftContext = fullText.substring(0, pos).slice(-60).trim();
        gap.rightContext = fullText.substring(pos + marker.length, pos + marker.length + 60).trim();
      }
    }
    if (!fullText || selectGaps.length === 0)
      return null;
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
      selectChoices
    };
  }
  function buildQuestionMap() {
    const questionMap = {};
    const viewportCenterY = window.innerHeight / 2;
    const viewportCenterX = window.innerWidth / 2;
    let syntheticQuestionNum = 1e6;
    const mcqViews = querySelectorAllDeep("mcq-view");
    const matchingViews = querySelectorAllDeep("object-matching-view");
    const dropdownMatchingViews = querySelectorAllDeep("matching-view");
    for (const mcqView of mcqViews) {
      const rect = mcqView.getBoundingClientRect();
      const hasSize = rect.width > 0 && rect.height > 0;
      if (!hasSize)
        continue;
      const questionNum = findQuestionNumberForElement(mcqView);
      if (questionNum === null)
        continue;
      const centerDist = Math.sqrt(
        Math.pow(rect.left + rect.width / 2 - viewportCenterX, 2) + Math.pow(rect.top + rect.height / 2 - viewportCenterY, 2)
      );
      const score = 1e4 - centerDist;
      const question = extractQuestionFromMcqView(mcqView, questionNum);
      if (!question || question.options.length < 2)
        continue;
      if (!questionMap[questionNum] || questionMap[questionNum].score < score) {
        questionMap[questionNum] = {
          type: "mcq",
          question,
          score,
          element: mcqView
        };
      }
    }
    for (const matchingView of matchingViews) {
      const rect = matchingView.getBoundingClientRect();
      const hasSize = rect.width > 0 && rect.height > 0;
      if (!hasSize)
        continue;
      const detectedQuestionNum = findQuestionNumberForElement(matchingView);
      const questionNum = detectedQuestionNum !== null ? detectedQuestionNum : syntheticQuestionNum++;
      const centerDist = Math.sqrt(
        Math.pow(rect.left + rect.width / 2 - viewportCenterX, 2) + Math.pow(rect.top + rect.height / 2 - viewportCenterY, 2)
      );
      const score = 1e4 - centerDist;
      const question = extractMatchingQuestionFromView(matchingView, questionNum);
      if (!question)
        continue;
      if (!questionMap[questionNum] || questionMap[questionNum].score < score) {
        questionMap[questionNum] = {
          type: "matching",
          question,
          score,
          element: matchingView
        };
      }
    }
    for (const matchingView of dropdownMatchingViews) {
      const rect = matchingView.getBoundingClientRect();
      const hasSize = rect.width > 0 && rect.height > 0;
      if (!hasSize)
        continue;
      const detectedQuestionNum = findQuestionNumberForElement(matchingView);
      const questionNum = detectedQuestionNum !== null ? detectedQuestionNum : syntheticQuestionNum++;
      const centerDist = Math.sqrt(
        Math.pow(rect.left + rect.width / 2 - viewportCenterX, 2) + Math.pow(rect.top + rect.height / 2 - viewportCenterY, 2)
      );
      const score = 1e4 - centerDist;
      const question = extractDropdownMatchingFromView(matchingView, questionNum);
      if (!question)
        continue;
      if (!questionMap[questionNum] || questionMap[questionNum].score < score) {
        questionMap[questionNum] = {
          type: "matching",
          question,
          score,
          element: matchingView
        };
      }
    }
    return questionMap;
  }
  function findQuestionNumberForElement(element) {
    let parent = element.parentElement || element.getRootNode()?.host;
    let depth = 0;
    const maxDepth = 15;
    while (parent && depth < maxDepth) {
      const siblings = parent.children;
      for (const sibling of siblings) {
        if (sibling === element)
          continue;
        let text = sibling.textContent || "";
        const match = text.match(/pregunta\s*(\d+)/i);
        if (match) {
          return parseInt(match[1]);
        }
        if (sibling.shadowRoot) {
          const shadowText = sibling.shadowRoot.textContent || "";
          const shadowMatch = shadowText.match(/pregunta\s*(\d+)/i);
          if (shadowMatch) {
            return parseInt(shadowMatch[1]);
          }
        }
      }
      const parentText = getDirectTextContent(parent);
      const parentMatch = parentText.match(/pregunta\s*(\d+)/i);
      if (parentMatch) {
        return parseInt(parentMatch[1]);
      }
      if (parent.shadowRoot) {
        const shadowText = parent.shadowRoot.textContent || "";
        const shadowMatch = shadowText.match(/pregunta\s*(\d+)/i);
        if (shadowMatch) {
          return parseInt(shadowMatch[1]);
        }
      }
      if (parent.parentElement) {
        parent = parent.parentElement;
      } else if (parent.getRootNode()?.host) {
        parent = parent.getRootNode().host;
      } else {
        break;
      }
      depth++;
    }
    if (element.shadowRoot) {
      const shadowText = element.shadowRoot.textContent || "";
      const match = shadowText.match(/pregunta\s*(\d+)/i);
      if (match) {
        return parseInt(match[1]);
      }
    }
    const rect = element.getBoundingClientRect();
    if (rect.width === 0 || rect.height === 0)
      return null;
    const preguntaElements = [];
    function collectPreguntaElements(root) {
      const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
      let node;
      while (node = walker.nextNode()) {
        if (node.textContent && /pregunta\s*\d+/i.test(node.textContent)) {
          const match = node.textContent.match(/pregunta\s*(\d+)/i);
          if (match && node.parentElement) {
            const preguntaRect = node.parentElement.getBoundingClientRect();
            if (preguntaRect.width > 0 && preguntaRect.height > 0) {
              preguntaElements.push({
                num: parseInt(match[1]),
                rect: preguntaRect,
                element: node.parentElement
              });
            }
          }
        }
      }
      const elements = root.querySelectorAll("*");
      elements.forEach((el) => {
        if (el.shadowRoot) {
          collectPreguntaElements(el.shadowRoot);
        }
      });
    }
    collectPreguntaElements(document);
    let bestMatch = null;
    let bestDistance = Infinity;
    for (const pregunta of preguntaElements) {
      const verticalDist = rect.top - pregunta.rect.bottom;
      const horizontalDist = Math.abs(
        rect.left + rect.width / 2 - (pregunta.rect.left + pregunta.rect.width / 2)
      );
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
  function extractMatchingQuestionFromView(matchingView, questionNumber) {
    const shadowRoot = matchingView.shadowRoot;
    if (!shadowRoot)
      return null;
    let questionText = "";
    const bodyEls = querySelectorAllDeep(
      ".component__body-inner, .objectMatching__body-inner",
      shadowRoot
    );
    if (bodyEls.length > 0) {
      questionText = bodyEls[0].textContent?.trim() || "";
    }
    const dropdownViews = querySelectorAllDeep(
      "object-matching-dropdown-view",
      shadowRoot
    );
    if (dropdownViews.length > 0) {
      const categories2 = [];
      const availableOptions = /* @__PURE__ */ new Set();
      dropdownViews.forEach((dropdownView, index) => {
        const dropdownShadow = dropdownView.shadowRoot;
        if (!dropdownShadow)
          return;
        const letterEl = dropdownShadow.querySelector(".category-item-number");
        const titleEl = dropdownShadow.querySelector(
          ".matching__item-title_inner"
        );
        if (titleEl) {
          const letter = letterEl ? letterEl.textContent?.trim() || String.fromCharCode(65 + index) : String.fromCharCode(65 + index);
          const text = titleEl.textContent?.trim() || "";
          if (text && !text.includes("objetivo dejado en blanco")) {
            categories2.push({
              letter,
              text
            });
          }
        }
        const dropdownBtn = dropdownShadow.querySelector(".dropdown__btn");
        if (dropdownBtn) {
          const selectedText = dropdownShadow.querySelector(".dropdown__inner")?.textContent?.trim();
          if (selectedText && !selectedText.includes("s\xE9lectionner") && !selectedText.includes("Seleccione") && !selectedText.includes("Select")) {
            availableOptions.add(selectedText);
          }
        }
        const listItems = dropdownShadow.querySelectorAll(
          ".dropdown__item-inner"
        );
        listItems.forEach((item) => {
          const optText = item.textContent?.trim();
          if (optText && !optText.includes("s\xE9lectionner") && !optText.includes("Seleccione") && !optText.includes("Select")) {
            availableOptions.add(optText);
          }
        });
      });
      const matchingOptions2 = Array.from(availableOptions).map((opt, idx) => ({
        index: idx + 1,
        text: opt
      }));
      if (categories2.length >= 2) {
        return {
          id: `matching-${questionNumber}`,
          type: "matching",
          matchingStyle: "object-dropdown",
          // Flag for object-matching with dropdowns
          questionNumber,
          text: questionText || `Pregunta ${questionNumber || "?"}`,
          categories: categories2,
          matchingOptions: matchingOptions2.length > 0 ? matchingOptions2 : [{ index: 1, text: "(options in dropdown)" }],
          element: matchingView,
          options: [],
          // Required by interface
          confidence: 95
        };
      }
    }
    const categories = [];
    const categoryItems = querySelectorAllDeep(
      ".objectMatching-category-item",
      shadowRoot
    );
    categoryItems.forEach((item, index) => {
      const textEl = item.querySelector(".category-item-text");
      const letterEl = item.querySelector(".category-item-number");
      if (textEl) {
        const text = textEl.textContent?.trim() || "";
        const letter = letterEl ? letterEl.textContent?.trim() || String.fromCharCode(65 + index) : String.fromCharCode(65 + index);
        categories.push({
          letter,
          text
        });
      }
    });
    const matchingOptions = [];
    const optionItems = querySelectorAllDeep(
      ".objectMatching-option-item",
      shadowRoot
    );
    optionItems.forEach((item, index) => {
      const textEl = item.querySelector(".category-item-text");
      if (textEl) {
        const text = textEl.textContent?.trim() || "";
        matchingOptions.push({
          index: index + 1,
          text
        });
      }
    });
    if (categories.length >= 2 && matchingOptions.length >= 2) {
      return {
        id: `matching-${questionNumber}`,
        type: "matching",
        questionNumber,
        text: questionText || `Pregunta ${questionNumber || "?"}`,
        categories,
        matchingOptions,
        element: matchingView,
        options: [],
        // Required by interface
        confidence: 95
      };
    }
    return null;
  }
  function extractDropdownMatchingFromView(matchingView, questionNumber) {
    const shadowRoot = matchingView.shadowRoot;
    if (!shadowRoot)
      return null;
    let questionText = "";
    const bodyEls = querySelectorAllDeep(
      ".component__body-inner, .matching__body-inner",
      shadowRoot
    );
    if (bodyEls.length > 0) {
      questionText = bodyEls[0].textContent?.trim() || "";
    }
    const descriptions = [];
    const availableOptions = /* @__PURE__ */ new Set();
    const dropdownViews = querySelectorAllDeep(
      "matching-dropdown-view",
      shadowRoot
    );
    dropdownViews.forEach((dropdownView, index) => {
      const dropdownShadow = dropdownView.shadowRoot;
      if (!dropdownShadow)
        return;
      const titleEl = dropdownShadow.querySelector(".matching__item-title_inner");
      if (titleEl) {
        const descText = titleEl.textContent?.trim() || "";
        descriptions.push({
          index: index + 1,
          text: descText
        });
      }
      const optionItems = dropdownShadow.querySelectorAll(
        ".dropdown__item-inner"
      );
      optionItems.forEach((optEl) => {
        const optText = optEl.textContent?.trim();
        if (optText && optText !== "Seleccione una opci\xF3n") {
          availableOptions.add(optText);
        }
      });
    });
    const matchingOptionsAsCategories = Array.from(availableOptions).map((opt, idx) => ({
      letter: String.fromCharCode(65 + idx),
      // A, B, C...
      text: opt
    }));
    if (descriptions.length >= 2 && matchingOptionsAsCategories.length >= 1) {
      return {
        id: `matching-dropdown-${questionNumber}`,
        type: "matching",
        matchingStyle: "dropdown",
        // Flag to indicate dropdown style
        questionNumber,
        text: questionText || `Pregunta ${questionNumber || "?"}`,
        categories: matchingOptionsAsCategories,
        // The answer options (TCP, UDP)
        matchingOptions: descriptions,
        // The descriptions to match
        element: matchingView,
        options: [],
        // Required by interface
        confidence: 95
      };
    }
    return null;
  }
  function extractQuestionFromMcqView(mcqView, questionNumber) {
    const shadowRoot = mcqView.shadowRoot;
    if (!shadowRoot)
      return null;
    let questionText = "";
    const questionBodyEls = querySelectorAllDeep(".mcq__body-inner", shadowRoot);
    if (questionBodyEls.length > 0) {
      questionText = questionBodyEls[0].textContent?.trim() || "";
    }
    let accessibilityContext = "";
    accessibilityContext = extractAccessibilityDescriptions(shadowRoot);
    if (!accessibilityContext) {
      let parent = mcqView.parentElement;
      let depth = 0;
      while (parent && depth < 10) {
        accessibilityContext = extractAccessibilityDescriptions(parent);
        if (accessibilityContext)
          break;
        if (parent.shadowRoot) {
          accessibilityContext = extractAccessibilityDescriptions(
            parent.shadowRoot
          );
          if (accessibilityContext)
            break;
        }
        if (parent.tagName && (parent.tagName.toLowerCase().includes("block-view") || parent.tagName.toLowerCase().includes("tabs-view") || parent.classList?.contains("component__container"))) {
          const allElements = parent.querySelectorAll("*");
          for (const el of allElements) {
            if (el.shadowRoot) {
              accessibilityContext = extractAccessibilityDescriptions(
                el.shadowRoot
              );
              if (accessibilityContext)
                break;
            }
          }
          if (accessibilityContext)
            break;
        }
        parent = parent.parentElement;
        depth++;
      }
    }
    if (!accessibilityContext) {
      log("[Study Assist] Searching entire document for diagram descriptions...");
      accessibilityContext = extractAccessibilityDescriptions(document.body);
    }
    if (accessibilityContext) {
      log("[Study Assist] Adding diagram description to question context");
      questionText = questionText + "\n\n[DIAGRAM DESCRIPTION]\n" + accessibilityContext;
    }
    const optionEls = querySelectorAllDeep(".mcq__item-text-inner", shadowRoot);
    const options = [];
    optionEls.forEach((optEl, optIndex) => {
      const optText = optEl.textContent?.trim() || "";
      if (optText && optText.length > 0) {
        options.push({
          letter: String.fromCharCode(65 + optIndex),
          text: optText
        });
      }
    });
    if (options.length < 2)
      return null;
    return {
      id: `mcq-${questionNumber}`,
      type: "multiple-choice",
      questionNumber,
      text: questionText || `Pregunta ${questionNumber || "?"}`,
      options,
      element: mcqView,
      confidence: 95
    };
  }

  // src/content/modules/ui.ts
  function showReloadPrompt() {
    if (window.self !== window.top)
      return;
    const existing = document.getElementById("study-assist-reload-prompt");
    if (existing)
      existing.remove();
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
      <span>\u{1F4DA} Study Assist activado. Recarga para habilitarlo.</span>
      <button id="study-assist-reload-btn" style="
        background: #4285f4;
        color: white;
        border: none;
        padding: 8px 16px;
        border-radius: 4px;
        cursor: pointer;
        font-weight: 600;
        font-size: 13px;
      ">Recargar</button>
      <button id="study-assist-dismiss-btn" style="
        background: transparent;
        color: #999;
        border: none;
        padding: 4px 8px;
        cursor: pointer;
        font-size: 16px;
      ">\u2715</button>
    </div>
    <style>
      @keyframes slideIn {
        from { transform: translateX(100%); opacity: 0; }
        to { transform: translateX(0); opacity: 1; }
      }
    </style>
  `;
    document.body.appendChild(prompt);
    const reloadBtn = document.getElementById("study-assist-reload-btn");
    if (reloadBtn) {
      reloadBtn.onclick = () => {
        window.location.reload();
      };
    }
    const dismissBtn = document.getElementById("study-assist-dismiss-btn");
    if (dismissBtn) {
      dismissBtn.onclick = () => {
        prompt.remove();
      };
    }
    setTimeout(() => {
      if (document.getElementById("study-assist-reload-prompt")) {
        prompt.remove();
      }
    }, 1e4);
  }
  function createOverlayContainer(callbacks) {
    const { frameHasQuizContent: frameHasQuizContent2, waitForQuizContent: waitForQuizContent2, handleQuickClick: handleQuickClick2 } = callbacks;
    const existing = document.getElementById("study-assist-overlay");
    if (existing)
      existing.remove();
    const existingQuick = document.getElementById("study-assist-quick-container");
    if (existingQuick)
      existingQuick.remove();
    const existingQuickBtn = document.getElementById("study-assist-quick");
    if (existingQuickBtn)
      existingQuickBtn.remove();
    if (state.settings.quickMode) {
      if (frameHasQuizContent2 && frameHasQuizContent2()) {
        createQuickButton({ handleQuickClick: handleQuickClick2 });
      } else if (waitForQuizContent2) {
        waitForQuizContent2((hasContent) => {
          if (hasContent) {
            createQuickButton({ handleQuickClick: handleQuickClick2 });
          }
        });
      }
    } else {
      createFullOverlay(callbacks.showQuestionsSummary);
    }
  }
  function createFullOverlay(refreshCurrentQuestionCallback) {
    const overlay = document.createElement("div");
    overlay.id = "study-assist-overlay";
    overlay.innerHTML = `
    <div class="study-assist-header">
      <span class="study-assist-logo">SA</span>
      <div class="study-assist-controls">
        <button class="study-assist-refresh" title="Volver a detectar pregunta">\u21BB</button>
        <button class="study-assist-minimize" title="Minimizar">\u2212</button>
        <button class="study-assist-close" title="Cerrar">\xD7</button>
      </div>
    </div>
    <div class="study-assist-content">
      <div class="study-assist-loading" style="display: none;">
        <div class="study-assist-spinner"></div>
        <span>Analizando...</span>
      </div>
      <div class="study-assist-results"></div>
    </div>
  `;
    document.body.appendChild(overlay);
    const closeBtn = overlay.querySelector(".study-assist-close");
    if (closeBtn) {
      closeBtn.addEventListener("click", hideOverlay);
    }
    const minimizeBtn = overlay.querySelector(".study-assist-minimize");
    if (minimizeBtn) {
      minimizeBtn.addEventListener("click", toggleMinimize);
    }
    if (refreshCurrentQuestionCallback) {
      const refreshBtn = overlay.querySelector(".study-assist-refresh");
      if (refreshBtn) {
        refreshBtn.addEventListener("click", refreshCurrentQuestionCallback);
      }
    }
    makeDraggable(overlay);
  }
  function showOverlay() {
    const overlay = document.getElementById("study-assist-overlay");
    if (overlay) {
      overlay.classList.add("study-assist-visible");
      state.overlayVisible = true;
    }
  }
  function hideOverlay() {
    const overlay = document.getElementById("study-assist-overlay");
    if (overlay) {
      overlay.classList.remove("study-assist-visible");
      state.overlayVisible = false;
    }
  }
  function toggleMinimize() {
    const overlay = document.getElementById("study-assist-overlay");
    if (overlay) {
      overlay.classList.toggle("study-assist-minimized");
    }
  }
  function makeDraggable(element) {
    const header = element.querySelector(".study-assist-header");
    if (!header)
      return;
    let isDragging = false;
    let currentX;
    let currentY;
    let initialX;
    let initialY;
    header.addEventListener("mousedown", (e) => {
      const target = e.target;
      if (target.tagName === "BUTTON")
        return;
      isDragging = true;
      initialX = e.clientX - (element.offsetLeft || 0);
      initialY = e.clientY - (element.offsetTop || 0);
    });
    document.addEventListener("mousemove", (e) => {
      if (!isDragging)
        return;
      e.preventDefault();
      currentX = e.clientX - initialX;
      currentY = e.clientY - initialY;
      element.style.left = `${currentX}px`;
      element.style.top = `${currentY}px`;
      element.style.right = "auto";
      element.style.bottom = "auto";
    });
    document.addEventListener("mouseup", () => {
      isDragging = false;
    });
  }
  function toggleSAButtonVisibility() {
    log("[Study Assist] ALT+Q pressed - toggling SA button visibility");
    const container = document.getElementById("study-assist-quick-container");
    if (container) {
      const isHidden = container.style.display === "none";
      container.style.display = isHidden ? "" : "none";
      log(`[Study Assist] SA button ${isHidden ? "shown" : "hidden"}`);
    } else {
      log("[Study Assist] SA button container not found");
    }
  }
  function resetQuickAnswer() {
    const quickBtn = document.getElementById("study-assist-quick");
    const container = document.getElementById("study-assist-quick-container");
    if (quickBtn) {
      quickBtn.innerHTML = `<span>SA</span>`;
      quickBtn.classList.remove(
        "has-answer",
        "matching-answer",
        "multi-answer",
        "multi-answer-large"
      );
    }
    if (container) {
      container.classList.remove("matching-mode");
    }
    state.lastAnsweredQuestionNum = null;
    state.hasValidAnswer = false;
  }
  function createQuickButton(callbacks) {
    const { handleQuickClick: handleQuickClick2 } = callbacks;
    const container = document.createElement("div");
    container.id = "study-assist-quick-container";
    const pos = state.settings.buttonPosition || "bottom-right";
    container.setAttribute("data-position", pos);
    const quickBtn = document.createElement("div");
    quickBtn.id = "study-assist-quick";
    quickBtn.innerHTML = `<span>SA</span>`;
    quickBtn.title = "Clic para obtener respuesta | SHIFT: Analizar | ALT+W: Re-detectar | ALT+Q: Ocultar | ALT+X: Cancelar";
    container.appendChild(quickBtn);
    document.body.appendChild(container);
    if (handleQuickClick2) {
      quickBtn.addEventListener("click", handleQuickClick2);
    }
    injectWebexToggleWithCtrl();
  }
  function injectWebexToggleWithCtrl() {
    const styleId = "study-assist-webex-hide-style";
    const isMainFrame = window.self === window.top;
    if (document.getElementById(styleId))
      return;
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
    const existingWebexBtn = document.querySelector(
      "#webexFabActionBtn, .fabActionBtn--WND8X"
    );
    if (existingWebexBtn) {
      applyWebexIconSize(existingWebexBtn);
    }
    const webexObserver = new MutationObserver((mutations) => {
      mutations.forEach((mutation) => {
        mutation.addedNodes.forEach((node) => {
          if (node.nodeType === Node.ELEMENT_NODE) {
            const element = node;
            if (element.id === "webexFabActionBtn" || element.classList.contains("fabActionBtn--WND8X")) {
              applyWebexIconSize(element);
            }
            const webexBtn = element.querySelector?.(
              "#webexFabActionBtn, .fabActionBtn--WND8X"
            );
            if (webexBtn) {
              applyWebexIconSize(webexBtn);
            }
          }
        });
      });
    });
    webexObserver.observe(document.body, {
      childList: true,
      subtree: true
    });
    function applyWebexIconSize(webexBtn) {
      if (!webexBtn)
        return;
      const webexImg = webexBtn.querySelector(
        ".fabActionBtnIconContainer--RPrZH img"
      );
      if (webexImg) {
        webexImg.style.setProperty("width", "55px", "important");
        webexImg.style.setProperty("height", "55px", "important");
      }
    }
    function hideWebex() {
      const webexBtn = document.querySelector(
        "#webexFabActionBtn, .fabActionBtn--WND8X"
      );
      if (webexBtn) {
        webexBtn.classList.add("webex-hidden-by-sa");
      }
    }
    function showWebex() {
      const webexBtn = document.querySelector(
        "#webexFabActionBtn, .fabActionBtn--WND8X"
      );
      if (webexBtn) {
        webexBtn.classList.remove("webex-hidden-by-sa");
      }
    }
    if (isMainFrame) {
      window.addEventListener("message", (e) => {
        if (e.data === "study-assist-hide-webex") {
          hideWebex();
        } else if (e.data === "study-assist-show-webex") {
          showWebex();
        }
      });
    }
    document.addEventListener("keydown", (e) => {
      if (e.key === "Control") {
        hideWebex();
        if (!isMainFrame) {
          try {
            window.parent.postMessage("study-assist-hide-webex", "*");
          } catch (err) {
          }
        }
      }
    });
    document.addEventListener("keyup", (e) => {
      if (e.key === "Control") {
        showWebex();
        if (!isMainFrame) {
          try {
            window.parent.postMessage("study-assist-show-webex", "*");
          } catch (err) {
          }
        }
      }
    });
  }
  function highlightDetectedQuestions(analyzeQuestionCallback) {
    clearAllHighlights();
    state.detectedQuestions.forEach((question, index) => {
      const element = question.element;
      element.classList.add("study-assist-question-highlight");
      element.dataset.studyAssistId = question.id;
      const badge = document.createElement("div");
      badge.className = "study-assist-question-badge";
      badge.textContent = String(index + 1);
      badge.title = `Pregunta ${index + 1} - Clic para analizar`;
      badge.addEventListener("click", (e) => {
        e.stopPropagation();
        if (analyzeQuestionCallback) {
          analyzeQuestionCallback(question);
        }
      });
      element.style.position = element.style.position || "relative";
      element.appendChild(badge);
    });
  }
  function clearAllHighlights() {
    document.querySelectorAll(".study-assist-question-highlight").forEach((el) => {
      el.classList.remove("study-assist-question-highlight");
      delete el.dataset.studyAssistId;
    });
    document.querySelectorAll(".study-assist-question-badge").forEach((el) => {
      el.remove();
    });
  }
  function displaySingleQuestion(question, analyzeQuestionCallback) {
    const overlay = document.getElementById("study-assist-overlay");
    if (!overlay)
      return;
    const results = overlay.querySelector(".study-assist-results");
    if (!results)
      return;
    let contentHtml;
    if (question.type === "matching") {
      const categoriesList = (question.categories || []).map(
        (cat) => `<div class="study-assist-matching-item"><strong>${cat.letter}.</strong> ${escapeHtml(cat.text)}</div>`
      ).join("");
      const optionsList = (question.matchingOptions || []).map(
        (opt) => `<div class="study-assist-matching-item"><strong>${opt.index}.</strong> ${escapeHtml(opt.text)}</div>`
      ).join("");
      contentHtml = `
      <div class="study-assist-single-question">
        ${question.questionNumber ? `<div class="study-assist-question-label">Pregunta ${question.questionNumber}</div>` : ""}
        <div class="study-assist-question-box">
          <p>${escapeHtml(question.text)}</p>
          <div class="study-assist-matching-container">
            <div class="study-assist-matching-section">
              <h5>Categor\xEDas:</h5>
              <div class="study-assist-matching-items">
                ${categoriesList}
              </div>
            </div>
            <div class="study-assist-matching-section">
              <h5>Opciones:</h5>
              <div class="study-assist-matching-items">
                ${optionsList}
              </div>
            </div>
          </div>
        </div>
        <button class="study-assist-analyze-btn-large">Analizar Pregunta</button>
      </div>
    `;
    } else {
      const optionsList = (question.options || []).map(
        (opt) => `<div class="study-assist-option-item"><strong>${opt.letter}.</strong> ${escapeHtml(opt.text)}</div>`
      ).join("");
      contentHtml = `
      <div class="study-assist-single-question">
        ${question.questionNumber ? `<div class="study-assist-question-label">Pregunta ${question.questionNumber}</div>` : ""}
        <div class="study-assist-question-box">
          <p>${escapeHtml(question.text)}</p>
          <div class="study-assist-options">
            ${optionsList}
          </div>
        </div>
        <button class="study-assist-analyze-btn-large">Analizar Pregunta</button>
      </div>
    `;
    }
    results.innerHTML = contentHtml;
    state.currentVisibleQuestion = question;
    const analyzeBtn = results.querySelector(".study-assist-analyze-btn-large");
    if (analyzeBtn) {
      analyzeBtn.addEventListener("click", () => {
        if (analyzeQuestionCallback) {
          analyzeQuestionCallback(question);
        }
      });
    }
    showOverlay();
  }
  async function showQuestionsSummary(detectVisibleQuestionCallback, analyzeQuestionCallback) {
    const overlay = document.getElementById("study-assist-overlay");
    if (!overlay)
      return;
    const currentQuestion = await detectVisibleQuestionCallback();
    if (currentQuestion) {
      displaySingleQuestion(currentQuestion, analyzeQuestionCallback);
      return;
    }
    let fallbackQuestion = null;
    let bestScore = -1;
    state.detectedQuestions.forEach((q) => {
      const score = getVisibilityScore(q.element);
      if (score > bestScore) {
        bestScore = score;
        fallbackQuestion = q;
      }
    });
    if (!fallbackQuestion && state.detectedQuestions.length > 0) {
      fallbackQuestion = state.detectedQuestions[0];
    }
    if (fallbackQuestion) {
      displaySingleQuestion(fallbackQuestion, analyzeQuestionCallback);
      return;
    }
    showNoQuestionsFound();
  }
  function showNoQuestionsFound() {
    const overlay = document.getElementById("study-assist-overlay");
    if (!overlay || !state.overlayVisible)
      return;
    const results = overlay.querySelector(".study-assist-results");
    if (!results)
      return;
    results.innerHTML = `
    <div class="study-assist-empty">
      <p>No se detect\xF3 una pregunta. Haz clic en \u21BB para reintentar.</p>
    </div>
  `;
  }
  function showLoading() {
    const overlay = document.getElementById("study-assist-overlay");
    if (!overlay)
      return;
    const loading = overlay.querySelector(".study-assist-loading");
    if (loading) {
      loading.style.display = "flex";
    }
  }
  function hideLoading() {
    const overlay = document.getElementById("study-assist-overlay");
    if (!overlay)
      return;
    const loading = overlay.querySelector(".study-assist-loading");
    if (loading) {
      loading.style.display = "none";
    }
  }
  function displayAnalysisResult(result, question, showQuestionsSummaryCallback) {
    const overlay = document.getElementById("study-assist-overlay");
    if (!overlay)
      return;
    const results = overlay.querySelector(".study-assist-results");
    if (!results)
      return;
    results.innerHTML = `
    <div class="study-assist-analysis">
      <button class="study-assist-back-btn">\u2190 Volver a Preguntas</button>
      
      <div class="study-assist-question-box">
        <h4>\u{1F4DD} Pregunta</h4>
        <p>${escapeHtml(truncateText(question.text, 300))}</p>
        ${question.options && question.options.length > 0 ? `
          <div class="study-assist-options">
            ${question.options.map(
      (o) => `
              <div class="study-assist-option">
                <span class="study-assist-option-letter">${o.letter}</span>
                <span>${escapeHtml(o.text)}</span>
              </div>
            `
    ).join("")}
          </div>
        ` : ""}
      </div>
      
      <div class="study-assist-answer-box">
        <h4>\u{1F393} Learning Guide</h4>
        <div class="study-assist-answer-content">
          ${formatAnalysisResult(result)}
        </div>
      </div>
      
      <div class="study-assist-disclaimer">
          \u26A0\uFE0F Esta es una ayuda de aprendizaje generada por IA. Verifica siempre la informaci\xF3n y \xFAsala para mejorar tu comprensi\xF3n, no como sustituto del estudio.
      </div>
    </div>
  `;
    const backBtn = results.querySelector(".study-assist-back-btn");
    if (backBtn) {
      backBtn.addEventListener("click", () => {
        if (showQuestionsSummaryCallback) {
          showQuestionsSummaryCallback();
        }
      });
    }
    showOverlay();
  }
  function displayAnalysisResultStreaming(result, question, showQuestionsSummaryCallback, isInitial = false, tokenInfo) {
    const overlay = document.getElementById("study-assist-overlay");
    if (!overlay)
      return;
    const results = overlay.querySelector(".study-assist-results");
    if (!results)
      return;
    if (isInitial) {
      results.innerHTML = `
      <div class="study-assist-analysis">
        <button class="study-assist-back-btn">\u2190 Volver a Preguntas</button>
        
        <div class="study-assist-question-box">
          <h4>\u{1F4DD} Pregunta</h4>
          <p>${escapeHtml(truncateText(question.text, 300))}</p>
          ${question.options && question.options.length > 0 ? `
            <div class="study-assist-options">
              ${question.options.map(
        (o) => `
                <div class="study-assist-option">
                  <span class="study-assist-option-letter">${o.letter}</span>
                  <span>${escapeHtml(o.text)}</span>
                </div>
              `
      ).join("")}
            </div>
          ` : ""}
        </div>
        
        <div class="study-assist-answer-box">
          <h4>\u{1F393} Learning Guide</h4>
          <div class="study-assist-answer-content" id="study-assist-stream-content">
            <span class="study-assist-stream-cursor">\u258A</span>
          </div>
        </div>

        <div class="study-assist-token-info" id="study-assist-token-info" style="display:none;"></div>
        
        <div class="study-assist-disclaimer">
          \u26A0\uFE0F Esta es una ayuda de aprendizaje generada por IA. Verifica siempre la informaci\xF3n.
        </div>
      </div>
    `;
      const backBtn = results.querySelector(".study-assist-back-btn");
      if (backBtn) {
        backBtn.addEventListener("click", () => {
          if (showQuestionsSummaryCallback) {
            showQuestionsSummaryCallback();
          }
        });
      }
      showOverlay();
      return;
    }
    const streamContent = document.getElementById("study-assist-stream-content");
    if (streamContent) {
      const cursorHtml = tokenInfo ? "" : '<span class="study-assist-stream-cursor">\u258A</span>';
      streamContent.innerHTML = formatAnalysisResult(result) + cursorHtml;
      streamContent.scrollTop = streamContent.scrollHeight;
    }
    if (tokenInfo) {
      const tokenInfoEl = document.getElementById("study-assist-token-info");
      if (tokenInfoEl) {
        tokenInfoEl.style.display = "block";
        tokenInfoEl.innerHTML = `
        <span title="Tokens de entrada">\u{1F4E5} ${tokenInfo.inputTokens}</span>
        <span title="Tokens de salida">\u{1F4E4} ${tokenInfo.outputTokens}</span>
        <span title="Costo estimado">\u{1F4B0} $${tokenInfo.cost.toFixed(6)}</span>
      `;
      }
    }
  }
  function displayError(errorMessage, showQuestionsSummaryCallback) {
    const overlay = document.getElementById("study-assist-overlay");
    if (!overlay)
      return;
    const results = overlay.querySelector(".study-assist-results");
    if (!results)
      return;
    results.innerHTML = `
    <div class="study-assist-error">
      <span class="study-assist-error-icon">\u26A0\uFE0F</span>
      <h3>Error de An\xE1lisis</h3>
      <p>${escapeHtml(errorMessage)}</p>
      <button class="study-assist-retry-btn">Reintentar</button>
    </div>
  `;
    const retryBtn = results.querySelector(".study-assist-retry-btn");
    if (retryBtn) {
      retryBtn.addEventListener("click", () => {
        if (showQuestionsSummaryCallback) {
          showQuestionsSummaryCallback();
        }
      });
    }
  }

  // src/content/modules/keyboard.ts
  function setupKeyboardHandlers(callbacks) {
    injectWebexToggleWithCtrl2(callbacks);
  }
  function injectWebexToggleWithCtrl2(callbacks) {
    const {
      triggerQuickAnalysis: triggerQuickAnalysis2,
      reloadQuickMode: reloadQuickMode2,
      toggleSAButtonVisibility: toggleSAButtonVisibility2,
      cancelCurrentRequest: cancelCurrentRequest2
    } = callbacks;
    const styleId = "study-assist-webex-hide-style";
    const keyboardMarkerId = "study-assist-keyboard-injected";
    const isMainFrame = window.self === window.top;
    const keyboardAlreadyInjected = document.documentElement.hasAttribute(keyboardMarkerId);
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
    if (keyboardAlreadyInjected)
      return;
    document.documentElement.setAttribute(keyboardMarkerId, "1");
    const existingWebexBtn = document.querySelector(
      "#webexFabActionBtn, .fabActionBtn--WND8X"
    );
    if (existingWebexBtn) {
      applyWebexIconSize(existingWebexBtn);
    }
    const webexObserver = new MutationObserver((mutations) => {
      mutations.forEach((mutation) => {
        mutation.addedNodes.forEach((node) => {
          if (node.nodeType === Node.ELEMENT_NODE) {
            const element = node;
            if (element.id === "webexFabActionBtn" || element.classList.contains("fabActionBtn--WND8X")) {
              applyWebexIconSize(element);
            }
            const webexBtn = element.querySelector?.(
              "#webexFabActionBtn, .fabActionBtn--WND8X"
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
      subtree: true
    });
    function applyWebexIconSize(webexBtn) {
      if (!webexBtn)
        return;
      const webexImg = webexBtn.querySelector(
        ".fabActionBtnIconContainer--RPrZH img"
      );
      if (webexImg) {
        webexImg.style.setProperty("width", "55px", "important");
        webexImg.style.setProperty("height", "55px", "important");
      }
    }
    function hideWebex() {
      const webexBtn = document.querySelector(
        "#webexFabActionBtn, .fabActionBtn--WND8X"
      );
      if (webexBtn) {
        webexBtn.classList.add("webex-hidden-by-sa");
      }
    }
    function showWebex() {
      const webexBtn = document.querySelector(
        "#webexFabActionBtn, .fabActionBtn--WND8X"
      );
      if (webexBtn) {
        webexBtn.classList.remove("webex-hidden-by-sa");
      }
    }
    if (isMainFrame) {
      window.addEventListener("message", (e) => {
        if (e.data === "study-assist-hide-webex") {
          hideWebex();
        } else if (e.data === "study-assist-show-webex") {
          showWebex();
        }
      });
    }
    document.addEventListener("keydown", (e) => {
      if (e.key === "Control") {
        hideWebex();
        if (!isMainFrame) {
          try {
            window.parent.postMessage("study-assist-hide-webex", "*");
          } catch (err) {
          }
        }
        try {
          window.top?.postMessage("study-assist-hide-webex", "*");
        } catch (err) {
        }
      }
      if (e.altKey && !e.repeat && (e.key === "w" || e.key === "W")) {
        const activeEl = document.activeElement;
        const isTyping = isUserTypingInElement(activeEl);
        if (!isTyping && state.settings.quickMode) {
          e.preventDefault();
          reloadQuickMode2();
        }
      }
      if (e.altKey && !e.repeat && (e.key === "q" || e.key === "Q")) {
        const activeEl = document.activeElement;
        const isTyping = isUserTypingInElement(activeEl);
        if (!isTyping) {
          e.preventDefault();
          toggleSAButtonVisibility2();
        }
      }
      if (e.altKey && !e.repeat && (e.key === "x" || e.key === "X")) {
        const activeEl = document.activeElement;
        const isTyping = isUserTypingInElement(activeEl);
        if (!isTyping && state.isRequestInProgress) {
          e.preventDefault();
          cancelCurrentRequest2();
        }
      }
      if (e.key === "Shift" && !e.repeat) {
        const activeEl = document.activeElement;
        const isTyping = isUserTypingInElement(activeEl);
        const quickBtn = document.getElementById("study-assist-quick");
        const isLoading = quickBtn && quickBtn.classList.contains("loading");
        if (!isTyping && quickBtn) {
          e.preventDefault();
          if (isLoading && e.ctrlKey) {
            log(
              "[Study Assist] CTRL+SHIFT pressed while loading - cancelling DeepSeek request"
            );
            chrome.runtime.sendMessage({ type: "CANCEL_DEEPSEEK" }).then((result) => {
              if (result && result.cancelled) {
                log("[Study Assist] DeepSeek cancelled, Claude will take over");
              }
            }).catch((err) => {
              log("[Study Assist] Cancel message error:", err);
            });
          } else if (!isLoading) {
            state.skipDeepSeek = e.ctrlKey;
            if (state.skipDeepSeek) {
              log(
                "[Study Assist] CTRL+SHIFT pressed - will skip DeepSeek, use Claude directly"
              );
            }
            triggerQuickAnalysis2();
          }
        }
      }
    });
    document.addEventListener("keyup", (e) => {
      if (e.key === "Control") {
        showWebex();
        if (!isMainFrame) {
          try {
            window.parent.postMessage("study-assist-show-webex", "*");
          } catch (err) {
          }
        }
        try {
          window.top?.postMessage("study-assist-show-webex", "*");
        } catch (err) {
        }
      }
    });
    window.addEventListener("blur", () => {
      showWebex();
      try {
        window.top?.postMessage("study-assist-show-webex", "*");
      } catch (err) {
      }
    });
  }
  function isUserTypingInElement(activeEl) {
    return !!(activeEl && (activeEl.tagName === "INPUT" || activeEl.tagName === "TEXTAREA" || activeEl.isContentEditable || activeEl.closest('[contenteditable="true"]')));
  }

  // src/content/modules/api.ts
  function isQASandboxActive() {
    return document.getElementById("study-assist-qa-sandbox") !== null;
  }
  function mapTrueFalseAnswer(result, options = []) {
    const normalized = result.normalize("NFD").replace(/[\u0300-\u036f]/g, "").toUpperCase().trim();
    if (/\b(V|TRUE|VERDADERO)\b/.test(normalized))
      return "V";
    if (/\b(F|FALSE|FALSO)\b/.test(normalized))
      return "F";
    const singleLetter = normalized.match(/\b([A-J])\b/)?.[1];
    if (singleLetter) {
      const byLetter = options.find((opt) => opt.letter.toUpperCase() === singleLetter);
      if (byLetter) {
        const optText = byLetter.text.normalize("NFD").replace(/[\u0300-\u036f]/g, "").toUpperCase();
        if (/\b(TRUE|VERDADERO)\b/.test(optText))
          return "V";
        if (/\b(FALSE|FALSO)\b/.test(optText))
          return "F";
      }
    }
    return "?";
  }
  function cancelCurrentRequest() {
    log("[Study Assist] ALT+X pressed - cancelling current request");
    const quickBtn = document.getElementById("study-assist-quick");
    if (!quickBtn)
      return;
    state.requestCancelled = true;
    if (state.slowConnectionTimer) {
      clearTimeout(state.slowConnectionTimer);
      state.slowConnectionTimer = null;
    }
    chrome.runtime.sendMessage({ type: "CANCEL_DEEPSEEK" }).catch(() => {
    });
    quickBtn.innerHTML = `<span>SA</span>`;
    quickBtn.classList.remove("loading", "slow-connection");
    state.isRequestInProgress = false;
    log("[Study Assist] Request cancelled by user");
  }
  function reloadQuickMode(callbacks = {
    detectVisibleQuestion,
    startQuestionChangeObserver
  }) {
    log("[Study Assist] ALT+W pressed - reloading quick mode");
    const existingBtn = document.getElementById("study-assist-quick");
    if (existingBtn) {
      log("[Study Assist] Applying reloading animation to SA button");
      existingBtn.classList.add("reloading");
      setTimeout(() => {
        existingBtn.classList.remove("reloading");
      }, 500);
      handleQuickReload();
      log("[Study Assist] Quick mode reloaded, question re-detected");
    } else {
      if (state.settings.quickMode && frameHasQuizContent()) {
        createQuickButton({ handleQuickClick: (e) => handleQuickClick(e) });
        log("[Study Assist] Quick button created");
      } else if (state.settings.quickMode) {
        waitForQuizContent((hasContent) => {
          if (hasContent) {
            createQuickButton({ handleQuickClick: (e) => handleQuickClick(e) });
            log("[Study Assist] Quick button created after waiting");
          } else {
            log("[Study Assist] No quiz content found in this frame");
          }
        });
      } else {
        log("[Study Assist] Quick mode is disabled in settings");
      }
    }
  }
  function triggerQuickAnalysis(callbacks = {
    detectVisibleQuestion,
    startQuestionChangeObserver
  }) {
    log("[Study Assist] SHIFT pressed - triggering quick analysis");
    const quickBtn = document.getElementById("study-assist-quick");
    if (quickBtn) {
      if (quickBtn.classList.contains("loading")) {
        log("[Study Assist] Already loading, ignoring");
        return;
      }
      handleQuickClick();
    } else {
      log("[Study Assist] Quick button not found, trying to create first");
      if (state.settings.quickMode && frameHasQuizContent()) {
        createQuickButton({ handleQuickClick: (e) => handleQuickClick(e) });
        setTimeout(() => {
          const btn = document.getElementById("study-assist-quick");
          if (btn) {
            handleQuickClick();
          }
        }, 100);
      }
    }
  }
  function startQuestionChangeObserver() {
    if (state.questionChangeObserver) {
      state.questionChangeObserver.disconnect();
      state.questionChangeObserver = null;
    }
    if (state.questionChangeInterval) {
      clearInterval(state.questionChangeInterval);
      state.questionChangeInterval = null;
    }
    state.questionChangeInterval = setInterval(() => {
      if (state.lastAnsweredQuestionNum === null) {
        if (state.questionChangeInterval) {
          clearInterval(state.questionChangeInterval);
          state.questionChangeInterval = null;
        }
        return;
      }
      try {
        const currentNum = findVisibleQuestionNumber();
        if (DEBUG_MODE) {
          log(`[Observer] lastAnswered: ${state.lastAnsweredQuestionNum}, currentNum: ${currentNum}, pending: ${state.pendingQuestionChange}`);
        }
        if (currentNum !== null && currentNum !== state.lastAnsweredQuestionNum) {
          if (!state.pendingQuestionChange || state.pendingQuestionChange !== currentNum) {
            state.pendingQuestionChange = currentNum;
            log(`[Observer] Question change detected: ${state.lastAnsweredQuestionNum} \u2192 ${currentNum}, waiting for confirmation...`);
            return;
          }
          log(
            "[Study Assist] Question changed from",
            state.lastAnsweredQuestionNum,
            "to",
            currentNum
          );
          state.pendingQuestionChange = null;
          resetQuickAnswer();
          if (state.questionChangeInterval) {
            clearInterval(state.questionChangeInterval);
            state.questionChangeInterval = null;
          }
        } else if (currentNum === state.lastAnsweredQuestionNum) {
          state.pendingQuestionChange = null;
        }
      } catch (e) {
      }
    }, 1e3);
  }
  async function handleQuickReload() {
    const quickBtn = document.getElementById("study-assist-quick");
    const container = document.getElementById("study-assist-quick-container");
    if (!quickBtn)
      return;
    quickBtn.classList.add("reloading");
    state.hasValidAnswer = false;
    quickBtn.innerHTML = `<span>SA</span>`;
    quickBtn.classList.remove(
      "has-answer",
      "multi-answer",
      "multi-answer-large",
      "matching-answer"
    );
    if (container) {
      container.classList.remove("matching-mode");
    }
    detectVisibleQuestion().then((question) => {
      setTimeout(() => {
        quickBtn.classList.remove("reloading");
      }, 500);
    });
  }
  async function handleQuickClick(e, callbacks = {
    detectVisibleQuestion,
    startQuestionChangeObserver
  }) {
    const quickBtn = document.getElementById("study-assist-quick");
    if (!quickBtn)
      return;
    if (state.hasValidAnswer) {
      log(
        "[Study Assist] Valid answer already displayed, use ALT+W to re-detect and request again"
      );
      return;
    }
    if (state.isRequestInProgress) {
      log("[Study Assist] Request already in progress, ignoring");
      return;
    }
    if (quickBtn.classList.contains("loading")) {
      log("[Study Assist] Already loading (button state), ignoring");
      return;
    }
    state.isRequestInProgress = true;
    state.requestCancelled = false;
    if (state.questionChangeInterval) {
      clearInterval(state.questionChangeInterval);
      state.questionChangeInterval = null;
    }
    state.lastAnsweredQuestionNum = null;
    if (state.slowConnectionTimer) {
      clearTimeout(state.slowConnectionTimer);
      state.slowConnectionTimer = null;
    }
    const container = document.getElementById("study-assist-quick-container");
    if (container) {
      container.classList.remove("matching-mode");
    }
    quickBtn.classList.remove(
      "has-answer",
      "multi-answer",
      "multi-answer-large",
      "matching-answer",
      "slow-connection"
    );
    quickBtn.innerHTML = `<span class="study-assist-quick-loading"></span>`;
    quickBtn.classList.add("loading");
    state.slowConnectionTimer = setTimeout(() => {
      if (state.isRequestInProgress && quickBtn.classList.contains("loading")) {
        quickBtn.classList.add("slow-connection");
        quickBtn.innerHTML = `<span class="study-assist-slow-indicator">\u23F3</span>`;
      }
    }, 2e4);
    const detectFn = callbacks.detectVisibleQuestion ?? detectVisibleQuestion;
    const question = await detectFn();
    if (!question) {
      quickBtn.innerHTML = `<span>?</span>`;
      quickBtn.classList.remove("loading");
      state.isRequestInProgress = false;
      setTimeout(() => {
        quickBtn.innerHTML = `<span>SA</span>`;
      }, 1500);
      return;
    }
    try {
      let images = [];
      log("[Study Assist] sendImages setting:", state.settings.sendImages);
      if (state.settings.sendImages) {
        if (question.platform === "moodle") {
          if (question.images && question.images.length > 0) {
            images = [...question.images];
            log("[Study Assist] Moodle images found:", images.length);
          }
          if (question.options) {
            for (const opt of question.options) {
              if (opt.image) {
                images.push({
                  ...opt.image,
                  location: `option_${opt.letter}`
                });
              }
            }
          }
        } else if (question.element) {
          try {
            log(
              "[Study Assist] Extracting images from NetAcad element:",
              question.element.tagName
            );
            images = await extractImagesAsBase64(question.element);
            log("[Study Assist] NetAcad images extracted:", images.length);
          } catch (imgError) {
            console.error("[Study Assist] Image extraction error:", imgError);
          }
        }
      } else {
        log("[Study Assist] sendImages is OFF - no images will be sent");
      }
      log("[Study Assist] Total images to send:", images.length);
      let context;
      if (question.type === "matching") {
        context = {
          questionText: question.text,
          questionType: "matching",
          matchingStyle: question.matchingStyle || "drag-drop",
          // "dropdown" or "drag-drop"
          categories: question.categories,
          matchingOptions: question.matchingOptions,
          images,
          pageTitle: document.title,
          pageUrl: window.location.href,
          responseMode: "quick",
          skipDeepSeek: state.skipDeepSeek,
          courseName: question.courseName,
          // Academic course for context
          qaMode: isQASandboxActive()
        };
      } else if (question.type === "select-missing-words") {
        context = {
          questionText: question.text,
          questionType: "select-missing-words",
          selectGaps: question.selectGaps,
          selectChoices: question.selectChoices,
          images,
          pageTitle: document.title,
          pageUrl: window.location.href,
          responseMode: "quick",
          skipDeepSeek: state.skipDeepSeek,
          courseName: question.courseName,
          qaMode: isQASandboxActive()
        };
      } else if (question.type === "short-answer" || question.type === "numerical") {
        context = {
          questionText: question.text,
          questionType: question.type,
          images,
          pageTitle: document.title,
          pageUrl: window.location.href,
          responseMode: "quick",
          skipDeepSeek: state.skipDeepSeek,
          courseName: question.courseName,
          qaMode: isQASandboxActive()
        };
      } else {
        context = {
          questionText: question.text,
          questionType: question.type === "true-false" ? "true-false" : "multiple-choice",
          options: question.options,
          images,
          pageTitle: document.title,
          pageUrl: window.location.href,
          responseMode: "quick",
          skipDeepSeek: state.skipDeepSeek,
          courseName: question.courseName,
          // Academic course for context
          qaMode: isQASandboxActive()
        };
      }
      state.skipDeepSeek = false;
      log("[Study Assist] Sending to API:", {
        questionNumber: question.questionNumber,
        questionType: question.type,
        questionText: question.text ? question.text.substring(0, 80) : "(no text)",
        optionsCount: question.options ? question.options.length : 0,
        options: question.options ? question.options.map(
          (o) => `${o.letter}: ${o.text ? o.text.substring(0, 30) : ""}`
        ) : []
      });
      const response = await chrome.runtime.sendMessage({
        type: "ANALYZE_QUESTION",
        context
      });
      if (state.slowConnectionTimer) {
        clearTimeout(state.slowConnectionTimer);
        state.slowConnectionTimer = null;
      }
      if (state.requestCancelled) {
        log("[Study Assist] Request was cancelled, ignoring response");
        return;
      }
      quickBtn.classList.remove("loading", "slow-connection");
      state.isRequestInProgress = false;
      if (response.success && response.result) {
        const result = response.result.trim();
        const container2 = document.getElementById("study-assist-quick-container");
        state.lastAnsweredQuestionNum = question.questionNumber || null;
        const observerFn = callbacks.startQuestionChangeObserver ?? startQuestionChangeObserver;
        observerFn();
        if (question.type === "matching") {
          const cleanResult = result.toUpperCase().trim().replace(/,\s*/g, "\n");
          quickBtn.innerHTML = `<span class="study-assist-quick-answer study-assist-matching-answer">${cleanResult}</span>`;
          quickBtn.classList.add("has-answer", "matching-answer");
          if (container2)
            container2.classList.add("matching-mode");
          state.hasValidAnswer = true;
        } else if (question.type === "select-missing-words") {
          const cleanResult = result.trim().replace(/,\s*/g, "\n");
          quickBtn.innerHTML = `<span class="study-assist-quick-answer study-assist-matching-answer">${cleanResult}</span>`;
          quickBtn.classList.add("has-answer", "matching-answer");
          if (container2)
            container2.classList.add("matching-mode");
          state.hasValidAnswer = true;
        } else if (question.type === "short-answer" || question.type === "numerical") {
          const displayAnswer = result.trim() || "?";
          quickBtn.innerHTML = `<span class="study-assist-quick-answer study-assist-matching-answer">${displayAnswer}</span>`;
          quickBtn.classList.add("has-answer", "matching-answer");
          if (container2)
            container2.classList.add("matching-mode");
          if (displayAnswer !== "?") {
            state.hasValidAnswer = true;
          }
        } else {
          const upperResult = result.toUpperCase();
          if (question.type === "true-false") {
            const answer2 = mapTrueFalseAnswer(result, question.options || []);
            quickBtn.innerHTML = `<span class="study-assist-quick-answer">${answer2}</span>`;
            quickBtn.classList.add("has-answer");
            if (answer2 !== "?") {
              state.hasValidAnswer = true;
            }
            return;
          }
          const multiMatch = upperResult.match(
            /^([A-J])\s*,\s*([A-J])(?:\s*,\s*([A-J]))?(?:\s*,\s*([A-J]))?(?:\s*,\s*([A-J]))?$/
          );
          let answer;
          let isMultiple = false;
          if (multiMatch) {
            const letters = [
              multiMatch[1],
              multiMatch[2],
              multiMatch[3],
              multiMatch[4],
              multiMatch[5]
            ].filter(Boolean).join(",");
            answer = letters;
            isMultiple = true;
          } else {
            const singleMatch = upperResult.match(/\b([A-J])\b/);
            answer = singleMatch ? singleMatch[1] : "?";
          }
          quickBtn.innerHTML = `<span class="study-assist-quick-answer">${answer}</span>`;
          quickBtn.classList.add("has-answer");
          if (isMultiple) {
            quickBtn.classList.add("multi-answer");
            const answerCount = answer.split(",").length;
            if (answerCount >= 3) {
              quickBtn.classList.add("multi-answer-large");
            }
          }
          if (answer !== "?") {
            state.hasValidAnswer = true;
          }
        }
      } else {
        quickBtn.innerHTML = `<span>!</span>`;
        quickBtn.classList.remove("slow-connection");
        state.isRequestInProgress = false;
        setTimeout(() => {
          quickBtn.innerHTML = `<span>SA</span>`;
        }, 2e3);
      }
    } catch (error) {
      console.error("[Study Assist] Quick analysis error:", error);
      if (state.slowConnectionTimer) {
        clearTimeout(state.slowConnectionTimer);
        state.slowConnectionTimer = null;
      }
      quickBtn.classList.remove("loading", "slow-connection");
      quickBtn.innerHTML = `<span>!</span>`;
      state.isRequestInProgress = false;
      setTimeout(() => {
        quickBtn.innerHTML = `<span>SA</span>`;
      }, 2e3);
    }
  }
  async function analyzeQuestion(question, callbacks = {
    detectVisibleQuestion,
    startQuestionChangeObserver
  }) {
    if (!state.isActive)
      return;
    showLoading();
    let images = [];
    if (state.settings.sendImages) {
      if (question.platform === "moodle") {
        if (question.images && question.images.length > 0) {
          images = [...question.images];
        }
        if (question.options) {
          for (const opt of question.options) {
            if (opt.image) {
              images.push({
                ...opt.image,
                location: `option_${opt.letter}`
              });
            }
          }
        }
      } else if (question.element) {
        try {
          images = await extractImagesAsBase64(question.element);
        } catch (imgError) {
        }
      }
    }
    let context;
    if (question.type === "matching") {
      context = {
        questionText: question.text,
        questionType: "matching",
        matchingStyle: question.matchingStyle || "drag-drop",
        // "dropdown" or "drag-drop"
        categories: question.categories,
        matchingOptions: question.matchingOptions,
        images,
        pageTitle: document.title,
        pageUrl: window.location.href,
        responseMode: state.settings.responseMode,
        courseName: question.courseName,
        // Academic course for context
        qaMode: isQASandboxActive()
      };
    } else if (question.type === "select-missing-words") {
      context = {
        questionText: question.text,
        questionType: "select-missing-words",
        selectGaps: question.selectGaps,
        selectChoices: question.selectChoices,
        images,
        pageTitle: document.title,
        pageUrl: window.location.href,
        responseMode: state.settings.responseMode,
        courseName: question.courseName,
        qaMode: isQASandboxActive()
      };
    } else if (question.type === "short-answer" || question.type === "numerical") {
      context = {
        questionText: question.text,
        questionType: question.type,
        images,
        pageTitle: document.title,
        pageUrl: window.location.href,
        responseMode: state.settings.responseMode,
        courseName: question.courseName,
        qaMode: isQASandboxActive()
      };
    } else {
      context = {
        questionText: question.text,
        questionType: question.type === "true-false" ? "true-false" : "multiple-choice",
        options: question.options,
        images,
        pageTitle: document.title,
        pageUrl: window.location.href,
        responseMode: state.settings.responseMode,
        courseName: question.courseName,
        // Academic course for context
        qaMode: isQASandboxActive()
      };
    }
    try {
      const port = chrome.runtime.connect({ name: "stream-analysis" });
      displayAnalysisResultStreaming("", question, callbacks.showQuestionsSummary, true);
      let fullText = "";
      let streamInputTokens = 0;
      let streamOutputTokens = 0;
      let streamCost = 0;
      await new Promise((resolve, reject) => {
        port.onMessage.addListener((msg) => {
          switch (msg.type) {
            case "STREAM_CHUNK":
              fullText += msg.chunk;
              displayAnalysisResultStreaming(fullText, question, callbacks.showQuestionsSummary, false);
              break;
            case "STREAM_STATUS":
              if (msg.status === "input_tokens") {
                streamInputTokens = msg.inputTokens;
              }
              if (msg.status === "complete") {
                streamOutputTokens = msg.outputTokens;
              }
              break;
            case "STREAM_COMPLETE":
              streamInputTokens = msg.inputTokens || streamInputTokens;
              streamOutputTokens = msg.outputTokens || streamOutputTokens;
              streamCost = msg.cost || 0;
              hideLoading();
              displayAnalysisResultStreaming(
                fullText,
                question,
                callbacks.showQuestionsSummary,
                false,
                { inputTokens: streamInputTokens, outputTokens: streamOutputTokens, cost: streamCost }
              );
              resolve();
              break;
            case "STREAM_ERROR":
              hideLoading();
              displayError(msg.error || "Error de transmisi\xF3n", callbacks.showQuestionsSummary);
              reject(new Error(msg.error));
              break;
          }
        });
        port.onDisconnect.addListener(() => {
          if (!fullText) {
            hideLoading();
            displayError("Conexi\xF3n perdida", callbacks.showQuestionsSummary);
            reject(new Error("Puerto desconectado"));
          } else {
            resolve();
          }
        });
        port.postMessage({ context });
      });
    } catch (error) {
      hideLoading();
      displayError(error.message, callbacks.showQuestionsSummary);
    }
  }

  // src/content/content.ts
  async function checkDomainAllowed() {
    try {
      const result = await chrome.storage.local.get(["allowedDomains"]);
      const allowedDomains = result.allowedDomains ?? DEFAULT_ALLOWED_DOMAINS;
      const currentHostname = window.location.hostname.toLowerCase();
      const isAllowed = allowedDomains.some((domain) => {
        return currentHostname === domain || currentHostname.endsWith("." + domain);
      });
      state.isDomainAllowed = isAllowed;
      return isAllowed;
    } catch (error) {
      console.error("[Study Assist] Error checking domain:", error);
      return false;
    }
  }
  function setupContentObserver() {
    if (state.contentObserver)
      return;
    let debounceTimer = null;
    state.contentObserver = new MutationObserver((_mutations) => {
      if (debounceTimer)
        clearTimeout(debounceTimer);
      debounceTimer = setTimeout(() => {
        if (state.settings.quickMode && !document.getElementById("study-assist-quick-container")) {
          if (frameHasQuizContent()) {
            initQuickButton();
          }
        }
      }, 500);
    });
    state.contentObserver.observe(document.body ?? document.documentElement, {
      childList: true,
      subtree: true
    });
  }
  function initQuickButton() {
    createQuickButton({
      handleQuickClick: (e) => handleQuickClick(e, {
        detectVisibleQuestion,
        startQuestionChangeObserver
      })
    });
  }
  function analyzeQuestionWithCallbacks(question) {
    return analyzeQuestion(question, {
      detectVisibleQuestion,
      startQuestionChangeObserver,
      showQuestionsSummary: showQuestionsSummaryWithCallbacks
    });
  }
  function showQuestionsSummaryWithCallbacks() {
    return showQuestionsSummary(detectVisibleQuestion, analyzeQuestionWithCallbacks);
  }
  function initOverlayContainer() {
    createOverlayContainer({
      frameHasQuizContent,
      waitForQuizContent,
      handleQuickClick: (e) => handleQuickClick(e, {
        detectVisibleQuestion,
        startQuestionChangeObserver
      }),
      showQuestionsSummary: showQuestionsSummaryWithCallbacks
    });
  }
  function initKeyboardHandlers() {
    setupKeyboardHandlers({
      triggerQuickAnalysis: () => triggerQuickAnalysis({
        detectVisibleQuestion,
        startQuestionChangeObserver
      }),
      reloadQuickMode: () => reloadQuickMode({
        detectVisibleQuestion,
        startQuestionChangeObserver
      }),
      toggleSAButtonVisibility,
      cancelCurrentRequest
    });
  }
  async function runDetection() {
    const result = await detectQuestionsOnPage();
    if (result && result.found) {
      if (state.settings.highlightQuestions) {
        highlightDetectedQuestions(analyzeQuestionWithCallbacks);
      }
      if (!state.settings.quickMode) {
        await showQuestionsSummaryWithCallbacks();
      }
    }
  }
  async function initialize() {
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
        "buttonPosition"
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
        setTimeout(() => runDetection(), 1e3);
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
  function clearQASandbox() {
    const sandbox = document.getElementById("study-assist-qa-sandbox");
    if (sandbox)
      sandbox.remove();
  }
  function injectNetAcadMcq(target) {
    target.innerHTML = `
    <div class="qa-block">
      <h3>NetAcad Simulado \u2014 Opci\xF3n m\xFAltiple</h3>
      <p class="qa-tip">Usa <strong>SHIFT</strong> para quick mode, o clic en badge para an\xE1lisis completo.</p>
      <div class="qa-question-title">Pregunta 1</div>
      <mcq-view id="qa-netacad-mcq"></mcq-view>
    </div>
  `;
    const mcqView = target.querySelector("#qa-netacad-mcq");
    if (!mcqView)
      return;
    const shadowRoot = mcqView.attachShadow({ mode: "open" });
    shadowRoot.innerHTML = `
    <style>
      .mcq__body-inner { font-size: 16px; margin-bottom: 12px; color: #1f2937; }
      .mcq__item { margin: 8px 0; padding: 10px; border: 1px solid #e5e7eb; border-radius: 8px; background: #fff; }
      .mcq__item-text-inner { font-size: 14px; color: #111827; }
    </style>
    <div class="mcq__body-inner">\xBFCu\xE1l capa del modelo OSI se encarga del enrutamiento?</div>
    <div class="mcq__item"><div class="mcq__item-text-inner">Capa F\xEDsica</div></div>
    <div class="mcq__item"><div class="mcq__item-text-inner">Capa de Enlace</div></div>
    <div class="mcq__item"><div class="mcq__item-text-inner">Capa de Red</div></div>
    <div class="mcq__item"><div class="mcq__item-text-inner">Capa de Aplicaci\xF3n</div></div>
  `;
  }
  function injectNetAcadMatching(target) {
    target.innerHTML = `
    <div class="qa-block">
      <h3>NetAcad Simulado \u2014 Matching</h3>
      <p class="qa-tip">En quick mode la respuesta se mostrar\xE1 como pares (ej. <strong>A-2</strong>).</p>
      <div class="qa-question-title">Pregunta 1</div>
      <object-matching-view id="qa-netacad-matching"></object-matching-view>
    </div>
  `;
    const matchingView = target.querySelector("#qa-netacad-matching");
    if (!matchingView)
      return;
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
  function injectMoodleShortAnswer(target) {
    target.innerHTML = `
    <div class="qa-block">
      <h3>Moodle Simulado \u2014 Respuesta corta (Short Answer)</h3>
      <p class="qa-tip">La IA responder\xE1 con texto libre. Respuesta esperada: <strong>HyperText Transfer Protocol</strong>.</p>
      <div class="que shortanswer">
        <div class="info"><h3 class="no">Pregunta <span class="qno">1</span></h3></div>
        <div class="content">
          <div class="formulation clearfix">
            <div class="qtext">\xBFQu\xE9 significa el acr\xF3nimo <strong>HTTP</strong> en el contexto de la World Wide Web?</div>
            <div class="answer">
              <input type="text" class="form-control d-inline" size="30" placeholder="Escribe tu respuesta aqu\xED" />
            </div>
          </div>
        </div>
      </div>
    </div>
  `;
  }
  function injectMoodleNumerical(target) {
    target.innerHTML = `
    <div class="qa-block">
      <h3>Moodle Simulado \u2014 Num\xE9rica (Numerical)</h3>
      <p class="qa-tip">La IA responder\xE1 con un n\xFAmero. Respuesta esperada: <strong>32</strong>.</p>
      <div class="que numerical">
        <div class="info"><h3 class="no">Pregunta <span class="qno">1</span></h3></div>
        <div class="content">
          <div class="formulation clearfix">
            <div class="qtext">\xBFCu\xE1ntos bits tiene una direcci\xF3n IPv4?</div>
            <div class="answer">
              <input type="text" class="form-control d-inline" size="15" placeholder="Respuesta num\xE9rica" />
            </div>
          </div>
        </div>
      </div>
    </div>
  `;
  }
  function injectMoodleGapSelect(target) {
    target.innerHTML = `
    <div class="qa-block">
      <h3>Moodle Simulado \u2014 Selecciona las palabras faltantes (Select Missing Words)</h3>
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
              para comunicaci\xF3n no cifrada, mientras que
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
              para comunicaci\xF3n cifrada.
            </div>
          </div>
        </div>
      </div>
    </div>
  `;
  }
  function injectMoodleMatch(target) {
    target.innerHTML = `
    <div class="qa-block">
      <h3>Moodle Simulado \u2014 Relacionar (Match)</h3>
      <p class="qa-tip">Respuesta esperada: <strong>A-2, B-1, C-3</strong> (categor\xEDa-opci\xF3n).</p>
      <div class="que match">
        <div class="info"><h3 class="no">Pregunta <span class="qno">1</span></h3></div>
        <div class="content">
          <div class="formulation clearfix">
            <div class="qtext">Relaciona cada capa del modelo OSI con su funci\xF3n principal.</div>
            <div class="ablock">
              <table class="answer">
                <tbody>
                  <tr class="r0">
                    <td class="text">Enrutamiento l\xF3gico de paquetes</td>
                    <td class="control">
                      <select>
                        <option value="0">Elegir...</option>
                        <option value="1">Capa F\xEDsica</option>
                        <option value="2">Capa de Red</option>
                        <option value="3">Capa de Transporte</option>
                      </select>
                    </td>
                  </tr>
                  <tr class="r1">
                    <td class="text">Transmisi\xF3n de bits por el medio f\xEDsico</td>
                    <td class="control">
                      <select>
                        <option value="0">Elegir...</option>
                        <option value="1">Capa F\xEDsica</option>
                        <option value="2">Capa de Red</option>
                        <option value="3">Capa de Transporte</option>
                      </select>
                    </td>
                  </tr>
                  <tr class="r0">
                    <td class="text">Control de flujo y segmentaci\xF3n extremo a extremo</td>
                    <td class="control">
                      <select>
                        <option value="0">Elegir...</option>
                        <option value="1">Capa F\xEDsica</option>
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
  function attachQANavigation(container) {
    const slides = Array.from(container.querySelectorAll(".qa-slide"));
    if (slides.length === 0)
      return;
    let current = 0;
    const prevBtn = container.querySelector("#qa-nav-prev");
    const nextBtn = container.querySelector("#qa-nav-next");
    const progressEl = container.querySelector(".qa-quiz-progress");
    function update() {
      slides.forEach((slide, i) => {
        slide.style.display = i === current ? "" : "none";
      });
      if (prevBtn)
        prevBtn.disabled = current <= 0;
      if (nextBtn)
        nextBtn.disabled = current >= slides.length - 1;
      if (progressEl)
        progressEl.textContent = `Pregunta ${current + 1} de ${slides.length}`;
      window.dispatchEvent(new CustomEvent("study-assist-navigate"));
    }
    if (prevBtn)
      prevBtn.addEventListener("click", () => {
        if (current > 0) {
          current--;
          update();
        }
      });
    if (nextBtn)
      nextBtn.addEventListener("click", () => {
        if (current < slides.length - 1) {
          current++;
          update();
        }
      });
  }
  function injectNetAcadQuiz(target) {
    target.innerHTML = `
    <div class="qa-quiz-header">
      <span class="qa-quiz-platform">\u{1F535} NetAcad \u2014 Quiz Real</span>
      <div class="qa-quiz-nav">
        <button class="qa-sandbox-nav-btn" id="qa-nav-prev" disabled>\u2190 Anterior</button>
        <span class="qa-quiz-progress">Pregunta 1 de 2</span>
        <button class="qa-sandbox-nav-btn" id="qa-nav-next">Siguiente \u2192</button>
      </div>
    </div>
    <p class="qa-tip">La detecci\xF3n se actualiza autom\xE1ticamente al navegar.</p>

    <div class="qa-slide" data-slide="0">
      <div class="qa-block">
        <h3>Pregunta 1 \u2014 Opci\xF3n m\xFAltiple (MCQ)</h3>
        <div class="qa-question-title">Pregunta 1</div>
        <mcq-view id="qa-netacad-quiz-mcq"></mcq-view>
      </div>
    </div>

    <div class="qa-slide" data-slide="1" style="display:none">
      <div class="qa-block">
        <h3>Pregunta 2 \u2014 Relacionar (Matching)</h3>
        <p class="qa-tip">En quick mode la respuesta se mostrar\xE1 como pares (ej. <strong>A-2</strong>).</p>
        <div class="qa-question-title">Pregunta 2</div>
        <object-matching-view id="qa-netacad-quiz-matching"></object-matching-view>
      </div>
    </div>
  `;
    const mcqView = target.querySelector("#qa-netacad-quiz-mcq");
    if (mcqView) {
      const sr = mcqView.attachShadow({ mode: "open" });
      sr.innerHTML = `
      <style>
        .mcq__body-inner { font-size: 16px; margin-bottom: 12px; color: #1f2937; }
        .mcq__item { margin: 8px 0; padding: 10px; border: 1px solid #e5e7eb; border-radius: 8px; background: #fff; }
        .mcq__item-text-inner { font-size: 14px; color: #111827; }
      </style>
      <div class="mcq__body-inner">\xBFCu\xE1l capa del modelo OSI se encarga del enrutamiento l\xF3gico de paquetes?</div>
      <div class="mcq__item"><div class="mcq__item-text-inner">Capa F\xEDsica</div></div>
      <div class="mcq__item"><div class="mcq__item-text-inner">Capa de Enlace de Datos</div></div>
      <div class="mcq__item"><div class="mcq__item-text-inner">Capa de Red</div></div>
      <div class="mcq__item"><div class="mcq__item-text-inner">Capa de Transporte</div></div>
    `;
    }
    const matchingView = target.querySelector("#qa-netacad-quiz-matching");
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
  function injectMoodleQuiz(target) {
    target.innerHTML = `
    <div class="qa-quiz-header">
      <span class="qa-quiz-platform">\u{1F7E3} Moodle \u2014 Quiz Real</span>
      <div class="qa-quiz-nav">
        <button class="qa-sandbox-nav-btn" id="qa-nav-prev" disabled>\u2190 Anterior</button>
        <span class="qa-quiz-progress">Pregunta 1 de 6</span>
        <button class="qa-sandbox-nav-btn" id="qa-nav-next">Siguiente \u2192</button>
      </div>
    </div>
    <p class="qa-tip">La detecci\xF3n se actualiza autom\xE1ticamente al navegar.</p>

    <div class="qa-slide" data-slide="0">
      <div class="qa-block">
        <h3>Pregunta 1 \u2014 Opci\xF3n m\xFAltiple (MCQ)</h3>
        <div class="que multichoice">
          <div class="info"><h3 class="no">Pregunta <span class="qno">1</span></h3></div>
          <div class="qtext">\xBFQu\xE9 protocolo utiliza el puerto 443 por defecto?</div>
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
        <h3>Pregunta 2 \u2014 Verdadero/Falso</h3>
        <div class="que truefalse">
          <div class="info"><h3 class="no">Pregunta <span class="qno">2</span></h3></div>
          <div class="qtext">La entrop\xEDa representa la tendencia natural de un sistema a desorganizarse.</div>
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
        <h3>Pregunta 3 \u2014 Relacionar (Match)</h3>
        <div class="que match">
          <div class="info"><h3 class="no">Pregunta <span class="qno">3</span></h3></div>
          <div class="content">
            <div class="formulation clearfix">
              <div class="qtext">Relaciona cada capa del modelo OSI con su funci\xF3n principal.</div>
              <div class="ablock">
                <table class="answer">
                  <tbody>
                    <tr class="r0">
                      <td class="text">Enrutamiento l\xF3gico de paquetes</td>
                      <td class="control">
                        <select>
                          <option value="0">Elegir...</option>
                          <option value="1">Capa F\xEDsica</option>
                          <option value="2">Capa de Red</option>
                          <option value="3">Capa de Transporte</option>
                        </select>
                      </td>
                    </tr>
                    <tr class="r1">
                      <td class="text">Transmisi\xF3n de bits por el medio f\xEDsico</td>
                      <td class="control">
                        <select>
                          <option value="0">Elegir...</option>
                          <option value="1">Capa F\xEDsica</option>
                          <option value="2">Capa de Red</option>
                          <option value="3">Capa de Transporte</option>
                        </select>
                      </td>
                    </tr>
                    <tr class="r0">
                      <td class="text">Control de flujo y segmentaci\xF3n extremo a extremo</td>
                      <td class="control">
                        <select>
                          <option value="0">Elegir...</option>
                          <option value="1">Capa F\xEDsica</option>
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
        <h3>Pregunta 4 \u2014 Respuesta corta (Short Answer)</h3>
        <div class="que shortanswer">
          <div class="info"><h3 class="no">Pregunta <span class="qno">4</span></h3></div>
          <div class="content">
            <div class="formulation clearfix">
              <div class="qtext">\xBFCu\xE1l es el nombre completo del protocolo cuyas siglas son HTTP?</div>
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
        <h3>Pregunta 5 \u2014 Num\xE9rica (Numerical)</h3>
        <div class="que numerical">
          <div class="info"><h3 class="no">Pregunta <span class="qno">5</span></h3></div>
          <div class="content">
            <div class="formulation clearfix">
              <div class="qtext">\xBFCu\xE1ntos bits componen una direcci\xF3n IPv4?</div>
              <div class="ablock">
                <label for="qa_num_input">Respuesta:</label>
                <input type="text" id="qa_num_input" class="form-control d-inline" size="10" placeholder="N\xFAmero..." />
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>

    <div class="qa-slide" data-slide="5" style="display:none">
      <div class="qa-block">
        <h3>Pregunta 6 \u2014 Seleccionar palabras que faltan (Gap Select)</h3>
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
                para tr\xE1fico no cifrado, mientras que
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
  function injectQAScenario(scenario) {
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
    <h2>\u{1F9EA} Study Assist QA Sandbox</h2>
    <p class="qa-meta">
      Escenario: <strong>${scenario}</strong> \xB7 Usa ALT+W para recargar detecci\xF3n y SHIFT para quick analysis.
    </p>
  `;
    const content = document.createElement("div");
    wrapper.appendChild(content);
    if (scenario === "moodle-mcq") {
      content.innerHTML = `
      <div class="qa-block">
        <h3>Moodle Simulado \u2014 Opci\xF3n m\xFAltiple</h3>
        <div class="que multichoice">
          <div class="info"><h3 class="no">Pregunta <span class="qno">1</span></h3></div>
          <div class="qtext">\xBFQu\xE9 protocolo utiliza el puerto 443 por defecto?</div>
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
        <h3>Moodle Simulado \u2014 Verdadero/Falso</h3>
        <div class="que truefalse">
          <div class="info"><h3 class="no">Pregunta <span class="qno">1</span></h3></div>
          <div class="qtext">La entrop\xEDa representa la tendencia natural de un sistema a desorganizarse.</div>
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
  async function runQAPreview() {
    const result = await detectQuestionsOnPage();
    if (result?.found) {
      highlightDetectedQuestions(analyzeQuestionWithCallbacks);
    }
    return result?.count ?? 0;
  }
  chrome.runtime.onMessage.addListener(
    (message, _sender, sendResponse) => {
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
          state.settings = { ...state.settings, ...message.settings };
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
              sendResponse({ success: false, error: error.message });
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
      return true;
    }
  );
  window.addEventListener("study-assist-navigate", () => {
    if (state.isActive && state.isDomainAllowed) {
      runDetection();
    }
  });
  initialize();
})();
//# sourceMappingURL=data:application/json;base64,ewogICJ2ZXJzaW9uIjogMywKICAic291cmNlcyI6IFsiLi4vc3JjL2NvbnRlbnQvbW9kdWxlcy9zdGF0ZS50cyIsICIuLi9zcmMvY29udGVudC9tb2R1bGVzL3V0aWxzLnRzIiwgIi4uL3NyYy9jb250ZW50L21vZHVsZXMvaW1hZ2VzLnRzIiwgIi4uL3NyYy9jb250ZW50L21vZHVsZXMvZGV0ZWN0aW9uLnRzIiwgIi4uL3NyYy9jb250ZW50L21vZHVsZXMvdWkudHMiLCAiLi4vc3JjL2NvbnRlbnQvbW9kdWxlcy9rZXlib2FyZC50cyIsICIuLi9zcmMvY29udGVudC9tb2R1bGVzL2FwaS50cyIsICIuLi9zcmMvY29udGVudC9jb250ZW50LnRzIl0sCiAgInNvdXJjZXNDb250ZW50IjogWyIvKipcclxuICogU3R1ZHkgQXNzaXN0IC0gU3RhdGUgTWFuYWdlbWVudCBNb2R1bGVcclxuICogQ2VudHJhbGl6ZWQgc3RhdGUgZm9yIHRoZSBleHRlbnNpb25cclxuICovXHJcblxyXG5pbXBvcnQgdHlwZSB7IFN0YXRlLCBTZXR0aW5ncyB9IGZyb20gXCIuLi8uLi90eXBlcy9pbmRleC5qc1wiO1xyXG5cclxuLy8gPT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT1cclxuLy8gRGVidWcgTW9kZVxyXG4vLyA9PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PVxyXG5leHBvcnQgY29uc3QgREVCVUdfTU9ERSA9IHRydWU7XHJcbmV4cG9ydCBjb25zdCBsb2cgPSAoLi4uYXJnczogdW5rbm93bltdKTogdm9pZCA9PiB7XHJcbiAgaWYgKERFQlVHX01PREUpIHtcclxuICAgIGNvbnNvbGUubG9nKC4uLmFyZ3MpO1xyXG4gIH1cclxufTtcclxuXHJcbi8vID09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09XHJcbi8vIFN0YXRlIE9iamVjdFxyXG4vLyA9PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PVxyXG5leHBvcnQgY29uc3Qgc3RhdGU6IFN0YXRlID0ge1xyXG4gIGlzQWN0aXZlOiBmYWxzZSxcclxuICBpc0RvbWFpbkFsbG93ZWQ6IGZhbHNlLFxyXG4gIGlzSW5pdGlhbGl6ZWQ6IGZhbHNlLFxyXG4gIHNldHRpbmdzOiB7XHJcbiAgICByZXNwb25zZU1vZGU6IFwiZ3VpZGVkXCIsXHJcbiAgICBhdXRvRGV0ZWN0OiB0cnVlLFxyXG4gICAgaGlnaGxpZ2h0UXVlc3Rpb25zOiB0cnVlLFxyXG4gICAgcXVpY2tNb2RlOiBmYWxzZSxcclxuICAgIHNlbmRJbWFnZXM6IGZhbHNlLFxyXG4gICAgYnV0dG9uUG9zaXRpb246IFwiYm90dG9tLXJpZ2h0XCIsXHJcbiAgfSBhcyBTZXR0aW5ncyxcclxuICBkZXRlY3RlZFF1ZXN0aW9uczogW10sXHJcbiAgY3VycmVudFZpc2libGVRdWVzdGlvbjogbnVsbCxcclxuICBvdmVybGF5VmlzaWJsZTogZmFsc2UsXHJcbiAgY29udGVudE9ic2VydmVyOiBudWxsLFxyXG4gIC8vIFRyYWNrIGN1cnJlbnQgcXVlc3Rpb24gZm9yIHF1aWNrIG1vZGUgYW5zd2VyIHBlcnNpc3RlbmNlXHJcbiAgbGFzdEFuc3dlcmVkUXVlc3Rpb25OdW06IG51bGwsXHJcbiAgcXVlc3Rpb25DaGFuZ2VPYnNlcnZlcjogbnVsbCxcclxuICBxdWVzdGlvbkNoYW5nZUludGVydmFsOiBudWxsLFxyXG4gIC8vIFByZXZlbnQgc2ltdWx0YW5lb3VzIEFQSSByZXF1ZXN0c1xyXG4gIGlzUmVxdWVzdEluUHJvZ3Jlc3M6IGZhbHNlLFxyXG4gIC8vIEJsb2NrIG5ldyByZXF1ZXN0cyB3aGVuIHZhbGlkIGFuc3dlciBpcyBkaXNwbGF5ZWQgKHVudGlsIHJlbG9hZClcclxuICBoYXNWYWxpZEFuc3dlcjogZmFsc2UsXHJcbiAgLy8gU2tpcCBEZWVwU2VlayBhbmQgdXNlIENsYXVkZSBkaXJlY3RseSAoQ1RSTCtTSElGVClcclxuICBza2lwRGVlcFNlZWs6IGZhbHNlLFxyXG4gIC8vIFNsb3cgY29ubmVjdGlvbiB0aW1lclxyXG4gIHNsb3dDb25uZWN0aW9uVGltZXI6IG51bGwsXHJcbiAgLy8gUmVxdWVzdCBjYW5jZWxsZWQgYnkgdXNlciAoQUxUK1gpXHJcbiAgcmVxdWVzdENhbmNlbGxlZDogZmFsc2UsXHJcbiAgLy8gUGVuZGluZyBxdWVzdGlvbiBjaGFuZ2UgKGZvciBkb3VibGUtY29uZmlybWF0aW9uKVxyXG4gIHBlbmRpbmdRdWVzdGlvbkNoYW5nZTogbnVsbCxcclxufTtcclxuXHJcbi8vID09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09XHJcbi8vIERlZmF1bHQgQ29uZmlndXJhdGlvblxyXG4vLyA9PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PVxyXG5leHBvcnQgY29uc3QgREVGQVVMVF9BTExPV0VEX0RPTUFJTlM6IHN0cmluZ1tdID0gW107XHJcbiIsICIvKipcclxuICogU3R1ZHkgQXNzaXN0IC0gVXRpbGl0eSBGdW5jdGlvbnMgTW9kdWxlXHJcbiAqIENvbW1vbiB1dGlsaXR5IGZ1bmN0aW9ucyBmb3IgRE9NIHRyYXZlcnNhbCwgdGV4dCBleHRyYWN0aW9uLCBhbmQgZm9ybWF0dGluZ1xyXG4gKi9cclxuXHJcbmltcG9ydCB0eXBlIHsgRGV0ZWN0ZWRRdWVzdGlvbiwgUXVlc3Rpb25UeXBlIH0gZnJvbSBcIi4uLy4uL3R5cGVzL2luZGV4LmpzXCI7XHJcbmltcG9ydCB7IGxvZyB9IGZyb20gXCIuL3N0YXRlLmpzXCI7XHJcblxyXG4vLyA9PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PVxyXG4vLyBET00gVHJhdmVyc2FsIFV0aWxpdGllc1xyXG4vLyA9PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PVxyXG5cclxuLyoqXHJcbiAqIFF1ZXJ5IHNlbGVjdG9yIHRoYXQgdHJhdmVyc2VzIGludG8gc2hhZG93IERPTXNcclxuICogQHBhcmFtIHNlbGVjdG9yIC0gQ1NTIHNlbGVjdG9yXHJcbiAqIEBwYXJhbSByb290IC0gUm9vdCBlbGVtZW50IHRvIHN0YXJ0IGZyb21cclxuICogQHJldHVybnMgQWxsIG1hdGNoaW5nIGVsZW1lbnRzIGluY2x1ZGluZyB0aG9zZSBpbiBuZXN0ZWQgc2hhZG93IERPTXNcclxuICovXHJcbmV4cG9ydCBmdW5jdGlvbiBxdWVyeVNlbGVjdG9yQWxsRGVlcChcclxuICBzZWxlY3Rvcjogc3RyaW5nLFxyXG4gIHJvb3Q6IEVsZW1lbnQgfCBEb2N1bWVudCB8IFNoYWRvd1Jvb3QgPSBkb2N1bWVudFxyXG4pOiBFbGVtZW50W10ge1xyXG4gIGNvbnN0IHJlc3VsdHM6IEVsZW1lbnRbXSA9IFtdO1xyXG5cclxuICAvKipcclxuICAgKiBIZWxwZXIgZnVuY3Rpb24gdG8gcmVjdXJzaXZlbHkgdHJhdmVyc2VcclxuICAgKi9cclxuICBmdW5jdGlvbiB0cmF2ZXJzZShub2RlOiBFbGVtZW50KTogdm9pZCB7XHJcbiAgICAvLyBJZiB0aGlzIG5vZGUgaGFzIGEgc2hhZG93IHJvb3QsIHNlYXJjaCBpbnNpZGUgaXRcclxuICAgIGlmIChub2RlLnNoYWRvd1Jvb3QpIHtcclxuICAgICAgdHJ5IHtcclxuICAgICAgICBjb25zdCBzaGFkb3dNYXRjaGVzID0gbm9kZS5zaGFkb3dSb290LnF1ZXJ5U2VsZWN0b3JBbGwoc2VsZWN0b3IpO1xyXG4gICAgICAgIHJlc3VsdHMucHVzaCguLi5BcnJheS5mcm9tKHNoYWRvd01hdGNoZXMpKTtcclxuICAgICAgfSBjYXRjaCAoZSkge1xyXG4gICAgICAgIC8vIElnbm9yZSBlcnJvcnMgZnJvbSBpbnZhbGlkIHNlbGVjdG9ycyBpbiBzaGFkb3cgRE9NXHJcbiAgICAgIH1cclxuXHJcbiAgICAgIC8vIEFsc28gdHJhdmVyc2UgYWxsIGVsZW1lbnRzIGluc2lkZSB0aGUgc2hhZG93IHJvb3RcclxuICAgICAgY29uc3Qgc2hhZG93RWxlbWVudHMgPSBub2RlLnNoYWRvd1Jvb3QucXVlcnlTZWxlY3RvckFsbChcIipcIik7XHJcbiAgICAgIGZvciAoY29uc3QgZWwgb2Ygc2hhZG93RWxlbWVudHMpIHtcclxuICAgICAgICB0cmF2ZXJzZShlbCk7XHJcbiAgICAgIH1cclxuICAgIH1cclxuICB9XHJcblxyXG4gIC8vIEZpcnN0LCBzZWFyY2ggaW4gdGhlIHJvb3QgaXRzZWxmXHJcbiAgdHJ5IHtcclxuICAgIGNvbnN0IHJvb3RNYXRjaGVzID0gcm9vdC5xdWVyeVNlbGVjdG9yQWxsKHNlbGVjdG9yKTtcclxuICAgIHJlc3VsdHMucHVzaCguLi5BcnJheS5mcm9tKHJvb3RNYXRjaGVzKSk7XHJcbiAgfSBjYXRjaCAoZSkge1xyXG4gICAgLy8gSWdub3JlIGVycm9ycyBmcm9tIGludmFsaWQgc2VsZWN0b3JzXHJcbiAgfVxyXG5cclxuICAvLyBJZiByb290IGlzIGFuIEVsZW1lbnQgd2l0aCBpdHMgb3duIHNoYWRvdyByb290LCB0cmF2ZXJzZSBpdCBmaXJzdC5cclxuICAvLyBUaGlzIGhhbmRsZXMgdGhlIGNhc2Ugd2hlcmUgcm9vdCBpcyBhIGN1c3RvbSBlbGVtZW50IChlLmcuIG1jcS12aWV3KVxyXG4gIC8vIHdob3NlIGNvbnRlbnQgbGl2ZXMgZW50aXJlbHkgaW4gaXRzIHNoYWRvdyBET00uXHJcbiAgaWYgKFwic2hhZG93Um9vdFwiIGluIHJvb3QgJiYgKHJvb3QgYXMgRWxlbWVudCkuc2hhZG93Um9vdCkge1xyXG4gICAgdHJhdmVyc2Uocm9vdCBhcyBFbGVtZW50KTtcclxuICB9XHJcblxyXG4gIC8vIFRoZW4gdHJhdmVyc2UgYWxsIGVsZW1lbnRzIHRvIGZpbmQgc2hhZG93IHJvb3RzXHJcbiAgdHJ5IHtcclxuICAgIGNvbnN0IGFsbEVsZW1lbnRzID0gcm9vdC5xdWVyeVNlbGVjdG9yQWxsKFwiKlwiKTtcclxuICAgIGZvciAoY29uc3QgZWwgb2YgYWxsRWxlbWVudHMpIHtcclxuICAgICAgdHJhdmVyc2UoZWwpO1xyXG4gICAgfVxyXG4gIH0gY2F0Y2ggKGUpIHtcclxuICAgIC8vIElnbm9yZSBlcnJvcnNcclxuICB9XHJcblxyXG4gIHJldHVybiByZXN1bHRzO1xyXG59XHJcblxyXG4vKipcclxuICogU2hhZG93IHJvb3QgaW5mb3JtYXRpb24gZm9yIGRlYnVnZ2luZ1xyXG4gKi9cclxuaW50ZXJmYWNlIFNoYWRvd1Jvb3RJbmZvIHtcclxuICBlbGVtZW50OiBzdHJpbmc7XHJcbiAgc2hhZG93Um9vdDogU2hhZG93Um9vdDtcclxufVxyXG5cclxuLyoqXHJcbiAqIEZpbmQgYWxsIHNoYWRvdyByb290cyBpbiB0aGUgZG9jdW1lbnQgKGZvciBkZWJ1Z2dpbmcpXHJcbiAqIEBwYXJhbSByb290IC0gUm9vdCBlbGVtZW50IHRvIHN0YXJ0IGZyb21cclxuICogQHJldHVybnMgQXJyYXkgb2Ygc2hhZG93IHJvb3QgaW5mb1xyXG4gKi9cclxuZXhwb3J0IGZ1bmN0aW9uIGZpbmRBbGxTaGFkb3dSb290cyhcclxuICByb290OiBFbGVtZW50IHwgRG9jdW1lbnQgPSBkb2N1bWVudFxyXG4pOiBTaGFkb3dSb290SW5mb1tdIHtcclxuICBjb25zdCBzaGFkb3dSb290czogU2hhZG93Um9vdEluZm9bXSA9IFtdO1xyXG5cclxuICBmdW5jdGlvbiB0cmF2ZXJzZShub2RlOiBFbGVtZW50KTogdm9pZCB7XHJcbiAgICBpZiAobm9kZS5zaGFkb3dSb290KSB7XHJcbiAgICAgIHNoYWRvd1Jvb3RzLnB1c2goeyBlbGVtZW50OiBub2RlLnRhZ05hbWUsIHNoYWRvd1Jvb3Q6IG5vZGUuc2hhZG93Um9vdCB9KTtcclxuICAgICAgY29uc3Qgc2hhZG93RWxlbWVudHMgPSBub2RlLnNoYWRvd1Jvb3QucXVlcnlTZWxlY3RvckFsbChcIipcIik7XHJcbiAgICAgIGZvciAoY29uc3QgZWwgb2Ygc2hhZG93RWxlbWVudHMpIHtcclxuICAgICAgICB0cmF2ZXJzZShlbCk7XHJcbiAgICAgIH1cclxuICAgIH1cclxuICB9XHJcblxyXG4gIGNvbnN0IGFsbEVsZW1lbnRzID0gcm9vdC5xdWVyeVNlbGVjdG9yQWxsKFwiKlwiKTtcclxuICBmb3IgKGNvbnN0IGVsIG9mIGFsbEVsZW1lbnRzKSB7XHJcbiAgICB0cmF2ZXJzZShlbCk7XHJcbiAgfVxyXG5cclxuICByZXR1cm4gc2hhZG93Um9vdHM7XHJcbn1cclxuXHJcbi8vID09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09XHJcbi8vIFRleHQgRXh0cmFjdGlvbiBVdGlsaXRpZXNcclxuLy8gPT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT1cclxuXHJcbi8qKlxyXG4gKiBHZXQgYWxsIHRleHQgY29udGVudCBmcm9tIGFuIGVsZW1lbnQsIHRyYXZlcnNpbmcgaW50byBzaGFkb3cgcm9vdHNcclxuICogQHBhcmFtIGVsZW1lbnQgLSBUaGUgZWxlbWVudCB0byBleHRyYWN0IHRleHQgZnJvbVxyXG4gKiBAcmV0dXJucyBDb21iaW5lZCB0ZXh0IGNvbnRlbnQgd2l0aCBub3JtYWxpemVkIHdoaXRlc3BhY2VcclxuICovXHJcbmV4cG9ydCBmdW5jdGlvbiBnZXREZWVwVGV4dENvbnRlbnQoZWxlbWVudDogRWxlbWVudCk6IHN0cmluZyB7XHJcbiAgbGV0IHRleHQgPSBcIlwiO1xyXG5cclxuICBmdW5jdGlvbiB0cmF2ZXJzZShub2RlOiBOb2RlKTogdm9pZCB7XHJcbiAgICBpZiAobm9kZS5ub2RlVHlwZSA9PT0gTm9kZS5URVhUX05PREUpIHtcclxuICAgICAgdGV4dCArPSBub2RlLnRleHRDb250ZW50ICsgXCIgXCI7XHJcbiAgICB9IGVsc2UgaWYgKG5vZGUubm9kZVR5cGUgPT09IE5vZGUuRUxFTUVOVF9OT0RFKSB7XHJcbiAgICAgIGNvbnN0IGVsZW1lbnROb2RlID0gbm9kZSBhcyBFbGVtZW50O1xyXG4gICAgICAvLyBGaXJzdCB0cmF2ZXJzZSBzaGFkb3cgcm9vdCBpZiBleGlzdHNcclxuICAgICAgaWYgKGVsZW1lbnROb2RlLnNoYWRvd1Jvb3QpIHtcclxuICAgICAgICBmb3IgKGNvbnN0IGNoaWxkIG9mIGVsZW1lbnROb2RlLnNoYWRvd1Jvb3QuY2hpbGROb2Rlcykge1xyXG4gICAgICAgICAgdHJhdmVyc2UoY2hpbGQpO1xyXG4gICAgICAgIH1cclxuICAgICAgfVxyXG4gICAgICAvLyBUaGVuIHRyYXZlcnNlIHJlZ3VsYXIgY2hpbGRyZW5cclxuICAgICAgZm9yIChjb25zdCBjaGlsZCBvZiBub2RlLmNoaWxkTm9kZXMpIHtcclxuICAgICAgICB0cmF2ZXJzZShjaGlsZCk7XHJcbiAgICAgIH1cclxuICAgIH1cclxuICB9XHJcblxyXG4gIHRyYXZlcnNlKGVsZW1lbnQpO1xyXG4gIHJldHVybiB0ZXh0LnJlcGxhY2UoL1xccysvZywgXCIgXCIpLnRyaW0oKTtcclxufVxyXG5cclxuLyoqXHJcbiAqIEdldCBkaXJlY3QgdGV4dCBjb250ZW50IG9mIGFuIGVsZW1lbnQgKGV4Y2x1ZGluZyB0ZXh0IGZyb20gY2hpbGRyZW4pXHJcbiAqIEBwYXJhbSBlbGVtZW50IC0gVGhlIGVsZW1lbnQgdG8gZXh0cmFjdCB0ZXh0IGZyb21cclxuICogQHJldHVybnMgRGlyZWN0IHRleHQgY29udGVudCBvbmx5XHJcbiAqL1xyXG5leHBvcnQgZnVuY3Rpb24gZ2V0RGlyZWN0VGV4dENvbnRlbnQoZWxlbWVudDogRWxlbWVudCk6IHN0cmluZyB7XHJcbiAgbGV0IHRleHQgPSBcIlwiO1xyXG4gIGZvciAoY29uc3Qgbm9kZSBvZiBlbGVtZW50LmNoaWxkTm9kZXMpIHtcclxuICAgIGlmIChub2RlLm5vZGVUeXBlID09PSBOb2RlLlRFWFRfTk9ERSkge1xyXG4gICAgICB0ZXh0ICs9IG5vZGUudGV4dENvbnRlbnQ7XHJcbiAgICB9XHJcbiAgfVxyXG4gIHJldHVybiB0ZXh0O1xyXG59XHJcblxyXG4vKipcclxuICogR2V0IHZpc2libGUgdGV4dCBmcm9tIGFuIGVsZW1lbnQsIHNraXBwaW5nIGhpZGRlbiBlbGVtZW50c1xyXG4gKiBAcGFyYW0gZWxlbWVudCAtIFRoZSBlbGVtZW50IHRvIGV4dHJhY3QgdGV4dCBmcm9tXHJcbiAqIEByZXR1cm5zIFZpc2libGUgdGV4dCBjb250ZW50IHdpdGggbm9ybWFsaXplZCB3aGl0ZXNwYWNlXHJcbiAqL1xyXG5leHBvcnQgZnVuY3Rpb24gZ2V0VmlzaWJsZVRleHQoZWxlbWVudDogRWxlbWVudCk6IHN0cmluZyB7XHJcbiAgLy8gU2tpcCBoaWRkZW4gZWxlbWVudHNcclxuICBjb25zdCBzdHlsZSA9IHdpbmRvdy5nZXRDb21wdXRlZFN0eWxlKGVsZW1lbnQpO1xyXG4gIGlmIChcclxuICAgIHN0eWxlLmRpc3BsYXkgPT09IFwibm9uZVwiIHx8XHJcbiAgICBzdHlsZS52aXNpYmlsaXR5ID09PSBcImhpZGRlblwiIHx8XHJcbiAgICBzdHlsZS5vcGFjaXR5ID09PSBcIjBcIlxyXG4gICkge1xyXG4gICAgcmV0dXJuIFwiXCI7XHJcbiAgfVxyXG5cclxuICAvLyBHZXQgdGV4dCBjb250ZW50LCBwcmVzZXJ2aW5nIHNvbWUgc3RydWN0dXJlXHJcbiAgbGV0IHRleHQgPSBcIlwiO1xyXG4gIGNvbnN0IHdhbGtlciA9IGRvY3VtZW50LmNyZWF0ZVRyZWVXYWxrZXIoZWxlbWVudCwgTm9kZUZpbHRlci5TSE9XX1RFWFQsIHtcclxuICAgIGFjY2VwdE5vZGU6IChub2RlOiBOb2RlKTogbnVtYmVyID0+IHtcclxuICAgICAgY29uc3QgcGFyZW50ID0gbm9kZS5wYXJlbnRFbGVtZW50O1xyXG4gICAgICBpZiAoIXBhcmVudCkgcmV0dXJuIE5vZGVGaWx0ZXIuRklMVEVSX1JFSkVDVDtcclxuXHJcbiAgICAgIGNvbnN0IHBhcmVudFN0eWxlID0gd2luZG93LmdldENvbXB1dGVkU3R5bGUocGFyZW50KTtcclxuICAgICAgaWYgKFxyXG4gICAgICAgIHBhcmVudFN0eWxlLmRpc3BsYXkgPT09IFwibm9uZVwiIHx8XHJcbiAgICAgICAgcGFyZW50U3R5bGUudmlzaWJpbGl0eSA9PT0gXCJoaWRkZW5cIlxyXG4gICAgICApIHtcclxuICAgICAgICByZXR1cm4gTm9kZUZpbHRlci5GSUxURVJfUkVKRUNUO1xyXG4gICAgICB9XHJcblxyXG4gICAgICByZXR1cm4gTm9kZUZpbHRlci5GSUxURVJfQUNDRVBUO1xyXG4gICAgfSxcclxuICB9KTtcclxuXHJcbiAgbGV0IGN1cnJlbnROb2RlOiBOb2RlIHwgbnVsbDtcclxuICB3aGlsZSAoKGN1cnJlbnROb2RlID0gd2Fsa2VyLm5leHROb2RlKCkpKSB7XHJcbiAgICB0ZXh0ICs9IGN1cnJlbnROb2RlLnRleHRDb250ZW50ICsgXCIgXCI7XHJcbiAgfVxyXG5cclxuICByZXR1cm4gdGV4dC5yZXBsYWNlKC9cXHMrL2csIFwiIFwiKS50cmltKCk7XHJcbn1cclxuXHJcbi8qKlxyXG4gKiBFeHRyYWN0IGFjY2Vzc2liaWxpdHkgZGVzY3JpcHRpb25zIGZyb20gZHluYW1pYyBncmFwaGljcyAoU1ZHIGRpYWdyYW1zKVxyXG4gKiBOZXRBY2FkIHVzZXMgYTExeV9kZXNjcmlwdGlvbiBkaXZzIHRvIGRlc2NyaWJlIHRvcG9sb2d5IGltYWdlc1xyXG4gKiBAcGFyYW0gcm9vdCAtIFJvb3QgZWxlbWVudCB0byBzZWFyY2hcclxuICogQHJldHVybnMgQ29tYmluZWQgYWNjZXNzaWJpbGl0eSBkZXNjcmlwdGlvbnNcclxuICovXHJcbmV4cG9ydCBmdW5jdGlvbiBleHRyYWN0QWNjZXNzaWJpbGl0eURlc2NyaXB0aW9ucyhcclxuICByb290OiBFbGVtZW50IHwgU2hhZG93Um9vdFxyXG4pOiBzdHJpbmcge1xyXG4gIGNvbnN0IGRlc2NyaXB0aW9uczogc3RyaW5nW10gPSBbXTtcclxuICBjb25zdCBzZWVuVGV4dHMgPSBuZXcgU2V0PHN0cmluZz4oKTtcclxuXHJcbiAgZnVuY3Rpb24gYWRkRGVzY3JpcHRpb24odGV4dDogc3RyaW5nIHwgbnVsbCB8IHVuZGVmaW5lZCk6IHZvaWQge1xyXG4gICAgY29uc3QgdHJpbW1lZCA9IHRleHQ/LnRyaW0oKTtcclxuICAgIGlmICh0cmltbWVkICYmIHRyaW1tZWQubGVuZ3RoID4gMjAgJiYgIXNlZW5UZXh0cy5oYXModHJpbW1lZCkpIHtcclxuICAgICAgc2VlblRleHRzLmFkZCh0cmltbWVkKTtcclxuICAgICAgZGVzY3JpcHRpb25zLnB1c2godHJpbW1lZCk7XHJcbiAgICB9XHJcbiAgfVxyXG5cclxuICAvKipcclxuICAgKiBEZWVwIHJlY3Vyc2l2ZSBzZWFyY2ggZm9yIGExMXlfZGVzY3JpcHRpb24gZWxlbWVudHNcclxuICAgKi9cclxuICBmdW5jdGlvbiBzZWFyY2hJbkVsZW1lbnQoZWxlbWVudDogRWxlbWVudCB8IFNoYWRvd1Jvb3QgfCBudWxsKTogdm9pZCB7XHJcbiAgICBpZiAoIWVsZW1lbnQpIHJldHVybjtcclxuXHJcbiAgICAvLyBTZWFyY2ggaW4gdGhlIGVsZW1lbnQncyBvd24gY29udGVudCAob25seSBmb3IgRWxlbWVudCwgbm90IFNoYWRvd1Jvb3QpXHJcbiAgICBpZiAoZWxlbWVudCBpbnN0YW5jZW9mIEVsZW1lbnQgJiYgZWxlbWVudC5jbGFzc0xpc3Q/LmNvbnRhaW5zKFwiYTExeV9kZXNjcmlwdGlvblwiKSkge1xyXG4gICAgICBhZGREZXNjcmlwdGlvbihlbGVtZW50LnRleHRDb250ZW50KTtcclxuICAgIH1cclxuXHJcbiAgICAvLyBTZWFyY2ggY2hpbGRyZW5cclxuICAgIGNvbnN0IGNoaWxkcmVuID0gZWxlbWVudC5xdWVyeVNlbGVjdG9yQWxsPy4oXCIuYTExeV9kZXNjcmlwdGlvblwiKTtcclxuICAgIGlmIChjaGlsZHJlbikge1xyXG4gICAgICBmb3IgKGNvbnN0IGVsIG9mIGNoaWxkcmVuKSB7XHJcbiAgICAgICAgYWRkRGVzY3JpcHRpb24oZWwudGV4dENvbnRlbnQpO1xyXG4gICAgICB9XHJcbiAgICB9XHJcblxyXG4gICAgLy8gU2VhcmNoIGluIHNoYWRvdyByb290IGlmIGV4aXN0cyAob25seSBmb3IgRWxlbWVudClcclxuICAgIGlmIChlbGVtZW50IGluc3RhbmNlb2YgRWxlbWVudCAmJiBlbGVtZW50LnNoYWRvd1Jvb3QpIHtcclxuICAgICAgY29uc3Qgc2hhZG93QTExeSA9XHJcbiAgICAgICAgZWxlbWVudC5zaGFkb3dSb290LnF1ZXJ5U2VsZWN0b3JBbGwoXCIuYTExeV9kZXNjcmlwdGlvblwiKTtcclxuICAgICAgZm9yIChjb25zdCBlbCBvZiBzaGFkb3dBMTF5KSB7XHJcbiAgICAgICAgYWRkRGVzY3JpcHRpb24oZWwudGV4dENvbnRlbnQpO1xyXG4gICAgICB9XHJcblxyXG4gICAgICAvLyBSZWN1cnNpdmVseSBzZWFyY2ggZWxlbWVudHMgaW5zaWRlIHNoYWRvdyByb290XHJcbiAgICAgIGNvbnN0IHNoYWRvd0VsZW1lbnRzID0gZWxlbWVudC5zaGFkb3dSb290LnF1ZXJ5U2VsZWN0b3JBbGwoXCIqXCIpO1xyXG4gICAgICBmb3IgKGNvbnN0IGVsIG9mIHNoYWRvd0VsZW1lbnRzKSB7XHJcbiAgICAgICAgc2VhcmNoSW5FbGVtZW50KGVsKTtcclxuICAgICAgfVxyXG4gICAgfVxyXG4gIH1cclxuXHJcbiAgLy8gU2VhcmNoIGluIHRoZSBwcm92aWRlZCByb290XHJcbiAgc2VhcmNoSW5FbGVtZW50KHJvb3QpO1xyXG5cclxuICAvLyBBbHNvIHNlYXJjaCBmb3IgYXJpYS1sYWJlbGxlZGJ5IHJlZmVyZW5jZXNcclxuICBjb25zdCBmaWd1cmVFbGVtZW50cyA9IHF1ZXJ5U2VsZWN0b3JBbGxEZWVwKFwiW3JvbGU9J2ZpZ3VyZSddXCIsIHJvb3QpO1xyXG4gIGZvciAoY29uc3QgZmlnIG9mIGZpZ3VyZUVsZW1lbnRzKSB7XHJcbiAgICBjb25zdCBhcmlhTGFiZWwgPSBmaWcuZ2V0QXR0cmlidXRlKFwiYXJpYS1sYWJlbGxlZGJ5XCIpO1xyXG4gICAgaWYgKGFyaWFMYWJlbCkge1xyXG4gICAgICBjb25zdCBsYWJlbEVsID0gcXVlcnlTZWxlY3RvckFsbERlZXAoYCMke2FyaWFMYWJlbH1gLCByb290KVswXTtcclxuICAgICAgaWYgKGxhYmVsRWwpIHtcclxuICAgICAgICBhZGREZXNjcmlwdGlvbihsYWJlbEVsLnRleHRDb250ZW50KTtcclxuICAgICAgfVxyXG4gICAgfVxyXG4gIH1cclxuXHJcbiAgLy8gU2VhcmNoIGZvciBkeW5hbWljLWdyYXBoaWMtdmlldyBlbGVtZW50cyBzcGVjaWZpY2FsbHlcclxuICBjb25zdCBkeW5hbWljR3JhcGhpY3MgPSBxdWVyeVNlbGVjdG9yQWxsRGVlcChcImR5bmFtaWMtZ3JhcGhpYy12aWV3XCIsIHJvb3QpO1xyXG4gIGZvciAoY29uc3QgZ3JhcGhpYyBvZiBkeW5hbWljR3JhcGhpY3MpIHtcclxuICAgIHNlYXJjaEluRWxlbWVudChncmFwaGljKTtcclxuICB9XHJcblxyXG4gIC8vIFNlYXJjaCBmb3IgdGFicy12aWV3IGFuZCBpbmxpbmUtc3ZnLXZpZXdlciBlbGVtZW50c1xyXG4gIGNvbnN0IHRhYnNWaWV3cyA9IHF1ZXJ5U2VsZWN0b3JBbGxEZWVwKFwidGFicy12aWV3XCIsIHJvb3QpO1xyXG4gIGZvciAoY29uc3QgdGFicyBvZiB0YWJzVmlld3MpIHtcclxuICAgIHNlYXJjaEluRWxlbWVudCh0YWJzKTtcclxuICB9XHJcblxyXG4gIGlmIChkZXNjcmlwdGlvbnMubGVuZ3RoID4gMCkge1xyXG4gICAgbG9nKFxyXG4gICAgICBcIltTdHVkeSBBc3Npc3RdIEZvdW5kIGFjY2Vzc2liaWxpdHkgZGVzY3JpcHRpb25zOlwiLFxyXG4gICAgICBkZXNjcmlwdGlvbnMubGVuZ3RoXHJcbiAgICApO1xyXG4gIH1cclxuXHJcbiAgcmV0dXJuIGRlc2NyaXB0aW9ucy5qb2luKFwiXFxuXFxuXCIpO1xyXG59XHJcblxyXG4vLyA9PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PVxyXG4vLyBWaXNpYmlsaXR5IFV0aWxpdGllc1xyXG4vLyA9PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PVxyXG5cclxuLyoqXHJcbiAqIENoZWNrIGhvdyBtdWNoIG9mIGFuIGVsZW1lbnQgaXMgdmlzaWJsZSBpbiB2aWV3cG9ydCAoMC0xKVxyXG4gKiBAcGFyYW0gZWxlbWVudCAtIFRoZSBlbGVtZW50IHRvIGNoZWNrXHJcbiAqIEByZXR1cm5zIFZpc2liaWxpdHkgc2NvcmUgZnJvbSAwIChub3QgdmlzaWJsZSkgdG8gMSAoZnVsbHkgdmlzaWJsZSBhbmQgY2VudGVyZWQpXHJcbiAqL1xyXG5leHBvcnQgZnVuY3Rpb24gZ2V0VmlzaWJpbGl0eVNjb3JlKGVsZW1lbnQ6IEVsZW1lbnQpOiBudW1iZXIge1xyXG4gIGNvbnN0IHJlY3QgPSBlbGVtZW50LmdldEJvdW5kaW5nQ2xpZW50UmVjdCgpO1xyXG4gIGNvbnN0IHdpbmRvd0hlaWdodCA9IHdpbmRvdy5pbm5lckhlaWdodDtcclxuICBjb25zdCB3aW5kb3dXaWR0aCA9IHdpbmRvdy5pbm5lcldpZHRoO1xyXG5cclxuICAvLyBFbGVtZW50IGlzIGNvbXBsZXRlbHkgb3V0c2lkZSB2aWV3cG9ydFxyXG4gIGlmIChcclxuICAgIHJlY3QuYm90dG9tIDwgMCB8fFxyXG4gICAgcmVjdC50b3AgPiB3aW5kb3dIZWlnaHQgfHxcclxuICAgIHJlY3QucmlnaHQgPCAwIHx8XHJcbiAgICByZWN0LmxlZnQgPiB3aW5kb3dXaWR0aFxyXG4gICkge1xyXG4gICAgcmV0dXJuIDA7XHJcbiAgfVxyXG5cclxuICAvLyBDYWxjdWxhdGUgdmlzaWJsZSBhcmVhXHJcbiAgY29uc3QgdmlzaWJsZVRvcCA9IE1hdGgubWF4KDAsIHJlY3QudG9wKTtcclxuICBjb25zdCB2aXNpYmxlQm90dG9tID0gTWF0aC5taW4od2luZG93SGVpZ2h0LCByZWN0LmJvdHRvbSk7XHJcbiAgY29uc3QgdmlzaWJsZUxlZnQgPSBNYXRoLm1heCgwLCByZWN0LmxlZnQpO1xyXG4gIGNvbnN0IHZpc2libGVSaWdodCA9IE1hdGgubWluKHdpbmRvd1dpZHRoLCByZWN0LnJpZ2h0KTtcclxuXHJcbiAgY29uc3QgdmlzaWJsZUhlaWdodCA9IHZpc2libGVCb3R0b20gLSB2aXNpYmxlVG9wO1xyXG4gIGNvbnN0IHZpc2libGVXaWR0aCA9IHZpc2libGVSaWdodCAtIHZpc2libGVMZWZ0O1xyXG4gIGNvbnN0IHZpc2libGVBcmVhID0gdmlzaWJsZUhlaWdodCAqIHZpc2libGVXaWR0aDtcclxuXHJcbiAgY29uc3QgZWxlbWVudEFyZWEgPSByZWN0LndpZHRoICogcmVjdC5oZWlnaHQ7XHJcbiAgaWYgKGVsZW1lbnRBcmVhID09PSAwKSByZXR1cm4gMDtcclxuXHJcbiAgLy8gRmF2b3IgZWxlbWVudHMgY2xvc2VyIHRvIGNlbnRlciBvZiBzY3JlZW5cclxuICBjb25zdCBjZW50ZXJZID0gKHJlY3QudG9wICsgcmVjdC5ib3R0b20pIC8gMjtcclxuICBjb25zdCBzY3JlZW5DZW50ZXJZID0gd2luZG93SGVpZ2h0IC8gMjtcclxuICBjb25zdCBjZW50ZXJCb251cyA9IDEgLSBNYXRoLmFicyhjZW50ZXJZIC0gc2NyZWVuQ2VudGVyWSkgLyB3aW5kb3dIZWlnaHQ7XHJcblxyXG4gIHJldHVybiAodmlzaWJsZUFyZWEgLyBlbGVtZW50QXJlYSkgKiAwLjcgKyBjZW50ZXJCb251cyAqIDAuMztcclxufVxyXG5cclxuLy8gPT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT1cclxuLy8gRWxlbWVudCBSZWxhdGlvbnNoaXAgVXRpbGl0aWVzXHJcbi8vID09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09XHJcblxyXG4vKipcclxuICogQ2hlY2sgaWYgYW4gZWxlbWVudCBpcyBhIGNoaWxkIG9mIGFueSBwcm9jZXNzZWQgcXVlc3Rpb24gZWxlbWVudFxyXG4gKiBAcGFyYW0gZWxlbWVudCAtIFRoZSBlbGVtZW50IHRvIGNoZWNrXHJcbiAqIEBwYXJhbSBkZXRlY3RlZFF1ZXN0aW9ucyAtIEFycmF5IG9mIGRldGVjdGVkIHF1ZXN0aW9uIG9iamVjdHMgd2l0aCBlbGVtZW50IHByb3BlcnR5XHJcbiAqIEByZXR1cm5zIFRydWUgaWYgZWxlbWVudCBpcyBjb250YWluZWQgd2l0aGluIGEgcHJvY2Vzc2VkIHF1ZXN0aW9uXHJcbiAqL1xyXG5leHBvcnQgZnVuY3Rpb24gaXNDaGlsZE9mUHJvY2Vzc2VkKFxyXG4gIGVsZW1lbnQ6IEVsZW1lbnQsXHJcbiAgZGV0ZWN0ZWRRdWVzdGlvbnM6IERldGVjdGVkUXVlc3Rpb25bXVxyXG4pOiBib29sZWFuIHtcclxuICBmb3IgKGNvbnN0IHEgb2YgZGV0ZWN0ZWRRdWVzdGlvbnMpIHtcclxuICAgIGlmIChxLmVsZW1lbnQuY29udGFpbnMoZWxlbWVudCkgJiYgcS5lbGVtZW50ICE9PSBlbGVtZW50KSB7XHJcbiAgICAgIHJldHVybiB0cnVlO1xyXG4gICAgfVxyXG4gIH1cclxuICByZXR1cm4gZmFsc2U7XHJcbn1cclxuXHJcbi8vID09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09XHJcbi8vIFRleHQgRm9ybWF0dGluZyBVdGlsaXRpZXNcclxuLy8gPT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT1cclxuXHJcbi8qKlxyXG4gKiBGb3JtYXQgcXVlc3Rpb24gdHlwZSBmb3IgZGlzcGxheSB3aXRoIGVtb2ppXHJcbiAqIEBwYXJhbSB0eXBlIC0gVGhlIHF1ZXN0aW9uIHR5cGUgaWRlbnRpZmllclxyXG4gKiBAcmV0dXJucyBGb3JtYXR0ZWQgcXVlc3Rpb24gdHlwZSB3aXRoIGVtb2ppXHJcbiAqL1xyXG5leHBvcnQgZnVuY3Rpb24gZm9ybWF0UXVlc3Rpb25UeXBlKHR5cGU6IFF1ZXN0aW9uVHlwZSB8IHN0cmluZyk6IHN0cmluZyB7XHJcbiAgY29uc3QgdHlwZXM6IFJlY29yZDxzdHJpbmcsIHN0cmluZz4gPSB7XHJcbiAgICBcIm11bHRpcGxlLWNob2ljZVwiOiBcIlx1RDgzRFx1RENDQiBNdWx0aXBsZSBDaG9pY2VcIixcclxuICAgIFwidHJ1ZS1mYWxzZVwiOiBcIlx1MjcxM1x1MjcxNyBUcnVlL0ZhbHNlXCIsXHJcbiAgICBcImZpbGwtYmxhbmtcIjogXCJcdUQ4M0RcdURDREQgRmlsbCBpbiB0aGUgQmxhbmtcIixcclxuICAgIHVua25vd246IFwiXHUyNzUzIFF1ZXN0aW9uXCIsXHJcbiAgfTtcclxuICByZXR1cm4gdHlwZXNbdHlwZV0gfHwgdHlwZXNbXCJ1bmtub3duXCJdO1xyXG59XHJcblxyXG4vKipcclxuICogVHJ1bmNhdGUgdGV4dCB0byBhIG1heGltdW0gbGVuZ3RoIHdpdGggZWxsaXBzaXNcclxuICogQHBhcmFtIHRleHQgLSBUaGUgdGV4dCB0byB0cnVuY2F0ZVxyXG4gKiBAcGFyYW0gbWF4TGVuZ3RoIC0gTWF4aW11bSBsZW5ndGggYmVmb3JlIHRydW5jYXRpb25cclxuICogQHJldHVybnMgVHJ1bmNhdGVkIHRleHQgd2l0aCBlbGxpcHNpcyBpZiBuZWVkZWRcclxuICovXHJcbmV4cG9ydCBmdW5jdGlvbiB0cnVuY2F0ZVRleHQodGV4dDogc3RyaW5nLCBtYXhMZW5ndGg6IG51bWJlcik6IHN0cmluZyB7XHJcbiAgaWYgKHRleHQubGVuZ3RoIDw9IG1heExlbmd0aCkgcmV0dXJuIHRleHQ7XHJcbiAgcmV0dXJuIHRleHQuc3Vic3RyaW5nKDAsIG1heExlbmd0aCkudHJpbSgpICsgXCIuLi5cIjtcclxufVxyXG5cclxuLyoqXHJcbiAqIEVzY2FwZSBIVE1MIHNwZWNpYWwgY2hhcmFjdGVycyB0byBwcmV2ZW50IFhTU1xyXG4gKiBAcGFyYW0gdGV4dCAtIFRoZSB0ZXh0IHRvIGVzY2FwZVxyXG4gKiBAcmV0dXJucyBIVE1MLWVzY2FwZWQgdGV4dFxyXG4gKi9cclxuZXhwb3J0IGZ1bmN0aW9uIGVzY2FwZUh0bWwodGV4dDogc3RyaW5nKTogc3RyaW5nIHtcclxuICBjb25zdCBkaXYgPSBkb2N1bWVudC5jcmVhdGVFbGVtZW50KFwiZGl2XCIpO1xyXG4gIGRpdi50ZXh0Q29udGVudCA9IHRleHQ7XHJcbiAgcmV0dXJuIGRpdi5pbm5lckhUTUw7XHJcbn1cclxuXHJcbi8qKlxyXG4gKiBGb3JtYXQgQUkgYW5hbHlzaXMgcmVzdWx0IHdpdGggYmFzaWMgbWFya2Rvd24tdG8tSFRNTCBjb252ZXJzaW9uXHJcbiAqIENvbnZlcnRzIGJvbGQsIGl0YWxpYywgYW5kIGxpbmUgYnJlYWtzIHRvIEhUTUxcclxuICogQHBhcmFtIHJlc3VsdCAtIFRoZSBhbmFseXNpcyByZXN1bHQgdGV4dCB3aXRoIG1hcmtkb3duIGZvcm1hdHRpbmdcclxuICogQHJldHVybnMgSFRNTC1mb3JtYXR0ZWQgcmVzdWx0XHJcbiAqL1xyXG5leHBvcnQgZnVuY3Rpb24gZm9ybWF0QW5hbHlzaXNSZXN1bHQocmVzdWx0OiBzdHJpbmcpOiBzdHJpbmcge1xyXG4gIC8vIENvbnZlcnQgbWFya2Rvd24tc3R5bGUgZm9ybWF0dGluZyB0byBIVE1MXHJcbiAgbGV0IGZvcm1hdHRlZCA9IGVzY2FwZUh0bWwocmVzdWx0KTtcclxuXHJcbiAgLy8gQm9sZCB0ZXh0OiAqKnRleHQqKiBvciBfX3RleHRfX1xyXG4gIGZvcm1hdHRlZCA9IGZvcm1hdHRlZC5yZXBsYWNlKC9cXCpcXCooLis/KVxcKlxcKi9nLCBcIjxzdHJvbmc+JDE8L3N0cm9uZz5cIik7XHJcbiAgZm9ybWF0dGVkID0gZm9ybWF0dGVkLnJlcGxhY2UoL19fKC4rPylfXy9nLCBcIjxzdHJvbmc+JDE8L3N0cm9uZz5cIik7XHJcblxyXG4gIC8vIEl0YWxpYyB0ZXh0OiAqdGV4dCogb3IgX3RleHRfXHJcbiAgZm9ybWF0dGVkID0gZm9ybWF0dGVkLnJlcGxhY2UoL1xcKiguKz8pXFwqL2csIFwiPGVtPiQxPC9lbT5cIik7XHJcbiAgZm9ybWF0dGVkID0gZm9ybWF0dGVkLnJlcGxhY2UoL18oLis/KV8vZywgXCI8ZW0+JDE8L2VtPlwiKTtcclxuXHJcbiAgLy8gTGluZSBicmVha3NcclxuICBmb3JtYXR0ZWQgPSBmb3JtYXR0ZWQucmVwbGFjZSgvXFxuXFxuL2csIFwiPC9wPjxwPlwiKTtcclxuICBmb3JtYXR0ZWQgPSBmb3JtYXR0ZWQucmVwbGFjZSgvXFxuL2csIFwiPGJyPlwiKTtcclxuXHJcbiAgLy8gV3JhcCBpbiBwYXJhZ3JhcGhcclxuICBmb3JtYXR0ZWQgPSBgPHA+JHtmb3JtYXR0ZWR9PC9wPmA7XHJcblxyXG4gIHJldHVybiBmb3JtYXR0ZWQ7XHJcbn1cclxuIiwgIi8qKlxyXG4gKiBJbWFnZXMgTW9kdWxlXHJcbiAqIEhhbmRsZXMgaW1hZ2UgZXh0cmFjdGlvbiBhbmQgY29udmVyc2lvbiBmb3Igc2VuZGluZyB0byBBSSBBUElzLlxyXG4gKiBQcmVmZXJzIHNlbmRpbmcgcHVibGljIFVSTHMgZGlyZWN0bHkgKHNhdmVzIHRva2VucyksIGZhbGxzIGJhY2sgdG8gYmFzZTY0LlxyXG4gKi9cclxuXHJcbmltcG9ydCB0eXBlIHsgSW1hZ2VEYXRhIH0gZnJvbSBcIi4uLy4uL3R5cGVzL2luZGV4LmpzXCI7XHJcbmltcG9ydCB7IHF1ZXJ5U2VsZWN0b3JBbGxEZWVwIH0gZnJvbSBcIi4vdXRpbHMuanNcIjtcclxuXHJcbi8qKlxyXG4gKiBDaGVjayBpZiBhIFVSTCBpcyBhIHB1YmxpY2x5IGFjY2Vzc2libGUgSFRUUChTKSBVUkwgdGhhdCBDbGF1ZGUgY2FuIGZldGNoLlxyXG4gKiBFeGNsdWRlcyBkYXRhIFVSSXMsIGJsb2IgVVJJcywgZXh0ZW5zaW9uIFVSTHMsIGFuZCBsb2NhbGhvc3QuXHJcbiAqL1xyXG5leHBvcnQgZnVuY3Rpb24gaXNQdWJsaWNJbWFnZVVybChzcmM6IHN0cmluZyk6IGJvb2xlYW4ge1xyXG4gIGlmICghc3JjKSByZXR1cm4gZmFsc2U7XHJcbiAgdHJ5IHtcclxuICAgIGNvbnN0IHVybCA9IG5ldyBVUkwoc3JjKTtcclxuICAgIGlmICh1cmwucHJvdG9jb2wgIT09IFwiaHR0cHM6XCIgJiYgdXJsLnByb3RvY29sICE9PSBcImh0dHA6XCIpIHJldHVybiBmYWxzZTtcclxuICAgIGNvbnN0IGhvc3QgPSB1cmwuaG9zdG5hbWUudG9Mb3dlckNhc2UoKTtcclxuICAgIGlmIChob3N0ID09PSBcImxvY2FsaG9zdFwiIHx8IGhvc3QgPT09IFwiMTI3LjAuMC4xXCIgfHwgaG9zdCA9PT0gXCJbOjoxXVwiKSByZXR1cm4gZmFsc2U7XHJcbiAgICAvLyBFeGNsdWRlIGV4dGVuc2lvbi1pbnRlcm5hbCBVUkxzXHJcbiAgICBpZiAoc3JjLnN0YXJ0c1dpdGgoXCJjaHJvbWUtZXh0ZW5zaW9uOi8vXCIpIHx8IHNyYy5zdGFydHNXaXRoKFwibW96LWV4dGVuc2lvbjovL1wiKSkgcmV0dXJuIGZhbHNlO1xyXG4gICAgcmV0dXJuIHRydWU7XHJcbiAgfSBjYXRjaCB7XHJcbiAgICByZXR1cm4gZmFsc2U7XHJcbiAgfVxyXG59XHJcblxyXG4vKipcclxuICogRXh0cmFjdCBhbGwgcmVsZXZhbnQgaW1hZ2VzIGZyb20gYSByb290IGVsZW1lbnQgYW5kIGNvbnZlcnQgdGhlbSB0byBiYXNlNjRcclxuICogQHBhcmFtIHJvb3QgLSBUaGUgcm9vdCBlbGVtZW50IHRvIHNlYXJjaCBmb3IgaW1hZ2VzXHJcbiAqIEByZXR1cm5zIEFycmF5IG9mIGJhc2U2NC1lbmNvZGVkIGltYWdlc1xyXG4gKi9cclxuZXhwb3J0IGFzeW5jIGZ1bmN0aW9uIGV4dHJhY3RJbWFnZXNBc0Jhc2U2NChyb290OiBFbGVtZW50KTogUHJvbWlzZTxJbWFnZURhdGFbXT4ge1xyXG4gIGNvbnN0IGltYWdlczogSW1hZ2VEYXRhW10gPSBbXTtcclxuXHJcbiAgLy8gRmluZCBhbGwgaW1nIGVsZW1lbnRzIChkZWVwIHNlYXJjaClcclxuICBjb25zdCBpbWdFbGVtZW50cyA9IHF1ZXJ5U2VsZWN0b3JBbGxEZWVwKFwiaW1nXCIsIHJvb3QpIGFzIEhUTUxJbWFnZUVsZW1lbnRbXTtcclxuXHJcbiAgZm9yIChjb25zdCBpbWcgb2YgaW1nRWxlbWVudHMpIHtcclxuICAgIHRyeSB7XHJcbiAgICAgIC8vIEdldCB0aGUgaW1hZ2Ugc291cmNlXHJcbiAgICAgIGNvbnN0IGltZ1NyYzogc3RyaW5nID0gaW1nLnNyYztcclxuXHJcbiAgICAgIC8vIFNraXAgZGF0YSBVUklzIHRoYXQgYXJlIHRvbyBzbWFsbCAoaWNvbnMpXHJcbiAgICAgIGlmIChpbWdTcmMuc3RhcnRzV2l0aChcImRhdGE6XCIpICYmIGltZ1NyYy5sZW5ndGggPCA1MDApIHtcclxuICAgICAgICBjb250aW51ZTtcclxuICAgICAgfVxyXG5cclxuICAgICAgLy8gU2tpcCBrbm93biBpY29uIHBhdHRlcm5zXHJcbiAgICAgIGlmIChcclxuICAgICAgICBpbWdTcmMuaW5jbHVkZXMoXCJpY29uXCIpIHx8XHJcbiAgICAgICAgaW1nU3JjLmluY2x1ZGVzKFwibG9nb1wiKSB8fFxyXG4gICAgICAgIGltZ1NyYy5pbmNsdWRlcyhcImF2YXRhclwiKVxyXG4gICAgICApIHtcclxuICAgICAgICBjb250aW51ZTtcclxuICAgICAgfVxyXG5cclxuICAgICAgLy8gV2FpdCBmb3IgaW1hZ2UgdG8gbG9hZCBpZiBuZWVkZWRcclxuICAgICAgaWYgKCFpbWcuY29tcGxldGUpIHtcclxuICAgICAgICBhd2FpdCBuZXcgUHJvbWlzZTx2b2lkPigocmVzb2x2ZSkgPT4ge1xyXG4gICAgICAgICAgaW1nLm9ubG9hZCA9ICgpID0+IHJlc29sdmUoKTtcclxuICAgICAgICAgIGltZy5vbmVycm9yID0gKCkgPT4gcmVzb2x2ZSgpO1xyXG4gICAgICAgICAgLy8gVGltZW91dCBhZnRlciAzIHNlY29uZHNcclxuICAgICAgICAgIHNldFRpbWVvdXQocmVzb2x2ZSwgMzAwMCk7XHJcbiAgICAgICAgfSk7XHJcbiAgICAgIH1cclxuXHJcbiAgICAgIC8vIENoZWNrIGRpbWVuc2lvbnMgYWZ0ZXIgbG9hZGluZyAoYnV0IGJlIG1vcmUgbGVuaWVudClcclxuICAgICAgY29uc3Qgd2lkdGg6IG51bWJlciA9IGltZy5uYXR1cmFsV2lkdGggfHwgaW1nLndpZHRoIHx8IDEwMDtcclxuICAgICAgY29uc3QgaGVpZ2h0OiBudW1iZXIgPSBpbWcubmF0dXJhbEhlaWdodCB8fCBpbWcuaGVpZ2h0IHx8IDEwMDtcclxuXHJcbiAgICAgIGlmICh3aWR0aCA8IDMwIHx8IGhlaWdodCA8IDMwKSB7XHJcbiAgICAgICAgY29udGludWU7XHJcbiAgICAgIH1cclxuXHJcbiAgICAgIC8vIElmIGltYWdlIGlzIHB1YmxpY2x5IGFjY2Vzc2libGUsIHVzZSBVUkwgZGlyZWN0bHkgKG5vIGJhc2U2NCBjb252ZXJzaW9uIG5lZWRlZClcclxuICAgICAgaWYgKGlzUHVibGljSW1hZ2VVcmwoaW1nU3JjKSkge1xyXG4gICAgICAgIGltYWdlcy5wdXNoKHtcclxuICAgICAgICAgIHVybDogaW1nU3JjLFxyXG4gICAgICAgICAgbWVkaWFUeXBlOiBcImltYWdlL2pwZWdcIiwgLy8gQ2xhdWRlIGRvZXNuJ3QgbmVlZCB0aGlzIGZvciBVUkwgdHlwZVxyXG4gICAgICAgIH0pO1xyXG4gICAgICB9IGVsc2Uge1xyXG4gICAgICAgIC8vIEZvciBub24tcHVibGljIGltYWdlcyAoZGF0YTosIGJsb2I6LCBDT1JTLXJlc3RyaWN0ZWQpLCBjb252ZXJ0IHRvIGJhc2U2NFxyXG4gICAgICAgIGNvbnN0IGJhc2U2NERhdGEgPSBhd2FpdCBpbWFnZVRvQmFzZTY0KGltZyk7XHJcbiAgICAgICAgaWYgKGJhc2U2NERhdGEpIHtcclxuICAgICAgICAgIGltYWdlcy5wdXNoKGJhc2U2NERhdGEpO1xyXG4gICAgICAgIH1cclxuICAgICAgfVxyXG4gICAgfSBjYXRjaCAoZXJyb3IpIHtcclxuICAgICAgY29uc29sZS53YXJuKFwiW1N0dWR5IEFzc2lzdF0gRmFpbGVkIHRvIGV4dHJhY3QgaW1hZ2U6XCIsIGVycm9yKTtcclxuICAgIH1cclxuICB9XHJcblxyXG4gIHJldHVybiBpbWFnZXM7XHJcbn1cclxuXHJcbi8qKlxyXG4gKiBDb252ZXJ0IGFuIGltYWdlIGVsZW1lbnQgdG8gYmFzZTY0XHJcbiAqIEBwYXJhbSBpbWcgLSBJbWFnZSBlbGVtZW50IHRvIGNvbnZlcnRcclxuICogQHJldHVybnMgQmFzZTY0IGRhdGEgb3IgbnVsbCBpZiBjb252ZXJzaW9uIGZhaWxzXHJcbiAqL1xyXG5leHBvcnQgYXN5bmMgZnVuY3Rpb24gaW1hZ2VUb0Jhc2U2NChpbWc6IEhUTUxJbWFnZUVsZW1lbnQpOiBQcm9taXNlPEltYWdlRGF0YSB8IG51bGw+IHtcclxuICByZXR1cm4gbmV3IFByb21pc2UoKHJlc29sdmUpID0+IHtcclxuICAgIHRyeSB7XHJcbiAgICAgIC8vIElmIGltYWdlIGlzIG5vdCBsb2FkZWQsIHdhaXQgZm9yIGl0XHJcbiAgICAgIGlmICghaW1nLmNvbXBsZXRlKSB7XHJcbiAgICAgICAgaW1nLm9ubG9hZCA9ICgpID0+IGNvbnZlcnRUb0Jhc2U2NChpbWcsIHJlc29sdmUpO1xyXG4gICAgICAgIGltZy5vbmVycm9yID0gKCkgPT4gcmVzb2x2ZShudWxsKTtcclxuICAgICAgICByZXR1cm47XHJcbiAgICAgIH1cclxuXHJcbiAgICAgIGNvbnZlcnRUb0Jhc2U2NChpbWcsIHJlc29sdmUpO1xyXG4gICAgfSBjYXRjaCAoZXJyb3IpIHtcclxuICAgICAgY29uc29sZS53YXJuKFwiW1N0dWR5IEFzc2lzdF0gSW1hZ2UgY29udmVyc2lvbiBlcnJvcjpcIiwgZXJyb3IpO1xyXG4gICAgICByZXNvbHZlKG51bGwpO1xyXG4gICAgfVxyXG4gIH0pO1xyXG59XHJcblxyXG4vKipcclxuICogQ29udmVydCBhIGxvYWRlZCBpbWFnZSB0byBiYXNlNjQgdXNpbmcgY2FudmFzXHJcbiAqIEBwYXJhbSBpbWcgLSBMb2FkZWQgaW1hZ2UgZWxlbWVudFxyXG4gKiBAcGFyYW0gcmVzb2x2ZSAtIFByb21pc2UgcmVzb2x2ZSBmdW5jdGlvbiB0byBjYWxsIHdpdGggcmVzdWx0XHJcbiAqL1xyXG5leHBvcnQgZnVuY3Rpb24gY29udmVydFRvQmFzZTY0KFxyXG4gIGltZzogSFRNTEltYWdlRWxlbWVudCxcclxuICByZXNvbHZlOiAodmFsdWU6IEltYWdlRGF0YSB8IG51bGwpID0+IHZvaWRcclxuKTogdm9pZCB7XHJcbiAgdHJ5IHtcclxuICAgIGNvbnN0IGNhbnZhczogSFRNTENhbnZhc0VsZW1lbnQgPSBkb2N1bWVudC5jcmVhdGVFbGVtZW50KFwiY2FudmFzXCIpO1xyXG4gICAgY2FudmFzLndpZHRoID0gaW1nLm5hdHVyYWxXaWR0aCB8fCBpbWcud2lkdGg7XHJcbiAgICBjYW52YXMuaGVpZ2h0ID0gaW1nLm5hdHVyYWxIZWlnaHQgfHwgaW1nLmhlaWdodDtcclxuXHJcbiAgICAvLyBTa2lwIGlmIGNhbnZhcyBpcyB0b28gc21hbGxcclxuICAgIGlmIChjYW52YXMud2lkdGggPCA1MCB8fCBjYW52YXMuaGVpZ2h0IDwgNTApIHtcclxuICAgICAgcmVzb2x2ZShudWxsKTtcclxuICAgICAgcmV0dXJuO1xyXG4gICAgfVxyXG5cclxuICAgIGNvbnN0IGN0eDogQ2FudmFzUmVuZGVyaW5nQ29udGV4dDJEIHwgbnVsbCA9IGNhbnZhcy5nZXRDb250ZXh0KFwiMmRcIik7XHJcbiAgICBpZiAoIWN0eCkge1xyXG4gICAgICByZXNvbHZlKG51bGwpO1xyXG4gICAgICByZXR1cm47XHJcbiAgICB9XHJcbiAgICBjdHguZHJhd0ltYWdlKGltZywgMCwgMCk7XHJcblxyXG4gICAgLy8gR2V0IGFzIFBORyBiYXNlNjRcclxuICAgIGNvbnN0IGRhdGFVcmw6IHN0cmluZyA9IGNhbnZhcy50b0RhdGFVUkwoXCJpbWFnZS9wbmdcIik7XHJcbiAgICBjb25zdCBiYXNlNjQ6IHN0cmluZyA9IGRhdGFVcmwucmVwbGFjZSgvXmRhdGE6aW1hZ2VcXC9cXHcrO2Jhc2U2NCwvLCBcIlwiKTtcclxuXHJcbiAgICByZXNvbHZlKHtcclxuICAgICAgYmFzZTY0OiBiYXNlNjQsXHJcbiAgICAgIG1lZGlhVHlwZTogXCJpbWFnZS9wbmdcIixcclxuICAgIH0pO1xyXG4gIH0gY2F0Y2ggKGVycm9yKSB7XHJcbiAgICAvLyBDT1JTIGVycm9yIC0gdHJ5IGZldGNoaW5nIHRoZSBpbWFnZVxyXG4gICAgZmV0Y2hJbWFnZUFzQmFzZTY0KGltZy5zcmMpXHJcbiAgICAgIC50aGVuKHJlc29sdmUpXHJcbiAgICAgIC5jYXRjaCgoKSA9PiByZXNvbHZlKG51bGwpKTtcclxuICB9XHJcbn1cclxuXHJcbi8qKlxyXG4gKiBGZXRjaCBhbiBpbWFnZSB2aWEgVVJMIGFuZCBjb252ZXJ0IHRvIGJhc2U2NCAoZm9yIENPUlMtcmVzdHJpY3RlZCBpbWFnZXMpXHJcbiAqIEBwYXJhbSB1cmwgLSBUaGUgVVJMIG9mIHRoZSBpbWFnZSB0byBmZXRjaFxyXG4gKiBAcmV0dXJucyBCYXNlNjQgZGF0YSBvciBudWxsIGlmIGZldGNoIGZhaWxzXHJcbiAqL1xyXG5leHBvcnQgYXN5bmMgZnVuY3Rpb24gZmV0Y2hJbWFnZUFzQmFzZTY0KHVybDogc3RyaW5nKTogUHJvbWlzZTxJbWFnZURhdGEgfCBudWxsPiB7XHJcbiAgdHJ5IHtcclxuICAgIGNvbnN0IHJlc3BvbnNlOiBSZXNwb25zZSA9IGF3YWl0IGZldGNoKHVybCk7XHJcbiAgICBjb25zdCBibG9iOiBCbG9iID0gYXdhaXQgcmVzcG9uc2UuYmxvYigpO1xyXG5cclxuICAgIHJldHVybiBuZXcgUHJvbWlzZSgocmVzb2x2ZSwgcmVqZWN0KSA9PiB7XHJcbiAgICAgIGNvbnN0IHJlYWRlcjogRmlsZVJlYWRlciA9IG5ldyBGaWxlUmVhZGVyKCk7XHJcbiAgICAgIHJlYWRlci5vbmxvYWRlbmQgPSAoKSA9PiB7XHJcbiAgICAgICAgY29uc3QgZGF0YVVybCA9IHJlYWRlci5yZXN1bHQgYXMgc3RyaW5nO1xyXG4gICAgICAgIGNvbnN0IGJhc2U2NDogc3RyaW5nID0gZGF0YVVybC5yZXBsYWNlKC9eZGF0YTppbWFnZVxcL1xcdys7YmFzZTY0LC8sIFwiXCIpO1xyXG4gICAgICAgIGNvbnN0IG1lZGlhVHlwZTogc3RyaW5nID0gYmxvYi50eXBlIHx8IFwiaW1hZ2UvcG5nXCI7XHJcbiAgICAgICAgcmVzb2x2ZSh7IGJhc2U2NCwgbWVkaWFUeXBlIH0pO1xyXG4gICAgICB9O1xyXG4gICAgICByZWFkZXIub25lcnJvciA9IHJlamVjdDtcclxuICAgICAgcmVhZGVyLnJlYWRBc0RhdGFVUkwoYmxvYik7XHJcbiAgICB9KTtcclxuICB9IGNhdGNoIChlcnJvcikge1xyXG4gICAgY29uc29sZS53YXJuKFwiW1N0dWR5IEFzc2lzdF0gRmFpbGVkIHRvIGZldGNoIGltYWdlOlwiLCBlcnJvcik7XHJcbiAgICByZXR1cm4gbnVsbDtcclxuICB9XHJcbn1cclxuIiwgIi8qKlxyXG4gKiBTdHVkeSBBc3Npc3QgLSBRdWVzdGlvbiBEZXRlY3Rpb24gTW9kdWxlXHJcbiAqIEZ1bmN0aW9ucyBmb3IgZGV0ZWN0aW5nIGFuZCBleHRyYWN0aW5nIHF1ZXN0aW9ucyBmcm9tIHZhcmlvdXMgcXVpeiBwbGF0Zm9ybXNcclxuICogU3VwcG9ydHMgTmV0QWNhZCwgTW9vZGxlLCBhbmQgZ2VuZXJhbCBxdWl6IGZvcm1hdHNcclxuICovXHJcblxyXG5pbXBvcnQgdHlwZSB7XHJcbiAgRGV0ZWN0ZWRRdWVzdGlvbixcclxuICBRdWVzdGlvblR5cGUsXHJcbiAgUXVlc3Rpb25PcHRpb24sXHJcbiAgUXVlc3Rpb25QYXR0ZXJucyxcclxuICBRdWVzdGlvbk1hcCxcclxuICBRdWVzdGlvbk1hcEVudHJ5LFxyXG4gIERldGVjdGlvblJlc3VsdCxcclxuICBEZXRlY3Rpb25DYWxsYmFja3MsXHJcbiAgSW1hZ2VEYXRhLFxyXG4gIE1hdGNoaW5nQ2F0ZWdvcnksXHJcbiAgTWF0Y2hpbmdPcHRpb24sXHJcbiAgTWF0Y2hpbmdTdHlsZSxcclxuICBTZWxlY3RHYXAsXHJcbn0gZnJvbSBcIi4uLy4uL3R5cGVzL2luZGV4LmpzXCI7XHJcblxyXG5pbXBvcnQgeyBsb2csIHN0YXRlIH0gZnJvbSBcIi4vc3RhdGUuanNcIjtcclxuaW1wb3J0IHtcclxuICBxdWVyeVNlbGVjdG9yQWxsRGVlcCxcclxuICBnZXREZWVwVGV4dENvbnRlbnQsXHJcbiAgZ2V0VmlzaWJpbGl0eVNjb3JlLFxyXG4gIGdldFZpc2libGVUZXh0LFxyXG4gIGlzQ2hpbGRPZlByb2Nlc3NlZCxcclxuICBnZXREaXJlY3RUZXh0Q29udGVudCxcclxuICBmaW5kQWxsU2hhZG93Um9vdHMsXHJcbiAgZXh0cmFjdEFjY2Vzc2liaWxpdHlEZXNjcmlwdGlvbnMsXHJcbn0gZnJvbSBcIi4vdXRpbHMuanNcIjtcclxuaW1wb3J0IHsgaW1hZ2VUb0Jhc2U2NCwgZXh0cmFjdEltYWdlc0FzQmFzZTY0LCBpc1B1YmxpY0ltYWdlVXJsIH0gZnJvbSBcIi4vaW1hZ2VzLmpzXCI7XHJcblxyXG4vLyA9PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PVxyXG4vLyBRdWVzdGlvbiBEZXRlY3Rpb24gUGF0dGVybnNcclxuLy8gPT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT1cclxuZXhwb3J0IGNvbnN0IFFVRVNUSU9OX1BBVFRFUk5TOiBRdWVzdGlvblBhdHRlcm5zID0ge1xyXG4gIC8vIFF1ZXN0aW9uIGluZGljYXRvcnMgKEVuZ2xpc2ggYW5kIFNwYW5pc2gpXHJcbiAgcXVlc3Rpb25NYXJrZXJzOlxyXG4gICAgL1xcP3x3aGF0fHdoaWNofGhvd3x3aHl8d2hlbnx3aGVyZXx3aG98d2hvc2V8d2hvbXxleHBsYWlufGRlc2NyaWJlfGRlZmluZXxpZGVudGlmeXxzZWxlY3R8Y2hvb3NlfHBpY2t8ZGV0ZXJtaW5lfGNhbGN1bGF0ZXxjb21wdXRlfGZpbmR8c29sdmV8YW5hbHl6ZXxldmFsdWF0ZXxjb21wYXJlfGNvbnRyYXN0fGxpc3R8bmFtZXxzdGF0ZXxxdVx1MDBFOXxjdVx1MDBFMWx8Y1x1MDBGM21vfHBvclxccypxdVx1MDBFOXxjdVx1MDBFMW5kb3xkXHUwMEYzbmRlfHF1aVx1MDBFOW58cHJlZ3VudGFcXHMqXFxkKy9pLFxyXG5cclxuICAvLyBNdWx0aXBsZSBjaG9pY2UgcGF0dGVybnNcclxuICBtdWx0aXBsZUNob2ljZTogW1xyXG4gICAgL15cXHMqW0EtRGEtZF1bXFwuXFwpXFw6XT9cXHMrLisvbSwgLy8gQS4gQW5zd2VyIG9yIEEpIEFuc3dlciBvciBBOiBBbnN3ZXJcclxuICAgIC9eXFxzKlxcKFtBLURhLWRdXFwpXFxzKy4rL20sIC8vIChBKSBBbnN3ZXJcclxuICAgIC9eXFxzKlsxLTRdW1xcLlxcKVxcOl0/XFxzKy4rL20sIC8vIDEuIEFuc3dlciBvciAxKSBBbnN3ZXJcclxuICAgIC9cXGIoPzpvcHRpb258Y2hvaWNlfGFuc3dlcilcXHMqW0EtRGEtZDEtNF0vaSwgLy8gT3B0aW9uIEEsIENob2ljZSBCLCBBbnN3ZXIgMVxyXG4gICAgLzxpbnB1dFtePl0qdHlwZT1bXCInXT9yYWRpb1tcIiddP1tePl0qPi9pLCAvLyBSYWRpbyBidXR0b24gaW5wdXRzXHJcbiAgICAvXFxic2VsZWN0XFxzKyg/Om9uZXxhbGx8dGhlXFxzKyg/OmNvcnJlY3R8YmVzdHxyaWdodCkpL2ksIC8vIFwiU2VsZWN0IG9uZVwiLCBcIlNlbGVjdCB0aGUgY29ycmVjdFwiXHJcbiAgICAvcmFkaW9fYnV0dG9uXyg/OmNoZWNrZWR8dW5jaGVja2VkKS9pLCAvLyBNYXRlcmlhbCBEZXNpZ24gaWNvbnMgKE5ldEFjYWQpXHJcbiAgICAvcHJlZ3VudGFcXHMqXFxkKy9pLCAvLyBcIlByZWd1bnRhIDFcIiwgXCJQcmVndW50YSAyXCIgKE5ldEFjYWQgU3BhbmlzaClcclxuICBdLFxyXG5cclxuICAvLyBUcnVlL0ZhbHNlIHBhdHRlcm5zXHJcbiAgdHJ1ZUZhbHNlOiBbXHJcbiAgICAvXFxiKD86dHJ1ZXxmYWxzZSlcXGIuKlxcYig/OnRydWV8ZmFsc2UpXFxiL2ksXHJcbiAgICAvXlxccyooPzpUcnVlfEZhbHNlfFR8RilbXFwuXFwpXFxzXS9tLFxyXG4gICAgL1xcYig/OmlzXFxzK3RoaXN8dGhpc1xccytpcylcXHMrKD86dHJ1ZXxmYWxzZXxjb3JyZWN0fGluY29ycmVjdClcXGIvaSxcclxuICAgIC9cXGIoPzp2ZXJkYWRlcm98ZmFsc28pXFxiL2ksIC8vIFNwYW5pc2hcclxuICBdLFxyXG5cclxuICAvLyBGaWxsIGluIHRoZSBibGFua1xyXG4gIGZpbGxCbGFuazogW1xyXG4gICAgL197Mix9fFxcLnszLH18XFxbP1xccypibGFua1xccypcXF0/L2ksXHJcbiAgICAvZmlsbFxccysoPzppblxccyspPyg/OnRoZVxccyspPyg/OmJsYW5rfGdhcCkvaSxcclxuICAgIC9jb21wbGV0ZVxccysoPzpsYXxlbHxsb3N8bGFzKS9pLCAvLyBTcGFuaXNoXHJcbiAgXSxcclxufTtcclxuXHJcbi8vID09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09XHJcbi8vIFRleHQgQ2xlYW5pbmcgSGVscGVyc1xyXG4vLyA9PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PVxyXG5cclxuLyoqXHJcbiAqIENsZWFuIHF1ZXN0aW9uIHRleHQgYnkgZXh0cmFjdGluZyBvbmx5IHRoZSBhY3R1YWwgcXVlc3Rpb24gcGFydFxyXG4gKiBSZW1vdmVzIGNvbnRleHQgbGlrZSByb3V0aW5nIHRhYmxlcywgY29kZSBzbmlwcGV0cywgZXRjLiB0aGF0IGFwcGVhciBiZWZvcmUgdGhlIHF1ZXN0aW9uXHJcbiAqL1xyXG5mdW5jdGlvbiBjbGVhblF1ZXN0aW9uVGV4dChyYXdUZXh0OiBzdHJpbmcpOiBzdHJpbmcge1xyXG4gIGlmICghcmF3VGV4dCB8fCByYXdUZXh0Lmxlbmd0aCA8IDEwMCkge1xyXG4gICAgcmV0dXJuIHJhd1RleHQ7IC8vIFNob3J0IHRleHQsIHByb2JhYmx5IGFscmVhZHkgY2xlYW5cclxuICB9XHJcblxyXG4gIC8vIFBhdHRlcm5zIHRoYXQgdHlwaWNhbGx5IGluZGljYXRlIHRoZSBzdGFydCBvZiB0aGUgYWN0dWFsIHF1ZXN0aW9uXHJcbiAgY29uc3QgcXVlc3Rpb25TdGFydFBhdHRlcm5zID0gW1xyXG4gICAgLyg/OmNvbnN1bHRlXFxzKyg/OmxhXFxzKyk/KD86aW1hZ2VufGlsdXN0cmFjaVtvXHUwMEYzXW58ZXhoaWJpY2lbb1x1MDBGM11ufGZpZ3VyYXx0YWJsYXxnclthXHUwMEUxXWZpY1thb10pKVsuOixdP1xccyovaSxcclxuICAgIC8oPzpyZWZlclxccyt0b1xccyt0aGVcXHMrKD86ZXhoaWJpdHxmaWd1cmV8ZGlhZ3JhbXxpbWFnZXx0YWJsZXxncmFwaGljKSlbLjosXT9cXHMqL2ksXHJcbiAgICAvKD86c2VlXFxzK3RoZVxccysoPzpleGhpYml0fGZpZ3VyZXxkaWFncmFtfGltYWdlfHRhYmxlfGdyYXBoaWMpKVsuOixdP1xccyovaSxcclxuICBdO1xyXG5cclxuICAvLyBUcnkgdG8gZmluZCB3aGVyZSB0aGUgYWN0dWFsIHF1ZXN0aW9uIHN0YXJ0c1xyXG4gIGZvciAoY29uc3QgcGF0dGVybiBvZiBxdWVzdGlvblN0YXJ0UGF0dGVybnMpIHtcclxuICAgIGNvbnN0IG1hdGNoID0gcmF3VGV4dC5tYXRjaChwYXR0ZXJuKTtcclxuICAgIGlmIChtYXRjaCAmJiBtYXRjaC5pbmRleCAhPT0gdW5kZWZpbmVkKSB7XHJcbiAgICAgIC8vIEV4dHJhY3QgZnJvbSB0aGlzIHBvaW50IHRvIHRoZSBlbmRcclxuICAgICAgY29uc3QgcXVlc3Rpb25QYXJ0ID0gcmF3VGV4dC5zdWJzdHJpbmcobWF0Y2guaW5kZXgpLnRyaW0oKTtcclxuICAgICAgXHJcbiAgICAgIC8vIE1ha2Ugc3VyZSB3ZSBnb3QgYSBzdWJzdGFudGlhbCBxdWVzdGlvbiAoaGFzIGEgcXVlc3Rpb24gbWFyaylcclxuICAgICAgaWYgKHF1ZXN0aW9uUGFydC5pbmNsdWRlcygnPycpKSB7XHJcbiAgICAgICAgbG9nKGBbU3R1ZHkgQXNzaXN0XSBDbGVhbmVkIHF1ZXN0aW9uIHRleHQ6IFwiJHtyYXdUZXh0LnN1YnN0cmluZygwLCA1MCl9Li4uXCIgXHUyMTkyIFwiJHtxdWVzdGlvblBhcnQuc3Vic3RyaW5nKDAsIDEwMCl9Li4uXCJgKTtcclxuICAgICAgICByZXR1cm4gcXVlc3Rpb25QYXJ0O1xyXG4gICAgICB9XHJcbiAgICB9XHJcbiAgfVxyXG5cclxuICAvLyBJZiBubyBcIkNvbnN1bHRlLi4uXCIgcGF0dGVybiBmb3VuZCwgY2hlY2sgaWYgdGhlcmUncyBhIGxvdCBvZiBub24tcXVlc3Rpb24gdGV4dFxyXG4gIC8vIChsaWtlIHJvdXRpbmcgdGFibGVzIHdpdGggbWFueSBsaW5lcyBzdGFydGluZyB3aXRoIGxldHRlcnMvbnVtYmVycyBhbmQgbmV0d29yayBhZGRyZXNzZXMpXHJcbiAgY29uc3QgbGluZXMgPSByYXdUZXh0LnNwbGl0KCdcXG4nKS5tYXAobCA9PiBsLnRyaW0oKSkuZmlsdGVyKGwgPT4gbC5sZW5ndGggPiAwKTtcclxuICBcclxuICAvLyBEZXRlY3QgaWYgbWFueSBsaW5lcyBsb29rIGxpa2Ugcm91dGluZyB0YWJsZSBlbnRyaWVzIG9yIGNvZGVcclxuICBjb25zdCB0YWJsZUxpbmVQYXR0ID0gL15bQS1aXVxccytbXFxkXFwuOi9dK3xeXFx3K1xcKFteKV0rXFwpXFxzKiN8XltcXGRcXC5dKyBcXFt8Z2F0ZXdheVxccytvZlxccytsYXN0XFxzK3Jlc29ydC9pO1xyXG4gIGNvbnN0IHRhYmxlTGluZXMgPSBsaW5lcy5maWx0ZXIobCA9PiB0YWJsZUxpbmVQYXR0LnRlc3QobCkpO1xyXG4gIFxyXG4gIC8vIElmIG1vcmUgdGhhbiAzMCUgb2YgbGluZXMgbG9vayBsaWtlIHRhYmxlcy9jb2RlLCBleHRyYWN0IGp1c3QgdGhlIGxhc3Qgc2VudGVuY2Ugd2l0aCBcIj9cIlxyXG4gIGlmICh0YWJsZUxpbmVzLmxlbmd0aCA+IGxpbmVzLmxlbmd0aCAqIDAuMykge1xyXG4gICAgLy8gRmluZCB0aGUgbGFzdCBzdWJzdGFudGlhbCBzZW50ZW5jZSB3aXRoIGEgcXVlc3Rpb24gbWFya1xyXG4gICAgY29uc3Qgc2VudGVuY2VzID0gcmF3VGV4dC5zcGxpdCgvWy4hXHUwMEJGXVxccysvKS5maWx0ZXIocyA9PiBzLmluY2x1ZGVzKCc/JykpO1xyXG4gICAgaWYgKHNlbnRlbmNlcy5sZW5ndGggPiAwKSB7XHJcbiAgICAgIGNvbnN0IGxhc3RRdWVzdGlvbiA9IHNlbnRlbmNlc1tzZW50ZW5jZXMubGVuZ3RoIC0gMV0udHJpbSgpO1xyXG4gICAgICBcclxuICAgICAgLy8gSW5jbHVkZSBhbnkgXCJDb25zdWx0ZS4uLlwiIHByZWZpeCBpZiBwcmVzZW50XHJcbiAgICAgIGNvbnN0IGNvbnRleHRNYXRjaCA9IHJhd1RleHQubWF0Y2goLyhjb25zdWx0ZVxccysoPzpsYVxccyspPyg/OmltYWdlbnxpbHVzdHJhY2lbb1x1MDBGM11ufGV4aGliaWNpW29cdTAwRjNdbilbLjosXT9cXHMrW15cdTAwQkY/XStcXD8pL2kpO1xyXG4gICAgICBpZiAoY29udGV4dE1hdGNoKSB7XHJcbiAgICAgICAgbG9nKGBbU3R1ZHkgQXNzaXN0XSBDbGVhbmVkIHF1ZXN0aW9uIHRleHQgKHRhYmxlIGRldGVjdGVkKTogXCIke3Jhd1RleHQuc3Vic3RyaW5nKDAsIDUwKX0uLi5cIiBcdTIxOTIgXCIke2NvbnRleHRNYXRjaFsxXS50cmltKCkuc3Vic3RyaW5nKDAsIDEwMCl9Li4uXCJgKTtcclxuICAgICAgICByZXR1cm4gY29udGV4dE1hdGNoWzFdLnRyaW0oKTtcclxuICAgICAgfVxyXG4gICAgICBcclxuICAgICAgbG9nKGBbU3R1ZHkgQXNzaXN0XSBDbGVhbmVkIHF1ZXN0aW9uIHRleHQgKHRhYmxlIGRldGVjdGVkKTogXCIke3Jhd1RleHQuc3Vic3RyaW5nKDAsIDUwKX0uLi5cIiBcdTIxOTIgXCIke2xhc3RRdWVzdGlvbi5zdWJzdHJpbmcoMCwgMTAwKX0uLi5cImApO1xyXG4gICAgICByZXR1cm4gbGFzdFF1ZXN0aW9uO1xyXG4gICAgfVxyXG4gIH1cclxuXHJcbiAgLy8gTm8gY2xlYW5pbmcgbmVlZGVkIC0gcmV0dXJuIG9yaWdpbmFsXHJcbiAgcmV0dXJuIHJhd1RleHQ7XHJcbn1cclxuXHJcbi8vID09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09XHJcbi8vIEludGVybmFsIFR5cGVzXHJcbi8vID09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09XHJcblxyXG5pbnRlcmZhY2UgTmV0QWNhZFF1ZXN0aW9uRGF0YSB7XHJcbiAgcXVlc3Rpb25UZXh0OiBzdHJpbmc7XHJcbiAgb3B0aW9uczogUXVlc3Rpb25PcHRpb25bXTtcclxufVxyXG5cclxuaW50ZXJmYWNlIEFuYWx5c2lzUmVzdWx0IHtcclxuICBpc1F1ZXN0aW9uOiBib29sZWFuO1xyXG4gIHR5cGU6IFF1ZXN0aW9uVHlwZTtcclxuICBvcHRpb25zOiBRdWVzdGlvbk9wdGlvbltdIHwgc3RyaW5nW107XHJcbiAgY29uZmlkZW5jZTogbnVtYmVyO1xyXG59XHJcblxyXG5pbnRlcmZhY2UgUHJlZ3VudGFDYW5kaWRhdGUge1xyXG4gIG51bTogbnVtYmVyO1xyXG4gIHRvcDogbnVtYmVyO1xyXG4gIGZvbnRTaXplOiBudW1iZXI7XHJcbiAgYXJlYTogbnVtYmVyO1xyXG4gIHNjb3JlOiBudW1iZXI7XHJcbiAgdGV4dDogc3RyaW5nO1xyXG59XHJcblxyXG5pbnRlcmZhY2UgUHJlZ3VudGFFbGVtZW50IHtcclxuICBudW06IG51bWJlcjtcclxuICByZWN0OiBET01SZWN0O1xyXG4gIGVsZW1lbnQ6IEVsZW1lbnQ7XHJcbn1cclxuXHJcbmludGVyZmFjZSBWaXNpYmxlTWF0Y2hSZXN1bHQge1xyXG4gIG1hdGNoaW5nVmlldzogRWxlbWVudDtcclxuICByZWN0OiBET01SZWN0O1xyXG4gIGNlbnRlckRpc3Q6IG51bWJlcjtcclxufVxyXG5cclxuLy8gPT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT1cclxuLy8gTWFpbiBEZXRlY3Rpb24gRnVuY3Rpb25zXHJcbi8vID09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09XHJcblxyXG4vKipcclxuICogTWFpbiBmdW5jdGlvbiB0byBkZXRlY3QgYWxsIHF1ZXN0aW9ucyBvbiB0aGUgcGFnZVxyXG4gKiBUcmllcyBtdWx0aXBsZSBkZXRlY3Rpb24gc3RyYXRlZ2llcyBpbiBvcmRlciBvZiBzcGVjaWZpY2l0eVxyXG4gKiBAcGFyYW0gcmV0cnlDb3VudCAtIE51bWJlciBvZiByZXRyeSBhdHRlbXB0cyAoZm9yIGxhenktbG9hZGVkIGNvbnRlbnQpXHJcbiAqL1xyXG5leHBvcnQgYXN5bmMgZnVuY3Rpb24gZGV0ZWN0UXVlc3Rpb25zT25QYWdlKHJldHJ5Q291bnQ6IG51bWJlciA9IDApOiBQcm9taXNlPERldGVjdGlvblJlc3VsdCB8IHVuZGVmaW5lZD4ge1xyXG4gIGlmICghc3RhdGUuaXNBY3RpdmUpIHJldHVybjtcclxuXHJcbiAgc3RhdGUuZGV0ZWN0ZWRRdWVzdGlvbnMgPSBbXTtcclxuXHJcbiAgLy8gRmlyc3QsIHRyeSB0byBkZXRlY3QgTW9vZGxlIHF1ZXN0aW9uc1xyXG4gIGF3YWl0IGRldGVjdE1vb2RsZVF1ZXN0aW9ucygpO1xyXG5cclxuICAvLyBJZiBubyBNb29kbGUgcXVlc3Rpb25zLCB0cnkgTmV0QWNhZC1zdHlsZSBxdWVzdGlvbnMgKFByZWd1bnRhIDEsIFByZWd1bnRhIDIsIGV0Yy4pXHJcbiAgaWYgKHN0YXRlLmRldGVjdGVkUXVlc3Rpb25zLmxlbmd0aCA9PT0gMCkge1xyXG4gICAgZGV0ZWN0TmV0QWNhZFF1ZXN0aW9ucygpO1xyXG4gIH1cclxuXHJcbiAgLy8gSWYgc3RpbGwgbm8gcXVlc3Rpb25zIGZvdW5kLCB1c2UgZ2VuZXJhbCBkZXRlY3Rpb25cclxuICBpZiAoc3RhdGUuZGV0ZWN0ZWRRdWVzdGlvbnMubGVuZ3RoID09PSAwKSB7XHJcbiAgICBkZXRlY3RHZW5lcmFsUXVlc3Rpb25zKCk7XHJcbiAgfVxyXG5cclxuICAvLyBSZXR1cm4gcmVzdWx0cyBmb3IgZXh0ZXJuYWwgaGFuZGxlcnNcclxuICByZXR1cm4ge1xyXG4gICAgZm91bmQ6IHN0YXRlLmRldGVjdGVkUXVlc3Rpb25zLmxlbmd0aCA+IDAsXHJcbiAgICBjb3VudDogc3RhdGUuZGV0ZWN0ZWRRdWVzdGlvbnMubGVuZ3RoLFxyXG4gICAgcmV0cnlDb3VudCxcclxuICB9O1xyXG59XHJcblxyXG4vLyA9PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PVxyXG4vLyBNb29kbGUgUXVlc3Rpb24gRGV0ZWN0aW9uXHJcbi8vID09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09XHJcblxyXG4vKipcclxuICogRGV0ZWN0IE1vb2RsZSBxdWl6IHF1ZXN0aW9uc1xyXG4gKiBNb29kbGUgdXNlcyBzdGFuZGFyZCBIVE1MIHdpdGggY2xhc3NlcyBsaWtlIC5xdWUubXVsdGljaG9pY2VcclxuICovXHJcbmV4cG9ydCBhc3luYyBmdW5jdGlvbiBkZXRlY3RNb29kbGVRdWVzdGlvbnMoKTogUHJvbWlzZTx2b2lkPiB7XHJcbiAgLy8gTG9vayBmb3IgTW9vZGxlIHF1ZXN0aW9uIGNvbnRhaW5lcnMgKGFsbCBzdXBwb3J0ZWQgdHlwZXMpXHJcbiAgY29uc3QgbW9vZGxlUXVlc3Rpb25zID0gZG9jdW1lbnQucXVlcnlTZWxlY3RvckFsbChcclxuICAgIFwiLnF1ZS5tdWx0aWNob2ljZSwgLnF1ZS50cnVlZmFsc2UsIC5xdWUubWF0Y2gsIC5xdWUuc2hvcnRhbnN3ZXIsIC5xdWUubnVtZXJpY2FsLCAucXVlLmdhcHNlbGVjdFwiLFxyXG4gICk7XHJcblxyXG4gIGlmIChtb29kbGVRdWVzdGlvbnMubGVuZ3RoID09PSAwKSB7XHJcbiAgICByZXR1cm47XHJcbiAgfVxyXG5cclxuICBmb3IgKGNvbnN0IFtpbmRleCwgcXVlc3Rpb25FbF0gb2YgQXJyYXkuZnJvbShtb29kbGVRdWVzdGlvbnMpLmVudHJpZXMoKSkge1xyXG4gICAgaWYgKHF1ZXN0aW9uRWwuY2xhc3NMaXN0LmNvbnRhaW5zKFwibWF0Y2hcIikpIHtcclxuICAgICAgY29uc3QgcXVlc3Rpb25EYXRhID0gYXdhaXQgZXh0cmFjdE1vb2RsZU1hdGNoUXVlc3Rpb24ocXVlc3Rpb25FbCk7XHJcbiAgICAgIGlmIChxdWVzdGlvbkRhdGEpIHtcclxuICAgICAgICBxdWVzdGlvbkRhdGEuaWQgPSBgbW9vZGxlLXEtJHtpbmRleH1gO1xyXG4gICAgICAgIHN0YXRlLmRldGVjdGVkUXVlc3Rpb25zLnB1c2gocXVlc3Rpb25EYXRhKTtcclxuICAgICAgfVxyXG4gICAgfSBlbHNlIGlmIChxdWVzdGlvbkVsLmNsYXNzTGlzdC5jb250YWlucyhcInNob3J0YW5zd2VyXCIpKSB7XHJcbiAgICAgIGNvbnN0IHF1ZXN0aW9uRGF0YSA9IGF3YWl0IGV4dHJhY3RNb29kbGVTaG9ydEFuc3dlclF1ZXN0aW9uKHF1ZXN0aW9uRWwsIFwic2hvcnQtYW5zd2VyXCIpO1xyXG4gICAgICBpZiAocXVlc3Rpb25EYXRhKSB7XHJcbiAgICAgICAgcXVlc3Rpb25EYXRhLmlkID0gYG1vb2RsZS1xLSR7aW5kZXh9YDtcclxuICAgICAgICBzdGF0ZS5kZXRlY3RlZFF1ZXN0aW9ucy5wdXNoKHF1ZXN0aW9uRGF0YSk7XHJcbiAgICAgIH1cclxuICAgIH0gZWxzZSBpZiAocXVlc3Rpb25FbC5jbGFzc0xpc3QuY29udGFpbnMoXCJudW1lcmljYWxcIikpIHtcclxuICAgICAgY29uc3QgcXVlc3Rpb25EYXRhID0gYXdhaXQgZXh0cmFjdE1vb2RsZVNob3J0QW5zd2VyUXVlc3Rpb24ocXVlc3Rpb25FbCwgXCJudW1lcmljYWxcIik7XHJcbiAgICAgIGlmIChxdWVzdGlvbkRhdGEpIHtcclxuICAgICAgICBxdWVzdGlvbkRhdGEuaWQgPSBgbW9vZGxlLXEtJHtpbmRleH1gO1xyXG4gICAgICAgIHN0YXRlLmRldGVjdGVkUXVlc3Rpb25zLnB1c2gocXVlc3Rpb25EYXRhKTtcclxuICAgICAgfVxyXG4gICAgfSBlbHNlIGlmIChxdWVzdGlvbkVsLmNsYXNzTGlzdC5jb250YWlucyhcImdhcHNlbGVjdFwiKSkge1xyXG4gICAgICBjb25zdCBxdWVzdGlvbkRhdGEgPSBhd2FpdCBleHRyYWN0TW9vZGxlU2VsZWN0TWlzc2luZ1dvcmRzKHF1ZXN0aW9uRWwpO1xyXG4gICAgICBpZiAocXVlc3Rpb25EYXRhKSB7XHJcbiAgICAgICAgcXVlc3Rpb25EYXRhLmlkID0gYG1vb2RsZS1xLSR7aW5kZXh9YDtcclxuICAgICAgICBzdGF0ZS5kZXRlY3RlZFF1ZXN0aW9ucy5wdXNoKHF1ZXN0aW9uRGF0YSk7XHJcbiAgICAgIH1cclxuICAgIH0gZWxzZSB7XHJcbiAgICAgIC8vIG11bHRpY2hvaWNlIG9yIHRydWVmYWxzZVxyXG4gICAgICBjb25zdCBxdWVzdGlvbkRhdGEgPSBhd2FpdCBleHRyYWN0TW9vZGxlUXVlc3Rpb25EYXRhKHF1ZXN0aW9uRWwpO1xyXG4gICAgICBpZiAocXVlc3Rpb25EYXRhKSB7XHJcbiAgICAgICAgc3RhdGUuZGV0ZWN0ZWRRdWVzdGlvbnMucHVzaCh7XHJcbiAgICAgICAgICBpZDogYG1vb2RsZS1xLSR7aW5kZXh9YCxcclxuICAgICAgICAgIGVsZW1lbnQ6IHF1ZXN0aW9uRWwsXHJcbiAgICAgICAgICB0ZXh0OiBxdWVzdGlvbkRhdGEudGV4dCxcclxuICAgICAgICAgIHR5cGU6IHF1ZXN0aW9uRGF0YS50eXBlLFxyXG4gICAgICAgICAgb3B0aW9uczogcXVlc3Rpb25EYXRhLm9wdGlvbnMsXHJcbiAgICAgICAgICBxdWVzdGlvbk51bWJlcjogcXVlc3Rpb25EYXRhLnF1ZXN0aW9uTnVtYmVyLFxyXG4gICAgICAgICAgaW1hZ2VzOiBxdWVzdGlvbkRhdGEuaW1hZ2VzLFxyXG4gICAgICAgICAgY29uZmlkZW5jZTogOTUsXHJcbiAgICAgICAgICBwbGF0Zm9ybTogXCJtb29kbGVcIixcclxuICAgICAgICAgIGNvdXJzZU5hbWU6IHF1ZXN0aW9uRGF0YS5jb3Vyc2VOYW1lLFxyXG4gICAgICAgIH0pO1xyXG4gICAgICB9XHJcbiAgICB9XHJcbiAgfVxyXG59XHJcblxyXG4vLyA9PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PVxyXG4vLyBOZXRBY2FkLXNwZWNpZmljIFF1ZXN0aW9uIERldGVjdGlvblxyXG4vLyA9PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PVxyXG5cclxuLyoqXHJcbiAqIERldGVjdCBOZXRBY2FkLXN0eWxlIHF1ZXN0aW9uc1xyXG4gKiBVc2VzIHNoYWRvdyBET00gdHJhdmVyc2FsIHRvIGZpbmQgbWNxLXZpZXcgYW5kIG1hdGNoaW5nIGNvbXBvbmVudHNcclxuICovXHJcbmV4cG9ydCBmdW5jdGlvbiBkZXRlY3ROZXRBY2FkUXVlc3Rpb25zKCk6IHZvaWQge1xyXG4gIC8vIEZpbmQgYWxsIHNoYWRvdyByb290cyBpbiBkb2N1bWVudFxyXG4gIGNvbnN0IHNoYWRvd1Jvb3RzID0gZmluZEFsbFNoYWRvd1Jvb3RzKCk7XHJcblxyXG4gIC8vIE1ldGhvZCAxOiBTZWFyY2ggdGhyb3VnaCBTaGFkb3cgRE9NcyBmb3IgbWNxLXZpZXcgY29tcG9uZW50cyAoTmV0QWNhZCBzcGVjaWZpYylcclxuICBjb25zdCBtY3FWaWV3cyA9IHF1ZXJ5U2VsZWN0b3JBbGxEZWVwKFwibWNxLXZpZXdcIik7XHJcblxyXG4gIGlmIChtY3FWaWV3cy5sZW5ndGggPiAwKSB7XHJcbiAgICBtY3FWaWV3cy5mb3JFYWNoKChtY3FWaWV3LCBpbmRleCkgPT4ge1xyXG4gICAgICAvLyBHZXQgdGhlIHNoYWRvdyByb290IGNvbnRlbnRcclxuICAgICAgY29uc3Qgc2hhZG93Um9vdCA9IG1jcVZpZXcuc2hhZG93Um9vdDtcclxuICAgICAgaWYgKCFzaGFkb3dSb290KSB7XHJcbiAgICAgICAgcmV0dXJuO1xyXG4gICAgICB9XHJcblxyXG4gICAgICAvLyBGaW5kIHF1ZXN0aW9uIHRleHQgLSBpdCdzIG5lc3RlZCBpbiBiYXNlLXZpZXcgPiBzaGFkb3cgPiAubWNxX19ib2R5LWlubmVyXHJcbiAgICAgIC8vIFVzZSBkZWVwIHNlYXJjaCB0byBmaW5kIGl0XHJcbiAgICAgIGxldCBxdWVzdGlvblRleHQgPSBcIlwiO1xyXG4gICAgICBjb25zdCBxdWVzdGlvbkJvZHlFbHMgPSBxdWVyeVNlbGVjdG9yQWxsRGVlcChcclxuICAgICAgICBcIi5tY3FfX2JvZHktaW5uZXJcIixcclxuICAgICAgICBzaGFkb3dSb290LFxyXG4gICAgICApO1xyXG4gICAgICBpZiAocXVlc3Rpb25Cb2R5RWxzLmxlbmd0aCA+IDApIHtcclxuICAgICAgICBjb25zdCByYXdUZXh0ID0gcXVlc3Rpb25Cb2R5RWxzWzBdLnRleHRDb250ZW50Py50cmltKCkgfHwgXCJcIjtcclxuICAgICAgICBxdWVzdGlvblRleHQgPSBjbGVhblF1ZXN0aW9uVGV4dChyYXdUZXh0KTtcclxuICAgICAgfVxyXG5cclxuICAgICAgLy8gSWYgc3RpbGwgbm90IGZvdW5kLCB0cnkgZ2V0dGluZyBhbGwgdGV4dCBmcm9tIHRoZSBoZWFkZXJcclxuICAgICAgaWYgKCFxdWVzdGlvblRleHQpIHtcclxuICAgICAgICBjb25zdCBoZWFkZXJFbHMgPSBxdWVyeVNlbGVjdG9yQWxsRGVlcChcclxuICAgICAgICAgIFwiLm1jcV9faGVhZGVyLCAuY29tcG9uZW50X19ib2R5XCIsXHJcbiAgICAgICAgICBzaGFkb3dSb290LFxyXG4gICAgICAgICk7XHJcbiAgICAgICAgaWYgKGhlYWRlckVscy5sZW5ndGggPiAwKSB7XHJcbiAgICAgICAgICBjb25zdCByYXdUZXh0ID0gaGVhZGVyRWxzWzBdLnRleHRDb250ZW50Py50cmltKCkgfHwgXCJcIjtcclxuICAgICAgICAgIHF1ZXN0aW9uVGV4dCA9IGNsZWFuUXVlc3Rpb25UZXh0KHJhd1RleHQpO1xyXG4gICAgICAgIH1cclxuICAgICAgfVxyXG5cclxuICAgICAgLy8gTGFzdCByZXNvcnQ6IGdldCB0ZXh0IGNvbnRlbnQgZnJvbSBtY3EtdmlldyBpdHNlbGZcclxuICAgICAgaWYgKCFxdWVzdGlvblRleHQpIHtcclxuICAgICAgICBxdWVzdGlvblRleHQgPSBnZXREZWVwVGV4dENvbnRlbnQobWNxVmlldyk7XHJcbiAgICAgICAgLy8gVGFrZSBmaXJzdCBwYXJ0IGJlZm9yZSBhbnkgb3B0aW9uLWxpa2UgdGV4dFxyXG4gICAgICAgIGNvbnN0IGxpbmVzID0gcXVlc3Rpb25UZXh0XHJcbiAgICAgICAgICAuc3BsaXQoXCJcXG5cIilcclxuICAgICAgICAgIC5maWx0ZXIoKGwpID0+IGwudHJpbSgpLmxlbmd0aCA+IDEwKTtcclxuICAgICAgICBpZiAobGluZXMubGVuZ3RoID4gMCkge1xyXG4gICAgICAgICAgcXVlc3Rpb25UZXh0ID0gbGluZXNbMF0udHJpbSgpO1xyXG4gICAgICAgIH1cclxuICAgICAgfVxyXG5cclxuICAgICAgLy8gRmluZCBhbnN3ZXIgb3B0aW9ucyAtIHRoZXkncmUgaW4gLm1jcV9faXRlbS10ZXh0LWlubmVyIChkZWVwIHNlYXJjaClcclxuICAgICAgY29uc3Qgb3B0aW9uRWxzID0gcXVlcnlTZWxlY3RvckFsbERlZXAoXHJcbiAgICAgICAgXCIubWNxX19pdGVtLXRleHQtaW5uZXJcIixcclxuICAgICAgICBzaGFkb3dSb290LFxyXG4gICAgICApO1xyXG4gICAgICBjb25zdCBvcHRpb25zOiBRdWVzdGlvbk9wdGlvbltdID0gW107XHJcblxyXG4gICAgICBvcHRpb25FbHMuZm9yRWFjaCgob3B0RWwsIG9wdEluZGV4KSA9PiB7XHJcbiAgICAgICAgY29uc3Qgb3B0VGV4dCA9IG9wdEVsLnRleHRDb250ZW50Py50cmltKCkgfHwgXCJcIjtcclxuICAgICAgICBpZiAob3B0VGV4dCAmJiBvcHRUZXh0Lmxlbmd0aCA+IDApIHtcclxuICAgICAgICAgIG9wdGlvbnMucHVzaCh7XHJcbiAgICAgICAgICAgIGxldHRlcjogU3RyaW5nLmZyb21DaGFyQ29kZSg2NSArIG9wdEluZGV4KSwgLy8gQSwgQiwgQywgRFxyXG4gICAgICAgICAgICB0ZXh0OiBvcHRUZXh0LFxyXG4gICAgICAgICAgfSk7XHJcbiAgICAgICAgfVxyXG4gICAgICB9KTtcclxuXHJcbiAgICAgIC8vIFRyeSB0byBleHRyYWN0IGFjdHVhbCBxdWVzdGlvbiBudW1iZXIgZnJvbSBuZWFyYnkgXCJQcmVndW50YSBYXCIgdGV4dFxyXG4gICAgICBsZXQgcXVlc3Rpb25OdW1iZXIgPSBpbmRleCArIDE7IC8vIGRlZmF1bHQgdG8gYXJyYXkgaW5kZXhcclxuICAgICAgY29uc3QgZnVsbFRleHQgPSBnZXREZWVwVGV4dENvbnRlbnQobWNxVmlldyk7XHJcbiAgICAgIGNvbnN0IHByZWd1bnRhTWF0Y2ggPSBmdWxsVGV4dC5tYXRjaCgvcHJlZ3VudGFcXHMqKFxcZCspL2kpO1xyXG4gICAgICBpZiAocHJlZ3VudGFNYXRjaCkge1xyXG4gICAgICAgIHF1ZXN0aW9uTnVtYmVyID0gcGFyc2VJbnQocHJlZ3VudGFNYXRjaFsxXSk7XHJcbiAgICAgIH1cclxuXHJcbiAgICAgIC8vIE9ubHkgcmVxdWlyZSBvcHRpb25zIC0gcXVlc3Rpb24gdGV4dCBtaWdodCBiZSBlbXB0eSBpZiBleHRyYWN0aW9uIGZhaWxzXHJcbiAgICAgIGlmIChvcHRpb25zLmxlbmd0aCA+PSAyKSB7XHJcbiAgICAgICAgc3RhdGUuZGV0ZWN0ZWRRdWVzdGlvbnMucHVzaCh7XHJcbiAgICAgICAgICBpZDogYHEtJHtpbmRleH1gLFxyXG4gICAgICAgICAgcXVlc3Rpb25OdW1iZXI6IHF1ZXN0aW9uTnVtYmVyLFxyXG4gICAgICAgICAgZWxlbWVudDogbWNxVmlldyxcclxuICAgICAgICAgIHRleHQ6IHF1ZXN0aW9uVGV4dCB8fCBgUXVlc3Rpb24gJHtxdWVzdGlvbk51bWJlcn1gLFxyXG4gICAgICAgICAgdHlwZTogXCJtdWx0aXBsZS1jaG9pY2VcIixcclxuICAgICAgICAgIG9wdGlvbnM6IG9wdGlvbnMsXHJcbiAgICAgICAgICBjb25maWRlbmNlOiA5NSxcclxuICAgICAgICB9KTtcclxuICAgICAgfVxyXG4gICAgfSk7XHJcblxyXG4gICAgaWYgKHN0YXRlLmRldGVjdGVkUXVlc3Rpb25zLmxlbmd0aCA+IDApIHtcclxuICAgICAgcmV0dXJuO1xyXG4gICAgfVxyXG4gIH1cclxuXHJcbiAgLy8gTWV0aG9kIDI6IFRyeSBmaW5kaW5nIG1jcSBjbGFzc2VzIGRpcmVjdGx5IHdpdGggZGVlcCBzZWFyY2hcclxuICBjb25zdCBtY3FJdGVtcyA9IHF1ZXJ5U2VsZWN0b3JBbGxEZWVwKFwiLm1jcV9faXRlbS10ZXh0LWlubmVyXCIpO1xyXG5cclxuICBpZiAobWNxSXRlbXMubGVuZ3RoID4gMCkge1xyXG4gICAgLy8gR3JvdXAgb3B0aW9ucyBieSB0aGVpciBwYXJlbnQgcXVlc3Rpb24gY29udGFpbmVyXHJcbiAgICBjb25zdCBxdWVzdGlvbk1hcCA9IG5ldyBNYXA8RWxlbWVudCwgc3RyaW5nW10+KCk7XHJcblxyXG4gICAgbWNxSXRlbXMuZm9yRWFjaCgoaXRlbSkgPT4ge1xyXG4gICAgICAvLyBGaW5kIHRoZSBtY3EtdmlldyBwYXJlbnRcclxuICAgICAgbGV0IHBhcmVudDogRWxlbWVudCB8IG51bGwgPSBpdGVtO1xyXG4gICAgICB3aGlsZSAocGFyZW50ICYmIHBhcmVudC50YWdOYW1lICE9PSBcIk1DUS1WSUVXXCIpIHtcclxuICAgICAgICBwYXJlbnQgPSAocGFyZW50LnBhcmVudEVsZW1lbnQgfHwgKHBhcmVudCBhcyB1bmtub3duIGFzIHsgaG9zdDogRWxlbWVudCB9KS5ob3N0KSBhcyBFbGVtZW50IHwgbnVsbDtcclxuICAgICAgfVxyXG5cclxuICAgICAgaWYgKHBhcmVudCkge1xyXG4gICAgICAgIGlmICghcXVlc3Rpb25NYXAuaGFzKHBhcmVudCkpIHtcclxuICAgICAgICAgIHF1ZXN0aW9uTWFwLnNldChwYXJlbnQsIFtdKTtcclxuICAgICAgICB9XHJcbiAgICAgICAgcXVlc3Rpb25NYXAuZ2V0KHBhcmVudCkhLnB1c2goaXRlbS50ZXh0Q29udGVudD8udHJpbSgpIHx8IFwiXCIpO1xyXG4gICAgICB9XHJcbiAgICB9KTtcclxuXHJcbiAgICBsZXQgaW5kZXggPSAwO1xyXG4gICAgcXVlc3Rpb25NYXAuZm9yRWFjaCgob3B0aW9uVGV4dHMsIGNvbnRhaW5lcikgPT4ge1xyXG4gICAgICAvLyBUcnkgdG8gZ2V0IHF1ZXN0aW9uIHRleHRcclxuICAgICAgY29uc3QgcXVlc3Rpb25Cb2R5ID0gcXVlcnlTZWxlY3RvckFsbERlZXAoXHJcbiAgICAgICAgXCIubWNxX19ib2R5LWlubmVyXCIsXHJcbiAgICAgICAgY29udGFpbmVyLnNoYWRvd1Jvb3QgfHwgY29udGFpbmVyLFxyXG4gICAgICApWzBdO1xyXG4gICAgICBjb25zdCByYXdUZXh0ID0gcXVlc3Rpb25Cb2R5XHJcbiAgICAgICAgPyBxdWVzdGlvbkJvZHkudGV4dENvbnRlbnQ/LnRyaW0oKSB8fCBgUXVlc3Rpb24gJHtpbmRleCArIDF9YFxyXG4gICAgICAgIDogYFF1ZXN0aW9uICR7aW5kZXggKyAxfWA7XHJcbiAgICAgIGNvbnN0IHF1ZXN0aW9uVGV4dCA9IGNsZWFuUXVlc3Rpb25UZXh0KHJhd1RleHQpO1xyXG5cclxuICAgICAgY29uc3Qgb3B0aW9uczogUXVlc3Rpb25PcHRpb25bXSA9IG9wdGlvblRleHRzLm1hcCgodGV4dCwgaSkgPT4gKHtcclxuICAgICAgICBsZXR0ZXI6IFN0cmluZy5mcm9tQ2hhckNvZGUoNjUgKyBpKSxcclxuICAgICAgICB0ZXh0OiB0ZXh0LFxyXG4gICAgICB9KSk7XHJcblxyXG4gICAgICBpZiAob3B0aW9ucy5sZW5ndGggPj0gMikge1xyXG4gICAgICAgIHN0YXRlLmRldGVjdGVkUXVlc3Rpb25zLnB1c2goe1xyXG4gICAgICAgICAgaWQ6IGBxLSR7aW5kZXh9YCxcclxuICAgICAgICAgIGVsZW1lbnQ6IGNvbnRhaW5lcixcclxuICAgICAgICAgIHRleHQ6IHF1ZXN0aW9uVGV4dCxcclxuICAgICAgICAgIHR5cGU6IFwibXVsdGlwbGUtY2hvaWNlXCIsXHJcbiAgICAgICAgICBvcHRpb25zOiBvcHRpb25zLFxyXG4gICAgICAgICAgY29uZmlkZW5jZTogOTAsXHJcbiAgICAgICAgfSk7XHJcbiAgICAgICAgaW5kZXgrKztcclxuICAgICAgfVxyXG4gICAgfSk7XHJcblxyXG4gICAgaWYgKHN0YXRlLmRldGVjdGVkUXVlc3Rpb25zLmxlbmd0aCA+IDApIHtcclxuICAgICAgcmV0dXJuO1xyXG4gICAgfVxyXG4gIH1cclxuXHJcbiAgLy8gTWV0aG9kIDM6IEZhbGxiYWNrIC0gbG9vayBmb3IgcmVndWxhciBET00gZWxlbWVudHNcclxuICBjb25zdCBhbGxDbGFzc2VzID0gbmV3IFNldDxzdHJpbmc+KCk7XHJcbiAgZG9jdW1lbnQucXVlcnlTZWxlY3RvckFsbChcIipcIikuZm9yRWFjaCgoZWwpID0+IHtcclxuICAgIGlmIChlbC5jbGFzc05hbWUgJiYgdHlwZW9mIGVsLmNsYXNzTmFtZSA9PT0gXCJzdHJpbmdcIikge1xyXG4gICAgICBlbC5jbGFzc05hbWUuc3BsaXQoL1xccysvKS5mb3JFYWNoKChjbHMpID0+IHtcclxuICAgICAgICBpZiAoY2xzLmxlbmd0aCA+IDApIGFsbENsYXNzZXMuYWRkKGNscyk7XHJcbiAgICAgIH0pO1xyXG4gICAgfVxyXG4gIH0pO1xyXG5cclxuICAvLyBMb29rIGZvciBjbGFzc2VzIHRoYXQgbWlnaHQgaW5kaWNhdGUgcXVlc3Rpb25zL2Fuc3dlcnNcclxuICBjb25zdCByZWxldmFudENsYXNzZXMgPSBBcnJheS5mcm9tKGFsbENsYXNzZXMpLmZpbHRlcigoY2xzKSA9PlxyXG4gICAgL21jcXxxdWVzdGlvbnxhbnN3ZXJ8b3B0aW9ufGNob2ljZXxyYWRpb3xjaGVja3xzZWxlY3R8cXVpenxpdGVtL2kudGVzdChjbHMpLFxyXG4gICk7XHJcblxyXG4gIC8vIE1ldGhvZCA0OiBMb29rIGZvciByYWRpbyBidXR0b25zIG9yIGNoZWNrYm94ZXMgKHVuaXZlcnNhbCBxdWl6IGRldGVjdGlvbilcclxuICBjb25zdCByYWRpb0J1dHRvbnMgPSBkb2N1bWVudC5xdWVyeVNlbGVjdG9yQWxsKFxyXG4gICAgJ2lucHV0W3R5cGU9XCJyYWRpb1wiXSwgaW5wdXRbdHlwZT1cImNoZWNrYm94XCJdJyxcclxuICApIGFzIE5vZGVMaXN0T2Y8SFRNTElucHV0RWxlbWVudD47XHJcblxyXG4gIGlmIChyYWRpb0J1dHRvbnMubGVuZ3RoID49IDIpIHtcclxuICAgIC8vIEdyb3VwIHJhZGlvIGJ1dHRvbnMgYnkgdGhlaXIgbmFtZSBhdHRyaWJ1dGUgKGVhY2ggZ3JvdXAgPSBvbmUgcXVlc3Rpb24pXHJcbiAgICBjb25zdCBxdWVzdGlvbkdyb3VwcyA9IG5ldyBNYXA8c3RyaW5nLCBIVE1MSW5wdXRFbGVtZW50W10+KCk7XHJcblxyXG4gICAgcmFkaW9CdXR0b25zLmZvckVhY2goKHJhZGlvKSA9PiB7XHJcbiAgICAgIGNvbnN0IG5hbWUgPSByYWRpby5uYW1lIHx8IHJhZGlvLmlkIHx8IFwidW5uYW1lZFwiO1xyXG4gICAgICBpZiAoIXF1ZXN0aW9uR3JvdXBzLmhhcyhuYW1lKSkge1xyXG4gICAgICAgIHF1ZXN0aW9uR3JvdXBzLnNldChuYW1lLCBbXSk7XHJcbiAgICAgIH1cclxuICAgICAgcXVlc3Rpb25Hcm91cHMuZ2V0KG5hbWUpIS5wdXNoKHJhZGlvKTtcclxuICAgIH0pO1xyXG5cclxuICAgIGxldCBpbmRleCA9IDA7XHJcbiAgICBxdWVzdGlvbkdyb3Vwcy5mb3JFYWNoKChyYWRpb3MsIGdyb3VwTmFtZSkgPT4ge1xyXG4gICAgICBpZiAocmFkaW9zLmxlbmd0aCA+PSAyKSB7XHJcbiAgICAgICAgLy8gRmluZCB0aGUgY29udGFpbmVyIHRoYXQgaG9sZHMgYWxsIHRoZXNlIHJhZGlvIGJ1dHRvbnNcclxuICAgICAgICBsZXQgY29udGFpbmVyOiBFbGVtZW50IHwgbnVsbCA9IHJhZGlvc1swXS5jbG9zZXN0KFxyXG4gICAgICAgICAgJ2Zvcm0sIGZpZWxkc2V0LCBbcm9sZT1cImdyb3VwXCJdLCBbcm9sZT1cInJhZGlvZ3JvdXBcIl0nLFxyXG4gICAgICAgICk7XHJcbiAgICAgICAgaWYgKCFjb250YWluZXIpIHtcclxuICAgICAgICAgIC8vIEdvIHVwIHRvIGZpbmQgY29tbW9uIHBhcmVudFxyXG4gICAgICAgICAgY29udGFpbmVyID0gcmFkaW9zWzBdLnBhcmVudEVsZW1lbnQ7XHJcbiAgICAgICAgICBmb3IgKGxldCBpID0gMDsgaSA8IDEwOyBpKyspIHtcclxuICAgICAgICAgICAgaWYgKCFjb250YWluZXIgfHwgIWNvbnRhaW5lci5wYXJlbnRFbGVtZW50KSBicmVhaztcclxuICAgICAgICAgICAgY29uc3QgY29udGFpbnNBbGwgPSByYWRpb3MuZXZlcnkoKHIpID0+IGNvbnRhaW5lciEuY29udGFpbnMocikpO1xyXG4gICAgICAgICAgICBpZiAoXHJcbiAgICAgICAgICAgICAgY29udGFpbnNBbGwgJiZcclxuICAgICAgICAgICAgICAoY29udGFpbmVyIGFzIEhUTUxFbGVtZW50KS5pbm5lclRleHQgJiZcclxuICAgICAgICAgICAgICAoY29udGFpbmVyIGFzIEhUTUxFbGVtZW50KS5pbm5lclRleHQubGVuZ3RoID4gNTBcclxuICAgICAgICAgICAgKSB7XHJcbiAgICAgICAgICAgICAgYnJlYWs7XHJcbiAgICAgICAgICAgIH1cclxuICAgICAgICAgICAgY29udGFpbmVyID0gY29udGFpbmVyLnBhcmVudEVsZW1lbnQ7XHJcbiAgICAgICAgICB9XHJcbiAgICAgICAgfVxyXG5cclxuICAgICAgICBpZiAoY29udGFpbmVyKSB7XHJcbiAgICAgICAgICBjb25zdCBvcHRpb25zOiBRdWVzdGlvbk9wdGlvbltdID0gcmFkaW9zXHJcbiAgICAgICAgICAgIC5tYXAoKHJhZGlvLCBpKSA9PiB7XHJcbiAgICAgICAgICAgICAgLy8gRmluZCB0aGUgbGFiZWwgdGV4dCBmb3IgdGhpcyByYWRpb1xyXG4gICAgICAgICAgICAgIGxldCBsYWJlbFRleHQgPSBcIlwiO1xyXG4gICAgICAgICAgICAgIGNvbnN0IGxhYmVsID1cclxuICAgICAgICAgICAgICAgIHJhZGlvLmNsb3Nlc3QoXCJsYWJlbFwiKSB8fFxyXG4gICAgICAgICAgICAgICAgZG9jdW1lbnQucXVlcnlTZWxlY3RvcihgbGFiZWxbZm9yPVwiJHtyYWRpby5pZH1cIl1gKTtcclxuICAgICAgICAgICAgICBpZiAobGFiZWwpIHtcclxuICAgICAgICAgICAgICAgIGxhYmVsVGV4dCA9IChsYWJlbCBhcyBIVE1MRWxlbWVudCkuaW5uZXJUZXh0Py50cmltKCkgfHwgXCJcIjtcclxuICAgICAgICAgICAgICB9IGVsc2Uge1xyXG4gICAgICAgICAgICAgICAgLy8gVHJ5IHRvIGdldCB0ZXh0IGZyb20gcGFyZW50IG9yIG5leHQgc2libGluZ1xyXG4gICAgICAgICAgICAgICAgY29uc3QgcGFyZW50ID0gcmFkaW8ucGFyZW50RWxlbWVudDtcclxuICAgICAgICAgICAgICAgIGxhYmVsVGV4dCA9IChwYXJlbnQgYXMgSFRNTEVsZW1lbnQpPy5pbm5lclRleHQ/LnRyaW0oKSB8fCBcIlwiO1xyXG4gICAgICAgICAgICAgIH1cclxuICAgICAgICAgICAgICByZXR1cm4ge1xyXG4gICAgICAgICAgICAgICAgbGV0dGVyOiBTdHJpbmcuZnJvbUNoYXJDb2RlKDY1ICsgaSksXHJcbiAgICAgICAgICAgICAgICB0ZXh0OiBsYWJlbFRleHQsXHJcbiAgICAgICAgICAgICAgfTtcclxuICAgICAgICAgICAgfSlcclxuICAgICAgICAgICAgLmZpbHRlcigob3B0KSA9PiBvcHQudGV4dC5sZW5ndGggPiAwKTtcclxuXHJcbiAgICAgICAgICAvLyBFeHRyYWN0IHF1ZXN0aW9uIHRleHQgKHRleHQgYmVmb3JlIHRoZSBvcHRpb25zKVxyXG4gICAgICAgICAgY29uc3QgZnVsbFRleHQgPSAoY29udGFpbmVyIGFzIEhUTUxFbGVtZW50KS5pbm5lclRleHQgfHwgXCJcIjtcclxuICAgICAgICAgIGxldCBxdWVzdGlvblRleHQgPSBmdWxsVGV4dDtcclxuICAgICAgICAgIG9wdGlvbnMuZm9yRWFjaCgob3B0KSA9PiB7XHJcbiAgICAgICAgICAgIHF1ZXN0aW9uVGV4dCA9IHF1ZXN0aW9uVGV4dC5yZXBsYWNlKG9wdC50ZXh0LCBcIlwiKTtcclxuICAgICAgICAgIH0pO1xyXG4gICAgICAgICAgcXVlc3Rpb25UZXh0ID0gcXVlc3Rpb25UZXh0LnJlcGxhY2UoL1xccysvZywgXCIgXCIpLnRyaW0oKTtcclxuXHJcbiAgICAgICAgICBpZiAocXVlc3Rpb25UZXh0Lmxlbmd0aCA+IDEwICYmIG9wdGlvbnMubGVuZ3RoID49IDIpIHtcclxuICAgICAgICAgICAgc3RhdGUuZGV0ZWN0ZWRRdWVzdGlvbnMucHVzaCh7XHJcbiAgICAgICAgICAgICAgaWQ6IGBxLSR7aW5kZXh9YCxcclxuICAgICAgICAgICAgICBlbGVtZW50OiBjb250YWluZXIsXHJcbiAgICAgICAgICAgICAgdGV4dDogcXVlc3Rpb25UZXh0LnN1YnN0cmluZygwLCA1MDApLFxyXG4gICAgICAgICAgICAgIHR5cGU6IFwibXVsdGlwbGUtY2hvaWNlXCIsXHJcbiAgICAgICAgICAgICAgb3B0aW9uczogb3B0aW9ucyxcclxuICAgICAgICAgICAgICBjb25maWRlbmNlOiA4NSxcclxuICAgICAgICAgICAgfSk7XHJcbiAgICAgICAgICAgIGluZGV4Kys7XHJcbiAgICAgICAgICB9XHJcbiAgICAgICAgfVxyXG4gICAgICB9XHJcbiAgICB9KTtcclxuXHJcbiAgICBpZiAoc3RhdGUuZGV0ZWN0ZWRRdWVzdGlvbnMubGVuZ3RoID4gMCkge1xyXG4gICAgICByZXR1cm47XHJcbiAgICB9XHJcbiAgfVxyXG5cclxuICAvLyBNZXRob2QgNTogTG9vayBmb3IgbWNxIGNsYXNzZXMgaW4gcmVndWxhciBET00gKGZhbGxiYWNrKVxyXG4gIGNvbnN0IHJlZ3VsYXJNY3FJdGVtcyA9IGRvY3VtZW50LnF1ZXJ5U2VsZWN0b3JBbGwoXHJcbiAgICAnLm1jcV9faXRlbS10ZXh0LCAubWNxX19pdGVtLXRleHQtaW5uZXIsIFtjbGFzcyo9XCJtY3FfX1wiXSwgW2NsYXNzKj1cIm1jcS1cIl0nLFxyXG4gICk7XHJcblxyXG4gIGlmIChyZWd1bGFyTWNxSXRlbXMubGVuZ3RoID4gMCkge1xyXG4gICAgLy8gRmluZCBhbGwgcXVlc3Rpb24gY29udGFpbmVycyBieSBnb2luZyB1cCBmcm9tIG1jcSBpdGVtc1xyXG4gICAgY29uc3QgcXVlc3Rpb25Db250YWluZXJzID0gbmV3IFNldDxFbGVtZW50PigpO1xyXG5cclxuICAgIHJlZ3VsYXJNY3FJdGVtcy5mb3JFYWNoKChpdGVtKSA9PiB7XHJcbiAgICAgIC8vIEdvIHVwIHRvIGZpbmQgdGhlIHF1ZXN0aW9uIGNvbnRhaW5lclxyXG4gICAgICBsZXQgY29udGFpbmVyOiBFbGVtZW50IHwgbnVsbCA9IGl0ZW07XHJcbiAgICAgIGZvciAobGV0IGkgPSAwOyBpIDwgMTU7IGkrKykge1xyXG4gICAgICAgIGlmICghY29udGFpbmVyLnBhcmVudEVsZW1lbnQpIGJyZWFrO1xyXG4gICAgICAgIGNvbnRhaW5lciA9IGNvbnRhaW5lci5wYXJlbnRFbGVtZW50O1xyXG5cclxuICAgICAgICAvLyBDaGVjayBpZiB0aGlzIGNvbnRhaW5lciBoYXMgcXVlc3Rpb24gdGV4dCBhbmQgbXVsdGlwbGUgbWNxIGl0ZW1zXHJcbiAgICAgICAgY29uc3QgbWNxQ291bnQgPSBjb250YWluZXIucXVlcnlTZWxlY3RvckFsbChcclxuICAgICAgICAgICcubWNxX19pdGVtLCBbY2xhc3MqPVwibWNxX19pdGVtXCJdJyxcclxuICAgICAgICApLmxlbmd0aDtcclxuICAgICAgICBjb25zdCB0ZXh0ID0gKGNvbnRhaW5lciBhcyBIVE1MRWxlbWVudCkuaW5uZXJUZXh0IHx8IFwiXCI7XHJcblxyXG4gICAgICAgIC8vIElmIHdlIGhhdmUgMisgb3B0aW9ucyBhbmQgcXVlc3Rpb24tbGlrZSB0ZXh0LCB0aGlzIGlzIGxpa2VseSB0aGUgcXVlc3Rpb24gY29udGFpbmVyXHJcbiAgICAgICAgaWYgKG1jcUNvdW50ID49IDIgJiYgdGV4dC5sZW5ndGggPiA1MCAmJiB0ZXh0Lmxlbmd0aCA8IDUwMDApIHtcclxuICAgICAgICAgIC8vIENoZWNrIGlmIGl0IGxvb2tzIGxpa2UgYSBxdWVzdGlvblxyXG4gICAgICAgICAgaWYgKFxyXG4gICAgICAgICAgICAvXFw/fHByZWd1bnRhfHF1XHUwMEU5fGN1XHUwMEUxbHxjXHUwMEYzbW98ZFx1MDBGM25kZXx3aGljaHx3aGF0fGhvd3x3aGVyZS9pLnRlc3QodGV4dClcclxuICAgICAgICAgICkge1xyXG4gICAgICAgICAgICBxdWVzdGlvbkNvbnRhaW5lcnMuYWRkKGNvbnRhaW5lcik7XHJcbiAgICAgICAgICAgIGJyZWFrO1xyXG4gICAgICAgICAgfVxyXG4gICAgICAgIH1cclxuICAgICAgfVxyXG4gICAgfSk7XHJcblxyXG4gICAgLy8gUHJvY2VzcyBlYWNoIHF1ZXN0aW9uIGNvbnRhaW5lclxyXG4gICAgbGV0IGluZGV4ID0gMDtcclxuICAgIHF1ZXN0aW9uQ29udGFpbmVycy5mb3JFYWNoKChjb250YWluZXIpID0+IHtcclxuICAgICAgY29uc3QgcXVlc3Rpb25EYXRhID0gZXh0cmFjdE5ldEFjYWRRdWVzdGlvbihjb250YWluZXIpO1xyXG4gICAgICBpZiAocXVlc3Rpb25EYXRhKSB7XHJcbiAgICAgICAgc3RhdGUuZGV0ZWN0ZWRRdWVzdGlvbnMucHVzaCh7XHJcbiAgICAgICAgICBpZDogYHEtJHtpbmRleH1gLFxyXG4gICAgICAgICAgZWxlbWVudDogY29udGFpbmVyLFxyXG4gICAgICAgICAgdGV4dDogcXVlc3Rpb25EYXRhLnF1ZXN0aW9uVGV4dCxcclxuICAgICAgICAgIHR5cGU6IFwibXVsdGlwbGUtY2hvaWNlXCIsXHJcbiAgICAgICAgICBvcHRpb25zOiBxdWVzdGlvbkRhdGEub3B0aW9ucyxcclxuICAgICAgICAgIGNvbmZpZGVuY2U6IDkwLFxyXG4gICAgICAgIH0pO1xyXG4gICAgICAgIGluZGV4Kys7XHJcbiAgICAgIH1cclxuICAgIH0pO1xyXG5cclxuICAgIGlmIChzdGF0ZS5kZXRlY3RlZFF1ZXN0aW9ucy5sZW5ndGggPiAwKSB7XHJcbiAgICAgIHJldHVybjtcclxuICAgIH1cclxuICB9XHJcblxyXG4gIC8vIE1ldGhvZCA2OiBGYWxsYmFjayAtIExvb2sgZm9yIFwiUHJlZ3VudGEgWFwiIHBhdHRlcm5zIGluIHRoZSBwYWdlXHJcbiAgY29uc3QgZmFsbGJhY2tFbGVtZW50cyA9IGRvY3VtZW50LmJvZHkucXVlcnlTZWxlY3RvckFsbChcIipcIik7XHJcbiAgY29uc3QgcXVlc3Rpb25Db250YWluZXJzTGlzdDogRWxlbWVudFtdID0gW107XHJcblxyXG4gIC8vIEZpbmQgZWxlbWVudHMgY29udGFpbmluZyBcIlByZWd1bnRhIFhcIlxyXG4gIGZhbGxiYWNrRWxlbWVudHMuZm9yRWFjaCgoZWwpID0+IHtcclxuICAgIGNvbnN0IHRleHQgPSBlbC50ZXh0Q29udGVudCB8fCBcIlwiO1xyXG4gICAgaWYgKC9wcmVndW50YVxccypcXGQrL2kudGVzdCh0ZXh0KSAmJiB0ZXh0Lmxlbmd0aCA8IDUwMCkge1xyXG4gICAgICAvLyBGaW5kIHRoZSBwYXJlbnQgY29udGFpbmVyIHRoYXQgaG9sZHMgdGhlIGZ1bGwgcXVlc3Rpb25cclxuICAgICAgbGV0IGNvbnRhaW5lcjogRWxlbWVudCA9IGVsO1xyXG4gICAgICB3aGlsZSAoXHJcbiAgICAgICAgY29udGFpbmVyLnBhcmVudEVsZW1lbnQgJiZcclxuICAgICAgICBjb250YWluZXIucGFyZW50RWxlbWVudCAhPT0gZG9jdW1lbnQuYm9keVxyXG4gICAgICApIHtcclxuICAgICAgICBjb25zdCBwYXJlbnRUZXh0ID0gY29udGFpbmVyLnBhcmVudEVsZW1lbnQudGV4dENvbnRlbnQgfHwgXCJcIjtcclxuICAgICAgICAvLyBJZiBwYXJlbnQgY29udGFpbnMgcmFkaW8gYnV0dG9ucyBvciBvcHRpb25zLCB1c2UgaXRcclxuICAgICAgICBpZiAoXHJcbiAgICAgICAgICAvcmFkaW9fYnV0dG9ufGNoZWNrYm94L2kudGVzdChwYXJlbnRUZXh0KSB8fFxyXG4gICAgICAgICAgY29udGFpbmVyLnBhcmVudEVsZW1lbnQucXVlcnlTZWxlY3RvckFsbCgnaW5wdXRbdHlwZT1cInJhZGlvXCJdJylcclxuICAgICAgICAgICAgLmxlbmd0aCA+IDBcclxuICAgICAgICApIHtcclxuICAgICAgICAgIGNvbnRhaW5lciA9IGNvbnRhaW5lci5wYXJlbnRFbGVtZW50O1xyXG4gICAgICAgICAgYnJlYWs7XHJcbiAgICAgICAgfVxyXG4gICAgICAgIC8vIERvbid0IGdvIHRvbyBmYXIgdXBcclxuICAgICAgICBpZiAocGFyZW50VGV4dC5sZW5ndGggPiAzMDAwKSBicmVhaztcclxuICAgICAgICBjb250YWluZXIgPSBjb250YWluZXIucGFyZW50RWxlbWVudDtcclxuICAgICAgfVxyXG5cclxuICAgICAgLy8gQXZvaWQgZHVwbGljYXRlc1xyXG4gICAgICBpZiAoIXF1ZXN0aW9uQ29udGFpbmVyc0xpc3QuaW5jbHVkZXMoY29udGFpbmVyKSkge1xyXG4gICAgICAgIHF1ZXN0aW9uQ29udGFpbmVyc0xpc3QucHVzaChjb250YWluZXIpO1xyXG4gICAgICB9XHJcbiAgICB9XHJcbiAgfSk7XHJcblxyXG4gIC8vIEFsc28gbG9vayBmb3IgY29udGFpbmVycyB3aXRoIHJhZGlvX2J1dHRvbiB0ZXh0IChNYXRlcmlhbCBpY29ucylcclxuICBjb25zdCBib2R5VGV4dCA9IGRvY3VtZW50LmJvZHkuaW5uZXJUZXh0IHx8IFwiXCI7XHJcbiAgaWYgKC9yYWRpb19idXR0b25fKD86Y2hlY2tlZHx1bmNoZWNrZWQpL2kudGVzdChib2R5VGV4dCkpIHtcclxuICAgIC8vIEZpbmQgYWxsIHRleHQgbm9kZXMgd2l0aCByYWRpb19idXR0b25cclxuICAgIGNvbnN0IHdhbGtlciA9IGRvY3VtZW50LmNyZWF0ZVRyZWVXYWxrZXIoXHJcbiAgICAgIGRvY3VtZW50LmJvZHksXHJcbiAgICAgIE5vZGVGaWx0ZXIuU0hPV19URVhULFxyXG4gICAgKTtcclxuICAgIGxldCBub2RlOiBUZXh0IHwgbnVsbDtcclxuICAgIGNvbnN0IHJhZGlvQ29udGFpbmVycyA9IG5ldyBTZXQ8RWxlbWVudD4oKTtcclxuXHJcbiAgICB3aGlsZSAoKG5vZGUgPSB3YWxrZXIubmV4dE5vZGUoKSBhcyBUZXh0IHwgbnVsbCkpIHtcclxuICAgICAgaWYgKC9yYWRpb19idXR0b24vaS50ZXN0KG5vZGUudGV4dENvbnRlbnQgfHwgXCJcIikpIHtcclxuICAgICAgICBsZXQgcGFyZW50OiBFbGVtZW50IHwgbnVsbCA9IG5vZGUucGFyZW50RWxlbWVudDtcclxuICAgICAgICAvLyBHbyB1cCB0byBmaW5kIGEgcmVhc29uYWJsZSBjb250YWluZXJcclxuICAgICAgICBmb3IgKGxldCBpID0gMDsgaSA8IDEwICYmIHBhcmVudDsgaSsrKSB7XHJcbiAgICAgICAgICBpZiAoL3ByZWd1bnRhL2kudGVzdChwYXJlbnQudGV4dENvbnRlbnQgfHwgXCJcIikpIHtcclxuICAgICAgICAgICAgcmFkaW9Db250YWluZXJzLmFkZChwYXJlbnQpO1xyXG4gICAgICAgICAgICBicmVhaztcclxuICAgICAgICAgIH1cclxuICAgICAgICAgIHBhcmVudCA9IHBhcmVudC5wYXJlbnRFbGVtZW50O1xyXG4gICAgICAgIH1cclxuICAgICAgfVxyXG4gICAgfVxyXG5cclxuICAgIHJhZGlvQ29udGFpbmVycy5mb3JFYWNoKChjb250YWluZXIpID0+IHtcclxuICAgICAgaWYgKCFxdWVzdGlvbkNvbnRhaW5lcnNMaXN0LmluY2x1ZGVzKGNvbnRhaW5lcikpIHtcclxuICAgICAgICBxdWVzdGlvbkNvbnRhaW5lcnNMaXN0LnB1c2goY29udGFpbmVyKTtcclxuICAgICAgfVxyXG4gICAgfSk7XHJcbiAgfVxyXG5cclxuICAvLyBQcm9jZXNzIGZvdW5kIGNvbnRhaW5lcnNcclxuICBxdWVzdGlvbkNvbnRhaW5lcnNMaXN0LmZvckVhY2goKGNvbnRhaW5lciwgaW5kZXgpID0+IHtcclxuICAgIGNvbnN0IHRleHQgPSBnZXRWaXNpYmxlVGV4dChjb250YWluZXIpO1xyXG4gICAgaWYgKHRleHQgJiYgdGV4dC5sZW5ndGggPiAzMCkge1xyXG4gICAgICBjb25zdCBvcHRpb25zID0gZXh0cmFjdE5ldEFjYWRPcHRpb25zKHRleHQsIGNvbnRhaW5lcik7XHJcbiAgICAgIHN0YXRlLmRldGVjdGVkUXVlc3Rpb25zLnB1c2goe1xyXG4gICAgICAgIGlkOiBgcS0ke2luZGV4fWAsXHJcbiAgICAgICAgZWxlbWVudDogY29udGFpbmVyLFxyXG4gICAgICAgIHRleHQ6IHRleHQsXHJcbiAgICAgICAgdHlwZTogXCJtdWx0aXBsZS1jaG9pY2VcIixcclxuICAgICAgICBvcHRpb25zOiBvcHRpb25zLFxyXG4gICAgICAgIGNvbmZpZGVuY2U6IDgwLFxyXG4gICAgICB9KTtcclxuICAgIH1cclxuICB9KTtcclxufVxyXG5cclxuLy8gPT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT1cclxuLy8gRXh0cmFjdCBOZXRBY2FkIE9wdGlvbnNcclxuLy8gPT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT1cclxuXHJcbi8qKlxyXG4gKiBFeHRyYWN0IG9wdGlvbnMgZnJvbSBOZXRBY2FkIHF1ZXN0aW9uIHRleHRcclxuICogQHBhcmFtIHRleHQgLSBUaGUgcXVlc3Rpb24gdGV4dFxyXG4gKiBAcGFyYW0gZWxlbWVudCAtIFRoZSBxdWVzdGlvbiBlbGVtZW50XHJcbiAqIEByZXR1cm5zIEFycmF5IG9mIG9wdGlvbiBvYmplY3RzIHdpdGggbGV0dGVyIGFuZCB0ZXh0XHJcbiAqL1xyXG5leHBvcnQgZnVuY3Rpb24gZXh0cmFjdE5ldEFjYWRPcHRpb25zKHRleHQ6IHN0cmluZywgZWxlbWVudDogRWxlbWVudCk6IFF1ZXN0aW9uT3B0aW9uW10ge1xyXG4gIGNvbnN0IG9wdGlvbnM6IFF1ZXN0aW9uT3B0aW9uW10gPSBbXTtcclxuXHJcbiAgLy8gU3BsaXQgYnkgcmFkaW9fYnV0dG9uIG1hcmtlcnNcclxuICBjb25zdCBwYXJ0cyA9IHRleHQuc3BsaXQoL3JhZGlvX2J1dHRvbl8oPzpjaGVja2VkfHVuY2hlY2tlZCkvaSk7XHJcblxyXG4gIC8vIEZpcnN0IHBhcnQgaXMgdGhlIHF1ZXN0aW9uLCByZXN0IGFyZSBvcHRpb25zXHJcbiAgaWYgKHBhcnRzLmxlbmd0aCA+IDEpIHtcclxuICAgIHBhcnRzLnNsaWNlKDEpLmZvckVhY2goKHBhcnQsIGluZGV4KSA9PiB7XHJcbiAgICAgIGNvbnN0IG9wdGlvblRleHQgPSBwYXJ0LnRyaW0oKS5zcGxpdChcIlxcblwiKVswXS50cmltKCk7XHJcbiAgICAgIGlmIChvcHRpb25UZXh0ICYmIG9wdGlvblRleHQubGVuZ3RoID4gMikge1xyXG4gICAgICAgIG9wdGlvbnMucHVzaCh7XHJcbiAgICAgICAgICBsZXR0ZXI6IFN0cmluZy5mcm9tQ2hhckNvZGUoNjUgKyBpbmRleCksIC8vIEEsIEIsIEMsIEQuLi5cclxuICAgICAgICAgIHRleHQ6IG9wdGlvblRleHQsXHJcbiAgICAgICAgfSk7XHJcbiAgICAgIH1cclxuICAgIH0pO1xyXG4gIH1cclxuXHJcbiAgcmV0dXJuIG9wdGlvbnM7XHJcbn1cclxuXHJcbi8vID09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09XHJcbi8vIEV4dHJhY3QgTmV0QWNhZCBRdWVzdGlvbiAodXNpbmcgbWNxIGNsYXNzZXMpXHJcbi8vID09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09XHJcblxyXG4vKipcclxuICogRXh0cmFjdCBxdWVzdGlvbiBkYXRhIGZyb20gYSBOZXRBY2FkIGNvbnRhaW5lciB1c2luZyBtY3EgY2xhc3Nlc1xyXG4gKiBAcGFyYW0gY29udGFpbmVyIC0gVGhlIHF1ZXN0aW9uIGNvbnRhaW5lciBlbGVtZW50XHJcbiAqIEByZXR1cm5zIFF1ZXN0aW9uIGRhdGEgb3IgbnVsbCBpZiBleHRyYWN0aW9uIGZhaWxzXHJcbiAqL1xyXG5leHBvcnQgZnVuY3Rpb24gZXh0cmFjdE5ldEFjYWRRdWVzdGlvbihjb250YWluZXI6IEVsZW1lbnQpOiBOZXRBY2FkUXVlc3Rpb25EYXRhIHwgbnVsbCB7XHJcbiAgY29uc3Qgb3B0aW9uczogUXVlc3Rpb25PcHRpb25bXSA9IFtdO1xyXG5cclxuICAvLyBGaW5kIGFsbCBhbnN3ZXIgb3B0aW9ucyB1c2luZyBtY3EgY2xhc3Nlc1xyXG4gIGNvbnN0IG1jcUl0ZW1zID0gY29udGFpbmVyLnF1ZXJ5U2VsZWN0b3JBbGwoXHJcbiAgICAnLm1jcV9faXRlbSwgW2NsYXNzKj1cIm1jcV9faXRlbVwiXScsXHJcbiAgKTtcclxuXHJcbiAgaWYgKG1jcUl0ZW1zLmxlbmd0aCA9PT0gMCkge1xyXG4gICAgLy8gVHJ5IGFsdGVybmF0aXZlOiBsb29rIGZvciBtY3FfX2l0ZW0tdGV4dCBkaXJlY3RseVxyXG4gICAgY29uc3QgdGV4dEl0ZW1zID0gY29udGFpbmVyLnF1ZXJ5U2VsZWN0b3JBbGwoXHJcbiAgICAgIFwiLm1jcV9faXRlbS10ZXh0LCAubWNxX19pdGVtLXRleHQtaW5uZXJcIixcclxuICAgICk7XHJcbiAgICB0ZXh0SXRlbXMuZm9yRWFjaCgoaXRlbSwgaW5kZXgpID0+IHtcclxuICAgICAgY29uc3QgdGV4dCA9IChpdGVtIGFzIEhUTUxFbGVtZW50KS5pbm5lclRleHQ/LnRyaW0oKTtcclxuICAgICAgaWYgKHRleHQgJiYgdGV4dC5sZW5ndGggPiAxKSB7XHJcbiAgICAgICAgb3B0aW9ucy5wdXNoKHtcclxuICAgICAgICAgIGxldHRlcjogU3RyaW5nLmZyb21DaGFyQ29kZSg2NSArIGluZGV4KSxcclxuICAgICAgICAgIHRleHQ6IHRleHQsXHJcbiAgICAgICAgfSk7XHJcbiAgICAgIH1cclxuICAgIH0pO1xyXG4gIH0gZWxzZSB7XHJcbiAgICBtY3FJdGVtcy5mb3JFYWNoKChpdGVtLCBpbmRleCkgPT4ge1xyXG4gICAgICBjb25zdCB0ZXh0RWwgPVxyXG4gICAgICAgIGl0ZW0ucXVlcnlTZWxlY3RvcihcIi5tY3FfX2l0ZW0tdGV4dC1pbm5lciwgLm1jcV9faXRlbS10ZXh0XCIpIHx8IGl0ZW07XHJcbiAgICAgIGNvbnN0IHRleHQgPSAodGV4dEVsIGFzIEhUTUxFbGVtZW50KS5pbm5lclRleHQ/LnRyaW0oKTtcclxuICAgICAgaWYgKHRleHQgJiYgdGV4dC5sZW5ndGggPiAxKSB7XHJcbiAgICAgICAgb3B0aW9ucy5wdXNoKHtcclxuICAgICAgICAgIGxldHRlcjogU3RyaW5nLmZyb21DaGFyQ29kZSg2NSArIGluZGV4KSxcclxuICAgICAgICAgIHRleHQ6IHRleHQsXHJcbiAgICAgICAgfSk7XHJcbiAgICAgIH1cclxuICAgIH0pO1xyXG4gIH1cclxuXHJcbiAgLy8gRXh0cmFjdCB0aGUgcXVlc3Rpb24gdGV4dCAoZXZlcnl0aGluZyB0aGF0J3Mgbm90IGFuIG9wdGlvbilcclxuICBsZXQgcXVlc3Rpb25UZXh0ID0gKGNvbnRhaW5lciBhcyBIVE1MRWxlbWVudCkuaW5uZXJUZXh0IHx8IFwiXCI7XHJcblxyXG4gIC8vIFJlbW92ZSBvcHRpb24gdGV4dHMgZnJvbSBxdWVzdGlvbiB0ZXh0IHRvIGdldCBjbGVhbiBxdWVzdGlvblxyXG4gIG9wdGlvbnMuZm9yRWFjaCgob3B0KSA9PiB7XHJcbiAgICBxdWVzdGlvblRleHQgPSBxdWVzdGlvblRleHQucmVwbGFjZShvcHQudGV4dCwgXCJcIik7XHJcbiAgfSk7XHJcblxyXG4gIC8vIENsZWFuIHVwIHRoZSBxdWVzdGlvbiB0ZXh0XHJcbiAgcXVlc3Rpb25UZXh0ID0gcXVlc3Rpb25UZXh0XHJcbiAgICAucmVwbGFjZSgvcmFkaW9fYnV0dG9uXyg/OmNoZWNrZWR8dW5jaGVja2VkKS9naSwgXCJcIilcclxuICAgIC5yZXBsYWNlKC9cXHMrL2csIFwiIFwiKVxyXG4gICAgLnRyaW0oKTtcclxuXHJcbiAgaWYgKHF1ZXN0aW9uVGV4dC5sZW5ndGggPCAxMCB8fCBvcHRpb25zLmxlbmd0aCA8IDIpIHtcclxuICAgIHJldHVybiBudWxsO1xyXG4gIH1cclxuXHJcbiAgcmV0dXJuIHtcclxuICAgIHF1ZXN0aW9uVGV4dDogcXVlc3Rpb25UZXh0LFxyXG4gICAgb3B0aW9uczogb3B0aW9ucyxcclxuICB9O1xyXG59XHJcblxyXG4vLyA9PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PVxyXG4vLyBHZW5lcmFsIFF1ZXN0aW9uIERldGVjdGlvblxyXG4vLyA9PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PVxyXG5cclxuLyoqXHJcbiAqIERldGVjdCBxdWVzdGlvbnMgdXNpbmcgZ2VuZXJhbCBwYXR0ZXJuc1xyXG4gKiBXb3JrcyBhY3Jvc3MgdmFyaW91cyBxdWl6IHBsYXRmb3Jtc1xyXG4gKi9cclxuZXhwb3J0IGZ1bmN0aW9uIGRldGVjdEdlbmVyYWxRdWVzdGlvbnMoKTogdm9pZCB7XHJcbiAgLy8gR2V0IGFsbCB0ZXh0LWNvbnRhaW5pbmcgZWxlbWVudHNcclxuICBjb25zdCB0ZXh0RWxlbWVudHMgPSBkb2N1bWVudC5xdWVyeVNlbGVjdG9yQWxsKFxyXG4gICAgXCJwLCBkaXYsIHNwYW4sIGxpLCB0ZCwgdGgsIGxhYmVsLCBoMSwgaDIsIGgzLCBoNCwgaDUsIGg2LCBcIiArXHJcbiAgICAgIFwiYXJ0aWNsZSwgc2VjdGlvbiwgYmxvY2txdW90ZSwgLnF1ZXN0aW9uLCAucXVpei1xdWVzdGlvbiwgXCIgK1xyXG4gICAgICAnW2NsYXNzKj1cInF1ZXN0aW9uXCJdLCBbY2xhc3MqPVwicXVpelwiXSwgW2NsYXNzKj1cImV4YW1cIl0sICcgK1xyXG4gICAgICAnW2RhdGEtcXVlc3Rpb25dLCBbcm9sZT1cImxpc3RpdGVtXCJdJyxcclxuICApO1xyXG5cclxuICBjb25zdCBwcm9jZXNzZWRUZXh0cyA9IG5ldyBTZXQ8c3RyaW5nPigpO1xyXG5cclxuICB0ZXh0RWxlbWVudHMuZm9yRWFjaCgoZWxlbWVudCwgaW5kZXgpID0+IHtcclxuICAgIGNvbnN0IHRleHQgPSBnZXRWaXNpYmxlVGV4dChlbGVtZW50KTtcclxuXHJcbiAgICAvLyBTa2lwIGVtcHR5LCB0b28gc2hvcnQsIG9yIGR1cGxpY2F0ZSB0ZXh0c1xyXG4gICAgaWYgKCF0ZXh0IHx8IHRleHQubGVuZ3RoIDwgMjAgfHwgcHJvY2Vzc2VkVGV4dHMuaGFzKHRleHQpKSByZXR1cm47XHJcblxyXG4gICAgLy8gU2tpcCBpZiBwYXJlbnQgYWxyZWFkeSBwcm9jZXNzZWQgKGF2b2lkIGR1cGxpY2F0ZXMpXHJcbiAgICBpZiAoaXNDaGlsZE9mUHJvY2Vzc2VkKGVsZW1lbnQsIHN0YXRlLmRldGVjdGVkUXVlc3Rpb25zKSkgcmV0dXJuO1xyXG5cclxuICAgIGNvbnN0IHF1ZXN0aW9uSW5mbyA9IGFuYWx5emVUZXh0Rm9yUXVlc3Rpb24odGV4dCwgZWxlbWVudCk7XHJcblxyXG4gICAgaWYgKHF1ZXN0aW9uSW5mby5pc1F1ZXN0aW9uKSB7XHJcbiAgICAgIHByb2Nlc3NlZFRleHRzLmFkZCh0ZXh0KTtcclxuICAgICAgc3RhdGUuZGV0ZWN0ZWRRdWVzdGlvbnMucHVzaCh7XHJcbiAgICAgICAgaWQ6IGBxLSR7c3RhdGUuZGV0ZWN0ZWRRdWVzdGlvbnMubGVuZ3RofWAsXHJcbiAgICAgICAgZWxlbWVudDogZWxlbWVudCxcclxuICAgICAgICB0ZXh0OiB0ZXh0LFxyXG4gICAgICAgIHR5cGU6IHF1ZXN0aW9uSW5mby50eXBlLFxyXG4gICAgICAgIG9wdGlvbnM6IHF1ZXN0aW9uSW5mby5vcHRpb25zIGFzIFF1ZXN0aW9uT3B0aW9uW10sXHJcbiAgICAgICAgY29uZmlkZW5jZTogcXVlc3Rpb25JbmZvLmNvbmZpZGVuY2UsXHJcbiAgICAgIH0pO1xyXG4gICAgfVxyXG4gIH0pO1xyXG59XHJcblxyXG4vLyA9PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PVxyXG4vLyBRdWVzdGlvbiBBbmFseXNpc1xyXG4vLyA9PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PVxyXG5cclxuLyoqXHJcbiAqIEFuYWx5emUgdGV4dCB0byBkZXRlcm1pbmUgaWYgaXQncyBhIHF1ZXN0aW9uIGFuZCBleHRyYWN0IG1ldGFkYXRhXHJcbiAqIEBwYXJhbSB0ZXh0IC0gVGhlIHRleHQgdG8gYW5hbHl6ZVxyXG4gKiBAcGFyYW0gZWxlbWVudCAtIFRoZSBlbGVtZW50IGNvbnRhaW5pbmcgdGhlIHRleHRcclxuICogQHJldHVybnMgQW5hbHlzaXMgcmVzdWx0IHdpdGggaXNRdWVzdGlvbiwgdHlwZSwgb3B0aW9ucywgY29uZmlkZW5jZVxyXG4gKi9cclxuZXhwb3J0IGZ1bmN0aW9uIGFuYWx5emVUZXh0Rm9yUXVlc3Rpb24odGV4dDogc3RyaW5nLCBlbGVtZW50OiBFbGVtZW50KTogQW5hbHlzaXNSZXN1bHQge1xyXG4gIGxldCBpc1F1ZXN0aW9uID0gZmFsc2U7XHJcbiAgbGV0IHR5cGU6IFF1ZXN0aW9uVHlwZSA9IFwidW5rbm93blwiO1xyXG4gIGxldCBvcHRpb25zOiBRdWVzdGlvbk9wdGlvbltdIHwgc3RyaW5nW10gPSBbXTtcclxuICBsZXQgY29uZmlkZW5jZSA9IDA7XHJcblxyXG4gIC8vIENoZWNrIGZvciBxdWVzdGlvbiBtYXJrZXJzXHJcbiAgaWYgKFFVRVNUSU9OX1BBVFRFUk5TLnF1ZXN0aW9uTWFya2Vycy50ZXN0KHRleHQpKSB7XHJcbiAgICBjb25maWRlbmNlICs9IDMwO1xyXG4gIH1cclxuXHJcbiAgLy8gQ2hlY2sgZm9yIG11bHRpcGxlIGNob2ljZVxyXG4gIGZvciAoY29uc3QgcGF0dGVybiBvZiBRVUVTVElPTl9QQVRURVJOUy5tdWx0aXBsZUNob2ljZSkge1xyXG4gICAgaWYgKHBhdHRlcm4udGVzdCh0ZXh0KSkge1xyXG4gICAgICB0eXBlID0gXCJtdWx0aXBsZS1jaG9pY2VcIjtcclxuICAgICAgY29uZmlkZW5jZSArPSA0MDtcclxuICAgICAgb3B0aW9ucyA9IGV4dHJhY3RPcHRpb25zKHRleHQsIGVsZW1lbnQpO1xyXG4gICAgICBicmVhaztcclxuICAgIH1cclxuICB9XHJcblxyXG4gIC8vIENoZWNrIGZvciB0cnVlL2ZhbHNlXHJcbiAgaWYgKHR5cGUgPT09IFwidW5rbm93blwiKSB7XHJcbiAgICBmb3IgKGNvbnN0IHBhdHRlcm4gb2YgUVVFU1RJT05fUEFUVEVSTlMudHJ1ZUZhbHNlKSB7XHJcbiAgICAgIGlmIChwYXR0ZXJuLnRlc3QodGV4dCkpIHtcclxuICAgICAgICB0eXBlID0gXCJ0cnVlLWZhbHNlXCI7XHJcbiAgICAgICAgY29uZmlkZW5jZSArPSAzNTtcclxuICAgICAgICBvcHRpb25zID0gW1wiVHJ1ZVwiLCBcIkZhbHNlXCJdO1xyXG4gICAgICAgIGJyZWFrO1xyXG4gICAgICB9XHJcbiAgICB9XHJcbiAgfVxyXG5cclxuICAvLyBDaGVjayBmb3IgZmlsbCBpbiB0aGUgYmxhbmtcclxuICBpZiAodHlwZSA9PT0gXCJ1bmtub3duXCIpIHtcclxuICAgIGZvciAoY29uc3QgcGF0dGVybiBvZiBRVUVTVElPTl9QQVRURVJOUy5maWxsQmxhbmspIHtcclxuICAgICAgaWYgKHBhdHRlcm4udGVzdCh0ZXh0KSkge1xyXG4gICAgICAgIHR5cGUgPSBcImZpbGwtYmxhbmtcIjtcclxuICAgICAgICBjb25maWRlbmNlICs9IDMwO1xyXG4gICAgICAgIGJyZWFrO1xyXG4gICAgICB9XHJcbiAgICB9XHJcbiAgfVxyXG5cclxuICAvLyBDaGVjayBlbGVtZW50IGNsYXNzZXMvYXR0cmlidXRlcyBmb3IgcXVlc3Rpb24gaW5kaWNhdG9yc1xyXG4gIGNvbnN0IGNsYXNzTGlzdCA9IChlbGVtZW50LmNsYXNzTmFtZSB8fCBcIlwiKS50b1N0cmluZygpLnRvTG93ZXJDYXNlKCk7XHJcbiAgY29uc3QgZGF0YUF0dHJzID0gQXJyYXkuZnJvbShlbGVtZW50LmF0dHJpYnV0ZXMpXHJcbiAgICAubWFwKChhKSA9PiBhLm5hbWUudG9Mb3dlckNhc2UoKSlcclxuICAgIC5qb2luKFwiIFwiKTtcclxuXHJcbiAgaWYgKC9xdWVzdGlvbnxxdWl6fGV4YW18dGVzdHxhc3Nlc3NtZW50L2kudGVzdChjbGFzc0xpc3QgKyBcIiBcIiArIGRhdGFBdHRycykpIHtcclxuICAgIGNvbmZpZGVuY2UgKz0gMjU7XHJcbiAgfVxyXG5cclxuICAvLyBDaGVjayBmb3IgcmFkaW8vY2hlY2tib3ggaW5wdXRzXHJcbiAgY29uc3QgaGFzSW5wdXRzID1cclxuICAgIGVsZW1lbnQucXVlcnlTZWxlY3RvckFsbCgnaW5wdXRbdHlwZT1cInJhZGlvXCJdLCBpbnB1dFt0eXBlPVwiY2hlY2tib3hcIl0nKVxyXG4gICAgICAubGVuZ3RoID4gMDtcclxuICBpZiAoaGFzSW5wdXRzKSB7XHJcbiAgICB0eXBlID0gdHlwZSA9PT0gXCJ1bmtub3duXCIgPyBcIm11bHRpcGxlLWNob2ljZVwiIDogdHlwZTtcclxuICAgIGNvbmZpZGVuY2UgKz0gMzU7XHJcbiAgICBpZiAob3B0aW9ucy5sZW5ndGggPT09IDApIHtcclxuICAgICAgb3B0aW9ucyA9IGV4dHJhY3RPcHRpb25zRnJvbUlucHV0cyhlbGVtZW50KTtcclxuICAgIH1cclxuICB9XHJcblxyXG4gIC8vIERldGVybWluZSBpZiBpdCdzIGEgcXVlc3Rpb24gYmFzZWQgb24gY29uZmlkZW5jZVxyXG4gIGlzUXVlc3Rpb24gPSBjb25maWRlbmNlID49IDQwO1xyXG5cclxuICByZXR1cm4geyBpc1F1ZXN0aW9uLCB0eXBlLCBvcHRpb25zLCBjb25maWRlbmNlIH07XHJcbn1cclxuXHJcbi8vID09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09XHJcbi8vIE9wdGlvbiBFeHRyYWN0aW9uXHJcbi8vID09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09XHJcblxyXG4vKipcclxuICogRXh0cmFjdCBvcHRpb25zIGZyb20gcXVlc3Rpb24gdGV4dCB1c2luZyB2YXJpb3VzIHBhdHRlcm5zXHJcbiAqIEBwYXJhbSB0ZXh0IC0gVGhlIHF1ZXN0aW9uIHRleHRcclxuICogQHBhcmFtIGVsZW1lbnQgLSBUaGUgcXVlc3Rpb24gZWxlbWVudFxyXG4gKiBAcmV0dXJucyBBcnJheSBvZiBvcHRpb24gb2JqZWN0cyB3aXRoIGxldHRlciBhbmQgdGV4dFxyXG4gKi9cclxuZXhwb3J0IGZ1bmN0aW9uIGV4dHJhY3RPcHRpb25zKHRleHQ6IHN0cmluZywgZWxlbWVudDogRWxlbWVudCk6IFF1ZXN0aW9uT3B0aW9uW10ge1xyXG4gIGNvbnN0IG9wdGlvbnM6IFF1ZXN0aW9uT3B0aW9uW10gPSBbXTtcclxuXHJcbiAgLy8gUGF0dGVybiAxOiBBLiBBbnN3ZXIsIEIuIEFuc3dlciwgZXRjLlxyXG4gIGNvbnN0IGxldHRlclBhdHRlcm4gPSAvKD86XnxcXG4pXFxzKihbQS1EYS1kXSlbXFwuXFwpXFw6XT9cXHMqKFteXFxuXSspL2dtO1xyXG4gIGxldCBtYXRjaDogUmVnRXhwRXhlY0FycmF5IHwgbnVsbDtcclxuXHJcbiAgd2hpbGUgKChtYXRjaCA9IGxldHRlclBhdHRlcm4uZXhlYyh0ZXh0KSkgIT09IG51bGwpIHtcclxuICAgIG9wdGlvbnMucHVzaCh7XHJcbiAgICAgIGxldHRlcjogbWF0Y2hbMV0udG9VcHBlckNhc2UoKSxcclxuICAgICAgdGV4dDogbWF0Y2hbMl0udHJpbSgpLFxyXG4gICAgfSk7XHJcbiAgfVxyXG5cclxuICAvLyBQYXR0ZXJuIDI6IChBKSBBbnN3ZXIsIChCKSBBbnN3ZXIsIGV0Yy5cclxuICBpZiAob3B0aW9ucy5sZW5ndGggPT09IDApIHtcclxuICAgIGNvbnN0IHBhcmVuUGF0dGVybiA9IC9cXCgoW0EtRGEtZF0pXFwpXFxzKihbXlxcblxcKF0rKS9nbTtcclxuICAgIHdoaWxlICgobWF0Y2ggPSBwYXJlblBhdHRlcm4uZXhlYyh0ZXh0KSkgIT09IG51bGwpIHtcclxuICAgICAgb3B0aW9ucy5wdXNoKHtcclxuICAgICAgICBsZXR0ZXI6IG1hdGNoWzFdLnRvVXBwZXJDYXNlKCksXHJcbiAgICAgICAgdGV4dDogbWF0Y2hbMl0udHJpbSgpLFxyXG4gICAgICB9KTtcclxuICAgIH1cclxuICB9XHJcblxyXG4gIC8vIFBhdHRlcm4gMzogTnVtYmVyZWQgb3B0aW9uc1xyXG4gIGlmIChvcHRpb25zLmxlbmd0aCA9PT0gMCkge1xyXG4gICAgY29uc3QgbnVtYmVyUGF0dGVybiA9IC8oPzpefFxcbilcXHMqKFsxLTRdKVtcXC5cXClcXDpdP1xccyooW15cXG5dKykvZ207XHJcbiAgICB3aGlsZSAoKG1hdGNoID0gbnVtYmVyUGF0dGVybi5leGVjKHRleHQpKSAhPT0gbnVsbCkge1xyXG4gICAgICBvcHRpb25zLnB1c2goe1xyXG4gICAgICAgIGxldHRlcjogbWF0Y2hbMV0sXHJcbiAgICAgICAgdGV4dDogbWF0Y2hbMl0udHJpbSgpLFxyXG4gICAgICB9KTtcclxuICAgIH1cclxuICB9XHJcblxyXG4gIHJldHVybiBvcHRpb25zO1xyXG59XHJcblxyXG4vKipcclxuICogRXh0cmFjdCBvcHRpb25zIGZyb20gaW5wdXQgZWxlbWVudHMgKHJhZGlvL2NoZWNrYm94KVxyXG4gKiBAcGFyYW0gZWxlbWVudCAtIFRoZSBjb250YWluZXIgZWxlbWVudCB3aXRoIGlucHV0c1xyXG4gKiBAcmV0dXJucyBBcnJheSBvZiBvcHRpb24gb2JqZWN0cyB3aXRoIGxldHRlciBhbmQgdGV4dFxyXG4gKi9cclxuZXhwb3J0IGZ1bmN0aW9uIGV4dHJhY3RPcHRpb25zRnJvbUlucHV0cyhlbGVtZW50OiBFbGVtZW50KTogUXVlc3Rpb25PcHRpb25bXSB7XHJcbiAgY29uc3Qgb3B0aW9uczogUXVlc3Rpb25PcHRpb25bXSA9IFtdO1xyXG4gIGNvbnN0IGlucHV0cyA9IGVsZW1lbnQucXVlcnlTZWxlY3RvckFsbChcclxuICAgICdpbnB1dFt0eXBlPVwicmFkaW9cIl0sIGlucHV0W3R5cGU9XCJjaGVja2JveFwiXScsXHJcbiAgKSBhcyBOb2RlTGlzdE9mPEhUTUxJbnB1dEVsZW1lbnQ+O1xyXG5cclxuICBpbnB1dHMuZm9yRWFjaCgoaW5wdXQsIGluZGV4KSA9PiB7XHJcbiAgICBjb25zdCBsYWJlbCA9XHJcbiAgICAgIGVsZW1lbnQucXVlcnlTZWxlY3RvcihgbGFiZWxbZm9yPVwiJHtpbnB1dC5pZH1cIl1gKSB8fFxyXG4gICAgICBpbnB1dC5jbG9zZXN0KFwibGFiZWxcIik7XHJcblxyXG4gICAgY29uc3QgdGV4dCA9IGxhYmVsXHJcbiAgICAgID8gZ2V0VmlzaWJsZVRleHQobGFiZWwpXHJcbiAgICAgIDogaW5wdXQudmFsdWUgfHwgYE9wdGlvbiAke2luZGV4ICsgMX1gO1xyXG5cclxuICAgIG9wdGlvbnMucHVzaCh7XHJcbiAgICAgIGxldHRlcjogU3RyaW5nLmZyb21DaGFyQ29kZSg2NSArIGluZGV4KSwgLy8gQSwgQiwgQywgRC4uLlxyXG4gICAgICB0ZXh0OiAodGV4dCB8fCBcIlwiKS5yZXBsYWNlKC9eW0EtRGEtZF1bXFwuXFwpXFw6XVxccyovLCBcIlwiKS50cmltKCksXHJcbiAgICB9KTtcclxuICB9KTtcclxuXHJcbiAgcmV0dXJuIG9wdGlvbnM7XHJcbn1cclxuXHJcbi8vID09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09XHJcbi8vIFF1aXogQ29udGVudCBEZXRlY3Rpb25cclxuLy8gPT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT1cclxuXHJcbi8qKlxyXG4gKiBDaGVjayBpZiB0aGlzIGZyYW1lIGNvbnRhaW5zIHF1aXogY29udGVudCAoTmV0QWNhZCBvciBNb29kbGUpXHJcbiAqIFVzZWQgdG8gb25seSBzaG93IFVJIGluIHRoZSBjb3JyZWN0IGZyYW1lXHJcbiAqIEByZXR1cm5zIFRydWUgaWYgcXVpeiBjb250ZW50IGlzIGRldGVjdGVkXHJcbiAqL1xyXG5leHBvcnQgZnVuY3Rpb24gZnJhbWVIYXNRdWl6Q29udGVudCgpOiBib29sZWFuIHtcclxuICAvLyBOZXRBY2FkIGRldGVjdGlvblxyXG4gIGNvbnN0IG1jcVZpZXdzID0gcXVlcnlTZWxlY3RvckFsbERlZXAoXCJtY3Etdmlld1wiKTtcclxuICBjb25zdCBtYXRjaGluZ1ZpZXdzID0gcXVlcnlTZWxlY3RvckFsbERlZXAoXCJvYmplY3QtbWF0Y2hpbmctdmlld1wiKTtcclxuICBjb25zdCBkcm9wZG93bk1hdGNoaW5nVmlld3MgPSBxdWVyeVNlbGVjdG9yQWxsRGVlcChcIm1hdGNoaW5nLXZpZXdcIik7XHJcbiAgaWYgKFxyXG4gICAgbWNxVmlld3MubGVuZ3RoID4gMCB8fFxyXG4gICAgbWF0Y2hpbmdWaWV3cy5sZW5ndGggPiAwIHx8XHJcbiAgICBkcm9wZG93bk1hdGNoaW5nVmlld3MubGVuZ3RoID4gMFxyXG4gICkge1xyXG4gICAgcmV0dXJuIHRydWU7XHJcbiAgfVxyXG5cclxuICAvLyBNb29kbGUgZGV0ZWN0aW9uIC0gbG9vayBmb3IgcXVpeiBxdWVzdGlvbiBjb250YWluZXJzXHJcbiAgY29uc3QgbW9vZGxlUXVlc3Rpb25zID0gZG9jdW1lbnQucXVlcnlTZWxlY3RvckFsbChcclxuICAgIFwiLnF1ZS5tdWx0aWNob2ljZSwgLnF1ZS50cnVlZmFsc2UsIC5xdWUuc2hvcnRhbnN3ZXIsIC5xdWUubnVtZXJpY2FsLCAucXVlLmVzc2F5LCAucXVlLm1hdGNoLCAucXVlLmdhcHNlbGVjdFwiLFxyXG4gICk7XHJcbiAgaWYgKG1vb2RsZVF1ZXN0aW9ucy5sZW5ndGggPiAwKSB7XHJcbiAgICByZXR1cm4gdHJ1ZTtcclxuICB9XHJcblxyXG4gIHJldHVybiBmYWxzZTtcclxufVxyXG5cclxuLyoqXHJcbiAqIERlbGF5ZWQgY2hlY2sgZm9yIHF1aXogY29udGVudCAtIGNvbnRlbnQgbWF5IGxvYWQgYWZ0ZXIgc2NyaXB0XHJcbiAqIEBwYXJhbSBjYWxsYmFjayAtIENhbGxiYWNrIGZ1bmN0aW9uIHdpdGggYm9vbGVhbiByZXN1bHRcclxuICogQHBhcmFtIG1heEF0dGVtcHRzIC0gTWF4aW11bSBudW1iZXIgb2YgY2hlY2sgYXR0ZW1wdHNcclxuICogQHBhcmFtIGludGVydmFsIC0gSW50ZXJ2YWwgYmV0d2VlbiBjaGVja3MgaW4gbWlsbGlzZWNvbmRzXHJcbiAqL1xyXG5leHBvcnQgZnVuY3Rpb24gd2FpdEZvclF1aXpDb250ZW50KFxyXG4gIGNhbGxiYWNrOiAoZm91bmQ6IGJvb2xlYW4pID0+IHZvaWQsXHJcbiAgbWF4QXR0ZW1wdHM6IG51bWJlciA9IDEwLFxyXG4gIGludGVydmFsOiBudW1iZXIgPSA1MDBcclxuKTogdm9pZCB7XHJcbiAgbGV0IGF0dGVtcHRzID0gMDtcclxuXHJcbiAgZnVuY3Rpb24gY2hlY2soKTogdm9pZCB7XHJcbiAgICBhdHRlbXB0cysrO1xyXG4gICAgaWYgKGZyYW1lSGFzUXVpekNvbnRlbnQoKSkge1xyXG4gICAgICBjYWxsYmFjayh0cnVlKTtcclxuICAgIH0gZWxzZSBpZiAoYXR0ZW1wdHMgPCBtYXhBdHRlbXB0cykge1xyXG4gICAgICBzZXRUaW1lb3V0KGNoZWNrLCBpbnRlcnZhbCk7XHJcbiAgICB9IGVsc2Uge1xyXG4gICAgICBjYWxsYmFjayhmYWxzZSk7XHJcbiAgICB9XHJcbiAgfVxyXG5cclxuICBjaGVjaygpO1xyXG59XHJcblxyXG4vLyA9PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PVxyXG4vLyBWaXNpYmxlIFF1ZXN0aW9uIERldGVjdGlvblxyXG4vLyA9PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PVxyXG5cclxuLyoqXHJcbiAqIERldGVjdCB2aXNpYmxlIG1hdGNoaW5nIHF1ZXN0aW9uIChvYmplY3QtbWF0Y2hpbmctdmlldylcclxuICogUmV0dXJucyBhIHF1ZXN0aW9uIG9iamVjdCBpZiBmb3VuZCwgbnVsbCBvdGhlcndpc2VcclxuICogQHJldHVybnMgTWF0Y2hpbmcgcXVlc3Rpb24gb2JqZWN0IG9yIG51bGxcclxuICovXHJcbmV4cG9ydCBmdW5jdGlvbiBkZXRlY3RWaXNpYmxlTWF0Y2hpbmdRdWVzdGlvbigpOiBEZXRlY3RlZFF1ZXN0aW9uIHwgbnVsbCB7XHJcbiAgY29uc3QgbWF0Y2hpbmdWaWV3cyA9IHF1ZXJ5U2VsZWN0b3JBbGxEZWVwKFwib2JqZWN0LW1hdGNoaW5nLXZpZXdcIik7XHJcblxyXG4gIGlmIChtYXRjaGluZ1ZpZXdzLmxlbmd0aCA9PT0gMCkgcmV0dXJuIG51bGw7XHJcblxyXG4gIC8vIEZpbmQgYWxsIHZpc2libGUgbWF0Y2hpbmcgdmlld3MgYW5kIHNjb3JlIGJ5IHByb3hpbWl0eSB0byBjZW50ZXIgb2Ygdmlld3BvcnRcclxuICBjb25zdCB2aXNpYmxlTWF0Y2hlczogVmlzaWJsZU1hdGNoUmVzdWx0W10gPSBbXTtcclxuICBjb25zdCB2aWV3cG9ydENlbnRlciA9IHdpbmRvdy5pbm5lckhlaWdodCAvIDI7XHJcbiAgZm9yIChjb25zdCBtYXRjaGluZ1ZpZXcgb2YgbWF0Y2hpbmdWaWV3cykge1xyXG4gICAgY29uc3QgcmVjdCA9IG1hdGNoaW5nVmlldy5nZXRCb3VuZGluZ0NsaWVudFJlY3QoKTtcclxuICAgIGNvbnN0IGhhc1NpemUgPSByZWN0LndpZHRoID4gMCAmJiByZWN0LmhlaWdodCA+IDA7XHJcbiAgICBpZiAoIWhhc1NpemUpIGNvbnRpbnVlO1xyXG4gICAgLy8gU2NvcmUgYnkgZGlzdGFuY2UgdG8gY2VudGVyXHJcbiAgICBjb25zdCBjZW50ZXJEaXN0ID0gTWF0aC5hYnMoKHJlY3QudG9wICsgcmVjdC5ib3R0b20pIC8gMiAtIHZpZXdwb3J0Q2VudGVyKTtcclxuICAgIHZpc2libGVNYXRjaGVzLnB1c2goeyBtYXRjaGluZ1ZpZXcsIHJlY3QsIGNlbnRlckRpc3QgfSk7XHJcbiAgfVxyXG4gIGlmICh2aXNpYmxlTWF0Y2hlcy5sZW5ndGggPT09IDApIHJldHVybiBudWxsO1xyXG4gIC8vIFBpY2sgdGhlIG9uZSBjbG9zZXN0IHRvIGNlbnRlclxyXG4gIHZpc2libGVNYXRjaGVzLnNvcnQoKGEsIGIpID0+IGEuY2VudGVyRGlzdCAtIGIuY2VudGVyRGlzdCk7XHJcbiAgY29uc3QgYmVzdE1hdGNoID0gdmlzaWJsZU1hdGNoZXNbMF0ubWF0Y2hpbmdWaWV3O1xyXG4gIGNvbnN0IGJlc3RSZWN0ID0gdmlzaWJsZU1hdGNoZXNbMF0ucmVjdDtcclxuICBjb25zdCBiZXN0Q2VudGVyID0gKGJlc3RSZWN0LnRvcCArIGJlc3RSZWN0LmJvdHRvbSkgLyAyO1xyXG4gIGlmIChNYXRoLmFicyhiZXN0Q2VudGVyIC0gdmlld3BvcnRDZW50ZXIpID4gMjAwKSByZXR1cm4gbnVsbDtcclxuICBjb25zdCBzaGFkb3dSb290ID0gYmVzdE1hdGNoLnNoYWRvd1Jvb3Q7XHJcbiAgaWYgKCFzaGFkb3dSb290KSByZXR1cm4gbnVsbDtcclxuXHJcbiAgLy8gRXh0cmFjdCBxdWVzdGlvbiB0ZXh0XHJcbiAgbGV0IHF1ZXN0aW9uVGV4dCA9IFwiXCI7XHJcbiAgY29uc3QgYm9keUVscyA9IHF1ZXJ5U2VsZWN0b3JBbGxEZWVwKFxyXG4gICAgXCIuY29tcG9uZW50X19ib2R5LWlubmVyLCAub2JqZWN0TWF0Y2hpbmdfX2JvZHktaW5uZXJcIixcclxuICAgIHNoYWRvd1Jvb3QsXHJcbiAgKTtcclxuICBpZiAoYm9keUVscy5sZW5ndGggPiAwKSB7XHJcbiAgICBxdWVzdGlvblRleHQgPSBib2R5RWxzWzBdLnRleHRDb250ZW50Py50cmltKCkgfHwgXCJcIjtcclxuICB9XHJcblxyXG4gIC8vIEV4dHJhY3QgY2F0ZWdvcmllcyAobGVmdCBzaWRlIC0gQSwgQiwgQy4uLilcclxuICBjb25zdCBjYXRlZ29yaWVzOiBNYXRjaGluZ0NhdGVnb3J5W10gPSBbXTtcclxuICBjb25zdCBjYXRlZ29yeUl0ZW1zID0gcXVlcnlTZWxlY3RvckFsbERlZXAoXHJcbiAgICBcIi5vYmplY3RNYXRjaGluZy1jYXRlZ29yeS1pdGVtXCIsXHJcbiAgICBzaGFkb3dSb290LFxyXG4gICk7XHJcbiAgY2F0ZWdvcnlJdGVtcy5mb3JFYWNoKChpdGVtLCBpbmRleCkgPT4ge1xyXG4gICAgY29uc3QgdGV4dEVsID0gaXRlbS5xdWVyeVNlbGVjdG9yKFwiLmNhdGVnb3J5LWl0ZW0tdGV4dFwiKTtcclxuICAgIGNvbnN0IGxldHRlckVsID0gaXRlbS5xdWVyeVNlbGVjdG9yKFwiLmNhdGVnb3J5LWl0ZW0tbnVtYmVyXCIpO1xyXG4gICAgaWYgKHRleHRFbCkge1xyXG4gICAgICBjb25zdCB0ZXh0ID0gdGV4dEVsLnRleHRDb250ZW50Py50cmltKCkgfHwgXCJcIjtcclxuICAgICAgY29uc3QgbGV0dGVyID0gbGV0dGVyRWxcclxuICAgICAgICA/IGxldHRlckVsLnRleHRDb250ZW50Py50cmltKCkgfHwgU3RyaW5nLmZyb21DaGFyQ29kZSg2NSArIGluZGV4KVxyXG4gICAgICAgIDogU3RyaW5nLmZyb21DaGFyQ29kZSg2NSArIGluZGV4KTtcclxuICAgICAgY2F0ZWdvcmllcy5wdXNoKHtcclxuICAgICAgICBsZXR0ZXI6IGxldHRlcixcclxuICAgICAgICB0ZXh0OiB0ZXh0LFxyXG4gICAgICB9KTtcclxuICAgIH1cclxuICB9KTtcclxuXHJcbiAgLy8gRXh0cmFjdCBvcHRpb25zIChyaWdodCBzaWRlIC0gdG8gYmUgbWF0Y2hlZClcclxuICBjb25zdCBtYXRjaGluZ09wdGlvbnM6IE1hdGNoaW5nT3B0aW9uW10gPSBbXTtcclxuICBjb25zdCBvcHRpb25JdGVtcyA9IHF1ZXJ5U2VsZWN0b3JBbGxEZWVwKFxyXG4gICAgXCIub2JqZWN0TWF0Y2hpbmctb3B0aW9uLWl0ZW1cIixcclxuICAgIHNoYWRvd1Jvb3QsXHJcbiAgKTtcclxuICBvcHRpb25JdGVtcy5mb3JFYWNoKChpdGVtLCBpbmRleCkgPT4ge1xyXG4gICAgY29uc3QgdGV4dEVsID0gaXRlbS5xdWVyeVNlbGVjdG9yKFwiLmNhdGVnb3J5LWl0ZW0tdGV4dFwiKTtcclxuICAgIGlmICh0ZXh0RWwpIHtcclxuICAgICAgY29uc3QgdGV4dCA9IHRleHRFbC50ZXh0Q29udGVudD8udHJpbSgpIHx8IFwiXCI7XHJcbiAgICAgIG1hdGNoaW5nT3B0aW9ucy5wdXNoKHtcclxuICAgICAgICBpbmRleDogaW5kZXggKyAxLFxyXG4gICAgICAgIHRleHQ6IHRleHQsXHJcbiAgICAgIH0pO1xyXG4gICAgfVxyXG4gIH0pO1xyXG5cclxuICBpZiAoY2F0ZWdvcmllcy5sZW5ndGggPj0gMiAmJiBtYXRjaGluZ09wdGlvbnMubGVuZ3RoID49IDIpIHtcclxuICAgIHJldHVybiB7XHJcbiAgICAgIGlkOiBcIm1hdGNoaW5nLXZpc2libGVcIixcclxuICAgICAgdHlwZTogXCJtYXRjaGluZ1wiLFxyXG4gICAgICB0ZXh0OiBxdWVzdGlvblRleHQsXHJcbiAgICAgIGNhdGVnb3JpZXM6IGNhdGVnb3JpZXMsXHJcbiAgICAgIG1hdGNoaW5nT3B0aW9uczogbWF0Y2hpbmdPcHRpb25zLFxyXG4gICAgICBlbGVtZW50OiBiZXN0TWF0Y2gsXHJcbiAgICAgIG9wdGlvbnM6IFtdLCAvLyBSZXF1aXJlZCBieSBpbnRlcmZhY2UgYnV0IG5vdCB1c2VkIGZvciBtYXRjaGluZ1xyXG4gICAgICBjb25maWRlbmNlOiA5NSxcclxuICAgIH07XHJcbiAgfVxyXG4gIHJldHVybiBudWxsO1xyXG59XHJcblxyXG4vKipcclxuICogRmluZCB0aGUgdmlzaWJsZSBxdWVzdGlvbiBudW1iZXIgb24gdGhlIHBhZ2VcclxuICogU2VhcmNoZXMgZm9yIFwiUHJlZ3VudGEgWFwiIHRleHQgYW5kIHJldHVybnMgdGhlIG1vc3QgcHJvbWluZW50IG9uZVxyXG4gKiBAcmV0dXJucyBUaGUgcXVlc3Rpb24gbnVtYmVyIG9yIG51bGwgaWYgbm90IGZvdW5kXHJcbiAqL1xyXG5leHBvcnQgZnVuY3Rpb24gZmluZFZpc2libGVRdWVzdGlvbk51bWJlcigpOiBudW1iZXIgfCBudWxsIHtcclxuICBjb25zdCBjYW5kaWRhdGVzOiBQcmVndW50YUNhbmRpZGF0ZVtdID0gW107XHJcblxyXG4gIC8vIFNlYXJjaCBmb3IgXCJQcmVndW50YSBYXCIgdGV4dCBpbiB0aGUgcGFnZSAoaW5jbHVkaW5nIHNoYWRvdyBET01zKVxyXG4gIGZ1bmN0aW9uIGNvbGxlY3RUZXh0Tm9kZXMocm9vdDogRWxlbWVudCB8IERvY3VtZW50IHwgU2hhZG93Um9vdCk6IHZvaWQge1xyXG4gICAgY29uc3Qgd2Fsa2VyID0gZG9jdW1lbnQuY3JlYXRlVHJlZVdhbGtlcihyb290IGFzIE5vZGUsIE5vZGVGaWx0ZXIuU0hPV19URVhUKTtcclxuICAgIGxldCBub2RlOiBUZXh0IHwgbnVsbDtcclxuICAgIHdoaWxlICgobm9kZSA9IHdhbGtlci5uZXh0Tm9kZSgpIGFzIFRleHQgfCBudWxsKSkge1xyXG4gICAgICBpZiAobm9kZS50ZXh0Q29udGVudCAmJiAvcHJlZ3VudGFcXHMqXFxkKy9pLnRlc3Qobm9kZS50ZXh0Q29udGVudCkpIHtcclxuICAgICAgICBjb25zdCBtYXRjaCA9IG5vZGUudGV4dENvbnRlbnQubWF0Y2goL3ByZWd1bnRhXFxzKihcXGQrKS9pKTtcclxuICAgICAgICBpZiAobWF0Y2gpIHtcclxuICAgICAgICAgIGNvbnN0IG51bSA9IHBhcnNlSW50KG1hdGNoWzFdKTtcclxuICAgICAgICAgIGNvbnN0IHBhcmVudCA9IG5vZGUucGFyZW50RWxlbWVudDtcclxuICAgICAgICAgIGlmIChwYXJlbnQpIHtcclxuICAgICAgICAgICAgY29uc3QgcmVjdCA9IHBhcmVudC5nZXRCb3VuZGluZ0NsaWVudFJlY3QoKTtcclxuICAgICAgICAgICAgLy8gQ2hlY2sgaWYgZWxlbWVudCBpcyBpbiB2aWV3cG9ydFxyXG4gICAgICAgICAgICBpZiAoXHJcbiAgICAgICAgICAgICAgcmVjdC50b3AgPj0gLTEwMCAmJlxyXG4gICAgICAgICAgICAgIHJlY3QudG9wIDw9IHdpbmRvdy5pbm5lckhlaWdodCAmJlxyXG4gICAgICAgICAgICAgIHJlY3Qud2lkdGggPiAwICYmXHJcbiAgICAgICAgICAgICAgcmVjdC5oZWlnaHQgPiAwXHJcbiAgICAgICAgICAgICkge1xyXG4gICAgICAgICAgICAgIC8vIENhbGN1bGF0ZSBhIFwicHJvbWluZW5jZVwiIHNjb3JlIC0gbGFyZ2VyIGVsZW1lbnRzIGFyZSBtb3JlIGxpa2VseSB0aGUgbWFpbiBpbmRpY2F0b3JcclxuICAgICAgICAgICAgICBjb25zdCBmb250U2l6ZSA9XHJcbiAgICAgICAgICAgICAgICBwYXJzZUZsb2F0KHdpbmRvdy5nZXRDb21wdXRlZFN0eWxlKHBhcmVudCkuZm9udFNpemUpIHx8IDEyO1xyXG4gICAgICAgICAgICAgIGNvbnN0IGFyZWEgPSByZWN0LndpZHRoICogcmVjdC5oZWlnaHQ7XHJcbiAgICAgICAgICAgICAgLy8gUHJlZmVyIGVsZW1lbnRzIGNsb3NlciB0byBjZW50ZXItdG9wIG9mIHNjcmVlbiAobWFpbiBjb250ZW50IGFyZWEpXHJcbiAgICAgICAgICAgICAgY29uc3QgY2VudGVyRGlzdGFuY2UgPSBNYXRoLmFicyhcclxuICAgICAgICAgICAgICAgIHJlY3QubGVmdCArIHJlY3Qud2lkdGggLyAyIC0gd2luZG93LmlubmVyV2lkdGggLyAyLFxyXG4gICAgICAgICAgICAgICk7XHJcbiAgICAgICAgICAgICAgY29uc3Qgc2NvcmUgPSBmb250U2l6ZSAqIDEwICsgYXJlYSAvIDEwMCAtIGNlbnRlckRpc3RhbmNlIC8gMTA7XHJcblxyXG4gICAgICAgICAgICAgIGNhbmRpZGF0ZXMucHVzaCh7XHJcbiAgICAgICAgICAgICAgICBudW06IG51bSxcclxuICAgICAgICAgICAgICAgIHRvcDogcmVjdC50b3AsXHJcbiAgICAgICAgICAgICAgICBmb250U2l6ZTogZm9udFNpemUsXHJcbiAgICAgICAgICAgICAgICBhcmVhOiBhcmVhLFxyXG4gICAgICAgICAgICAgICAgc2NvcmU6IHNjb3JlLFxyXG4gICAgICAgICAgICAgICAgdGV4dDogbm9kZS50ZXh0Q29udGVudC50cmltKCksXHJcbiAgICAgICAgICAgICAgfSk7XHJcbiAgICAgICAgICAgIH1cclxuICAgICAgICAgIH1cclxuICAgICAgICB9XHJcbiAgICAgIH1cclxuICAgIH1cclxuICAgIC8vIEFsc28gY2hlY2sgc2hhZG93IHJvb3RzXHJcbiAgICBjb25zdCBlbGVtZW50cyA9IHJvb3QucXVlcnlTZWxlY3RvckFsbChcIipcIik7XHJcbiAgICBlbGVtZW50cy5mb3JFYWNoKChlbCkgPT4ge1xyXG4gICAgICBpZiAoZWwuc2hhZG93Um9vdCkge1xyXG4gICAgICAgIGNvbGxlY3RUZXh0Tm9kZXMoZWwuc2hhZG93Um9vdCk7XHJcbiAgICAgIH1cclxuICAgIH0pO1xyXG4gIH1cclxuXHJcbiAgY29sbGVjdFRleHROb2Rlcyhkb2N1bWVudCk7XHJcblxyXG4gIGlmIChjYW5kaWRhdGVzLmxlbmd0aCA9PT0gMCkge1xyXG4gICAgcmV0dXJuIG51bGw7XHJcbiAgfVxyXG5cclxuICAvLyBTb3J0IGJ5IHNjb3JlIChoaWdoZXN0IGZpcnN0KSAtIHRoaXMgcHJlZmVycyBsYXJnZXIsIGNlbnRlcmVkIGVsZW1lbnRzXHJcbiAgY2FuZGlkYXRlcy5zb3J0KChhLCBiKSA9PiBiLnNjb3JlIC0gYS5zY29yZSk7XHJcblxyXG4gIC8vIFJldHVybiB0aGUgcXVlc3Rpb24gbnVtYmVyIHdpdGggaGlnaGVzdCBzY29yZVxyXG4gIHJldHVybiBjYW5kaWRhdGVzWzBdLm51bTtcclxufVxyXG5cclxuLyoqXHJcbiAqIFJlLWRldGVjdCBhbmQgcmVmcmVzaCB0aGUgY3VycmVudCBxdWVzdGlvblxyXG4gKiBAcGFyYW0gZGlzcGxheUNhbGxiYWNrIC0gT3B0aW9uYWwgY2FsbGJhY2sgdG8gZGlzcGxheSB0aGUgcXVlc3Rpb24gKGZvciBVSSBpbnRlZ3JhdGlvbilcclxuICogQHJldHVybnMgVGhlIGRldGVjdGVkIHF1ZXN0aW9uIG9yIG51bGxcclxuICovXHJcbmV4cG9ydCBhc3luYyBmdW5jdGlvbiByZWZyZXNoQ3VycmVudFF1ZXN0aW9uKFxyXG4gIGRpc3BsYXlDYWxsYmFjazogKChxdWVzdGlvbjogRGV0ZWN0ZWRRdWVzdGlvbikgPT4gdm9pZCkgfCBudWxsID0gbnVsbFxyXG4pOiBQcm9taXNlPERldGVjdGVkUXVlc3Rpb24gfCBudWxsPiB7XHJcbiAgLy8gUmUtZGV0ZWN0IHRoZSB2aXNpYmxlIHF1ZXN0aW9uIGZyb20gc2NyYXRjaCAoYXN5bmMgZm9yIGltYWdlIGV4dHJhY3Rpb24pXHJcbiAgY29uc3QgcXVlc3Rpb24gPSBhd2FpdCBkZXRlY3RWaXNpYmxlUXVlc3Rpb24oKTtcclxuICBpZiAocXVlc3Rpb24gJiYgZGlzcGxheUNhbGxiYWNrKSB7XHJcbiAgICBkaXNwbGF5Q2FsbGJhY2socXVlc3Rpb24pO1xyXG4gIH1cclxuICByZXR1cm4gcXVlc3Rpb247XHJcbn1cclxuXHJcbi8qKlxyXG4gKiBEZXRlY3Qgb25seSB0aGUgY3VycmVudGx5IHZpc2libGUgcXVlc3Rpb24gb24gc2NyZWVuXHJcbiAqIFVzZXMgYSBxdWVzdGlvbiBtYXAgYXBwcm9hY2ggdG8gaGFuZGxlIG1peGVkIG1jcS9tYXRjaGluZyBxdWVzdGlvbnNcclxuICogQHJldHVybnMgVGhlIGRldGVjdGVkIHF1ZXN0aW9uIG9yIG51bGxcclxuICovXHJcbmV4cG9ydCBhc3luYyBmdW5jdGlvbiBkZXRlY3RWaXNpYmxlUXVlc3Rpb24oKTogUHJvbWlzZTxEZXRlY3RlZFF1ZXN0aW9uIHwgbnVsbD4ge1xyXG4gIC8vIEZpcnN0LCB0cnkgdG8gZGV0ZWN0IE1vb2RsZSBxdWVzdGlvbnMgKHRoZXkgaGF2ZSBhIHNpbXBsZXIgc3RydWN0dXJlKVxyXG4gIGNvbnN0IG1vb2RsZVF1ZXN0aW9uID0gYXdhaXQgZGV0ZWN0TW9vZGxlUXVlc3Rpb24oKTtcclxuICBpZiAobW9vZGxlUXVlc3Rpb24pIHtcclxuICAgIHJldHVybiBtb29kbGVRdWVzdGlvbjtcclxuICB9XHJcblxyXG4gIC8vIFRoZW4gdHJ5IE5ldEFjYWQgZGV0ZWN0aW9uICh1c2VzIFNoYWRvdyBET00gYW5kIHF1ZXN0aW9uIG1hcHMpXHJcbiAgLy8gRmluZCB2aXNpYmxlIHF1ZXN0aW9uIG51bWJlciBmaXJzdFxyXG4gIGNvbnN0IHZpc2libGVRdWVzdGlvbk51bSA9IGZpbmRWaXNpYmxlUXVlc3Rpb25OdW1iZXIoKTtcclxuXHJcbiAgLy8gQnVpbGQgYSBtYXAgb2YgYWxsIHF1ZXN0aW9ucyAoYm90aCBtY3EgYW5kIG1hdGNoaW5nKSB3aXRoIHRoZWlyIHByb3hpbWl0eSBzY29yZXNcclxuICBjb25zdCBxdWVzdGlvbk1hcCA9IGJ1aWxkUXVlc3Rpb25NYXAoKTtcclxuXHJcbiAgLy8gRGVidWcgbG9nZ2luZ1xyXG4gIGxvZyhcIltTdHVkeSBBc3Npc3RdIGRldGVjdFZpc2libGVRdWVzdGlvbjpcIiwge1xyXG4gICAgdmlzaWJsZVF1ZXN0aW9uTnVtLFxyXG4gICAgcXVlc3Rpb25NYXBLZXlzOiBPYmplY3Qua2V5cyhxdWVzdGlvbk1hcCksXHJcbiAgICBxdWVzdGlvbk1hcERldGFpbHM6IE9iamVjdC5lbnRyaWVzKHF1ZXN0aW9uTWFwKS5tYXAoKFtrLCB2XSkgPT4gKHtcclxuICAgICAgbnVtOiBrLFxyXG4gICAgICB0eXBlOiB2LnF1ZXN0aW9uPy50eXBlLFxyXG4gICAgICBzY29yZTogdi5zY29yZSxcclxuICAgICAgdGV4dDogdi5xdWVzdGlvbj8udGV4dD8uc3Vic3RyaW5nKDAsIDUwKSxcclxuICAgIH0pKSxcclxuICB9KTtcclxuXHJcbiAgLy8gSWYgd2UgaGF2ZSBhIHZpc2libGUgcXVlc3Rpb24gbnVtYmVyLCB0cnkgdG8gZmluZCBpdCBpbiB0aGUgbWFwXHJcbiAgaWYgKHZpc2libGVRdWVzdGlvbk51bSAhPT0gbnVsbCAmJiBxdWVzdGlvbk1hcFt2aXNpYmxlUXVlc3Rpb25OdW1dKSB7XHJcbiAgICBjb25zdCBlbnRyeSA9IHF1ZXN0aW9uTWFwW3Zpc2libGVRdWVzdGlvbk51bV07XHJcbiAgICByZXR1cm4gZW50cnkucXVlc3Rpb247XHJcbiAgfVxyXG5cclxuICAvLyBGYWxsYmFjazogc2VsZWN0IHRoZSBxdWVzdGlvbiB3aXRoIHRoZSBoaWdoZXN0IHZpc2liaWxpdHkgc2NvcmVcclxuICBsZXQgYmVzdEVudHJ5OiBRdWVzdGlvbk1hcEVudHJ5IHwgbnVsbCA9IG51bGw7XHJcbiAgbGV0IGJlc3RTY29yZSA9IC1JbmZpbml0eTtcclxuXHJcbiAgZm9yIChjb25zdCBudW0gaW4gcXVlc3Rpb25NYXApIHtcclxuICAgIGNvbnN0IGVudHJ5ID0gcXVlc3Rpb25NYXBbbnVtXTtcclxuICAgIGlmIChlbnRyeS5zY29yZSA+IGJlc3RTY29yZSkge1xyXG4gICAgICBiZXN0U2NvcmUgPSBlbnRyeS5zY29yZTtcclxuICAgICAgYmVzdEVudHJ5ID0gZW50cnk7XHJcbiAgICB9XHJcbiAgfVxyXG5cclxuICBpZiAoYmVzdEVudHJ5KSB7XHJcbiAgICByZXR1cm4gYmVzdEVudHJ5LnF1ZXN0aW9uO1xyXG4gIH1cclxuXHJcbiAgcmV0dXJuIG51bGw7XHJcbn1cclxuXHJcbi8qKlxyXG4gKiBEZXRlY3QgTW9vZGxlIHF1aXogcXVlc3Rpb25zIChmb3IgdmlzaWJsZSBxdWVzdGlvbiBkZXRlY3Rpb24pXHJcbiAqIE1vb2RsZSB1c2VzIHN0YW5kYXJkIEhUTUwgd2l0aCBjbGFzc2VzIGxpa2UgLnF1ZS5tdWx0aWNob2ljZVxyXG4gKiBAcmV0dXJucyBUaGUgZGV0ZWN0ZWQgcXVlc3Rpb24gb3IgbnVsbFxyXG4gKi9cclxuZXhwb3J0IGFzeW5jIGZ1bmN0aW9uIGRldGVjdE1vb2RsZVF1ZXN0aW9uKCk6IFByb21pc2U8RGV0ZWN0ZWRRdWVzdGlvbiB8IG51bGw+IHtcclxuICAvLyBMb29rIGZvciBNb29kbGUgcXVlc3Rpb24gY29udGFpbmVycyAoYWxsIHN1cHBvcnRlZCB0eXBlcylcclxuICBjb25zdCBtb29kbGVRdWVzdGlvbnMgPSBkb2N1bWVudC5xdWVyeVNlbGVjdG9yQWxsKFxyXG4gICAgXCIucXVlLm11bHRpY2hvaWNlLCAucXVlLnRydWVmYWxzZSwgLnF1ZS5tYXRjaCwgLnF1ZS5zaG9ydGFuc3dlciwgLnF1ZS5udW1lcmljYWwsIC5xdWUuZ2Fwc2VsZWN0XCIsXHJcbiAgKTtcclxuXHJcbiAgaWYgKG1vb2RsZVF1ZXN0aW9ucy5sZW5ndGggPT09IDApIHtcclxuICAgIHJldHVybiBudWxsO1xyXG4gIH1cclxuXHJcbiAgLy8gRmluZCB0aGUgbW9zdCB2aXNpYmxlIHF1ZXN0aW9uIChjbG9zZXN0IHRvIHZpZXdwb3J0IGNlbnRlcilcclxuICBjb25zdCB2aWV3cG9ydENlbnRlclkgPSB3aW5kb3cuaW5uZXJIZWlnaHQgLyAyO1xyXG4gIGxldCBiZXN0UXVlc3Rpb246IEVsZW1lbnQgfCBudWxsID0gbnVsbDtcclxuICBsZXQgYmVzdFNjb3JlID0gLUluZmluaXR5O1xyXG5cclxuICBmb3IgKGNvbnN0IHF1ZXN0aW9uRWwgb2YgbW9vZGxlUXVlc3Rpb25zKSB7XHJcbiAgICBjb25zdCByZWN0ID0gcXVlc3Rpb25FbC5nZXRCb3VuZGluZ0NsaWVudFJlY3QoKTtcclxuICAgIGlmIChyZWN0LndpZHRoID09PSAwIHx8IHJlY3QuaGVpZ2h0ID09PSAwKSBjb250aW51ZTtcclxuXHJcbiAgICBjb25zdCBpc0luVmlld3BvcnQgPSByZWN0LnRvcCA8IHdpbmRvdy5pbm5lckhlaWdodCAmJiByZWN0LmJvdHRvbSA+IDA7XHJcbiAgICBpZiAoIWlzSW5WaWV3cG9ydCkgY29udGludWU7XHJcblxyXG4gICAgY29uc3QgY2VudGVyRGlzdCA9IE1hdGguYWJzKChyZWN0LnRvcCArIHJlY3QuYm90dG9tKSAvIDIgLSB2aWV3cG9ydENlbnRlclkpO1xyXG4gICAgY29uc3Qgc2NvcmUgPSAxMDAwMCAtIGNlbnRlckRpc3Q7XHJcblxyXG4gICAgaWYgKHNjb3JlID4gYmVzdFNjb3JlKSB7XHJcbiAgICAgIGJlc3RTY29yZSA9IHNjb3JlO1xyXG4gICAgICBiZXN0UXVlc3Rpb24gPSBxdWVzdGlvbkVsO1xyXG4gICAgfVxyXG4gIH1cclxuXHJcbiAgaWYgKCFiZXN0UXVlc3Rpb24pIHtcclxuICAgIC8vIEZhbGxiYWNrIGZvciB6ZXJvLWRpbWVuc2lvbiBjb250ZXh0cyAoaWZyYW1lcywganNkb20pXHJcbiAgICBiZXN0UXVlc3Rpb24gPSBtb29kbGVRdWVzdGlvbnNbMF0gPz8gbnVsbDtcclxuICB9XHJcblxyXG4gIGlmICghYmVzdFF1ZXN0aW9uKSB7XHJcbiAgICByZXR1cm4gbnVsbDtcclxuICB9XHJcblxyXG4gIC8vIFJvdXRlIHRvIGNvcnJlY3QgZXh0cmFjdG9yIGJhc2VkIG9uIHF1ZXN0aW9uIHR5cGVcclxuICBpZiAoYmVzdFF1ZXN0aW9uLmNsYXNzTGlzdC5jb250YWlucyhcIm1hdGNoXCIpKSB7XHJcbiAgICByZXR1cm4gYXdhaXQgZXh0cmFjdE1vb2RsZU1hdGNoUXVlc3Rpb24oYmVzdFF1ZXN0aW9uKTtcclxuICB9XHJcbiAgaWYgKGJlc3RRdWVzdGlvbi5jbGFzc0xpc3QuY29udGFpbnMoXCJzaG9ydGFuc3dlclwiKSkge1xyXG4gICAgcmV0dXJuIGF3YWl0IGV4dHJhY3RNb29kbGVTaG9ydEFuc3dlclF1ZXN0aW9uKGJlc3RRdWVzdGlvbiwgXCJzaG9ydC1hbnN3ZXJcIik7XHJcbiAgfVxyXG4gIGlmIChiZXN0UXVlc3Rpb24uY2xhc3NMaXN0LmNvbnRhaW5zKFwibnVtZXJpY2FsXCIpKSB7XHJcbiAgICByZXR1cm4gYXdhaXQgZXh0cmFjdE1vb2RsZVNob3J0QW5zd2VyUXVlc3Rpb24oYmVzdFF1ZXN0aW9uLCBcIm51bWVyaWNhbFwiKTtcclxuICB9XHJcbiAgaWYgKGJlc3RRdWVzdGlvbi5jbGFzc0xpc3QuY29udGFpbnMoXCJnYXBzZWxlY3RcIikpIHtcclxuICAgIHJldHVybiBhd2FpdCBleHRyYWN0TW9vZGxlU2VsZWN0TWlzc2luZ1dvcmRzKGJlc3RRdWVzdGlvbik7XHJcbiAgfVxyXG4gIHJldHVybiBhd2FpdCBleHRyYWN0TW9vZGxlUXVlc3Rpb25EYXRhKGJlc3RRdWVzdGlvbik7XHJcbn1cclxuXHJcbi8qKlxyXG4gKiBFeHRyYWN0IGNvdXJzZSBuYW1lIGZyb20gTW9vZGxlIHBhZ2UgdGl0bGVcclxuICogTW9vZGxlIGZvcm1hdDogXCJRdWl6IFRpdGxlOiBDb3Vyc2UgTmFtZVwiIG9yIGp1c3QgXCJDb3Vyc2UgTmFtZVwiXHJcbiAqIEByZXR1cm5zIENvdXJzZSBuYW1lIG9yIHVuZGVmaW5lZFxyXG4gKi9cclxuZnVuY3Rpb24gZXh0cmFjdE1vb2RsZUNvdXJzZU5hbWUoKTogc3RyaW5nIHwgdW5kZWZpbmVkIHtcclxuICBjb25zdCB0aXRsZSA9IGRvY3VtZW50LnRpdGxlLnRyaW0oKTtcclxuICBcclxuICAvLyBNb29kbGUgdHlwaWNhbGx5IHVzZXMgZm9ybWF0IFwiQWN0aXZpdHk6IENvdXJzZSBOYW1lXCJcclxuICAvLyBFeGFtcGxlOiBcIkN1ZXN0aW9uYXJpbyAzLiBVQlVOVFU6IFNpc3RlbWFzIE9wZXJhdGl2b3NcIlxyXG4gIGNvbnN0IGNvbG9uSW5kZXggPSB0aXRsZS5sYXN0SW5kZXhPZignOicpO1xyXG4gIFxyXG4gIGlmIChjb2xvbkluZGV4ICE9PSAtMSAmJiBjb2xvbkluZGV4IDwgdGl0bGUubGVuZ3RoIC0gMSkge1xyXG4gICAgY29uc3QgY291cnNlTmFtZSA9IHRpdGxlLnN1YnN0cmluZyhjb2xvbkluZGV4ICsgMSkudHJpbSgpO1xyXG4gICAgLy8gT25seSByZXR1cm4gaWYgaXQncyBub3QgZW1wdHkgYW5kIG5vdCB0b28gc2hvcnRcclxuICAgIGlmIChjb3Vyc2VOYW1lLmxlbmd0aCA+IDMpIHtcclxuICAgICAgcmV0dXJuIGNvdXJzZU5hbWU7XHJcbiAgICB9XHJcbiAgfVxyXG4gIFxyXG4gIHJldHVybiB1bmRlZmluZWQ7XHJcbn1cclxuXHJcbi8qKlxyXG4gKiBFeHRyYWN0IHF1ZXN0aW9uIGRhdGEgZnJvbSBhIE1vb2RsZSBxdWVzdGlvbiBlbGVtZW50XHJcbiAqIE5vdyBhc3luYyB0byBoYW5kbGUgaW1hZ2UgZXh0cmFjdGlvblxyXG4gKiBAcGFyYW0gcXVlc3Rpb25FbCAtIFRoZSBNb29kbGUgcXVlc3Rpb24gZWxlbWVudFxyXG4gKiBAcmV0dXJucyBRdWVzdGlvbiBkYXRhIG9yIG51bGxcclxuICovXHJcbmV4cG9ydCBhc3luYyBmdW5jdGlvbiBleHRyYWN0TW9vZGxlUXVlc3Rpb25EYXRhKHF1ZXN0aW9uRWw6IEVsZW1lbnQpOiBQcm9taXNlPERldGVjdGVkUXVlc3Rpb24gfCBudWxsPiB7XHJcbiAgLy8gRXh0cmFjdCBjb3Vyc2UgbmFtZSBmcm9tIHBhZ2UgdGl0bGVcclxuICBjb25zdCBjb3Vyc2VOYW1lID0gZXh0cmFjdE1vb2RsZUNvdXJzZU5hbWUoKTtcclxuICBjb25zdCBpc1RydWVGYWxzZSA9IHF1ZXN0aW9uRWwuY2xhc3NMaXN0LmNvbnRhaW5zKFwidHJ1ZWZhbHNlXCIpO1xyXG4gIFxyXG4gIC8vIEdldCBxdWVzdGlvbiBudW1iZXIgZnJvbSBzcGFuLnFub1xyXG4gIGNvbnN0IHFub0VsID0gcXVlc3Rpb25FbC5xdWVyeVNlbGVjdG9yKFwiLnFub1wiKTtcclxuICBjb25zdCBxdWVzdGlvbk51bWJlciA9IHFub0VsID8gcGFyc2VJbnQocW5vRWwudGV4dENvbnRlbnQ/LnRyaW0oKSB8fCBcIjFcIikgOiAxO1xyXG5cclxuICAvLyBHZXQgcXVlc3Rpb24gdGV4dCBmcm9tIGRpdi5xdGV4dFxyXG4gIGNvbnN0IHF0ZXh0RWwgPSBxdWVzdGlvbkVsLnF1ZXJ5U2VsZWN0b3IoXCIucXRleHRcIik7XHJcbiAgbGV0IHF1ZXN0aW9uVGV4dCA9IFwiXCI7XHJcbiAgY29uc3QgcXVlc3Rpb25JbWFnZXM6IEltYWdlRGF0YVtdID0gW107XHJcblxyXG4gIGlmIChxdGV4dEVsKSB7XHJcbiAgICAvLyBHZXQgYWxsIHRleHQsIGV4Y2x1ZGluZyBoaWRkZW4gZWxlbWVudHNcclxuICAgIHF1ZXN0aW9uVGV4dCA9IHF0ZXh0RWwudGV4dENvbnRlbnQ/LnRyaW0oKSB8fCBcIlwiO1xyXG5cclxuICAgIC8vIEV4dHJhY3QgaW1hZ2VzIGZyb20gcXVlc3Rpb24gdGV4dCAoZXhjbHVkZSBmbGFnIGltYWdlcylcclxuICAgIGNvbnN0IGltZ3MgPSBxdGV4dEVsLnF1ZXJ5U2VsZWN0b3JBbGwoXCJpbWc6bm90KC5xdWVzdGlvbmZsYWdpbWFnZSlcIikgYXMgTm9kZUxpc3RPZjxIVE1MSW1hZ2VFbGVtZW50PjtcclxuICAgIGZvciAoY29uc3QgaW1nIG9mIGltZ3MpIHtcclxuICAgICAgLy8gU2tpcCB0aW55IGltYWdlcyAobGlrZWx5IGljb25zKVxyXG4gICAgICBpZiAoaW1nLndpZHRoIDwgNTAgfHwgaW1nLmhlaWdodCA8IDUwKSBjb250aW51ZTtcclxuXHJcbiAgICAgIC8vIFByZWZlciBwdWJsaWMgVVJMIChzYXZlcyB0b2tlbnMpIG92ZXIgYmFzZTY0XHJcbiAgICAgIGlmIChpc1B1YmxpY0ltYWdlVXJsKGltZy5zcmMpKSB7XHJcbiAgICAgICAgcXVlc3Rpb25JbWFnZXMucHVzaCh7XHJcbiAgICAgICAgICB1cmw6IGltZy5zcmMsXHJcbiAgICAgICAgICBtZWRpYVR5cGU6IFwiaW1hZ2UvanBlZ1wiLFxyXG4gICAgICAgICAgYWx0OiBpbWcuYWx0IHx8IFwiUXVlc3Rpb24gaW1hZ2VcIixcclxuICAgICAgICAgIGxvY2F0aW9uOiBcInF1ZXN0aW9uXCIsXHJcbiAgICAgICAgfSk7XHJcbiAgICAgIH0gZWxzZSB7XHJcbiAgICAgICAgY29uc3QgYmFzZTY0RGF0YSA9IGF3YWl0IGltYWdlVG9CYXNlNjQoaW1nKTtcclxuICAgICAgICBpZiAoYmFzZTY0RGF0YSkge1xyXG4gICAgICAgICAgcXVlc3Rpb25JbWFnZXMucHVzaCh7XHJcbiAgICAgICAgICAgIGJhc2U2NDogYmFzZTY0RGF0YS5iYXNlNjQsXHJcbiAgICAgICAgICAgIG1lZGlhVHlwZTogYmFzZTY0RGF0YS5tZWRpYVR5cGUsXHJcbiAgICAgICAgICAgIGFsdDogaW1nLmFsdCB8fCBcIlF1ZXN0aW9uIGltYWdlXCIsXHJcbiAgICAgICAgICAgIGxvY2F0aW9uOiBcInF1ZXN0aW9uXCIsXHJcbiAgICAgICAgICB9KTtcclxuICAgICAgICB9XHJcbiAgICAgIH1cclxuICAgIH1cclxuICB9XHJcblxyXG4gIC8vIEdldCBhbnN3ZXIgb3B0aW9ucyBmcm9tIGRpdi5hbnN3ZXJcclxuICBjb25zdCBhbnN3ZXJDb250YWluZXIgPSBxdWVzdGlvbkVsLnF1ZXJ5U2VsZWN0b3IoXCIuYW5zd2VyXCIpO1xyXG4gIGNvbnN0IG9wdGlvbnM6IFF1ZXN0aW9uT3B0aW9uW10gPSBbXTtcclxuXHJcbiAgaWYgKGFuc3dlckNvbnRhaW5lcikge1xyXG4gICAgLy8gRWFjaCBvcHRpb24gaXMgaW4gYSBkaXYgd2l0aCBjbGFzcyByMCBvciByMSAoYWx0ZXJuYXRpbmcpXHJcbiAgICBjb25zdCBvcHRpb25EaXZzID0gYW5zd2VyQ29udGFpbmVyLnF1ZXJ5U2VsZWN0b3JBbGwoXHJcbiAgICAgIFwiOnNjb3BlID4gZGl2LnIwLCA6c2NvcGUgPiBkaXYucjFcIixcclxuICAgICk7XHJcblxyXG4gICAgZm9yIChjb25zdCBvcHREaXYgb2Ygb3B0aW9uRGl2cykge1xyXG4gICAgICAvLyBHZXQgdGhlIGxldHRlciBmcm9tIHNwYW4uYW5zd2VybnVtYmVyIChlLmcuLCBcImEuIFwiLCBcImIuIFwiKVxyXG4gICAgICBjb25zdCBsZXR0ZXJFbCA9IG9wdERpdi5xdWVyeVNlbGVjdG9yKFwiLmFuc3dlcm51bWJlclwiKTtcclxuICAgICAgbGV0IGxldHRlciA9IFwiXCI7XHJcbiAgICAgIGlmIChsZXR0ZXJFbCkge1xyXG4gICAgICAgIGxldHRlciA9IChsZXR0ZXJFbC50ZXh0Q29udGVudD8udHJpbSgpIHx8IFwiXCIpLnJlcGxhY2UoXCIuXCIsIFwiXCIpLnRvVXBwZXJDYXNlKCk7XHJcbiAgICAgIH1cclxuXHJcbiAgICAgIC8vIEdldCB0aGUgb3B0aW9uIHRleHQgLSBpdCdzIGluIHRoZSBmbGV4LWZpbGwgZGl2IGFmdGVyIGFuc3dlcm51bWJlclxyXG4gICAgICBjb25zdCB0ZXh0Q29udGFpbmVyID0gb3B0RGl2LnF1ZXJ5U2VsZWN0b3IoXHJcbiAgICAgICAgXCIuZmxleC1maWxsLCBbZGF0YS1yZWdpb249J2Fuc3dlci1sYWJlbCddID4gZGl2Om5vdCguYW5zd2VybnVtYmVyKVwiLFxyXG4gICAgICApO1xyXG4gICAgICBsZXQgb3B0aW9uVGV4dCA9IFwiXCI7XHJcbiAgICAgIGxldCBvcHRpb25JbWFnZTogSW1hZ2VEYXRhIHwgbnVsbCA9IG51bGw7XHJcblxyXG4gICAgICBpZiAodGV4dENvbnRhaW5lcikge1xyXG4gICAgICAgIG9wdGlvblRleHQgPSB0ZXh0Q29udGFpbmVyLnRleHRDb250ZW50Py50cmltKCkgfHwgXCJcIjtcclxuXHJcbiAgICAgICAgLy8gQ2hlY2sgZm9yIGltYWdlIGluIHRoaXMgb3B0aW9uIChzb21lIGFuc3dlcnMgYXJlIGltYWdlcylcclxuICAgICAgICBjb25zdCBvcHRJbWcgPSB0ZXh0Q29udGFpbmVyLnF1ZXJ5U2VsZWN0b3IoXHJcbiAgICAgICAgICBcImltZzpub3QoLnF1ZXN0aW9uZmxhZ2ltYWdlKVwiLFxyXG4gICAgICAgICkgYXMgSFRNTEltYWdlRWxlbWVudCB8IG51bGw7XHJcbiAgICAgICAgaWYgKG9wdEltZyAmJiBvcHRJbWcud2lkdGggPj0gNTAgJiYgb3B0SW1nLmhlaWdodCA+PSA1MCkge1xyXG4gICAgICAgICAgLy8gUHJlZmVyIHB1YmxpYyBVUkwgb3ZlciBiYXNlNjRcclxuICAgICAgICAgIGlmIChpc1B1YmxpY0ltYWdlVXJsKG9wdEltZy5zcmMpKSB7XHJcbiAgICAgICAgICAgIG9wdGlvbkltYWdlID0ge1xyXG4gICAgICAgICAgICAgIHVybDogb3B0SW1nLnNyYyxcclxuICAgICAgICAgICAgICBtZWRpYVR5cGU6IFwiaW1hZ2UvanBlZ1wiLFxyXG4gICAgICAgICAgICAgIGFsdDogb3B0SW1nLmFsdCB8fCBgT3B0aW9uICR7bGV0dGVyfSBpbWFnZWAsXHJcbiAgICAgICAgICAgIH07XHJcbiAgICAgICAgICB9IGVsc2Uge1xyXG4gICAgICAgICAgICBjb25zdCBiYXNlNjREYXRhID0gYXdhaXQgaW1hZ2VUb0Jhc2U2NChvcHRJbWcpO1xyXG4gICAgICAgICAgICBpZiAoYmFzZTY0RGF0YSkge1xyXG4gICAgICAgICAgICAgIG9wdGlvbkltYWdlID0ge1xyXG4gICAgICAgICAgICAgICAgYmFzZTY0OiBiYXNlNjREYXRhLmJhc2U2NCxcclxuICAgICAgICAgICAgICAgIG1lZGlhVHlwZTogYmFzZTY0RGF0YS5tZWRpYVR5cGUsXHJcbiAgICAgICAgICAgICAgICBhbHQ6IG9wdEltZy5hbHQgfHwgYE9wdGlvbiAke2xldHRlcn0gaW1hZ2VgLFxyXG4gICAgICAgICAgICAgIH07XHJcbiAgICAgICAgICAgIH1cclxuICAgICAgICAgIH1cclxuICAgICAgICB9XHJcbiAgICAgIH0gZWxzZSB7XHJcbiAgICAgICAgLy8gRmFsbGJhY2s6IGdldCB0ZXh0IGZyb20gdGhlIGxhYmVsIGRpdiwgZXhjbHVkaW5nIHRoZSBsZXR0ZXJcclxuICAgICAgICBjb25zdCBsYWJlbERpdiA9IG9wdERpdi5xdWVyeVNlbGVjdG9yKFwiW2RhdGEtcmVnaW9uPSdhbnN3ZXItbGFiZWwnXVwiKTtcclxuICAgICAgICBpZiAobGFiZWxEaXYpIHtcclxuICAgICAgICAgIG9wdGlvblRleHQgPSBsYWJlbERpdi50ZXh0Q29udGVudD8udHJpbSgpIHx8IFwiXCI7XHJcbiAgICAgICAgICAvLyBSZW1vdmUgdGhlIGxldHRlciBwcmVmaXhcclxuICAgICAgICAgIGlmIChsZXR0ZXJFbCkge1xyXG4gICAgICAgICAgICBvcHRpb25UZXh0ID0gb3B0aW9uVGV4dC5yZXBsYWNlKGxldHRlckVsLnRleHRDb250ZW50IHx8IFwiXCIsIFwiXCIpLnRyaW0oKTtcclxuICAgICAgICAgIH1cclxuXHJcbiAgICAgICAgICAvLyBDaGVjayBmb3IgaW1hZ2UgaW4gbGFiZWxcclxuICAgICAgICAgIGNvbnN0IG9wdEltZyA9IGxhYmVsRGl2LnF1ZXJ5U2VsZWN0b3IoXCJpbWc6bm90KC5xdWVzdGlvbmZsYWdpbWFnZSlcIikgYXMgSFRNTEltYWdlRWxlbWVudCB8IG51bGw7XHJcbiAgICAgICAgICBpZiAob3B0SW1nICYmIG9wdEltZy53aWR0aCA+PSA1MCAmJiBvcHRJbWcuaGVpZ2h0ID49IDUwKSB7XHJcbiAgICAgICAgICAgIC8vIFByZWZlciBwdWJsaWMgVVJMIG92ZXIgYmFzZTY0XHJcbiAgICAgICAgICAgIGlmIChpc1B1YmxpY0ltYWdlVXJsKG9wdEltZy5zcmMpKSB7XHJcbiAgICAgICAgICAgICAgb3B0aW9uSW1hZ2UgPSB7XHJcbiAgICAgICAgICAgICAgICB1cmw6IG9wdEltZy5zcmMsXHJcbiAgICAgICAgICAgICAgICBtZWRpYVR5cGU6IFwiaW1hZ2UvanBlZ1wiLFxyXG4gICAgICAgICAgICAgICAgYWx0OiBvcHRJbWcuYWx0IHx8IGBPcHRpb24gJHtsZXR0ZXJ9IGltYWdlYCxcclxuICAgICAgICAgICAgICB9O1xyXG4gICAgICAgICAgICB9IGVsc2Uge1xyXG4gICAgICAgICAgICAgIGNvbnN0IGJhc2U2NERhdGEgPSBhd2FpdCBpbWFnZVRvQmFzZTY0KG9wdEltZyk7XHJcbiAgICAgICAgICAgICAgaWYgKGJhc2U2NERhdGEpIHtcclxuICAgICAgICAgICAgICAgIG9wdGlvbkltYWdlID0ge1xyXG4gICAgICAgICAgICAgICAgICBiYXNlNjQ6IGJhc2U2NERhdGEuYmFzZTY0LFxyXG4gICAgICAgICAgICAgICAgICBtZWRpYVR5cGU6IGJhc2U2NERhdGEubWVkaWFUeXBlLFxyXG4gICAgICAgICAgICAgICAgICBhbHQ6IG9wdEltZy5hbHQgfHwgYE9wdGlvbiAke2xldHRlcn0gaW1hZ2VgLFxyXG4gICAgICAgICAgICAgICAgfTtcclxuICAgICAgICAgICAgICB9XHJcbiAgICAgICAgICAgIH1cclxuICAgICAgICAgIH1cclxuICAgICAgICB9XHJcbiAgICAgIH1cclxuXHJcbiAgICAgIC8vIE1vb2RsZSB0cnVlL2ZhbHNlIG9mdGVuIHVzZXMgPGxhYmVsPiAod2l0aG91dCAuYW5zd2VybnVtYmVyIC8gLmZsZXgtZmlsbClcclxuICAgICAgaWYgKCFvcHRpb25UZXh0KSB7XHJcbiAgICAgICAgY29uc3QgbGFiZWxFbCA9IG9wdERpdi5xdWVyeVNlbGVjdG9yKFwibGFiZWxcIik7XHJcbiAgICAgICAgaWYgKGxhYmVsRWwpIHtcclxuICAgICAgICAgIG9wdGlvblRleHQgPSBsYWJlbEVsLnRleHRDb250ZW50Py50cmltKCkgfHwgXCJcIjtcclxuICAgICAgICB9XHJcbiAgICAgIH1cclxuXHJcbiAgICAgIC8vIExhc3QtcmVzb3J0IHRleHQgZXh0cmFjdGlvbiBmcm9tIG9wdGlvbiBjb250YWluZXJcclxuICAgICAgaWYgKCFvcHRpb25UZXh0KSB7XHJcbiAgICAgICAgb3B0aW9uVGV4dCA9IG9wdERpdi50ZXh0Q29udGVudD8udHJpbSgpIHx8IFwiXCI7XHJcbiAgICAgICAgaWYgKGxldHRlckVsICYmIGxldHRlckVsLnRleHRDb250ZW50KSB7XHJcbiAgICAgICAgICBvcHRpb25UZXh0ID0gb3B0aW9uVGV4dC5yZXBsYWNlKGxldHRlckVsLnRleHRDb250ZW50LCBcIlwiKS50cmltKCk7XHJcbiAgICAgICAgfVxyXG4gICAgICB9XHJcblxyXG4gICAgICAvLyBGb3IgdHJ1ZS9mYWxzZSwgbm9ybWFsaXplIG9wdGlvbiBsZXR0ZXJzIHRvIFYvRiBmb3IgcXVpY2sgbW9kZSBVWFxyXG4gICAgICBpZiAoaXNUcnVlRmFsc2UpIHtcclxuICAgICAgICBjb25zdCBub3JtYWxpemVkID0gb3B0aW9uVGV4dFxyXG4gICAgICAgICAgLm5vcm1hbGl6ZShcIk5GRFwiKVxyXG4gICAgICAgICAgLnJlcGxhY2UoL1tcXHUwMzAwLVxcdTAzNmZdL2csIFwiXCIpXHJcbiAgICAgICAgICAudG9Mb3dlckNhc2UoKTtcclxuXHJcbiAgICAgICAgaWYgKC8oXnxcXGIpKHRydWV8dmVyZGFkZXJvKShcXGJ8JCkvaS50ZXN0KG5vcm1hbGl6ZWQpKSB7XHJcbiAgICAgICAgICBsZXR0ZXIgPSBcIlZcIjtcclxuICAgICAgICB9IGVsc2UgaWYgKC8oXnxcXGIpKGZhbHNlfGZhbHNvKShcXGJ8JCkvaS50ZXN0KG5vcm1hbGl6ZWQpKSB7XHJcbiAgICAgICAgICBsZXR0ZXIgPSBcIkZcIjtcclxuICAgICAgICB9XHJcbiAgICAgIH1cclxuXHJcbiAgICAgIC8vIEZhbGxiYWNrIGxldHRlciBmb3Igbm9uIHRydWUvZmFsc2Ugb3B0aW9ucyB0aGF0IGRvbid0IGV4cG9zZSBhbnN3ZXJudW1iZXJcclxuICAgICAgaWYgKCFsZXR0ZXIpIHtcclxuICAgICAgICBsZXR0ZXIgPSBTdHJpbmcuZnJvbUNoYXJDb2RlKDY1ICsgb3B0aW9ucy5sZW5ndGgpOyAvLyBBLCBCLCBDLi4uXHJcbiAgICAgIH1cclxuXHJcbiAgICAgIC8vIEFjY2VwdCBvcHRpb24gaWYgaXQgaGFzIHRleHQgT1IgYW4gaW1hZ2VcclxuICAgICAgaWYgKG9wdGlvblRleHQgfHwgb3B0aW9uSW1hZ2UpIHtcclxuICAgICAgICBvcHRpb25zLnB1c2goe1xyXG4gICAgICAgICAgbGV0dGVyOiBsZXR0ZXIsXHJcbiAgICAgICAgICB0ZXh0OiBvcHRpb25UZXh0IHx8IGBbSW1hZ2U6ICR7b3B0aW9uSW1hZ2U/LmFsdCB8fCBcIm9wdGlvblwifV1gLFxyXG4gICAgICAgICAgaW1hZ2U6IG9wdGlvbkltYWdlLFxyXG4gICAgICAgIH0pO1xyXG4gICAgICB9XHJcbiAgICB9XHJcbiAgfVxyXG5cclxuICAvLyBDaGVjayBpZiB3ZSBoYXZlIHZhbGlkIGRhdGEgKHRleHQgb3IgaW1hZ2VzIGNvdW50IGFzIHZhbGlkKVxyXG4gIGNvbnN0IGhhc0NvbnRlbnQgPSBxdWVzdGlvblRleHQgfHwgcXVlc3Rpb25JbWFnZXMubGVuZ3RoID4gMDtcclxuICBpZiAoIWhhc0NvbnRlbnQgfHwgb3B0aW9ucy5sZW5ndGggPCAyKSB7XHJcbiAgICByZXR1cm4gbnVsbDtcclxuICB9XHJcblxyXG4gIHJldHVybiB7XHJcbiAgICBpZDogYG1vb2RsZS1xLSR7cXVlc3Rpb25OdW1iZXJ9YCxcclxuICAgIHR5cGU6IGlzVHJ1ZUZhbHNlID8gXCJ0cnVlLWZhbHNlXCIgOiBcIm11bHRpcGxlLWNob2ljZVwiLFxyXG4gICAgdGV4dDogcXVlc3Rpb25UZXh0LFxyXG4gICAgb3B0aW9uczogb3B0aW9ucyxcclxuICAgIGVsZW1lbnQ6IHF1ZXN0aW9uRWwsXHJcbiAgICBxdWVzdGlvbk51bWJlcjogcXVlc3Rpb25OdW1iZXIsXHJcbiAgICBwbGF0Zm9ybTogXCJtb29kbGVcIixcclxuICAgIGltYWdlczogcXVlc3Rpb25JbWFnZXMsIC8vIEFycmF5IG9mIGltYWdlcyBmcm9tIHF1ZXN0aW9uIHRleHRcclxuICAgIGNvbmZpZGVuY2U6IDk1LFxyXG4gICAgY291cnNlTmFtZTogY291cnNlTmFtZSwgLy8gQWNhZGVtaWMgY291cnNlIG5hbWUgZm9yIGNvbnRleHRcclxuICB9O1xyXG59XHJcblxyXG4vKipcclxuICogRXh0cmFjdCBxdWVzdGlvbiBkYXRhIGZyb20gYSBNb29kbGUgXCJtYXRjaFwiIHF1ZXN0aW9uIGVsZW1lbnQuXHJcbiAqIFRoZXNlIHVzZSBhIHRhYmxlIGxheW91dCB3aGVyZSBlYWNoIHJvdyBoYXMgYSBjb25jZXB0ICh0ZC50ZXh0KSBhbmQgYVxyXG4gKiA8c2VsZWN0PiBkcm9wZG93biB3aXRoIHNoYXJlZCBhbnN3ZXIgb3B0aW9ucyAodGQuY29udHJvbCkuXHJcbiAqXHJcbiAqIFRoZSBleHRyYWN0ZWQgcXVlc3Rpb24gdXNlczpcclxuICogICBjYXRlZ29yaWVzIChBLCBCLCBDLi4uKSA9IHRoZSByb3cgY29uY2VwdHNcclxuICogICBtYXRjaGluZ09wdGlvbnMgKDEsIDIsIDMuLi4pID0gdGhlIGRyb3Bkb3duIG9wdGlvbiB2YWx1ZXNcclxuICogd2hpY2ggcHJvZHVjZXMgdGhlIGFuc3dlciBmb3JtYXQ6IEEtMSwgQi0zLCBDLTJcclxuICovXHJcbmFzeW5jIGZ1bmN0aW9uIGV4dHJhY3RNb29kbGVNYXRjaFF1ZXN0aW9uKHF1ZXN0aW9uRWw6IEVsZW1lbnQpOiBQcm9taXNlPERldGVjdGVkUXVlc3Rpb24gfCBudWxsPiB7XHJcbiAgY29uc3QgY291cnNlTmFtZSA9IGV4dHJhY3RNb29kbGVDb3Vyc2VOYW1lKCk7XHJcblxyXG4gIGNvbnN0IHFub0VsID0gcXVlc3Rpb25FbC5xdWVyeVNlbGVjdG9yKFwiLnFub1wiKTtcclxuICBjb25zdCBxdWVzdGlvbk51bWJlciA9IHFub0VsID8gcGFyc2VJbnQocW5vRWwudGV4dENvbnRlbnQ/LnRyaW0oKSB8fCBcIjFcIikgOiAxO1xyXG5cclxuICBjb25zdCBxdGV4dEVsID0gcXVlc3Rpb25FbC5xdWVyeVNlbGVjdG9yKFwiLnF0ZXh0XCIpO1xyXG4gIGNvbnN0IHF1ZXN0aW9uVGV4dCA9IHF0ZXh0RWw/LnRleHRDb250ZW50Py50cmltKCkgfHwgXCJcIjtcclxuXHJcbiAgaWYgKCFxdWVzdGlvblRleHQpIHJldHVybiBudWxsO1xyXG5cclxuICBjb25zdCByb3dzID0gcXVlc3Rpb25FbC5xdWVyeVNlbGVjdG9yQWxsKFwidGFibGUuYW5zd2VyIHRib2R5IHRyXCIpO1xyXG4gIGlmIChyb3dzLmxlbmd0aCA9PT0gMCkgcmV0dXJuIG51bGw7XHJcblxyXG4gIGNvbnN0IGNhdGVnb3JpZXM6IE1hdGNoaW5nQ2F0ZWdvcnlbXSA9IFtdO1xyXG4gIGxldCBtYXRjaGluZ09wdGlvbnM6IE1hdGNoaW5nT3B0aW9uW10gfCBudWxsID0gbnVsbDtcclxuXHJcbiAgZm9yIChjb25zdCBbcm93SW5kZXgsIHJvd10gb2YgQXJyYXkuZnJvbShyb3dzKS5lbnRyaWVzKCkpIHtcclxuICAgIGNvbnN0IHRleHRDZWxsID0gcm93LnF1ZXJ5U2VsZWN0b3IoXCJ0ZC50ZXh0XCIpO1xyXG4gICAgY29uc3QgY29uY2VwdFRleHQgPSB0ZXh0Q2VsbD8udGV4dENvbnRlbnQ/LnRyaW0oKSB8fCBcIlwiO1xyXG5cclxuICAgIGlmIChjb25jZXB0VGV4dCkge1xyXG4gICAgICBjYXRlZ29yaWVzLnB1c2goe1xyXG4gICAgICAgIGxldHRlcjogU3RyaW5nLmZyb21DaGFyQ29kZSg2NSArIHJvd0luZGV4KSwgLy8gQSwgQiwgQy4uLlxyXG4gICAgICAgIHRleHQ6IGNvbmNlcHRUZXh0LFxyXG4gICAgICB9KTtcclxuICAgIH1cclxuXHJcbiAgICAvLyBPcHRpb25zIGFyZSBpZGVudGljYWwgYWNyb3NzIGFsbCByb3dzIFx1MjAxNCBleHRyYWN0IG9uY2UgZnJvbSB0aGUgZmlyc3Qgc2VsZWN0XHJcbiAgICBpZiAoIW1hdGNoaW5nT3B0aW9ucykge1xyXG4gICAgICBjb25zdCBzZWxlY3RFbCA9IHJvdy5xdWVyeVNlbGVjdG9yKFwidGQuY29udHJvbCBzZWxlY3RcIik7XHJcbiAgICAgIGlmIChzZWxlY3RFbCkge1xyXG4gICAgICAgIG1hdGNoaW5nT3B0aW9ucyA9IFtdO1xyXG4gICAgICAgIGZvciAoY29uc3Qgb3B0IG9mIEFycmF5LmZyb20oc2VsZWN0RWwucXVlcnlTZWxlY3RvckFsbChcIm9wdGlvblwiKSkpIHtcclxuICAgICAgICAgIGNvbnN0IHZhbHVlID0gcGFyc2VJbnQob3B0LmdldEF0dHJpYnV0ZShcInZhbHVlXCIpIHx8IFwiMFwiKTtcclxuICAgICAgICAgIGlmICh2YWx1ZSA+IDApIHsgLy8gU2tpcCB0aGUgXCJFbGVnaXIuLi5cIiBwbGFjZWhvbGRlciAodmFsdWU9XCIwXCIpXHJcbiAgICAgICAgICAgIG1hdGNoaW5nT3B0aW9ucy5wdXNoKHtcclxuICAgICAgICAgICAgICBpbmRleDogdmFsdWUsXHJcbiAgICAgICAgICAgICAgdGV4dDogb3B0LnRleHRDb250ZW50Py50cmltKCkgfHwgXCJcIixcclxuICAgICAgICAgICAgfSk7XHJcbiAgICAgICAgICB9XHJcbiAgICAgICAgfVxyXG4gICAgICB9XHJcbiAgICB9XHJcbiAgfVxyXG5cclxuICBpZiAoY2F0ZWdvcmllcy5sZW5ndGggPT09IDAgfHwgIW1hdGNoaW5nT3B0aW9ucyB8fCBtYXRjaGluZ09wdGlvbnMubGVuZ3RoID09PSAwKSB7XHJcbiAgICByZXR1cm4gbnVsbDtcclxuICB9XHJcblxyXG4gIHJldHVybiB7XHJcbiAgICBpZDogYG1vb2RsZS1xLSR7cXVlc3Rpb25OdW1iZXJ9YCxcclxuICAgIHR5cGU6IFwibWF0Y2hpbmdcIixcclxuICAgIHRleHQ6IHF1ZXN0aW9uVGV4dCxcclxuICAgIG9wdGlvbnM6IFtdLFxyXG4gICAgZWxlbWVudDogcXVlc3Rpb25FbCxcclxuICAgIHF1ZXN0aW9uTnVtYmVyLFxyXG4gICAgcGxhdGZvcm06IFwibW9vZGxlXCIsXHJcbiAgICBjb25maWRlbmNlOiA5NSxcclxuICAgIGNvdXJzZU5hbWUsXHJcbiAgICBjYXRlZ29yaWVzLFxyXG4gICAgbWF0Y2hpbmdPcHRpb25zLFxyXG4gICAgLy8gbWF0Y2hpbmdTdHlsZSBpbnRlbnRpb25hbGx5IG9taXR0ZWQgXHUyMTkyIGZhbGxzIGJhY2sgdG8gXCJkcmFnLWRyb3BcIiBpbiBhcGkudHNcclxuICAgIC8vIHdoaWNoIHVzZXMgdGhlIEEtMSwgQi0zLCBDLTIgYW5zd2VyIGZvcm1hdCBleHBlY3RlZCBmb3IgdGhpcyBxdWVzdGlvbiB0eXBlXHJcbiAgfTtcclxufVxyXG5cclxuLyoqXHJcbiAqIEV4dHJhY3QgYSBNb29kbGUgU2hvcnQgQW5zd2VyIG9yIE51bWVyaWNhbCBxdWVzdGlvbi5cclxuICogVGhlc2UgYXJlIGZyZWUtdGV4dCBxdWVzdGlvbnMgXHUyMDE0IG5vIHByZWRlZmluZWQgb3B0aW9ucy5cclxuICovXHJcbmFzeW5jIGZ1bmN0aW9uIGV4dHJhY3RNb29kbGVTaG9ydEFuc3dlclF1ZXN0aW9uKFxyXG4gIHF1ZXN0aW9uRWw6IEVsZW1lbnQsXHJcbiAgdHlwZTogXCJzaG9ydC1hbnN3ZXJcIiB8IFwibnVtZXJpY2FsXCIsXHJcbik6IFByb21pc2U8RGV0ZWN0ZWRRdWVzdGlvbiB8IG51bGw+IHtcclxuICBjb25zdCBjb3Vyc2VOYW1lID0gZXh0cmFjdE1vb2RsZUNvdXJzZU5hbWUoKTtcclxuXHJcbiAgY29uc3QgcW5vRWwgPSBxdWVzdGlvbkVsLnF1ZXJ5U2VsZWN0b3IoXCIucW5vXCIpO1xyXG4gIGNvbnN0IHF1ZXN0aW9uTnVtYmVyID0gcW5vRWwgPyBwYXJzZUludChxbm9FbC50ZXh0Q29udGVudD8udHJpbSgpIHx8IFwiMVwiKSA6IDE7XHJcblxyXG4gIGNvbnN0IHF0ZXh0RWwgPSBxdWVzdGlvbkVsLnF1ZXJ5U2VsZWN0b3IoXCIucXRleHRcIik7XHJcbiAgY29uc3QgcXVlc3Rpb25UZXh0ID0gcXRleHRFbD8udGV4dENvbnRlbnQ/LnRyaW0oKSB8fCBcIlwiO1xyXG5cclxuICBpZiAoIXF1ZXN0aW9uVGV4dCkgcmV0dXJuIG51bGw7XHJcblxyXG4gIHJldHVybiB7XHJcbiAgICBpZDogYG1vb2RsZS1xLSR7cXVlc3Rpb25OdW1iZXJ9YCxcclxuICAgIHR5cGUsXHJcbiAgICB0ZXh0OiBxdWVzdGlvblRleHQsXHJcbiAgICBvcHRpb25zOiBbXSxcclxuICAgIGVsZW1lbnQ6IHF1ZXN0aW9uRWwsXHJcbiAgICBxdWVzdGlvbk51bWJlcixcclxuICAgIHBsYXRmb3JtOiBcIm1vb2RsZVwiLFxyXG4gICAgY29uZmlkZW5jZTogOTUsXHJcbiAgICBjb3Vyc2VOYW1lLFxyXG4gIH07XHJcbn1cclxuXHJcbi8qKlxyXG4gKiBFeHRyYWN0IGEgTW9vZGxlIFwiU2VsZWN0IE1pc3NpbmcgV29yZHNcIiAoZ2Fwc2VsZWN0KSBxdWVzdGlvbi5cclxuICogVGhlIHF1ZXN0aW9uIHRleHQgY29udGFpbnMgaW5saW5lIDxzZWxlY3Q+IGRyb3Bkb3ducyB0aGF0IHJlcGxhY2UgW1tuXV0gcGxhY2Vob2xkZXJzLlxyXG4gKiBFYWNoIGRyb3Bkb3duIGJlbG9uZ3MgdG8gYSBjaG9pY2UgZ3JvdXA7IGdhcHMgc2hhcmluZyBpZGVudGljYWwgb3B0aW9uIGxpc3RzIHNoYXJlIGEgZ3JvdXAuXHJcbiAqL1xyXG5hc3luYyBmdW5jdGlvbiBleHRyYWN0TW9vZGxlU2VsZWN0TWlzc2luZ1dvcmRzKFxyXG4gIHF1ZXN0aW9uRWw6IEVsZW1lbnQsXHJcbik6IFByb21pc2U8RGV0ZWN0ZWRRdWVzdGlvbiB8IG51bGw+IHtcclxuICBjb25zdCBjb3Vyc2VOYW1lID0gZXh0cmFjdE1vb2RsZUNvdXJzZU5hbWUoKTtcclxuXHJcbiAgY29uc3QgcW5vRWwgPSBxdWVzdGlvbkVsLnF1ZXJ5U2VsZWN0b3IoXCIucW5vXCIpO1xyXG4gIGNvbnN0IHF1ZXN0aW9uTnVtYmVyID0gcW5vRWwgPyBwYXJzZUludChxbm9FbC50ZXh0Q29udGVudD8udHJpbSgpIHx8IFwiMVwiKSA6IDE7XHJcblxyXG4gIGNvbnN0IHF0ZXh0RWwgPSBxdWVzdGlvbkVsLnF1ZXJ5U2VsZWN0b3IoXCIucXRleHRcIik7XHJcbiAgaWYgKCFxdGV4dEVsKSByZXR1cm4gbnVsbDtcclxuXHJcbiAgY29uc3QgbGl2ZVNlbGVjdHMgPSBBcnJheS5mcm9tKHF0ZXh0RWwucXVlcnlTZWxlY3RvckFsbChcInNlbGVjdFwiKSk7XHJcbiAgaWYgKGxpdmVTZWxlY3RzLmxlbmd0aCA9PT0gMCkgcmV0dXJuIG51bGw7XHJcblxyXG4gIC8vIENsb25lIHRvIHJlY29uc3RydWN0IHRleHQgd2l0aG91dCBtb2RpZnlpbmcgdGhlIGxpdmUgRE9NXHJcbiAgY29uc3QgY2xvbmVkID0gcXRleHRFbC5jbG9uZU5vZGUodHJ1ZSkgYXMgRWxlbWVudDtcclxuICBjb25zdCBjbG9uZWRTZWxlY3RzID0gQXJyYXkuZnJvbShjbG9uZWQucXVlcnlTZWxlY3RvckFsbChcInNlbGVjdFwiKSk7XHJcblxyXG4gIGNvbnN0IHNlbGVjdEdhcHM6IFNlbGVjdEdhcFtdID0gW107XHJcbiAgY29uc3Qgc2VsZWN0Q2hvaWNlczogUmVjb3JkPHN0cmluZywgc3RyaW5nW10+ID0ge307XHJcblxyXG4gIC8vIGZpbmdlcnByaW50IFx1MjE5MiBncm91cElkLCBzbyBnYXBzIHNoYXJpbmcgdGhlIHNhbWUgb3B0aW9uIGxpc3QgcmV1c2UgdGhlIHNhbWUgZ3JvdXBcclxuICBjb25zdCBjaG9pY2VGaW5nZXJwcmludHMgPSBuZXcgTWFwPHN0cmluZywgc3RyaW5nPigpO1xyXG4gIGxldCBncm91cENvdW50ZXIgPSAwO1xyXG5cclxuICBmb3IgKGxldCBpID0gMDsgaSA8IGxpdmVTZWxlY3RzLmxlbmd0aDsgaSsrKSB7XHJcbiAgICBjb25zdCBsaXZlU2VsZWN0ID0gbGl2ZVNlbGVjdHNbaV07XHJcbiAgICBjb25zdCBjbG9uZWRTZWxlY3QgPSBjbG9uZWRTZWxlY3RzW2ldO1xyXG4gICAgY29uc3QgZ2FwSW5kZXggPSBpICsgMTsgLy8gMS1iYXNlZFxyXG5cclxuICAgIC8vIENvbGxlY3QgY2hvaWNlcyAoc2tpcCB0aGUgXCJDaG9vc2UuLi5cIiBwbGFjZWhvbGRlciBhdCB2YWx1ZSAwKVxyXG4gICAgY29uc3QgY2hvaWNlczogc3RyaW5nW10gPSBbXTtcclxuICAgIGZvciAoY29uc3Qgb3B0IG9mIEFycmF5LmZyb20obGl2ZVNlbGVjdC5xdWVyeVNlbGVjdG9yQWxsKFwib3B0aW9uXCIpKSkge1xyXG4gICAgICBjb25zdCB2YWx1ZSA9IHBhcnNlSW50KG9wdC5nZXRBdHRyaWJ1dGUoXCJ2YWx1ZVwiKSB8fCBcIjBcIik7XHJcbiAgICAgIGlmICh2YWx1ZSA+IDApIHtcclxuICAgICAgICBjaG9pY2VzLnB1c2gob3B0LnRleHRDb250ZW50Py50cmltKCkgfHwgXCJcIik7XHJcbiAgICAgIH1cclxuICAgIH1cclxuXHJcbiAgICAvLyBEZXRlcm1pbmUgZ3JvdXAgYnkgZmluZ2VycHJpbnRpbmcgdGhlIGNob2ljZSBsaXN0XHJcbiAgICBjb25zdCBmaW5nZXJwcmludCA9IGNob2ljZXMuam9pbihcInxcIik7XHJcbiAgICBsZXQgZ3JvdXBJZDogc3RyaW5nO1xyXG4gICAgaWYgKGNob2ljZUZpbmdlcnByaW50cy5oYXMoZmluZ2VycHJpbnQpKSB7XHJcbiAgICAgIGdyb3VwSWQgPSBjaG9pY2VGaW5nZXJwcmludHMuZ2V0KGZpbmdlcnByaW50KSE7XHJcbiAgICB9IGVsc2Uge1xyXG4gICAgICBncm91cElkID0gU3RyaW5nLmZyb21DaGFyQ29kZSg2NSArIGdyb3VwQ291bnRlcik7IC8vIEEsIEIsIEMuLi5cclxuICAgICAgZ3JvdXBDb3VudGVyKys7XHJcbiAgICAgIGNob2ljZUZpbmdlcnByaW50cy5zZXQoZmluZ2VycHJpbnQsIGdyb3VwSWQpO1xyXG4gICAgICBzZWxlY3RDaG9pY2VzW2dyb3VwSWRdID0gY2hvaWNlcztcclxuICAgIH1cclxuXHJcbiAgICAvLyBSZXBsYWNlIHRoZSBjbG9uZWQgPHNlbGVjdD4gd2l0aCBhIHBsYWluLXRleHQgW1tuXV0gbWFya2VyXHJcbiAgICBjbG9uZWRTZWxlY3QucmVwbGFjZVdpdGgoYFtbJHtnYXBJbmRleH1dXWApO1xyXG5cclxuICAgIHNlbGVjdEdhcHMucHVzaCh7IGluZGV4OiBnYXBJbmRleCwgZ3JvdXBJZCwgbGVmdENvbnRleHQ6IFwiXCIsIHJpZ2h0Q29udGV4dDogXCJcIiB9KTtcclxuICB9XHJcblxyXG4gIC8vIFJlY29uc3RydWN0IHF1ZXN0aW9uIHRleHQgYW5kIGZpbGwgaW4gZ2FwIGNvbnRleHRzXHJcbiAgY29uc3QgZnVsbFRleHQgPSAoY2xvbmVkLnRleHRDb250ZW50IHx8IFwiXCIpLnJlcGxhY2UoL1xccysvZywgXCIgXCIpLnRyaW0oKTtcclxuXHJcbiAgZm9yIChjb25zdCBnYXAgb2Ygc2VsZWN0R2Fwcykge1xyXG4gICAgY29uc3QgbWFya2VyID0gYFtbJHtnYXAuaW5kZXh9XV1gO1xyXG4gICAgY29uc3QgcG9zID0gZnVsbFRleHQuaW5kZXhPZihtYXJrZXIpO1xyXG4gICAgaWYgKHBvcyAhPT0gLTEpIHtcclxuICAgICAgZ2FwLmxlZnRDb250ZXh0ID0gZnVsbFRleHQuc3Vic3RyaW5nKDAsIHBvcykuc2xpY2UoLTYwKS50cmltKCk7XHJcbiAgICAgIGdhcC5yaWdodENvbnRleHQgPSBmdWxsVGV4dC5zdWJzdHJpbmcocG9zICsgbWFya2VyLmxlbmd0aCwgcG9zICsgbWFya2VyLmxlbmd0aCArIDYwKS50cmltKCk7XHJcbiAgICB9XHJcbiAgfVxyXG5cclxuICBpZiAoIWZ1bGxUZXh0IHx8IHNlbGVjdEdhcHMubGVuZ3RoID09PSAwKSByZXR1cm4gbnVsbDtcclxuXHJcbiAgcmV0dXJuIHtcclxuICAgIGlkOiBgbW9vZGxlLXEtJHtxdWVzdGlvbk51bWJlcn1gLFxyXG4gICAgdHlwZTogXCJzZWxlY3QtbWlzc2luZy13b3Jkc1wiLFxyXG4gICAgdGV4dDogZnVsbFRleHQsXHJcbiAgICBvcHRpb25zOiBbXSxcclxuICAgIGVsZW1lbnQ6IHF1ZXN0aW9uRWwsXHJcbiAgICBxdWVzdGlvbk51bWJlcixcclxuICAgIHBsYXRmb3JtOiBcIm1vb2RsZVwiLFxyXG4gICAgY29uZmlkZW5jZTogOTUsXHJcbiAgICBjb3Vyc2VOYW1lLFxyXG4gICAgc2VsZWN0R2FwcyxcclxuICAgIHNlbGVjdENob2ljZXMsXHJcbiAgfTtcclxufVxyXG5cclxuLyoqXHJcbiAqIEJ1aWxkIGEgbWFwIG9mIGFsbCBxdWVzdGlvbnMgKG1jcSBhbmQgbWF0Y2hpbmcpIGluZGV4ZWQgYnkgcXVlc3Rpb24gbnVtYmVyXHJcbiAqIEVhY2ggZW50cnkgY29udGFpbnM6IHsgdHlwZSwgcXVlc3Rpb24sIHNjb3JlLCBlbGVtZW50IH1cclxuICogQHJldHVybnMgTWFwIG9mIHF1ZXN0aW9uIG51bWJlciB0byBxdWVzdGlvbiBkYXRhXHJcbiAqL1xyXG5leHBvcnQgZnVuY3Rpb24gYnVpbGRRdWVzdGlvbk1hcCgpOiBRdWVzdGlvbk1hcCB7XHJcbiAgY29uc3QgcXVlc3Rpb25NYXA6IFF1ZXN0aW9uTWFwID0ge307XHJcbiAgY29uc3Qgdmlld3BvcnRDZW50ZXJZID0gd2luZG93LmlubmVySGVpZ2h0IC8gMjtcclxuICBjb25zdCB2aWV3cG9ydENlbnRlclggPSB3aW5kb3cuaW5uZXJXaWR0aCAvIDI7XHJcbiAgbGV0IHN5bnRoZXRpY1F1ZXN0aW9uTnVtID0gMTAwMDAwMDtcclxuXHJcbiAgLy8gQ29sbGVjdCBhbGwgbWNxLXZpZXdzXHJcbiAgY29uc3QgbWNxVmlld3MgPSBxdWVyeVNlbGVjdG9yQWxsRGVlcChcIm1jcS12aWV3XCIpO1xyXG5cclxuICAvLyBDb2xsZWN0IGFsbCBtYXRjaGluZy12aWV3cyAoZHJhZy1hbmQtZHJvcCBzdHlsZSlcclxuICBjb25zdCBtYXRjaGluZ1ZpZXdzID0gcXVlcnlTZWxlY3RvckFsbERlZXAoXCJvYmplY3QtbWF0Y2hpbmctdmlld1wiKTtcclxuXHJcbiAgLy8gQ29sbGVjdCBhbGwgbWF0Y2hpbmctdmlldyAoZHJvcGRvd24gc3R5bGUgLSBuZXcgZm9ybWF0KVxyXG4gIGNvbnN0IGRyb3Bkb3duTWF0Y2hpbmdWaWV3cyA9IHF1ZXJ5U2VsZWN0b3JBbGxEZWVwKFwibWF0Y2hpbmctdmlld1wiKTtcclxuXHJcbiAgLy8gUHJvY2VzcyBtY3Etdmlld3MgLSBmaW5kIHRoZWlyIGFzc29jaWF0ZWQgcXVlc3Rpb24gbnVtYmVyc1xyXG4gIGZvciAoY29uc3QgbWNxVmlldyBvZiBtY3FWaWV3cykge1xyXG4gICAgY29uc3QgcmVjdCA9IG1jcVZpZXcuZ2V0Qm91bmRpbmdDbGllbnRSZWN0KCk7XHJcbiAgICBjb25zdCBoYXNTaXplID0gcmVjdC53aWR0aCA+IDAgJiYgcmVjdC5oZWlnaHQgPiAwO1xyXG4gICAgaWYgKCFoYXNTaXplKSBjb250aW51ZTtcclxuXHJcbiAgICAvLyBGaW5kIHRoZSBxdWVzdGlvbiBudW1iZXIgYXNzb2NpYXRlZCB3aXRoIHRoaXMgbWNxLXZpZXdcclxuICAgIGNvbnN0IHF1ZXN0aW9uTnVtID0gZmluZFF1ZXN0aW9uTnVtYmVyRm9yRWxlbWVudChtY3FWaWV3KTtcclxuICAgIGlmIChxdWVzdGlvbk51bSA9PT0gbnVsbCkgY29udGludWU7XHJcblxyXG4gICAgLy8gQ2FsY3VsYXRlIHZpc2liaWxpdHkgc2NvcmVcclxuICAgIGNvbnN0IGNlbnRlckRpc3QgPSBNYXRoLnNxcnQoXHJcbiAgICAgIE1hdGgucG93KHJlY3QubGVmdCArIHJlY3Qud2lkdGggLyAyIC0gdmlld3BvcnRDZW50ZXJYLCAyKSArXHJcbiAgICAgICAgTWF0aC5wb3cocmVjdC50b3AgKyByZWN0LmhlaWdodCAvIDIgLSB2aWV3cG9ydENlbnRlclksIDIpLFxyXG4gICAgKTtcclxuICAgIGNvbnN0IHNjb3JlID0gMTAwMDAgLSBjZW50ZXJEaXN0O1xyXG5cclxuICAgIC8vIEV4dHJhY3QgcXVlc3Rpb24gZGF0YVxyXG4gICAgY29uc3QgcXVlc3Rpb24gPSBleHRyYWN0UXVlc3Rpb25Gcm9tTWNxVmlldyhtY3FWaWV3LCBxdWVzdGlvbk51bSk7XHJcbiAgICBpZiAoIXF1ZXN0aW9uIHx8IHF1ZXN0aW9uLm9wdGlvbnMubGVuZ3RoIDwgMikgY29udGludWU7XHJcblxyXG4gICAgLy8gT25seSBhZGQgaWYgdGhpcyBxdWVzdGlvbiBudW1iZXIgZG9lc24ndCBleGlzdCBvciBoYXMgYSBoaWdoZXIgc2NvcmVcclxuICAgIGlmICghcXVlc3Rpb25NYXBbcXVlc3Rpb25OdW1dIHx8IHF1ZXN0aW9uTWFwW3F1ZXN0aW9uTnVtXS5zY29yZSA8IHNjb3JlKSB7XHJcbiAgICAgIHF1ZXN0aW9uTWFwW3F1ZXN0aW9uTnVtXSA9IHtcclxuICAgICAgICB0eXBlOiBcIm1jcVwiLFxyXG4gICAgICAgIHF1ZXN0aW9uOiBxdWVzdGlvbixcclxuICAgICAgICBzY29yZTogc2NvcmUsXHJcbiAgICAgICAgZWxlbWVudDogbWNxVmlldyxcclxuICAgICAgfTtcclxuICAgIH1cclxuICB9XHJcblxyXG4gIC8vIFByb2Nlc3MgbWF0Y2hpbmctdmlld3MgLSBmaW5kIHRoZWlyIGFzc29jaWF0ZWQgcXVlc3Rpb24gbnVtYmVyc1xyXG4gIGZvciAoY29uc3QgbWF0Y2hpbmdWaWV3IG9mIG1hdGNoaW5nVmlld3MpIHtcclxuICAgIGNvbnN0IHJlY3QgPSBtYXRjaGluZ1ZpZXcuZ2V0Qm91bmRpbmdDbGllbnRSZWN0KCk7XHJcbiAgICBjb25zdCBoYXNTaXplID0gcmVjdC53aWR0aCA+IDAgJiYgcmVjdC5oZWlnaHQgPiAwO1xyXG4gICAgaWYgKCFoYXNTaXplKSBjb250aW51ZTtcclxuXHJcbiAgICAvLyBGaW5kIHRoZSBxdWVzdGlvbiBudW1iZXIgYXNzb2NpYXRlZCB3aXRoIHRoaXMgbWF0Y2hpbmctdmlld1xyXG4gICAgY29uc3QgZGV0ZWN0ZWRRdWVzdGlvbk51bSA9IGZpbmRRdWVzdGlvbk51bWJlckZvckVsZW1lbnQobWF0Y2hpbmdWaWV3KTtcclxuICAgIGNvbnN0IHF1ZXN0aW9uTnVtID1cclxuICAgICAgZGV0ZWN0ZWRRdWVzdGlvbk51bSAhPT0gbnVsbFxyXG4gICAgICAgID8gZGV0ZWN0ZWRRdWVzdGlvbk51bVxyXG4gICAgICAgIDogc3ludGhldGljUXVlc3Rpb25OdW0rKztcclxuXHJcbiAgICAvLyBDYWxjdWxhdGUgdmlzaWJpbGl0eSBzY29yZVxyXG4gICAgY29uc3QgY2VudGVyRGlzdCA9IE1hdGguc3FydChcclxuICAgICAgTWF0aC5wb3cocmVjdC5sZWZ0ICsgcmVjdC53aWR0aCAvIDIgLSB2aWV3cG9ydENlbnRlclgsIDIpICtcclxuICAgICAgICBNYXRoLnBvdyhyZWN0LnRvcCArIHJlY3QuaGVpZ2h0IC8gMiAtIHZpZXdwb3J0Q2VudGVyWSwgMiksXHJcbiAgICApO1xyXG4gICAgY29uc3Qgc2NvcmUgPSAxMDAwMCAtIGNlbnRlckRpc3Q7XHJcblxyXG4gICAgLy8gRXh0cmFjdCBtYXRjaGluZyBxdWVzdGlvbiBkYXRhXHJcbiAgICBjb25zdCBxdWVzdGlvbiA9IGV4dHJhY3RNYXRjaGluZ1F1ZXN0aW9uRnJvbVZpZXcobWF0Y2hpbmdWaWV3LCBxdWVzdGlvbk51bSk7XHJcbiAgICBpZiAoIXF1ZXN0aW9uKSBjb250aW51ZTtcclxuXHJcbiAgICAvLyBPbmx5IGFkZCBpZiB0aGlzIHF1ZXN0aW9uIG51bWJlciBkb2Vzbid0IGV4aXN0IG9yIGhhcyBhIGhpZ2hlciBzY29yZVxyXG4gICAgaWYgKCFxdWVzdGlvbk1hcFtxdWVzdGlvbk51bV0gfHwgcXVlc3Rpb25NYXBbcXVlc3Rpb25OdW1dLnNjb3JlIDwgc2NvcmUpIHtcclxuICAgICAgcXVlc3Rpb25NYXBbcXVlc3Rpb25OdW1dID0ge1xyXG4gICAgICAgIHR5cGU6IFwibWF0Y2hpbmdcIixcclxuICAgICAgICBxdWVzdGlvbjogcXVlc3Rpb24sXHJcbiAgICAgICAgc2NvcmU6IHNjb3JlLFxyXG4gICAgICAgIGVsZW1lbnQ6IG1hdGNoaW5nVmlldyxcclxuICAgICAgfTtcclxuICAgIH1cclxuICB9XHJcblxyXG4gIC8vIFByb2Nlc3MgZHJvcGRvd24gbWF0Y2hpbmctdmlld3MgKG5ldyBmb3JtYXQgd2l0aCBkcm9wZG93bnMpXHJcbiAgZm9yIChjb25zdCBtYXRjaGluZ1ZpZXcgb2YgZHJvcGRvd25NYXRjaGluZ1ZpZXdzKSB7XHJcbiAgICBjb25zdCByZWN0ID0gbWF0Y2hpbmdWaWV3LmdldEJvdW5kaW5nQ2xpZW50UmVjdCgpO1xyXG4gICAgY29uc3QgaGFzU2l6ZSA9IHJlY3Qud2lkdGggPiAwICYmIHJlY3QuaGVpZ2h0ID4gMDtcclxuICAgIGlmICghaGFzU2l6ZSkgY29udGludWU7XHJcblxyXG4gICAgLy8gRmluZCB0aGUgcXVlc3Rpb24gbnVtYmVyIGFzc29jaWF0ZWQgd2l0aCB0aGlzIG1hdGNoaW5nLXZpZXdcclxuICAgIGNvbnN0IGRldGVjdGVkUXVlc3Rpb25OdW0gPSBmaW5kUXVlc3Rpb25OdW1iZXJGb3JFbGVtZW50KG1hdGNoaW5nVmlldyk7XHJcbiAgICBjb25zdCBxdWVzdGlvbk51bSA9XHJcbiAgICAgIGRldGVjdGVkUXVlc3Rpb25OdW0gIT09IG51bGxcclxuICAgICAgICA/IGRldGVjdGVkUXVlc3Rpb25OdW1cclxuICAgICAgICA6IHN5bnRoZXRpY1F1ZXN0aW9uTnVtKys7XHJcblxyXG4gICAgLy8gQ2FsY3VsYXRlIHZpc2liaWxpdHkgc2NvcmVcclxuICAgIGNvbnN0IGNlbnRlckRpc3QgPSBNYXRoLnNxcnQoXHJcbiAgICAgIE1hdGgucG93KHJlY3QubGVmdCArIHJlY3Qud2lkdGggLyAyIC0gdmlld3BvcnRDZW50ZXJYLCAyKSArXHJcbiAgICAgICAgTWF0aC5wb3cocmVjdC50b3AgKyByZWN0LmhlaWdodCAvIDIgLSB2aWV3cG9ydENlbnRlclksIDIpLFxyXG4gICAgKTtcclxuICAgIGNvbnN0IHNjb3JlID0gMTAwMDAgLSBjZW50ZXJEaXN0O1xyXG5cclxuICAgIC8vIEV4dHJhY3QgZHJvcGRvd24gbWF0Y2hpbmcgcXVlc3Rpb24gZGF0YVxyXG4gICAgY29uc3QgcXVlc3Rpb24gPSBleHRyYWN0RHJvcGRvd25NYXRjaGluZ0Zyb21WaWV3KG1hdGNoaW5nVmlldywgcXVlc3Rpb25OdW0pO1xyXG4gICAgaWYgKCFxdWVzdGlvbikgY29udGludWU7XHJcblxyXG4gICAgLy8gT25seSBhZGQgaWYgdGhpcyBxdWVzdGlvbiBudW1iZXIgZG9lc24ndCBleGlzdCBvciBoYXMgYSBoaWdoZXIgc2NvcmVcclxuICAgIGlmICghcXVlc3Rpb25NYXBbcXVlc3Rpb25OdW1dIHx8IHF1ZXN0aW9uTWFwW3F1ZXN0aW9uTnVtXS5zY29yZSA8IHNjb3JlKSB7XHJcbiAgICAgIHF1ZXN0aW9uTWFwW3F1ZXN0aW9uTnVtXSA9IHtcclxuICAgICAgICB0eXBlOiBcIm1hdGNoaW5nXCIsXHJcbiAgICAgICAgcXVlc3Rpb246IHF1ZXN0aW9uLFxyXG4gICAgICAgIHNjb3JlOiBzY29yZSxcclxuICAgICAgICBlbGVtZW50OiBtYXRjaGluZ1ZpZXcsXHJcbiAgICAgIH07XHJcbiAgICB9XHJcbiAgfVxyXG5cclxuICByZXR1cm4gcXVlc3Rpb25NYXA7XHJcbn1cclxuXHJcbi8qKlxyXG4gKiBGaW5kIHRoZSBxdWVzdGlvbiBudW1iZXIgYXNzb2NpYXRlZCB3aXRoIGEgcXVlc3Rpb24gZWxlbWVudCAobWNxLXZpZXcgb3Igb2JqZWN0LW1hdGNoaW5nLXZpZXcpXHJcbiAqIGJ5IHNlYXJjaGluZyBmb3IgXCJQcmVndW50YSBYXCIgdGV4dCBpbiBwYXJlbnQvc2libGluZyBlbGVtZW50cyBhbmQgc2hhZG93IERPTXNcclxuICogQHBhcmFtIGVsZW1lbnQgLSBUaGUgcXVlc3Rpb24gZWxlbWVudFxyXG4gKiBAcmV0dXJucyBUaGUgcXVlc3Rpb24gbnVtYmVyIG9yIG51bGxcclxuICovXHJcbmV4cG9ydCBmdW5jdGlvbiBmaW5kUXVlc3Rpb25OdW1iZXJGb3JFbGVtZW50KGVsZW1lbnQ6IEVsZW1lbnQpOiBudW1iZXIgfCBudWxsIHtcclxuICAvLyBTdHJhdGVneSAxOiBMb29rIGluIGFuY2VzdG9yIGVsZW1lbnRzIGFuZCB0aGVpciBzaGFkb3cgcm9vdHMgZm9yIFwiUHJlZ3VudGEgWFwiXHJcbiAgbGV0IHBhcmVudDogRWxlbWVudCB8IG51bGwgPSBlbGVtZW50LnBhcmVudEVsZW1lbnQgfHwgKGVsZW1lbnQuZ2V0Um9vdE5vZGUoKSBhcyBTaGFkb3dSb290KT8uaG9zdDtcclxuICBsZXQgZGVwdGggPSAwO1xyXG4gIGNvbnN0IG1heERlcHRoID0gMTU7XHJcblxyXG4gIHdoaWxlIChwYXJlbnQgJiYgZGVwdGggPCBtYXhEZXB0aCkge1xyXG4gICAgLy8gQ2hlY2sgdGV4dCBjb250ZW50IG9mIHNpYmxpbmdzIGF0IHRoaXMgbGV2ZWwgKGluY2x1ZGluZyBzaGFkb3cgcm9vdHMpXHJcbiAgICBjb25zdCBzaWJsaW5ncyA9IHBhcmVudC5jaGlsZHJlbjtcclxuICAgIGZvciAoY29uc3Qgc2libGluZyBvZiBzaWJsaW5ncykge1xyXG4gICAgICBpZiAoc2libGluZyA9PT0gZWxlbWVudCkgY29udGludWU7XHJcblxyXG4gICAgICAvLyBDaGVjayBzaWJsaW5nJ3MgdGV4dCBjb250ZW50XHJcbiAgICAgIGxldCB0ZXh0ID0gc2libGluZy50ZXh0Q29udGVudCB8fCBcIlwiO1xyXG4gICAgICBjb25zdCBtYXRjaCA9IHRleHQubWF0Y2goL3ByZWd1bnRhXFxzKihcXGQrKS9pKTtcclxuICAgICAgaWYgKG1hdGNoKSB7XHJcbiAgICAgICAgcmV0dXJuIHBhcnNlSW50KG1hdGNoWzFdKTtcclxuICAgICAgfVxyXG5cclxuICAgICAgLy8gQ2hlY2sgc2libGluZydzIHNoYWRvdyByb290IGlmIHByZXNlbnRcclxuICAgICAgaWYgKHNpYmxpbmcuc2hhZG93Um9vdCkge1xyXG4gICAgICAgIGNvbnN0IHNoYWRvd1RleHQgPSBzaWJsaW5nLnNoYWRvd1Jvb3QudGV4dENvbnRlbnQgfHwgXCJcIjtcclxuICAgICAgICBjb25zdCBzaGFkb3dNYXRjaCA9IHNoYWRvd1RleHQubWF0Y2goL3ByZWd1bnRhXFxzKihcXGQrKS9pKTtcclxuICAgICAgICBpZiAoc2hhZG93TWF0Y2gpIHtcclxuICAgICAgICAgIHJldHVybiBwYXJzZUludChzaGFkb3dNYXRjaFsxXSk7XHJcbiAgICAgICAgfVxyXG4gICAgICB9XHJcbiAgICB9XHJcblxyXG4gICAgLy8gQ2hlY2sgcGFyZW50J3Mgb3duIHRleHQgKGV4Y2x1ZGluZyBjaGlsZHJlbilcclxuICAgIGNvbnN0IHBhcmVudFRleHQgPSBnZXREaXJlY3RUZXh0Q29udGVudChwYXJlbnQpO1xyXG4gICAgY29uc3QgcGFyZW50TWF0Y2ggPSBwYXJlbnRUZXh0Lm1hdGNoKC9wcmVndW50YVxccyooXFxkKykvaSk7XHJcbiAgICBpZiAocGFyZW50TWF0Y2gpIHtcclxuICAgICAgcmV0dXJuIHBhcnNlSW50KHBhcmVudE1hdGNoWzFdKTtcclxuICAgIH1cclxuXHJcbiAgICAvLyBDaGVjayBwYXJlbnQncyBzaGFkb3cgcm9vdFxyXG4gICAgaWYgKHBhcmVudC5zaGFkb3dSb290KSB7XHJcbiAgICAgIGNvbnN0IHNoYWRvd1RleHQgPSBwYXJlbnQuc2hhZG93Um9vdC50ZXh0Q29udGVudCB8fCBcIlwiO1xyXG4gICAgICBjb25zdCBzaGFkb3dNYXRjaCA9IHNoYWRvd1RleHQubWF0Y2goL3ByZWd1bnRhXFxzKihcXGQrKS9pKTtcclxuICAgICAgaWYgKHNoYWRvd01hdGNoKSB7XHJcbiAgICAgICAgcmV0dXJuIHBhcnNlSW50KHNoYWRvd01hdGNoWzFdKTtcclxuICAgICAgfVxyXG4gICAgfVxyXG5cclxuICAgIC8vIE1vdmUgdXAgLSBoYW5kbGUgYm90aCByZWd1bGFyIERPTSBhbmQgc2hhZG93IERPTVxyXG4gICAgaWYgKHBhcmVudC5wYXJlbnRFbGVtZW50KSB7XHJcbiAgICAgIHBhcmVudCA9IHBhcmVudC5wYXJlbnRFbGVtZW50O1xyXG4gICAgfSBlbHNlIGlmICgocGFyZW50LmdldFJvb3ROb2RlKCkgYXMgU2hhZG93Um9vdCk/Lmhvc3QpIHtcclxuICAgICAgcGFyZW50ID0gKHBhcmVudC5nZXRSb290Tm9kZSgpIGFzIFNoYWRvd1Jvb3QpLmhvc3Q7XHJcbiAgICB9IGVsc2Uge1xyXG4gICAgICBicmVhaztcclxuICAgIH1cclxuICAgIGRlcHRoKys7XHJcbiAgfVxyXG5cclxuICAvLyBTdHJhdGVneSAyOiBMb29rIGluIHRoZSBlbGVtZW50J3Mgc2hhZG93IHJvb3QgZm9yIHF1ZXN0aW9uIG51bWJlclxyXG4gIGlmIChlbGVtZW50LnNoYWRvd1Jvb3QpIHtcclxuICAgIGNvbnN0IHNoYWRvd1RleHQgPSBlbGVtZW50LnNoYWRvd1Jvb3QudGV4dENvbnRlbnQgfHwgXCJcIjtcclxuICAgIGNvbnN0IG1hdGNoID0gc2hhZG93VGV4dC5tYXRjaCgvcHJlZ3VudGFcXHMqKFxcZCspL2kpO1xyXG4gICAgaWYgKG1hdGNoKSB7XHJcbiAgICAgIHJldHVybiBwYXJzZUludChtYXRjaFsxXSk7XHJcbiAgICB9XHJcbiAgfVxyXG5cclxuICAvLyBTdHJhdGVneSAzOiBVc2UgcG9zaXRpb24tYmFzZWQgZXN0aW1hdGlvblxyXG4gIC8vIEZpbmQgYWxsIFwiUHJlZ3VudGEgWFwiIGVsZW1lbnRzIGFuZCBtYXRjaCBieSBwcm94aW1pdHlcclxuICBjb25zdCByZWN0ID0gZWxlbWVudC5nZXRCb3VuZGluZ0NsaWVudFJlY3QoKTtcclxuICBpZiAocmVjdC53aWR0aCA9PT0gMCB8fCByZWN0LmhlaWdodCA9PT0gMCkgcmV0dXJuIG51bGw7XHJcblxyXG4gIGNvbnN0IHByZWd1bnRhRWxlbWVudHM6IFByZWd1bnRhRWxlbWVudFtdID0gW107XHJcblxyXG4gIGZ1bmN0aW9uIGNvbGxlY3RQcmVndW50YUVsZW1lbnRzKHJvb3Q6IEVsZW1lbnQgfCBEb2N1bWVudCB8IFNoYWRvd1Jvb3QpOiB2b2lkIHtcclxuICAgIGNvbnN0IHdhbGtlciA9IGRvY3VtZW50LmNyZWF0ZVRyZWVXYWxrZXIocm9vdCBhcyBOb2RlLCBOb2RlRmlsdGVyLlNIT1dfVEVYVCk7XHJcbiAgICBsZXQgbm9kZTogVGV4dCB8IG51bGw7XHJcbiAgICB3aGlsZSAoKG5vZGUgPSB3YWxrZXIubmV4dE5vZGUoKSBhcyBUZXh0IHwgbnVsbCkpIHtcclxuICAgICAgaWYgKG5vZGUudGV4dENvbnRlbnQgJiYgL3ByZWd1bnRhXFxzKlxcZCsvaS50ZXN0KG5vZGUudGV4dENvbnRlbnQpKSB7XHJcbiAgICAgICAgY29uc3QgbWF0Y2ggPSBub2RlLnRleHRDb250ZW50Lm1hdGNoKC9wcmVndW50YVxccyooXFxkKykvaSk7XHJcbiAgICAgICAgaWYgKG1hdGNoICYmIG5vZGUucGFyZW50RWxlbWVudCkge1xyXG4gICAgICAgICAgY29uc3QgcHJlZ3VudGFSZWN0ID0gbm9kZS5wYXJlbnRFbGVtZW50LmdldEJvdW5kaW5nQ2xpZW50UmVjdCgpO1xyXG4gICAgICAgICAgaWYgKHByZWd1bnRhUmVjdC53aWR0aCA+IDAgJiYgcHJlZ3VudGFSZWN0LmhlaWdodCA+IDApIHtcclxuICAgICAgICAgICAgcHJlZ3VudGFFbGVtZW50cy5wdXNoKHtcclxuICAgICAgICAgICAgICBudW06IHBhcnNlSW50KG1hdGNoWzFdKSxcclxuICAgICAgICAgICAgICByZWN0OiBwcmVndW50YVJlY3QsXHJcbiAgICAgICAgICAgICAgZWxlbWVudDogbm9kZS5wYXJlbnRFbGVtZW50LFxyXG4gICAgICAgICAgICB9KTtcclxuICAgICAgICAgIH1cclxuICAgICAgICB9XHJcbiAgICAgIH1cclxuICAgIH1cclxuICAgIC8vIENoZWNrIHNoYWRvdyByb290c1xyXG4gICAgY29uc3QgZWxlbWVudHMgPSByb290LnF1ZXJ5U2VsZWN0b3JBbGwoXCIqXCIpO1xyXG4gICAgZWxlbWVudHMuZm9yRWFjaCgoZWwpID0+IHtcclxuICAgICAgaWYgKGVsLnNoYWRvd1Jvb3QpIHtcclxuICAgICAgICBjb2xsZWN0UHJlZ3VudGFFbGVtZW50cyhlbC5zaGFkb3dSb290KTtcclxuICAgICAgfVxyXG4gICAgfSk7XHJcbiAgfVxyXG5cclxuICBjb2xsZWN0UHJlZ3VudGFFbGVtZW50cyhkb2N1bWVudCk7XHJcblxyXG4gIC8vIEZpbmQgdGhlIFwiUHJlZ3VudGEgWFwiIGVsZW1lbnQgdGhhdCBpcyBjbG9zZXN0IHZlcnRpY2FsbHkgYW5kIGFib3ZlIHRoZSBxdWVzdGlvbiBlbGVtZW50XHJcbiAgbGV0IGJlc3RNYXRjaDogUHJlZ3VudGFFbGVtZW50IHwgbnVsbCA9IG51bGw7XHJcbiAgbGV0IGJlc3REaXN0YW5jZSA9IEluZmluaXR5O1xyXG5cclxuICBmb3IgKGNvbnN0IHByZWd1bnRhIG9mIHByZWd1bnRhRWxlbWVudHMpIHtcclxuICAgIC8vIFRoZSBcIlByZWd1bnRhIFhcIiB0ZXh0IHNob3VsZCBiZSBhYm92ZSBvciBhdCB0aGUgc2FtZSBsZXZlbCBhcyB0aGUgcXVlc3Rpb25cclxuICAgIGNvbnN0IHZlcnRpY2FsRGlzdCA9IHJlY3QudG9wIC0gcHJlZ3VudGEucmVjdC5ib3R0b207XHJcbiAgICBjb25zdCBob3Jpem9udGFsRGlzdCA9IE1hdGguYWJzKFxyXG4gICAgICByZWN0LmxlZnQgK1xyXG4gICAgICAgIHJlY3Qud2lkdGggLyAyIC1cclxuICAgICAgICAocHJlZ3VudGEucmVjdC5sZWZ0ICsgcHJlZ3VudGEucmVjdC53aWR0aCAvIDIpLFxyXG4gICAgKTtcclxuXHJcbiAgICAvLyBPbmx5IGNvbnNpZGVyIGVsZW1lbnRzIHRoYXQgYXJlIGFib3ZlIHRoZSBxdWVzdGlvbiAod2l0aCBzb21lIHRvbGVyYW5jZSlcclxuICAgIGlmICh2ZXJ0aWNhbERpc3QgPj0gLTUwICYmIHZlcnRpY2FsRGlzdCA8IDUwMCkge1xyXG4gICAgICBjb25zdCB0b3RhbERpc3QgPSBNYXRoLmFicyh2ZXJ0aWNhbERpc3QpICsgaG9yaXpvbnRhbERpc3QgKiAwLjU7XHJcbiAgICAgIGlmICh0b3RhbERpc3QgPCBiZXN0RGlzdGFuY2UpIHtcclxuICAgICAgICBiZXN0RGlzdGFuY2UgPSB0b3RhbERpc3Q7XHJcbiAgICAgICAgYmVzdE1hdGNoID0gcHJlZ3VudGE7XHJcbiAgICAgIH1cclxuICAgIH1cclxuICB9XHJcblxyXG4gIGlmIChiZXN0TWF0Y2gpIHtcclxuICAgIHJldHVybiBiZXN0TWF0Y2gubnVtO1xyXG4gIH1cclxuXHJcbiAgcmV0dXJuIG51bGw7XHJcbn1cclxuXHJcbi8qKlxyXG4gKiBFeHRyYWN0IG1hdGNoaW5nIHF1ZXN0aW9uIGRhdGEgZnJvbSBhbiBvYmplY3QtbWF0Y2hpbmctdmlldyBlbGVtZW50XHJcbiAqIFN1cHBvcnRzIGJvdGggZHJhZy1kcm9wIHN0eWxlIGFuZCBkcm9wZG93biBzdHlsZSB3aXRoaW4gb2JqZWN0LW1hdGNoaW5nLXZpZXdcclxuICogQHBhcmFtIG1hdGNoaW5nVmlldyAtIFRoZSBtYXRjaGluZyB2aWV3IGVsZW1lbnRcclxuICogQHBhcmFtIHF1ZXN0aW9uTnVtYmVyIC0gVGhlIHF1ZXN0aW9uIG51bWJlclxyXG4gKiBAcmV0dXJucyBRdWVzdGlvbiBkYXRhIG9yIG51bGxcclxuICovXHJcbmV4cG9ydCBmdW5jdGlvbiBleHRyYWN0TWF0Y2hpbmdRdWVzdGlvbkZyb21WaWV3KFxyXG4gIG1hdGNoaW5nVmlldzogRWxlbWVudCxcclxuICBxdWVzdGlvbk51bWJlcjogbnVtYmVyXHJcbik6IERldGVjdGVkUXVlc3Rpb24gfCBudWxsIHtcclxuICBjb25zdCBzaGFkb3dSb290ID0gbWF0Y2hpbmdWaWV3LnNoYWRvd1Jvb3Q7XHJcbiAgaWYgKCFzaGFkb3dSb290KSByZXR1cm4gbnVsbDtcclxuXHJcbiAgLy8gRXh0cmFjdCBxdWVzdGlvbiB0ZXh0XHJcbiAgbGV0IHF1ZXN0aW9uVGV4dCA9IFwiXCI7XHJcbiAgY29uc3QgYm9keUVscyA9IHF1ZXJ5U2VsZWN0b3JBbGxEZWVwKFxyXG4gICAgXCIuY29tcG9uZW50X19ib2R5LWlubmVyLCAub2JqZWN0TWF0Y2hpbmdfX2JvZHktaW5uZXJcIixcclxuICAgIHNoYWRvd1Jvb3QsXHJcbiAgKTtcclxuICBpZiAoYm9keUVscy5sZW5ndGggPiAwKSB7XHJcbiAgICBxdWVzdGlvblRleHQgPSBib2R5RWxzWzBdLnRleHRDb250ZW50Py50cmltKCkgfHwgXCJcIjtcclxuICB9XHJcblxyXG4gIC8vIENoZWNrIGlmIHRoaXMgaXMgdGhlIGRyb3Bkb3duIHN0eWxlIChvYmplY3QtbWF0Y2hpbmctZHJvcGRvd24tdmlldylcclxuICBjb25zdCBkcm9wZG93blZpZXdzID0gcXVlcnlTZWxlY3RvckFsbERlZXAoXHJcbiAgICBcIm9iamVjdC1tYXRjaGluZy1kcm9wZG93bi12aWV3XCIsXHJcbiAgICBzaGFkb3dSb290LFxyXG4gICk7XHJcblxyXG4gIGlmIChkcm9wZG93blZpZXdzLmxlbmd0aCA+IDApIHtcclxuICAgIC8vIERyb3Bkb3duIHN0eWxlIG1hdGNoaW5nIHdpdGhpbiBvYmplY3QtbWF0Y2hpbmctdmlld1xyXG4gICAgY29uc3QgY2F0ZWdvcmllczogTWF0Y2hpbmdDYXRlZ29yeVtdID0gW107XHJcbiAgICBjb25zdCBhdmFpbGFibGVPcHRpb25zID0gbmV3IFNldDxzdHJpbmc+KCk7XHJcblxyXG4gICAgZHJvcGRvd25WaWV3cy5mb3JFYWNoKChkcm9wZG93blZpZXcsIGluZGV4KSA9PiB7XHJcbiAgICAgIGNvbnN0IGRyb3Bkb3duU2hhZG93ID0gZHJvcGRvd25WaWV3LnNoYWRvd1Jvb3Q7XHJcbiAgICAgIGlmICghZHJvcGRvd25TaGFkb3cpIHJldHVybjtcclxuXHJcbiAgICAgIC8vIEdldCB0aGUgY2F0ZWdvcnkgbGV0dGVyIGFuZCB0ZXh0XHJcbiAgICAgIGNvbnN0IGxldHRlckVsID0gZHJvcGRvd25TaGFkb3cucXVlcnlTZWxlY3RvcihcIi5jYXRlZ29yeS1pdGVtLW51bWJlclwiKTtcclxuICAgICAgY29uc3QgdGl0bGVFbCA9IGRyb3Bkb3duU2hhZG93LnF1ZXJ5U2VsZWN0b3IoXHJcbiAgICAgICAgXCIubWF0Y2hpbmdfX2l0ZW0tdGl0bGVfaW5uZXJcIixcclxuICAgICAgKTtcclxuXHJcbiAgICAgIGlmICh0aXRsZUVsKSB7XHJcbiAgICAgICAgY29uc3QgbGV0dGVyID0gbGV0dGVyRWxcclxuICAgICAgICAgID8gbGV0dGVyRWwudGV4dENvbnRlbnQ/LnRyaW0oKSB8fCBTdHJpbmcuZnJvbUNoYXJDb2RlKDY1ICsgaW5kZXgpXHJcbiAgICAgICAgICA6IFN0cmluZy5mcm9tQ2hhckNvZGUoNjUgKyBpbmRleCk7XHJcbiAgICAgICAgY29uc3QgdGV4dCA9IHRpdGxlRWwudGV4dENvbnRlbnQ/LnRyaW0oKSB8fCBcIlwiO1xyXG5cclxuICAgICAgICAvLyBTa2lwIGJsYW5rL3BsYWNlaG9sZGVyIGl0ZW1zXHJcbiAgICAgICAgaWYgKHRleHQgJiYgIXRleHQuaW5jbHVkZXMoXCJvYmpldGl2byBkZWphZG8gZW4gYmxhbmNvXCIpKSB7XHJcbiAgICAgICAgICBjYXRlZ29yaWVzLnB1c2goe1xyXG4gICAgICAgICAgICBsZXR0ZXI6IGxldHRlcixcclxuICAgICAgICAgICAgdGV4dDogdGV4dCxcclxuICAgICAgICAgIH0pO1xyXG4gICAgICAgIH1cclxuICAgICAgfVxyXG5cclxuICAgICAgLy8gR2V0IHRoZSBkcm9wZG93biBidXR0b24gdG8gZmluZCBhdmFpbGFibGUgb3B0aW9uc1xyXG4gICAgICAvLyBUaGUgb3B0aW9ucyBhcmUgc2hvd24gaW4gYSBkcm9wZG93biBsaXN0IG9yIGNhbiBiZSBpbmZlcnJlZCBmcm9tIGFyaWEtbGFiZWxcclxuICAgICAgY29uc3QgZHJvcGRvd25CdG4gPSBkcm9wZG93blNoYWRvdy5xdWVyeVNlbGVjdG9yKFwiLmRyb3Bkb3duX19idG5cIik7XHJcbiAgICAgIGlmIChkcm9wZG93bkJ0bikge1xyXG4gICAgICAgIGNvbnN0IHNlbGVjdGVkVGV4dCA9IGRyb3Bkb3duU2hhZG93XHJcbiAgICAgICAgICAucXVlcnlTZWxlY3RvcihcIi5kcm9wZG93bl9faW5uZXJcIilcclxuICAgICAgICAgID8udGV4dENvbnRlbnQ/LnRyaW0oKTtcclxuICAgICAgICAvLyBJZiBhbiBvcHRpb24gaXMgc2VsZWN0ZWQgKG5vdCBwbGFjZWhvbGRlciksIGFkZCBpdCB0byBhdmFpbGFibGUgb3B0aW9uc1xyXG4gICAgICAgIGlmIChcclxuICAgICAgICAgIHNlbGVjdGVkVGV4dCAmJlxyXG4gICAgICAgICAgIXNlbGVjdGVkVGV4dC5pbmNsdWRlcyhcInNcdTAwRTlsZWN0aW9ubmVyXCIpICYmXHJcbiAgICAgICAgICAhc2VsZWN0ZWRUZXh0LmluY2x1ZGVzKFwiU2VsZWNjaW9uZVwiKSAmJlxyXG4gICAgICAgICAgIXNlbGVjdGVkVGV4dC5pbmNsdWRlcyhcIlNlbGVjdFwiKVxyXG4gICAgICAgICkge1xyXG4gICAgICAgICAgYXZhaWxhYmxlT3B0aW9ucy5hZGQoc2VsZWN0ZWRUZXh0KTtcclxuICAgICAgICB9XHJcbiAgICAgIH1cclxuXHJcbiAgICAgIC8vIEFsc28gbG9vayBmb3IgZHJvcGRvd24gbGlzdCBpdGVtcyBpZiB2aXNpYmxlXHJcbiAgICAgIGNvbnN0IGxpc3RJdGVtcyA9IGRyb3Bkb3duU2hhZG93LnF1ZXJ5U2VsZWN0b3JBbGwoXHJcbiAgICAgICAgXCIuZHJvcGRvd25fX2l0ZW0taW5uZXJcIixcclxuICAgICAgKTtcclxuICAgICAgbGlzdEl0ZW1zLmZvckVhY2goKGl0ZW0pID0+IHtcclxuICAgICAgICBjb25zdCBvcHRUZXh0ID0gaXRlbS50ZXh0Q29udGVudD8udHJpbSgpO1xyXG4gICAgICAgIGlmIChcclxuICAgICAgICAgIG9wdFRleHQgJiZcclxuICAgICAgICAgICFvcHRUZXh0LmluY2x1ZGVzKFwic1x1MDBFOWxlY3Rpb25uZXJcIikgJiZcclxuICAgICAgICAgICFvcHRUZXh0LmluY2x1ZGVzKFwiU2VsZWNjaW9uZVwiKSAmJlxyXG4gICAgICAgICAgIW9wdFRleHQuaW5jbHVkZXMoXCJTZWxlY3RcIilcclxuICAgICAgICApIHtcclxuICAgICAgICAgIGF2YWlsYWJsZU9wdGlvbnMuYWRkKG9wdFRleHQpO1xyXG4gICAgICAgIH1cclxuICAgICAgfSk7XHJcbiAgICB9KTtcclxuXHJcbiAgICAvLyBDb252ZXJ0IG9wdGlvbnMgdG8gYXJyYXkgd2l0aCBudW1iZXJzXHJcbiAgICBjb25zdCBtYXRjaGluZ09wdGlvbnM6IE1hdGNoaW5nT3B0aW9uW10gPSBBcnJheS5mcm9tKGF2YWlsYWJsZU9wdGlvbnMpLm1hcCgob3B0LCBpZHgpID0+ICh7XHJcbiAgICAgIGluZGV4OiBpZHggKyAxLFxyXG4gICAgICB0ZXh0OiBvcHQsXHJcbiAgICB9KSk7XHJcblxyXG4gICAgaWYgKGNhdGVnb3JpZXMubGVuZ3RoID49IDIpIHtcclxuICAgICAgcmV0dXJuIHtcclxuICAgICAgICBpZDogYG1hdGNoaW5nLSR7cXVlc3Rpb25OdW1iZXJ9YCxcclxuICAgICAgICB0eXBlOiBcIm1hdGNoaW5nXCIsXHJcbiAgICAgICAgbWF0Y2hpbmdTdHlsZTogXCJvYmplY3QtZHJvcGRvd25cIiBhcyBNYXRjaGluZ1N0eWxlLCAvLyBGbGFnIGZvciBvYmplY3QtbWF0Y2hpbmcgd2l0aCBkcm9wZG93bnNcclxuICAgICAgICBxdWVzdGlvbk51bWJlcjogcXVlc3Rpb25OdW1iZXIsXHJcbiAgICAgICAgdGV4dDogcXVlc3Rpb25UZXh0IHx8IGBQcmVndW50YSAke3F1ZXN0aW9uTnVtYmVyIHx8IFwiP1wifWAsXHJcbiAgICAgICAgY2F0ZWdvcmllczogY2F0ZWdvcmllcyxcclxuICAgICAgICBtYXRjaGluZ09wdGlvbnM6XHJcbiAgICAgICAgICBtYXRjaGluZ09wdGlvbnMubGVuZ3RoID4gMFxyXG4gICAgICAgICAgICA/IG1hdGNoaW5nT3B0aW9uc1xyXG4gICAgICAgICAgICA6IFt7IGluZGV4OiAxLCB0ZXh0OiBcIihvcHRpb25zIGluIGRyb3Bkb3duKVwiIH1dLFxyXG4gICAgICAgIGVsZW1lbnQ6IG1hdGNoaW5nVmlldyxcclxuICAgICAgICBvcHRpb25zOiBbXSwgLy8gUmVxdWlyZWQgYnkgaW50ZXJmYWNlXHJcbiAgICAgICAgY29uZmlkZW5jZTogOTUsXHJcbiAgICAgIH07XHJcbiAgICB9XHJcbiAgfVxyXG5cclxuICAvLyBTdGFuZGFyZCBkcmFnLWRyb3Agc3R5bGUgbWF0Y2hpbmdcclxuICAvLyBFeHRyYWN0IGNhdGVnb3JpZXMgKGxlZnQgc2lkZSAtIEEsIEIsIEMuLi4pXHJcbiAgY29uc3QgY2F0ZWdvcmllczogTWF0Y2hpbmdDYXRlZ29yeVtdID0gW107XHJcbiAgY29uc3QgY2F0ZWdvcnlJdGVtcyA9IHF1ZXJ5U2VsZWN0b3JBbGxEZWVwKFxyXG4gICAgXCIub2JqZWN0TWF0Y2hpbmctY2F0ZWdvcnktaXRlbVwiLFxyXG4gICAgc2hhZG93Um9vdCxcclxuICApO1xyXG4gIGNhdGVnb3J5SXRlbXMuZm9yRWFjaCgoaXRlbSwgaW5kZXgpID0+IHtcclxuICAgIGNvbnN0IHRleHRFbCA9IGl0ZW0ucXVlcnlTZWxlY3RvcihcIi5jYXRlZ29yeS1pdGVtLXRleHRcIik7XHJcbiAgICBjb25zdCBsZXR0ZXJFbCA9IGl0ZW0ucXVlcnlTZWxlY3RvcihcIi5jYXRlZ29yeS1pdGVtLW51bWJlclwiKTtcclxuICAgIGlmICh0ZXh0RWwpIHtcclxuICAgICAgY29uc3QgdGV4dCA9IHRleHRFbC50ZXh0Q29udGVudD8udHJpbSgpIHx8IFwiXCI7XHJcbiAgICAgIGNvbnN0IGxldHRlciA9IGxldHRlckVsXHJcbiAgICAgICAgPyBsZXR0ZXJFbC50ZXh0Q29udGVudD8udHJpbSgpIHx8IFN0cmluZy5mcm9tQ2hhckNvZGUoNjUgKyBpbmRleClcclxuICAgICAgICA6IFN0cmluZy5mcm9tQ2hhckNvZGUoNjUgKyBpbmRleCk7XHJcbiAgICAgIGNhdGVnb3JpZXMucHVzaCh7XHJcbiAgICAgICAgbGV0dGVyOiBsZXR0ZXIsXHJcbiAgICAgICAgdGV4dDogdGV4dCxcclxuICAgICAgfSk7XHJcbiAgICB9XHJcbiAgfSk7XHJcblxyXG4gIC8vIEV4dHJhY3Qgb3B0aW9ucyAocmlnaHQgc2lkZSAtIHRvIGJlIG1hdGNoZWQpXHJcbiAgY29uc3QgbWF0Y2hpbmdPcHRpb25zOiBNYXRjaGluZ09wdGlvbltdID0gW107XHJcbiAgY29uc3Qgb3B0aW9uSXRlbXMgPSBxdWVyeVNlbGVjdG9yQWxsRGVlcChcclxuICAgIFwiLm9iamVjdE1hdGNoaW5nLW9wdGlvbi1pdGVtXCIsXHJcbiAgICBzaGFkb3dSb290LFxyXG4gICk7XHJcbiAgb3B0aW9uSXRlbXMuZm9yRWFjaCgoaXRlbSwgaW5kZXgpID0+IHtcclxuICAgIGNvbnN0IHRleHRFbCA9IGl0ZW0ucXVlcnlTZWxlY3RvcihcIi5jYXRlZ29yeS1pdGVtLXRleHRcIik7XHJcbiAgICBpZiAodGV4dEVsKSB7XHJcbiAgICAgIGNvbnN0IHRleHQgPSB0ZXh0RWwudGV4dENvbnRlbnQ/LnRyaW0oKSB8fCBcIlwiO1xyXG4gICAgICBtYXRjaGluZ09wdGlvbnMucHVzaCh7XHJcbiAgICAgICAgaW5kZXg6IGluZGV4ICsgMSxcclxuICAgICAgICB0ZXh0OiB0ZXh0LFxyXG4gICAgICB9KTtcclxuICAgIH1cclxuICB9KTtcclxuXHJcbiAgaWYgKGNhdGVnb3JpZXMubGVuZ3RoID49IDIgJiYgbWF0Y2hpbmdPcHRpb25zLmxlbmd0aCA+PSAyKSB7XHJcbiAgICByZXR1cm4ge1xyXG4gICAgICBpZDogYG1hdGNoaW5nLSR7cXVlc3Rpb25OdW1iZXJ9YCxcclxuICAgICAgdHlwZTogXCJtYXRjaGluZ1wiLFxyXG4gICAgICBxdWVzdGlvbk51bWJlcjogcXVlc3Rpb25OdW1iZXIsXHJcbiAgICAgIHRleHQ6IHF1ZXN0aW9uVGV4dCB8fCBgUHJlZ3VudGEgJHtxdWVzdGlvbk51bWJlciB8fCBcIj9cIn1gLFxyXG4gICAgICBjYXRlZ29yaWVzOiBjYXRlZ29yaWVzLFxyXG4gICAgICBtYXRjaGluZ09wdGlvbnM6IG1hdGNoaW5nT3B0aW9ucyxcclxuICAgICAgZWxlbWVudDogbWF0Y2hpbmdWaWV3LFxyXG4gICAgICBvcHRpb25zOiBbXSwgLy8gUmVxdWlyZWQgYnkgaW50ZXJmYWNlXHJcbiAgICAgIGNvbmZpZGVuY2U6IDk1LFxyXG4gICAgfTtcclxuICB9XHJcbiAgcmV0dXJuIG51bGw7XHJcbn1cclxuXHJcbi8qKlxyXG4gKiBFeHRyYWN0IG1hdGNoaW5nIHF1ZXN0aW9uIGRhdGEgZnJvbSBhIG1hdGNoaW5nLXZpZXcgZWxlbWVudCAoZHJvcGRvd24gc3R5bGUpXHJcbiAqIFRoaXMgaXMgYSBuZXdlciBmb3JtYXQgdXNlZCBpbiBOZXRBY2FkJ3MgXCJNaWRlIFR1IENvbm9jaW1pZW50b1wiIGFzc2Vzc21lbnRzXHJcbiAqIEVhY2ggaXRlbSBoYXMgYSBkZXNjcmlwdGlvbiBhbmQgYSBkcm9wZG93biB0byBzZWxlY3QgdGhlIG1hdGNoaW5nIG9wdGlvbiAoZS5nLiwgVENQL1VEUClcclxuICogQHBhcmFtIG1hdGNoaW5nVmlldyAtIFRoZSBtYXRjaGluZyB2aWV3IGVsZW1lbnRcclxuICogQHBhcmFtIHF1ZXN0aW9uTnVtYmVyIC0gVGhlIHF1ZXN0aW9uIG51bWJlclxyXG4gKiBAcmV0dXJucyBRdWVzdGlvbiBkYXRhIG9yIG51bGxcclxuICovXHJcbmV4cG9ydCBmdW5jdGlvbiBleHRyYWN0RHJvcGRvd25NYXRjaGluZ0Zyb21WaWV3KFxyXG4gIG1hdGNoaW5nVmlldzogRWxlbWVudCxcclxuICBxdWVzdGlvbk51bWJlcjogbnVtYmVyXHJcbik6IERldGVjdGVkUXVlc3Rpb24gfCBudWxsIHtcclxuICBjb25zdCBzaGFkb3dSb290ID0gbWF0Y2hpbmdWaWV3LnNoYWRvd1Jvb3Q7XHJcbiAgaWYgKCFzaGFkb3dSb290KSByZXR1cm4gbnVsbDtcclxuXHJcbiAgLy8gRXh0cmFjdCBxdWVzdGlvbiB0ZXh0IChpbnN0cnVjdGlvbilcclxuICBsZXQgcXVlc3Rpb25UZXh0ID0gXCJcIjtcclxuICBjb25zdCBib2R5RWxzID0gcXVlcnlTZWxlY3RvckFsbERlZXAoXHJcbiAgICBcIi5jb21wb25lbnRfX2JvZHktaW5uZXIsIC5tYXRjaGluZ19fYm9keS1pbm5lclwiLFxyXG4gICAgc2hhZG93Um9vdCxcclxuICApO1xyXG4gIGlmIChib2R5RWxzLmxlbmd0aCA+IDApIHtcclxuICAgIHF1ZXN0aW9uVGV4dCA9IGJvZHlFbHNbMF0udGV4dENvbnRlbnQ/LnRyaW0oKSB8fCBcIlwiO1xyXG4gIH1cclxuXHJcbiAgLy8gRXh0cmFjdCBkcm9wZG93biBpdGVtcyAtIGVhY2ggaGFzIGEgZGVzY3JpcHRpb24gdGhhdCBuZWVkcyB0byBiZSBtYXRjaGVkXHJcbiAgLy8gVGhlIHN0cnVjdHVyZSBpczogbWF0Y2hpbmctZHJvcGRvd24tdmlldyBlbGVtZW50cywgZWFjaCB3aXRoOlxyXG4gIC8vICAgLSAubWF0Y2hpbmdfX2l0ZW0tdGl0bGVfaW5uZXIgKHRoZSBkZXNjcmlwdGlvbiB0byBtYXRjaClcclxuICAvLyAgIC0gLmRyb3Bkb3duX19saXN0IHdpdGggb3B0aW9ucyAod2hhdCB0byBtYXRjaCB0bylcclxuICBjb25zdCBkZXNjcmlwdGlvbnM6IE1hdGNoaW5nT3B0aW9uW10gPSBbXTsgLy8gSXRlbXMgdG8gYmUgbWF0Y2hlZCAobGVmdCBzaWRlIGRlc2NyaXB0aW9ucylcclxuICBjb25zdCBhdmFpbGFibGVPcHRpb25zID0gbmV3IFNldDxzdHJpbmc+KCk7IC8vIEF2YWlsYWJsZSBvcHRpb25zIChlLmcuLCBUQ1AsIFVEUClcclxuXHJcbiAgLy8gRmluZCBhbGwgbWF0Y2hpbmctZHJvcGRvd24tdmlldyBlbGVtZW50c1xyXG4gIGNvbnN0IGRyb3Bkb3duVmlld3MgPSBxdWVyeVNlbGVjdG9yQWxsRGVlcChcclxuICAgIFwibWF0Y2hpbmctZHJvcGRvd24tdmlld1wiLFxyXG4gICAgc2hhZG93Um9vdCxcclxuICApO1xyXG5cclxuICBkcm9wZG93blZpZXdzLmZvckVhY2goKGRyb3Bkb3duVmlldywgaW5kZXgpID0+IHtcclxuICAgIGNvbnN0IGRyb3Bkb3duU2hhZG93ID0gZHJvcGRvd25WaWV3LnNoYWRvd1Jvb3Q7XHJcbiAgICBpZiAoIWRyb3Bkb3duU2hhZG93KSByZXR1cm47XHJcblxyXG4gICAgLy8gR2V0IHRoZSBkZXNjcmlwdGlvbiB0ZXh0XHJcbiAgICBjb25zdCB0aXRsZUVsID0gZHJvcGRvd25TaGFkb3cucXVlcnlTZWxlY3RvcihcIi5tYXRjaGluZ19faXRlbS10aXRsZV9pbm5lclwiKTtcclxuICAgIGlmICh0aXRsZUVsKSB7XHJcbiAgICAgIGNvbnN0IGRlc2NUZXh0ID0gdGl0bGVFbC50ZXh0Q29udGVudD8udHJpbSgpIHx8IFwiXCI7XHJcbiAgICAgIGRlc2NyaXB0aW9ucy5wdXNoKHtcclxuICAgICAgICBpbmRleDogaW5kZXggKyAxLFxyXG4gICAgICAgIHRleHQ6IGRlc2NUZXh0LFxyXG4gICAgICB9KTtcclxuICAgIH1cclxuXHJcbiAgICAvLyBHZXQgdGhlIGF2YWlsYWJsZSBkcm9wZG93biBvcHRpb25zICh1c3VhbGx5IHNhbWUgZm9yIGFsbCBkcm9wZG93bnMpXHJcbiAgICBjb25zdCBvcHRpb25JdGVtcyA9IGRyb3Bkb3duU2hhZG93LnF1ZXJ5U2VsZWN0b3JBbGwoXHJcbiAgICAgIFwiLmRyb3Bkb3duX19pdGVtLWlubmVyXCIsXHJcbiAgICApO1xyXG4gICAgb3B0aW9uSXRlbXMuZm9yRWFjaCgob3B0RWwpID0+IHtcclxuICAgICAgY29uc3Qgb3B0VGV4dCA9IG9wdEVsLnRleHRDb250ZW50Py50cmltKCk7XHJcbiAgICAgIGlmIChvcHRUZXh0ICYmIG9wdFRleHQgIT09IFwiU2VsZWNjaW9uZSB1bmEgb3BjaVx1MDBGM25cIikge1xyXG4gICAgICAgIGF2YWlsYWJsZU9wdGlvbnMuYWRkKG9wdFRleHQpO1xyXG4gICAgICB9XHJcbiAgICB9KTtcclxuICB9KTtcclxuXHJcbiAgLy8gQ29udmVydCBvcHRpb25zIHNldCB0byBhcnJheSB3aXRoIGxldHRlciBhc3NpZ25tZW50c1xyXG4gIGNvbnN0IG1hdGNoaW5nT3B0aW9uc0FzQ2F0ZWdvcmllczogTWF0Y2hpbmdDYXRlZ29yeVtdID0gQXJyYXkuZnJvbShhdmFpbGFibGVPcHRpb25zKS5tYXAoKG9wdCwgaWR4KSA9PiAoe1xyXG4gICAgbGV0dGVyOiBTdHJpbmcuZnJvbUNoYXJDb2RlKDY1ICsgaWR4KSwgLy8gQSwgQiwgQy4uLlxyXG4gICAgdGV4dDogb3B0LFxyXG4gIH0pKTtcclxuXHJcbiAgLy8gRm9yIHRoaXMgdHlwZSBvZiBtYXRjaGluZywgdGhlIFwiY2F0ZWdvcmllc1wiIGFyZSB0aGUgcG9zc2libGUgYW5zd2VycyAoVENQLCBVRFAsIGV0Yy4pXHJcbiAgLy8gYW5kIHRoZSBcIm1hdGNoaW5nT3B0aW9uc1wiIGFyZSB0aGUgZGVzY3JpcHRpb25zIHRoYXQgbmVlZCB0byBiZSBtYXRjaGVkXHJcbiAgaWYgKGRlc2NyaXB0aW9ucy5sZW5ndGggPj0gMiAmJiBtYXRjaGluZ09wdGlvbnNBc0NhdGVnb3JpZXMubGVuZ3RoID49IDEpIHtcclxuICAgIHJldHVybiB7XHJcbiAgICAgIGlkOiBgbWF0Y2hpbmctZHJvcGRvd24tJHtxdWVzdGlvbk51bWJlcn1gLFxyXG4gICAgICB0eXBlOiBcIm1hdGNoaW5nXCIsXHJcbiAgICAgIG1hdGNoaW5nU3R5bGU6IFwiZHJvcGRvd25cIiBhcyBNYXRjaGluZ1N0eWxlLCAvLyBGbGFnIHRvIGluZGljYXRlIGRyb3Bkb3duIHN0eWxlXHJcbiAgICAgIHF1ZXN0aW9uTnVtYmVyOiBxdWVzdGlvbk51bWJlcixcclxuICAgICAgdGV4dDogcXVlc3Rpb25UZXh0IHx8IGBQcmVndW50YSAke3F1ZXN0aW9uTnVtYmVyIHx8IFwiP1wifWAsXHJcbiAgICAgIGNhdGVnb3JpZXM6IG1hdGNoaW5nT3B0aW9uc0FzQ2F0ZWdvcmllcywgLy8gVGhlIGFuc3dlciBvcHRpb25zIChUQ1AsIFVEUClcclxuICAgICAgbWF0Y2hpbmdPcHRpb25zOiBkZXNjcmlwdGlvbnMsIC8vIFRoZSBkZXNjcmlwdGlvbnMgdG8gbWF0Y2hcclxuICAgICAgZWxlbWVudDogbWF0Y2hpbmdWaWV3LFxyXG4gICAgICBvcHRpb25zOiBbXSwgLy8gUmVxdWlyZWQgYnkgaW50ZXJmYWNlXHJcbiAgICAgIGNvbmZpZGVuY2U6IDk1LFxyXG4gICAgfTtcclxuICB9XHJcbiAgcmV0dXJuIG51bGw7XHJcbn1cclxuXHJcbi8qKlxyXG4gKiBFeHRyYWN0IHF1ZXN0aW9uIGRhdGEgZnJvbSBhIHNpbmdsZSBtY3EtdmlldyBlbGVtZW50XHJcbiAqIEBwYXJhbSBtY3FWaWV3IC0gVGhlIG1jcS12aWV3IGVsZW1lbnRcclxuICogQHBhcmFtIHF1ZXN0aW9uTnVtYmVyIC0gVGhlIHF1ZXN0aW9uIG51bWJlclxyXG4gKiBAcmV0dXJucyBRdWVzdGlvbiBkYXRhIG9yIG51bGxcclxuICovXHJcbmV4cG9ydCBmdW5jdGlvbiBleHRyYWN0UXVlc3Rpb25Gcm9tTWNxVmlldyhcclxuICBtY3FWaWV3OiBFbGVtZW50LFxyXG4gIHF1ZXN0aW9uTnVtYmVyOiBudW1iZXJcclxuKTogRGV0ZWN0ZWRRdWVzdGlvbiB8IG51bGwge1xyXG4gIGNvbnN0IHNoYWRvd1Jvb3QgPSBtY3FWaWV3LnNoYWRvd1Jvb3Q7XHJcbiAgaWYgKCFzaGFkb3dSb290KSByZXR1cm4gbnVsbDtcclxuXHJcbiAgLy8gRXh0cmFjdCBxdWVzdGlvbiB0ZXh0XHJcbiAgbGV0IHF1ZXN0aW9uVGV4dCA9IFwiXCI7XHJcbiAgY29uc3QgcXVlc3Rpb25Cb2R5RWxzID0gcXVlcnlTZWxlY3RvckFsbERlZXAoXCIubWNxX19ib2R5LWlubmVyXCIsIHNoYWRvd1Jvb3QpO1xyXG4gIGlmIChxdWVzdGlvbkJvZHlFbHMubGVuZ3RoID4gMCkge1xyXG4gICAgcXVlc3Rpb25UZXh0ID0gcXVlc3Rpb25Cb2R5RWxzWzBdLnRleHRDb250ZW50Py50cmltKCkgfHwgXCJcIjtcclxuICB9XHJcblxyXG4gIC8vIFRyeSB0byBmaW5kIGFjY2Vzc2liaWxpdHkgZGVzY3JpcHRpb25zIGZvciBpbWFnZXMvZGlhZ3JhbXNcclxuICAvLyBUaGVzZSBhcmUgdXN1YWxseSBpbiBwYXJlbnQgZWxlbWVudHMgKGJsb2NrLXZpZXcsIHRhYnMtdmlldywgZXRjLilcclxuICBsZXQgYWNjZXNzaWJpbGl0eUNvbnRleHQgPSBcIlwiO1xyXG5cclxuICAvLyBTZWFyY2ggaW4gdGhlIG1jcS12aWV3J3Mgc2hhZG93IHJvb3QgZmlyc3RcclxuICBhY2Nlc3NpYmlsaXR5Q29udGV4dCA9IGV4dHJhY3RBY2Nlc3NpYmlsaXR5RGVzY3JpcHRpb25zKHNoYWRvd1Jvb3QpO1xyXG5cclxuICAvLyBJZiBub3QgZm91bmQsIHNlYXJjaCBpbiBwYXJlbnQgYmxvY2stdmlldyBvciB0YWJzLXZpZXcgZWxlbWVudHNcclxuICBpZiAoIWFjY2Vzc2liaWxpdHlDb250ZXh0KSB7XHJcbiAgICAvLyBUcnkgdG8gZmluZCBwYXJlbnQgY29udGFpbmVyIHRoYXQgbWlnaHQgaGF2ZSB0aGUgZGlhZ3JhbVxyXG4gICAgbGV0IHBhcmVudDogRWxlbWVudCB8IG51bGwgPSBtY3FWaWV3LnBhcmVudEVsZW1lbnQ7XHJcbiAgICBsZXQgZGVwdGggPSAwO1xyXG4gICAgd2hpbGUgKHBhcmVudCAmJiBkZXB0aCA8IDEwKSB7XHJcbiAgICAgIC8vIENoZWNrIGlmIHRoaXMgZWxlbWVudCBvciBpdHMgc2hhZG93IHJvb3QgaGFzIGFjY2Vzc2liaWxpdHkgZGVzY3JpcHRpb25zXHJcbiAgICAgIGFjY2Vzc2liaWxpdHlDb250ZXh0ID0gZXh0cmFjdEFjY2Vzc2liaWxpdHlEZXNjcmlwdGlvbnMocGFyZW50KTtcclxuICAgICAgaWYgKGFjY2Vzc2liaWxpdHlDb250ZXh0KSBicmVhaztcclxuXHJcbiAgICAgIC8vIEFsc28gY2hlY2sgZm9yIGJsb2NrLXZpZXcgc2hhZG93IHJvb3RzXHJcbiAgICAgIGlmIChwYXJlbnQuc2hhZG93Um9vdCkge1xyXG4gICAgICAgIGFjY2Vzc2liaWxpdHlDb250ZXh0ID0gZXh0cmFjdEFjY2Vzc2liaWxpdHlEZXNjcmlwdGlvbnMoXHJcbiAgICAgICAgICBwYXJlbnQuc2hhZG93Um9vdCxcclxuICAgICAgICApO1xyXG4gICAgICAgIGlmIChhY2Nlc3NpYmlsaXR5Q29udGV4dCkgYnJlYWs7XHJcbiAgICAgIH1cclxuXHJcbiAgICAgIC8vIExvb2sgZm9yIHNwZWNpZmljIE5ldEFjYWQgY29udGFpbmVyIHR5cGVzXHJcbiAgICAgIGlmIChcclxuICAgICAgICBwYXJlbnQudGFnTmFtZSAmJlxyXG4gICAgICAgIChwYXJlbnQudGFnTmFtZS50b0xvd2VyQ2FzZSgpLmluY2x1ZGVzKFwiYmxvY2stdmlld1wiKSB8fFxyXG4gICAgICAgICAgcGFyZW50LnRhZ05hbWUudG9Mb3dlckNhc2UoKS5pbmNsdWRlcyhcInRhYnMtdmlld1wiKSB8fFxyXG4gICAgICAgICAgcGFyZW50LmNsYXNzTGlzdD8uY29udGFpbnMoXCJjb21wb25lbnRfX2NvbnRhaW5lclwiKSlcclxuICAgICAgKSB7XHJcbiAgICAgICAgLy8gU2VhcmNoIGRlZXBseSBpbiB0aGlzIGNvbnRhaW5lclxyXG4gICAgICAgIGNvbnN0IGFsbEVsZW1lbnRzID0gcGFyZW50LnF1ZXJ5U2VsZWN0b3JBbGwoXCIqXCIpO1xyXG4gICAgICAgIGZvciAoY29uc3QgZWwgb2YgYWxsRWxlbWVudHMpIHtcclxuICAgICAgICAgIGlmIChlbC5zaGFkb3dSb290KSB7XHJcbiAgICAgICAgICAgIGFjY2Vzc2liaWxpdHlDb250ZXh0ID0gZXh0cmFjdEFjY2Vzc2liaWxpdHlEZXNjcmlwdGlvbnMoXHJcbiAgICAgICAgICAgICAgZWwuc2hhZG93Um9vdCxcclxuICAgICAgICAgICAgKTtcclxuICAgICAgICAgICAgaWYgKGFjY2Vzc2liaWxpdHlDb250ZXh0KSBicmVhaztcclxuICAgICAgICAgIH1cclxuICAgICAgICB9XHJcbiAgICAgICAgaWYgKGFjY2Vzc2liaWxpdHlDb250ZXh0KSBicmVhaztcclxuICAgICAgfVxyXG5cclxuICAgICAgcGFyZW50ID0gcGFyZW50LnBhcmVudEVsZW1lbnQ7XHJcbiAgICAgIGRlcHRoKys7XHJcbiAgICB9XHJcbiAgfVxyXG5cclxuICAvLyBMYXN0IHJlc29ydDogc2VhcmNoIHRoZSBlbnRpcmUgZG9jdW1lbnQgZm9yIGFueSBhMTF5X2Rlc2NyaXB0aW9uXHJcbiAgLy8gVGhpcyBoYW5kbGVzIGNhc2VzIHdoZXJlIHRoZSBkaWFncmFtIGlzIGluIGEgc2libGluZyBjb21wb25lbnQgKHRhYnMtdmlldylcclxuICBpZiAoIWFjY2Vzc2liaWxpdHlDb250ZXh0KSB7XHJcbiAgICBsb2coXCJbU3R1ZHkgQXNzaXN0XSBTZWFyY2hpbmcgZW50aXJlIGRvY3VtZW50IGZvciBkaWFncmFtIGRlc2NyaXB0aW9ucy4uLlwiKTtcclxuICAgIGFjY2Vzc2liaWxpdHlDb250ZXh0ID0gZXh0cmFjdEFjY2Vzc2liaWxpdHlEZXNjcmlwdGlvbnMoZG9jdW1lbnQuYm9keSk7XHJcbiAgfVxyXG5cclxuICAvLyBJZiB3ZSBmb3VuZCBhY2Nlc3NpYmlsaXR5IGNvbnRleHQgKGRpYWdyYW0gZGVzY3JpcHRpb24pLCBhcHBlbmQgaXQgdG8gcXVlc3Rpb25cclxuICBpZiAoYWNjZXNzaWJpbGl0eUNvbnRleHQpIHtcclxuICAgIGxvZyhcIltTdHVkeSBBc3Npc3RdIEFkZGluZyBkaWFncmFtIGRlc2NyaXB0aW9uIHRvIHF1ZXN0aW9uIGNvbnRleHRcIik7XHJcbiAgICBxdWVzdGlvblRleHQgPVxyXG4gICAgICBxdWVzdGlvblRleHQgKyBcIlxcblxcbltESUFHUkFNIERFU0NSSVBUSU9OXVxcblwiICsgYWNjZXNzaWJpbGl0eUNvbnRleHQ7XHJcbiAgfVxyXG5cclxuICAvLyBFeHRyYWN0IG9wdGlvbnNcclxuICBjb25zdCBvcHRpb25FbHMgPSBxdWVyeVNlbGVjdG9yQWxsRGVlcChcIi5tY3FfX2l0ZW0tdGV4dC1pbm5lclwiLCBzaGFkb3dSb290KTtcclxuICBjb25zdCBvcHRpb25zOiBRdWVzdGlvbk9wdGlvbltdID0gW107XHJcbiAgb3B0aW9uRWxzLmZvckVhY2goKG9wdEVsLCBvcHRJbmRleCkgPT4ge1xyXG4gICAgY29uc3Qgb3B0VGV4dCA9IG9wdEVsLnRleHRDb250ZW50Py50cmltKCkgfHwgXCJcIjtcclxuICAgIGlmIChvcHRUZXh0ICYmIG9wdFRleHQubGVuZ3RoID4gMCkge1xyXG4gICAgICBvcHRpb25zLnB1c2goe1xyXG4gICAgICAgIGxldHRlcjogU3RyaW5nLmZyb21DaGFyQ29kZSg2NSArIG9wdEluZGV4KSxcclxuICAgICAgICB0ZXh0OiBvcHRUZXh0LFxyXG4gICAgICB9KTtcclxuICAgIH1cclxuICB9KTtcclxuXHJcbiAgaWYgKG9wdGlvbnMubGVuZ3RoIDwgMikgcmV0dXJuIG51bGw7XHJcblxyXG4gIHJldHVybiB7XHJcbiAgICBpZDogYG1jcS0ke3F1ZXN0aW9uTnVtYmVyfWAsXHJcbiAgICB0eXBlOiBcIm11bHRpcGxlLWNob2ljZVwiLFxyXG4gICAgcXVlc3Rpb25OdW1iZXI6IHF1ZXN0aW9uTnVtYmVyLFxyXG4gICAgdGV4dDogcXVlc3Rpb25UZXh0IHx8IGBQcmVndW50YSAke3F1ZXN0aW9uTnVtYmVyIHx8IFwiP1wifWAsXHJcbiAgICBvcHRpb25zOiBvcHRpb25zLFxyXG4gICAgZWxlbWVudDogbWNxVmlldyxcclxuICAgIGNvbmZpZGVuY2U6IDk1LFxyXG4gIH07XHJcbn1cclxuIiwgIi8qKlxyXG4gKiBTdHVkeSBBc3Npc3QgLSBVSSBNb2R1bGVcclxuICogSGFuZGxlcyBvdmVybGF5LCBxdWljayBidXR0b24sIGhpZ2hsaWdodGluZywgYW5kIGRpc3BsYXkgZnVuY3Rpb25zXHJcbiAqL1xyXG5cclxuaW1wb3J0IHR5cGUgeyBEZXRlY3RlZFF1ZXN0aW9uLCBVSUNhbGxiYWNrcyB9IGZyb20gXCIuLi8uLi90eXBlcy9pbmRleC5qc1wiO1xyXG5pbXBvcnQgeyBsb2csIHN0YXRlIH0gZnJvbSBcIi4vc3RhdGUuanNcIjtcclxuaW1wb3J0IHtcclxuICBlc2NhcGVIdG1sLFxyXG4gIGZvcm1hdFF1ZXN0aW9uVHlwZSxcclxuICB0cnVuY2F0ZVRleHQsXHJcbiAgZm9ybWF0QW5hbHlzaXNSZXN1bHQsXHJcbiAgZ2V0VmlzaWJpbGl0eVNjb3JlLFxyXG59IGZyb20gXCIuL3V0aWxzLmpzXCI7XHJcblxyXG4vLyA9PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PVxyXG4vLyBSZWxvYWQgUHJvbXB0XHJcbi8vID09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09XHJcblxyXG4vKipcclxuICogU2hvdyBhIHByb21wdCBhc2tpbmcgdXNlciB0byByZWxvYWQgdGhlIHBhZ2VcclxuICovXHJcbmV4cG9ydCBmdW5jdGlvbiBzaG93UmVsb2FkUHJvbXB0KCk6IHZvaWQge1xyXG4gIC8vIE9ubHkgc2hvdyBpbiBtYWluIGZyYW1lLCBub3QgaWZyYW1lc1xyXG4gIGlmICh3aW5kb3cuc2VsZiAhPT0gd2luZG93LnRvcCkgcmV0dXJuO1xyXG5cclxuICAvLyBSZW1vdmUgZXhpc3RpbmcgcHJvbXB0IGlmIGFueVxyXG4gIGNvbnN0IGV4aXN0aW5nID0gZG9jdW1lbnQuZ2V0RWxlbWVudEJ5SWQoXCJzdHVkeS1hc3Npc3QtcmVsb2FkLXByb21wdFwiKTtcclxuICBpZiAoZXhpc3RpbmcpIGV4aXN0aW5nLnJlbW92ZSgpO1xyXG5cclxuICBjb25zdCBwcm9tcHQgPSBkb2N1bWVudC5jcmVhdGVFbGVtZW50KFwiZGl2XCIpO1xyXG4gIHByb21wdC5pZCA9IFwic3R1ZHktYXNzaXN0LXJlbG9hZC1wcm9tcHRcIjtcclxuICBwcm9tcHQuaW5uZXJIVE1MID0gYFxyXG4gICAgPGRpdiBzdHlsZT1cIlxyXG4gICAgICBwb3NpdGlvbjogZml4ZWQ7XHJcbiAgICAgIGJvdHRvbTogMjBweDtcclxuICAgICAgcmlnaHQ6IDIwcHg7XHJcbiAgICAgIGJhY2tncm91bmQ6ICMzMzM7XHJcbiAgICAgIGNvbG9yOiAjZmZmO1xyXG4gICAgICBwYWRkaW5nOiAxNnB4IDIwcHg7XHJcbiAgICAgIGJvcmRlci1yYWRpdXM6IDhweDtcclxuICAgICAgYm94LXNoYWRvdzogMCA0cHggMTJweCByZ2JhKDAsMCwwLDAuMyk7XHJcbiAgICAgIHotaW5kZXg6IDk5OTk5OTtcclxuICAgICAgZm9udC1mYW1pbHk6ICdTZWdvZSBVSScsIFJvYm90bywgQXJpYWwsIHNhbnMtc2VyaWY7XHJcbiAgICAgIGZvbnQtc2l6ZTogMTRweDtcclxuICAgICAgZGlzcGxheTogZmxleDtcclxuICAgICAgYWxpZ24taXRlbXM6IGNlbnRlcjtcclxuICAgICAgZ2FwOiAxMnB4O1xyXG4gICAgICBhbmltYXRpb246IHNsaWRlSW4gMC4zcyBlYXNlO1xyXG4gICAgXCI+XHJcbiAgICAgIDxzcGFuPlx1RDgzRFx1RENEQSBTdHVkeSBBc3Npc3QgYWN0aXZhZG8uIFJlY2FyZ2EgcGFyYSBoYWJpbGl0YXJsby48L3NwYW4+XHJcbiAgICAgIDxidXR0b24gaWQ9XCJzdHVkeS1hc3Npc3QtcmVsb2FkLWJ0blwiIHN0eWxlPVwiXHJcbiAgICAgICAgYmFja2dyb3VuZDogIzQyODVmNDtcclxuICAgICAgICBjb2xvcjogd2hpdGU7XHJcbiAgICAgICAgYm9yZGVyOiBub25lO1xyXG4gICAgICAgIHBhZGRpbmc6IDhweCAxNnB4O1xyXG4gICAgICAgIGJvcmRlci1yYWRpdXM6IDRweDtcclxuICAgICAgICBjdXJzb3I6IHBvaW50ZXI7XHJcbiAgICAgICAgZm9udC13ZWlnaHQ6IDYwMDtcclxuICAgICAgICBmb250LXNpemU6IDEzcHg7XHJcbiAgICAgIFwiPlJlY2FyZ2FyPC9idXR0b24+XHJcbiAgICAgIDxidXR0b24gaWQ9XCJzdHVkeS1hc3Npc3QtZGlzbWlzcy1idG5cIiBzdHlsZT1cIlxyXG4gICAgICAgIGJhY2tncm91bmQ6IHRyYW5zcGFyZW50O1xyXG4gICAgICAgIGNvbG9yOiAjOTk5O1xyXG4gICAgICAgIGJvcmRlcjogbm9uZTtcclxuICAgICAgICBwYWRkaW5nOiA0cHggOHB4O1xyXG4gICAgICAgIGN1cnNvcjogcG9pbnRlcjtcclxuICAgICAgICBmb250LXNpemU6IDE2cHg7XHJcbiAgICAgIFwiPlx1MjcxNTwvYnV0dG9uPlxyXG4gICAgPC9kaXY+XHJcbiAgICA8c3R5bGU+XHJcbiAgICAgIEBrZXlmcmFtZXMgc2xpZGVJbiB7XHJcbiAgICAgICAgZnJvbSB7IHRyYW5zZm9ybTogdHJhbnNsYXRlWCgxMDAlKTsgb3BhY2l0eTogMDsgfVxyXG4gICAgICAgIHRvIHsgdHJhbnNmb3JtOiB0cmFuc2xhdGVYKDApOyBvcGFjaXR5OiAxOyB9XHJcbiAgICAgIH1cclxuICAgIDwvc3R5bGU+XHJcbiAgYDtcclxuXHJcbiAgZG9jdW1lbnQuYm9keS5hcHBlbmRDaGlsZChwcm9tcHQpO1xyXG5cclxuICBjb25zdCByZWxvYWRCdG4gPSBkb2N1bWVudC5nZXRFbGVtZW50QnlJZChcInN0dWR5LWFzc2lzdC1yZWxvYWQtYnRuXCIpIGFzIEhUTUxCdXR0b25FbGVtZW50IHwgbnVsbDtcclxuICBpZiAocmVsb2FkQnRuKSB7XHJcbiAgICByZWxvYWRCdG4ub25jbGljayA9ICgpOiB2b2lkID0+IHtcclxuICAgICAgd2luZG93LmxvY2F0aW9uLnJlbG9hZCgpO1xyXG4gICAgfTtcclxuICB9XHJcblxyXG4gIGNvbnN0IGRpc21pc3NCdG4gPSBkb2N1bWVudC5nZXRFbGVtZW50QnlJZChcInN0dWR5LWFzc2lzdC1kaXNtaXNzLWJ0blwiKSBhcyBIVE1MQnV0dG9uRWxlbWVudCB8IG51bGw7XHJcbiAgaWYgKGRpc21pc3NCdG4pIHtcclxuICAgIGRpc21pc3NCdG4ub25jbGljayA9ICgpOiB2b2lkID0+IHtcclxuICAgICAgcHJvbXB0LnJlbW92ZSgpO1xyXG4gICAgfTtcclxuICB9XHJcblxyXG4gIC8vIEF1dG8tZGlzbWlzcyBhZnRlciAxMCBzZWNvbmRzXHJcbiAgc2V0VGltZW91dCgoKTogdm9pZCA9PiB7XHJcbiAgICBpZiAoZG9jdW1lbnQuZ2V0RWxlbWVudEJ5SWQoXCJzdHVkeS1hc3Npc3QtcmVsb2FkLXByb21wdFwiKSkge1xyXG4gICAgICBwcm9tcHQucmVtb3ZlKCk7XHJcbiAgICB9XHJcbiAgfSwgMTAwMDApO1xyXG59XHJcblxyXG4vLyA9PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PVxyXG4vLyBPdmVybGF5ICYgQ29udGFpbmVyXHJcbi8vID09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09XHJcblxyXG4vKipcclxuICogQ3JlYXRlIHRoZSBvdmVybGF5IGNvbnRhaW5lciAocXVpY2sgbW9kZSBvciBmdWxsIG92ZXJsYXkpXHJcbiAqIEBwYXJhbSBjYWxsYmFja3MgLSBVSSBjYWxsYmFja3MgZm9yIHF1aXogY29udGVudCBkZXRlY3Rpb24gYW5kIGhhbmRsaW5nXHJcbiAqL1xyXG5leHBvcnQgZnVuY3Rpb24gY3JlYXRlT3ZlcmxheUNvbnRhaW5lcihjYWxsYmFja3M6IFVJQ2FsbGJhY2tzKTogdm9pZCB7XHJcbiAgY29uc3QgeyBmcmFtZUhhc1F1aXpDb250ZW50LCB3YWl0Rm9yUXVpekNvbnRlbnQsIGhhbmRsZVF1aWNrQ2xpY2sgfSA9IGNhbGxiYWNrcztcclxuXHJcbiAgLy8gUmVtb3ZlIGV4aXN0aW5nIG92ZXJsYXlzXHJcbiAgY29uc3QgZXhpc3RpbmcgPSBkb2N1bWVudC5nZXRFbGVtZW50QnlJZChcInN0dWR5LWFzc2lzdC1vdmVybGF5XCIpO1xyXG4gIGlmIChleGlzdGluZykgZXhpc3RpbmcucmVtb3ZlKCk7XHJcbiAgY29uc3QgZXhpc3RpbmdRdWljayA9IGRvY3VtZW50LmdldEVsZW1lbnRCeUlkKFwic3R1ZHktYXNzaXN0LXF1aWNrLWNvbnRhaW5lclwiKTtcclxuICBpZiAoZXhpc3RpbmdRdWljaykgZXhpc3RpbmdRdWljay5yZW1vdmUoKTtcclxuICBjb25zdCBleGlzdGluZ1F1aWNrQnRuID0gZG9jdW1lbnQuZ2V0RWxlbWVudEJ5SWQoXCJzdHVkeS1hc3Npc3QtcXVpY2tcIik7XHJcbiAgaWYgKGV4aXN0aW5nUXVpY2tCdG4pIGV4aXN0aW5nUXVpY2tCdG4ucmVtb3ZlKCk7XHJcblxyXG4gIGlmIChzdGF0ZS5zZXR0aW5ncy5xdWlja01vZGUpIHtcclxuICAgIC8vIE9ubHkgY3JlYXRlIHF1aWNrIGJ1dHRvbiBpbiBmcmFtZSB3aXRoIHF1aXogY29udGVudFxyXG4gICAgLy8gQ2hlY2sgaW1tZWRpYXRlbHkgZmlyc3QsIHRoZW4gd2FpdCBmb3IgY29udGVudCB0byBsb2FkXHJcbiAgICBpZiAoZnJhbWVIYXNRdWl6Q29udGVudCAmJiBmcmFtZUhhc1F1aXpDb250ZW50KCkpIHtcclxuICAgICAgY3JlYXRlUXVpY2tCdXR0b24oeyBoYW5kbGVRdWlja0NsaWNrIH0pO1xyXG4gICAgfSBlbHNlIGlmICh3YWl0Rm9yUXVpekNvbnRlbnQpIHtcclxuICAgICAgLy8gV2FpdCBmb3IgY29udGVudCB0byBsb2FkLCB0aGVuIGNyZWF0ZSBidXR0b25cclxuICAgICAgd2FpdEZvclF1aXpDb250ZW50KChoYXNDb250ZW50OiBib29sZWFuKTogdm9pZCA9PiB7XHJcbiAgICAgICAgaWYgKGhhc0NvbnRlbnQpIHtcclxuICAgICAgICAgIGNyZWF0ZVF1aWNrQnV0dG9uKHsgaGFuZGxlUXVpY2tDbGljayB9KTtcclxuICAgICAgICB9XHJcbiAgICAgIH0pO1xyXG4gICAgfVxyXG4gIH0gZWxzZSB7XHJcbiAgICAvLyBGdWxsIG92ZXJsYXkgY2FuIGJlIHNob3duIGluIGFueSBmcmFtZVxyXG4gICAgY3JlYXRlRnVsbE92ZXJsYXkoY2FsbGJhY2tzLnNob3dRdWVzdGlvbnNTdW1tYXJ5KTtcclxuICB9XHJcbn1cclxuXHJcbi8qKlxyXG4gKiBDcmVhdGUgdGhlIGZ1bGwgb3ZlcmxheSBVSVxyXG4gKiBAcGFyYW0gcmVmcmVzaEN1cnJlbnRRdWVzdGlvbkNhbGxiYWNrIC0gT3B0aW9uYWwgY2FsbGJhY2sgZm9yIHJlZnJlc2ggYnV0dG9uXHJcbiAqL1xyXG5leHBvcnQgZnVuY3Rpb24gY3JlYXRlRnVsbE92ZXJsYXkocmVmcmVzaEN1cnJlbnRRdWVzdGlvbkNhbGxiYWNrPzogKCkgPT4gUHJvbWlzZTx2b2lkPik6IHZvaWQge1xyXG4gIGNvbnN0IG92ZXJsYXkgPSBkb2N1bWVudC5jcmVhdGVFbGVtZW50KFwiZGl2XCIpO1xyXG4gIG92ZXJsYXkuaWQgPSBcInN0dWR5LWFzc2lzdC1vdmVybGF5XCI7XHJcbiAgb3ZlcmxheS5pbm5lckhUTUwgPSBgXHJcbiAgICA8ZGl2IGNsYXNzPVwic3R1ZHktYXNzaXN0LWhlYWRlclwiPlxyXG4gICAgICA8c3BhbiBjbGFzcz1cInN0dWR5LWFzc2lzdC1sb2dvXCI+U0E8L3NwYW4+XHJcbiAgICAgIDxkaXYgY2xhc3M9XCJzdHVkeS1hc3Npc3QtY29udHJvbHNcIj5cclxuICAgICAgICA8YnV0dG9uIGNsYXNzPVwic3R1ZHktYXNzaXN0LXJlZnJlc2hcIiB0aXRsZT1cIlZvbHZlciBhIGRldGVjdGFyIHByZWd1bnRhXCI+XHUyMUJCPC9idXR0b24+XHJcbiAgICAgICAgPGJ1dHRvbiBjbGFzcz1cInN0dWR5LWFzc2lzdC1taW5pbWl6ZVwiIHRpdGxlPVwiTWluaW1pemFyXCI+XHUyMjEyPC9idXR0b24+XHJcbiAgICAgICAgPGJ1dHRvbiBjbGFzcz1cInN0dWR5LWFzc2lzdC1jbG9zZVwiIHRpdGxlPVwiQ2VycmFyXCI+XHUwMEQ3PC9idXR0b24+XHJcbiAgICAgIDwvZGl2PlxyXG4gICAgPC9kaXY+XHJcbiAgICA8ZGl2IGNsYXNzPVwic3R1ZHktYXNzaXN0LWNvbnRlbnRcIj5cclxuICAgICAgPGRpdiBjbGFzcz1cInN0dWR5LWFzc2lzdC1sb2FkaW5nXCIgc3R5bGU9XCJkaXNwbGF5OiBub25lO1wiPlxyXG4gICAgICAgIDxkaXYgY2xhc3M9XCJzdHVkeS1hc3Npc3Qtc3Bpbm5lclwiPjwvZGl2PlxyXG4gICAgICAgIDxzcGFuPkFuYWxpemFuZG8uLi48L3NwYW4+XHJcbiAgICAgIDwvZGl2PlxyXG4gICAgICA8ZGl2IGNsYXNzPVwic3R1ZHktYXNzaXN0LXJlc3VsdHNcIj48L2Rpdj5cclxuICAgIDwvZGl2PlxyXG4gIGA7XHJcblxyXG4gIGRvY3VtZW50LmJvZHkuYXBwZW5kQ2hpbGQob3ZlcmxheSk7XHJcblxyXG4gIC8vIFNldHVwIG92ZXJsYXkgY29udHJvbHNcclxuICBjb25zdCBjbG9zZUJ0biA9IG92ZXJsYXkucXVlcnlTZWxlY3RvcihcIi5zdHVkeS1hc3Npc3QtY2xvc2VcIikgYXMgSFRNTEJ1dHRvbkVsZW1lbnQgfCBudWxsO1xyXG4gIGlmIChjbG9zZUJ0bikge1xyXG4gICAgY2xvc2VCdG4uYWRkRXZlbnRMaXN0ZW5lcihcImNsaWNrXCIsIGhpZGVPdmVybGF5KTtcclxuICB9XHJcblxyXG4gIGNvbnN0IG1pbmltaXplQnRuID0gb3ZlcmxheS5xdWVyeVNlbGVjdG9yKFwiLnN0dWR5LWFzc2lzdC1taW5pbWl6ZVwiKSBhcyBIVE1MQnV0dG9uRWxlbWVudCB8IG51bGw7XHJcbiAgaWYgKG1pbmltaXplQnRuKSB7XHJcbiAgICBtaW5pbWl6ZUJ0bi5hZGRFdmVudExpc3RlbmVyKFwiY2xpY2tcIiwgdG9nZ2xlTWluaW1pemUpO1xyXG4gIH1cclxuXHJcbiAgaWYgKHJlZnJlc2hDdXJyZW50UXVlc3Rpb25DYWxsYmFjaykge1xyXG4gICAgY29uc3QgcmVmcmVzaEJ0biA9IG92ZXJsYXkucXVlcnlTZWxlY3RvcihcIi5zdHVkeS1hc3Npc3QtcmVmcmVzaFwiKSBhcyBIVE1MQnV0dG9uRWxlbWVudCB8IG51bGw7XHJcbiAgICBpZiAocmVmcmVzaEJ0bikge1xyXG4gICAgICByZWZyZXNoQnRuLmFkZEV2ZW50TGlzdGVuZXIoXCJjbGlja1wiLCByZWZyZXNoQ3VycmVudFF1ZXN0aW9uQ2FsbGJhY2spO1xyXG4gICAgfVxyXG4gIH1cclxuXHJcbiAgLy8gTWFrZSBkcmFnZ2FibGVcclxuICBtYWtlRHJhZ2dhYmxlKG92ZXJsYXkpO1xyXG59XHJcblxyXG4vKipcclxuICogU2hvdyB0aGUgb3ZlcmxheVxyXG4gKi9cclxuZXhwb3J0IGZ1bmN0aW9uIHNob3dPdmVybGF5KCk6IHZvaWQge1xyXG4gIGNvbnN0IG92ZXJsYXkgPSBkb2N1bWVudC5nZXRFbGVtZW50QnlJZChcInN0dWR5LWFzc2lzdC1vdmVybGF5XCIpIGFzIEhUTUxEaXZFbGVtZW50IHwgbnVsbDtcclxuICBpZiAob3ZlcmxheSkge1xyXG4gICAgb3ZlcmxheS5jbGFzc0xpc3QuYWRkKFwic3R1ZHktYXNzaXN0LXZpc2libGVcIik7XHJcbiAgICBzdGF0ZS5vdmVybGF5VmlzaWJsZSA9IHRydWU7XHJcbiAgfVxyXG59XHJcblxyXG4vKipcclxuICogSGlkZSB0aGUgb3ZlcmxheVxyXG4gKi9cclxuZXhwb3J0IGZ1bmN0aW9uIGhpZGVPdmVybGF5KCk6IHZvaWQge1xyXG4gIGNvbnN0IG92ZXJsYXkgPSBkb2N1bWVudC5nZXRFbGVtZW50QnlJZChcInN0dWR5LWFzc2lzdC1vdmVybGF5XCIpIGFzIEhUTUxEaXZFbGVtZW50IHwgbnVsbDtcclxuICBpZiAob3ZlcmxheSkge1xyXG4gICAgb3ZlcmxheS5jbGFzc0xpc3QucmVtb3ZlKFwic3R1ZHktYXNzaXN0LXZpc2libGVcIik7XHJcbiAgICBzdGF0ZS5vdmVybGF5VmlzaWJsZSA9IGZhbHNlO1xyXG4gIH1cclxufVxyXG5cclxuLyoqXHJcbiAqIFRvZ2dsZSBtaW5pbWl6ZWQgc3RhdGUgb2Ygb3ZlcmxheVxyXG4gKi9cclxuZXhwb3J0IGZ1bmN0aW9uIHRvZ2dsZU1pbmltaXplKCk6IHZvaWQge1xyXG4gIGNvbnN0IG92ZXJsYXkgPSBkb2N1bWVudC5nZXRFbGVtZW50QnlJZChcInN0dWR5LWFzc2lzdC1vdmVybGF5XCIpIGFzIEhUTUxEaXZFbGVtZW50IHwgbnVsbDtcclxuICBpZiAob3ZlcmxheSkge1xyXG4gICAgb3ZlcmxheS5jbGFzc0xpc3QudG9nZ2xlKFwic3R1ZHktYXNzaXN0LW1pbmltaXplZFwiKTtcclxuICB9XHJcbn1cclxuXHJcbi8qKlxyXG4gKiBNYWtlIGFuIGVsZW1lbnQgZHJhZ2dhYmxlIGJ5IGl0cyBoZWFkZXJcclxuICogQHBhcmFtIGVsZW1lbnQgLSBUaGUgZWxlbWVudCB0byBtYWtlIGRyYWdnYWJsZVxyXG4gKi9cclxuZXhwb3J0IGZ1bmN0aW9uIG1ha2VEcmFnZ2FibGUoZWxlbWVudDogSFRNTEVsZW1lbnQpOiB2b2lkIHtcclxuICBjb25zdCBoZWFkZXIgPSBlbGVtZW50LnF1ZXJ5U2VsZWN0b3IoXCIuc3R1ZHktYXNzaXN0LWhlYWRlclwiKSBhcyBIVE1MRWxlbWVudCB8IG51bGw7XHJcbiAgaWYgKCFoZWFkZXIpIHJldHVybjtcclxuXHJcbiAgbGV0IGlzRHJhZ2dpbmcgPSBmYWxzZTtcclxuICBsZXQgY3VycmVudFg6IG51bWJlcjtcclxuICBsZXQgY3VycmVudFk6IG51bWJlcjtcclxuICBsZXQgaW5pdGlhbFg6IG51bWJlcjtcclxuICBsZXQgaW5pdGlhbFk6IG51bWJlcjtcclxuXHJcbiAgaGVhZGVyLmFkZEV2ZW50TGlzdGVuZXIoXCJtb3VzZWRvd25cIiwgKGU6IE1vdXNlRXZlbnQpOiB2b2lkID0+IHtcclxuICAgIGNvbnN0IHRhcmdldCA9IGUudGFyZ2V0IGFzIEhUTUxFbGVtZW50O1xyXG4gICAgaWYgKHRhcmdldC50YWdOYW1lID09PSBcIkJVVFRPTlwiKSByZXR1cm47XHJcbiAgICBpc0RyYWdnaW5nID0gdHJ1ZTtcclxuICAgIGluaXRpYWxYID0gZS5jbGllbnRYIC0gKGVsZW1lbnQub2Zmc2V0TGVmdCB8fCAwKTtcclxuICAgIGluaXRpYWxZID0gZS5jbGllbnRZIC0gKGVsZW1lbnQub2Zmc2V0VG9wIHx8IDApO1xyXG4gIH0pO1xyXG5cclxuICBkb2N1bWVudC5hZGRFdmVudExpc3RlbmVyKFwibW91c2Vtb3ZlXCIsIChlOiBNb3VzZUV2ZW50KTogdm9pZCA9PiB7XHJcbiAgICBpZiAoIWlzRHJhZ2dpbmcpIHJldHVybjtcclxuICAgIGUucHJldmVudERlZmF1bHQoKTtcclxuICAgIGN1cnJlbnRYID0gZS5jbGllbnRYIC0gaW5pdGlhbFg7XHJcbiAgICBjdXJyZW50WSA9IGUuY2xpZW50WSAtIGluaXRpYWxZO1xyXG4gICAgZWxlbWVudC5zdHlsZS5sZWZ0ID0gYCR7Y3VycmVudFh9cHhgO1xyXG4gICAgZWxlbWVudC5zdHlsZS50b3AgPSBgJHtjdXJyZW50WX1weGA7XHJcbiAgICBlbGVtZW50LnN0eWxlLnJpZ2h0ID0gXCJhdXRvXCI7XHJcbiAgICBlbGVtZW50LnN0eWxlLmJvdHRvbSA9IFwiYXV0b1wiO1xyXG4gIH0pO1xyXG5cclxuICBkb2N1bWVudC5hZGRFdmVudExpc3RlbmVyKFwibW91c2V1cFwiLCAoKTogdm9pZCA9PiB7XHJcbiAgICBpc0RyYWdnaW5nID0gZmFsc2U7XHJcbiAgfSk7XHJcbn1cclxuXHJcbi8vID09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09XHJcbi8vIFF1aWNrIEJ1dHRvblxyXG4vLyA9PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PVxyXG5cclxuLyoqXHJcbiAqIFRvZ2dsZSBTQSBidXR0b24gdmlzaWJpbGl0eVxyXG4gKiBDYWxsZWQgd2hlbiBwcmVzc2luZyBBTFQrUVxyXG4gKi9cclxuZXhwb3J0IGZ1bmN0aW9uIHRvZ2dsZVNBQnV0dG9uVmlzaWJpbGl0eSgpOiB2b2lkIHtcclxuICBsb2coXCJbU3R1ZHkgQXNzaXN0XSBBTFQrUSBwcmVzc2VkIC0gdG9nZ2xpbmcgU0EgYnV0dG9uIHZpc2liaWxpdHlcIik7XHJcbiAgY29uc3QgY29udGFpbmVyID0gZG9jdW1lbnQuZ2V0RWxlbWVudEJ5SWQoXCJzdHVkeS1hc3Npc3QtcXVpY2stY29udGFpbmVyXCIpIGFzIEhUTUxEaXZFbGVtZW50IHwgbnVsbDtcclxuXHJcbiAgaWYgKGNvbnRhaW5lcikge1xyXG4gICAgY29uc3QgaXNIaWRkZW4gPSBjb250YWluZXIuc3R5bGUuZGlzcGxheSA9PT0gXCJub25lXCI7XHJcbiAgICBjb250YWluZXIuc3R5bGUuZGlzcGxheSA9IGlzSGlkZGVuID8gXCJcIiA6IFwibm9uZVwiO1xyXG4gICAgbG9nKGBbU3R1ZHkgQXNzaXN0XSBTQSBidXR0b24gJHtpc0hpZGRlbiA/IFwic2hvd25cIiA6IFwiaGlkZGVuXCJ9YCk7XHJcbiAgfSBlbHNlIHtcclxuICAgIGxvZyhcIltTdHVkeSBBc3Npc3RdIFNBIGJ1dHRvbiBjb250YWluZXIgbm90IGZvdW5kXCIpO1xyXG4gIH1cclxufVxyXG5cclxuLyoqXHJcbiAqIFJlc2V0IHRoZSBxdWljayBhbnN3ZXIgYnV0dG9uIHRvIGRlZmF1bHQgc3RhdGVcclxuICovXHJcbmV4cG9ydCBmdW5jdGlvbiByZXNldFF1aWNrQW5zd2VyKCk6IHZvaWQge1xyXG4gIGNvbnN0IHF1aWNrQnRuID0gZG9jdW1lbnQuZ2V0RWxlbWVudEJ5SWQoXCJzdHVkeS1hc3Npc3QtcXVpY2tcIikgYXMgSFRNTERpdkVsZW1lbnQgfCBudWxsO1xyXG4gIGNvbnN0IGNvbnRhaW5lciA9IGRvY3VtZW50LmdldEVsZW1lbnRCeUlkKFwic3R1ZHktYXNzaXN0LXF1aWNrLWNvbnRhaW5lclwiKSBhcyBIVE1MRGl2RWxlbWVudCB8IG51bGw7XHJcblxyXG4gIGlmIChxdWlja0J0bikge1xyXG4gICAgcXVpY2tCdG4uaW5uZXJIVE1MID0gYDxzcGFuPlNBPC9zcGFuPmA7XHJcbiAgICBxdWlja0J0bi5jbGFzc0xpc3QucmVtb3ZlKFxyXG4gICAgICBcImhhcy1hbnN3ZXJcIixcclxuICAgICAgXCJtYXRjaGluZy1hbnN3ZXJcIixcclxuICAgICAgXCJtdWx0aS1hbnN3ZXJcIixcclxuICAgICAgXCJtdWx0aS1hbnN3ZXItbGFyZ2VcIixcclxuICAgICk7XHJcbiAgfVxyXG4gIGlmIChjb250YWluZXIpIHtcclxuICAgIGNvbnRhaW5lci5jbGFzc0xpc3QucmVtb3ZlKFwibWF0Y2hpbmctbW9kZVwiKTtcclxuICB9XHJcblxyXG4gIHN0YXRlLmxhc3RBbnN3ZXJlZFF1ZXN0aW9uTnVtID0gbnVsbDtcclxuICBzdGF0ZS5oYXNWYWxpZEFuc3dlciA9IGZhbHNlOyAvLyBBbGxvdyBuZXcgcmVxdWVzdHMgYWZ0ZXIgcmVzZXRcclxufVxyXG5cclxuLyoqXHJcbiAqIENhbGxiYWNrcyBmb3IgcXVpY2sgYnV0dG9uIGNyZWF0aW9uXHJcbiAqL1xyXG5pbnRlcmZhY2UgUXVpY2tCdXR0b25DYWxsYmFja3Mge1xyXG4gIGhhbmRsZVF1aWNrQ2xpY2s/OiAoZTogTW91c2VFdmVudCkgPT4gdm9pZDtcclxufVxyXG5cclxuLyoqXHJcbiAqIENyZWF0ZSB0aGUgcXVpY2sgYnV0dG9uIGZvciBxdWljayBtb2RlXHJcbiAqIEBwYXJhbSBjYWxsYmFja3MgLSBPYmplY3QgY29udGFpbmluZyBjbGljayBoYW5kbGVyXHJcbiAqL1xyXG5leHBvcnQgZnVuY3Rpb24gY3JlYXRlUXVpY2tCdXR0b24oY2FsbGJhY2tzOiBRdWlja0J1dHRvbkNhbGxiYWNrcyk6IHZvaWQge1xyXG4gIGNvbnN0IHsgaGFuZGxlUXVpY2tDbGljayB9ID0gY2FsbGJhY2tzO1xyXG5cclxuICAvLyBDcmVhdGUgY29udGFpbmVyIGZvciBidXR0b25cclxuICBjb25zdCBjb250YWluZXIgPSBkb2N1bWVudC5jcmVhdGVFbGVtZW50KFwiZGl2XCIpO1xyXG4gIGNvbnRhaW5lci5pZCA9IFwic3R1ZHktYXNzaXN0LXF1aWNrLWNvbnRhaW5lclwiO1xyXG5cclxuICAvLyBBcHBseSBidXR0b24gcG9zaXRpb24gZnJvbSBzZXR0aW5nc1xyXG4gIGNvbnN0IHBvcyA9IHN0YXRlLnNldHRpbmdzLmJ1dHRvblBvc2l0aW9uIHx8IFwiYm90dG9tLXJpZ2h0XCI7XHJcbiAgY29udGFpbmVyLnNldEF0dHJpYnV0ZShcImRhdGEtcG9zaXRpb25cIiwgcG9zKTtcclxuXHJcbiAgLy8gQ3JlYXRlIG1haW4gcXVpY2sgYnV0dG9uXHJcbiAgY29uc3QgcXVpY2tCdG4gPSBkb2N1bWVudC5jcmVhdGVFbGVtZW50KFwiZGl2XCIpO1xyXG4gIHF1aWNrQnRuLmlkID0gXCJzdHVkeS1hc3Npc3QtcXVpY2tcIjtcclxuICBxdWlja0J0bi5pbm5lckhUTUwgPSBgPHNwYW4+U0E8L3NwYW4+YDtcclxuICBxdWlja0J0bi50aXRsZSA9XHJcbiAgICBcIkNsaWMgcGFyYSBvYnRlbmVyIHJlc3B1ZXN0YSB8IFNISUZUOiBBbmFsaXphciB8IEFMVCtXOiBSZS1kZXRlY3RhciB8IEFMVCtROiBPY3VsdGFyIHwgQUxUK1g6IENhbmNlbGFyXCI7XHJcbiAgY29udGFpbmVyLmFwcGVuZENoaWxkKHF1aWNrQnRuKTtcclxuXHJcbiAgZG9jdW1lbnQuYm9keS5hcHBlbmRDaGlsZChjb250YWluZXIpO1xyXG5cclxuICBpZiAoaGFuZGxlUXVpY2tDbGljaykge1xyXG4gICAgcXVpY2tCdG4uYWRkRXZlbnRMaXN0ZW5lcihcImNsaWNrXCIsIGhhbmRsZVF1aWNrQ2xpY2spO1xyXG4gIH1cclxuXHJcbiAgLy8gU2V0dXAgQ3RybCB0b2dnbGUgZm9yIFdlYmV4IGJ1dHRvblxyXG4gIGluamVjdFdlYmV4VG9nZ2xlV2l0aEN0cmwoKTtcclxufVxyXG5cclxuLyoqXHJcbiAqIEluamVjdCBXZWJleCBidXR0b24gdG9nZ2xlIGZ1bmN0aW9uYWxpdHkgd2l0aCBDdHJsIGtleVxyXG4gKiBAcHJpdmF0ZVxyXG4gKi9cclxuZnVuY3Rpb24gaW5qZWN0V2ViZXhUb2dnbGVXaXRoQ3RybCgpOiB2b2lkIHtcclxuICAvLyBIb2xkIEN0cmwgdG8gaGlkZSBXZWJleCwgcmVsZWFzZSB0byBzaG93XHJcbiAgLy8gVXNlcyBwb3N0TWVzc2FnZSB0byBjb21tdW5pY2F0ZSBiZXR3ZWVuIGZyYW1lc1xyXG5cclxuICBjb25zdCBzdHlsZUlkID0gXCJzdHVkeS1hc3Npc3Qtd2ViZXgtaGlkZS1zdHlsZVwiO1xyXG4gIGNvbnN0IGlzTWFpbkZyYW1lID0gd2luZG93LnNlbGYgPT09IHdpbmRvdy50b3A7XHJcblxyXG4gIC8vIERvbid0IGluamVjdCB0d2ljZVxyXG4gIGlmIChkb2N1bWVudC5nZXRFbGVtZW50QnlJZChzdHlsZUlkKSkgcmV0dXJuO1xyXG5cclxuICBjb25zdCBzdHlsZSA9IGRvY3VtZW50LmNyZWF0ZUVsZW1lbnQoXCJzdHlsZVwiKTtcclxuICBzdHlsZS5pZCA9IHN0eWxlSWQ7XHJcbiAgc3R5bGUudGV4dENvbnRlbnQgPSBgXHJcbiAgICAvKiBDbGFzcyB0byBoaWRlIFdlYmV4IGJ1dHRvbiAqL1xyXG4gICAgLndlYmV4LWhpZGRlbi1ieS1zYSB7XHJcbiAgICAgIHZpc2liaWxpdHk6IGhpZGRlbiAhaW1wb3J0YW50O1xyXG4gICAgfVxyXG4gICAgLyogU2V0IFdlYmV4IGJ1dHRvbiBpY29uIHNpemUgKi9cclxuICAgIC5mYWJBY3Rpb25CdG5JY29uQ29udGFpbmVyLS1SUHJaSCBpbWcge1xyXG4gICAgICB3aWR0aDogNjVweCAhaW1wb3J0YW50O1xyXG4gICAgICBoZWlnaHQ6IDY1cHggIWltcG9ydGFudDtcclxuICAgIH1cclxuICBgO1xyXG4gIGRvY3VtZW50LmhlYWQuYXBwZW5kQ2hpbGQoc3R5bGUpO1xyXG5cclxuICAvLyBBcHBseSBpY29uIHNpemUgdG8gZXhpc3RpbmcgYnV0dG9uIGlmIHByZXNlbnRcclxuICBjb25zdCBleGlzdGluZ1dlYmV4QnRuID0gZG9jdW1lbnQucXVlcnlTZWxlY3RvcihcclxuICAgIFwiI3dlYmV4RmFiQWN0aW9uQnRuLCAuZmFiQWN0aW9uQnRuLS1XTkQ4WFwiLFxyXG4gICkgYXMgSFRNTEVsZW1lbnQgfCBudWxsO1xyXG4gIGlmIChleGlzdGluZ1dlYmV4QnRuKSB7XHJcbiAgICBhcHBseVdlYmV4SWNvblNpemUoZXhpc3RpbmdXZWJleEJ0bik7XHJcbiAgfVxyXG5cclxuICAvLyBPYnNlcnZlIGZvciBXZWJleCBidXR0b24gYXBwZWFyaW5nIGR5bmFtaWNhbGx5XHJcbiAgY29uc3Qgd2ViZXhPYnNlcnZlciA9IG5ldyBNdXRhdGlvbk9ic2VydmVyKChtdXRhdGlvbnM6IE11dGF0aW9uUmVjb3JkW10pOiB2b2lkID0+IHtcclxuICAgIG11dGF0aW9ucy5mb3JFYWNoKChtdXRhdGlvbjogTXV0YXRpb25SZWNvcmQpOiB2b2lkID0+IHtcclxuICAgICAgbXV0YXRpb24uYWRkZWROb2Rlcy5mb3JFYWNoKChub2RlOiBOb2RlKTogdm9pZCA9PiB7XHJcbiAgICAgICAgaWYgKG5vZGUubm9kZVR5cGUgPT09IE5vZGUuRUxFTUVOVF9OT0RFKSB7XHJcbiAgICAgICAgICBjb25zdCBlbGVtZW50ID0gbm9kZSBhcyBFbGVtZW50O1xyXG4gICAgICAgICAgLy8gQ2hlY2sgaWYgdGhlIGFkZGVkIG5vZGUgaXMgdGhlIFdlYmV4IGJ1dHRvblxyXG4gICAgICAgICAgaWYgKFxyXG4gICAgICAgICAgICBlbGVtZW50LmlkID09PSBcIndlYmV4RmFiQWN0aW9uQnRuXCIgfHxcclxuICAgICAgICAgICAgZWxlbWVudC5jbGFzc0xpc3QuY29udGFpbnMoXCJmYWJBY3Rpb25CdG4tLVdORDhYXCIpXHJcbiAgICAgICAgICApIHtcclxuICAgICAgICAgICAgYXBwbHlXZWJleEljb25TaXplKGVsZW1lbnQgYXMgSFRNTEVsZW1lbnQpO1xyXG4gICAgICAgICAgfVxyXG4gICAgICAgICAgLy8gQWxzbyBjaGVjayBkZXNjZW5kYW50c1xyXG4gICAgICAgICAgY29uc3Qgd2ViZXhCdG4gPSBlbGVtZW50LnF1ZXJ5U2VsZWN0b3I/LihcclxuICAgICAgICAgICAgXCIjd2ViZXhGYWJBY3Rpb25CdG4sIC5mYWJBY3Rpb25CdG4tLVdORDhYXCJcclxuICAgICAgICAgICkgYXMgSFRNTEVsZW1lbnQgfCBudWxsO1xyXG4gICAgICAgICAgaWYgKHdlYmV4QnRuKSB7XHJcbiAgICAgICAgICAgIGFwcGx5V2ViZXhJY29uU2l6ZSh3ZWJleEJ0bik7XHJcbiAgICAgICAgICB9XHJcbiAgICAgICAgfVxyXG4gICAgICB9KTtcclxuICAgIH0pO1xyXG4gIH0pO1xyXG5cclxuICB3ZWJleE9ic2VydmVyLm9ic2VydmUoZG9jdW1lbnQuYm9keSwge1xyXG4gICAgY2hpbGRMaXN0OiB0cnVlLFxyXG4gICAgc3VidHJlZTogdHJ1ZSxcclxuICB9KTtcclxuXHJcbiAgZnVuY3Rpb24gYXBwbHlXZWJleEljb25TaXplKHdlYmV4QnRuOiBIVE1MRWxlbWVudCB8IG51bGwpOiB2b2lkIHtcclxuICAgIGlmICghd2ViZXhCdG4pIHJldHVybjtcclxuICAgIGNvbnN0IHdlYmV4SW1nID0gd2ViZXhCdG4ucXVlcnlTZWxlY3RvcihcclxuICAgICAgXCIuZmFiQWN0aW9uQnRuSWNvbkNvbnRhaW5lci0tUlByWkggaW1nXCIsXHJcbiAgICApIGFzIEhUTUxJbWFnZUVsZW1lbnQgfCBudWxsO1xyXG4gICAgaWYgKHdlYmV4SW1nKSB7XHJcbiAgICAgIHdlYmV4SW1nLnN0eWxlLnNldFByb3BlcnR5KFwid2lkdGhcIiwgXCI1NXB4XCIsIFwiaW1wb3J0YW50XCIpO1xyXG4gICAgICB3ZWJleEltZy5zdHlsZS5zZXRQcm9wZXJ0eShcImhlaWdodFwiLCBcIjU1cHhcIiwgXCJpbXBvcnRhbnRcIik7XHJcbiAgICB9XHJcbiAgfVxyXG5cclxuICBmdW5jdGlvbiBoaWRlV2ViZXgoKTogdm9pZCB7XHJcbiAgICBjb25zdCB3ZWJleEJ0biA9IGRvY3VtZW50LnF1ZXJ5U2VsZWN0b3IoXHJcbiAgICAgIFwiI3dlYmV4RmFiQWN0aW9uQnRuLCAuZmFiQWN0aW9uQnRuLS1XTkQ4WFwiLFxyXG4gICAgKSBhcyBIVE1MRWxlbWVudCB8IG51bGw7XHJcbiAgICBpZiAod2ViZXhCdG4pIHtcclxuICAgICAgd2ViZXhCdG4uY2xhc3NMaXN0LmFkZChcIndlYmV4LWhpZGRlbi1ieS1zYVwiKTtcclxuICAgIH1cclxuICB9XHJcblxyXG4gIGZ1bmN0aW9uIHNob3dXZWJleCgpOiB2b2lkIHtcclxuICAgIGNvbnN0IHdlYmV4QnRuID0gZG9jdW1lbnQucXVlcnlTZWxlY3RvcihcclxuICAgICAgXCIjd2ViZXhGYWJBY3Rpb25CdG4sIC5mYWJBY3Rpb25CdG4tLVdORDhYXCIsXHJcbiAgICApIGFzIEhUTUxFbGVtZW50IHwgbnVsbDtcclxuICAgIGlmICh3ZWJleEJ0bikge1xyXG4gICAgICB3ZWJleEJ0bi5jbGFzc0xpc3QucmVtb3ZlKFwid2ViZXgtaGlkZGVuLWJ5LXNhXCIpO1xyXG4gICAgfVxyXG4gIH1cclxuXHJcbiAgLy8gTUFJTiBGUkFNRTogTGlzdGVuIGZvciBtZXNzYWdlcyBmcm9tIGlmcmFtZXNcclxuICBpZiAoaXNNYWluRnJhbWUpIHtcclxuICAgIHdpbmRvdy5hZGRFdmVudExpc3RlbmVyKFwibWVzc2FnZVwiLCAoZTogTWVzc2FnZUV2ZW50KTogdm9pZCA9PiB7XHJcbiAgICAgIGlmIChlLmRhdGEgPT09IFwic3R1ZHktYXNzaXN0LWhpZGUtd2ViZXhcIikge1xyXG4gICAgICAgIGhpZGVXZWJleCgpO1xyXG4gICAgICB9IGVsc2UgaWYgKGUuZGF0YSA9PT0gXCJzdHVkeS1hc3Npc3Qtc2hvdy13ZWJleFwiKSB7XHJcbiAgICAgICAgc2hvd1dlYmV4KCk7XHJcbiAgICAgIH1cclxuICAgIH0pO1xyXG4gIH1cclxuXHJcbiAgLy8gQUxMIEZSQU1FUzogTGlzdGVuIGZvciBDdHJsIGtleSBhbmQgc2VuZCBtZXNzYWdlIHRvIHBhcmVudFxyXG4gIGRvY3VtZW50LmFkZEV2ZW50TGlzdGVuZXIoXCJrZXlkb3duXCIsIChlOiBLZXlib2FyZEV2ZW50KTogdm9pZCA9PiB7XHJcbiAgICBpZiAoZS5rZXkgPT09IFwiQ29udHJvbFwiKSB7XHJcbiAgICAgIC8vIFRyeSBsb2NhbGx5IGZpcnN0XHJcbiAgICAgIGhpZGVXZWJleCgpO1xyXG4gICAgICAvLyBBbHNvIHNlbmQgdG8gcGFyZW50IGZyYW1lIChpbiBjYXNlIFdlYmV4IGlzIHRoZXJlKVxyXG4gICAgICBpZiAoIWlzTWFpbkZyYW1lKSB7XHJcbiAgICAgICAgdHJ5IHtcclxuICAgICAgICAgIHdpbmRvdy5wYXJlbnQucG9zdE1lc3NhZ2UoXCJzdHVkeS1hc3Npc3QtaGlkZS13ZWJleFwiLCBcIipcIik7XHJcbiAgICAgICAgfSBjYXRjaCAoZXJyKSB7XHJcbiAgICAgICAgICAvLyBJZ25vcmUgY3Jvc3Mtb3JpZ2luIGVycm9yc1xyXG4gICAgICAgIH1cclxuICAgICAgfVxyXG4gICAgfVxyXG4gIH0pO1xyXG5cclxuICBkb2N1bWVudC5hZGRFdmVudExpc3RlbmVyKFwia2V5dXBcIiwgKGU6IEtleWJvYXJkRXZlbnQpOiB2b2lkID0+IHtcclxuICAgIGlmIChlLmtleSA9PT0gXCJDb250cm9sXCIpIHtcclxuICAgICAgLy8gU2hvdyBXZWJleCB3aGVuIEN0cmwgaXMgcmVsZWFzZWRcclxuICAgICAgc2hvd1dlYmV4KCk7XHJcbiAgICAgIC8vIEFsc28gc2VuZCB0byBwYXJlbnQgZnJhbWVcclxuICAgICAgaWYgKCFpc01haW5GcmFtZSkge1xyXG4gICAgICAgIHRyeSB7XHJcbiAgICAgICAgICB3aW5kb3cucGFyZW50LnBvc3RNZXNzYWdlKFwic3R1ZHktYXNzaXN0LXNob3ctd2ViZXhcIiwgXCIqXCIpO1xyXG4gICAgICAgIH0gY2F0Y2ggKGVycikge1xyXG4gICAgICAgICAgLy8gSWdub3JlIGNyb3NzLW9yaWdpbiBlcnJvcnNcclxuICAgICAgICB9XHJcbiAgICAgIH1cclxuICAgIH1cclxuICB9KTtcclxufVxyXG5cclxuLy8gPT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT1cclxuLy8gUXVlc3Rpb24gSGlnaGxpZ2h0aW5nXHJcbi8vID09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09XHJcblxyXG4vKipcclxuICogSGlnaGxpZ2h0IGRldGVjdGVkIHF1ZXN0aW9ucyBvbiB0aGUgcGFnZVxyXG4gKiBAcGFyYW0gYW5hbHl6ZVF1ZXN0aW9uQ2FsbGJhY2sgLSBDYWxsYmFjayB0byBhbmFseXplIGEgcXVlc3Rpb24gd2hlbiBiYWRnZSBpcyBjbGlja2VkXHJcbiAqL1xyXG5leHBvcnQgZnVuY3Rpb24gaGlnaGxpZ2h0RGV0ZWN0ZWRRdWVzdGlvbnMoXHJcbiAgYW5hbHl6ZVF1ZXN0aW9uQ2FsbGJhY2s/OiAocXVlc3Rpb246IERldGVjdGVkUXVlc3Rpb24pID0+IFByb21pc2U8dm9pZD5cclxuKTogdm9pZCB7XHJcbiAgY2xlYXJBbGxIaWdobGlnaHRzKCk7XHJcblxyXG4gIHN0YXRlLmRldGVjdGVkUXVlc3Rpb25zLmZvckVhY2goKHF1ZXN0aW9uOiBEZXRlY3RlZFF1ZXN0aW9uLCBpbmRleDogbnVtYmVyKTogdm9pZCA9PiB7XHJcbiAgICBjb25zdCBlbGVtZW50ID0gcXVlc3Rpb24uZWxlbWVudCBhcyBIVE1MRWxlbWVudDtcclxuXHJcbiAgICAvLyBBZGQgaGlnaGxpZ2h0IGNsYXNzXHJcbiAgICBlbGVtZW50LmNsYXNzTGlzdC5hZGQoXCJzdHVkeS1hc3Npc3QtcXVlc3Rpb24taGlnaGxpZ2h0XCIpO1xyXG4gICAgZWxlbWVudC5kYXRhc2V0LnN0dWR5QXNzaXN0SWQgPSBxdWVzdGlvbi5pZDtcclxuXHJcbiAgICAvLyBBZGQgcXVlc3Rpb24gbnVtYmVyIGJhZGdlXHJcbiAgICBjb25zdCBiYWRnZSA9IGRvY3VtZW50LmNyZWF0ZUVsZW1lbnQoXCJkaXZcIik7XHJcbiAgICBiYWRnZS5jbGFzc05hbWUgPSBcInN0dWR5LWFzc2lzdC1xdWVzdGlvbi1iYWRnZVwiO1xyXG4gICAgYmFkZ2UudGV4dENvbnRlbnQgPSBTdHJpbmcoaW5kZXggKyAxKTtcclxuICAgIGJhZGdlLnRpdGxlID0gYFByZWd1bnRhICR7aW5kZXggKyAxfSAtIENsaWMgcGFyYSBhbmFsaXphcmA7XHJcbiAgICBiYWRnZS5hZGRFdmVudExpc3RlbmVyKFwiY2xpY2tcIiwgKGU6IE1vdXNlRXZlbnQpOiB2b2lkID0+IHtcclxuICAgICAgZS5zdG9wUHJvcGFnYXRpb24oKTtcclxuICAgICAgaWYgKGFuYWx5emVRdWVzdGlvbkNhbGxiYWNrKSB7XHJcbiAgICAgICAgYW5hbHl6ZVF1ZXN0aW9uQ2FsbGJhY2socXVlc3Rpb24pO1xyXG4gICAgICB9XHJcbiAgICB9KTtcclxuXHJcbiAgICAvLyBQb3NpdGlvbiBiYWRnZVxyXG4gICAgZWxlbWVudC5zdHlsZS5wb3NpdGlvbiA9IGVsZW1lbnQuc3R5bGUucG9zaXRpb24gfHwgXCJyZWxhdGl2ZVwiO1xyXG4gICAgZWxlbWVudC5hcHBlbmRDaGlsZChiYWRnZSk7XHJcbiAgfSk7XHJcbn1cclxuXHJcbi8qKlxyXG4gKiBDbGVhciBhbGwgcXVlc3Rpb24gaGlnaGxpZ2h0cyBmcm9tIHRoZSBwYWdlXHJcbiAqL1xyXG5leHBvcnQgZnVuY3Rpb24gY2xlYXJBbGxIaWdobGlnaHRzKCk6IHZvaWQge1xyXG4gIGRvY3VtZW50XHJcbiAgICAucXVlcnlTZWxlY3RvckFsbChcIi5zdHVkeS1hc3Npc3QtcXVlc3Rpb24taGlnaGxpZ2h0XCIpXHJcbiAgICAuZm9yRWFjaCgoZWw6IEVsZW1lbnQpOiB2b2lkID0+IHtcclxuICAgICAgZWwuY2xhc3NMaXN0LnJlbW92ZShcInN0dWR5LWFzc2lzdC1xdWVzdGlvbi1oaWdobGlnaHRcIik7XHJcbiAgICAgIGRlbGV0ZSAoZWwgYXMgSFRNTEVsZW1lbnQpLmRhdGFzZXQuc3R1ZHlBc3Npc3RJZDtcclxuICAgIH0pO1xyXG5cclxuICBkb2N1bWVudC5xdWVyeVNlbGVjdG9yQWxsKFwiLnN0dWR5LWFzc2lzdC1xdWVzdGlvbi1iYWRnZVwiKS5mb3JFYWNoKChlbDogRWxlbWVudCk6IHZvaWQgPT4ge1xyXG4gICAgZWwucmVtb3ZlKCk7XHJcbiAgfSk7XHJcbn1cclxuXHJcbi8vID09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09XHJcbi8vIERpc3BsYXkgRnVuY3Rpb25zXHJcbi8vID09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09XHJcblxyXG4vKipcclxuICogRGlzcGxheSBhIHNpbmdsZSBxdWVzdGlvbiBpbiB0aGUgb3ZlcmxheVxyXG4gKiBAcGFyYW0gcXVlc3Rpb24gLSBUaGUgcXVlc3Rpb24gb2JqZWN0IHRvIGRpc3BsYXlcclxuICogQHBhcmFtIGFuYWx5emVRdWVzdGlvbkNhbGxiYWNrIC0gQ2FsbGJhY2sgdG8gYW5hbHl6ZSB0aGUgcXVlc3Rpb25cclxuICovXHJcbmV4cG9ydCBmdW5jdGlvbiBkaXNwbGF5U2luZ2xlUXVlc3Rpb24oXHJcbiAgcXVlc3Rpb246IERldGVjdGVkUXVlc3Rpb24sXHJcbiAgYW5hbHl6ZVF1ZXN0aW9uQ2FsbGJhY2s/OiAocXVlc3Rpb246IERldGVjdGVkUXVlc3Rpb24pID0+IFByb21pc2U8dm9pZD5cclxuKTogdm9pZCB7XHJcbiAgY29uc3Qgb3ZlcmxheSA9IGRvY3VtZW50LmdldEVsZW1lbnRCeUlkKFwic3R1ZHktYXNzaXN0LW92ZXJsYXlcIikgYXMgSFRNTERpdkVsZW1lbnQgfCBudWxsO1xyXG4gIGlmICghb3ZlcmxheSkgcmV0dXJuO1xyXG5cclxuICBjb25zdCByZXN1bHRzID0gb3ZlcmxheS5xdWVyeVNlbGVjdG9yKFwiLnN0dWR5LWFzc2lzdC1yZXN1bHRzXCIpIGFzIEhUTUxEaXZFbGVtZW50IHwgbnVsbDtcclxuICBpZiAoIXJlc3VsdHMpIHJldHVybjtcclxuXHJcbiAgbGV0IGNvbnRlbnRIdG1sOiBzdHJpbmc7XHJcbiAgaWYgKHF1ZXN0aW9uLnR5cGUgPT09IFwibWF0Y2hpbmdcIikge1xyXG4gICAgLy8gRGlzcGxheSBtYXRjaGluZyBxdWVzdGlvbiBmb3JtYXRcclxuICAgIGNvbnN0IGNhdGVnb3JpZXNMaXN0ID0gKHF1ZXN0aW9uLmNhdGVnb3JpZXMgfHwgW10pXHJcbiAgICAgIC5tYXAoXHJcbiAgICAgICAgKGNhdCkgPT5cclxuICAgICAgICAgIGA8ZGl2IGNsYXNzPVwic3R1ZHktYXNzaXN0LW1hdGNoaW5nLWl0ZW1cIj48c3Ryb25nPiR7Y2F0LmxldHRlcn0uPC9zdHJvbmc+ICR7ZXNjYXBlSHRtbChjYXQudGV4dCl9PC9kaXY+YCxcclxuICAgICAgKVxyXG4gICAgICAuam9pbihcIlwiKTtcclxuXHJcbiAgICBjb25zdCBvcHRpb25zTGlzdCA9IChxdWVzdGlvbi5tYXRjaGluZ09wdGlvbnMgfHwgW10pXHJcbiAgICAgIC5tYXAoXHJcbiAgICAgICAgKG9wdCkgPT5cclxuICAgICAgICAgIGA8ZGl2IGNsYXNzPVwic3R1ZHktYXNzaXN0LW1hdGNoaW5nLWl0ZW1cIj48c3Ryb25nPiR7b3B0LmluZGV4fS48L3N0cm9uZz4gJHtlc2NhcGVIdG1sKG9wdC50ZXh0KX08L2Rpdj5gLFxyXG4gICAgICApXHJcbiAgICAgIC5qb2luKFwiXCIpO1xyXG5cclxuICAgIGNvbnRlbnRIdG1sID0gYFxyXG4gICAgICA8ZGl2IGNsYXNzPVwic3R1ZHktYXNzaXN0LXNpbmdsZS1xdWVzdGlvblwiPlxyXG4gICAgICAgICR7cXVlc3Rpb24ucXVlc3Rpb25OdW1iZXIgPyBgPGRpdiBjbGFzcz1cInN0dWR5LWFzc2lzdC1xdWVzdGlvbi1sYWJlbFwiPlByZWd1bnRhICR7cXVlc3Rpb24ucXVlc3Rpb25OdW1iZXJ9PC9kaXY+YCA6IFwiXCJ9XHJcbiAgICAgICAgPGRpdiBjbGFzcz1cInN0dWR5LWFzc2lzdC1xdWVzdGlvbi1ib3hcIj5cclxuICAgICAgICAgIDxwPiR7ZXNjYXBlSHRtbChxdWVzdGlvbi50ZXh0KX08L3A+XHJcbiAgICAgICAgICA8ZGl2IGNsYXNzPVwic3R1ZHktYXNzaXN0LW1hdGNoaW5nLWNvbnRhaW5lclwiPlxyXG4gICAgICAgICAgICA8ZGl2IGNsYXNzPVwic3R1ZHktYXNzaXN0LW1hdGNoaW5nLXNlY3Rpb25cIj5cclxuICAgICAgICAgICAgICA8aDU+Q2F0ZWdvclx1MDBFRGFzOjwvaDU+XHJcbiAgICAgICAgICAgICAgPGRpdiBjbGFzcz1cInN0dWR5LWFzc2lzdC1tYXRjaGluZy1pdGVtc1wiPlxyXG4gICAgICAgICAgICAgICAgJHtjYXRlZ29yaWVzTGlzdH1cclxuICAgICAgICAgICAgICA8L2Rpdj5cclxuICAgICAgICAgICAgPC9kaXY+XHJcbiAgICAgICAgICAgIDxkaXYgY2xhc3M9XCJzdHVkeS1hc3Npc3QtbWF0Y2hpbmctc2VjdGlvblwiPlxyXG4gICAgICAgICAgICAgIDxoNT5PcGNpb25lczo8L2g1PlxyXG4gICAgICAgICAgICAgIDxkaXYgY2xhc3M9XCJzdHVkeS1hc3Npc3QtbWF0Y2hpbmctaXRlbXNcIj5cclxuICAgICAgICAgICAgICAgICR7b3B0aW9uc0xpc3R9XHJcbiAgICAgICAgICAgICAgPC9kaXY+XHJcbiAgICAgICAgICAgIDwvZGl2PlxyXG4gICAgICAgICAgPC9kaXY+XHJcbiAgICAgICAgPC9kaXY+XHJcbiAgICAgICAgPGJ1dHRvbiBjbGFzcz1cInN0dWR5LWFzc2lzdC1hbmFseXplLWJ0bi1sYXJnZVwiPkFuYWxpemFyIFByZWd1bnRhPC9idXR0b24+XHJcbiAgICAgIDwvZGl2PlxyXG4gICAgYDtcclxuICB9IGVsc2Uge1xyXG4gICAgLy8gRGlzcGxheSBtdWx0aXBsZSBjaG9pY2UgZm9ybWF0XHJcbiAgICBjb25zdCBvcHRpb25zTGlzdCA9IChxdWVzdGlvbi5vcHRpb25zIHx8IFtdKVxyXG4gICAgICAubWFwKFxyXG4gICAgICAgIChvcHQpID0+XHJcbiAgICAgICAgICBgPGRpdiBjbGFzcz1cInN0dWR5LWFzc2lzdC1vcHRpb24taXRlbVwiPjxzdHJvbmc+JHtvcHQubGV0dGVyfS48L3N0cm9uZz4gJHtlc2NhcGVIdG1sKG9wdC50ZXh0KX08L2Rpdj5gLFxyXG4gICAgICApXHJcbiAgICAgIC5qb2luKFwiXCIpO1xyXG5cclxuICAgIGNvbnRlbnRIdG1sID0gYFxyXG4gICAgICA8ZGl2IGNsYXNzPVwic3R1ZHktYXNzaXN0LXNpbmdsZS1xdWVzdGlvblwiPlxyXG4gICAgICAgICR7cXVlc3Rpb24ucXVlc3Rpb25OdW1iZXIgPyBgPGRpdiBjbGFzcz1cInN0dWR5LWFzc2lzdC1xdWVzdGlvbi1sYWJlbFwiPlByZWd1bnRhICR7cXVlc3Rpb24ucXVlc3Rpb25OdW1iZXJ9PC9kaXY+YCA6IFwiXCJ9XHJcbiAgICAgICAgPGRpdiBjbGFzcz1cInN0dWR5LWFzc2lzdC1xdWVzdGlvbi1ib3hcIj5cclxuICAgICAgICAgIDxwPiR7ZXNjYXBlSHRtbChxdWVzdGlvbi50ZXh0KX08L3A+XHJcbiAgICAgICAgICA8ZGl2IGNsYXNzPVwic3R1ZHktYXNzaXN0LW9wdGlvbnNcIj5cclxuICAgICAgICAgICAgJHtvcHRpb25zTGlzdH1cclxuICAgICAgICAgIDwvZGl2PlxyXG4gICAgICAgIDwvZGl2PlxyXG4gICAgICAgIDxidXR0b24gY2xhc3M9XCJzdHVkeS1hc3Npc3QtYW5hbHl6ZS1idG4tbGFyZ2VcIj5BbmFsaXphciBQcmVndW50YTwvYnV0dG9uPlxyXG4gICAgICA8L2Rpdj5cclxuICAgIGA7XHJcbiAgfVxyXG5cclxuICByZXN1bHRzLmlubmVySFRNTCA9IGNvbnRlbnRIdG1sO1xyXG5cclxuICAvLyBTdG9yZSBjdXJyZW50IHF1ZXN0aW9uIGZvciBhbmFseXNpc1xyXG4gIHN0YXRlLmN1cnJlbnRWaXNpYmxlUXVlc3Rpb24gPSBxdWVzdGlvbjtcclxuXHJcbiAgLy8gQWRkIGNsaWNrIGhhbmRsZXIgZm9yIGFuYWx5emUgYnV0dG9uXHJcbiAgY29uc3QgYW5hbHl6ZUJ0biA9IHJlc3VsdHMucXVlcnlTZWxlY3RvcihcIi5zdHVkeS1hc3Npc3QtYW5hbHl6ZS1idG4tbGFyZ2VcIikgYXMgSFRNTEJ1dHRvbkVsZW1lbnQgfCBudWxsO1xyXG4gIGlmIChhbmFseXplQnRuKSB7XHJcbiAgICBhbmFseXplQnRuLmFkZEV2ZW50TGlzdGVuZXIoXCJjbGlja1wiLCAoKTogdm9pZCA9PiB7XHJcbiAgICAgIGlmIChhbmFseXplUXVlc3Rpb25DYWxsYmFjaykge1xyXG4gICAgICAgIGFuYWx5emVRdWVzdGlvbkNhbGxiYWNrKHF1ZXN0aW9uKTtcclxuICAgICAgfVxyXG4gICAgfSk7XHJcbiAgfVxyXG5cclxuICBzaG93T3ZlcmxheSgpO1xyXG59XHJcblxyXG4vKipcclxuICogU2hvdyBxdWVzdGlvbnMgc3VtbWFyeSBpbiB0aGUgb3ZlcmxheVxyXG4gKiBAcGFyYW0gZGV0ZWN0VmlzaWJsZVF1ZXN0aW9uQ2FsbGJhY2sgLSBBc3luYyBmdW5jdGlvbiB0byBkZXRlY3QgdGhlIHZpc2libGUgcXVlc3Rpb25cclxuICogQHBhcmFtIGFuYWx5emVRdWVzdGlvbkNhbGxiYWNrIC0gQ2FsbGJhY2sgdG8gYW5hbHl6ZSBhIHF1ZXN0aW9uXHJcbiAqL1xyXG5leHBvcnQgYXN5bmMgZnVuY3Rpb24gc2hvd1F1ZXN0aW9uc1N1bW1hcnkoXHJcbiAgZGV0ZWN0VmlzaWJsZVF1ZXN0aW9uQ2FsbGJhY2s6ICgpID0+IFByb21pc2U8RGV0ZWN0ZWRRdWVzdGlvbiB8IG51bGw+LFxyXG4gIGFuYWx5emVRdWVzdGlvbkNhbGxiYWNrPzogKHF1ZXN0aW9uOiBEZXRlY3RlZFF1ZXN0aW9uKSA9PiBQcm9taXNlPHZvaWQ+XHJcbik6IFByb21pc2U8dm9pZD4ge1xyXG4gIGNvbnN0IG92ZXJsYXkgPSBkb2N1bWVudC5nZXRFbGVtZW50QnlJZChcInN0dWR5LWFzc2lzdC1vdmVybGF5XCIpIGFzIEhUTUxEaXZFbGVtZW50IHwgbnVsbDtcclxuICBpZiAoIW92ZXJsYXkpIHJldHVybjtcclxuXHJcbiAgLy8gRGV0ZWN0IHRoZSBjdXJyZW50bHkgdmlzaWJsZSBxdWVzdGlvbiBkaXJlY3RseSAoYXN5bmMgZm9yIGltYWdlIGV4dHJhY3Rpb24pXHJcbiAgY29uc3QgY3VycmVudFF1ZXN0aW9uID0gYXdhaXQgZGV0ZWN0VmlzaWJsZVF1ZXN0aW9uQ2FsbGJhY2soKTtcclxuXHJcbiAgaWYgKGN1cnJlbnRRdWVzdGlvbikge1xyXG4gICAgZGlzcGxheVNpbmdsZVF1ZXN0aW9uKGN1cnJlbnRRdWVzdGlvbiwgYW5hbHl6ZVF1ZXN0aW9uQ2FsbGJhY2spO1xyXG4gICAgcmV0dXJuO1xyXG4gIH1cclxuXHJcbiAgLy8gRmFsbGJhY2s6IHRyeSB0byBmaW5kIGZyb20gcHJlLWRldGVjdGVkIHF1ZXN0aW9ucyB1c2luZyB2aXNpYmlsaXR5IHNjb3JlXHJcbiAgbGV0IGZhbGxiYWNrUXVlc3Rpb246IERldGVjdGVkUXVlc3Rpb24gfCBudWxsID0gbnVsbDtcclxuICBsZXQgYmVzdFNjb3JlID0gLTE7XHJcbiAgc3RhdGUuZGV0ZWN0ZWRRdWVzdGlvbnMuZm9yRWFjaCgocTogRGV0ZWN0ZWRRdWVzdGlvbik6IHZvaWQgPT4ge1xyXG4gICAgY29uc3Qgc2NvcmUgPSBnZXRWaXNpYmlsaXR5U2NvcmUocS5lbGVtZW50KTtcclxuICAgIGlmIChzY29yZSA+IGJlc3RTY29yZSkge1xyXG4gICAgICBiZXN0U2NvcmUgPSBzY29yZTtcclxuICAgICAgZmFsbGJhY2tRdWVzdGlvbiA9IHE7XHJcbiAgICB9XHJcbiAgfSk7XHJcblxyXG4gIC8vIExhc3QgZmFsbGJhY2s6IHVzZSB0aGUgZmlyc3QgcXVlc3Rpb25cclxuICBpZiAoIWZhbGxiYWNrUXVlc3Rpb24gJiYgc3RhdGUuZGV0ZWN0ZWRRdWVzdGlvbnMubGVuZ3RoID4gMCkge1xyXG4gICAgZmFsbGJhY2tRdWVzdGlvbiA9IHN0YXRlLmRldGVjdGVkUXVlc3Rpb25zWzBdO1xyXG4gIH1cclxuXHJcbiAgaWYgKGZhbGxiYWNrUXVlc3Rpb24pIHtcclxuICAgIGRpc3BsYXlTaW5nbGVRdWVzdGlvbihmYWxsYmFja1F1ZXN0aW9uLCBhbmFseXplUXVlc3Rpb25DYWxsYmFjayk7XHJcbiAgICByZXR1cm47XHJcbiAgfVxyXG5cclxuICBzaG93Tm9RdWVzdGlvbnNGb3VuZCgpO1xyXG59XHJcblxyXG4vKipcclxuICogU2hvdyBcIm5vIHF1ZXN0aW9ucyBmb3VuZFwiIG1lc3NhZ2UgaW4gdGhlIG92ZXJsYXlcclxuICovXHJcbmV4cG9ydCBmdW5jdGlvbiBzaG93Tm9RdWVzdGlvbnNGb3VuZCgpOiB2b2lkIHtcclxuICAvLyBPbmx5IHNob3cgaWYgb3ZlcmxheSBleGlzdHMgYW5kIGlzIGFscmVhZHkgdmlzaWJsZSAodXNlciBtYW51YWxseSB0cmlnZ2VyZWQpXHJcbiAgY29uc3Qgb3ZlcmxheSA9IGRvY3VtZW50LmdldEVsZW1lbnRCeUlkKFwic3R1ZHktYXNzaXN0LW92ZXJsYXlcIikgYXMgSFRNTERpdkVsZW1lbnQgfCBudWxsO1xyXG4gIGlmICghb3ZlcmxheSB8fCAhc3RhdGUub3ZlcmxheVZpc2libGUpIHJldHVybjtcclxuXHJcbiAgY29uc3QgcmVzdWx0cyA9IG92ZXJsYXkucXVlcnlTZWxlY3RvcihcIi5zdHVkeS1hc3Npc3QtcmVzdWx0c1wiKSBhcyBIVE1MRGl2RWxlbWVudCB8IG51bGw7XHJcbiAgaWYgKCFyZXN1bHRzKSByZXR1cm47XHJcblxyXG4gIHJlc3VsdHMuaW5uZXJIVE1MID0gYFxyXG4gICAgPGRpdiBjbGFzcz1cInN0dWR5LWFzc2lzdC1lbXB0eVwiPlxyXG4gICAgICA8cD5ObyBzZSBkZXRlY3RcdTAwRjMgdW5hIHByZWd1bnRhLiBIYXogY2xpYyBlbiBcdTIxQkIgcGFyYSByZWludGVudGFyLjwvcD5cclxuICAgIDwvZGl2PlxyXG4gIGA7XHJcbn1cclxuXHJcbi8qKlxyXG4gKiBTaG93IGxvYWRpbmcgc3Bpbm5lciBpbiB0aGUgb3ZlcmxheVxyXG4gKi9cclxuZXhwb3J0IGZ1bmN0aW9uIHNob3dMb2FkaW5nKCk6IHZvaWQge1xyXG4gIGNvbnN0IG92ZXJsYXkgPSBkb2N1bWVudC5nZXRFbGVtZW50QnlJZChcInN0dWR5LWFzc2lzdC1vdmVybGF5XCIpIGFzIEhUTUxEaXZFbGVtZW50IHwgbnVsbDtcclxuICBpZiAoIW92ZXJsYXkpIHJldHVybjtcclxuXHJcbiAgY29uc3QgbG9hZGluZyA9IG92ZXJsYXkucXVlcnlTZWxlY3RvcihcIi5zdHVkeS1hc3Npc3QtbG9hZGluZ1wiKSBhcyBIVE1MRGl2RWxlbWVudCB8IG51bGw7XHJcbiAgaWYgKGxvYWRpbmcpIHtcclxuICAgIGxvYWRpbmcuc3R5bGUuZGlzcGxheSA9IFwiZmxleFwiO1xyXG4gIH1cclxufVxyXG5cclxuLyoqXHJcbiAqIEhpZGUgbG9hZGluZyBzcGlubmVyIGluIHRoZSBvdmVybGF5XHJcbiAqL1xyXG5leHBvcnQgZnVuY3Rpb24gaGlkZUxvYWRpbmcoKTogdm9pZCB7XHJcbiAgY29uc3Qgb3ZlcmxheSA9IGRvY3VtZW50LmdldEVsZW1lbnRCeUlkKFwic3R1ZHktYXNzaXN0LW92ZXJsYXlcIikgYXMgSFRNTERpdkVsZW1lbnQgfCBudWxsO1xyXG4gIGlmICghb3ZlcmxheSkgcmV0dXJuO1xyXG5cclxuICBjb25zdCBsb2FkaW5nID0gb3ZlcmxheS5xdWVyeVNlbGVjdG9yKFwiLnN0dWR5LWFzc2lzdC1sb2FkaW5nXCIpIGFzIEhUTUxEaXZFbGVtZW50IHwgbnVsbDtcclxuICBpZiAobG9hZGluZykge1xyXG4gICAgbG9hZGluZy5zdHlsZS5kaXNwbGF5ID0gXCJub25lXCI7XHJcbiAgfVxyXG59XHJcblxyXG4vKipcclxuICogRGlzcGxheSBhbmFseXNpcyByZXN1bHQgaW4gdGhlIG92ZXJsYXlcclxuICogQHBhcmFtIHJlc3VsdCAtIFRoZSBhbmFseXNpcyByZXN1bHQgdGV4dFxyXG4gKiBAcGFyYW0gcXVlc3Rpb24gLSBUaGUgcXVlc3Rpb24gb2JqZWN0XHJcbiAqIEBwYXJhbSBzaG93UXVlc3Rpb25zU3VtbWFyeUNhbGxiYWNrIC0gQ2FsbGJhY2sgdG8gc2hvdyBxdWVzdGlvbnMgc3VtbWFyeSAoZm9yIGJhY2sgYnV0dG9uKVxyXG4gKi9cclxuZXhwb3J0IGZ1bmN0aW9uIGRpc3BsYXlBbmFseXNpc1Jlc3VsdChcclxuICByZXN1bHQ6IHN0cmluZyxcclxuICBxdWVzdGlvbjogRGV0ZWN0ZWRRdWVzdGlvbixcclxuICBzaG93UXVlc3Rpb25zU3VtbWFyeUNhbGxiYWNrPzogKCkgPT4gUHJvbWlzZTx2b2lkPlxyXG4pOiB2b2lkIHtcclxuICBjb25zdCBvdmVybGF5ID0gZG9jdW1lbnQuZ2V0RWxlbWVudEJ5SWQoXCJzdHVkeS1hc3Npc3Qtb3ZlcmxheVwiKSBhcyBIVE1MRGl2RWxlbWVudCB8IG51bGw7XHJcbiAgaWYgKCFvdmVybGF5KSByZXR1cm47XHJcblxyXG4gIGNvbnN0IHJlc3VsdHMgPSBvdmVybGF5LnF1ZXJ5U2VsZWN0b3IoXCIuc3R1ZHktYXNzaXN0LXJlc3VsdHNcIikgYXMgSFRNTERpdkVsZW1lbnQgfCBudWxsO1xyXG4gIGlmICghcmVzdWx0cykgcmV0dXJuO1xyXG5cclxuICByZXN1bHRzLmlubmVySFRNTCA9IGBcclxuICAgIDxkaXYgY2xhc3M9XCJzdHVkeS1hc3Npc3QtYW5hbHlzaXNcIj5cclxuICAgICAgPGJ1dHRvbiBjbGFzcz1cInN0dWR5LWFzc2lzdC1iYWNrLWJ0blwiPlx1MjE5MCBWb2x2ZXIgYSBQcmVndW50YXM8L2J1dHRvbj5cclxuICAgICAgXHJcbiAgICAgIDxkaXYgY2xhc3M9XCJzdHVkeS1hc3Npc3QtcXVlc3Rpb24tYm94XCI+XHJcbiAgICAgICAgPGg0Plx1RDgzRFx1RENERCBQcmVndW50YTwvaDQ+XHJcbiAgICAgICAgPHA+JHtlc2NhcGVIdG1sKHRydW5jYXRlVGV4dChxdWVzdGlvbi50ZXh0LCAzMDApKX08L3A+XHJcbiAgICAgICAgJHtcclxuICAgICAgICAgIHF1ZXN0aW9uLm9wdGlvbnMgJiYgcXVlc3Rpb24ub3B0aW9ucy5sZW5ndGggPiAwXHJcbiAgICAgICAgICAgID8gYFxyXG4gICAgICAgICAgPGRpdiBjbGFzcz1cInN0dWR5LWFzc2lzdC1vcHRpb25zXCI+XHJcbiAgICAgICAgICAgICR7cXVlc3Rpb24ub3B0aW9uc1xyXG4gICAgICAgICAgICAgIC5tYXAoXHJcbiAgICAgICAgICAgICAgICAobykgPT4gYFxyXG4gICAgICAgICAgICAgIDxkaXYgY2xhc3M9XCJzdHVkeS1hc3Npc3Qtb3B0aW9uXCI+XHJcbiAgICAgICAgICAgICAgICA8c3BhbiBjbGFzcz1cInN0dWR5LWFzc2lzdC1vcHRpb24tbGV0dGVyXCI+JHtvLmxldHRlcn08L3NwYW4+XHJcbiAgICAgICAgICAgICAgICA8c3Bhbj4ke2VzY2FwZUh0bWwoby50ZXh0KX08L3NwYW4+XHJcbiAgICAgICAgICAgICAgPC9kaXY+XHJcbiAgICAgICAgICAgIGAsXHJcbiAgICAgICAgICAgICAgKVxyXG4gICAgICAgICAgICAgIC5qb2luKFwiXCIpfVxyXG4gICAgICAgICAgPC9kaXY+XHJcbiAgICAgICAgYFxyXG4gICAgICAgICAgICA6IFwiXCJcclxuICAgICAgICB9XHJcbiAgICAgIDwvZGl2PlxyXG4gICAgICBcclxuICAgICAgPGRpdiBjbGFzcz1cInN0dWR5LWFzc2lzdC1hbnN3ZXItYm94XCI+XHJcbiAgICAgICAgPGg0Plx1RDgzQ1x1REY5MyBMZWFybmluZyBHdWlkZTwvaDQ+XHJcbiAgICAgICAgPGRpdiBjbGFzcz1cInN0dWR5LWFzc2lzdC1hbnN3ZXItY29udGVudFwiPlxyXG4gICAgICAgICAgJHtmb3JtYXRBbmFseXNpc1Jlc3VsdChyZXN1bHQpfVxyXG4gICAgICAgIDwvZGl2PlxyXG4gICAgICA8L2Rpdj5cclxuICAgICAgXHJcbiAgICAgIDxkaXYgY2xhc3M9XCJzdHVkeS1hc3Npc3QtZGlzY2xhaW1lclwiPlxyXG4gICAgICAgICAgXHUyNkEwXHVGRTBGIEVzdGEgZXMgdW5hIGF5dWRhIGRlIGFwcmVuZGl6YWplIGdlbmVyYWRhIHBvciBJQS4gVmVyaWZpY2Egc2llbXByZSBsYSBpbmZvcm1hY2lcdTAwRjNuIHkgXHUwMEZBc2FsYSBwYXJhIG1lam9yYXIgdHUgY29tcHJlbnNpXHUwMEYzbiwgbm8gY29tbyBzdXN0aXR1dG8gZGVsIGVzdHVkaW8uXHJcbiAgICAgIDwvZGl2PlxyXG4gICAgPC9kaXY+XHJcbiAgYDtcclxuXHJcbiAgLy8gQWRkIGJhY2sgYnV0dG9uIGhhbmRsZXJcclxuICBjb25zdCBiYWNrQnRuID0gcmVzdWx0cy5xdWVyeVNlbGVjdG9yKFwiLnN0dWR5LWFzc2lzdC1iYWNrLWJ0blwiKSBhcyBIVE1MQnV0dG9uRWxlbWVudCB8IG51bGw7XHJcbiAgaWYgKGJhY2tCdG4pIHtcclxuICAgIGJhY2tCdG4uYWRkRXZlbnRMaXN0ZW5lcihcImNsaWNrXCIsICgpOiB2b2lkID0+IHtcclxuICAgICAgaWYgKHNob3dRdWVzdGlvbnNTdW1tYXJ5Q2FsbGJhY2spIHtcclxuICAgICAgICBzaG93UXVlc3Rpb25zU3VtbWFyeUNhbGxiYWNrKCk7XHJcbiAgICAgIH1cclxuICAgIH0pO1xyXG4gIH1cclxuXHJcbiAgc2hvd092ZXJsYXkoKTtcclxufVxyXG5cclxuLyoqXHJcbiAqIERpc3BsYXkgc3RyZWFtaW5nIGFuYWx5c2lzIHJlc3VsdCAtIHVwZGF0ZXMgaW4gcmVhbC10aW1lIGFzIGNodW5rcyBhcnJpdmVcclxuICogQHBhcmFtIHJlc3VsdCAtIFRoZSBhY2N1bXVsYXRlZCBhbmFseXNpcyByZXN1bHQgdGV4dCBzbyBmYXJcclxuICogQHBhcmFtIHF1ZXN0aW9uIC0gVGhlIHF1ZXN0aW9uIG9iamVjdFxyXG4gKiBAcGFyYW0gc2hvd1F1ZXN0aW9uc1N1bW1hcnlDYWxsYmFjayAtIENhbGxiYWNrIHRvIHNob3cgcXVlc3Rpb25zIHN1bW1hcnlcclxuICogQHBhcmFtIGlzSW5pdGlhbCAtIFdoZXRoZXIgdGhpcyBpcyB0aGUgaW5pdGlhbCBjYWxsIChjcmVhdGVzIHRoZSBET00pXHJcbiAqIEBwYXJhbSB0b2tlbkluZm8gLSBUb2tlbi9jb3N0IGluZm9ybWF0aW9uIChzaG93biBhZnRlciBjb21wbGV0aW9uKVxyXG4gKi9cclxuZXhwb3J0IGZ1bmN0aW9uIGRpc3BsYXlBbmFseXNpc1Jlc3VsdFN0cmVhbWluZyhcclxuICByZXN1bHQ6IHN0cmluZyxcclxuICBxdWVzdGlvbjogRGV0ZWN0ZWRRdWVzdGlvbixcclxuICBzaG93UXVlc3Rpb25zU3VtbWFyeUNhbGxiYWNrPzogKCkgPT4gUHJvbWlzZTx2b2lkPixcclxuICBpc0luaXRpYWw6IGJvb2xlYW4gPSBmYWxzZSxcclxuICB0b2tlbkluZm8/OiB7IGlucHV0VG9rZW5zOiBudW1iZXI7IG91dHB1dFRva2VuczogbnVtYmVyOyBjb3N0OiBudW1iZXIgfSxcclxuKTogdm9pZCB7XHJcbiAgY29uc3Qgb3ZlcmxheSA9IGRvY3VtZW50LmdldEVsZW1lbnRCeUlkKFwic3R1ZHktYXNzaXN0LW92ZXJsYXlcIikgYXMgSFRNTERpdkVsZW1lbnQgfCBudWxsO1xyXG4gIGlmICghb3ZlcmxheSkgcmV0dXJuO1xyXG5cclxuICBjb25zdCByZXN1bHRzID0gb3ZlcmxheS5xdWVyeVNlbGVjdG9yKFwiLnN0dWR5LWFzc2lzdC1yZXN1bHRzXCIpIGFzIEhUTUxEaXZFbGVtZW50IHwgbnVsbDtcclxuICBpZiAoIXJlc3VsdHMpIHJldHVybjtcclxuXHJcbiAgaWYgKGlzSW5pdGlhbCkge1xyXG4gICAgcmVzdWx0cy5pbm5lckhUTUwgPSBgXHJcbiAgICAgIDxkaXYgY2xhc3M9XCJzdHVkeS1hc3Npc3QtYW5hbHlzaXNcIj5cclxuICAgICAgICA8YnV0dG9uIGNsYXNzPVwic3R1ZHktYXNzaXN0LWJhY2stYnRuXCI+XHUyMTkwIFZvbHZlciBhIFByZWd1bnRhczwvYnV0dG9uPlxyXG4gICAgICAgIFxyXG4gICAgICAgIDxkaXYgY2xhc3M9XCJzdHVkeS1hc3Npc3QtcXVlc3Rpb24tYm94XCI+XHJcbiAgICAgICAgICA8aDQ+XHVEODNEXHVEQ0REIFByZWd1bnRhPC9oND5cclxuICAgICAgICAgIDxwPiR7ZXNjYXBlSHRtbCh0cnVuY2F0ZVRleHQocXVlc3Rpb24udGV4dCwgMzAwKSl9PC9wPlxyXG4gICAgICAgICAgJHtcclxuICAgICAgICAgICAgcXVlc3Rpb24ub3B0aW9ucyAmJiBxdWVzdGlvbi5vcHRpb25zLmxlbmd0aCA+IDBcclxuICAgICAgICAgICAgICA/IGBcclxuICAgICAgICAgICAgPGRpdiBjbGFzcz1cInN0dWR5LWFzc2lzdC1vcHRpb25zXCI+XHJcbiAgICAgICAgICAgICAgJHtxdWVzdGlvbi5vcHRpb25zXHJcbiAgICAgICAgICAgICAgICAubWFwKFxyXG4gICAgICAgICAgICAgICAgICAobykgPT4gYFxyXG4gICAgICAgICAgICAgICAgPGRpdiBjbGFzcz1cInN0dWR5LWFzc2lzdC1vcHRpb25cIj5cclxuICAgICAgICAgICAgICAgICAgPHNwYW4gY2xhc3M9XCJzdHVkeS1hc3Npc3Qtb3B0aW9uLWxldHRlclwiPiR7by5sZXR0ZXJ9PC9zcGFuPlxyXG4gICAgICAgICAgICAgICAgICA8c3Bhbj4ke2VzY2FwZUh0bWwoby50ZXh0KX08L3NwYW4+XHJcbiAgICAgICAgICAgICAgICA8L2Rpdj5cclxuICAgICAgICAgICAgICBgLFxyXG4gICAgICAgICAgICAgICAgKVxyXG4gICAgICAgICAgICAgICAgLmpvaW4oXCJcIil9XHJcbiAgICAgICAgICAgIDwvZGl2PlxyXG4gICAgICAgICAgYFxyXG4gICAgICAgICAgICAgIDogXCJcIlxyXG4gICAgICAgICAgfVxyXG4gICAgICAgIDwvZGl2PlxyXG4gICAgICAgIFxyXG4gICAgICAgIDxkaXYgY2xhc3M9XCJzdHVkeS1hc3Npc3QtYW5zd2VyLWJveFwiPlxyXG4gICAgICAgICAgPGg0Plx1RDgzQ1x1REY5MyBMZWFybmluZyBHdWlkZTwvaDQ+XHJcbiAgICAgICAgICA8ZGl2IGNsYXNzPVwic3R1ZHktYXNzaXN0LWFuc3dlci1jb250ZW50XCIgaWQ9XCJzdHVkeS1hc3Npc3Qtc3RyZWFtLWNvbnRlbnRcIj5cclxuICAgICAgICAgICAgPHNwYW4gY2xhc3M9XCJzdHVkeS1hc3Npc3Qtc3RyZWFtLWN1cnNvclwiPlx1MjU4QTwvc3Bhbj5cclxuICAgICAgICAgIDwvZGl2PlxyXG4gICAgICAgIDwvZGl2PlxyXG5cclxuICAgICAgICA8ZGl2IGNsYXNzPVwic3R1ZHktYXNzaXN0LXRva2VuLWluZm9cIiBpZD1cInN0dWR5LWFzc2lzdC10b2tlbi1pbmZvXCIgc3R5bGU9XCJkaXNwbGF5Om5vbmU7XCI+PC9kaXY+XHJcbiAgICAgICAgXHJcbiAgICAgICAgPGRpdiBjbGFzcz1cInN0dWR5LWFzc2lzdC1kaXNjbGFpbWVyXCI+XHJcbiAgICAgICAgICBcdTI2QTBcdUZFMEYgRXN0YSBlcyB1bmEgYXl1ZGEgZGUgYXByZW5kaXphamUgZ2VuZXJhZGEgcG9yIElBLiBWZXJpZmljYSBzaWVtcHJlIGxhIGluZm9ybWFjaVx1MDBGM24uXHJcbiAgICAgICAgPC9kaXY+XHJcbiAgICAgIDwvZGl2PlxyXG4gICAgYDtcclxuXHJcbiAgICBjb25zdCBiYWNrQnRuID0gcmVzdWx0cy5xdWVyeVNlbGVjdG9yKFwiLnN0dWR5LWFzc2lzdC1iYWNrLWJ0blwiKSBhcyBIVE1MQnV0dG9uRWxlbWVudCB8IG51bGw7XHJcbiAgICBpZiAoYmFja0J0bikge1xyXG4gICAgICBiYWNrQnRuLmFkZEV2ZW50TGlzdGVuZXIoXCJjbGlja1wiLCAoKTogdm9pZCA9PiB7XHJcbiAgICAgICAgaWYgKHNob3dRdWVzdGlvbnNTdW1tYXJ5Q2FsbGJhY2spIHtcclxuICAgICAgICAgIHNob3dRdWVzdGlvbnNTdW1tYXJ5Q2FsbGJhY2soKTtcclxuICAgICAgICB9XHJcbiAgICAgIH0pO1xyXG4gICAgfVxyXG4gICAgc2hvd092ZXJsYXkoKTtcclxuICAgIHJldHVybjtcclxuICB9XHJcblxyXG4gIC8vIFVwZGF0ZSB0aGUgc3RyZWFtaW5nIGNvbnRlbnRcclxuICBjb25zdCBzdHJlYW1Db250ZW50ID0gZG9jdW1lbnQuZ2V0RWxlbWVudEJ5SWQoXCJzdHVkeS1hc3Npc3Qtc3RyZWFtLWNvbnRlbnRcIik7XHJcbiAgaWYgKHN0cmVhbUNvbnRlbnQpIHtcclxuICAgIGNvbnN0IGN1cnNvckh0bWwgPSB0b2tlbkluZm8gPyBcIlwiIDogJzxzcGFuIGNsYXNzPVwic3R1ZHktYXNzaXN0LXN0cmVhbS1jdXJzb3JcIj5cdTI1OEE8L3NwYW4+JztcclxuICAgIHN0cmVhbUNvbnRlbnQuaW5uZXJIVE1MID0gZm9ybWF0QW5hbHlzaXNSZXN1bHQocmVzdWx0KSArIGN1cnNvckh0bWw7XHJcbiAgICBzdHJlYW1Db250ZW50LnNjcm9sbFRvcCA9IHN0cmVhbUNvbnRlbnQuc2Nyb2xsSGVpZ2h0O1xyXG4gIH1cclxuXHJcbiAgLy8gU2hvdyB0b2tlbiBpbmZvIHdoZW4gY29tcGxldGVcclxuICBpZiAodG9rZW5JbmZvKSB7XHJcbiAgICBjb25zdCB0b2tlbkluZm9FbCA9IGRvY3VtZW50LmdldEVsZW1lbnRCeUlkKFwic3R1ZHktYXNzaXN0LXRva2VuLWluZm9cIik7XHJcbiAgICBpZiAodG9rZW5JbmZvRWwpIHtcclxuICAgICAgdG9rZW5JbmZvRWwuc3R5bGUuZGlzcGxheSA9IFwiYmxvY2tcIjtcclxuICAgICAgdG9rZW5JbmZvRWwuaW5uZXJIVE1MID0gYFxyXG4gICAgICAgIDxzcGFuIHRpdGxlPVwiVG9rZW5zIGRlIGVudHJhZGFcIj5cdUQ4M0RcdURDRTUgJHt0b2tlbkluZm8uaW5wdXRUb2tlbnN9PC9zcGFuPlxyXG4gICAgICAgIDxzcGFuIHRpdGxlPVwiVG9rZW5zIGRlIHNhbGlkYVwiPlx1RDgzRFx1RENFNCAke3Rva2VuSW5mby5vdXRwdXRUb2tlbnN9PC9zcGFuPlxyXG4gICAgICAgIDxzcGFuIHRpdGxlPVwiQ29zdG8gZXN0aW1hZG9cIj5cdUQ4M0RcdURDQjAgJCR7dG9rZW5JbmZvLmNvc3QudG9GaXhlZCg2KX08L3NwYW4+XHJcbiAgICAgIGA7XHJcbiAgICB9XHJcbiAgfVxyXG59XHJcblxyXG4vKipcclxuICogRGlzcGxheSBhbiBlcnJvciBtZXNzYWdlIGluIHRoZSBvdmVybGF5XHJcbiAqIEBwYXJhbSBlcnJvck1lc3NhZ2UgLSBUaGUgZXJyb3IgbWVzc2FnZSB0byBkaXNwbGF5XHJcbiAqIEBwYXJhbSBzaG93UXVlc3Rpb25zU3VtbWFyeUNhbGxiYWNrIC0gQ2FsbGJhY2sgZm9yIHJldHJ5IGJ1dHRvblxyXG4gKi9cclxuZXhwb3J0IGZ1bmN0aW9uIGRpc3BsYXlFcnJvcihcclxuICBlcnJvck1lc3NhZ2U6IHN0cmluZyxcclxuICBzaG93UXVlc3Rpb25zU3VtbWFyeUNhbGxiYWNrPzogKCkgPT4gUHJvbWlzZTx2b2lkPlxyXG4pOiB2b2lkIHtcclxuICBjb25zdCBvdmVybGF5ID0gZG9jdW1lbnQuZ2V0RWxlbWVudEJ5SWQoXCJzdHVkeS1hc3Npc3Qtb3ZlcmxheVwiKSBhcyBIVE1MRGl2RWxlbWVudCB8IG51bGw7XHJcbiAgaWYgKCFvdmVybGF5KSByZXR1cm47XHJcblxyXG4gIGNvbnN0IHJlc3VsdHMgPSBvdmVybGF5LnF1ZXJ5U2VsZWN0b3IoXCIuc3R1ZHktYXNzaXN0LXJlc3VsdHNcIikgYXMgSFRNTERpdkVsZW1lbnQgfCBudWxsO1xyXG4gIGlmICghcmVzdWx0cykgcmV0dXJuO1xyXG5cclxuICByZXN1bHRzLmlubmVySFRNTCA9IGBcclxuICAgIDxkaXYgY2xhc3M9XCJzdHVkeS1hc3Npc3QtZXJyb3JcIj5cclxuICAgICAgPHNwYW4gY2xhc3M9XCJzdHVkeS1hc3Npc3QtZXJyb3ItaWNvblwiPlx1MjZBMFx1RkUwRjwvc3Bhbj5cclxuICAgICAgPGgzPkVycm9yIGRlIEFuXHUwMEUxbGlzaXM8L2gzPlxyXG4gICAgICA8cD4ke2VzY2FwZUh0bWwoZXJyb3JNZXNzYWdlKX08L3A+XHJcbiAgICAgIDxidXR0b24gY2xhc3M9XCJzdHVkeS1hc3Npc3QtcmV0cnktYnRuXCI+UmVpbnRlbnRhcjwvYnV0dG9uPlxyXG4gICAgPC9kaXY+XHJcbiAgYDtcclxuXHJcbiAgY29uc3QgcmV0cnlCdG4gPSByZXN1bHRzLnF1ZXJ5U2VsZWN0b3IoXCIuc3R1ZHktYXNzaXN0LXJldHJ5LWJ0blwiKSBhcyBIVE1MQnV0dG9uRWxlbWVudCB8IG51bGw7XHJcbiAgaWYgKHJldHJ5QnRuKSB7XHJcbiAgICByZXRyeUJ0bi5hZGRFdmVudExpc3RlbmVyKFwiY2xpY2tcIiwgKCk6IHZvaWQgPT4ge1xyXG4gICAgICBpZiAoc2hvd1F1ZXN0aW9uc1N1bW1hcnlDYWxsYmFjaykge1xyXG4gICAgICAgIHNob3dRdWVzdGlvbnNTdW1tYXJ5Q2FsbGJhY2soKTtcclxuICAgICAgfVxyXG4gICAgfSk7XHJcbiAgfVxyXG59XHJcbiIsICIvKipcclxuICogU3R1ZHkgQXNzaXN0IC0gS2V5Ym9hcmQgTW9kdWxlXHJcbiAqIEhhbmRsZXMgYWxsIGtleWJvYXJkIGludGVyYWN0aW9ucyBhbmQgc2hvcnRjdXRzXHJcbiAqL1xyXG5cclxuaW1wb3J0IHsgS2V5Ym9hcmRDYWxsYmFja3MgfSBmcm9tIFwiLi4vLi4vdHlwZXMvaW5kZXguanNcIjtcclxuaW1wb3J0IHsgbG9nLCBzdGF0ZSB9IGZyb20gXCIuL3N0YXRlLmpzXCI7XHJcblxyXG4vLyA9PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PVxyXG4vLyBLZXlib2FyZCBIYW5kbGVycyBTZXR1cFxyXG4vLyA9PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PVxyXG5cclxuLyoqXHJcbiAqIFNldHVwIGFsbCBrZXlib2FyZCBoYW5kbGVycyBmb3IgdGhlIGV4dGVuc2lvblxyXG4gKiBAcGFyYW0gY2FsbGJhY2tzIC0gQ2FsbGJhY2sgZnVuY3Rpb25zIGZvciBrZXlib2FyZCBhY3Rpb25zXHJcbiAqL1xyXG5leHBvcnQgZnVuY3Rpb24gc2V0dXBLZXlib2FyZEhhbmRsZXJzKGNhbGxiYWNrczogS2V5Ym9hcmRDYWxsYmFja3MpOiB2b2lkIHtcclxuICBpbmplY3RXZWJleFRvZ2dsZVdpdGhDdHJsKGNhbGxiYWNrcyk7XHJcbn1cclxuXHJcbi8qKlxyXG4gKiBJbmplY3Qga2V5Ym9hcmQgaGFuZGxlcnMgZm9yOlxyXG4gKiAtIEN0cmwgaG9sZCB0byBoaWRlIFdlYmV4IGJ1dHRvblxyXG4gKiAtIFNoaWZ0IGNsaWNrIHRvIHRyaWdnZXIgYW5hbHlzaXNcclxuICogLSBDdHJsK1NoaWZ0IGNsaWNrIHRvIHVzZSBDbGF1ZGUgZGlyZWN0bHlcclxuICogLSBBbHQrVyB0byByZWxvYWQvcmUtZGV0ZWN0IHF1ZXN0aW9uXHJcbiAqIC0gQWx0K1EgdG8gdG9nZ2xlIFNBIGJ1dHRvbiB2aXNpYmlsaXR5XHJcbiAqIC0gQWx0K1ggdG8gY2FuY2VsIGN1cnJlbnQgcmVxdWVzdFxyXG4gKlxyXG4gKiBAcGFyYW0gY2FsbGJhY2tzIC0gQ2FsbGJhY2sgZnVuY3Rpb25zIGZvciBrZXlib2FyZCBhY3Rpb25zXHJcbiAqL1xyXG5leHBvcnQgZnVuY3Rpb24gaW5qZWN0V2ViZXhUb2dnbGVXaXRoQ3RybChjYWxsYmFja3M6IEtleWJvYXJkQ2FsbGJhY2tzKTogdm9pZCB7XHJcbiAgY29uc3Qge1xyXG4gICAgdHJpZ2dlclF1aWNrQW5hbHlzaXMsXHJcbiAgICByZWxvYWRRdWlja01vZGUsXHJcbiAgICB0b2dnbGVTQUJ1dHRvblZpc2liaWxpdHksXHJcbiAgICBjYW5jZWxDdXJyZW50UmVxdWVzdCxcclxuICB9ID0gY2FsbGJhY2tzO1xyXG5cclxuICAvLyBIb2xkIEN0cmwgdG8gaGlkZSBXZWJleCwgcmVsZWFzZSB0byBzaG93XHJcbiAgLy8gVXNlcyBwb3N0TWVzc2FnZSB0byBjb21tdW5pY2F0ZSBiZXR3ZWVuIGZyYW1lc1xyXG5cclxuICBjb25zdCBzdHlsZUlkID0gXCJzdHVkeS1hc3Npc3Qtd2ViZXgtaGlkZS1zdHlsZVwiO1xyXG4gIGNvbnN0IGtleWJvYXJkTWFya2VySWQgPSBcInN0dWR5LWFzc2lzdC1rZXlib2FyZC1pbmplY3RlZFwiO1xyXG4gIGNvbnN0IGlzTWFpbkZyYW1lID0gd2luZG93LnNlbGYgPT09IHdpbmRvdy50b3A7XHJcblxyXG4gIC8vIEtleWJvYXJkIGhhbmRsZXJzIGNhbiBiZSByZS1yZWdpc3RlcmVkIHdoZW4gcXVpY2tNb2RlIGlzIHRvZ2dsZWQgb24vb2ZmLlxyXG4gIC8vIFVzZSBhIGN1c3RvbSBhdHRyaWJ1dGUgb24gZG9jdW1lbnQgdG8gdHJhY2sgcmVnaXN0cmF0aW9uIHNlcGFyYXRlbHkgZnJvbSB0aGUgc3R5bGUuXHJcbiAgY29uc3Qga2V5Ym9hcmRBbHJlYWR5SW5qZWN0ZWQgPSBkb2N1bWVudC5kb2N1bWVudEVsZW1lbnQuaGFzQXR0cmlidXRlKGtleWJvYXJkTWFya2VySWQpO1xyXG5cclxuICAvLyBPbmx5IGluamVjdCB0aGUgc3R5bGUgb25jZSAoc2hhcmVkIHdpdGggdWkudHMgQ3RybC9XZWJleCBoYW5kbGVyKVxyXG4gIGlmICghZG9jdW1lbnQuZ2V0RWxlbWVudEJ5SWQoc3R5bGVJZCkpIHtcclxuXHJcbiAgY29uc3Qgc3R5bGUgPSBkb2N1bWVudC5jcmVhdGVFbGVtZW50KFwic3R5bGVcIik7XHJcbiAgc3R5bGUuaWQgPSBzdHlsZUlkO1xyXG4gIHN0eWxlLnRleHRDb250ZW50ID0gYFxyXG4gICAgLyogQ2xhc3MgdG8gaGlkZSBXZWJleCBidXR0b24gKi9cclxuICAgIC53ZWJleC1oaWRkZW4tYnktc2Ege1xyXG4gICAgICB2aXNpYmlsaXR5OiBoaWRkZW4gIWltcG9ydGFudDtcclxuICAgIH1cclxuICAgIC8qIFNldCBXZWJleCBidXR0b24gaWNvbiBzaXplICovXHJcbiAgICAuZmFiQWN0aW9uQnRuSWNvbkNvbnRhaW5lci0tUlByWkggaW1nIHtcclxuICAgICAgd2lkdGg6IDY1cHggIWltcG9ydGFudDtcclxuICAgICAgaGVpZ2h0OiA2NXB4ICFpbXBvcnRhbnQ7XHJcbiAgICB9XHJcbiAgYDtcclxuICAoZG9jdW1lbnQuaGVhZCA/PyBkb2N1bWVudC5kb2N1bWVudEVsZW1lbnQpLmFwcGVuZENoaWxkKHN0eWxlKTtcclxuICB9XHJcblxyXG4gIC8vIERvbid0IHJlLXJlZ2lzdGVyIGtleWJvYXJkIHNob3J0Y3V0cyBpZiBhbHJlYWR5IGRvbmVcclxuICBpZiAoa2V5Ym9hcmRBbHJlYWR5SW5qZWN0ZWQpIHJldHVybjtcclxuICBkb2N1bWVudC5kb2N1bWVudEVsZW1lbnQuc2V0QXR0cmlidXRlKGtleWJvYXJkTWFya2VySWQsIFwiMVwiKTtcclxuXHJcbiAgLy8gQXBwbHkgaWNvbiBzaXplIHRvIGV4aXN0aW5nIGJ1dHRvbiBpZiBwcmVzZW50XHJcbiAgY29uc3QgZXhpc3RpbmdXZWJleEJ0biA9IGRvY3VtZW50LnF1ZXJ5U2VsZWN0b3IoXHJcbiAgICBcIiN3ZWJleEZhYkFjdGlvbkJ0biwgLmZhYkFjdGlvbkJ0bi0tV05EOFhcIixcclxuICApO1xyXG4gIGlmIChleGlzdGluZ1dlYmV4QnRuKSB7XHJcbiAgICBhcHBseVdlYmV4SWNvblNpemUoZXhpc3RpbmdXZWJleEJ0bik7XHJcbiAgfVxyXG5cclxuICAvLyBPYnNlcnZlIGZvciBXZWJleCBidXR0b24gYXBwZWFyaW5nIGR5bmFtaWNhbGx5XHJcbiAgY29uc3Qgd2ViZXhPYnNlcnZlciA9IG5ldyBNdXRhdGlvbk9ic2VydmVyKChtdXRhdGlvbnM6IE11dGF0aW9uUmVjb3JkW10pOiB2b2lkID0+IHtcclxuICAgIG11dGF0aW9ucy5mb3JFYWNoKChtdXRhdGlvbjogTXV0YXRpb25SZWNvcmQpOiB2b2lkID0+IHtcclxuICAgICAgbXV0YXRpb24uYWRkZWROb2Rlcy5mb3JFYWNoKChub2RlOiBOb2RlKTogdm9pZCA9PiB7XHJcbiAgICAgICAgaWYgKG5vZGUubm9kZVR5cGUgPT09IE5vZGUuRUxFTUVOVF9OT0RFKSB7XHJcbiAgICAgICAgICBjb25zdCBlbGVtZW50ID0gbm9kZSBhcyBFbGVtZW50O1xyXG4gICAgICAgICAgLy8gQ2hlY2sgaWYgdGhlIGFkZGVkIG5vZGUgaXMgdGhlIFdlYmV4IGJ1dHRvblxyXG4gICAgICAgICAgaWYgKFxyXG4gICAgICAgICAgICBlbGVtZW50LmlkID09PSBcIndlYmV4RmFiQWN0aW9uQnRuXCIgfHxcclxuICAgICAgICAgICAgZWxlbWVudC5jbGFzc0xpc3QuY29udGFpbnMoXCJmYWJBY3Rpb25CdG4tLVdORDhYXCIpXHJcbiAgICAgICAgICApIHtcclxuICAgICAgICAgICAgYXBwbHlXZWJleEljb25TaXplKGVsZW1lbnQpO1xyXG4gICAgICAgICAgfVxyXG4gICAgICAgICAgLy8gQWxzbyBjaGVjayBkZXNjZW5kYW50c1xyXG4gICAgICAgICAgY29uc3Qgd2ViZXhCdG4gPSBlbGVtZW50LnF1ZXJ5U2VsZWN0b3I/LihcclxuICAgICAgICAgICAgXCIjd2ViZXhGYWJBY3Rpb25CdG4sIC5mYWJBY3Rpb25CdG4tLVdORDhYXCIsXHJcbiAgICAgICAgICApO1xyXG4gICAgICAgICAgaWYgKHdlYmV4QnRuKSB7XHJcbiAgICAgICAgICAgIGFwcGx5V2ViZXhJY29uU2l6ZSh3ZWJleEJ0bik7XHJcbiAgICAgICAgICB9XHJcbiAgICAgICAgfVxyXG4gICAgICB9KTtcclxuICAgIH0pO1xyXG4gIH0pO1xyXG5cclxuICB3ZWJleE9ic2VydmVyLm9ic2VydmUoZG9jdW1lbnQuYm9keSA/PyBkb2N1bWVudC5kb2N1bWVudEVsZW1lbnQsIHtcclxuICAgIGNoaWxkTGlzdDogdHJ1ZSxcclxuICAgIHN1YnRyZWU6IHRydWUsXHJcbiAgfSk7XHJcblxyXG4gIGZ1bmN0aW9uIGFwcGx5V2ViZXhJY29uU2l6ZSh3ZWJleEJ0bjogRWxlbWVudCk6IHZvaWQge1xyXG4gICAgaWYgKCF3ZWJleEJ0bikgcmV0dXJuO1xyXG4gICAgY29uc3Qgd2ViZXhJbWcgPSB3ZWJleEJ0bi5xdWVyeVNlbGVjdG9yKFxyXG4gICAgICBcIi5mYWJBY3Rpb25CdG5JY29uQ29udGFpbmVyLS1SUHJaSCBpbWdcIixcclxuICAgICkgYXMgSFRNTEltYWdlRWxlbWVudCB8IG51bGw7XHJcbiAgICBpZiAod2ViZXhJbWcpIHtcclxuICAgICAgd2ViZXhJbWcuc3R5bGUuc2V0UHJvcGVydHkoXCJ3aWR0aFwiLCBcIjU1cHhcIiwgXCJpbXBvcnRhbnRcIik7XHJcbiAgICAgIHdlYmV4SW1nLnN0eWxlLnNldFByb3BlcnR5KFwiaGVpZ2h0XCIsIFwiNTVweFwiLCBcImltcG9ydGFudFwiKTtcclxuICAgIH1cclxuICB9XHJcblxyXG4gIGZ1bmN0aW9uIGhpZGVXZWJleCgpOiB2b2lkIHtcclxuICAgIGNvbnN0IHdlYmV4QnRuID0gZG9jdW1lbnQucXVlcnlTZWxlY3RvcihcclxuICAgICAgXCIjd2ViZXhGYWJBY3Rpb25CdG4sIC5mYWJBY3Rpb25CdG4tLVdORDhYXCIsXHJcbiAgICApO1xyXG4gICAgaWYgKHdlYmV4QnRuKSB7XHJcbiAgICAgIHdlYmV4QnRuLmNsYXNzTGlzdC5hZGQoXCJ3ZWJleC1oaWRkZW4tYnktc2FcIik7XHJcbiAgICB9XHJcbiAgfVxyXG5cclxuICBmdW5jdGlvbiBzaG93V2ViZXgoKTogdm9pZCB7XHJcbiAgICBjb25zdCB3ZWJleEJ0biA9IGRvY3VtZW50LnF1ZXJ5U2VsZWN0b3IoXHJcbiAgICAgIFwiI3dlYmV4RmFiQWN0aW9uQnRuLCAuZmFiQWN0aW9uQnRuLS1XTkQ4WFwiLFxyXG4gICAgKTtcclxuICAgIGlmICh3ZWJleEJ0bikge1xyXG4gICAgICB3ZWJleEJ0bi5jbGFzc0xpc3QucmVtb3ZlKFwid2ViZXgtaGlkZGVuLWJ5LXNhXCIpO1xyXG4gICAgfVxyXG4gIH1cclxuXHJcbiAgLy8gTUFJTiBGUkFNRTogTGlzdGVuIGZvciBtZXNzYWdlcyBmcm9tIGlmcmFtZXNcclxuICBpZiAoaXNNYWluRnJhbWUpIHtcclxuICAgIHdpbmRvdy5hZGRFdmVudExpc3RlbmVyKFwibWVzc2FnZVwiLCAoZTogTWVzc2FnZUV2ZW50KTogdm9pZCA9PiB7XHJcbiAgICAgIGlmIChlLmRhdGEgPT09IFwic3R1ZHktYXNzaXN0LWhpZGUtd2ViZXhcIikge1xyXG4gICAgICAgIGhpZGVXZWJleCgpO1xyXG4gICAgICB9IGVsc2UgaWYgKGUuZGF0YSA9PT0gXCJzdHVkeS1hc3Npc3Qtc2hvdy13ZWJleFwiKSB7XHJcbiAgICAgICAgc2hvd1dlYmV4KCk7XHJcbiAgICAgIH1cclxuICAgIH0pO1xyXG4gIH1cclxuXHJcbiAgLy8gQUxMIEZSQU1FUzogTGlzdGVuIGZvciBDdHJsIGtleSBhbmQgc2VuZCBtZXNzYWdlIHRvIHBhcmVudFxyXG4gIGRvY3VtZW50LmFkZEV2ZW50TGlzdGVuZXIoXCJrZXlkb3duXCIsIChlOiBLZXlib2FyZEV2ZW50KTogdm9pZCA9PiB7XHJcbiAgICBpZiAoZS5rZXkgPT09IFwiQ29udHJvbFwiKSB7XHJcbiAgICAgIC8vIFRyeSBsb2NhbGx5IGZpcnN0XHJcbiAgICAgIGhpZGVXZWJleCgpO1xyXG4gICAgICAvLyBBbHNvIHNlbmQgdG8gcGFyZW50IGZyYW1lIChpbiBjYXNlIFdlYmV4IGlzIHRoZXJlKVxyXG4gICAgICBpZiAoIWlzTWFpbkZyYW1lKSB7XHJcbiAgICAgICAgdHJ5IHtcclxuICAgICAgICAgIHdpbmRvdy5wYXJlbnQucG9zdE1lc3NhZ2UoXCJzdHVkeS1hc3Npc3QtaGlkZS13ZWJleFwiLCBcIipcIik7XHJcbiAgICAgICAgfSBjYXRjaCAoZXJyKSB7XHJcbiAgICAgICAgICAvLyBJZ25vcmUgY3Jvc3Mtb3JpZ2luIGVycm9yc1xyXG4gICAgICAgIH1cclxuICAgICAgfVxyXG4gICAgICAvLyBBbHNvIHNlbmQgdG8gdG9wIGZyYW1lXHJcbiAgICAgIHRyeSB7XHJcbiAgICAgICAgd2luZG93LnRvcD8ucG9zdE1lc3NhZ2UoXCJzdHVkeS1hc3Npc3QtaGlkZS13ZWJleFwiLCBcIipcIik7XHJcbiAgICAgIH0gY2F0Y2ggKGVycikge1xyXG4gICAgICAgIC8vIElnbm9yZSBjcm9zcy1vcmlnaW4gZXJyb3JzXHJcbiAgICAgIH1cclxuICAgIH1cclxuXHJcbiAgICAvLyBBTFQrVyAtIFJlbG9hZCBxdWljayBtb2RlIGRldGVjdGlvbiAocmUtZGV0ZWN0IHF1ZXN0aW9uKVxyXG4gICAgLy8gQUxUK1EgLSBIaWRlL3Nob3cgU0EgYnV0dG9uXHJcbiAgICAvLyBPbmx5IHRyaWdnZXIgaWY6XHJcbiAgICAvLyAxLiBOb3QgYSBrZXkgcmVwZWF0XHJcbiAgICAvLyAyLiBOb3QgdHlwaW5nIGluIGFuIGlucHV0IGZpZWxkXHJcbiAgICAvLyAzLiBRdWljayBtb2RlIGlzIGVuYWJsZWQgaW4gc2V0dGluZ3MgKGZvciBBTFQrVylcclxuICAgIGlmIChlLmFsdEtleSAmJiAhZS5yZXBlYXQgJiYgKGUua2V5ID09PSBcIndcIiB8fCBlLmtleSA9PT0gXCJXXCIpKSB7XHJcbiAgICAgIGNvbnN0IGFjdGl2ZUVsID0gZG9jdW1lbnQuYWN0aXZlRWxlbWVudCBhcyBIVE1MRWxlbWVudCB8IG51bGw7XHJcbiAgICAgIGNvbnN0IGlzVHlwaW5nID0gaXNVc2VyVHlwaW5nSW5FbGVtZW50KGFjdGl2ZUVsKTtcclxuXHJcbiAgICAgIGlmICghaXNUeXBpbmcgJiYgc3RhdGUuc2V0dGluZ3MucXVpY2tNb2RlKSB7XHJcbiAgICAgICAgZS5wcmV2ZW50RGVmYXVsdCgpO1xyXG4gICAgICAgIHJlbG9hZFF1aWNrTW9kZSgpO1xyXG4gICAgICB9XHJcbiAgICB9XHJcblxyXG4gICAgLy8gQUxUK1EgLSBIaWRlL3Nob3cgU0EgYnV0dG9uXHJcbiAgICBpZiAoZS5hbHRLZXkgJiYgIWUucmVwZWF0ICYmIChlLmtleSA9PT0gXCJxXCIgfHwgZS5rZXkgPT09IFwiUVwiKSkge1xyXG4gICAgICBjb25zdCBhY3RpdmVFbCA9IGRvY3VtZW50LmFjdGl2ZUVsZW1lbnQgYXMgSFRNTEVsZW1lbnQgfCBudWxsO1xyXG4gICAgICBjb25zdCBpc1R5cGluZyA9IGlzVXNlclR5cGluZ0luRWxlbWVudChhY3RpdmVFbCk7XHJcblxyXG4gICAgICBpZiAoIWlzVHlwaW5nKSB7XHJcbiAgICAgICAgZS5wcmV2ZW50RGVmYXVsdCgpO1xyXG4gICAgICAgIHRvZ2dsZVNBQnV0dG9uVmlzaWJpbGl0eSgpO1xyXG4gICAgICB9XHJcbiAgICB9XHJcblxyXG4gICAgLy8gQUxUK1ggLSBDYW5jZWwgY3VycmVudCByZXF1ZXN0XHJcbiAgICBpZiAoZS5hbHRLZXkgJiYgIWUucmVwZWF0ICYmIChlLmtleSA9PT0gXCJ4XCIgfHwgZS5rZXkgPT09IFwiWFwiKSkge1xyXG4gICAgICBjb25zdCBhY3RpdmVFbCA9IGRvY3VtZW50LmFjdGl2ZUVsZW1lbnQgYXMgSFRNTEVsZW1lbnQgfCBudWxsO1xyXG4gICAgICBjb25zdCBpc1R5cGluZyA9IGlzVXNlclR5cGluZ0luRWxlbWVudChhY3RpdmVFbCk7XHJcblxyXG4gICAgICBpZiAoIWlzVHlwaW5nICYmIHN0YXRlLmlzUmVxdWVzdEluUHJvZ3Jlc3MpIHtcclxuICAgICAgICBlLnByZXZlbnREZWZhdWx0KCk7XHJcbiAgICAgICAgY2FuY2VsQ3VycmVudFJlcXVlc3QoKTtcclxuICAgICAgfVxyXG4gICAgfVxyXG5cclxuICAgIC8vIFNISUZUIGtleSAtIFNlbmQgcXVlc3Rpb24gdG8gQVBJIGF1dG9tYXRpY2FsbHlcclxuICAgIC8vIENUUkwrU0hJRlQgLSBTZW5kIHF1ZXN0aW9uIGRpcmVjdGx5IHRvIENsYXVkZSAoc2tpcCBEZWVwU2VlaylcclxuICAgIC8vIElmIENUUkwrU0hJRlQgd2hpbGUgbG9hZGluZyAtIENhbmNlbCBEZWVwU2VlayBhbmQgdXNlIENsYXVkZVxyXG4gICAgLy8gT25seSB0cmlnZ2VyIGlmOlxyXG4gICAgLy8gMS4gTm90IGEga2V5IHJlcGVhdCAocHJldmVudHMgc3BhbSBmcm9tIGhvbGRpbmcga2V5KVxyXG4gICAgLy8gMi4gTm90IHR5cGluZyBpbiBhbiBpbnB1dCBmaWVsZCAodXNlciBtYXkgYmUgdHlwaW5nIHVwcGVyY2FzZSlcclxuICAgIC8vIDMuIFRoaXMgZnJhbWUgaGFzIHRoZSBTQSBidXR0b24gKGF2b2lkIGR1cGxpY2F0ZSB0cmlnZ2VycyBmcm9tIGlmcmFtZXMpXHJcbiAgICBpZiAoZS5rZXkgPT09IFwiU2hpZnRcIiAmJiAhZS5yZXBlYXQpIHtcclxuICAgICAgY29uc3QgYWN0aXZlRWwgPSBkb2N1bWVudC5hY3RpdmVFbGVtZW50IGFzIEhUTUxFbGVtZW50IHwgbnVsbDtcclxuICAgICAgY29uc3QgaXNUeXBpbmcgPSBpc1VzZXJUeXBpbmdJbkVsZW1lbnQoYWN0aXZlRWwpO1xyXG5cclxuICAgICAgY29uc3QgcXVpY2tCdG4gPSBkb2N1bWVudC5nZXRFbGVtZW50QnlJZChcInN0dWR5LWFzc2lzdC1xdWlja1wiKTtcclxuICAgICAgY29uc3QgaXNMb2FkaW5nID0gcXVpY2tCdG4gJiYgcXVpY2tCdG4uY2xhc3NMaXN0LmNvbnRhaW5zKFwibG9hZGluZ1wiKTtcclxuXHJcbiAgICAgIGlmICghaXNUeXBpbmcgJiYgcXVpY2tCdG4pIHtcclxuICAgICAgICBlLnByZXZlbnREZWZhdWx0KCk7XHJcblxyXG4gICAgICAgIGlmIChpc0xvYWRpbmcgJiYgZS5jdHJsS2V5KSB7XHJcbiAgICAgICAgICAvLyBDVFJMK1NISUZUIHdoaWxlIGxvYWRpbmcgLSBDYW5jZWwgRGVlcFNlZWsgcmVxdWVzdFxyXG4gICAgICAgICAgbG9nKFxyXG4gICAgICAgICAgICBcIltTdHVkeSBBc3Npc3RdIENUUkwrU0hJRlQgcHJlc3NlZCB3aGlsZSBsb2FkaW5nIC0gY2FuY2VsbGluZyBEZWVwU2VlayByZXF1ZXN0XCIsXHJcbiAgICAgICAgICApO1xyXG4gICAgICAgICAgY2hyb21lLnJ1bnRpbWVcclxuICAgICAgICAgICAgLnNlbmRNZXNzYWdlKHsgdHlwZTogXCJDQU5DRUxfREVFUFNFRUtcIiB9KVxyXG4gICAgICAgICAgICAudGhlbigocmVzdWx0OiB7IGNhbmNlbGxlZD86IGJvb2xlYW4gfSB8IHVuZGVmaW5lZCkgPT4ge1xyXG4gICAgICAgICAgICAgIGlmIChyZXN1bHQgJiYgcmVzdWx0LmNhbmNlbGxlZCkge1xyXG4gICAgICAgICAgICAgICAgbG9nKFwiW1N0dWR5IEFzc2lzdF0gRGVlcFNlZWsgY2FuY2VsbGVkLCBDbGF1ZGUgd2lsbCB0YWtlIG92ZXJcIik7XHJcbiAgICAgICAgICAgICAgfVxyXG4gICAgICAgICAgICB9KVxyXG4gICAgICAgICAgICAuY2F0Y2goKGVycjogRXJyb3IpID0+IHtcclxuICAgICAgICAgICAgICBsb2coXCJbU3R1ZHkgQXNzaXN0XSBDYW5jZWwgbWVzc2FnZSBlcnJvcjpcIiwgZXJyKTtcclxuICAgICAgICAgICAgfSk7XHJcbiAgICAgICAgfSBlbHNlIGlmICghaXNMb2FkaW5nKSB7XHJcbiAgICAgICAgICAvLyBOb3QgbG9hZGluZyAtIHN0YXJ0IG5ldyBhbmFseXNpc1xyXG4gICAgICAgICAgLy8gSWYgQ1RSTCBpcyBhbHNvIHByZXNzZWQsIHNraXAgRGVlcFNlZWsgYW5kIHVzZSBDbGF1ZGUgZGlyZWN0bHlcclxuICAgICAgICAgIHN0YXRlLnNraXBEZWVwU2VlayA9IGUuY3RybEtleTtcclxuICAgICAgICAgIGlmIChzdGF0ZS5za2lwRGVlcFNlZWspIHtcclxuICAgICAgICAgICAgbG9nKFxyXG4gICAgICAgICAgICAgIFwiW1N0dWR5IEFzc2lzdF0gQ1RSTCtTSElGVCBwcmVzc2VkIC0gd2lsbCBza2lwIERlZXBTZWVrLCB1c2UgQ2xhdWRlIGRpcmVjdGx5XCIsXHJcbiAgICAgICAgICAgICk7XHJcbiAgICAgICAgICB9XHJcbiAgICAgICAgICB0cmlnZ2VyUXVpY2tBbmFseXNpcygpO1xyXG4gICAgICAgIH1cclxuICAgICAgfVxyXG4gICAgfVxyXG4gIH0pO1xyXG5cclxuICBkb2N1bWVudC5hZGRFdmVudExpc3RlbmVyKFwia2V5dXBcIiwgKGU6IEtleWJvYXJkRXZlbnQpOiB2b2lkID0+IHtcclxuICAgIGlmIChlLmtleSA9PT0gXCJDb250cm9sXCIpIHtcclxuICAgICAgLy8gVHJ5IGxvY2FsbHkgZmlyc3RcclxuICAgICAgc2hvd1dlYmV4KCk7XHJcbiAgICAgIC8vIEFsc28gc2VuZCB0byBwYXJlbnQgZnJhbWVcclxuICAgICAgaWYgKCFpc01haW5GcmFtZSkge1xyXG4gICAgICAgIHRyeSB7XHJcbiAgICAgICAgICB3aW5kb3cucGFyZW50LnBvc3RNZXNzYWdlKFwic3R1ZHktYXNzaXN0LXNob3ctd2ViZXhcIiwgXCIqXCIpO1xyXG4gICAgICAgIH0gY2F0Y2ggKGVycikge1xyXG4gICAgICAgICAgLy8gSWdub3JlIGNyb3NzLW9yaWdpbiBlcnJvcnNcclxuICAgICAgICB9XHJcbiAgICAgIH1cclxuICAgICAgLy8gQWxzbyBzZW5kIHRvIHRvcCBmcmFtZVxyXG4gICAgICB0cnkge1xyXG4gICAgICAgIHdpbmRvdy50b3A/LnBvc3RNZXNzYWdlKFwic3R1ZHktYXNzaXN0LXNob3ctd2ViZXhcIiwgXCIqXCIpO1xyXG4gICAgICB9IGNhdGNoIChlcnIpIHtcclxuICAgICAgICAvLyBJZ25vcmUgY3Jvc3Mtb3JpZ2luIGVycm9yc1xyXG4gICAgICB9XHJcbiAgICB9XHJcbiAgfSk7XHJcblxyXG4gIC8vIEFsc28gc2hvdyB3aGVuIHdpbmRvdyBsb3NlcyBmb2N1c1xyXG4gIHdpbmRvdy5hZGRFdmVudExpc3RlbmVyKFwiYmx1clwiLCAoKTogdm9pZCA9PiB7XHJcbiAgICBzaG93V2ViZXgoKTtcclxuICAgIHRyeSB7XHJcbiAgICAgIHdpbmRvdy50b3A/LnBvc3RNZXNzYWdlKFwic3R1ZHktYXNzaXN0LXNob3ctd2ViZXhcIiwgXCIqXCIpO1xyXG4gICAgfSBjYXRjaCAoZXJyKSB7XHJcbiAgICAgIC8vIElnbm9yZSBjcm9zcy1vcmlnaW4gZXJyb3JzXHJcbiAgICB9XHJcbiAgfSk7XHJcbn1cclxuXHJcbi8vID09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09XHJcbi8vIFV0aWxpdHk6IENoZWNrIGlmIHVzZXIgaXMgdHlwaW5nXHJcbi8vID09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09XHJcblxyXG4vKipcclxuICogSGVscGVyIGZ1bmN0aW9uIHRvIGNoZWNrIGlmIHVzZXIgaXMgdHlwaW5nIGluIGEgc3BlY2lmaWMgZWxlbWVudFxyXG4gKiBAcGFyYW0gYWN0aXZlRWwgLSBUaGUgYWN0aXZlIGVsZW1lbnQgdG8gY2hlY2tcclxuICogQHJldHVybnMgVHJ1ZSBpZiB1c2VyIGlzIHR5cGluZyBpbiB0aGUgZWxlbWVudFxyXG4gKi9cclxuZnVuY3Rpb24gaXNVc2VyVHlwaW5nSW5FbGVtZW50KGFjdGl2ZUVsOiBIVE1MRWxlbWVudCB8IG51bGwpOiBib29sZWFuIHtcclxuICByZXR1cm4gISEoXHJcbiAgICBhY3RpdmVFbCAmJlxyXG4gICAgKGFjdGl2ZUVsLnRhZ05hbWUgPT09IFwiSU5QVVRcIiB8fFxyXG4gICAgICBhY3RpdmVFbC50YWdOYW1lID09PSBcIlRFWFRBUkVBXCIgfHxcclxuICAgICAgYWN0aXZlRWwuaXNDb250ZW50RWRpdGFibGUgfHxcclxuICAgICAgYWN0aXZlRWwuY2xvc2VzdCgnW2NvbnRlbnRlZGl0YWJsZT1cInRydWVcIl0nKSlcclxuICApO1xyXG59XHJcblxyXG4vKipcclxuICogQ2hlY2sgaWYgdGhlIHVzZXIgaXMgY3VycmVudGx5IHR5cGluZyBpbiBhbiBpbnB1dCBmaWVsZFxyXG4gKiBAcmV0dXJucyBUcnVlIGlmIHVzZXIgaXMgdHlwaW5nXHJcbiAqL1xyXG5leHBvcnQgZnVuY3Rpb24gaXNVc2VyVHlwaW5nKCk6IGJvb2xlYW4ge1xyXG4gIGNvbnN0IGFjdGl2ZUVsID0gZG9jdW1lbnQuYWN0aXZlRWxlbWVudCBhcyBIVE1MRWxlbWVudCB8IG51bGw7XHJcbiAgcmV0dXJuIGlzVXNlclR5cGluZ0luRWxlbWVudChhY3RpdmVFbCk7XHJcbn1cclxuIiwgIi8qKlxyXG4gKiBTdHVkeSBBc3Npc3QgLSBBUEkgTW9kdWxlXHJcbiAqIEhhbmRsZXMgQVBJIHJlcXVlc3RzLCBxdWVzdGlvbiBhbmFseXNpcywgYW5kIHF1aWNrIG1vZGUgaW50ZXJhY3Rpb25zXHJcbiAqL1xyXG5cclxuLy8gQ2hyb21lIEFQSSB0eXBlIGRlY2xhcmF0aW9uXHJcbmRlY2xhcmUgY29uc3QgY2hyb21lOiB7XHJcbiAgcnVudGltZToge1xyXG4gICAgc2VuZE1lc3NhZ2U6IDxUID0gdW5rbm93bj4obWVzc2FnZTogdW5rbm93bikgPT4gUHJvbWlzZTxUPjtcclxuICAgIGNvbm5lY3Q6IChjb25uZWN0SW5mbzogeyBuYW1lOiBzdHJpbmcgfSkgPT4gY2hyb21lLnJ1bnRpbWUuUG9ydDtcclxuICB9O1xyXG59O1xyXG5cclxuaW1wb3J0IHR5cGUge1xyXG4gIERldGVjdGVkUXVlc3Rpb24sXHJcbiAgQW5hbHlzaXNDb250ZXh0LFxyXG4gIEFuYWx5c2lzUmVzcG9uc2UsXHJcbiAgUXVpY2tDbGlja0NhbGxiYWNrcyxcclxuICBJbWFnZURhdGEsXHJcbn0gZnJvbSBcIi4uLy4uL3R5cGVzL2luZGV4LmpzXCI7XHJcbmltcG9ydCB7IGxvZywgc3RhdGUsIERFQlVHX01PREUgfSBmcm9tIFwiLi9zdGF0ZS5qc1wiO1xyXG5pbXBvcnQge1xyXG4gIGRldGVjdFZpc2libGVRdWVzdGlvbixcclxuICBmaW5kVmlzaWJsZVF1ZXN0aW9uTnVtYmVyLFxyXG4gIGZyYW1lSGFzUXVpekNvbnRlbnQsXHJcbiAgd2FpdEZvclF1aXpDb250ZW50LFxyXG59IGZyb20gXCIuL2RldGVjdGlvbi5qc1wiO1xyXG5pbXBvcnQgeyBleHRyYWN0SW1hZ2VzQXNCYXNlNjQgfSBmcm9tIFwiLi9pbWFnZXMuanNcIjtcclxuaW1wb3J0IHtcclxuICByZXNldFF1aWNrQW5zd2VyLFxyXG4gIGNyZWF0ZVF1aWNrQnV0dG9uLFxyXG4gIHNob3dMb2FkaW5nLFxyXG4gIGhpZGVMb2FkaW5nLFxyXG4gIGRpc3BsYXlBbmFseXNpc1Jlc3VsdCxcclxuICBkaXNwbGF5QW5hbHlzaXNSZXN1bHRTdHJlYW1pbmcsXHJcbiAgZGlzcGxheUVycm9yLFxyXG59IGZyb20gXCIuL3VpLmpzXCI7XHJcblxyXG5mdW5jdGlvbiBpc1FBU2FuZGJveEFjdGl2ZSgpOiBib29sZWFuIHtcclxuICByZXR1cm4gZG9jdW1lbnQuZ2V0RWxlbWVudEJ5SWQoXCJzdHVkeS1hc3Npc3QtcWEtc2FuZGJveFwiKSAhPT0gbnVsbDtcclxufVxyXG5cclxuZnVuY3Rpb24gbWFwVHJ1ZUZhbHNlQW5zd2VyKHJlc3VsdDogc3RyaW5nLCBvcHRpb25zOiB7IGxldHRlcjogc3RyaW5nOyB0ZXh0OiBzdHJpbmcgfVtdID0gW10pOiBzdHJpbmcge1xyXG4gIGNvbnN0IG5vcm1hbGl6ZWQgPSByZXN1bHRcclxuICAgIC5ub3JtYWxpemUoXCJORkRcIilcclxuICAgIC5yZXBsYWNlKC9bXFx1MDMwMC1cXHUwMzZmXS9nLCBcIlwiKVxyXG4gICAgLnRvVXBwZXJDYXNlKClcclxuICAgIC50cmltKCk7XHJcblxyXG4gIGlmICgvXFxiKFZ8VFJVRXxWRVJEQURFUk8pXFxiLy50ZXN0KG5vcm1hbGl6ZWQpKSByZXR1cm4gXCJWXCI7XHJcbiAgaWYgKC9cXGIoRnxGQUxTRXxGQUxTTylcXGIvLnRlc3Qobm9ybWFsaXplZCkpIHJldHVybiBcIkZcIjtcclxuXHJcbiAgY29uc3Qgc2luZ2xlTGV0dGVyID0gbm9ybWFsaXplZC5tYXRjaCgvXFxiKFtBLUpdKVxcYi8pPy5bMV07XHJcbiAgaWYgKHNpbmdsZUxldHRlcikge1xyXG4gICAgY29uc3QgYnlMZXR0ZXIgPSBvcHRpb25zLmZpbmQoKG9wdCkgPT4gb3B0LmxldHRlci50b1VwcGVyQ2FzZSgpID09PSBzaW5nbGVMZXR0ZXIpO1xyXG4gICAgaWYgKGJ5TGV0dGVyKSB7XHJcbiAgICAgIGNvbnN0IG9wdFRleHQgPSBieUxldHRlci50ZXh0XHJcbiAgICAgICAgLm5vcm1hbGl6ZShcIk5GRFwiKVxyXG4gICAgICAgIC5yZXBsYWNlKC9bXFx1MDMwMC1cXHUwMzZmXS9nLCBcIlwiKVxyXG4gICAgICAgIC50b1VwcGVyQ2FzZSgpO1xyXG4gICAgICBpZiAoL1xcYihUUlVFfFZFUkRBREVSTylcXGIvLnRlc3Qob3B0VGV4dCkpIHJldHVybiBcIlZcIjtcclxuICAgICAgaWYgKC9cXGIoRkFMU0V8RkFMU08pXFxiLy50ZXN0KG9wdFRleHQpKSByZXR1cm4gXCJGXCI7XHJcbiAgICB9XHJcbiAgfVxyXG5cclxuICByZXR1cm4gXCI/XCI7XHJcbn1cclxuXHJcbi8vID09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09XHJcbi8vIFJlcXVlc3QgQ2FuY2VsbGF0aW9uXHJcbi8vID09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09XHJcblxyXG4vKipcclxuICogQ2FuY2VsIGN1cnJlbnQgQVBJIHJlcXVlc3RcclxuICogQ2FsbGVkIHdoZW4gcHJlc3NpbmcgQUxUK1hcclxuICovXHJcbmV4cG9ydCBmdW5jdGlvbiBjYW5jZWxDdXJyZW50UmVxdWVzdCgpOiB2b2lkIHtcclxuICBsb2coXCJbU3R1ZHkgQXNzaXN0XSBBTFQrWCBwcmVzc2VkIC0gY2FuY2VsbGluZyBjdXJyZW50IHJlcXVlc3RcIik7XHJcblxyXG4gIGNvbnN0IHF1aWNrQnRuID0gZG9jdW1lbnQuZ2V0RWxlbWVudEJ5SWQoXCJzdHVkeS1hc3Npc3QtcXVpY2tcIik7XHJcbiAgaWYgKCFxdWlja0J0bikgcmV0dXJuO1xyXG5cclxuICAvLyBTZXQgY2FuY2VsbGVkIGZsYWdcclxuICBzdGF0ZS5yZXF1ZXN0Q2FuY2VsbGVkID0gdHJ1ZTtcclxuXHJcbiAgLy8gQ2xlYXIgc2xvdyBjb25uZWN0aW9uIHRpbWVyXHJcbiAgaWYgKHN0YXRlLnNsb3dDb25uZWN0aW9uVGltZXIpIHtcclxuICAgIGNsZWFyVGltZW91dChzdGF0ZS5zbG93Q29ubmVjdGlvblRpbWVyKTtcclxuICAgIHN0YXRlLnNsb3dDb25uZWN0aW9uVGltZXIgPSBudWxsO1xyXG4gIH1cclxuXHJcbiAgLy8gQ2FuY2VsIGFueSBwZW5kaW5nIERlZXBTZWVrIHJlcXVlc3RcclxuICBjaHJvbWUucnVudGltZS5zZW5kTWVzc2FnZSh7IHR5cGU6IFwiQ0FOQ0VMX0RFRVBTRUVLXCIgfSkuY2F0Y2goKCkgPT4ge30pO1xyXG5cclxuICAvLyBSZXNldCBVSVxyXG4gIHF1aWNrQnRuLmlubmVySFRNTCA9IGA8c3Bhbj5TQTwvc3Bhbj5gO1xyXG4gIHF1aWNrQnRuLmNsYXNzTGlzdC5yZW1vdmUoXCJsb2FkaW5nXCIsIFwic2xvdy1jb25uZWN0aW9uXCIpO1xyXG4gIHN0YXRlLmlzUmVxdWVzdEluUHJvZ3Jlc3MgPSBmYWxzZTtcclxuXHJcbiAgbG9nKFwiW1N0dWR5IEFzc2lzdF0gUmVxdWVzdCBjYW5jZWxsZWQgYnkgdXNlclwiKTtcclxufVxyXG5cclxuLy8gPT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT1cclxuLy8gUXVpY2sgTW9kZSBSZWxvYWRcclxuLy8gPT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT1cclxuXHJcbi8qKlxyXG4gKiBSZWxvYWQgcXVpY2sgbW9kZSAtIHJlY3JlYXRlcyB0aGUgcXVpY2sgYnV0dG9uIGlmIGl0IGRvZXNuJ3QgZXhpc3RcclxuICogQ2FsbGVkIHdoZW4gcHJlc3NpbmcgQUxUK1dcclxuICovXHJcbmV4cG9ydCBmdW5jdGlvbiByZWxvYWRRdWlja01vZGUoXHJcbiAgY2FsbGJhY2tzOiBRdWlja0NsaWNrQ2FsbGJhY2tzID0ge1xyXG4gICAgZGV0ZWN0VmlzaWJsZVF1ZXN0aW9uLFxyXG4gICAgc3RhcnRRdWVzdGlvbkNoYW5nZU9ic2VydmVyLFxyXG4gIH1cclxuKTogdm9pZCB7XHJcbiAgbG9nKFwiW1N0dWR5IEFzc2lzdF0gQUxUK1cgcHJlc3NlZCAtIHJlbG9hZGluZyBxdWljayBtb2RlXCIpO1xyXG5cclxuICBjb25zdCBleGlzdGluZ0J0biA9IGRvY3VtZW50LmdldEVsZW1lbnRCeUlkKFwic3R1ZHktYXNzaXN0LXF1aWNrXCIpO1xyXG5cclxuICBpZiAoZXhpc3RpbmdCdG4pIHtcclxuICAgIC8vIEJ1dHRvbiBleGlzdHMsIGp1c3QgZG8gYSB2aXN1YWwgZmVlZGJhY2sgYW5pbWF0aW9uIChwdWxzZSBlZmZlY3QpXHJcbiAgICBsb2coXCJbU3R1ZHkgQXNzaXN0XSBBcHBseWluZyByZWxvYWRpbmcgYW5pbWF0aW9uIHRvIFNBIGJ1dHRvblwiKTtcclxuICAgIGV4aXN0aW5nQnRuLmNsYXNzTGlzdC5hZGQoXCJyZWxvYWRpbmdcIik7XHJcbiAgICBzZXRUaW1lb3V0KCgpID0+IHtcclxuICAgICAgZXhpc3RpbmdCdG4uY2xhc3NMaXN0LnJlbW92ZShcInJlbG9hZGluZ1wiKTtcclxuICAgIH0sIDUwMCk7XHJcblxyXG4gICAgLy8gUmUtZGV0ZWN0IHRoZSBxdWVzdGlvblxyXG4gICAgaGFuZGxlUXVpY2tSZWxvYWQoKTtcclxuICAgIGxvZyhcIltTdHVkeSBBc3Npc3RdIFF1aWNrIG1vZGUgcmVsb2FkZWQsIHF1ZXN0aW9uIHJlLWRldGVjdGVkXCIpO1xyXG4gIH0gZWxzZSB7XHJcbiAgICAvLyBCdXR0b24gZG9lc24ndCBleGlzdCwgdHJ5IHRvIGNyZWF0ZSBpdFxyXG4gICAgaWYgKHN0YXRlLnNldHRpbmdzLnF1aWNrTW9kZSAmJiBmcmFtZUhhc1F1aXpDb250ZW50KCkpIHtcclxuICAgICAgY3JlYXRlUXVpY2tCdXR0b24oeyBoYW5kbGVRdWlja0NsaWNrOiAoZTogTW91c2VFdmVudCkgPT4gaGFuZGxlUXVpY2tDbGljayhlKSB9KTtcclxuICAgICAgbG9nKFwiW1N0dWR5IEFzc2lzdF0gUXVpY2sgYnV0dG9uIGNyZWF0ZWRcIik7XHJcbiAgICB9IGVsc2UgaWYgKHN0YXRlLnNldHRpbmdzLnF1aWNrTW9kZSkge1xyXG4gICAgICAvLyBXYWl0IGZvciBxdWl6IGNvbnRlbnRcclxuICAgICAgd2FpdEZvclF1aXpDb250ZW50KChoYXNDb250ZW50OiBib29sZWFuKSA9PiB7XHJcbiAgICAgICAgaWYgKGhhc0NvbnRlbnQpIHtcclxuICAgICAgICAgIGNyZWF0ZVF1aWNrQnV0dG9uKHsgaGFuZGxlUXVpY2tDbGljazogKGU6IE1vdXNlRXZlbnQpID0+IGhhbmRsZVF1aWNrQ2xpY2soZSkgfSk7XHJcbiAgICAgICAgICBsb2coXCJbU3R1ZHkgQXNzaXN0XSBRdWljayBidXR0b24gY3JlYXRlZCBhZnRlciB3YWl0aW5nXCIpO1xyXG4gICAgICAgIH0gZWxzZSB7XHJcbiAgICAgICAgICBsb2coXCJbU3R1ZHkgQXNzaXN0XSBObyBxdWl6IGNvbnRlbnQgZm91bmQgaW4gdGhpcyBmcmFtZVwiKTtcclxuICAgICAgICB9XHJcbiAgICAgIH0pO1xyXG4gICAgfSBlbHNlIHtcclxuICAgICAgbG9nKFwiW1N0dWR5IEFzc2lzdF0gUXVpY2sgbW9kZSBpcyBkaXNhYmxlZCBpbiBzZXR0aW5nc1wiKTtcclxuICAgIH1cclxuICB9XHJcbn1cclxuXHJcbi8vID09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09XHJcbi8vIFF1aWNrIEFuYWx5c2lzIFRyaWdnZXJcclxuLy8gPT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT1cclxuXHJcbi8qKlxyXG4gKiBUcmlnZ2VyIHF1aWNrIGFuYWx5c2lzIC0gc2FtZSBhcyBjbGlja2luZyB0aGUgU0EgYnV0dG9uXHJcbiAqIENhbGxlZCB3aGVuIHByZXNzaW5nIFNISUZUIGtleVxyXG4gKi9cclxuZXhwb3J0IGZ1bmN0aW9uIHRyaWdnZXJRdWlja0FuYWx5c2lzKFxyXG4gIGNhbGxiYWNrczogUXVpY2tDbGlja0NhbGxiYWNrcyA9IHtcclxuICAgIGRldGVjdFZpc2libGVRdWVzdGlvbixcclxuICAgIHN0YXJ0UXVlc3Rpb25DaGFuZ2VPYnNlcnZlcixcclxuICB9XHJcbik6IHZvaWQge1xyXG4gIGxvZyhcIltTdHVkeSBBc3Npc3RdIFNISUZUIHByZXNzZWQgLSB0cmlnZ2VyaW5nIHF1aWNrIGFuYWx5c2lzXCIpO1xyXG5cclxuICBjb25zdCBxdWlja0J0biA9IGRvY3VtZW50LmdldEVsZW1lbnRCeUlkKFwic3R1ZHktYXNzaXN0LXF1aWNrXCIpO1xyXG5cclxuICBpZiAocXVpY2tCdG4pIHtcclxuICAgIC8vIENoZWNrIGlmIGFscmVhZHkgbG9hZGluZ1xyXG4gICAgaWYgKHF1aWNrQnRuLmNsYXNzTGlzdC5jb250YWlucyhcImxvYWRpbmdcIikpIHtcclxuICAgICAgbG9nKFwiW1N0dWR5IEFzc2lzdF0gQWxyZWFkeSBsb2FkaW5nLCBpZ25vcmluZ1wiKTtcclxuICAgICAgcmV0dXJuO1xyXG4gICAgfVxyXG5cclxuICAgIC8vIFRyaWdnZXIgdGhlIHF1aWNrIGNsaWNrIGhhbmRsZXJcclxuICAgIGhhbmRsZVF1aWNrQ2xpY2soKTtcclxuICB9IGVsc2Uge1xyXG4gICAgbG9nKFwiW1N0dWR5IEFzc2lzdF0gUXVpY2sgYnV0dG9uIG5vdCBmb3VuZCwgdHJ5aW5nIHRvIGNyZWF0ZSBmaXJzdFwiKTtcclxuICAgIC8vIFRyeSB0byBjcmVhdGUgYnV0dG9uIGZpcnN0LCB0aGVuIGNsaWNrIGl0XHJcbiAgICBpZiAoc3RhdGUuc2V0dGluZ3MucXVpY2tNb2RlICYmIGZyYW1lSGFzUXVpekNvbnRlbnQoKSkge1xyXG4gICAgICBjcmVhdGVRdWlja0J1dHRvbih7IGhhbmRsZVF1aWNrQ2xpY2s6IChlOiBNb3VzZUV2ZW50KSA9PiBoYW5kbGVRdWlja0NsaWNrKGUpIH0pO1xyXG4gICAgICAvLyBXYWl0IGEgYml0IGZvciBidXR0b24gdG8gYmUgY3JlYXRlZCwgdGhlbiB0cmlnZ2VyXHJcbiAgICAgIHNldFRpbWVvdXQoKCkgPT4ge1xyXG4gICAgICAgIGNvbnN0IGJ0biA9IGRvY3VtZW50LmdldEVsZW1lbnRCeUlkKFwic3R1ZHktYXNzaXN0LXF1aWNrXCIpO1xyXG4gICAgICAgIGlmIChidG4pIHtcclxuICAgICAgICAgIGhhbmRsZVF1aWNrQ2xpY2soKTtcclxuICAgICAgICB9XHJcbiAgICAgIH0sIDEwMCk7XHJcbiAgICB9XHJcbiAgfVxyXG59XHJcblxyXG4vLyA9PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PVxyXG4vLyBRdWVzdGlvbiBDaGFuZ2UgT2JzZXJ2ZXJcclxuLy8gPT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT1cclxuXHJcbi8qKlxyXG4gKiBTdGFydCBvYnNlcnZpbmcgZm9yIHF1ZXN0aW9uIGNoYW5nZXMgdG8gcmVzZXQgdGhlIGFuc3dlclxyXG4gKiBVc2VzIGJvdGggTXV0YXRpb25PYnNlcnZlciBhbmQgcGVyaW9kaWMgY2hlY2tzIGZvciByb2J1c3RuZXNzXHJcbiAqL1xyXG5leHBvcnQgZnVuY3Rpb24gc3RhcnRRdWVzdGlvbkNoYW5nZU9ic2VydmVyKCk6IHZvaWQge1xyXG4gIC8vIFN0b3AgYW55IGV4aXN0aW5nIG9ic2VydmVyXHJcbiAgaWYgKHN0YXRlLnF1ZXN0aW9uQ2hhbmdlT2JzZXJ2ZXIpIHtcclxuICAgIHN0YXRlLnF1ZXN0aW9uQ2hhbmdlT2JzZXJ2ZXIuZGlzY29ubmVjdCgpO1xyXG4gICAgc3RhdGUucXVlc3Rpb25DaGFuZ2VPYnNlcnZlciA9IG51bGw7XHJcbiAgfVxyXG5cclxuICAvLyBBbHNvIGNsZWFyIGFueSBleGlzdGluZyBpbnRlcnZhbFxyXG4gIGlmIChzdGF0ZS5xdWVzdGlvbkNoYW5nZUludGVydmFsKSB7XHJcbiAgICBjbGVhckludGVydmFsKHN0YXRlLnF1ZXN0aW9uQ2hhbmdlSW50ZXJ2YWwpO1xyXG4gICAgc3RhdGUucXVlc3Rpb25DaGFuZ2VJbnRlcnZhbCA9IG51bGw7XHJcbiAgfVxyXG5cclxuICAvLyBQZXJpb2RpYyBjaGVjayBmb3IgcXVlc3Rpb24gY2hhbmdlcyAobW9yZSByZWxpYWJsZSBmb3IgTmV0QWNhZCdzIHNsaWRlLWJhc2VkIG5hdmlnYXRpb24pXHJcbiAgLy8gVXNlIGEgc2ltcGxlIGFwcHJvYWNoOiBqdXN0IGNoZWNrIHRoZSB2aXNpYmxlIHF1ZXN0aW9uIG51bWJlciB0ZXh0LCBub3QgZnVsbCBkZXRlY3Rpb25cclxuICBzdGF0ZS5xdWVzdGlvbkNoYW5nZUludGVydmFsID0gc2V0SW50ZXJ2YWwoKCkgPT4ge1xyXG4gICAgaWYgKHN0YXRlLmxhc3RBbnN3ZXJlZFF1ZXN0aW9uTnVtID09PSBudWxsKSB7XHJcbiAgICAgIC8vIE5vIGFuc3dlciBkaXNwbGF5ZWQsIHN0b3AgY2hlY2tpbmdcclxuICAgICAgaWYgKHN0YXRlLnF1ZXN0aW9uQ2hhbmdlSW50ZXJ2YWwpIHtcclxuICAgICAgICBjbGVhckludGVydmFsKHN0YXRlLnF1ZXN0aW9uQ2hhbmdlSW50ZXJ2YWwpO1xyXG4gICAgICAgIHN0YXRlLnF1ZXN0aW9uQ2hhbmdlSW50ZXJ2YWwgPSBudWxsO1xyXG4gICAgICB9XHJcbiAgICAgIHJldHVybjtcclxuICAgIH1cclxuXHJcbiAgICB0cnkge1xyXG4gICAgICAvLyBRdWljayBjaGVjazoganVzdCBmaW5kIHRoZSB2aXNpYmxlIHF1ZXN0aW9uIG51bWJlciB3aXRob3V0IGZ1bGwgZGV0ZWN0aW9uXHJcbiAgICAgIGNvbnN0IGN1cnJlbnROdW0gPSBmaW5kVmlzaWJsZVF1ZXN0aW9uTnVtYmVyKCk7XHJcblxyXG4gICAgICAvLyBMb2cgY3VycmVudCBzdGF0ZSBmb3IgZGVidWdnaW5nXHJcbiAgICAgIGlmIChERUJVR19NT0RFKSB7XHJcbiAgICAgICAgbG9nKGBbT2JzZXJ2ZXJdIGxhc3RBbnN3ZXJlZDogJHtzdGF0ZS5sYXN0QW5zd2VyZWRRdWVzdGlvbk51bX0sIGN1cnJlbnROdW06ICR7Y3VycmVudE51bX0sIHBlbmRpbmc6ICR7c3RhdGUucGVuZGluZ1F1ZXN0aW9uQ2hhbmdlfWApO1xyXG4gICAgICB9XHJcblxyXG4gICAgICAvLyBPbmx5IHJlc2V0IGlmIHdlIGZvdW5kIGEgRElGRkVSRU5UIHF1ZXN0aW9uIG51bWJlciAobm90IG51bGwpXHJcbiAgICAgIC8vIElmIGN1cnJlbnROdW0gaXMgbnVsbCwgd2UgY291bGRuJ3QgZGV0ZWN0IHRoZSBudW1iZXIgLSBkb24ndCByZXNldFxyXG4gICAgICAvLyBBbHNvIHJlcXVpcmUgYXQgbGVhc3QgMiBjb25zZWN1dGl2ZSBkZXRlY3Rpb25zIG9mIGEgZGlmZmVyZW50IG51bWJlclxyXG4gICAgICAvLyB0byBhdm9pZCBmYWxzZSBwb3NpdGl2ZXMgZnJvbSBzY3JvbGwvcmVzaXplIGNhdXNpbmcgZGlmZmVyZW50IHNjb3Jlc1xyXG4gICAgICBpZiAoY3VycmVudE51bSAhPT0gbnVsbCAmJiBjdXJyZW50TnVtICE9PSBzdGF0ZS5sYXN0QW5zd2VyZWRRdWVzdGlvbk51bSkge1xyXG4gICAgICAgIC8vIEZpcnN0IGRldGVjdGlvbiBvZiBjaGFuZ2UgLSBzdG9yZSBhbmQgd2FpdCBmb3IgY29uZmlybWF0aW9uXHJcbiAgICAgICAgaWYgKFxyXG4gICAgICAgICAgIXN0YXRlLnBlbmRpbmdRdWVzdGlvbkNoYW5nZSB8fFxyXG4gICAgICAgICAgc3RhdGUucGVuZGluZ1F1ZXN0aW9uQ2hhbmdlICE9PSBjdXJyZW50TnVtXHJcbiAgICAgICAgKSB7XHJcbiAgICAgICAgICBzdGF0ZS5wZW5kaW5nUXVlc3Rpb25DaGFuZ2UgPSBjdXJyZW50TnVtO1xyXG4gICAgICAgICAgbG9nKGBbT2JzZXJ2ZXJdIFF1ZXN0aW9uIGNoYW5nZSBkZXRlY3RlZDogJHtzdGF0ZS5sYXN0QW5zd2VyZWRRdWVzdGlvbk51bX0gXHUyMTkyICR7Y3VycmVudE51bX0sIHdhaXRpbmcgZm9yIGNvbmZpcm1hdGlvbi4uLmApO1xyXG4gICAgICAgICAgcmV0dXJuOyAvLyBXYWl0IGZvciBuZXh0IGludGVydmFsIHRvIGNvbmZpcm1cclxuICAgICAgICB9XHJcblxyXG4gICAgICAgIC8vIENvbmZpcm1lZCBjaGFuZ2UgKHNhbWUgZGlmZmVyZW50IG51bWJlciBkZXRlY3RlZCB0d2ljZSlcclxuICAgICAgICBsb2coXHJcbiAgICAgICAgICBcIltTdHVkeSBBc3Npc3RdIFF1ZXN0aW9uIGNoYW5nZWQgZnJvbVwiLFxyXG4gICAgICAgICAgc3RhdGUubGFzdEFuc3dlcmVkUXVlc3Rpb25OdW0sXHJcbiAgICAgICAgICBcInRvXCIsXHJcbiAgICAgICAgICBjdXJyZW50TnVtXHJcbiAgICAgICAgKTtcclxuICAgICAgICBzdGF0ZS5wZW5kaW5nUXVlc3Rpb25DaGFuZ2UgPSBudWxsO1xyXG4gICAgICAgIHJlc2V0UXVpY2tBbnN3ZXIoKTtcclxuICAgICAgICBpZiAoc3RhdGUucXVlc3Rpb25DaGFuZ2VJbnRlcnZhbCkge1xyXG4gICAgICAgICAgY2xlYXJJbnRlcnZhbChzdGF0ZS5xdWVzdGlvbkNoYW5nZUludGVydmFsKTtcclxuICAgICAgICAgIHN0YXRlLnF1ZXN0aW9uQ2hhbmdlSW50ZXJ2YWwgPSBudWxsO1xyXG4gICAgICAgIH1cclxuICAgICAgfSBlbHNlIGlmIChjdXJyZW50TnVtID09PSBzdGF0ZS5sYXN0QW5zd2VyZWRRdWVzdGlvbk51bSkge1xyXG4gICAgICAgIC8vIFNhbWUgcXVlc3Rpb24gLSBjbGVhciBhbnkgcGVuZGluZyBjaGFuZ2VcclxuICAgICAgICBzdGF0ZS5wZW5kaW5nUXVlc3Rpb25DaGFuZ2UgPSBudWxsO1xyXG4gICAgICB9XHJcbiAgICAgIC8vIE5vdGU6IGlmIGN1cnJlbnROdW0gaXMgbnVsbCwgd2UgRE9OJ1QgY2xlYXIgcGVuZGluZ1F1ZXN0aW9uQ2hhbmdlXHJcbiAgICAgIC8vIFRoaXMgd2F5IGlmIHdlIHRlbXBvcmFyaWx5IGxvc2Ugc2lnaHQgb2YgdGhlIHF1ZXN0aW9uIG51bWJlcixcclxuICAgICAgLy8gd2UgZG9uJ3QgcmVzZXQgdGhlIHBlbmRpbmcgc3RhdGVcclxuICAgIH0gY2F0Y2ggKGUpIHtcclxuICAgICAgLy8gSWdub3JlIGVycm9ycyBkdXJpbmcgZGV0ZWN0aW9uXHJcbiAgICB9XHJcbiAgfSwgMTAwMCk7IC8vIENoZWNrIGV2ZXJ5IDEgc2Vjb25kIChyZWR1Y2VkIGZyZXF1ZW5jeSlcclxufVxyXG5cclxuLy8gPT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT1cclxuLy8gUXVpY2sgUmVsb2FkIEhhbmRsZXJcclxuLy8gPT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT1cclxuXHJcbi8qKlxyXG4gKiBIYW5kbGUgcXVpY2sgcmVsb2FkIGJ1dHRvbiBjbGlja1xyXG4gKi9cclxuZXhwb3J0IGFzeW5jIGZ1bmN0aW9uIGhhbmRsZVF1aWNrUmVsb2FkKCk6IFByb21pc2U8dm9pZD4ge1xyXG4gIGNvbnN0IHF1aWNrQnRuID0gZG9jdW1lbnQuZ2V0RWxlbWVudEJ5SWQoXCJzdHVkeS1hc3Npc3QtcXVpY2tcIik7XHJcbiAgY29uc3QgY29udGFpbmVyID0gZG9jdW1lbnQuZ2V0RWxlbWVudEJ5SWQoXCJzdHVkeS1hc3Npc3QtcXVpY2stY29udGFpbmVyXCIpO1xyXG4gIGlmICghcXVpY2tCdG4pIHJldHVybjtcclxuXHJcbiAgLy8gU2hvdyByZWxvYWRpbmcgYW5pbWF0aW9uIG9uIGJ1dHRvblxyXG4gIHF1aWNrQnRuLmNsYXNzTGlzdC5hZGQoXCJyZWxvYWRpbmdcIik7XHJcblxyXG4gIC8vIFJlc2V0IHZhbGlkIGFuc3dlciBmbGFnIC0gYWxsb3cgbmV3IHJlcXVlc3RzIGFmdGVyIHJlbG9hZFxyXG4gIHN0YXRlLmhhc1ZhbGlkQW5zd2VyID0gZmFsc2U7XHJcblxyXG4gIC8vIFJlc2V0IHRoZSBtYWluIGJ1dHRvblxyXG4gIHF1aWNrQnRuLmlubmVySFRNTCA9IGA8c3Bhbj5TQTwvc3Bhbj5gO1xyXG4gIHF1aWNrQnRuLmNsYXNzTGlzdC5yZW1vdmUoXHJcbiAgICBcImhhcy1hbnN3ZXJcIixcclxuICAgIFwibXVsdGktYW5zd2VyXCIsXHJcbiAgICBcIm11bHRpLWFuc3dlci1sYXJnZVwiLFxyXG4gICAgXCJtYXRjaGluZy1hbnN3ZXJcIlxyXG4gICk7XHJcblxyXG4gIC8vIFJlc2V0IGNvbnRhaW5lciBhbGlnbm1lbnRcclxuICBpZiAoY29udGFpbmVyKSB7XHJcbiAgICBjb250YWluZXIuY2xhc3NMaXN0LnJlbW92ZShcIm1hdGNoaW5nLW1vZGVcIik7XHJcbiAgfVxyXG5cclxuICAvLyBSZS1kZXRlY3QgdGhlIHF1ZXN0aW9uIHRvIHZlcmlmeSAoYXN5bmMgbm93KVxyXG4gIGRldGVjdFZpc2libGVRdWVzdGlvbigpLnRoZW4oKHF1ZXN0aW9uOiBEZXRlY3RlZFF1ZXN0aW9uIHwgbnVsbCkgPT4ge1xyXG4gICAgLy8gU21hbGwgZGVsYXkgdG8gc2hvdyB0aGUgcmVmcmVzaCBhY3Rpb25cclxuICAgIHNldFRpbWVvdXQoKCkgPT4ge1xyXG4gICAgICBxdWlja0J0bi5jbGFzc0xpc3QucmVtb3ZlKFwicmVsb2FkaW5nXCIpO1xyXG4gICAgfSwgNTAwKTtcclxuICB9KTtcclxufVxyXG5cclxuLy8gPT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT1cclxuLy8gUXVpY2sgQ2xpY2sgSGFuZGxlclxyXG4vLyA9PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PVxyXG5cclxuLyoqXHJcbiAqIE1haW4gcXVpY2sgY2xpY2sgaGFuZGxlciAtIGhhbmRsZXMgU0EgYnV0dG9uIGNsaWNrc1xyXG4gKiBEZXRlY3RzIHF1ZXN0aW9uLCBzZW5kcyB0byBBUEksIGFuZCBkaXNwbGF5cyBhbnN3ZXJcclxuICovXHJcbmV4cG9ydCBhc3luYyBmdW5jdGlvbiBoYW5kbGVRdWlja0NsaWNrKFxyXG4gIGU/OiBNb3VzZUV2ZW50LFxyXG4gIGNhbGxiYWNrczogUXVpY2tDbGlja0NhbGxiYWNrcyA9IHtcclxuICAgIGRldGVjdFZpc2libGVRdWVzdGlvbixcclxuICAgIHN0YXJ0UXVlc3Rpb25DaGFuZ2VPYnNlcnZlcixcclxuICB9XHJcbik6IFByb21pc2U8dm9pZD4ge1xyXG4gIGNvbnN0IHF1aWNrQnRuID0gZG9jdW1lbnQuZ2V0RWxlbWVudEJ5SWQoXCJzdHVkeS1hc3Npc3QtcXVpY2tcIik7XHJcbiAgaWYgKCFxdWlja0J0bikgcmV0dXJuO1xyXG5cclxuICAvLyBTRUNVUklUWTogQmxvY2sgaWYgYWxyZWFkeSBoYXMgdmFsaWQgYW5zd2VyIChtdXN0IHVzZSBBTFQrVyB0byByZWxvYWQpXHJcbiAgaWYgKHN0YXRlLmhhc1ZhbGlkQW5zd2VyKSB7XHJcbiAgICBsb2coXHJcbiAgICAgIFwiW1N0dWR5IEFzc2lzdF0gVmFsaWQgYW5zd2VyIGFscmVhZHkgZGlzcGxheWVkLCB1c2UgQUxUK1cgdG8gcmUtZGV0ZWN0IGFuZCByZXF1ZXN0IGFnYWluXCJcclxuICAgICk7XHJcbiAgICByZXR1cm47XHJcbiAgfVxyXG5cclxuICAvLyBTRUNVUklUWTogUHJldmVudCBzaW11bHRhbmVvdXMgcmVxdWVzdHMgKGdsb2JhbCBsb2NrKVxyXG4gIGlmIChzdGF0ZS5pc1JlcXVlc3RJblByb2dyZXNzKSB7XHJcbiAgICBsb2coXCJbU3R1ZHkgQXNzaXN0XSBSZXF1ZXN0IGFscmVhZHkgaW4gcHJvZ3Jlc3MsIGlnbm9yaW5nXCIpO1xyXG4gICAgcmV0dXJuO1xyXG4gIH1cclxuXHJcbiAgLy8gU0VDVVJJVFk6IEFsc28gY2hlY2sgbG9hZGluZyBzdGF0ZSBvbiBidXR0b24gKGRvdWJsZSBwcm90ZWN0aW9uKVxyXG4gIGlmIChxdWlja0J0bi5jbGFzc0xpc3QuY29udGFpbnMoXCJsb2FkaW5nXCIpKSB7XHJcbiAgICBsb2coXCJbU3R1ZHkgQXNzaXN0XSBBbHJlYWR5IGxvYWRpbmcgKGJ1dHRvbiBzdGF0ZSksIGlnbm9yaW5nXCIpO1xyXG4gICAgcmV0dXJuO1xyXG4gIH1cclxuXHJcbiAgLy8gU2V0IGdsb2JhbCBsb2NrXHJcbiAgc3RhdGUuaXNSZXF1ZXN0SW5Qcm9ncmVzcyA9IHRydWU7XHJcbiAgc3RhdGUucmVxdWVzdENhbmNlbGxlZCA9IGZhbHNlOyAvLyBSZXNldCBjYW5jZWwgZmxhZ1xyXG5cclxuICAvLyBSZXNldCBhbnkgcHJldmlvdXMgYW5zd2VyIHN0YXRlIGJlZm9yZSBwcm9jZXNzaW5nIG5ldyByZXF1ZXN0XHJcbiAgLy8gVGhpcyBlbnN1cmVzIHdlIGRvbid0IGNhcnJ5IG92ZXIgc3RhdGUgZnJvbSBwcmV2aW91cyBxdWVzdGlvbnNcclxuICBpZiAoc3RhdGUucXVlc3Rpb25DaGFuZ2VJbnRlcnZhbCkge1xyXG4gICAgY2xlYXJJbnRlcnZhbChzdGF0ZS5xdWVzdGlvbkNoYW5nZUludGVydmFsKTtcclxuICAgIHN0YXRlLnF1ZXN0aW9uQ2hhbmdlSW50ZXJ2YWwgPSBudWxsO1xyXG4gIH1cclxuICBzdGF0ZS5sYXN0QW5zd2VyZWRRdWVzdGlvbk51bSA9IG51bGw7XHJcblxyXG4gIC8vIENsZWFyIGFueSBwcmV2aW91cyBzbG93IGNvbm5lY3Rpb24gdGltZXJcclxuICBpZiAoc3RhdGUuc2xvd0Nvbm5lY3Rpb25UaW1lcikge1xyXG4gICAgY2xlYXJUaW1lb3V0KHN0YXRlLnNsb3dDb25uZWN0aW9uVGltZXIpO1xyXG4gICAgc3RhdGUuc2xvd0Nvbm5lY3Rpb25UaW1lciA9IG51bGw7XHJcbiAgfVxyXG5cclxuICAvLyBBbHNvIHJlc2V0IHZpc3VhbCBzdGF0ZVxyXG4gIGNvbnN0IGNvbnRhaW5lciA9IGRvY3VtZW50LmdldEVsZW1lbnRCeUlkKFwic3R1ZHktYXNzaXN0LXF1aWNrLWNvbnRhaW5lclwiKTtcclxuICBpZiAoY29udGFpbmVyKSB7XHJcbiAgICBjb250YWluZXIuY2xhc3NMaXN0LnJlbW92ZShcIm1hdGNoaW5nLW1vZGVcIik7XHJcbiAgfVxyXG4gIHF1aWNrQnRuLmNsYXNzTGlzdC5yZW1vdmUoXHJcbiAgICBcImhhcy1hbnN3ZXJcIixcclxuICAgIFwibXVsdGktYW5zd2VyXCIsXHJcbiAgICBcIm11bHRpLWFuc3dlci1sYXJnZVwiLFxyXG4gICAgXCJtYXRjaGluZy1hbnN3ZXJcIixcclxuICAgIFwic2xvdy1jb25uZWN0aW9uXCJcclxuICApO1xyXG5cclxuICAvLyBTaG93IGxvYWRpbmcgc3RhdGVcclxuICBxdWlja0J0bi5pbm5lckhUTUwgPSBgPHNwYW4gY2xhc3M9XCJzdHVkeS1hc3Npc3QtcXVpY2stbG9hZGluZ1wiPjwvc3Bhbj5gO1xyXG4gIHF1aWNrQnRuLmNsYXNzTGlzdC5hZGQoXCJsb2FkaW5nXCIpO1xyXG5cclxuICAvLyBTdGFydCBzbG93IGNvbm5lY3Rpb24gdGltZXIgKDIwIHNlY29uZHMgLSBEZWVwU2VlayBSZWFzb25lciBjYW4gdGFrZSAxNS0yMHMgbm9ybWFsbHkpXHJcbiAgc3RhdGUuc2xvd0Nvbm5lY3Rpb25UaW1lciA9IHNldFRpbWVvdXQoKCkgPT4ge1xyXG4gICAgaWYgKHN0YXRlLmlzUmVxdWVzdEluUHJvZ3Jlc3MgJiYgcXVpY2tCdG4uY2xhc3NMaXN0LmNvbnRhaW5zKFwibG9hZGluZ1wiKSkge1xyXG4gICAgICBxdWlja0J0bi5jbGFzc0xpc3QuYWRkKFwic2xvdy1jb25uZWN0aW9uXCIpO1xyXG4gICAgICBxdWlja0J0bi5pbm5lckhUTUwgPSBgPHNwYW4gY2xhc3M9XCJzdHVkeS1hc3Npc3Qtc2xvdy1pbmRpY2F0b3JcIj5cdTIzRjM8L3NwYW4+YDtcclxuICAgIH1cclxuICB9LCAyMDAwMCk7XHJcblxyXG4gIC8vIERldGVjdCBjdXJyZW50IHF1ZXN0aW9uIChub3cgYXN5bmMgZm9yIGltYWdlIGV4dHJhY3Rpb24pXHJcbiAgY29uc3QgZGV0ZWN0Rm4gPSBjYWxsYmFja3MuZGV0ZWN0VmlzaWJsZVF1ZXN0aW9uID8/IGRldGVjdFZpc2libGVRdWVzdGlvbjtcclxuICBjb25zdCBxdWVzdGlvbiA9IGF3YWl0IGRldGVjdEZuKCk7XHJcblxyXG4gIGlmICghcXVlc3Rpb24pIHtcclxuICAgIHF1aWNrQnRuLmlubmVySFRNTCA9IGA8c3Bhbj4/PC9zcGFuPmA7XHJcbiAgICBxdWlja0J0bi5jbGFzc0xpc3QucmVtb3ZlKFwibG9hZGluZ1wiKTtcclxuICAgIHN0YXRlLmlzUmVxdWVzdEluUHJvZ3Jlc3MgPSBmYWxzZTsgLy8gUmVsZWFzZSBsb2NrXHJcbiAgICBzZXRUaW1lb3V0KCgpID0+IHtcclxuICAgICAgcXVpY2tCdG4uaW5uZXJIVE1MID0gYDxzcGFuPlNBPC9zcGFuPmA7XHJcbiAgICB9LCAxNTAwKTtcclxuICAgIHJldHVybjtcclxuICB9XHJcblxyXG4gIC8vIEdldCBxdWljayBhbnN3ZXIgZnJvbSBBUElcclxuICB0cnkge1xyXG4gICAgLy8gRXh0cmFjdCBpbWFnZXMgLSB1c2UgZGlmZmVyZW50IG1ldGhvZHMgYmFzZWQgb24gcGxhdGZvcm1cclxuICAgIGxldCBpbWFnZXM6IEltYWdlRGF0YVtdID0gW107XHJcbiAgICBsb2coXCJbU3R1ZHkgQXNzaXN0XSBzZW5kSW1hZ2VzIHNldHRpbmc6XCIsIHN0YXRlLnNldHRpbmdzLnNlbmRJbWFnZXMpO1xyXG5cclxuICAgIGlmIChzdGF0ZS5zZXR0aW5ncy5zZW5kSW1hZ2VzKSB7XHJcbiAgICAgIGlmIChxdWVzdGlvbi5wbGF0Zm9ybSA9PT0gXCJtb29kbGVcIikge1xyXG4gICAgICAgIC8vIEZvciBNb29kbGUsIGltYWdlcyBhcmUgYWxyZWFkeSBleHRyYWN0ZWQgaW4gdGhlIHF1ZXN0aW9uIG9iamVjdFxyXG4gICAgICAgIGlmIChxdWVzdGlvbi5pbWFnZXMgJiYgcXVlc3Rpb24uaW1hZ2VzLmxlbmd0aCA+IDApIHtcclxuICAgICAgICAgIGltYWdlcyA9IFsuLi5xdWVzdGlvbi5pbWFnZXNdO1xyXG4gICAgICAgICAgbG9nKFwiW1N0dWR5IEFzc2lzdF0gTW9vZGxlIGltYWdlcyBmb3VuZDpcIiwgaW1hZ2VzLmxlbmd0aCk7XHJcbiAgICAgICAgfVxyXG4gICAgICAgIC8vIEFsc28gYWRkIGltYWdlcyBmcm9tIG9wdGlvbnMgKHdoZW4gYW5zd2VycyBhcmUgaW1hZ2VzKVxyXG4gICAgICAgIGlmIChxdWVzdGlvbi5vcHRpb25zKSB7XHJcbiAgICAgICAgICBmb3IgKGNvbnN0IG9wdCBvZiBxdWVzdGlvbi5vcHRpb25zKSB7XHJcbiAgICAgICAgICAgIGlmIChvcHQuaW1hZ2UpIHtcclxuICAgICAgICAgICAgICBpbWFnZXMucHVzaCh7XHJcbiAgICAgICAgICAgICAgICAuLi5vcHQuaW1hZ2UsXHJcbiAgICAgICAgICAgICAgICBsb2NhdGlvbjogYG9wdGlvbl8ke29wdC5sZXR0ZXJ9YCBhcyBcInF1ZXN0aW9uXCIgfCBcIm9wdGlvblwiLFxyXG4gICAgICAgICAgICAgIH0pO1xyXG4gICAgICAgICAgICB9XHJcbiAgICAgICAgICB9XHJcbiAgICAgICAgfVxyXG4gICAgICB9IGVsc2UgaWYgKHF1ZXN0aW9uLmVsZW1lbnQpIHtcclxuICAgICAgICAvLyBGb3IgTmV0QWNhZCwgZXh0cmFjdCBmcm9tIHNoYWRvdyBET01cclxuICAgICAgICAvLyBxdWVyeVNlbGVjdG9yQWxsRGVlcCB0cmF2ZXJzZXMgc2hhZG93IHJvb3RzIGF1dG9tYXRpY2FsbHlcclxuICAgICAgICB0cnkge1xyXG4gICAgICAgICAgbG9nKFxyXG4gICAgICAgICAgICBcIltTdHVkeSBBc3Npc3RdIEV4dHJhY3RpbmcgaW1hZ2VzIGZyb20gTmV0QWNhZCBlbGVtZW50OlwiLFxyXG4gICAgICAgICAgICBxdWVzdGlvbi5lbGVtZW50LnRhZ05hbWVcclxuICAgICAgICAgICk7XHJcbiAgICAgICAgICBpbWFnZXMgPSBhd2FpdCBleHRyYWN0SW1hZ2VzQXNCYXNlNjQocXVlc3Rpb24uZWxlbWVudCk7XHJcbiAgICAgICAgICBsb2coXCJbU3R1ZHkgQXNzaXN0XSBOZXRBY2FkIGltYWdlcyBleHRyYWN0ZWQ6XCIsIGltYWdlcy5sZW5ndGgpO1xyXG4gICAgICAgIH0gY2F0Y2ggKGltZ0Vycm9yKSB7XHJcbiAgICAgICAgICBjb25zb2xlLmVycm9yKFwiW1N0dWR5IEFzc2lzdF0gSW1hZ2UgZXh0cmFjdGlvbiBlcnJvcjpcIiwgaW1nRXJyb3IpO1xyXG4gICAgICAgIH1cclxuICAgICAgfVxyXG4gICAgfSBlbHNlIHtcclxuICAgICAgbG9nKFwiW1N0dWR5IEFzc2lzdF0gc2VuZEltYWdlcyBpcyBPRkYgLSBubyBpbWFnZXMgd2lsbCBiZSBzZW50XCIpO1xyXG4gICAgfVxyXG5cclxuICAgIGxvZyhcIltTdHVkeSBBc3Npc3RdIFRvdGFsIGltYWdlcyB0byBzZW5kOlwiLCBpbWFnZXMubGVuZ3RoKTtcclxuXHJcbiAgICAvLyBCdWlsZCBjb250ZXh0IGJhc2VkIG9uIHF1ZXN0aW9uIHR5cGVcclxuICAgIGxldCBjb250ZXh0OiBBbmFseXNpc0NvbnRleHQ7XHJcbiAgICBpZiAocXVlc3Rpb24udHlwZSA9PT0gXCJtYXRjaGluZ1wiKSB7XHJcbiAgICAgIC8vIE1hdGNoaW5nIHF1ZXN0aW9uIGNvbnRleHRcclxuICAgICAgY29udGV4dCA9IHtcclxuICAgICAgICBxdWVzdGlvblRleHQ6IHF1ZXN0aW9uLnRleHQsXHJcbiAgICAgICAgcXVlc3Rpb25UeXBlOiBcIm1hdGNoaW5nXCIsXHJcbiAgICAgICAgbWF0Y2hpbmdTdHlsZTogcXVlc3Rpb24ubWF0Y2hpbmdTdHlsZSB8fCBcImRyYWctZHJvcFwiLCAvLyBcImRyb3Bkb3duXCIgb3IgXCJkcmFnLWRyb3BcIlxyXG4gICAgICAgIGNhdGVnb3JpZXM6IHF1ZXN0aW9uLmNhdGVnb3JpZXMsXHJcbiAgICAgICAgbWF0Y2hpbmdPcHRpb25zOiBxdWVzdGlvbi5tYXRjaGluZ09wdGlvbnMsXHJcbiAgICAgICAgaW1hZ2VzOiBpbWFnZXMsXHJcbiAgICAgICAgcGFnZVRpdGxlOiBkb2N1bWVudC50aXRsZSxcclxuICAgICAgICBwYWdlVXJsOiB3aW5kb3cubG9jYXRpb24uaHJlZixcclxuICAgICAgICByZXNwb25zZU1vZGU6IFwicXVpY2tcIixcclxuICAgICAgICBza2lwRGVlcFNlZWs6IHN0YXRlLnNraXBEZWVwU2VlayxcclxuICAgICAgICBjb3Vyc2VOYW1lOiBxdWVzdGlvbi5jb3Vyc2VOYW1lLCAvLyBBY2FkZW1pYyBjb3Vyc2UgZm9yIGNvbnRleHRcclxuICAgICAgICBxYU1vZGU6IGlzUUFTYW5kYm94QWN0aXZlKCksXHJcbiAgICAgIH07XHJcbiAgICB9IGVsc2UgaWYgKHF1ZXN0aW9uLnR5cGUgPT09IFwic2VsZWN0LW1pc3Npbmctd29yZHNcIikge1xyXG4gICAgICBjb250ZXh0ID0ge1xyXG4gICAgICAgIHF1ZXN0aW9uVGV4dDogcXVlc3Rpb24udGV4dCxcclxuICAgICAgICBxdWVzdGlvblR5cGU6IFwic2VsZWN0LW1pc3Npbmctd29yZHNcIixcclxuICAgICAgICBzZWxlY3RHYXBzOiBxdWVzdGlvbi5zZWxlY3RHYXBzLFxyXG4gICAgICAgIHNlbGVjdENob2ljZXM6IHF1ZXN0aW9uLnNlbGVjdENob2ljZXMsXHJcbiAgICAgICAgaW1hZ2VzOiBpbWFnZXMsXHJcbiAgICAgICAgcGFnZVRpdGxlOiBkb2N1bWVudC50aXRsZSxcclxuICAgICAgICBwYWdlVXJsOiB3aW5kb3cubG9jYXRpb24uaHJlZixcclxuICAgICAgICByZXNwb25zZU1vZGU6IFwicXVpY2tcIixcclxuICAgICAgICBza2lwRGVlcFNlZWs6IHN0YXRlLnNraXBEZWVwU2VlayxcclxuICAgICAgICBjb3Vyc2VOYW1lOiBxdWVzdGlvbi5jb3Vyc2VOYW1lLFxyXG4gICAgICAgIHFhTW9kZTogaXNRQVNhbmRib3hBY3RpdmUoKSxcclxuICAgICAgfTtcclxuICAgIH0gZWxzZSBpZiAocXVlc3Rpb24udHlwZSA9PT0gXCJzaG9ydC1hbnN3ZXJcIiB8fCBxdWVzdGlvbi50eXBlID09PSBcIm51bWVyaWNhbFwiKSB7XHJcbiAgICAgIGNvbnRleHQgPSB7XHJcbiAgICAgICAgcXVlc3Rpb25UZXh0OiBxdWVzdGlvbi50ZXh0LFxyXG4gICAgICAgIHF1ZXN0aW9uVHlwZTogcXVlc3Rpb24udHlwZSxcclxuICAgICAgICBpbWFnZXM6IGltYWdlcyxcclxuICAgICAgICBwYWdlVGl0bGU6IGRvY3VtZW50LnRpdGxlLFxyXG4gICAgICAgIHBhZ2VVcmw6IHdpbmRvdy5sb2NhdGlvbi5ocmVmLFxyXG4gICAgICAgIHJlc3BvbnNlTW9kZTogXCJxdWlja1wiLFxyXG4gICAgICAgIHNraXBEZWVwU2Vlazogc3RhdGUuc2tpcERlZXBTZWVrLFxyXG4gICAgICAgIGNvdXJzZU5hbWU6IHF1ZXN0aW9uLmNvdXJzZU5hbWUsXHJcbiAgICAgICAgcWFNb2RlOiBpc1FBU2FuZGJveEFjdGl2ZSgpLFxyXG4gICAgICB9O1xyXG4gICAgfSBlbHNlIHtcclxuICAgICAgLy8gUmVndWxhciBtdWx0aXBsZSBjaG9pY2UgY29udGV4dFxyXG4gICAgICBjb250ZXh0ID0ge1xyXG4gICAgICAgIHF1ZXN0aW9uVGV4dDogcXVlc3Rpb24udGV4dCxcclxuICAgICAgICBxdWVzdGlvblR5cGU6IHF1ZXN0aW9uLnR5cGUgPT09IFwidHJ1ZS1mYWxzZVwiID8gXCJ0cnVlLWZhbHNlXCIgOiBcIm11bHRpcGxlLWNob2ljZVwiLFxyXG4gICAgICAgIG9wdGlvbnM6IHF1ZXN0aW9uLm9wdGlvbnMsXHJcbiAgICAgICAgaW1hZ2VzOiBpbWFnZXMsXHJcbiAgICAgICAgcGFnZVRpdGxlOiBkb2N1bWVudC50aXRsZSxcclxuICAgICAgICBwYWdlVXJsOiB3aW5kb3cubG9jYXRpb24uaHJlZixcclxuICAgICAgICByZXNwb25zZU1vZGU6IFwicXVpY2tcIixcclxuICAgICAgICBza2lwRGVlcFNlZWs6IHN0YXRlLnNraXBEZWVwU2VlayxcclxuICAgICAgICBjb3Vyc2VOYW1lOiBxdWVzdGlvbi5jb3Vyc2VOYW1lLCAvLyBBY2FkZW1pYyBjb3Vyc2UgZm9yIGNvbnRleHRcclxuICAgICAgICBxYU1vZGU6IGlzUUFTYW5kYm94QWN0aXZlKCksXHJcbiAgICAgIH07XHJcbiAgICB9XHJcblxyXG4gICAgLy8gUmVzZXQgc2tpcERlZXBTZWVrIGZsYWcgYWZ0ZXIgdXNlXHJcbiAgICBzdGF0ZS5za2lwRGVlcFNlZWsgPSBmYWxzZTtcclxuXHJcbiAgICAvLyBEZWJ1ZzogTG9nIHdoYXQgd2UncmUgc2VuZGluZyB0byBBUElcclxuICAgIGxvZyhcIltTdHVkeSBBc3Npc3RdIFNlbmRpbmcgdG8gQVBJOlwiLCB7XHJcbiAgICAgIHF1ZXN0aW9uTnVtYmVyOiBxdWVzdGlvbi5xdWVzdGlvbk51bWJlcixcclxuICAgICAgcXVlc3Rpb25UeXBlOiBxdWVzdGlvbi50eXBlLFxyXG4gICAgICBxdWVzdGlvblRleHQ6IHF1ZXN0aW9uLnRleHRcclxuICAgICAgICA/IHF1ZXN0aW9uLnRleHQuc3Vic3RyaW5nKDAsIDgwKVxyXG4gICAgICAgIDogXCIobm8gdGV4dClcIixcclxuICAgICAgb3B0aW9uc0NvdW50OiBxdWVzdGlvbi5vcHRpb25zID8gcXVlc3Rpb24ub3B0aW9ucy5sZW5ndGggOiAwLFxyXG4gICAgICBvcHRpb25zOiBxdWVzdGlvbi5vcHRpb25zXHJcbiAgICAgICAgPyBxdWVzdGlvbi5vcHRpb25zLm1hcChcclxuICAgICAgICAgICAgKG8pID0+IGAke28ubGV0dGVyfTogJHtvLnRleHQgPyBvLnRleHQuc3Vic3RyaW5nKDAsIDMwKSA6IFwiXCJ9YFxyXG4gICAgICAgICAgKVxyXG4gICAgICAgIDogW10sXHJcbiAgICB9KTtcclxuXHJcbiAgICBjb25zdCByZXNwb25zZTogQW5hbHlzaXNSZXNwb25zZSA9IGF3YWl0IGNocm9tZS5ydW50aW1lLnNlbmRNZXNzYWdlKHtcclxuICAgICAgdHlwZTogXCJBTkFMWVpFX1FVRVNUSU9OXCIsXHJcbiAgICAgIGNvbnRleHQ6IGNvbnRleHQsXHJcbiAgICB9KTtcclxuXHJcbiAgICAvLyBDbGVhciBzbG93IGNvbm5lY3Rpb24gdGltZXJcclxuICAgIGlmIChzdGF0ZS5zbG93Q29ubmVjdGlvblRpbWVyKSB7XHJcbiAgICAgIGNsZWFyVGltZW91dChzdGF0ZS5zbG93Q29ubmVjdGlvblRpbWVyKTtcclxuICAgICAgc3RhdGUuc2xvd0Nvbm5lY3Rpb25UaW1lciA9IG51bGw7XHJcbiAgICB9XHJcblxyXG4gICAgLy8gQ2hlY2sgaWYgcmVxdWVzdCB3YXMgY2FuY2VsbGVkIHdoaWxlIHdhaXRpbmdcclxuICAgIGlmIChzdGF0ZS5yZXF1ZXN0Q2FuY2VsbGVkKSB7XHJcbiAgICAgIGxvZyhcIltTdHVkeSBBc3Npc3RdIFJlcXVlc3Qgd2FzIGNhbmNlbGxlZCwgaWdub3JpbmcgcmVzcG9uc2VcIik7XHJcbiAgICAgIHJldHVybjtcclxuICAgIH1cclxuXHJcbiAgICBxdWlja0J0bi5jbGFzc0xpc3QucmVtb3ZlKFwibG9hZGluZ1wiLCBcInNsb3ctY29ubmVjdGlvblwiKTtcclxuICAgIHN0YXRlLmlzUmVxdWVzdEluUHJvZ3Jlc3MgPSBmYWxzZTsgLy8gUmVsZWFzZSBsb2NrIGFmdGVyIEFQSSByZXNwb25zZVxyXG5cclxuICAgIGlmIChyZXNwb25zZS5zdWNjZXNzICYmIHJlc3BvbnNlLnJlc3VsdCkge1xyXG4gICAgICBjb25zdCByZXN1bHQgPSByZXNwb25zZS5yZXN1bHQudHJpbSgpO1xyXG5cclxuICAgICAgLy8gR2V0IGNvbnRhaW5lciBmb3IgbWF0Y2hpbmcgYW5zd2VyIGFsaWdubWVudFxyXG4gICAgICBjb25zdCBjb250YWluZXIgPSBkb2N1bWVudC5nZXRFbGVtZW50QnlJZChcInN0dWR5LWFzc2lzdC1xdWljay1jb250YWluZXJcIik7XHJcblxyXG4gICAgICAvLyBTYXZlIGN1cnJlbnQgcXVlc3Rpb24gbnVtYmVyIHRvIGRldGVjdCBxdWVzdGlvbiBjaGFuZ2VzXHJcbiAgICAgIHN0YXRlLmxhc3RBbnN3ZXJlZFF1ZXN0aW9uTnVtID0gcXVlc3Rpb24ucXVlc3Rpb25OdW1iZXIgfHwgbnVsbDtcclxuXHJcbiAgICAgIC8vIFN0YXJ0IG9ic2VydmluZyBmb3IgcXVlc3Rpb24gY2hhbmdlcyB0byByZXNldCB0aGUgYW5zd2VyIChmb3IgQUxMIHF1ZXN0aW9uIHR5cGVzKVxyXG4gICAgICBjb25zdCBvYnNlcnZlckZuID1cclxuICAgICAgICBjYWxsYmFja3Muc3RhcnRRdWVzdGlvbkNoYW5nZU9ic2VydmVyID8/IHN0YXJ0UXVlc3Rpb25DaGFuZ2VPYnNlcnZlcjtcclxuICAgICAgb2JzZXJ2ZXJGbigpO1xyXG5cclxuICAgICAgLy8gQ2hlY2sgaWYgdGhpcyBpcyBhIG1hdGNoaW5nIHF1ZXN0aW9uIHJlc3BvbnNlXHJcbiAgICAgIGlmIChxdWVzdGlvbi50eXBlID09PSBcIm1hdGNoaW5nXCIpIHtcclxuICAgICAgICAvLyBNYXRjaGluZyByZXNwb25zZSBmb3JtYXQ6IDEtQSwgMi1CLCAzLUEgb3IgQS0xLCBCLTMsIEMtMlxyXG4gICAgICAgIC8vIENvbnZlcnQgY29tbWEtc2VwYXJhdGVkIHRvIHZlcnRpY2FsIChuZXdsaW5lcylcclxuICAgICAgICBjb25zdCBjbGVhblJlc3VsdCA9IHJlc3VsdC50b1VwcGVyQ2FzZSgpLnRyaW0oKS5yZXBsYWNlKC8sXFxzKi9nLCBcIlxcblwiKTtcclxuXHJcbiAgICAgICAgLy8gU2hvdyBtYXRjaGluZyByZXN1bHRzIHZlcnRpY2FsbHlcclxuICAgICAgICBxdWlja0J0bi5pbm5lckhUTUwgPSBgPHNwYW4gY2xhc3M9XCJzdHVkeS1hc3Npc3QtcXVpY2stYW5zd2VyIHN0dWR5LWFzc2lzdC1tYXRjaGluZy1hbnN3ZXJcIj4ke2NsZWFuUmVzdWx0fTwvc3Bhbj5gO1xyXG4gICAgICAgIHF1aWNrQnRuLmNsYXNzTGlzdC5hZGQoXCJoYXMtYW5zd2VyXCIsIFwibWF0Y2hpbmctYW5zd2VyXCIpO1xyXG4gICAgICAgIGlmIChjb250YWluZXIpIGNvbnRhaW5lci5jbGFzc0xpc3QuYWRkKFwibWF0Y2hpbmctbW9kZVwiKTtcclxuXHJcbiAgICAgICAgLy8gTWFyayBhcyB2YWxpZCBhbnN3ZXIgLSBibG9jayBuZXcgcmVxdWVzdHMgdW50aWwgcmVsb2FkXHJcbiAgICAgICAgc3RhdGUuaGFzVmFsaWRBbnN3ZXIgPSB0cnVlO1xyXG4gICAgICB9IGVsc2UgaWYgKHF1ZXN0aW9uLnR5cGUgPT09IFwic2VsZWN0LW1pc3Npbmctd29yZHNcIikge1xyXG4gICAgICAgIC8vIEdhcC1maWxsIGFuc3dlcjogW1sxXV09SFRUUCwgW1syXV09ODAsIC4uLlxyXG4gICAgICAgIC8vIFNob3cgb24gYnV0dG9uIHZlcnRpY2FsbHk6IG9uZSBnYXAgcGVyIGxpbmVcclxuICAgICAgICBjb25zdCBjbGVhblJlc3VsdCA9IHJlc3VsdC50cmltKCkucmVwbGFjZSgvLFxccyovZywgXCJcXG5cIik7XHJcbiAgICAgICAgcXVpY2tCdG4uaW5uZXJIVE1MID0gYDxzcGFuIGNsYXNzPVwic3R1ZHktYXNzaXN0LXF1aWNrLWFuc3dlciBzdHVkeS1hc3Npc3QtbWF0Y2hpbmctYW5zd2VyXCI+JHtjbGVhblJlc3VsdH08L3NwYW4+YDtcclxuICAgICAgICBxdWlja0J0bi5jbGFzc0xpc3QuYWRkKFwiaGFzLWFuc3dlclwiLCBcIm1hdGNoaW5nLWFuc3dlclwiKTtcclxuICAgICAgICBpZiAoY29udGFpbmVyKSBjb250YWluZXIuY2xhc3NMaXN0LmFkZChcIm1hdGNoaW5nLW1vZGVcIik7XHJcbiAgICAgICAgc3RhdGUuaGFzVmFsaWRBbnN3ZXIgPSB0cnVlO1xyXG4gICAgICB9IGVsc2UgaWYgKHF1ZXN0aW9uLnR5cGUgPT09IFwic2hvcnQtYW5zd2VyXCIgfHwgcXVlc3Rpb24udHlwZSA9PT0gXCJudW1lcmljYWxcIikge1xyXG4gICAgICAgIC8vIEZyZWUtdGV4dCBhbnN3ZXIgXHUyMDE0IGRpc3BsYXkgYXMtaXMgb24gdGhlIGJ1dHRvblxyXG4gICAgICAgIGNvbnN0IGRpc3BsYXlBbnN3ZXIgPSByZXN1bHQudHJpbSgpIHx8IFwiP1wiO1xyXG4gICAgICAgIHF1aWNrQnRuLmlubmVySFRNTCA9IGA8c3BhbiBjbGFzcz1cInN0dWR5LWFzc2lzdC1xdWljay1hbnN3ZXIgc3R1ZHktYXNzaXN0LW1hdGNoaW5nLWFuc3dlclwiPiR7ZGlzcGxheUFuc3dlcn08L3NwYW4+YDtcclxuICAgICAgICBxdWlja0J0bi5jbGFzc0xpc3QuYWRkKFwiaGFzLWFuc3dlclwiLCBcIm1hdGNoaW5nLWFuc3dlclwiKTtcclxuICAgICAgICBpZiAoY29udGFpbmVyKSBjb250YWluZXIuY2xhc3NMaXN0LmFkZChcIm1hdGNoaW5nLW1vZGVcIik7XHJcbiAgICAgICAgaWYgKGRpc3BsYXlBbnN3ZXIgIT09IFwiP1wiKSB7XHJcbiAgICAgICAgICBzdGF0ZS5oYXNWYWxpZEFuc3dlciA9IHRydWU7XHJcbiAgICAgICAgfVxyXG4gICAgICB9IGVsc2Uge1xyXG4gICAgICAgIC8vIFJlZ3VsYXIgbXVsdGlwbGUgY2hvaWNlIGhhbmRsaW5nXHJcbiAgICAgICAgY29uc3QgdXBwZXJSZXN1bHQgPSByZXN1bHQudG9VcHBlckNhc2UoKTtcclxuXHJcbiAgICAgICAgaWYgKHF1ZXN0aW9uLnR5cGUgPT09IFwidHJ1ZS1mYWxzZVwiKSB7XHJcbiAgICAgICAgICBjb25zdCBhbnN3ZXIgPSBtYXBUcnVlRmFsc2VBbnN3ZXIocmVzdWx0LCBxdWVzdGlvbi5vcHRpb25zIHx8IFtdKTtcclxuICAgICAgICAgIHF1aWNrQnRuLmlubmVySFRNTCA9IGA8c3BhbiBjbGFzcz1cInN0dWR5LWFzc2lzdC1xdWljay1hbnN3ZXJcIj4ke2Fuc3dlcn08L3NwYW4+YDtcclxuICAgICAgICAgIHF1aWNrQnRuLmNsYXNzTGlzdC5hZGQoXCJoYXMtYW5zd2VyXCIpO1xyXG5cclxuICAgICAgICAgIGlmIChhbnN3ZXIgIT09IFwiP1wiKSB7XHJcbiAgICAgICAgICAgIHN0YXRlLmhhc1ZhbGlkQW5zd2VyID0gdHJ1ZTtcclxuICAgICAgICAgIH1cclxuICAgICAgICAgIHJldHVybjtcclxuICAgICAgICB9XHJcblxyXG4gICAgICAgIC8vIENoZWNrIGZvciBtdWx0aXBsZSBhbnN3ZXJzIChlLmcuLCBcIkEsRFwiIG9yIFwiQSwgRFwiIG9yIFwiQixDLEVcIiBvciBcIkEsRSxHXCIpXHJcbiAgICAgICAgLy8gU3VwcG9ydCBsZXR0ZXJzIEEtSiAodXAgdG8gMTAgb3B0aW9ucylcclxuICAgICAgICBjb25zdCBtdWx0aU1hdGNoID0gdXBwZXJSZXN1bHQubWF0Y2goXHJcbiAgICAgICAgICAvXihbQS1KXSlcXHMqLFxccyooW0EtSl0pKD86XFxzKixcXHMqKFtBLUpdKSk/KD86XFxzKixcXHMqKFtBLUpdKSk/KD86XFxzKixcXHMqKFtBLUpdKSk/JC9cclxuICAgICAgICApO1xyXG5cclxuICAgICAgICBsZXQgYW5zd2VyOiBzdHJpbmc7XHJcbiAgICAgICAgbGV0IGlzTXVsdGlwbGUgPSBmYWxzZTtcclxuXHJcbiAgICAgICAgaWYgKG11bHRpTWF0Y2gpIHtcclxuICAgICAgICAgIC8vIE11bHRpcGxlIGFuc3dlcnMgLSBqb2luIHdpdGggY29tbWFcclxuICAgICAgICAgIGNvbnN0IGxldHRlcnMgPSBbXHJcbiAgICAgICAgICAgIG11bHRpTWF0Y2hbMV0sXHJcbiAgICAgICAgICAgIG11bHRpTWF0Y2hbMl0sXHJcbiAgICAgICAgICAgIG11bHRpTWF0Y2hbM10sXHJcbiAgICAgICAgICAgIG11bHRpTWF0Y2hbNF0sXHJcbiAgICAgICAgICAgIG11bHRpTWF0Y2hbNV0sXHJcbiAgICAgICAgICBdXHJcbiAgICAgICAgICAgIC5maWx0ZXIoQm9vbGVhbilcclxuICAgICAgICAgICAgLmpvaW4oXCIsXCIpO1xyXG4gICAgICAgICAgYW5zd2VyID0gbGV0dGVycztcclxuICAgICAgICAgIGlzTXVsdGlwbGUgPSB0cnVlO1xyXG4gICAgICAgIH0gZWxzZSB7XHJcbiAgICAgICAgICAvLyBTaW5nbGUgYW5zd2VyXHJcbiAgICAgICAgICBjb25zdCBzaW5nbGVNYXRjaCA9IHVwcGVyUmVzdWx0Lm1hdGNoKC9cXGIoW0EtSl0pXFxiLyk7XHJcbiAgICAgICAgICBhbnN3ZXIgPSBzaW5nbGVNYXRjaCA/IHNpbmdsZU1hdGNoWzFdIDogXCI/XCI7XHJcbiAgICAgICAgfVxyXG5cclxuICAgICAgICBxdWlja0J0bi5pbm5lckhUTUwgPSBgPHNwYW4gY2xhc3M9XCJzdHVkeS1hc3Npc3QtcXVpY2stYW5zd2VyXCI+JHthbnN3ZXJ9PC9zcGFuPmA7XHJcbiAgICAgICAgcXVpY2tCdG4uY2xhc3NMaXN0LmFkZChcImhhcy1hbnN3ZXJcIik7XHJcbiAgICAgICAgaWYgKGlzTXVsdGlwbGUpIHtcclxuICAgICAgICAgIHF1aWNrQnRuLmNsYXNzTGlzdC5hZGQoXCJtdWx0aS1hbnN3ZXJcIik7XHJcbiAgICAgICAgICAvLyBBZGQgZXh0cmEtc21hbGwgY2xhc3MgZm9yIDMrIGFuc3dlcnNcclxuICAgICAgICAgIGNvbnN0IGFuc3dlckNvdW50ID0gYW5zd2VyLnNwbGl0KFwiLFwiKS5sZW5ndGg7XHJcbiAgICAgICAgICBpZiAoYW5zd2VyQ291bnQgPj0gMykge1xyXG4gICAgICAgICAgICBxdWlja0J0bi5jbGFzc0xpc3QuYWRkKFwibXVsdGktYW5zd2VyLWxhcmdlXCIpO1xyXG4gICAgICAgICAgfVxyXG4gICAgICAgIH1cclxuXHJcbiAgICAgICAgLy8gTWFyayBhcyB2YWxpZCBhbnN3ZXIgT05MWSBpZiB3ZSBnb3QgYSByZWFsIGFuc3dlciAobm90IFwiP1wiKVxyXG4gICAgICAgIGlmIChhbnN3ZXIgIT09IFwiP1wiKSB7XHJcbiAgICAgICAgICBzdGF0ZS5oYXNWYWxpZEFuc3dlciA9IHRydWU7XHJcbiAgICAgICAgfVxyXG5cclxuICAgICAgICAvLyBObyB0aW1lb3V0IC0gYW5zd2VyIHBlcnNpc3RzIHVudGlsIHF1ZXN0aW9uIGNoYW5nZXNcclxuICAgICAgfVxyXG4gICAgfSBlbHNlIHtcclxuICAgICAgcXVpY2tCdG4uaW5uZXJIVE1MID0gYDxzcGFuPiE8L3NwYW4+YDtcclxuICAgICAgcXVpY2tCdG4uY2xhc3NMaXN0LnJlbW92ZShcInNsb3ctY29ubmVjdGlvblwiKTtcclxuICAgICAgc3RhdGUuaXNSZXF1ZXN0SW5Qcm9ncmVzcyA9IGZhbHNlOyAvLyBSZWxlYXNlIGxvY2tcclxuICAgICAgc2V0VGltZW91dCgoKSA9PiB7XHJcbiAgICAgICAgcXVpY2tCdG4uaW5uZXJIVE1MID0gYDxzcGFuPlNBPC9zcGFuPmA7XHJcbiAgICAgIH0sIDIwMDApO1xyXG4gICAgfVxyXG4gIH0gY2F0Y2ggKGVycm9yKSB7XHJcbiAgICBjb25zb2xlLmVycm9yKFwiW1N0dWR5IEFzc2lzdF0gUXVpY2sgYW5hbHlzaXMgZXJyb3I6XCIsIGVycm9yKTtcclxuXHJcbiAgICAvLyBDbGVhciBzbG93IGNvbm5lY3Rpb24gdGltZXJcclxuICAgIGlmIChzdGF0ZS5zbG93Q29ubmVjdGlvblRpbWVyKSB7XHJcbiAgICAgIGNsZWFyVGltZW91dChzdGF0ZS5zbG93Q29ubmVjdGlvblRpbWVyKTtcclxuICAgICAgc3RhdGUuc2xvd0Nvbm5lY3Rpb25UaW1lciA9IG51bGw7XHJcbiAgICB9XHJcblxyXG4gICAgcXVpY2tCdG4uY2xhc3NMaXN0LnJlbW92ZShcImxvYWRpbmdcIiwgXCJzbG93LWNvbm5lY3Rpb25cIik7XHJcbiAgICBxdWlja0J0bi5pbm5lckhUTUwgPSBgPHNwYW4+ITwvc3Bhbj5gO1xyXG4gICAgc3RhdGUuaXNSZXF1ZXN0SW5Qcm9ncmVzcyA9IGZhbHNlOyAvLyBSZWxlYXNlIGxvY2tcclxuICAgIHNldFRpbWVvdXQoKCkgPT4ge1xyXG4gICAgICBxdWlja0J0bi5pbm5lckhUTUwgPSBgPHNwYW4+U0E8L3NwYW4+YDtcclxuICAgIH0sIDIwMDApO1xyXG4gIH1cclxufVxyXG5cclxuLy8gPT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT1cclxuLy8gRnVsbCBBbmFseXNpcyAoT3ZlcmxheSBNb2RlKVxyXG4vLyA9PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PVxyXG5cclxuLyoqXHJcbiAqIEZ1bGwgYW5hbHlzaXMgZm9yIG92ZXJsYXkgbW9kZVxyXG4gKiBAcGFyYW0gcXVlc3Rpb24gLSBUaGUgcXVlc3Rpb24gb2JqZWN0IHRvIGFuYWx5emVcclxuICogQHBhcmFtIGNhbGxiYWNrcyAtIE9wdGlvbmFsIGNhbGxiYWNrcyBmb3IgdGVzdGluZy9kZXBlbmRlbmN5IGluamVjdGlvblxyXG4gKi9cclxuZXhwb3J0IGFzeW5jIGZ1bmN0aW9uIGFuYWx5emVRdWVzdGlvbihcclxuICBxdWVzdGlvbjogRGV0ZWN0ZWRRdWVzdGlvbixcclxuICBjYWxsYmFja3M6IFF1aWNrQ2xpY2tDYWxsYmFja3MgPSB7XHJcbiAgICBkZXRlY3RWaXNpYmxlUXVlc3Rpb24sXHJcbiAgICBzdGFydFF1ZXN0aW9uQ2hhbmdlT2JzZXJ2ZXIsXHJcbiAgfVxyXG4pOiBQcm9taXNlPHZvaWQ+IHtcclxuICBpZiAoIXN0YXRlLmlzQWN0aXZlKSByZXR1cm47XHJcblxyXG4gIHNob3dMb2FkaW5nKCk7XHJcblxyXG4gIC8vIEV4dHJhY3QgaW1hZ2VzIGJhc2VkIG9uIHBsYXRmb3JtXHJcbiAgbGV0IGltYWdlczogSW1hZ2VEYXRhW10gPSBbXTtcclxuICBpZiAoc3RhdGUuc2V0dGluZ3Muc2VuZEltYWdlcykge1xyXG4gICAgaWYgKHF1ZXN0aW9uLnBsYXRmb3JtID09PSBcIm1vb2RsZVwiKSB7XHJcbiAgICAgIC8vIEZvciBNb29kbGUsIGltYWdlcyBhcmUgYWxyZWFkeSBleHRyYWN0ZWQgaW4gdGhlIHF1ZXN0aW9uIG9iamVjdFxyXG4gICAgICBpZiAocXVlc3Rpb24uaW1hZ2VzICYmIHF1ZXN0aW9uLmltYWdlcy5sZW5ndGggPiAwKSB7XHJcbiAgICAgICAgaW1hZ2VzID0gWy4uLnF1ZXN0aW9uLmltYWdlc107XHJcbiAgICAgIH1cclxuICAgICAgLy8gQWxzbyBhZGQgaW1hZ2VzIGZyb20gb3B0aW9ucyAod2hlbiBhbnN3ZXJzIGFyZSBpbWFnZXMpXHJcbiAgICAgIGlmIChxdWVzdGlvbi5vcHRpb25zKSB7XHJcbiAgICAgICAgZm9yIChjb25zdCBvcHQgb2YgcXVlc3Rpb24ub3B0aW9ucykge1xyXG4gICAgICAgICAgaWYgKG9wdC5pbWFnZSkge1xyXG4gICAgICAgICAgICBpbWFnZXMucHVzaCh7XHJcbiAgICAgICAgICAgICAgLi4ub3B0LmltYWdlLFxyXG4gICAgICAgICAgICAgIGxvY2F0aW9uOiBgb3B0aW9uXyR7b3B0LmxldHRlcn1gIGFzIFwicXVlc3Rpb25cIiB8IFwib3B0aW9uXCIsXHJcbiAgICAgICAgICAgIH0pO1xyXG4gICAgICAgICAgfVxyXG4gICAgICAgIH1cclxuICAgICAgfVxyXG4gICAgfSBlbHNlIGlmIChxdWVzdGlvbi5lbGVtZW50KSB7XHJcbiAgICAgIC8vIEZvciBOZXRBY2FkLCBleHRyYWN0IGZyb20gc2hhZG93IERPTVxyXG4gICAgICAvLyBxdWVyeVNlbGVjdG9yQWxsRGVlcCB0cmF2ZXJzZXMgc2hhZG93IHJvb3RzIGF1dG9tYXRpY2FsbHlcclxuICAgICAgdHJ5IHtcclxuICAgICAgICBpbWFnZXMgPSBhd2FpdCBleHRyYWN0SW1hZ2VzQXNCYXNlNjQocXVlc3Rpb24uZWxlbWVudCk7XHJcbiAgICAgIH0gY2F0Y2ggKGltZ0Vycm9yKSB7XHJcbiAgICAgICAgLy8gU2lsZW50IGZhaWwgZm9yIGltYWdlIGV4dHJhY3Rpb25cclxuICAgICAgfVxyXG4gICAgfVxyXG4gIH1cclxuXHJcbiAgLy8gUHJlcGFyZSBjb250ZXh0IGZvciBhbmFseXNpc1xyXG4gIGxldCBjb250ZXh0OiBBbmFseXNpc0NvbnRleHQ7XHJcbiAgaWYgKHF1ZXN0aW9uLnR5cGUgPT09IFwibWF0Y2hpbmdcIikge1xyXG4gICAgLy8gTWF0Y2hpbmcgcXVlc3Rpb24gY29udGV4dFxyXG4gICAgY29udGV4dCA9IHtcclxuICAgICAgcXVlc3Rpb25UZXh0OiBxdWVzdGlvbi50ZXh0LFxyXG4gICAgICBxdWVzdGlvblR5cGU6IFwibWF0Y2hpbmdcIixcclxuICAgICAgbWF0Y2hpbmdTdHlsZTogcXVlc3Rpb24ubWF0Y2hpbmdTdHlsZSB8fCBcImRyYWctZHJvcFwiLCAvLyBcImRyb3Bkb3duXCIgb3IgXCJkcmFnLWRyb3BcIlxyXG4gICAgICBjYXRlZ29yaWVzOiBxdWVzdGlvbi5jYXRlZ29yaWVzLFxyXG4gICAgICBtYXRjaGluZ09wdGlvbnM6IHF1ZXN0aW9uLm1hdGNoaW5nT3B0aW9ucyxcclxuICAgICAgaW1hZ2VzOiBpbWFnZXMsXHJcbiAgICAgIHBhZ2VUaXRsZTogZG9jdW1lbnQudGl0bGUsXHJcbiAgICAgIHBhZ2VVcmw6IHdpbmRvdy5sb2NhdGlvbi5ocmVmLFxyXG4gICAgICByZXNwb25zZU1vZGU6IHN0YXRlLnNldHRpbmdzLnJlc3BvbnNlTW9kZSxcclxuICAgICAgY291cnNlTmFtZTogcXVlc3Rpb24uY291cnNlTmFtZSwgLy8gQWNhZGVtaWMgY291cnNlIGZvciBjb250ZXh0XHJcbiAgICAgIHFhTW9kZTogaXNRQVNhbmRib3hBY3RpdmUoKSxcclxuICAgIH07XHJcbiAgfSBlbHNlIGlmIChxdWVzdGlvbi50eXBlID09PSBcInNlbGVjdC1taXNzaW5nLXdvcmRzXCIpIHtcclxuICAgIGNvbnRleHQgPSB7XHJcbiAgICAgIHF1ZXN0aW9uVGV4dDogcXVlc3Rpb24udGV4dCxcclxuICAgICAgcXVlc3Rpb25UeXBlOiBcInNlbGVjdC1taXNzaW5nLXdvcmRzXCIsXHJcbiAgICAgIHNlbGVjdEdhcHM6IHF1ZXN0aW9uLnNlbGVjdEdhcHMsXHJcbiAgICAgIHNlbGVjdENob2ljZXM6IHF1ZXN0aW9uLnNlbGVjdENob2ljZXMsXHJcbiAgICAgIGltYWdlczogaW1hZ2VzLFxyXG4gICAgICBwYWdlVGl0bGU6IGRvY3VtZW50LnRpdGxlLFxyXG4gICAgICBwYWdlVXJsOiB3aW5kb3cubG9jYXRpb24uaHJlZixcclxuICAgICAgcmVzcG9uc2VNb2RlOiBzdGF0ZS5zZXR0aW5ncy5yZXNwb25zZU1vZGUsXHJcbiAgICAgIGNvdXJzZU5hbWU6IHF1ZXN0aW9uLmNvdXJzZU5hbWUsXHJcbiAgICAgIHFhTW9kZTogaXNRQVNhbmRib3hBY3RpdmUoKSxcclxuICAgIH07XHJcbiAgfSBlbHNlIGlmIChxdWVzdGlvbi50eXBlID09PSBcInNob3J0LWFuc3dlclwiIHx8IHF1ZXN0aW9uLnR5cGUgPT09IFwibnVtZXJpY2FsXCIpIHtcclxuICAgIGNvbnRleHQgPSB7XHJcbiAgICAgIHF1ZXN0aW9uVGV4dDogcXVlc3Rpb24udGV4dCxcclxuICAgICAgcXVlc3Rpb25UeXBlOiBxdWVzdGlvbi50eXBlLFxyXG4gICAgICBpbWFnZXM6IGltYWdlcyxcclxuICAgICAgcGFnZVRpdGxlOiBkb2N1bWVudC50aXRsZSxcclxuICAgICAgcGFnZVVybDogd2luZG93LmxvY2F0aW9uLmhyZWYsXHJcbiAgICAgIHJlc3BvbnNlTW9kZTogc3RhdGUuc2V0dGluZ3MucmVzcG9uc2VNb2RlLFxyXG4gICAgICBjb3Vyc2VOYW1lOiBxdWVzdGlvbi5jb3Vyc2VOYW1lLFxyXG4gICAgICBxYU1vZGU6IGlzUUFTYW5kYm94QWN0aXZlKCksXHJcbiAgICB9O1xyXG4gIH0gZWxzZSB7XHJcbiAgICAvLyBSZWd1bGFyIG11bHRpcGxlIGNob2ljZSBjb250ZXh0XHJcbiAgICBjb250ZXh0ID0ge1xyXG4gICAgICBxdWVzdGlvblRleHQ6IHF1ZXN0aW9uLnRleHQsXHJcbiAgICAgIHF1ZXN0aW9uVHlwZTogcXVlc3Rpb24udHlwZSA9PT0gXCJ0cnVlLWZhbHNlXCIgPyBcInRydWUtZmFsc2VcIiA6IFwibXVsdGlwbGUtY2hvaWNlXCIsXHJcbiAgICAgIG9wdGlvbnM6IHF1ZXN0aW9uLm9wdGlvbnMsXHJcbiAgICAgIGltYWdlczogaW1hZ2VzLFxyXG4gICAgICBwYWdlVGl0bGU6IGRvY3VtZW50LnRpdGxlLFxyXG4gICAgICBwYWdlVXJsOiB3aW5kb3cubG9jYXRpb24uaHJlZixcclxuICAgICAgcmVzcG9uc2VNb2RlOiBzdGF0ZS5zZXR0aW5ncy5yZXNwb25zZU1vZGUsXHJcbiAgICAgIGNvdXJzZU5hbWU6IHF1ZXN0aW9uLmNvdXJzZU5hbWUsIC8vIEFjYWRlbWljIGNvdXJzZSBmb3IgY29udGV4dFxyXG4gICAgICBxYU1vZGU6IGlzUUFTYW5kYm94QWN0aXZlKCksXHJcbiAgICB9O1xyXG4gIH1cclxuXHJcbiAgdHJ5IHtcclxuICAgIC8vIFNlbmQgdG8gYmFja2dyb3VuZCBzY3JpcHQgZm9yIEFQSSBwcm9jZXNzaW5nXHJcbiAgICAvLyBVc2Ugc3RyZWFtaW5nIHZpYSBwb3J0IGZvciBmdWxsIChub24tcXVpY2spIG1vZGVcclxuICAgIGNvbnN0IHBvcnQgPSAoY2hyb21lLnJ1bnRpbWUgYXMgdW5rbm93biBhcyB7IGNvbm5lY3Q6IChpbmZvOiB7IG5hbWU6IHN0cmluZyB9KSA9PiB7IHBvc3RNZXNzYWdlOiAobXNnOiB1bmtub3duKSA9PiB2b2lkOyBvbk1lc3NhZ2U6IHsgYWRkTGlzdGVuZXI6IChjYjogKG1zZzogUmVjb3JkPHN0cmluZywgdW5rbm93bj4pID0+IHZvaWQpID0+IHZvaWQgfTsgb25EaXNjb25uZWN0OiB7IGFkZExpc3RlbmVyOiAoY2I6ICgpID0+IHZvaWQpID0+IHZvaWQgfTsgZGlzY29ubmVjdDogKCkgPT4gdm9pZCB9IH0pLmNvbm5lY3QoeyBuYW1lOiBcInN0cmVhbS1hbmFseXNpc1wiIH0pO1xyXG5cclxuICAgIGRpc3BsYXlBbmFseXNpc1Jlc3VsdFN0cmVhbWluZyhcIlwiLCBxdWVzdGlvbiwgY2FsbGJhY2tzLnNob3dRdWVzdGlvbnNTdW1tYXJ5LCB0cnVlKTtcclxuXHJcbiAgICBsZXQgZnVsbFRleHQgPSBcIlwiO1xyXG4gICAgbGV0IHN0cmVhbUlucHV0VG9rZW5zID0gMDtcclxuICAgIGxldCBzdHJlYW1PdXRwdXRUb2tlbnMgPSAwO1xyXG4gICAgbGV0IHN0cmVhbUNvc3QgPSAwO1xyXG5cclxuICAgIGF3YWl0IG5ldyBQcm9taXNlPHZvaWQ+KChyZXNvbHZlLCByZWplY3QpID0+IHtcclxuICAgICAgcG9ydC5vbk1lc3NhZ2UuYWRkTGlzdGVuZXIoKG1zZzogUmVjb3JkPHN0cmluZywgdW5rbm93bj4pID0+IHtcclxuICAgICAgICBzd2l0Y2ggKG1zZy50eXBlKSB7XHJcbiAgICAgICAgICBjYXNlIFwiU1RSRUFNX0NIVU5LXCI6XHJcbiAgICAgICAgICAgIGZ1bGxUZXh0ICs9IG1zZy5jaHVuayBhcyBzdHJpbmc7XHJcbiAgICAgICAgICAgIGRpc3BsYXlBbmFseXNpc1Jlc3VsdFN0cmVhbWluZyhmdWxsVGV4dCwgcXVlc3Rpb24sIGNhbGxiYWNrcy5zaG93UXVlc3Rpb25zU3VtbWFyeSwgZmFsc2UpO1xyXG4gICAgICAgICAgICBicmVhaztcclxuICAgICAgICAgIGNhc2UgXCJTVFJFQU1fU1RBVFVTXCI6XHJcbiAgICAgICAgICAgIGlmIChtc2cuc3RhdHVzID09PSBcImlucHV0X3Rva2Vuc1wiKSB7XHJcbiAgICAgICAgICAgICAgc3RyZWFtSW5wdXRUb2tlbnMgPSBtc2cuaW5wdXRUb2tlbnMgYXMgbnVtYmVyO1xyXG4gICAgICAgICAgICB9XHJcbiAgICAgICAgICAgIGlmIChtc2cuc3RhdHVzID09PSBcImNvbXBsZXRlXCIpIHtcclxuICAgICAgICAgICAgICBzdHJlYW1PdXRwdXRUb2tlbnMgPSBtc2cub3V0cHV0VG9rZW5zIGFzIG51bWJlcjtcclxuICAgICAgICAgICAgfVxyXG4gICAgICAgICAgICBicmVhaztcclxuICAgICAgICAgIGNhc2UgXCJTVFJFQU1fQ09NUExFVEVcIjpcclxuICAgICAgICAgICAgc3RyZWFtSW5wdXRUb2tlbnMgPSBtc2cuaW5wdXRUb2tlbnMgYXMgbnVtYmVyIHx8IHN0cmVhbUlucHV0VG9rZW5zO1xyXG4gICAgICAgICAgICBzdHJlYW1PdXRwdXRUb2tlbnMgPSBtc2cub3V0cHV0VG9rZW5zIGFzIG51bWJlciB8fCBzdHJlYW1PdXRwdXRUb2tlbnM7XHJcbiAgICAgICAgICAgIHN0cmVhbUNvc3QgPSBtc2cuY29zdCBhcyBudW1iZXIgfHwgMDtcclxuICAgICAgICAgICAgaGlkZUxvYWRpbmcoKTtcclxuICAgICAgICAgICAgZGlzcGxheUFuYWx5c2lzUmVzdWx0U3RyZWFtaW5nKFxyXG4gICAgICAgICAgICAgIGZ1bGxUZXh0LFxyXG4gICAgICAgICAgICAgIHF1ZXN0aW9uLFxyXG4gICAgICAgICAgICAgIGNhbGxiYWNrcy5zaG93UXVlc3Rpb25zU3VtbWFyeSxcclxuICAgICAgICAgICAgICBmYWxzZSxcclxuICAgICAgICAgICAgICB7IGlucHV0VG9rZW5zOiBzdHJlYW1JbnB1dFRva2Vucywgb3V0cHV0VG9rZW5zOiBzdHJlYW1PdXRwdXRUb2tlbnMsIGNvc3Q6IHN0cmVhbUNvc3QgfSxcclxuICAgICAgICAgICAgKTtcclxuICAgICAgICAgICAgcmVzb2x2ZSgpO1xyXG4gICAgICAgICAgICBicmVhaztcclxuICAgICAgICAgIGNhc2UgXCJTVFJFQU1fRVJST1JcIjpcclxuICAgICAgICAgICAgaGlkZUxvYWRpbmcoKTtcclxuICAgICAgICAgICAgZGlzcGxheUVycm9yKG1zZy5lcnJvciBhcyBzdHJpbmcgfHwgXCJFcnJvciBkZSB0cmFuc21pc2lcdTAwRjNuXCIsIGNhbGxiYWNrcy5zaG93UXVlc3Rpb25zU3VtbWFyeSk7XHJcbiAgICAgICAgICAgIHJlamVjdChuZXcgRXJyb3IobXNnLmVycm9yIGFzIHN0cmluZykpO1xyXG4gICAgICAgICAgICBicmVhaztcclxuICAgICAgICB9XHJcbiAgICAgIH0pO1xyXG5cclxuICAgICAgcG9ydC5vbkRpc2Nvbm5lY3QuYWRkTGlzdGVuZXIoKCkgPT4ge1xyXG4gICAgICAgIGlmICghZnVsbFRleHQpIHtcclxuICAgICAgICAgIGhpZGVMb2FkaW5nKCk7XHJcbiAgICAgICAgICBkaXNwbGF5RXJyb3IoXCJDb25leGlcdTAwRjNuIHBlcmRpZGFcIiwgY2FsbGJhY2tzLnNob3dRdWVzdGlvbnNTdW1tYXJ5KTtcclxuICAgICAgICAgIHJlamVjdChuZXcgRXJyb3IoXCJQdWVydG8gZGVzY29uZWN0YWRvXCIpKTtcclxuICAgICAgICB9IGVsc2Uge1xyXG4gICAgICAgICAgcmVzb2x2ZSgpO1xyXG4gICAgICAgIH1cclxuICAgICAgfSk7XHJcblxyXG4gICAgICBwb3J0LnBvc3RNZXNzYWdlKHsgY29udGV4dCB9KTtcclxuICAgIH0pO1xyXG4gIH0gY2F0Y2ggKGVycm9yKSB7XHJcbiAgICBoaWRlTG9hZGluZygpO1xyXG4gICAgZGlzcGxheUVycm9yKChlcnJvciBhcyBFcnJvcikubWVzc2FnZSwgY2FsbGJhY2tzLnNob3dRdWVzdGlvbnNTdW1tYXJ5KTtcclxuICB9XHJcbn1cclxuIiwgIi8qKlxyXG4gKiBTdHVkeSBBc3Npc3QgLSBDb250ZW50IFNjcmlwdCBFbnRyeSBQb2ludFxyXG4gKiBJbml0aWFsaXplcyB0aGUgZXh0ZW5zaW9uIGFuZCB3aXJlcyBtb2R1bGVzIHRvZ2V0aGVyXHJcbiAqL1xyXG5cclxuLy8gPT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT1cclxuLy8gTW9kdWxlIEltcG9ydHNcclxuLy8gPT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT1cclxuaW1wb3J0IHsgbG9nLCBzdGF0ZSwgREVGQVVMVF9BTExPV0VEX0RPTUFJTlMgfSBmcm9tIFwiLi9tb2R1bGVzL3N0YXRlLmpzXCI7XHJcbmltcG9ydCB7XHJcbiAgZGV0ZWN0UXVlc3Rpb25zT25QYWdlLFxyXG4gIGRldGVjdFZpc2libGVRdWVzdGlvbixcclxuICByZWZyZXNoQ3VycmVudFF1ZXN0aW9uLFxyXG4gIGZyYW1lSGFzUXVpekNvbnRlbnQsXHJcbiAgd2FpdEZvclF1aXpDb250ZW50LFxyXG59IGZyb20gXCIuL21vZHVsZXMvZGV0ZWN0aW9uLmpzXCI7XHJcbmltcG9ydCB7XHJcbiAgc2hvd1JlbG9hZFByb21wdCxcclxuICBjcmVhdGVPdmVybGF5Q29udGFpbmVyLFxyXG4gIGNyZWF0ZVF1aWNrQnV0dG9uLFxyXG4gIGhpZ2hsaWdodERldGVjdGVkUXVlc3Rpb25zLFxyXG4gIGNsZWFyQWxsSGlnaGxpZ2h0cyxcclxuICBoaWRlT3ZlcmxheSxcclxuICBkaXNwbGF5QW5hbHlzaXNSZXN1bHQsXHJcbiAgcmVzZXRRdWlja0Fuc3dlcixcclxuICB0b2dnbGVTQUJ1dHRvblZpc2liaWxpdHksXHJcbiAgZGlzcGxheVNpbmdsZVF1ZXN0aW9uLFxyXG4gIHNob3dRdWVzdGlvbnNTdW1tYXJ5LFxyXG59IGZyb20gXCIuL21vZHVsZXMvdWkuanNcIjtcclxuaW1wb3J0IHsgc2V0dXBLZXlib2FyZEhhbmRsZXJzIH0gZnJvbSBcIi4vbW9kdWxlcy9rZXlib2FyZC5qc1wiO1xyXG5pbXBvcnQge1xyXG4gIGhhbmRsZVF1aWNrQ2xpY2ssXHJcbiAgcmVsb2FkUXVpY2tNb2RlLFxyXG4gIHRyaWdnZXJRdWlja0FuYWx5c2lzLFxyXG4gIGNhbmNlbEN1cnJlbnRSZXF1ZXN0LFxyXG4gIGFuYWx5emVRdWVzdGlvbixcclxuICBzdGFydFF1ZXN0aW9uQ2hhbmdlT2JzZXJ2ZXIsXHJcbn0gZnJvbSBcIi4vbW9kdWxlcy9hcGkuanNcIjtcclxuXHJcbmltcG9ydCB0eXBlIHsgRGV0ZWN0ZWRRdWVzdGlvbiwgU2V0dGluZ3MgfSBmcm9tIFwiLi4vdHlwZXMvaW5kZXguanNcIjtcclxuXHJcbi8vID09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09XHJcbi8vIERvbWFpbiBDaGVja1xyXG4vLyA9PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PVxyXG5hc3luYyBmdW5jdGlvbiBjaGVja0RvbWFpbkFsbG93ZWQoKTogUHJvbWlzZTxib29sZWFuPiB7XHJcbiAgdHJ5IHtcclxuICAgIGNvbnN0IHJlc3VsdCA9IGF3YWl0IGNocm9tZS5zdG9yYWdlLmxvY2FsLmdldChbXCJhbGxvd2VkRG9tYWluc1wiXSk7XHJcbiAgICBjb25zdCBhbGxvd2VkRG9tYWluczogc3RyaW5nW10gPSByZXN1bHQuYWxsb3dlZERvbWFpbnMgPz8gREVGQVVMVF9BTExPV0VEX0RPTUFJTlM7XHJcblxyXG4gICAgY29uc3QgY3VycmVudEhvc3RuYW1lID0gd2luZG93LmxvY2F0aW9uLmhvc3RuYW1lLnRvTG93ZXJDYXNlKCk7XHJcblxyXG4gICAgY29uc3QgaXNBbGxvd2VkID0gYWxsb3dlZERvbWFpbnMuc29tZSgoZG9tYWluOiBzdHJpbmcpID0+IHtcclxuICAgICAgcmV0dXJuIChcclxuICAgICAgICBjdXJyZW50SG9zdG5hbWUgPT09IGRvbWFpbiB8fCBjdXJyZW50SG9zdG5hbWUuZW5kc1dpdGgoXCIuXCIgKyBkb21haW4pXHJcbiAgICAgICk7XHJcbiAgICB9KTtcclxuXHJcbiAgICBzdGF0ZS5pc0RvbWFpbkFsbG93ZWQgPSBpc0FsbG93ZWQ7XHJcbiAgICByZXR1cm4gaXNBbGxvd2VkO1xyXG4gIH0gY2F0Y2ggKGVycm9yKSB7XHJcbiAgICBjb25zb2xlLmVycm9yKFwiW1N0dWR5IEFzc2lzdF0gRXJyb3IgY2hlY2tpbmcgZG9tYWluOlwiLCBlcnJvcik7XHJcbiAgICByZXR1cm4gZmFsc2U7XHJcbiAgfVxyXG59XHJcblxyXG4vLyA9PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PVxyXG4vLyBDb250ZW50IE9ic2VydmVyXHJcbi8vID09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09XHJcbmZ1bmN0aW9uIHNldHVwQ29udGVudE9ic2VydmVyKCk6IHZvaWQge1xyXG4gIGlmIChzdGF0ZS5jb250ZW50T2JzZXJ2ZXIpIHJldHVybjtcclxuXHJcbiAgbGV0IGRlYm91bmNlVGltZXI6IFJldHVyblR5cGU8dHlwZW9mIHNldFRpbWVvdXQ+IHwgbnVsbCA9IG51bGw7XHJcblxyXG4gIHN0YXRlLmNvbnRlbnRPYnNlcnZlciA9IG5ldyBNdXRhdGlvbk9ic2VydmVyKChfbXV0YXRpb25zOiBNdXRhdGlvblJlY29yZFtdKSA9PiB7XHJcbiAgICBpZiAoZGVib3VuY2VUaW1lcikgY2xlYXJUaW1lb3V0KGRlYm91bmNlVGltZXIpO1xyXG4gICAgZGVib3VuY2VUaW1lciA9IHNldFRpbWVvdXQoKCkgPT4ge1xyXG4gICAgICBpZiAoXHJcbiAgICAgICAgc3RhdGUuc2V0dGluZ3MucXVpY2tNb2RlICYmXHJcbiAgICAgICAgIWRvY3VtZW50LmdldEVsZW1lbnRCeUlkKFwic3R1ZHktYXNzaXN0LXF1aWNrLWNvbnRhaW5lclwiKVxyXG4gICAgICApIHtcclxuICAgICAgICBpZiAoZnJhbWVIYXNRdWl6Q29udGVudCgpKSB7XHJcbiAgICAgICAgICBpbml0UXVpY2tCdXR0b24oKTtcclxuICAgICAgICB9XHJcbiAgICAgIH1cclxuICAgIH0sIDUwMCk7XHJcbiAgfSk7XHJcblxyXG4gIHN0YXRlLmNvbnRlbnRPYnNlcnZlci5vYnNlcnZlKGRvY3VtZW50LmJvZHkgPz8gZG9jdW1lbnQuZG9jdW1lbnRFbGVtZW50LCB7XHJcbiAgICBjaGlsZExpc3Q6IHRydWUsXHJcbiAgICBzdWJ0cmVlOiB0cnVlLFxyXG4gIH0pO1xyXG59XHJcblxyXG4vLyA9PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PVxyXG4vLyBRdWljayBCdXR0b24gSW5pdGlhbGl6YXRpb24gd2l0aCBDYWxsYmFja3NcclxuLy8gPT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT1cclxuZnVuY3Rpb24gaW5pdFF1aWNrQnV0dG9uKCk6IHZvaWQge1xyXG4gIGNyZWF0ZVF1aWNrQnV0dG9uKHtcclxuICAgIGhhbmRsZVF1aWNrQ2xpY2s6IChlOiBNb3VzZUV2ZW50KSA9PlxyXG4gICAgICBoYW5kbGVRdWlja0NsaWNrKGUsIHtcclxuICAgICAgICBkZXRlY3RWaXNpYmxlUXVlc3Rpb24sXHJcbiAgICAgICAgc3RhcnRRdWVzdGlvbkNoYW5nZU9ic2VydmVyLFxyXG4gICAgICB9KSxcclxuICB9KTtcclxufVxyXG5cclxuLy8gPT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT1cclxuLy8gQ2FsbGJhY2sgd3JhcHBlcnNcclxuLy8gPT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT1cclxuXHJcbi8qKiBBbmFseXplIGEgcXVlc3Rpb24gd2l0aCBwcm9wZXIgY2FsbGJhY2sgd2lyaW5nICovXHJcbmZ1bmN0aW9uIGFuYWx5emVRdWVzdGlvbldpdGhDYWxsYmFja3MocXVlc3Rpb246IERldGVjdGVkUXVlc3Rpb24pOiBQcm9taXNlPHZvaWQ+IHtcclxuICByZXR1cm4gYW5hbHl6ZVF1ZXN0aW9uKHF1ZXN0aW9uLCB7XHJcbiAgICBkZXRlY3RWaXNpYmxlUXVlc3Rpb24sXHJcbiAgICBzdGFydFF1ZXN0aW9uQ2hhbmdlT2JzZXJ2ZXIsXHJcbiAgICBzaG93UXVlc3Rpb25zU3VtbWFyeTogc2hvd1F1ZXN0aW9uc1N1bW1hcnlXaXRoQ2FsbGJhY2tzLFxyXG4gIH0pO1xyXG59XHJcblxyXG4vKiogU2hvdyBxdWVzdGlvbnMgc3VtbWFyeSB3aXRoIHByb3BlciBjYWxsYmFjayB3aXJpbmcgKi9cclxuZnVuY3Rpb24gc2hvd1F1ZXN0aW9uc1N1bW1hcnlXaXRoQ2FsbGJhY2tzKCk6IFByb21pc2U8dm9pZD4ge1xyXG4gIHJldHVybiBzaG93UXVlc3Rpb25zU3VtbWFyeShkZXRlY3RWaXNpYmxlUXVlc3Rpb24sIGFuYWx5emVRdWVzdGlvbldpdGhDYWxsYmFja3MpO1xyXG59XHJcblxyXG4vLyA9PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PVxyXG4vLyBPdmVybGF5IENvbnRhaW5lciBJbml0aWFsaXphdGlvbiB3aXRoIENhbGxiYWNrc1xyXG4vLyA9PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PVxyXG5mdW5jdGlvbiBpbml0T3ZlcmxheUNvbnRhaW5lcigpOiB2b2lkIHtcclxuICBjcmVhdGVPdmVybGF5Q29udGFpbmVyKHtcclxuICAgIGZyYW1lSGFzUXVpekNvbnRlbnQsXHJcbiAgICB3YWl0Rm9yUXVpekNvbnRlbnQsXHJcbiAgICBoYW5kbGVRdWlja0NsaWNrOiAoZTogTW91c2VFdmVudCkgPT5cclxuICAgICAgaGFuZGxlUXVpY2tDbGljayhlLCB7XHJcbiAgICAgICAgZGV0ZWN0VmlzaWJsZVF1ZXN0aW9uLFxyXG4gICAgICAgIHN0YXJ0UXVlc3Rpb25DaGFuZ2VPYnNlcnZlcixcclxuICAgICAgfSksXHJcbiAgICBzaG93UXVlc3Rpb25zU3VtbWFyeTogc2hvd1F1ZXN0aW9uc1N1bW1hcnlXaXRoQ2FsbGJhY2tzLFxyXG4gIH0pO1xyXG59XHJcblxyXG4vLyA9PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PVxyXG4vLyBLZXlib2FyZCBTZXR1cCB3aXRoIENhbGxiYWNrc1xyXG4vLyA9PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PVxyXG5mdW5jdGlvbiBpbml0S2V5Ym9hcmRIYW5kbGVycygpOiB2b2lkIHtcclxuICBzZXR1cEtleWJvYXJkSGFuZGxlcnMoe1xyXG4gICAgdHJpZ2dlclF1aWNrQW5hbHlzaXM6ICgpID0+XHJcbiAgICAgIHRyaWdnZXJRdWlja0FuYWx5c2lzKHtcclxuICAgICAgICBkZXRlY3RWaXNpYmxlUXVlc3Rpb24sXHJcbiAgICAgICAgc3RhcnRRdWVzdGlvbkNoYW5nZU9ic2VydmVyLFxyXG4gICAgICB9KSxcclxuICAgIHJlbG9hZFF1aWNrTW9kZTogKCkgPT5cclxuICAgICAgcmVsb2FkUXVpY2tNb2RlKHtcclxuICAgICAgICBkZXRlY3RWaXNpYmxlUXVlc3Rpb24sXHJcbiAgICAgICAgc3RhcnRRdWVzdGlvbkNoYW5nZU9ic2VydmVyLFxyXG4gICAgICB9KSxcclxuICAgIHRvZ2dsZVNBQnV0dG9uVmlzaWJpbGl0eSxcclxuICAgIGNhbmNlbEN1cnJlbnRSZXF1ZXN0LFxyXG4gIH0pO1xyXG59XHJcblxyXG4vLyA9PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PVxyXG4vLyBEZXRlY3Rpb24gd2l0aCBDYWxsYmFja3NcclxuLy8gPT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT1cclxuYXN5bmMgZnVuY3Rpb24gcnVuRGV0ZWN0aW9uKCk6IFByb21pc2U8dm9pZD4ge1xyXG4gIGNvbnN0IHJlc3VsdCA9IGF3YWl0IGRldGVjdFF1ZXN0aW9uc09uUGFnZSgpO1xyXG4gIFxyXG4gIGlmIChyZXN1bHQgJiYgcmVzdWx0LmZvdW5kKSB7XHJcbiAgICBpZiAoc3RhdGUuc2V0dGluZ3MuaGlnaGxpZ2h0UXVlc3Rpb25zKSB7XHJcbiAgICAgIGhpZ2hsaWdodERldGVjdGVkUXVlc3Rpb25zKGFuYWx5emVRdWVzdGlvbldpdGhDYWxsYmFja3MpO1xyXG4gICAgfVxyXG4gICAgLy8gSW4gbm9uLXF1aWNrIG1vZGUsIGF1dG8tc2hvdyB0aGUgb3ZlcmxheSB3aXRoIHRoZSBkZXRlY3RlZCBxdWVzdGlvblxyXG4gICAgaWYgKCFzdGF0ZS5zZXR0aW5ncy5xdWlja01vZGUpIHtcclxuICAgICAgYXdhaXQgc2hvd1F1ZXN0aW9uc1N1bW1hcnlXaXRoQ2FsbGJhY2tzKCk7XHJcbiAgICB9XHJcbiAgfVxyXG59XHJcblxyXG4vLyA9PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PVxyXG4vLyBJbml0aWFsaXphdGlvblxyXG4vLyA9PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PVxyXG5hc3luYyBmdW5jdGlvbiBpbml0aWFsaXplKCk6IFByb21pc2U8dm9pZD4ge1xyXG4gIHRyeSB7XHJcbiAgICBjb25zdCBkb21haW5BbGxvd2VkID0gYXdhaXQgY2hlY2tEb21haW5BbGxvd2VkKCk7XHJcbiAgICBpZiAoIWRvbWFpbkFsbG93ZWQpIHtcclxuICAgICAgcmV0dXJuO1xyXG4gICAgfVxyXG5cclxuICAgIGNvbnN0IHJlc3VsdCA9IGF3YWl0IGNocm9tZS5zdG9yYWdlLmxvY2FsLmdldChbXHJcbiAgICAgIFwiZXh0ZW5zaW9uQWN0aXZlXCIsXHJcbiAgICAgIFwicmVzcG9uc2VNb2RlXCIsXHJcbiAgICAgIFwiYXV0b0RldGVjdFwiLFxyXG4gICAgICBcImhpZ2hsaWdodFF1ZXN0aW9uc1wiLFxyXG4gICAgICBcInF1aWNrTW9kZVwiLFxyXG4gICAgICBcInNlbmRJbWFnZXNcIixcclxuICAgICAgXCJidXR0b25Qb3NpdGlvblwiLFxyXG4gICAgXSk7XHJcblxyXG4gICAgc3RhdGUuaXNBY3RpdmUgPSByZXN1bHQuZXh0ZW5zaW9uQWN0aXZlID8/IGZhbHNlO1xyXG5cclxuICAgIGlmICghc3RhdGUuaXNBY3RpdmUpIHtcclxuICAgICAgcmV0dXJuO1xyXG4gICAgfVxyXG5cclxuICAgIHN0YXRlLnNldHRpbmdzLnJlc3BvbnNlTW9kZSA9IHJlc3VsdC5yZXNwb25zZU1vZGUgPz8gXCJndWlkZWRcIjtcclxuICAgIHN0YXRlLnNldHRpbmdzLmF1dG9EZXRlY3QgPSByZXN1bHQuYXV0b0RldGVjdCA/PyB0cnVlO1xyXG4gICAgc3RhdGUuc2V0dGluZ3MuaGlnaGxpZ2h0UXVlc3Rpb25zID0gcmVzdWx0LmhpZ2hsaWdodFF1ZXN0aW9ucyA/PyB0cnVlO1xyXG4gICAgc3RhdGUuc2V0dGluZ3MucXVpY2tNb2RlID0gcmVzdWx0LnF1aWNrTW9kZSA/PyBmYWxzZTtcclxuICAgIHN0YXRlLnNldHRpbmdzLnNlbmRJbWFnZXMgPSByZXN1bHQuc2VuZEltYWdlcyA/PyBmYWxzZTtcclxuICAgIHN0YXRlLnNldHRpbmdzLmJ1dHRvblBvc2l0aW9uID0gcmVzdWx0LmJ1dHRvblBvc2l0aW9uID8/IFwiYm90dG9tLXJpZ2h0XCI7XHJcblxyXG4gICAgc3RhdGUuaXNJbml0aWFsaXplZCA9IHRydWU7XHJcblxyXG4gICAgdHJ5IHtcclxuICAgICAgaWYgKHN0YXRlLnNldHRpbmdzLnF1aWNrTW9kZSkge1xyXG4gICAgICAgIGluaXRLZXlib2FyZEhhbmRsZXJzKCk7XHJcbiAgICAgIH1cclxuICAgIH0gY2F0Y2ggKGtiRXJyKSB7XHJcbiAgICAgIGNvbnNvbGUuZXJyb3IoXCJbU3R1ZHkgQXNzaXN0XSBLZXlib2FyZCBpbml0IGVycm9yOlwiLCBrYkVycik7XHJcbiAgICB9XHJcblxyXG4gICAgdHJ5IHtcclxuICAgICAgaW5pdE92ZXJsYXlDb250YWluZXIoKTtcclxuICAgIH0gY2F0Y2ggKG92RXJyKSB7XHJcbiAgICAgIGNvbnNvbGUuZXJyb3IoXCJbU3R1ZHkgQXNzaXN0XSBPdmVybGF5IGluaXQgZXJyb3I6XCIsIG92RXJyKTtcclxuICAgIH1cclxuXHJcbiAgICBpZiAoc3RhdGUuaXNBY3RpdmUgJiYgc3RhdGUuc2V0dGluZ3MuYXV0b0RldGVjdCkge1xyXG4gICAgICBzZXRUaW1lb3V0KCgpID0+IHJ1bkRldGVjdGlvbigpLCAxMDAwKTtcclxuICAgIH1cclxuXHJcbiAgICB0cnkge1xyXG4gICAgICBzZXR1cENvbnRlbnRPYnNlcnZlcigpO1xyXG4gICAgfSBjYXRjaCAob2JzRXJyKSB7XHJcbiAgICAgIGNvbnNvbGUuZXJyb3IoXCJbU3R1ZHkgQXNzaXN0XSBPYnNlcnZlciBpbml0IGVycm9yOlwiLCBvYnNFcnIpO1xyXG4gICAgfVxyXG4gIH0gY2F0Y2ggKGVycm9yKSB7XHJcbiAgICBjb25zb2xlLmVycm9yKFwiW1N0dWR5IEFzc2lzdF0gSW5pdGlhbGl6YXRpb24gZXJyb3I6XCIsIGVycm9yKTtcclxuICB9XHJcbn1cclxuXHJcbi8vID09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09XHJcbi8vIFFBIFNhbmRib3ggKE1hbnVhbCBUZXN0aW5nKVxyXG4vLyA9PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PVxyXG5cclxudHlwZSBRQVNjZW5hcmlvVHlwZSA9XHJcbiAgfCBcIm1vb2RsZS1tY3FcIlxyXG4gIHwgXCJtb29kbGUtdHJ1ZWZhbHNlXCJcclxuICB8IFwibW9vZGxlLW1hdGNoXCJcclxuICB8IFwibW9vZGxlLXNob3J0YW5zd2VyXCJcclxuICB8IFwibW9vZGxlLW51bWVyaWNhbFwiXHJcbiAgfCBcIm1vb2RsZS1nYXBzZWxlY3RcIlxyXG4gIHwgXCJtb29kbGUtcXVpelwiXHJcbiAgfCBcIm5ldGFjYWQtbWNxXCJcclxuICB8IFwibmV0YWNhZC1tYXRjaGluZ1wiXHJcbiAgfCBcIm5ldGFjYWQtcXVpelwiO1xyXG5cclxuZnVuY3Rpb24gY2xlYXJRQVNhbmRib3goKTogdm9pZCB7XHJcbiAgY29uc3Qgc2FuZGJveCA9IGRvY3VtZW50LmdldEVsZW1lbnRCeUlkKFwic3R1ZHktYXNzaXN0LXFhLXNhbmRib3hcIik7XHJcbiAgaWYgKHNhbmRib3gpIHNhbmRib3gucmVtb3ZlKCk7XHJcbn1cclxuXHJcbmZ1bmN0aW9uIGluamVjdE5ldEFjYWRNY3EodGFyZ2V0OiBIVE1MRWxlbWVudCk6IHZvaWQge1xyXG4gIHRhcmdldC5pbm5lckhUTUwgPSBgXHJcbiAgICA8ZGl2IGNsYXNzPVwicWEtYmxvY2tcIj5cclxuICAgICAgPGgzPk5ldEFjYWQgU2ltdWxhZG8gXHUyMDE0IE9wY2lcdTAwRjNuIG1cdTAwRkFsdGlwbGU8L2gzPlxyXG4gICAgICA8cCBjbGFzcz1cInFhLXRpcFwiPlVzYSA8c3Ryb25nPlNISUZUPC9zdHJvbmc+IHBhcmEgcXVpY2sgbW9kZSwgbyBjbGljIGVuIGJhZGdlIHBhcmEgYW5cdTAwRTFsaXNpcyBjb21wbGV0by48L3A+XHJcbiAgICAgIDxkaXYgY2xhc3M9XCJxYS1xdWVzdGlvbi10aXRsZVwiPlByZWd1bnRhIDE8L2Rpdj5cclxuICAgICAgPG1jcS12aWV3IGlkPVwicWEtbmV0YWNhZC1tY3FcIj48L21jcS12aWV3PlxyXG4gICAgPC9kaXY+XHJcbiAgYDtcclxuXHJcbiAgY29uc3QgbWNxVmlldyA9IHRhcmdldC5xdWVyeVNlbGVjdG9yKFwiI3FhLW5ldGFjYWQtbWNxXCIpIGFzIEhUTUxFbGVtZW50IHwgbnVsbDtcclxuICBpZiAoIW1jcVZpZXcpIHJldHVybjtcclxuXHJcbiAgY29uc3Qgc2hhZG93Um9vdCA9IG1jcVZpZXcuYXR0YWNoU2hhZG93KHsgbW9kZTogXCJvcGVuXCIgfSk7XHJcbiAgc2hhZG93Um9vdC5pbm5lckhUTUwgPSBgXHJcbiAgICA8c3R5bGU+XHJcbiAgICAgIC5tY3FfX2JvZHktaW5uZXIgeyBmb250LXNpemU6IDE2cHg7IG1hcmdpbi1ib3R0b206IDEycHg7IGNvbG9yOiAjMWYyOTM3OyB9XHJcbiAgICAgIC5tY3FfX2l0ZW0geyBtYXJnaW46IDhweCAwOyBwYWRkaW5nOiAxMHB4OyBib3JkZXI6IDFweCBzb2xpZCAjZTVlN2ViOyBib3JkZXItcmFkaXVzOiA4cHg7IGJhY2tncm91bmQ6ICNmZmY7IH1cclxuICAgICAgLm1jcV9faXRlbS10ZXh0LWlubmVyIHsgZm9udC1zaXplOiAxNHB4OyBjb2xvcjogIzExMTgyNzsgfVxyXG4gICAgPC9zdHlsZT5cclxuICAgIDxkaXYgY2xhc3M9XCJtY3FfX2JvZHktaW5uZXJcIj5cdTAwQkZDdVx1MDBFMWwgY2FwYSBkZWwgbW9kZWxvIE9TSSBzZSBlbmNhcmdhIGRlbCBlbnJ1dGFtaWVudG8/PC9kaXY+XHJcbiAgICA8ZGl2IGNsYXNzPVwibWNxX19pdGVtXCI+PGRpdiBjbGFzcz1cIm1jcV9faXRlbS10ZXh0LWlubmVyXCI+Q2FwYSBGXHUwMEVEc2ljYTwvZGl2PjwvZGl2PlxyXG4gICAgPGRpdiBjbGFzcz1cIm1jcV9faXRlbVwiPjxkaXYgY2xhc3M9XCJtY3FfX2l0ZW0tdGV4dC1pbm5lclwiPkNhcGEgZGUgRW5sYWNlPC9kaXY+PC9kaXY+XHJcbiAgICA8ZGl2IGNsYXNzPVwibWNxX19pdGVtXCI+PGRpdiBjbGFzcz1cIm1jcV9faXRlbS10ZXh0LWlubmVyXCI+Q2FwYSBkZSBSZWQ8L2Rpdj48L2Rpdj5cclxuICAgIDxkaXYgY2xhc3M9XCJtY3FfX2l0ZW1cIj48ZGl2IGNsYXNzPVwibWNxX19pdGVtLXRleHQtaW5uZXJcIj5DYXBhIGRlIEFwbGljYWNpXHUwMEYzbjwvZGl2PjwvZGl2PlxyXG4gIGA7XHJcbn1cclxuXHJcbmZ1bmN0aW9uIGluamVjdE5ldEFjYWRNYXRjaGluZyh0YXJnZXQ6IEhUTUxFbGVtZW50KTogdm9pZCB7XHJcbiAgdGFyZ2V0LmlubmVySFRNTCA9IGBcclxuICAgIDxkaXYgY2xhc3M9XCJxYS1ibG9ja1wiPlxyXG4gICAgICA8aDM+TmV0QWNhZCBTaW11bGFkbyBcdTIwMTQgTWF0Y2hpbmc8L2gzPlxyXG4gICAgICA8cCBjbGFzcz1cInFhLXRpcFwiPkVuIHF1aWNrIG1vZGUgbGEgcmVzcHVlc3RhIHNlIG1vc3RyYXJcdTAwRTEgY29tbyBwYXJlcyAoZWouIDxzdHJvbmc+QS0yPC9zdHJvbmc+KS48L3A+XHJcbiAgICAgIDxkaXYgY2xhc3M9XCJxYS1xdWVzdGlvbi10aXRsZVwiPlByZWd1bnRhIDE8L2Rpdj5cclxuICAgICAgPG9iamVjdC1tYXRjaGluZy12aWV3IGlkPVwicWEtbmV0YWNhZC1tYXRjaGluZ1wiPjwvb2JqZWN0LW1hdGNoaW5nLXZpZXc+XHJcbiAgICA8L2Rpdj5cclxuICBgO1xyXG5cclxuICBjb25zdCBtYXRjaGluZ1ZpZXcgPSB0YXJnZXQucXVlcnlTZWxlY3RvcihcIiNxYS1uZXRhY2FkLW1hdGNoaW5nXCIpIGFzIEhUTUxFbGVtZW50IHwgbnVsbDtcclxuICBpZiAoIW1hdGNoaW5nVmlldykgcmV0dXJuO1xyXG5cclxuICBjb25zdCBzaGFkb3dSb290ID0gbWF0Y2hpbmdWaWV3LmF0dGFjaFNoYWRvdyh7IG1vZGU6IFwib3BlblwiIH0pO1xyXG4gIHNoYWRvd1Jvb3QuaW5uZXJIVE1MID0gYFxyXG4gICAgPHN0eWxlPlxyXG4gICAgICAuY29tcG9uZW50X19ib2R5LWlubmVyIHsgZm9udC1zaXplOiAxNnB4OyBtYXJnaW4tYm90dG9tOiAxMnB4OyBjb2xvcjogIzFmMjkzNzsgfVxyXG4gICAgICAub2JqZWN0TWF0Y2hpbmctY2F0ZWdvcnktaXRlbSxcclxuICAgICAgLm9iamVjdE1hdGNoaW5nLW9wdGlvbi1pdGVtIHtcclxuICAgICAgICBkaXNwbGF5OiBmbGV4O1xyXG4gICAgICAgIGFsaWduLWl0ZW1zOiBjZW50ZXI7XHJcbiAgICAgICAgZ2FwOiA4cHg7XHJcbiAgICAgICAgbWFyZ2luOiA2cHggMDtcclxuICAgICAgICBwYWRkaW5nOiA4cHg7XHJcbiAgICAgICAgYm9yZGVyOiAxcHggc29saWQgI2U1ZTdlYjtcclxuICAgICAgICBib3JkZXItcmFkaXVzOiA4cHg7XHJcbiAgICAgICAgYmFja2dyb3VuZDogI2ZmZjtcclxuICAgICAgfVxyXG4gICAgICAuY2F0ZWdvcnktaXRlbS1udW1iZXIgeyBmb250LXdlaWdodDogNzAwOyBtaW4td2lkdGg6IDIwcHg7IH1cclxuICAgICAgLmNhdGVnb3J5LWl0ZW0tdGV4dCB7IGNvbG9yOiAjMTExODI3OyB9XHJcbiAgICA8L3N0eWxlPlxyXG4gICAgPGRpdiBjbGFzcz1cImNvbXBvbmVudF9fYm9keS1pbm5lclwiPlJlbGFjaW9uYSBjYWRhIHByb3RvY29sbyBjb24gc3UgcHVlcnRvIHBvciBkZWZlY3RvLjwvZGl2PlxyXG4gICAgPGRpdiBjbGFzcz1cIm9iamVjdE1hdGNoaW5nLWNhdGVnb3J5LWl0ZW1cIj48c3BhbiBjbGFzcz1cImNhdGVnb3J5LWl0ZW0tbnVtYmVyXCI+QTwvc3Bhbj48c3BhbiBjbGFzcz1cImNhdGVnb3J5LWl0ZW0tdGV4dFwiPkhUVFA8L3NwYW4+PC9kaXY+XHJcbiAgICA8ZGl2IGNsYXNzPVwib2JqZWN0TWF0Y2hpbmctY2F0ZWdvcnktaXRlbVwiPjxzcGFuIGNsYXNzPVwiY2F0ZWdvcnktaXRlbS1udW1iZXJcIj5CPC9zcGFuPjxzcGFuIGNsYXNzPVwiY2F0ZWdvcnktaXRlbS10ZXh0XCI+SFRUUFM8L3NwYW4+PC9kaXY+XHJcbiAgICA8ZGl2IGNsYXNzPVwib2JqZWN0TWF0Y2hpbmctY2F0ZWdvcnktaXRlbVwiPjxzcGFuIGNsYXNzPVwiY2F0ZWdvcnktaXRlbS1udW1iZXJcIj5DPC9zcGFuPjxzcGFuIGNsYXNzPVwiY2F0ZWdvcnktaXRlbS10ZXh0XCI+U1NIPC9zcGFuPjwvZGl2PlxyXG4gICAgPGhyIC8+XHJcbiAgICA8ZGl2IGNsYXNzPVwib2JqZWN0TWF0Y2hpbmctb3B0aW9uLWl0ZW1cIj48c3BhbiBjbGFzcz1cImNhdGVnb3J5LWl0ZW0tdGV4dFwiPjQ0Mzwvc3Bhbj48L2Rpdj5cclxuICAgIDxkaXYgY2xhc3M9XCJvYmplY3RNYXRjaGluZy1vcHRpb24taXRlbVwiPjxzcGFuIGNsYXNzPVwiY2F0ZWdvcnktaXRlbS10ZXh0XCI+MjI8L3NwYW4+PC9kaXY+XHJcbiAgICA8ZGl2IGNsYXNzPVwib2JqZWN0TWF0Y2hpbmctb3B0aW9uLWl0ZW1cIj48c3BhbiBjbGFzcz1cImNhdGVnb3J5LWl0ZW0tdGV4dFwiPjgwPC9zcGFuPjwvZGl2PlxyXG4gIGA7XHJcbn1cclxuXHJcbmZ1bmN0aW9uIGluamVjdE1vb2RsZVNob3J0QW5zd2VyKHRhcmdldDogSFRNTEVsZW1lbnQpOiB2b2lkIHtcclxuICB0YXJnZXQuaW5uZXJIVE1MID0gYFxyXG4gICAgPGRpdiBjbGFzcz1cInFhLWJsb2NrXCI+XHJcbiAgICAgIDxoMz5Nb29kbGUgU2ltdWxhZG8gXHUyMDE0IFJlc3B1ZXN0YSBjb3J0YSAoU2hvcnQgQW5zd2VyKTwvaDM+XHJcbiAgICAgIDxwIGNsYXNzPVwicWEtdGlwXCI+TGEgSUEgcmVzcG9uZGVyXHUwMEUxIGNvbiB0ZXh0byBsaWJyZS4gUmVzcHVlc3RhIGVzcGVyYWRhOiA8c3Ryb25nPkh5cGVyVGV4dCBUcmFuc2ZlciBQcm90b2NvbDwvc3Ryb25nPi48L3A+XHJcbiAgICAgIDxkaXYgY2xhc3M9XCJxdWUgc2hvcnRhbnN3ZXJcIj5cclxuICAgICAgICA8ZGl2IGNsYXNzPVwiaW5mb1wiPjxoMyBjbGFzcz1cIm5vXCI+UHJlZ3VudGEgPHNwYW4gY2xhc3M9XCJxbm9cIj4xPC9zcGFuPjwvaDM+PC9kaXY+XHJcbiAgICAgICAgPGRpdiBjbGFzcz1cImNvbnRlbnRcIj5cclxuICAgICAgICAgIDxkaXYgY2xhc3M9XCJmb3JtdWxhdGlvbiBjbGVhcmZpeFwiPlxyXG4gICAgICAgICAgICA8ZGl2IGNsYXNzPVwicXRleHRcIj5cdTAwQkZRdVx1MDBFOSBzaWduaWZpY2EgZWwgYWNyXHUwMEYzbmltbyA8c3Ryb25nPkhUVFA8L3N0cm9uZz4gZW4gZWwgY29udGV4dG8gZGUgbGEgV29ybGQgV2lkZSBXZWI/PC9kaXY+XHJcbiAgICAgICAgICAgIDxkaXYgY2xhc3M9XCJhbnN3ZXJcIj5cclxuICAgICAgICAgICAgICA8aW5wdXQgdHlwZT1cInRleHRcIiBjbGFzcz1cImZvcm0tY29udHJvbCBkLWlubGluZVwiIHNpemU9XCIzMFwiIHBsYWNlaG9sZGVyPVwiRXNjcmliZSB0dSByZXNwdWVzdGEgYXF1XHUwMEVEXCIgLz5cclxuICAgICAgICAgICAgPC9kaXY+XHJcbiAgICAgICAgICA8L2Rpdj5cclxuICAgICAgICA8L2Rpdj5cclxuICAgICAgPC9kaXY+XHJcbiAgICA8L2Rpdj5cclxuICBgO1xyXG59XHJcblxyXG5mdW5jdGlvbiBpbmplY3RNb29kbGVOdW1lcmljYWwodGFyZ2V0OiBIVE1MRWxlbWVudCk6IHZvaWQge1xyXG4gIHRhcmdldC5pbm5lckhUTUwgPSBgXHJcbiAgICA8ZGl2IGNsYXNzPVwicWEtYmxvY2tcIj5cclxuICAgICAgPGgzPk1vb2RsZSBTaW11bGFkbyBcdTIwMTQgTnVtXHUwMEU5cmljYSAoTnVtZXJpY2FsKTwvaDM+XHJcbiAgICAgIDxwIGNsYXNzPVwicWEtdGlwXCI+TGEgSUEgcmVzcG9uZGVyXHUwMEUxIGNvbiB1biBuXHUwMEZBbWVyby4gUmVzcHVlc3RhIGVzcGVyYWRhOiA8c3Ryb25nPjMyPC9zdHJvbmc+LjwvcD5cclxuICAgICAgPGRpdiBjbGFzcz1cInF1ZSBudW1lcmljYWxcIj5cclxuICAgICAgICA8ZGl2IGNsYXNzPVwiaW5mb1wiPjxoMyBjbGFzcz1cIm5vXCI+UHJlZ3VudGEgPHNwYW4gY2xhc3M9XCJxbm9cIj4xPC9zcGFuPjwvaDM+PC9kaXY+XHJcbiAgICAgICAgPGRpdiBjbGFzcz1cImNvbnRlbnRcIj5cclxuICAgICAgICAgIDxkaXYgY2xhc3M9XCJmb3JtdWxhdGlvbiBjbGVhcmZpeFwiPlxyXG4gICAgICAgICAgICA8ZGl2IGNsYXNzPVwicXRleHRcIj5cdTAwQkZDdVx1MDBFMW50b3MgYml0cyB0aWVuZSB1bmEgZGlyZWNjaVx1MDBGM24gSVB2ND88L2Rpdj5cclxuICAgICAgICAgICAgPGRpdiBjbGFzcz1cImFuc3dlclwiPlxyXG4gICAgICAgICAgICAgIDxpbnB1dCB0eXBlPVwidGV4dFwiIGNsYXNzPVwiZm9ybS1jb250cm9sIGQtaW5saW5lXCIgc2l6ZT1cIjE1XCIgcGxhY2Vob2xkZXI9XCJSZXNwdWVzdGEgbnVtXHUwMEU5cmljYVwiIC8+XHJcbiAgICAgICAgICAgIDwvZGl2PlxyXG4gICAgICAgICAgPC9kaXY+XHJcbiAgICAgICAgPC9kaXY+XHJcbiAgICAgIDwvZGl2PlxyXG4gICAgPC9kaXY+XHJcbiAgYDtcclxufVxyXG5cclxuZnVuY3Rpb24gaW5qZWN0TW9vZGxlR2FwU2VsZWN0KHRhcmdldDogSFRNTEVsZW1lbnQpOiB2b2lkIHtcclxuICB0YXJnZXQuaW5uZXJIVE1MID0gYFxyXG4gICAgPGRpdiBjbGFzcz1cInFhLWJsb2NrXCI+XHJcbiAgICAgIDxoMz5Nb29kbGUgU2ltdWxhZG8gXHUyMDE0IFNlbGVjY2lvbmEgbGFzIHBhbGFicmFzIGZhbHRhbnRlcyAoU2VsZWN0IE1pc3NpbmcgV29yZHMpPC9oMz5cclxuICAgICAgPHAgY2xhc3M9XCJxYS10aXBcIj5SZXNwdWVzdGEgZXNwZXJhZGE6IDxzdHJvbmc+W1sxXV09SFRUUCwgW1syXV09ODAsIFtbM11dPUhUVFBTLCBbWzRdXT00NDM8L3N0cm9uZz4uPC9wPlxyXG4gICAgICA8ZGl2IGNsYXNzPVwicXVlIGdhcHNlbGVjdFwiPlxyXG4gICAgICAgIDxkaXYgY2xhc3M9XCJpbmZvXCI+PGgzIGNsYXNzPVwibm9cIj5QcmVndW50YSA8c3BhbiBjbGFzcz1cInFub1wiPjE8L3NwYW4+PC9oMz48L2Rpdj5cclxuICAgICAgICA8ZGl2IGNsYXNzPVwiY29udGVudFwiPlxyXG4gICAgICAgICAgPGRpdiBjbGFzcz1cImZvcm11bGF0aW9uIGNsZWFyZml4XCI+XHJcbiAgICAgICAgICAgIDxkaXYgY2xhc3M9XCJxdGV4dFwiPkVsIHByb3RvY29sb1xyXG4gICAgICAgICAgICAgIDxzZWxlY3QgbmFtZT1cInJlc3BfMVwiPlxyXG4gICAgICAgICAgICAgICAgPG9wdGlvbiB2YWx1ZT1cIjBcIj5FbGVnaXIuLi48L29wdGlvbj5cclxuICAgICAgICAgICAgICAgIDxvcHRpb24gdmFsdWU9XCIxXCI+SFRUUDwvb3B0aW9uPlxyXG4gICAgICAgICAgICAgICAgPG9wdGlvbiB2YWx1ZT1cIjJcIj5GVFA8L29wdGlvbj5cclxuICAgICAgICAgICAgICAgIDxvcHRpb24gdmFsdWU9XCIzXCI+U1NIPC9vcHRpb24+XHJcbiAgICAgICAgICAgICAgPC9zZWxlY3Q+XHJcbiAgICAgICAgICAgICAgdXRpbGl6YSBlbCBwdWVydG9cclxuICAgICAgICAgICAgICA8c2VsZWN0IG5hbWU9XCJyZXNwXzJcIj5cclxuICAgICAgICAgICAgICAgIDxvcHRpb24gdmFsdWU9XCIwXCI+RWxlZ2lyLi4uPC9vcHRpb24+XHJcbiAgICAgICAgICAgICAgICA8b3B0aW9uIHZhbHVlPVwiMVwiPjgwPC9vcHRpb24+XHJcbiAgICAgICAgICAgICAgICA8b3B0aW9uIHZhbHVlPVwiMlwiPjIxPC9vcHRpb24+XHJcbiAgICAgICAgICAgICAgICA8b3B0aW9uIHZhbHVlPVwiM1wiPjIyPC9vcHRpb24+XHJcbiAgICAgICAgICAgICAgPC9zZWxlY3Q+XHJcbiAgICAgICAgICAgICAgcGFyYSBjb211bmljYWNpXHUwMEYzbiBubyBjaWZyYWRhLCBtaWVudHJhcyBxdWVcclxuICAgICAgICAgICAgICA8c2VsZWN0IG5hbWU9XCJyZXNwXzNcIj5cclxuICAgICAgICAgICAgICAgIDxvcHRpb24gdmFsdWU9XCIwXCI+RWxlZ2lyLi4uPC9vcHRpb24+XHJcbiAgICAgICAgICAgICAgICA8b3B0aW9uIHZhbHVlPVwiMVwiPkhUVFA8L29wdGlvbj5cclxuICAgICAgICAgICAgICAgIDxvcHRpb24gdmFsdWU9XCIyXCI+SFRUUFM8L29wdGlvbj5cclxuICAgICAgICAgICAgICAgIDxvcHRpb24gdmFsdWU9XCIzXCI+RlRQPC9vcHRpb24+XHJcbiAgICAgICAgICAgICAgPC9zZWxlY3Q+XHJcbiAgICAgICAgICAgICAgdXNhIGVsIHB1ZXJ0b1xyXG4gICAgICAgICAgICAgIDxzZWxlY3QgbmFtZT1cInJlc3BfNFwiPlxyXG4gICAgICAgICAgICAgICAgPG9wdGlvbiB2YWx1ZT1cIjBcIj5FbGVnaXIuLi48L29wdGlvbj5cclxuICAgICAgICAgICAgICAgIDxvcHRpb24gdmFsdWU9XCIxXCI+ODA8L29wdGlvbj5cclxuICAgICAgICAgICAgICAgIDxvcHRpb24gdmFsdWU9XCIyXCI+NDQzPC9vcHRpb24+XHJcbiAgICAgICAgICAgICAgICA8b3B0aW9uIHZhbHVlPVwiM1wiPjgwODA8L29wdGlvbj5cclxuICAgICAgICAgICAgICA8L3NlbGVjdD5cclxuICAgICAgICAgICAgICBwYXJhIGNvbXVuaWNhY2lcdTAwRjNuIGNpZnJhZGEuXHJcbiAgICAgICAgICAgIDwvZGl2PlxyXG4gICAgICAgICAgPC9kaXY+XHJcbiAgICAgICAgPC9kaXY+XHJcbiAgICAgIDwvZGl2PlxyXG4gICAgPC9kaXY+XHJcbiAgYDtcclxufVxyXG5cclxuZnVuY3Rpb24gaW5qZWN0TW9vZGxlTWF0Y2godGFyZ2V0OiBIVE1MRWxlbWVudCk6IHZvaWQge1xyXG4gIHRhcmdldC5pbm5lckhUTUwgPSBgXHJcbiAgICA8ZGl2IGNsYXNzPVwicWEtYmxvY2tcIj5cclxuICAgICAgPGgzPk1vb2RsZSBTaW11bGFkbyBcdTIwMTQgUmVsYWNpb25hciAoTWF0Y2gpPC9oMz5cclxuICAgICAgPHAgY2xhc3M9XCJxYS10aXBcIj5SZXNwdWVzdGEgZXNwZXJhZGE6IDxzdHJvbmc+QS0yLCBCLTEsIEMtMzwvc3Ryb25nPiAoY2F0ZWdvclx1MDBFRGEtb3BjaVx1MDBGM24pLjwvcD5cclxuICAgICAgPGRpdiBjbGFzcz1cInF1ZSBtYXRjaFwiPlxyXG4gICAgICAgIDxkaXYgY2xhc3M9XCJpbmZvXCI+PGgzIGNsYXNzPVwibm9cIj5QcmVndW50YSA8c3BhbiBjbGFzcz1cInFub1wiPjE8L3NwYW4+PC9oMz48L2Rpdj5cclxuICAgICAgICA8ZGl2IGNsYXNzPVwiY29udGVudFwiPlxyXG4gICAgICAgICAgPGRpdiBjbGFzcz1cImZvcm11bGF0aW9uIGNsZWFyZml4XCI+XHJcbiAgICAgICAgICAgIDxkaXYgY2xhc3M9XCJxdGV4dFwiPlJlbGFjaW9uYSBjYWRhIGNhcGEgZGVsIG1vZGVsbyBPU0kgY29uIHN1IGZ1bmNpXHUwMEYzbiBwcmluY2lwYWwuPC9kaXY+XHJcbiAgICAgICAgICAgIDxkaXYgY2xhc3M9XCJhYmxvY2tcIj5cclxuICAgICAgICAgICAgICA8dGFibGUgY2xhc3M9XCJhbnN3ZXJcIj5cclxuICAgICAgICAgICAgICAgIDx0Ym9keT5cclxuICAgICAgICAgICAgICAgICAgPHRyIGNsYXNzPVwicjBcIj5cclxuICAgICAgICAgICAgICAgICAgICA8dGQgY2xhc3M9XCJ0ZXh0XCI+RW5ydXRhbWllbnRvIGxcdTAwRjNnaWNvIGRlIHBhcXVldGVzPC90ZD5cclxuICAgICAgICAgICAgICAgICAgICA8dGQgY2xhc3M9XCJjb250cm9sXCI+XHJcbiAgICAgICAgICAgICAgICAgICAgICA8c2VsZWN0PlxyXG4gICAgICAgICAgICAgICAgICAgICAgICA8b3B0aW9uIHZhbHVlPVwiMFwiPkVsZWdpci4uLjwvb3B0aW9uPlxyXG4gICAgICAgICAgICAgICAgICAgICAgICA8b3B0aW9uIHZhbHVlPVwiMVwiPkNhcGEgRlx1MDBFRHNpY2E8L29wdGlvbj5cclxuICAgICAgICAgICAgICAgICAgICAgICAgPG9wdGlvbiB2YWx1ZT1cIjJcIj5DYXBhIGRlIFJlZDwvb3B0aW9uPlxyXG4gICAgICAgICAgICAgICAgICAgICAgICA8b3B0aW9uIHZhbHVlPVwiM1wiPkNhcGEgZGUgVHJhbnNwb3J0ZTwvb3B0aW9uPlxyXG4gICAgICAgICAgICAgICAgICAgICAgPC9zZWxlY3Q+XHJcbiAgICAgICAgICAgICAgICAgICAgPC90ZD5cclxuICAgICAgICAgICAgICAgICAgPC90cj5cclxuICAgICAgICAgICAgICAgICAgPHRyIGNsYXNzPVwicjFcIj5cclxuICAgICAgICAgICAgICAgICAgICA8dGQgY2xhc3M9XCJ0ZXh0XCI+VHJhbnNtaXNpXHUwMEYzbiBkZSBiaXRzIHBvciBlbCBtZWRpbyBmXHUwMEVEc2ljbzwvdGQ+XHJcbiAgICAgICAgICAgICAgICAgICAgPHRkIGNsYXNzPVwiY29udHJvbFwiPlxyXG4gICAgICAgICAgICAgICAgICAgICAgPHNlbGVjdD5cclxuICAgICAgICAgICAgICAgICAgICAgICAgPG9wdGlvbiB2YWx1ZT1cIjBcIj5FbGVnaXIuLi48L29wdGlvbj5cclxuICAgICAgICAgICAgICAgICAgICAgICAgPG9wdGlvbiB2YWx1ZT1cIjFcIj5DYXBhIEZcdTAwRURzaWNhPC9vcHRpb24+XHJcbiAgICAgICAgICAgICAgICAgICAgICAgIDxvcHRpb24gdmFsdWU9XCIyXCI+Q2FwYSBkZSBSZWQ8L29wdGlvbj5cclxuICAgICAgICAgICAgICAgICAgICAgICAgPG9wdGlvbiB2YWx1ZT1cIjNcIj5DYXBhIGRlIFRyYW5zcG9ydGU8L29wdGlvbj5cclxuICAgICAgICAgICAgICAgICAgICAgIDwvc2VsZWN0PlxyXG4gICAgICAgICAgICAgICAgICAgIDwvdGQ+XHJcbiAgICAgICAgICAgICAgICAgIDwvdHI+XHJcbiAgICAgICAgICAgICAgICAgIDx0ciBjbGFzcz1cInIwXCI+XHJcbiAgICAgICAgICAgICAgICAgICAgPHRkIGNsYXNzPVwidGV4dFwiPkNvbnRyb2wgZGUgZmx1am8geSBzZWdtZW50YWNpXHUwMEYzbiBleHRyZW1vIGEgZXh0cmVtbzwvdGQ+XHJcbiAgICAgICAgICAgICAgICAgICAgPHRkIGNsYXNzPVwiY29udHJvbFwiPlxyXG4gICAgICAgICAgICAgICAgICAgICAgPHNlbGVjdD5cclxuICAgICAgICAgICAgICAgICAgICAgICAgPG9wdGlvbiB2YWx1ZT1cIjBcIj5FbGVnaXIuLi48L29wdGlvbj5cclxuICAgICAgICAgICAgICAgICAgICAgICAgPG9wdGlvbiB2YWx1ZT1cIjFcIj5DYXBhIEZcdTAwRURzaWNhPC9vcHRpb24+XHJcbiAgICAgICAgICAgICAgICAgICAgICAgIDxvcHRpb24gdmFsdWU9XCIyXCI+Q2FwYSBkZSBSZWQ8L29wdGlvbj5cclxuICAgICAgICAgICAgICAgICAgICAgICAgPG9wdGlvbiB2YWx1ZT1cIjNcIj5DYXBhIGRlIFRyYW5zcG9ydGU8L29wdGlvbj5cclxuICAgICAgICAgICAgICAgICAgICAgIDwvc2VsZWN0PlxyXG4gICAgICAgICAgICAgICAgICAgIDwvdGQ+XHJcbiAgICAgICAgICAgICAgICAgIDwvdHI+XHJcbiAgICAgICAgICAgICAgICA8L3Rib2R5PlxyXG4gICAgICAgICAgICAgIDwvdGFibGU+XHJcbiAgICAgICAgICAgIDwvZGl2PlxyXG4gICAgICAgICAgPC9kaXY+XHJcbiAgICAgICAgPC9kaXY+XHJcbiAgICAgIDwvZGl2PlxyXG4gICAgPC9kaXY+XHJcbiAgYDtcclxufVxyXG5cclxuLyoqXHJcbiAqIEF0dGFjaGVzIHByZXYvbmV4dCBuYXZpZ2F0aW9uIGxvZ2ljIHRvIGEgcXVpeiBjb250YWluZXIgdGhhdCBoYXMgLnFhLXNsaWRlIGVsZW1lbnRzLlxyXG4gKiBEaXNwYXRjaGVzICdzdHVkeS1hc3Npc3QtbmF2aWdhdGUnIG9uIHdpbmRvdyBhZnRlciBlYWNoIHNsaWRlIGNoYW5nZSBzbyB0aGUgY29udGVudFxyXG4gKiBzY3JpcHQgcmUtcnVucyBkZXRlY3Rpb24gYXV0b21hdGljYWxseS5cclxuICovXHJcbmZ1bmN0aW9uIGF0dGFjaFFBTmF2aWdhdGlvbihjb250YWluZXI6IEhUTUxFbGVtZW50KTogdm9pZCB7XHJcbiAgY29uc3Qgc2xpZGVzID0gQXJyYXkuZnJvbShjb250YWluZXIucXVlcnlTZWxlY3RvckFsbDxIVE1MRWxlbWVudD4oXCIucWEtc2xpZGVcIikpO1xyXG4gIGlmIChzbGlkZXMubGVuZ3RoID09PSAwKSByZXR1cm47XHJcblxyXG4gIGxldCBjdXJyZW50ID0gMDtcclxuXHJcbiAgY29uc3QgcHJldkJ0biA9IGNvbnRhaW5lci5xdWVyeVNlbGVjdG9yPEhUTUxCdXR0b25FbGVtZW50PihcIiNxYS1uYXYtcHJldlwiKTtcclxuICBjb25zdCBuZXh0QnRuID0gY29udGFpbmVyLnF1ZXJ5U2VsZWN0b3I8SFRNTEJ1dHRvbkVsZW1lbnQ+KFwiI3FhLW5hdi1uZXh0XCIpO1xyXG4gIGNvbnN0IHByb2dyZXNzRWwgPSBjb250YWluZXIucXVlcnlTZWxlY3RvcjxIVE1MRWxlbWVudD4oXCIucWEtcXVpei1wcm9ncmVzc1wiKTtcclxuXHJcbiAgZnVuY3Rpb24gdXBkYXRlKCk6IHZvaWQge1xyXG4gICAgc2xpZGVzLmZvckVhY2goKHNsaWRlLCBpKSA9PiB7XHJcbiAgICAgIHNsaWRlLnN0eWxlLmRpc3BsYXkgPSBpID09PSBjdXJyZW50ID8gXCJcIiA6IFwibm9uZVwiO1xyXG4gICAgfSk7XHJcbiAgICBpZiAocHJldkJ0bikgcHJldkJ0bi5kaXNhYmxlZCA9IGN1cnJlbnQgPD0gMDtcclxuICAgIGlmIChuZXh0QnRuKSBuZXh0QnRuLmRpc2FibGVkID0gY3VycmVudCA+PSBzbGlkZXMubGVuZ3RoIC0gMTtcclxuICAgIGlmIChwcm9ncmVzc0VsKSBwcm9ncmVzc0VsLnRleHRDb250ZW50ID0gYFByZWd1bnRhICR7Y3VycmVudCArIDF9IGRlICR7c2xpZGVzLmxlbmd0aH1gO1xyXG4gICAgd2luZG93LmRpc3BhdGNoRXZlbnQobmV3IEN1c3RvbUV2ZW50KFwic3R1ZHktYXNzaXN0LW5hdmlnYXRlXCIpKTtcclxuICB9XHJcblxyXG4gIGlmIChwcmV2QnRuKSBwcmV2QnRuLmFkZEV2ZW50TGlzdGVuZXIoXCJjbGlja1wiLCAoKSA9PiB7IGlmIChjdXJyZW50ID4gMCkgeyBjdXJyZW50LS07IHVwZGF0ZSgpOyB9IH0pO1xyXG4gIGlmIChuZXh0QnRuKSBuZXh0QnRuLmFkZEV2ZW50TGlzdGVuZXIoXCJjbGlja1wiLCAoKSA9PiB7IGlmIChjdXJyZW50IDwgc2xpZGVzLmxlbmd0aCAtIDEpIHsgY3VycmVudCsrOyB1cGRhdGUoKTsgfSB9KTtcclxufVxyXG5cclxuZnVuY3Rpb24gaW5qZWN0TmV0QWNhZFF1aXoodGFyZ2V0OiBIVE1MRWxlbWVudCk6IHZvaWQge1xyXG4gIHRhcmdldC5pbm5lckhUTUwgPSBgXHJcbiAgICA8ZGl2IGNsYXNzPVwicWEtcXVpei1oZWFkZXJcIj5cclxuICAgICAgPHNwYW4gY2xhc3M9XCJxYS1xdWl6LXBsYXRmb3JtXCI+XHVEODNEXHVERDM1IE5ldEFjYWQgXHUyMDE0IFF1aXogUmVhbDwvc3Bhbj5cclxuICAgICAgPGRpdiBjbGFzcz1cInFhLXF1aXotbmF2XCI+XHJcbiAgICAgICAgPGJ1dHRvbiBjbGFzcz1cInFhLXNhbmRib3gtbmF2LWJ0blwiIGlkPVwicWEtbmF2LXByZXZcIiBkaXNhYmxlZD5cdTIxOTAgQW50ZXJpb3I8L2J1dHRvbj5cclxuICAgICAgICA8c3BhbiBjbGFzcz1cInFhLXF1aXotcHJvZ3Jlc3NcIj5QcmVndW50YSAxIGRlIDI8L3NwYW4+XHJcbiAgICAgICAgPGJ1dHRvbiBjbGFzcz1cInFhLXNhbmRib3gtbmF2LWJ0blwiIGlkPVwicWEtbmF2LW5leHRcIj5TaWd1aWVudGUgXHUyMTkyPC9idXR0b24+XHJcbiAgICAgIDwvZGl2PlxyXG4gICAgPC9kaXY+XHJcbiAgICA8cCBjbGFzcz1cInFhLXRpcFwiPkxhIGRldGVjY2lcdTAwRjNuIHNlIGFjdHVhbGl6YSBhdXRvbVx1MDBFMXRpY2FtZW50ZSBhbCBuYXZlZ2FyLjwvcD5cclxuXHJcbiAgICA8ZGl2IGNsYXNzPVwicWEtc2xpZGVcIiBkYXRhLXNsaWRlPVwiMFwiPlxyXG4gICAgICA8ZGl2IGNsYXNzPVwicWEtYmxvY2tcIj5cclxuICAgICAgICA8aDM+UHJlZ3VudGEgMSBcdTIwMTQgT3BjaVx1MDBGM24gbVx1MDBGQWx0aXBsZSAoTUNRKTwvaDM+XHJcbiAgICAgICAgPGRpdiBjbGFzcz1cInFhLXF1ZXN0aW9uLXRpdGxlXCI+UHJlZ3VudGEgMTwvZGl2PlxyXG4gICAgICAgIDxtY3EtdmlldyBpZD1cInFhLW5ldGFjYWQtcXVpei1tY3FcIj48L21jcS12aWV3PlxyXG4gICAgICA8L2Rpdj5cclxuICAgIDwvZGl2PlxyXG5cclxuICAgIDxkaXYgY2xhc3M9XCJxYS1zbGlkZVwiIGRhdGEtc2xpZGU9XCIxXCIgc3R5bGU9XCJkaXNwbGF5Om5vbmVcIj5cclxuICAgICAgPGRpdiBjbGFzcz1cInFhLWJsb2NrXCI+XHJcbiAgICAgICAgPGgzPlByZWd1bnRhIDIgXHUyMDE0IFJlbGFjaW9uYXIgKE1hdGNoaW5nKTwvaDM+XHJcbiAgICAgICAgPHAgY2xhc3M9XCJxYS10aXBcIj5FbiBxdWljayBtb2RlIGxhIHJlc3B1ZXN0YSBzZSBtb3N0cmFyXHUwMEUxIGNvbW8gcGFyZXMgKGVqLiA8c3Ryb25nPkEtMjwvc3Ryb25nPikuPC9wPlxyXG4gICAgICAgIDxkaXYgY2xhc3M9XCJxYS1xdWVzdGlvbi10aXRsZVwiPlByZWd1bnRhIDI8L2Rpdj5cclxuICAgICAgICA8b2JqZWN0LW1hdGNoaW5nLXZpZXcgaWQ9XCJxYS1uZXRhY2FkLXF1aXotbWF0Y2hpbmdcIj48L29iamVjdC1tYXRjaGluZy12aWV3PlxyXG4gICAgICA8L2Rpdj5cclxuICAgIDwvZGl2PlxyXG4gIGA7XHJcblxyXG4gIC8vIE1DUSBzaGFkb3cgRE9NXHJcbiAgY29uc3QgbWNxVmlldyA9IHRhcmdldC5xdWVyeVNlbGVjdG9yKFwiI3FhLW5ldGFjYWQtcXVpei1tY3FcIikgYXMgSFRNTEVsZW1lbnQgfCBudWxsO1xyXG4gIGlmIChtY3FWaWV3KSB7XHJcbiAgICBjb25zdCBzciA9IG1jcVZpZXcuYXR0YWNoU2hhZG93KHsgbW9kZTogXCJvcGVuXCIgfSk7XHJcbiAgICBzci5pbm5lckhUTUwgPSBgXHJcbiAgICAgIDxzdHlsZT5cclxuICAgICAgICAubWNxX19ib2R5LWlubmVyIHsgZm9udC1zaXplOiAxNnB4OyBtYXJnaW4tYm90dG9tOiAxMnB4OyBjb2xvcjogIzFmMjkzNzsgfVxyXG4gICAgICAgIC5tY3FfX2l0ZW0geyBtYXJnaW46IDhweCAwOyBwYWRkaW5nOiAxMHB4OyBib3JkZXI6IDFweCBzb2xpZCAjZTVlN2ViOyBib3JkZXItcmFkaXVzOiA4cHg7IGJhY2tncm91bmQ6ICNmZmY7IH1cclxuICAgICAgICAubWNxX19pdGVtLXRleHQtaW5uZXIgeyBmb250LXNpemU6IDE0cHg7IGNvbG9yOiAjMTExODI3OyB9XHJcbiAgICAgIDwvc3R5bGU+XHJcbiAgICAgIDxkaXYgY2xhc3M9XCJtY3FfX2JvZHktaW5uZXJcIj5cdTAwQkZDdVx1MDBFMWwgY2FwYSBkZWwgbW9kZWxvIE9TSSBzZSBlbmNhcmdhIGRlbCBlbnJ1dGFtaWVudG8gbFx1MDBGM2dpY28gZGUgcGFxdWV0ZXM/PC9kaXY+XHJcbiAgICAgIDxkaXYgY2xhc3M9XCJtY3FfX2l0ZW1cIj48ZGl2IGNsYXNzPVwibWNxX19pdGVtLXRleHQtaW5uZXJcIj5DYXBhIEZcdTAwRURzaWNhPC9kaXY+PC9kaXY+XHJcbiAgICAgIDxkaXYgY2xhc3M9XCJtY3FfX2l0ZW1cIj48ZGl2IGNsYXNzPVwibWNxX19pdGVtLXRleHQtaW5uZXJcIj5DYXBhIGRlIEVubGFjZSBkZSBEYXRvczwvZGl2PjwvZGl2PlxyXG4gICAgICA8ZGl2IGNsYXNzPVwibWNxX19pdGVtXCI+PGRpdiBjbGFzcz1cIm1jcV9faXRlbS10ZXh0LWlubmVyXCI+Q2FwYSBkZSBSZWQ8L2Rpdj48L2Rpdj5cclxuICAgICAgPGRpdiBjbGFzcz1cIm1jcV9faXRlbVwiPjxkaXYgY2xhc3M9XCJtY3FfX2l0ZW0tdGV4dC1pbm5lclwiPkNhcGEgZGUgVHJhbnNwb3J0ZTwvZGl2PjwvZGl2PlxyXG4gICAgYDtcclxuICB9XHJcblxyXG4gIC8vIE1hdGNoaW5nIHNoYWRvdyBET01cclxuICBjb25zdCBtYXRjaGluZ1ZpZXcgPSB0YXJnZXQucXVlcnlTZWxlY3RvcihcIiNxYS1uZXRhY2FkLXF1aXotbWF0Y2hpbmdcIikgYXMgSFRNTEVsZW1lbnQgfCBudWxsO1xyXG4gIGlmIChtYXRjaGluZ1ZpZXcpIHtcclxuICAgIGNvbnN0IHNyID0gbWF0Y2hpbmdWaWV3LmF0dGFjaFNoYWRvdyh7IG1vZGU6IFwib3BlblwiIH0pO1xyXG4gICAgc3IuaW5uZXJIVE1MID0gYFxyXG4gICAgICA8c3R5bGU+XHJcbiAgICAgICAgLmNvbXBvbmVudF9fYm9keS1pbm5lciB7IGZvbnQtc2l6ZTogMTZweDsgbWFyZ2luLWJvdHRvbTogMTJweDsgY29sb3I6ICMxZjI5Mzc7IH1cclxuICAgICAgICAub2JqZWN0TWF0Y2hpbmctY2F0ZWdvcnktaXRlbSxcclxuICAgICAgICAub2JqZWN0TWF0Y2hpbmctb3B0aW9uLWl0ZW0ge1xyXG4gICAgICAgICAgZGlzcGxheTogZmxleDsgYWxpZ24taXRlbXM6IGNlbnRlcjsgZ2FwOiA4cHg7XHJcbiAgICAgICAgICBtYXJnaW46IDZweCAwOyBwYWRkaW5nOiA4cHg7XHJcbiAgICAgICAgICBib3JkZXI6IDFweCBzb2xpZCAjZTVlN2ViOyBib3JkZXItcmFkaXVzOiA4cHg7IGJhY2tncm91bmQ6ICNmZmY7XHJcbiAgICAgICAgfVxyXG4gICAgICAgIC5jYXRlZ29yeS1pdGVtLW51bWJlciB7IGZvbnQtd2VpZ2h0OiA3MDA7IG1pbi13aWR0aDogMjBweDsgfVxyXG4gICAgICA8L3N0eWxlPlxyXG4gICAgICA8ZGl2IGNsYXNzPVwiY29tcG9uZW50X19ib2R5LWlubmVyXCI+UmVsYWNpb25hIGNhZGEgcHJvdG9jb2xvIGNvbiBzdSBwdWVydG8gcG9yIGRlZmVjdG8uPC9kaXY+XHJcbiAgICAgIDxkaXYgY2xhc3M9XCJvYmplY3RNYXRjaGluZy1jYXRlZ29yeS1pdGVtXCI+PHNwYW4gY2xhc3M9XCJjYXRlZ29yeS1pdGVtLW51bWJlclwiPkE8L3NwYW4+PHNwYW4gY2xhc3M9XCJjYXRlZ29yeS1pdGVtLXRleHRcIj5IVFRQPC9zcGFuPjwvZGl2PlxyXG4gICAgICA8ZGl2IGNsYXNzPVwib2JqZWN0TWF0Y2hpbmctY2F0ZWdvcnktaXRlbVwiPjxzcGFuIGNsYXNzPVwiY2F0ZWdvcnktaXRlbS1udW1iZXJcIj5CPC9zcGFuPjxzcGFuIGNsYXNzPVwiY2F0ZWdvcnktaXRlbS10ZXh0XCI+SFRUUFM8L3NwYW4+PC9kaXY+XHJcbiAgICAgIDxkaXYgY2xhc3M9XCJvYmplY3RNYXRjaGluZy1jYXRlZ29yeS1pdGVtXCI+PHNwYW4gY2xhc3M9XCJjYXRlZ29yeS1pdGVtLW51bWJlclwiPkM8L3NwYW4+PHNwYW4gY2xhc3M9XCJjYXRlZ29yeS1pdGVtLXRleHRcIj5TU0g8L3NwYW4+PC9kaXY+XHJcbiAgICAgIDxociAvPlxyXG4gICAgICA8ZGl2IGNsYXNzPVwib2JqZWN0TWF0Y2hpbmctb3B0aW9uLWl0ZW1cIj48c3BhbiBjbGFzcz1cImNhdGVnb3J5LWl0ZW0tdGV4dFwiPjQ0Mzwvc3Bhbj48L2Rpdj5cclxuICAgICAgPGRpdiBjbGFzcz1cIm9iamVjdE1hdGNoaW5nLW9wdGlvbi1pdGVtXCI+PHNwYW4gY2xhc3M9XCJjYXRlZ29yeS1pdGVtLXRleHRcIj4yMjwvc3Bhbj48L2Rpdj5cclxuICAgICAgPGRpdiBjbGFzcz1cIm9iamVjdE1hdGNoaW5nLW9wdGlvbi1pdGVtXCI+PHNwYW4gY2xhc3M9XCJjYXRlZ29yeS1pdGVtLXRleHRcIj44MDwvc3Bhbj48L2Rpdj5cclxuICAgIGA7XHJcbiAgfVxyXG5cclxuICBhdHRhY2hRQU5hdmlnYXRpb24odGFyZ2V0KTtcclxufVxyXG5cclxuZnVuY3Rpb24gaW5qZWN0TW9vZGxlUXVpeih0YXJnZXQ6IEhUTUxFbGVtZW50KTogdm9pZCB7XHJcbiAgdGFyZ2V0LmlubmVySFRNTCA9IGBcclxuICAgIDxkaXYgY2xhc3M9XCJxYS1xdWl6LWhlYWRlclwiPlxyXG4gICAgICA8c3BhbiBjbGFzcz1cInFhLXF1aXotcGxhdGZvcm1cIj5cdUQ4M0RcdURGRTMgTW9vZGxlIFx1MjAxNCBRdWl6IFJlYWw8L3NwYW4+XHJcbiAgICAgIDxkaXYgY2xhc3M9XCJxYS1xdWl6LW5hdlwiPlxyXG4gICAgICAgIDxidXR0b24gY2xhc3M9XCJxYS1zYW5kYm94LW5hdi1idG5cIiBpZD1cInFhLW5hdi1wcmV2XCIgZGlzYWJsZWQ+XHUyMTkwIEFudGVyaW9yPC9idXR0b24+XHJcbiAgICAgICAgPHNwYW4gY2xhc3M9XCJxYS1xdWl6LXByb2dyZXNzXCI+UHJlZ3VudGEgMSBkZSA2PC9zcGFuPlxyXG4gICAgICAgIDxidXR0b24gY2xhc3M9XCJxYS1zYW5kYm94LW5hdi1idG5cIiBpZD1cInFhLW5hdi1uZXh0XCI+U2lndWllbnRlIFx1MjE5MjwvYnV0dG9uPlxyXG4gICAgICA8L2Rpdj5cclxuICAgIDwvZGl2PlxyXG4gICAgPHAgY2xhc3M9XCJxYS10aXBcIj5MYSBkZXRlY2NpXHUwMEYzbiBzZSBhY3R1YWxpemEgYXV0b21cdTAwRTF0aWNhbWVudGUgYWwgbmF2ZWdhci48L3A+XHJcblxyXG4gICAgPGRpdiBjbGFzcz1cInFhLXNsaWRlXCIgZGF0YS1zbGlkZT1cIjBcIj5cclxuICAgICAgPGRpdiBjbGFzcz1cInFhLWJsb2NrXCI+XHJcbiAgICAgICAgPGgzPlByZWd1bnRhIDEgXHUyMDE0IE9wY2lcdTAwRjNuIG1cdTAwRkFsdGlwbGUgKE1DUSk8L2gzPlxyXG4gICAgICAgIDxkaXYgY2xhc3M9XCJxdWUgbXVsdGljaG9pY2VcIj5cclxuICAgICAgICAgIDxkaXYgY2xhc3M9XCJpbmZvXCI+PGgzIGNsYXNzPVwibm9cIj5QcmVndW50YSA8c3BhbiBjbGFzcz1cInFub1wiPjE8L3NwYW4+PC9oMz48L2Rpdj5cclxuICAgICAgICAgIDxkaXYgY2xhc3M9XCJxdGV4dFwiPlx1MDBCRlF1XHUwMEU5IHByb3RvY29sbyB1dGlsaXphIGVsIHB1ZXJ0byA0NDMgcG9yIGRlZmVjdG8/PC9kaXY+XHJcbiAgICAgICAgICA8ZGl2IGNsYXNzPVwiYW5zd2VyXCI+XHJcbiAgICAgICAgICAgIDxkaXYgY2xhc3M9XCJyMFwiPjxzcGFuIGNsYXNzPVwiYW5zd2VybnVtYmVyXCI+YS48L3NwYW4+PGRpdiBjbGFzcz1cImZsZXgtZmlsbFwiPkhUVFA8L2Rpdj48L2Rpdj5cclxuICAgICAgICAgICAgPGRpdiBjbGFzcz1cInIxXCI+PHNwYW4gY2xhc3M9XCJhbnN3ZXJudW1iZXJcIj5iLjwvc3Bhbj48ZGl2IGNsYXNzPVwiZmxleC1maWxsXCI+SFRUUFM8L2Rpdj48L2Rpdj5cclxuICAgICAgICAgICAgPGRpdiBjbGFzcz1cInIwXCI+PHNwYW4gY2xhc3M9XCJhbnN3ZXJudW1iZXJcIj5jLjwvc3Bhbj48ZGl2IGNsYXNzPVwiZmxleC1maWxsXCI+RlRQPC9kaXY+PC9kaXY+XHJcbiAgICAgICAgICAgIDxkaXYgY2xhc3M9XCJyMVwiPjxzcGFuIGNsYXNzPVwiYW5zd2VybnVtYmVyXCI+ZC48L3NwYW4+PGRpdiBjbGFzcz1cImZsZXgtZmlsbFwiPlRlbG5ldDwvZGl2PjwvZGl2PlxyXG4gICAgICAgICAgPC9kaXY+XHJcbiAgICAgICAgPC9kaXY+XHJcbiAgICAgIDwvZGl2PlxyXG4gICAgPC9kaXY+XHJcblxyXG4gICAgPGRpdiBjbGFzcz1cInFhLXNsaWRlXCIgZGF0YS1zbGlkZT1cIjFcIiBzdHlsZT1cImRpc3BsYXk6bm9uZVwiPlxyXG4gICAgICA8ZGl2IGNsYXNzPVwicWEtYmxvY2tcIj5cclxuICAgICAgICA8aDM+UHJlZ3VudGEgMiBcdTIwMTQgVmVyZGFkZXJvL0ZhbHNvPC9oMz5cclxuICAgICAgICA8ZGl2IGNsYXNzPVwicXVlIHRydWVmYWxzZVwiPlxyXG4gICAgICAgICAgPGRpdiBjbGFzcz1cImluZm9cIj48aDMgY2xhc3M9XCJub1wiPlByZWd1bnRhIDxzcGFuIGNsYXNzPVwicW5vXCI+Mjwvc3Bhbj48L2gzPjwvZGl2PlxyXG4gICAgICAgICAgPGRpdiBjbGFzcz1cInF0ZXh0XCI+TGEgZW50cm9wXHUwMEVEYSByZXByZXNlbnRhIGxhIHRlbmRlbmNpYSBuYXR1cmFsIGRlIHVuIHNpc3RlbWEgYSBkZXNvcmdhbml6YXJzZS48L2Rpdj5cclxuICAgICAgICAgIDxkaXYgY2xhc3M9XCJhbnN3ZXJcIj5cclxuICAgICAgICAgICAgPGRpdiBjbGFzcz1cInIwXCI+XHJcbiAgICAgICAgICAgICAgPGlucHV0IHR5cGU9XCJyYWRpb1wiIG5hbWU9XCJxYV90ZlwiIHZhbHVlPVwiMVwiIGlkPVwicWFfdGZfdHJ1ZVwiIC8+XHJcbiAgICAgICAgICAgICAgPGxhYmVsIGZvcj1cInFhX3RmX3RydWVcIiBjbGFzcz1cIm1zLTFcIj5WZXJkYWRlcm88L2xhYmVsPlxyXG4gICAgICAgICAgICA8L2Rpdj5cclxuICAgICAgICAgICAgPGRpdiBjbGFzcz1cInIxXCI+XHJcbiAgICAgICAgICAgICAgPGlucHV0IHR5cGU9XCJyYWRpb1wiIG5hbWU9XCJxYV90ZlwiIHZhbHVlPVwiMFwiIGlkPVwicWFfdGZfZmFsc2VcIiAvPlxyXG4gICAgICAgICAgICAgIDxsYWJlbCBmb3I9XCJxYV90Zl9mYWxzZVwiIGNsYXNzPVwibXMtMVwiPkZhbHNvPC9sYWJlbD5cclxuICAgICAgICAgICAgPC9kaXY+XHJcbiAgICAgICAgICA8L2Rpdj5cclxuICAgICAgICA8L2Rpdj5cclxuICAgICAgPC9kaXY+XHJcbiAgICA8L2Rpdj5cclxuXHJcbiAgICA8ZGl2IGNsYXNzPVwicWEtc2xpZGVcIiBkYXRhLXNsaWRlPVwiMlwiIHN0eWxlPVwiZGlzcGxheTpub25lXCI+XHJcbiAgICAgIDxkaXYgY2xhc3M9XCJxYS1ibG9ja1wiPlxyXG4gICAgICAgIDxoMz5QcmVndW50YSAzIFx1MjAxNCBSZWxhY2lvbmFyIChNYXRjaCk8L2gzPlxyXG4gICAgICAgIDxkaXYgY2xhc3M9XCJxdWUgbWF0Y2hcIj5cclxuICAgICAgICAgIDxkaXYgY2xhc3M9XCJpbmZvXCI+PGgzIGNsYXNzPVwibm9cIj5QcmVndW50YSA8c3BhbiBjbGFzcz1cInFub1wiPjM8L3NwYW4+PC9oMz48L2Rpdj5cclxuICAgICAgICAgIDxkaXYgY2xhc3M9XCJjb250ZW50XCI+XHJcbiAgICAgICAgICAgIDxkaXYgY2xhc3M9XCJmb3JtdWxhdGlvbiBjbGVhcmZpeFwiPlxyXG4gICAgICAgICAgICAgIDxkaXYgY2xhc3M9XCJxdGV4dFwiPlJlbGFjaW9uYSBjYWRhIGNhcGEgZGVsIG1vZGVsbyBPU0kgY29uIHN1IGZ1bmNpXHUwMEYzbiBwcmluY2lwYWwuPC9kaXY+XHJcbiAgICAgICAgICAgICAgPGRpdiBjbGFzcz1cImFibG9ja1wiPlxyXG4gICAgICAgICAgICAgICAgPHRhYmxlIGNsYXNzPVwiYW5zd2VyXCI+XHJcbiAgICAgICAgICAgICAgICAgIDx0Ym9keT5cclxuICAgICAgICAgICAgICAgICAgICA8dHIgY2xhc3M9XCJyMFwiPlxyXG4gICAgICAgICAgICAgICAgICAgICAgPHRkIGNsYXNzPVwidGV4dFwiPkVucnV0YW1pZW50byBsXHUwMEYzZ2ljbyBkZSBwYXF1ZXRlczwvdGQ+XHJcbiAgICAgICAgICAgICAgICAgICAgICA8dGQgY2xhc3M9XCJjb250cm9sXCI+XHJcbiAgICAgICAgICAgICAgICAgICAgICAgIDxzZWxlY3Q+XHJcbiAgICAgICAgICAgICAgICAgICAgICAgICAgPG9wdGlvbiB2YWx1ZT1cIjBcIj5FbGVnaXIuLi48L29wdGlvbj5cclxuICAgICAgICAgICAgICAgICAgICAgICAgICA8b3B0aW9uIHZhbHVlPVwiMVwiPkNhcGEgRlx1MDBFRHNpY2E8L29wdGlvbj5cclxuICAgICAgICAgICAgICAgICAgICAgICAgICA8b3B0aW9uIHZhbHVlPVwiMlwiPkNhcGEgZGUgUmVkPC9vcHRpb24+XHJcbiAgICAgICAgICAgICAgICAgICAgICAgICAgPG9wdGlvbiB2YWx1ZT1cIjNcIj5DYXBhIGRlIFRyYW5zcG9ydGU8L29wdGlvbj5cclxuICAgICAgICAgICAgICAgICAgICAgICAgPC9zZWxlY3Q+XHJcbiAgICAgICAgICAgICAgICAgICAgICA8L3RkPlxyXG4gICAgICAgICAgICAgICAgICAgIDwvdHI+XHJcbiAgICAgICAgICAgICAgICAgICAgPHRyIGNsYXNzPVwicjFcIj5cclxuICAgICAgICAgICAgICAgICAgICAgIDx0ZCBjbGFzcz1cInRleHRcIj5UcmFuc21pc2lcdTAwRjNuIGRlIGJpdHMgcG9yIGVsIG1lZGlvIGZcdTAwRURzaWNvPC90ZD5cclxuICAgICAgICAgICAgICAgICAgICAgIDx0ZCBjbGFzcz1cImNvbnRyb2xcIj5cclxuICAgICAgICAgICAgICAgICAgICAgICAgPHNlbGVjdD5cclxuICAgICAgICAgICAgICAgICAgICAgICAgICA8b3B0aW9uIHZhbHVlPVwiMFwiPkVsZWdpci4uLjwvb3B0aW9uPlxyXG4gICAgICAgICAgICAgICAgICAgICAgICAgIDxvcHRpb24gdmFsdWU9XCIxXCI+Q2FwYSBGXHUwMEVEc2ljYTwvb3B0aW9uPlxyXG4gICAgICAgICAgICAgICAgICAgICAgICAgIDxvcHRpb24gdmFsdWU9XCIyXCI+Q2FwYSBkZSBSZWQ8L29wdGlvbj5cclxuICAgICAgICAgICAgICAgICAgICAgICAgICA8b3B0aW9uIHZhbHVlPVwiM1wiPkNhcGEgZGUgVHJhbnNwb3J0ZTwvb3B0aW9uPlxyXG4gICAgICAgICAgICAgICAgICAgICAgICA8L3NlbGVjdD5cclxuICAgICAgICAgICAgICAgICAgICAgIDwvdGQ+XHJcbiAgICAgICAgICAgICAgICAgICAgPC90cj5cclxuICAgICAgICAgICAgICAgICAgICA8dHIgY2xhc3M9XCJyMFwiPlxyXG4gICAgICAgICAgICAgICAgICAgICAgPHRkIGNsYXNzPVwidGV4dFwiPkNvbnRyb2wgZGUgZmx1am8geSBzZWdtZW50YWNpXHUwMEYzbiBleHRyZW1vIGEgZXh0cmVtbzwvdGQ+XHJcbiAgICAgICAgICAgICAgICAgICAgICA8dGQgY2xhc3M9XCJjb250cm9sXCI+XHJcbiAgICAgICAgICAgICAgICAgICAgICAgIDxzZWxlY3Q+XHJcbiAgICAgICAgICAgICAgICAgICAgICAgICAgPG9wdGlvbiB2YWx1ZT1cIjBcIj5FbGVnaXIuLi48L29wdGlvbj5cclxuICAgICAgICAgICAgICAgICAgICAgICAgICA8b3B0aW9uIHZhbHVlPVwiMVwiPkNhcGEgRlx1MDBFRHNpY2E8L29wdGlvbj5cclxuICAgICAgICAgICAgICAgICAgICAgICAgICA8b3B0aW9uIHZhbHVlPVwiMlwiPkNhcGEgZGUgUmVkPC9vcHRpb24+XHJcbiAgICAgICAgICAgICAgICAgICAgICAgICAgPG9wdGlvbiB2YWx1ZT1cIjNcIj5DYXBhIGRlIFRyYW5zcG9ydGU8L29wdGlvbj5cclxuICAgICAgICAgICAgICAgICAgICAgICAgPC9zZWxlY3Q+XHJcbiAgICAgICAgICAgICAgICAgICAgICA8L3RkPlxyXG4gICAgICAgICAgICAgICAgICAgIDwvdHI+XHJcbiAgICAgICAgICAgICAgICAgIDwvdGJvZHk+XHJcbiAgICAgICAgICAgICAgICA8L3RhYmxlPlxyXG4gICAgICAgICAgICAgIDwvZGl2PlxyXG4gICAgICAgICAgICA8L2Rpdj5cclxuICAgICAgICAgIDwvZGl2PlxyXG4gICAgICAgIDwvZGl2PlxyXG4gICAgICA8L2Rpdj5cclxuICAgIDwvZGl2PlxyXG5cclxuICAgIDxkaXYgY2xhc3M9XCJxYS1zbGlkZVwiIGRhdGEtc2xpZGU9XCIzXCIgc3R5bGU9XCJkaXNwbGF5Om5vbmVcIj5cclxuICAgICAgPGRpdiBjbGFzcz1cInFhLWJsb2NrXCI+XHJcbiAgICAgICAgPGgzPlByZWd1bnRhIDQgXHUyMDE0IFJlc3B1ZXN0YSBjb3J0YSAoU2hvcnQgQW5zd2VyKTwvaDM+XHJcbiAgICAgICAgPGRpdiBjbGFzcz1cInF1ZSBzaG9ydGFuc3dlclwiPlxyXG4gICAgICAgICAgPGRpdiBjbGFzcz1cImluZm9cIj48aDMgY2xhc3M9XCJub1wiPlByZWd1bnRhIDxzcGFuIGNsYXNzPVwicW5vXCI+NDwvc3Bhbj48L2gzPjwvZGl2PlxyXG4gICAgICAgICAgPGRpdiBjbGFzcz1cImNvbnRlbnRcIj5cclxuICAgICAgICAgICAgPGRpdiBjbGFzcz1cImZvcm11bGF0aW9uIGNsZWFyZml4XCI+XHJcbiAgICAgICAgICAgICAgPGRpdiBjbGFzcz1cInF0ZXh0XCI+XHUwMEJGQ3VcdTAwRTFsIGVzIGVsIG5vbWJyZSBjb21wbGV0byBkZWwgcHJvdG9jb2xvIGN1eWFzIHNpZ2xhcyBzb24gSFRUUD88L2Rpdj5cclxuICAgICAgICAgICAgICA8ZGl2IGNsYXNzPVwiYWJsb2NrXCI+XHJcbiAgICAgICAgICAgICAgICA8bGFiZWwgZm9yPVwicWFfc2FfaW5wdXRcIj5SZXNwdWVzdGE6PC9sYWJlbD5cclxuICAgICAgICAgICAgICAgIDxpbnB1dCB0eXBlPVwidGV4dFwiIGlkPVwicWFfc2FfaW5wdXRcIiBjbGFzcz1cImZvcm0tY29udHJvbCBkLWlubGluZVwiIHNpemU9XCIzMFwiIHBsYWNlaG9sZGVyPVwiRXNjcmliZSB0dSByZXNwdWVzdGEuLi5cIiAvPlxyXG4gICAgICAgICAgICAgIDwvZGl2PlxyXG4gICAgICAgICAgICA8L2Rpdj5cclxuICAgICAgICAgIDwvZGl2PlxyXG4gICAgICAgIDwvZGl2PlxyXG4gICAgICA8L2Rpdj5cclxuICAgIDwvZGl2PlxyXG5cclxuICAgIDxkaXYgY2xhc3M9XCJxYS1zbGlkZVwiIGRhdGEtc2xpZGU9XCI0XCIgc3R5bGU9XCJkaXNwbGF5Om5vbmVcIj5cclxuICAgICAgPGRpdiBjbGFzcz1cInFhLWJsb2NrXCI+XHJcbiAgICAgICAgPGgzPlByZWd1bnRhIDUgXHUyMDE0IE51bVx1MDBFOXJpY2EgKE51bWVyaWNhbCk8L2gzPlxyXG4gICAgICAgIDxkaXYgY2xhc3M9XCJxdWUgbnVtZXJpY2FsXCI+XHJcbiAgICAgICAgICA8ZGl2IGNsYXNzPVwiaW5mb1wiPjxoMyBjbGFzcz1cIm5vXCI+UHJlZ3VudGEgPHNwYW4gY2xhc3M9XCJxbm9cIj41PC9zcGFuPjwvaDM+PC9kaXY+XHJcbiAgICAgICAgICA8ZGl2IGNsYXNzPVwiY29udGVudFwiPlxyXG4gICAgICAgICAgICA8ZGl2IGNsYXNzPVwiZm9ybXVsYXRpb24gY2xlYXJmaXhcIj5cclxuICAgICAgICAgICAgICA8ZGl2IGNsYXNzPVwicXRleHRcIj5cdTAwQkZDdVx1MDBFMW50b3MgYml0cyBjb21wb25lbiB1bmEgZGlyZWNjaVx1MDBGM24gSVB2ND88L2Rpdj5cclxuICAgICAgICAgICAgICA8ZGl2IGNsYXNzPVwiYWJsb2NrXCI+XHJcbiAgICAgICAgICAgICAgICA8bGFiZWwgZm9yPVwicWFfbnVtX2lucHV0XCI+UmVzcHVlc3RhOjwvbGFiZWw+XHJcbiAgICAgICAgICAgICAgICA8aW5wdXQgdHlwZT1cInRleHRcIiBpZD1cInFhX251bV9pbnB1dFwiIGNsYXNzPVwiZm9ybS1jb250cm9sIGQtaW5saW5lXCIgc2l6ZT1cIjEwXCIgcGxhY2Vob2xkZXI9XCJOXHUwMEZBbWVyby4uLlwiIC8+XHJcbiAgICAgICAgICAgICAgPC9kaXY+XHJcbiAgICAgICAgICAgIDwvZGl2PlxyXG4gICAgICAgICAgPC9kaXY+XHJcbiAgICAgICAgPC9kaXY+XHJcbiAgICAgIDwvZGl2PlxyXG4gICAgPC9kaXY+XHJcblxyXG4gICAgPGRpdiBjbGFzcz1cInFhLXNsaWRlXCIgZGF0YS1zbGlkZT1cIjVcIiBzdHlsZT1cImRpc3BsYXk6bm9uZVwiPlxyXG4gICAgICA8ZGl2IGNsYXNzPVwicWEtYmxvY2tcIj5cclxuICAgICAgICA8aDM+UHJlZ3VudGEgNiBcdTIwMTQgU2VsZWNjaW9uYXIgcGFsYWJyYXMgcXVlIGZhbHRhbiAoR2FwIFNlbGVjdCk8L2gzPlxyXG4gICAgICAgIDxkaXYgY2xhc3M9XCJxdWUgZ2Fwc2VsZWN0XCI+XHJcbiAgICAgICAgICA8ZGl2IGNsYXNzPVwiaW5mb1wiPjxoMyBjbGFzcz1cIm5vXCI+UHJlZ3VudGEgPHNwYW4gY2xhc3M9XCJxbm9cIj42PC9zcGFuPjwvaDM+PC9kaXY+XHJcbiAgICAgICAgICA8ZGl2IGNsYXNzPVwiY29udGVudFwiPlxyXG4gICAgICAgICAgICA8ZGl2IGNsYXNzPVwiZm9ybXVsYXRpb24gY2xlYXJmaXhcIj5cclxuICAgICAgICAgICAgICA8ZGl2IGNsYXNzPVwicXRleHRcIj5FbCBwcm90b2NvbG9cclxuICAgICAgICAgICAgICAgIDxzZWxlY3QgbmFtZT1cInJlc3BfMVwiPlxyXG4gICAgICAgICAgICAgICAgICA8b3B0aW9uIHZhbHVlPVwiMFwiPkVsZWdpci4uLjwvb3B0aW9uPlxyXG4gICAgICAgICAgICAgICAgICA8b3B0aW9uIHZhbHVlPVwiMVwiPkhUVFA8L29wdGlvbj5cclxuICAgICAgICAgICAgICAgICAgPG9wdGlvbiB2YWx1ZT1cIjJcIj5GVFA8L29wdGlvbj5cclxuICAgICAgICAgICAgICAgICAgPG9wdGlvbiB2YWx1ZT1cIjNcIj5TTVRQPC9vcHRpb24+XHJcbiAgICAgICAgICAgICAgICA8L3NlbGVjdD5cclxuICAgICAgICAgICAgICAgIHV0aWxpemEgZWwgcHVlcnRvXHJcbiAgICAgICAgICAgICAgICA8c2VsZWN0IG5hbWU9XCJyZXNwXzJcIj5cclxuICAgICAgICAgICAgICAgICAgPG9wdGlvbiB2YWx1ZT1cIjBcIj5FbGVnaXIuLi48L29wdGlvbj5cclxuICAgICAgICAgICAgICAgICAgPG9wdGlvbiB2YWx1ZT1cIjFcIj44MDwvb3B0aW9uPlxyXG4gICAgICAgICAgICAgICAgICA8b3B0aW9uIHZhbHVlPVwiMlwiPjIxPC9vcHRpb24+XHJcbiAgICAgICAgICAgICAgICAgIDxvcHRpb24gdmFsdWU9XCIzXCI+MjU8L29wdGlvbj5cclxuICAgICAgICAgICAgICAgIDwvc2VsZWN0PlxyXG4gICAgICAgICAgICAgICAgcGFyYSB0clx1MDBFMWZpY28gbm8gY2lmcmFkbywgbWllbnRyYXMgcXVlXHJcbiAgICAgICAgICAgICAgICA8c2VsZWN0IG5hbWU9XCJyZXNwXzNcIj5cclxuICAgICAgICAgICAgICAgICAgPG9wdGlvbiB2YWx1ZT1cIjBcIj5FbGVnaXIuLi48L29wdGlvbj5cclxuICAgICAgICAgICAgICAgICAgPG9wdGlvbiB2YWx1ZT1cIjFcIj5IVFRQUzwvb3B0aW9uPlxyXG4gICAgICAgICAgICAgICAgICA8b3B0aW9uIHZhbHVlPVwiMlwiPlNGVFA8L29wdGlvbj5cclxuICAgICAgICAgICAgICAgICAgPG9wdGlvbiB2YWx1ZT1cIjNcIj5TTVRQUzwvb3B0aW9uPlxyXG4gICAgICAgICAgICAgICAgPC9zZWxlY3Q+XHJcbiAgICAgICAgICAgICAgICB1dGlsaXphIGVsIHB1ZXJ0b1xyXG4gICAgICAgICAgICAgICAgPHNlbGVjdCBuYW1lPVwicmVzcF80XCI+XHJcbiAgICAgICAgICAgICAgICAgIDxvcHRpb24gdmFsdWU9XCIwXCI+RWxlZ2lyLi4uPC9vcHRpb24+XHJcbiAgICAgICAgICAgICAgICAgIDxvcHRpb24gdmFsdWU9XCIxXCI+NDQzPC9vcHRpb24+XHJcbiAgICAgICAgICAgICAgICAgIDxvcHRpb24gdmFsdWU9XCIyXCI+MjI8L29wdGlvbj5cclxuICAgICAgICAgICAgICAgICAgPG9wdGlvbiB2YWx1ZT1cIjNcIj40NjU8L29wdGlvbj5cclxuICAgICAgICAgICAgICAgIDwvc2VsZWN0PlxyXG4gICAgICAgICAgICAgICAgcGFyYSBjb211bmljYWNpb25lcyBzZWd1cmFzLlxyXG4gICAgICAgICAgICAgIDwvZGl2PlxyXG4gICAgICAgICAgICA8L2Rpdj5cclxuICAgICAgICAgIDwvZGl2PlxyXG4gICAgICAgIDwvZGl2PlxyXG4gICAgICA8L2Rpdj5cclxuICAgIDwvZGl2PlxyXG4gIGA7XHJcblxyXG4gIGF0dGFjaFFBTmF2aWdhdGlvbih0YXJnZXQpO1xyXG59XHJcblxyXG5mdW5jdGlvbiBpbmplY3RRQVNjZW5hcmlvKHNjZW5hcmlvOiBRQVNjZW5hcmlvVHlwZSk6IHZvaWQge1xyXG5cclxuICBjb25zdCBzdHlsZUlkID0gXCJzdHVkeS1hc3Npc3QtcWEtc2FuZGJveC1zdHlsZVwiO1xyXG4gIGlmICghZG9jdW1lbnQuZ2V0RWxlbWVudEJ5SWQoc3R5bGVJZCkpIHtcclxuICAgIGNvbnN0IHN0eWxlID0gZG9jdW1lbnQuY3JlYXRlRWxlbWVudChcInN0eWxlXCIpO1xyXG4gICAgc3R5bGUuaWQgPSBzdHlsZUlkO1xyXG4gICAgc3R5bGUudGV4dENvbnRlbnQgPSBgXHJcbiAgICAgICNzdHVkeS1hc3Npc3QtcWEtc2FuZGJveCB7XHJcbiAgICAgICAgcG9zaXRpb246IHJlbGF0aXZlO1xyXG4gICAgICAgIHotaW5kZXg6IDk5OTc7XHJcbiAgICAgICAgbWFyZ2luOiAyMHB4O1xyXG4gICAgICAgIHBhZGRpbmc6IDE2cHg7XHJcbiAgICAgICAgYm9yZGVyOiAycHggZGFzaGVkICMzYjgyZjY7XHJcbiAgICAgICAgYm9yZGVyLXJhZGl1czogMTJweDtcclxuICAgICAgICBiYWNrZ3JvdW5kOiAjZjhmYWZjO1xyXG4gICAgICAgIGJveC1zaGFkb3c6IDAgMnB4IDEwcHggcmdiYSgwLDAsMCwwLjA4KTtcclxuICAgICAgICBmb250LWZhbWlseTogQXJpYWwsIHNhbnMtc2VyaWY7XHJcbiAgICAgIH1cclxuICAgICAgI3N0dWR5LWFzc2lzdC1xYS1zYW5kYm94IGgyIHsgbWFyZ2luOiAwIDAgOHB4OyBjb2xvcjogIzFkNGVkODsgfVxyXG4gICAgICAjc3R1ZHktYXNzaXN0LXFhLXNhbmRib3ggLnFhLW1ldGEgeyBtYXJnaW46IDAgMCAxMnB4OyBjb2xvcjogIzMzNDE1NTsgZm9udC1zaXplOiAxM3B4OyB9XHJcbiAgICAgICNzdHVkeS1hc3Npc3QtcWEtc2FuZGJveCAucWEtYmxvY2sgeyBtYXJnaW4tdG9wOiAxMHB4OyB9XHJcbiAgICAgICNzdHVkeS1hc3Npc3QtcWEtc2FuZGJveCAucWEtcXVlc3Rpb24tdGl0bGUgeyBmb250LXdlaWdodDogNzAwOyBtYXJnaW46IDEwcHggMDsgfVxyXG4gICAgICAjc3R1ZHktYXNzaXN0LXFhLXNhbmRib3ggLnFhLXRpcCB7IGNvbG9yOiAjNDc1NTY5OyBmb250LXNpemU6IDEzcHg7IG1hcmdpbi1ib3R0b206IDhweDsgfVxyXG4gICAgICAjc3R1ZHktYXNzaXN0LXFhLXNhbmRib3ggLnF1ZSB7XHJcbiAgICAgICAgYm9yZGVyOiAxcHggc29saWQgI2UyZThmMDtcclxuICAgICAgICBib3JkZXItcmFkaXVzOiAxMHB4O1xyXG4gICAgICAgIHBhZGRpbmc6IDEycHg7XHJcbiAgICAgICAgYmFja2dyb3VuZDogd2hpdGU7XHJcbiAgICAgIH1cclxuICAgICAgI3N0dWR5LWFzc2lzdC1xYS1zYW5kYm94IC5xdGV4dCB7IG1hcmdpbjogOHB4IDA7IGNvbG9yOiAjMTExODI3OyB9XHJcbiAgICAgICNzdHVkeS1hc3Npc3QtcWEtc2FuZGJveCAuYW5zd2VyIC5yMCxcclxuICAgICAgI3N0dWR5LWFzc2lzdC1xYS1zYW5kYm94IC5hbnN3ZXIgLnIxIHtcclxuICAgICAgICBtYXJnaW46IDZweCAwO1xyXG4gICAgICAgIGRpc3BsYXk6IGZsZXg7XHJcbiAgICAgICAgYWxpZ24taXRlbXM6IGNlbnRlcjtcclxuICAgICAgICBnYXA6IDhweDtcclxuICAgICAgfVxyXG4gICAgICAjc3R1ZHktYXNzaXN0LXFhLXNhbmRib3ggLnFhLXF1aXotaGVhZGVyIHtcclxuICAgICAgICBkaXNwbGF5OiBmbGV4O1xyXG4gICAgICAgIGZsZXgtd3JhcDogd3JhcDtcclxuICAgICAgICBhbGlnbi1pdGVtczogY2VudGVyO1xyXG4gICAgICAgIGdhcDogMTBweDtcclxuICAgICAgICBtYXJnaW4tYm90dG9tOiAxMnB4O1xyXG4gICAgICAgIHBhZGRpbmctYm90dG9tOiAxMHB4O1xyXG4gICAgICAgIGJvcmRlci1ib3R0b206IDFweCBzb2xpZCAjY2JkNWUxO1xyXG4gICAgICB9XHJcbiAgICAgICNzdHVkeS1hc3Npc3QtcWEtc2FuZGJveCAucWEtcXVpei1wbGF0Zm9ybSB7XHJcbiAgICAgICAgZm9udC13ZWlnaHQ6IDcwMDtcclxuICAgICAgICBjb2xvcjogIzFkNGVkODtcclxuICAgICAgICBmb250LXNpemU6IDE1cHg7XHJcbiAgICAgICAgZmxleDogMTtcclxuICAgICAgfVxyXG4gICAgICAjc3R1ZHktYXNzaXN0LXFhLXNhbmRib3ggLnFhLXF1aXotbmF2IHtcclxuICAgICAgICBkaXNwbGF5OiBmbGV4O1xyXG4gICAgICAgIGFsaWduLWl0ZW1zOiBjZW50ZXI7XHJcbiAgICAgICAgZ2FwOiA4cHg7XHJcbiAgICAgIH1cclxuICAgICAgI3N0dWR5LWFzc2lzdC1xYS1zYW5kYm94IC5xYS1xdWl6LXByb2dyZXNzIHtcclxuICAgICAgICBmb250LXNpemU6IDEzcHg7XHJcbiAgICAgICAgY29sb3I6ICMzMzQxNTU7XHJcbiAgICAgICAgbWluLXdpZHRoOiA4MHB4O1xyXG4gICAgICAgIHRleHQtYWxpZ246IGNlbnRlcjtcclxuICAgICAgfVxyXG4gICAgICAjc3R1ZHktYXNzaXN0LXFhLXNhbmRib3ggLnFhLXNhbmRib3gtbmF2LWJ0biB7XHJcbiAgICAgICAgcGFkZGluZzogNHB4IDEwcHg7XHJcbiAgICAgICAgZm9udC1zaXplOiAxM3B4O1xyXG4gICAgICAgIGJhY2tncm91bmQ6ICMzYjgyZjY7XHJcbiAgICAgICAgY29sb3I6IHdoaXRlO1xyXG4gICAgICAgIGJvcmRlcjogbm9uZTtcclxuICAgICAgICBib3JkZXItcmFkaXVzOiA2cHg7XHJcbiAgICAgICAgY3Vyc29yOiBwb2ludGVyO1xyXG4gICAgICB9XHJcbiAgICAgICNzdHVkeS1hc3Npc3QtcWEtc2FuZGJveCAucWEtc2FuZGJveC1uYXYtYnRuOmRpc2FibGVkIHtcclxuICAgICAgICBiYWNrZ3JvdW5kOiAjOTRhM2I4O1xyXG4gICAgICAgIGN1cnNvcjogZGVmYXVsdDtcclxuICAgICAgfVxyXG4gICAgICAjc3R1ZHktYXNzaXN0LXFhLXNhbmRib3ggdGFibGUuYW5zd2VyIHtcclxuICAgICAgICB3aWR0aDogMTAwJTtcclxuICAgICAgICBib3JkZXItY29sbGFwc2U6IGNvbGxhcHNlO1xyXG4gICAgICB9XHJcbiAgICAgICNzdHVkeS1hc3Npc3QtcWEtc2FuZGJveCB0YWJsZS5hbnN3ZXIgdGQge1xyXG4gICAgICAgIHBhZGRpbmc6IDhweDtcclxuICAgICAgICBib3JkZXI6IDFweCBzb2xpZCAjZTJlOGYwO1xyXG4gICAgICAgIHZlcnRpY2FsLWFsaWduOiBtaWRkbGU7XHJcbiAgICAgIH1cclxuICAgICAgI3N0dWR5LWFzc2lzdC1xYS1zYW5kYm94IHRhYmxlLmFuc3dlciB0ZC5jb250cm9sIHNlbGVjdCB7XHJcbiAgICAgICAgcGFkZGluZzogNHB4IDZweDtcclxuICAgICAgICBib3JkZXI6IDFweCBzb2xpZCAjY2JkNWUxO1xyXG4gICAgICAgIGJvcmRlci1yYWRpdXM6IDZweDtcclxuICAgICAgICBiYWNrZ3JvdW5kOiB3aGl0ZTtcclxuICAgICAgICBmb250LXNpemU6IDEzcHg7XHJcbiAgICAgIH1cclxuICAgIGA7XHJcbiAgICBkb2N1bWVudC5oZWFkLmFwcGVuZENoaWxkKHN0eWxlKTtcclxuICB9XHJcblxyXG4gIGNvbnN0IHdyYXBwZXIgPSBkb2N1bWVudC5jcmVhdGVFbGVtZW50KFwic2VjdGlvblwiKTtcclxuICB3cmFwcGVyLmlkID0gXCJzdHVkeS1hc3Npc3QtcWEtc2FuZGJveFwiO1xyXG4gIHdyYXBwZXIuaW5uZXJIVE1MID0gYFxyXG4gICAgPGgyPlx1RDgzRVx1RERFQSBTdHVkeSBBc3Npc3QgUUEgU2FuZGJveDwvaDI+XHJcbiAgICA8cCBjbGFzcz1cInFhLW1ldGFcIj5cclxuICAgICAgRXNjZW5hcmlvOiA8c3Ryb25nPiR7c2NlbmFyaW99PC9zdHJvbmc+IFx1MDBCNyBVc2EgQUxUK1cgcGFyYSByZWNhcmdhciBkZXRlY2NpXHUwMEYzbiB5IFNISUZUIHBhcmEgcXVpY2sgYW5hbHlzaXMuXHJcbiAgICA8L3A+XHJcbiAgYDtcclxuXHJcbiAgY29uc3QgY29udGVudCA9IGRvY3VtZW50LmNyZWF0ZUVsZW1lbnQoXCJkaXZcIik7XHJcbiAgd3JhcHBlci5hcHBlbmRDaGlsZChjb250ZW50KTtcclxuXHJcbiAgaWYgKHNjZW5hcmlvID09PSBcIm1vb2RsZS1tY3FcIikge1xyXG4gICAgY29udGVudC5pbm5lckhUTUwgPSBgXHJcbiAgICAgIDxkaXYgY2xhc3M9XCJxYS1ibG9ja1wiPlxyXG4gICAgICAgIDxoMz5Nb29kbGUgU2ltdWxhZG8gXHUyMDE0IE9wY2lcdTAwRjNuIG1cdTAwRkFsdGlwbGU8L2gzPlxyXG4gICAgICAgIDxkaXYgY2xhc3M9XCJxdWUgbXVsdGljaG9pY2VcIj5cclxuICAgICAgICAgIDxkaXYgY2xhc3M9XCJpbmZvXCI+PGgzIGNsYXNzPVwibm9cIj5QcmVndW50YSA8c3BhbiBjbGFzcz1cInFub1wiPjE8L3NwYW4+PC9oMz48L2Rpdj5cclxuICAgICAgICAgIDxkaXYgY2xhc3M9XCJxdGV4dFwiPlx1MDBCRlF1XHUwMEU5IHByb3RvY29sbyB1dGlsaXphIGVsIHB1ZXJ0byA0NDMgcG9yIGRlZmVjdG8/PC9kaXY+XHJcbiAgICAgICAgICA8ZGl2IGNsYXNzPVwiYW5zd2VyXCI+XHJcbiAgICAgICAgICAgIDxkaXYgY2xhc3M9XCJyMFwiPjxzcGFuIGNsYXNzPVwiYW5zd2VybnVtYmVyXCI+YS48L3NwYW4+PGRpdiBjbGFzcz1cImZsZXgtZmlsbFwiPkhUVFA8L2Rpdj48L2Rpdj5cclxuICAgICAgICAgICAgPGRpdiBjbGFzcz1cInIxXCI+PHNwYW4gY2xhc3M9XCJhbnN3ZXJudW1iZXJcIj5iLjwvc3Bhbj48ZGl2IGNsYXNzPVwiZmxleC1maWxsXCI+SFRUUFM8L2Rpdj48L2Rpdj5cclxuICAgICAgICAgICAgPGRpdiBjbGFzcz1cInIwXCI+PHNwYW4gY2xhc3M9XCJhbnN3ZXJudW1iZXJcIj5jLjwvc3Bhbj48ZGl2IGNsYXNzPVwiZmxleC1maWxsXCI+RlRQPC9kaXY+PC9kaXY+XHJcbiAgICAgICAgICAgIDxkaXYgY2xhc3M9XCJyMVwiPjxzcGFuIGNsYXNzPVwiYW5zd2VybnVtYmVyXCI+ZC48L3NwYW4+PGRpdiBjbGFzcz1cImZsZXgtZmlsbFwiPlRlbG5ldDwvZGl2PjwvZGl2PlxyXG4gICAgICAgICAgPC9kaXY+XHJcbiAgICAgICAgPC9kaXY+XHJcbiAgICAgIDwvZGl2PlxyXG4gICAgYDtcclxuICB9IGVsc2UgaWYgKHNjZW5hcmlvID09PSBcIm1vb2RsZS10cnVlZmFsc2VcIikge1xyXG4gICAgY29udGVudC5pbm5lckhUTUwgPSBgXHJcbiAgICAgIDxkaXYgY2xhc3M9XCJxYS1ibG9ja1wiPlxyXG4gICAgICAgIDxoMz5Nb29kbGUgU2ltdWxhZG8gXHUyMDE0IFZlcmRhZGVyby9GYWxzbzwvaDM+XHJcbiAgICAgICAgPGRpdiBjbGFzcz1cInF1ZSB0cnVlZmFsc2VcIj5cclxuICAgICAgICAgIDxkaXYgY2xhc3M9XCJpbmZvXCI+PGgzIGNsYXNzPVwibm9cIj5QcmVndW50YSA8c3BhbiBjbGFzcz1cInFub1wiPjE8L3NwYW4+PC9oMz48L2Rpdj5cclxuICAgICAgICAgIDxkaXYgY2xhc3M9XCJxdGV4dFwiPkxhIGVudHJvcFx1MDBFRGEgcmVwcmVzZW50YSBsYSB0ZW5kZW5jaWEgbmF0dXJhbCBkZSB1biBzaXN0ZW1hIGEgZGVzb3JnYW5pemFyc2UuPC9kaXY+XHJcbiAgICAgICAgICA8ZGl2IGNsYXNzPVwiYW5zd2VyXCI+XHJcbiAgICAgICAgICAgIDxkaXYgY2xhc3M9XCJyMFwiPlxyXG4gICAgICAgICAgICAgIDxpbnB1dCB0eXBlPVwicmFkaW9cIiBuYW1lPVwicWFfdGZcIiB2YWx1ZT1cIjFcIiBpZD1cInFhX3RmX3RydWVcIiAvPlxyXG4gICAgICAgICAgICAgIDxsYWJlbCBmb3I9XCJxYV90Zl90cnVlXCIgY2xhc3M9XCJtcy0xXCI+VmVyZGFkZXJvPC9sYWJlbD5cclxuICAgICAgICAgICAgPC9kaXY+XHJcbiAgICAgICAgICAgIDxkaXYgY2xhc3M9XCJyMVwiPlxyXG4gICAgICAgICAgICAgIDxpbnB1dCB0eXBlPVwicmFkaW9cIiBuYW1lPVwicWFfdGZcIiB2YWx1ZT1cIjBcIiBpZD1cInFhX3RmX2ZhbHNlXCIgLz5cclxuICAgICAgICAgICAgICA8bGFiZWwgZm9yPVwicWFfdGZfZmFsc2VcIiBjbGFzcz1cIm1zLTFcIj5GYWxzbzwvbGFiZWw+XHJcbiAgICAgICAgICAgIDwvZGl2PlxyXG4gICAgICAgICAgPC9kaXY+XHJcbiAgICAgICAgPC9kaXY+XHJcbiAgICAgIDwvZGl2PlxyXG4gICAgYDtcclxuICB9IGVsc2UgaWYgKHNjZW5hcmlvID09PSBcIm1vb2RsZS1zaG9ydGFuc3dlclwiKSB7XHJcbiAgICBpbmplY3RNb29kbGVTaG9ydEFuc3dlcihjb250ZW50KTtcclxuICB9IGVsc2UgaWYgKHNjZW5hcmlvID09PSBcIm1vb2RsZS1udW1lcmljYWxcIikge1xyXG4gICAgaW5qZWN0TW9vZGxlTnVtZXJpY2FsKGNvbnRlbnQpO1xyXG4gIH0gZWxzZSBpZiAoc2NlbmFyaW8gPT09IFwibW9vZGxlLWdhcHNlbGVjdFwiKSB7XHJcbiAgICBpbmplY3RNb29kbGVHYXBTZWxlY3QoY29udGVudCk7XHJcbiAgfSBlbHNlIGlmIChzY2VuYXJpbyA9PT0gXCJuZXRhY2FkLW1jcVwiKSB7XHJcbiAgICBpbmplY3ROZXRBY2FkTWNxKGNvbnRlbnQpO1xyXG4gIH0gZWxzZSBpZiAoc2NlbmFyaW8gPT09IFwibW9vZGxlLW1hdGNoXCIpIHtcclxuICAgIGluamVjdE1vb2RsZU1hdGNoKGNvbnRlbnQpO1xyXG4gIH0gZWxzZSBpZiAoc2NlbmFyaW8gPT09IFwibmV0YWNhZC1xdWl6XCIpIHtcclxuICAgIGluamVjdE5ldEFjYWRRdWl6KGNvbnRlbnQpO1xyXG4gIH0gZWxzZSBpZiAoc2NlbmFyaW8gPT09IFwibW9vZGxlLXF1aXpcIikge1xyXG4gICAgaW5qZWN0TW9vZGxlUXVpeihjb250ZW50KTtcclxuICB9IGVsc2Uge1xyXG4gICAgaW5qZWN0TmV0QWNhZE1hdGNoaW5nKGNvbnRlbnQpO1xyXG4gIH1cclxuXHJcbiAgZG9jdW1lbnQuYm9keS5wcmVwZW5kKHdyYXBwZXIpO1xyXG59XHJcblxyXG5hc3luYyBmdW5jdGlvbiBydW5RQVByZXZpZXcoKTogUHJvbWlzZTxudW1iZXI+IHtcclxuICBjb25zdCByZXN1bHQgPSBhd2FpdCBkZXRlY3RRdWVzdGlvbnNPblBhZ2UoKTtcclxuICBpZiAocmVzdWx0Py5mb3VuZCkge1xyXG4gICAgaGlnaGxpZ2h0RGV0ZWN0ZWRRdWVzdGlvbnMoYW5hbHl6ZVF1ZXN0aW9uV2l0aENhbGxiYWNrcyk7XHJcbiAgfVxyXG4gIHJldHVybiByZXN1bHQ/LmNvdW50ID8/IDA7XHJcbn1cclxuXHJcbi8vID09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09XHJcbi8vIE1lc3NhZ2UgTGlzdGVuZXJcclxuLy8gPT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT1cclxuaW50ZXJmYWNlIENvbnRlbnRNZXNzYWdlIHtcclxuICB0eXBlOiBzdHJpbmc7XHJcbiAgYWN0aXZlPzogYm9vbGVhbjtcclxuICBzZXR0aW5ncz86IFBhcnRpYWw8U2V0dGluZ3M+O1xyXG4gIHJlc3VsdD86IHN0cmluZztcclxuICBxdWVzdGlvbj86IERldGVjdGVkUXVlc3Rpb247XHJcbiAgc2NlbmFyaW8/OiBRQVNjZW5hcmlvVHlwZTtcclxufVxyXG5cclxuY2hyb21lLnJ1bnRpbWUub25NZXNzYWdlLmFkZExpc3RlbmVyKFxyXG4gIChcclxuICAgIG1lc3NhZ2U6IENvbnRlbnRNZXNzYWdlLFxyXG4gICAgX3NlbmRlcjogY2hyb21lLnJ1bnRpbWUuTWVzc2FnZVNlbmRlcixcclxuICAgIHNlbmRSZXNwb25zZTogKHJlc3BvbnNlOiB7IHN1Y2Nlc3M6IGJvb2xlYW47IGVycm9yPzogc3RyaW5nIH0pID0+IHZvaWRcclxuICApOiBib29sZWFuID0+IHtcclxuICAgIHN3aXRjaCAobWVzc2FnZS50eXBlKSB7XHJcbiAgICAgIGNhc2UgXCJFWFRFTlNJT05fU1RBVEVfQ0hBTkdFRFwiOlxyXG4gICAgICAgIHN0YXRlLmlzQWN0aXZlID0gbWVzc2FnZS5hY3RpdmUgPz8gZmFsc2U7XHJcbiAgICAgICAgaWYgKCFzdGF0ZS5pc0FjdGl2ZSkge1xyXG4gICAgICAgICAgY2xlYXJBbGxIaWdobGlnaHRzKCk7XHJcbiAgICAgICAgICBoaWRlT3ZlcmxheSgpO1xyXG4gICAgICAgIH0gZWxzZSBpZiAoIXN0YXRlLmlzSW5pdGlhbGl6ZWQpIHtcclxuICAgICAgICAgIGNoZWNrRG9tYWluQWxsb3dlZCgpLnRoZW4oKGFsbG93ZWQpID0+IHtcclxuICAgICAgICAgICAgaWYgKGFsbG93ZWQpIHtcclxuICAgICAgICAgICAgICBzaG93UmVsb2FkUHJvbXB0KCk7XHJcbiAgICAgICAgICAgIH1cclxuICAgICAgICAgIH0pO1xyXG4gICAgICAgIH0gZWxzZSBpZiAoc3RhdGUuaXNEb21haW5BbGxvd2VkICYmIHN0YXRlLnNldHRpbmdzLmF1dG9EZXRlY3QpIHtcclxuICAgICAgICAgIHJ1bkRldGVjdGlvbigpO1xyXG4gICAgICAgIH1cclxuICAgICAgICBzZW5kUmVzcG9uc2UoeyBzdWNjZXNzOiB0cnVlIH0pO1xyXG4gICAgICAgIGJyZWFrO1xyXG5cclxuICAgICAgY2FzZSBcIlNFVFRJTkdTX0NIQU5HRURcIjpcclxuICAgICAgICBpZiAoIXN0YXRlLmlzRG9tYWluQWxsb3dlZCkge1xyXG4gICAgICAgICAgc2VuZFJlc3BvbnNlKHsgc3VjY2VzczogZmFsc2UsIGVycm9yOiBcIkRvbWFpbiBub3QgYWxsb3dlZFwiIH0pO1xyXG4gICAgICAgICAgYnJlYWs7XHJcbiAgICAgICAgfVxyXG4gICAgICAgIGNvbnN0IG9sZFF1aWNrTW9kZSA9IHN0YXRlLnNldHRpbmdzLnF1aWNrTW9kZTtcclxuICAgICAgICBzdGF0ZS5zZXR0aW5ncyA9IHsgLi4uc3RhdGUuc2V0dGluZ3MsIC4uLm1lc3NhZ2Uuc2V0dGluZ3MgfSBhcyBTZXR0aW5ncztcclxuXHJcbiAgICAgICAgaWYgKG9sZFF1aWNrTW9kZSAhPT0gc3RhdGUuc2V0dGluZ3MucXVpY2tNb2RlKSB7XHJcbiAgICAgICAgICBpZiAoc3RhdGUuc2V0dGluZ3MucXVpY2tNb2RlKSB7XHJcbiAgICAgICAgICAgIGluaXRLZXlib2FyZEhhbmRsZXJzKCk7XHJcbiAgICAgICAgICB9XHJcbiAgICAgICAgICBpbml0T3ZlcmxheUNvbnRhaW5lcigpO1xyXG4gICAgICAgIH1cclxuXHJcbiAgICAgICAgaWYgKHN0YXRlLnNldHRpbmdzLmhpZ2hsaWdodFF1ZXN0aW9ucyAmJiBzdGF0ZS5pc0FjdGl2ZSkge1xyXG4gICAgICAgICAgaGlnaGxpZ2h0RGV0ZWN0ZWRRdWVzdGlvbnMoYW5hbHl6ZVF1ZXN0aW9uV2l0aENhbGxiYWNrcyk7XHJcbiAgICAgICAgfSBlbHNlIHtcclxuICAgICAgICAgIGNsZWFyQWxsSGlnaGxpZ2h0cygpO1xyXG4gICAgICAgIH1cclxuICAgICAgICBzZW5kUmVzcG9uc2UoeyBzdWNjZXNzOiB0cnVlIH0pO1xyXG4gICAgICAgIGJyZWFrO1xyXG5cclxuICAgICAgY2FzZSBcIkFOQUxZWkVfUEFHRVwiOlxyXG4gICAgICAgIGlmICghc3RhdGUuaXNEb21haW5BbGxvd2VkKSB7XHJcbiAgICAgICAgICBzZW5kUmVzcG9uc2UoeyBzdWNjZXNzOiBmYWxzZSwgZXJyb3I6IFwiRG9tYWluIG5vdCBhbGxvd2VkXCIgfSk7XHJcbiAgICAgICAgICBicmVhaztcclxuICAgICAgICB9XHJcbiAgICAgICAgaWYgKHN0YXRlLmlzQWN0aXZlKSB7XHJcbiAgICAgICAgICAvLyBSdW4gZnVsbCBwYWdlIGRldGVjdGlvbiAocmVmcmVzaGVzIHN0YXRlLmRldGVjdGVkUXVlc3Rpb25zLCB1cGRhdGVzIGhpZ2hsaWdodHMpXHJcbiAgICAgICAgICAvLyB0aGVuIG9wZW4gdGhlIG92ZXJsYXkgc2hvd2luZyB0aGUgY3VycmVudGx5IHZpc2libGUgcXVlc3Rpb24gc28gdGhlIHVzZXJcclxuICAgICAgICAgIC8vIGNhbiByZWFkIGl0IGFuZCB0cmlnZ2VyIHRoZSBBSSBhbmFseXNpcyBcdTIwMTQgdGhpcyBpcyB0aGUgbm9uLXF1aWNrIG1vZGUgZmxvdy5cclxuICAgICAgICAgIChhc3luYyAoKSA9PiB7XHJcbiAgICAgICAgICAgIGF3YWl0IHJ1bkRldGVjdGlvbigpO1xyXG4gICAgICAgICAgICBhd2FpdCBzaG93UXVlc3Rpb25zU3VtbWFyeVdpdGhDYWxsYmFja3MoKTtcclxuICAgICAgICAgIH0pKCk7XHJcbiAgICAgICAgfVxyXG4gICAgICAgIHNlbmRSZXNwb25zZSh7IHN1Y2Nlc3M6IHRydWUgfSk7XHJcbiAgICAgICAgYnJlYWs7XHJcblxyXG4gICAgICBjYXNlIFwiQ0xFQVJfUkVTVUxUU1wiOlxyXG4gICAgICAgIGNsZWFyQWxsSGlnaGxpZ2h0cygpO1xyXG4gICAgICAgIGhpZGVPdmVybGF5KCk7XHJcbiAgICAgICAgc3RhdGUuZGV0ZWN0ZWRRdWVzdGlvbnMgPSBbXTtcclxuICAgICAgICBzZW5kUmVzcG9uc2UoeyBzdWNjZXNzOiB0cnVlIH0pO1xyXG4gICAgICAgIGJyZWFrO1xyXG5cclxuICAgICAgY2FzZSBcIkZPUkNFX1NUQVRFX1JFU0VUXCI6XHJcbiAgICAgICAgLy8gUmVzZXQgYWxsIHByb2Nlc3NpbmcgbG9ja3Mgd2l0aG91dCBjbGVhcmluZyBVSSBvciBoaXN0b3J5XHJcbiAgICAgICAgc3RhdGUuaXNSZXF1ZXN0SW5Qcm9ncmVzcyA9IGZhbHNlO1xyXG4gICAgICAgIHN0YXRlLmhhc1ZhbGlkQW5zd2VyID0gZmFsc2U7XHJcbiAgICAgICAgc3RhdGUuc2tpcERlZXBTZWVrID0gZmFsc2U7XHJcbiAgICAgICAgc3RhdGUucmVxdWVzdENhbmNlbGxlZCA9IGZhbHNlO1xyXG4gICAgICAgIHN0YXRlLnBlbmRpbmdRdWVzdGlvbkNoYW5nZSA9IG51bGw7XHJcbiAgICAgICAgaWYgKHN0YXRlLnNsb3dDb25uZWN0aW9uVGltZXIpIHtcclxuICAgICAgICAgIGNsZWFyVGltZW91dChzdGF0ZS5zbG93Q29ubmVjdGlvblRpbWVyKTtcclxuICAgICAgICAgIHN0YXRlLnNsb3dDb25uZWN0aW9uVGltZXIgPSBudWxsO1xyXG4gICAgICAgIH1cclxuICAgICAgICBsb2coXCJbU3R1ZHkgQXNzaXN0XSBGb3JjZSBzdGF0ZSByZXNldCBjb21wbGV0ZVwiKTtcclxuICAgICAgICBzZW5kUmVzcG9uc2UoeyBzdWNjZXNzOiB0cnVlIH0pO1xyXG4gICAgICAgIGJyZWFrO1xyXG5cclxuICAgICAgY2FzZSBcIkFOQUxZU0lTX1JFU1VMVFwiOlxyXG4gICAgICAgIGlmIChtZXNzYWdlLnJlc3VsdCAmJiBtZXNzYWdlLnF1ZXN0aW9uKSB7XHJcbiAgICAgICAgICBkaXNwbGF5QW5hbHlzaXNSZXN1bHQoXHJcbiAgICAgICAgICAgIG1lc3NhZ2UucmVzdWx0LFxyXG4gICAgICAgICAgICBtZXNzYWdlLnF1ZXN0aW9uLFxyXG4gICAgICAgICAgICBzaG93UXVlc3Rpb25zU3VtbWFyeVdpdGhDYWxsYmFja3NcclxuICAgICAgICAgICk7XHJcbiAgICAgICAgfVxyXG4gICAgICAgIHNlbmRSZXNwb25zZSh7IHN1Y2Nlc3M6IHRydWUgfSk7XHJcbiAgICAgICAgYnJlYWs7XHJcblxyXG4gICAgICBjYXNlIFwiUUFfSU5KRUNUX1NDRU5BUklPXCI6XHJcbiAgICAgICAgKGFzeW5jICgpID0+IHtcclxuICAgICAgICAgIHRyeSB7XHJcbiAgICAgICAgICAgIGNvbnN0IHNjZW5hcmlvID0gbWVzc2FnZS5zY2VuYXJpbyA/PyBcIm1vb2RsZS10cnVlZmFsc2VcIjtcclxuICAgICAgICAgICAgaW5qZWN0UUFTY2VuYXJpbyhzY2VuYXJpbyk7XHJcblxyXG4gICAgICAgICAgICAvLyBBbGxvdyBRQSB1c2FnZSBldmVuIGlmIGN1cnJlbnQgZG9tYWluIGlzIG5vdCBpbiBhbGxvd2xpc3RcclxuICAgICAgICAgICAgc3RhdGUuaXNEb21haW5BbGxvd2VkID0gdHJ1ZTtcclxuICAgICAgICAgICAgc3RhdGUuaXNBY3RpdmUgPSB0cnVlO1xyXG4gICAgICAgICAgICBzdGF0ZS5zZXR0aW5ncy5xdWlja01vZGUgPSB0cnVlO1xyXG4gICAgICAgICAgICBzdGF0ZS5zZXR0aW5ncy5oaWdobGlnaHRRdWVzdGlvbnMgPSB0cnVlO1xyXG5cclxuICAgICAgICAgICAgaW5pdEtleWJvYXJkSGFuZGxlcnMoKTtcclxuICAgICAgICAgICAgaW5pdE92ZXJsYXlDb250YWluZXIoKTtcclxuICAgICAgICAgICAgY29uc3QgZGV0ZWN0ZWRDb3VudCA9IGF3YWl0IHJ1blFBUHJldmlldygpO1xyXG5cclxuICAgICAgICAgICAgbG9nKFwiW1N0dWR5IEFzc2lzdF0gUUEgcHJldmlldyBkZXRlY3RlZCBxdWVzdGlvbnM6XCIsIGRldGVjdGVkQ291bnQpO1xyXG4gICAgICAgICAgICBzZW5kUmVzcG9uc2UoeyBzdWNjZXNzOiB0cnVlIH0pO1xyXG4gICAgICAgICAgfSBjYXRjaCAoZXJyb3IpIHtcclxuICAgICAgICAgICAgc2VuZFJlc3BvbnNlKHsgc3VjY2VzczogZmFsc2UsIGVycm9yOiAoZXJyb3IgYXMgRXJyb3IpLm1lc3NhZ2UgfSk7XHJcbiAgICAgICAgICB9XHJcbiAgICAgICAgfSkoKTtcclxuICAgICAgICByZXR1cm4gdHJ1ZTtcclxuXHJcbiAgICAgIGNhc2UgXCJRQV9DTEVBUl9TQ0VOQVJJT1wiOlxyXG4gICAgICAgIGNsZWFyUUFTYW5kYm94KCk7XHJcbiAgICAgICAgY2xlYXJBbGxIaWdobGlnaHRzKCk7XHJcbiAgICAgICAgaGlkZU92ZXJsYXkoKTtcclxuICAgICAgICByZXNldFF1aWNrQW5zd2VyKCk7XHJcbiAgICAgICAgc3RhdGUuZGV0ZWN0ZWRRdWVzdGlvbnMgPSBbXTtcclxuICAgICAgICBzZW5kUmVzcG9uc2UoeyBzdWNjZXNzOiB0cnVlIH0pO1xyXG4gICAgICAgIGJyZWFrO1xyXG4gICAgfVxyXG5cclxuICAgIHJldHVybiB0cnVlOyAvLyBLZWVwIHRoZSBtZXNzYWdlIGNoYW5uZWwgb3BlbiBmb3IgYXN5bmMgcmVzcG9uc2VcclxuICB9XHJcbik7XHJcblxyXG4vLyA9PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PVxyXG4vLyBTdGFydFxyXG4vLyA9PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PVxyXG5cclxuLy8gUmUtZGV0ZWN0IHdoZW4gUUEgcXVpeiBuYXZpZ2F0aW9uIGNoYW5nZXMgdGhlIHZpc2libGUgcXVlc3Rpb25cclxud2luZG93LmFkZEV2ZW50TGlzdGVuZXIoXCJzdHVkeS1hc3Npc3QtbmF2aWdhdGVcIiwgKCkgPT4ge1xyXG4gIGlmIChzdGF0ZS5pc0FjdGl2ZSAmJiBzdGF0ZS5pc0RvbWFpbkFsbG93ZWQpIHtcclxuICAgIHJ1bkRldGVjdGlvbigpO1xyXG4gIH1cclxufSk7XHJcblxyXG5pbml0aWFsaXplKCk7XHJcbiJdLAogICJtYXBwaW5ncyI6ICI7OztBQVVPLE1BQU0sYUFBYTtBQUNuQixNQUFNLE1BQU0sSUFBSSxTQUEwQjtBQUMvQyxRQUFJLFlBQVk7QUFDZCxjQUFRLElBQUksR0FBRyxJQUFJO0FBQUEsSUFDckI7QUFBQSxFQUNGO0FBS08sTUFBTSxRQUFlO0FBQUEsSUFDMUIsVUFBVTtBQUFB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cUI7QUFDN0IseUJBQWEsTUFBTSxtQkFBbUI7QUFDdEMsa0JBQU0sc0JBQXNCO0FBQUEsVUFDOUI7QUFDQSxjQUFJLDJDQUEyQztBQUMvQyx1QkFBYSxFQUFFLFNBQVMsS0FBSyxDQUFDO0FBQzlCO0FBQUEsUUFFRixLQUFLO0FBQ0gsY0FBSSxRQUFRLFVBQVUsUUFBUSxVQUFVO0FBQ3RDO0FBQUEsY0FDRSxRQUFRO0FBQUEsY0FDUixRQUFRO0FBQUEsY0FDUjtBQUFBLFlBQ0Y7QUFBQSxVQUNGO0FBQ0EsdUJBQWEsRUFBRSxTQUFTLEtBQUssQ0FBQztBQUM5QjtBQUFBLFFBRUYsS0FBSztBQUNILFdBQUMsWUFBWTtBQUNYLGdCQUFJO0FBQ0Ysb0JBQU0sV0FBVyxRQUFRLFlBQVk7QUFDckMsK0JBQWlCLFFBQVE7QUFHekIsb0JBQU0sa0JBQWtCO0FBQ3hCLG9CQUFNLFdBQVc7QUFDakIsb0JBQU0sU0FBUyxZQUFZO0FBQzNCLG9CQUFNLFNBQVMscUJBQXFCO0FBRXBDLG1DQUFxQjtBQUNyQixtQ0FBcUI7QUFDckIsb0JBQU0sZ0JBQWdCLE1BQU0sYUFBYTtBQUV6QyxrQkFBSSxpREFBaUQsYUFBYTtBQUNsRSwyQkFBYSxFQUFFLFNBQVMsS0FBSyxDQUFDO0FBQUEsWUFDaEMsU0FBUyxPQUFPO0FBQ2QsMkJBQWEsRUFBRSxTQUFTLE9BQU8sT0FBUSxNQUFnQixRQUFRLENBQUM7QUFBQSxZQUNsRTtBQUFBLFVBQ0YsR0FBRztBQUNILGlCQUFPO0FBQUEsUUFFVCxLQUFLO0FBQ0gseUJBQWU7QUFDZiw2QkFBbUI7QUFDbkIsc0JBQVk7QUFDWiwyQkFBaUI7QUFDakIsZ0JBQU0sb0JBQW9CLENBQUM7QUFDM0IsdUJBQWEsRUFBRSxTQUFTLEtBQUssQ0FBQztBQUM5QjtBQUFBLE1BQ0o7QUFFQSxhQUFPO0FBQUEsSUFDVDtBQUFBLEVBQ0Y7QUFPQSxTQUFPLGlCQUFpQix5QkFBeUIsTUFBTTtBQUNyRCxRQUFJLE1BQU0sWUFBWSxNQUFNLGlCQUFpQjtBQUMzQyxtQkFBYTtBQUFBLElBQ2Y7QUFBQSxFQUNGLENBQUM7QUFFRCxhQUFXOyIsCiAgIm5hbWVzIjogWyJjYXRlZ29yaWVzIiwgIm1hdGNoaW5nT3B0aW9ucyIsICJmcmFtZUhhc1F1aXpDb250ZW50IiwgIndhaXRGb3JRdWl6Q29udGVudCIsICJoYW5kbGVRdWlja0NsaWNrIiwgImluamVjdFdlYmV4VG9nZ2xlV2l0aEN0cmwiLCAidHJpZ2dlclF1aWNrQW5hbHlzaXMiLCAicmVsb2FkUXVpY2tNb2RlIiwgInRvZ2dsZVNBQnV0dG9uVmlzaWJpbGl0eSIsICJjYW5jZWxDdXJyZW50UmVxdWVzdCIsICJjb250YWluZXIiLCAiYW5zd2VyIl0KfQo=
