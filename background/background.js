// src/background/modules/constants.ts
var DEBUG_MODE = true;
var log = (...args) => {
  if (DEBUG_MODE)
    console.log(...args);
};
var CLAUDE_API_BASE = "https://api.anthropic.com/v1/messages";
var DEFAULT_MODEL = "claude-3-haiku-20240307";
var ANTHROPIC_VERSION = "2023-06-01";
var DEEPSEEK_API_BASE = "https://api.deepseek.com/v1/chat/completions";
var DEEPSEEK_REASONER_MODEL = "deepseek-reasoner";
var activeDeepSeekController = null;
function setActiveDeepSeekController(ctrl) {
  activeDeepSeekController = ctrl;
}
var questionsBank = null;
function setQuestionsBank(bank) {
  questionsBank = bank;
}

// src/background/modules/fetchUtils.ts
async function logError(logObj) {
  try {
    const logText = `[${(/* @__PURE__ */ new Date()).toISOString()}] ${JSON.stringify(logObj, null, 2)}
`;
    const { errorLog } = await chrome.storage.local.get("errorLog");
    const newLog = (errorLog || "") + logText;
    await chrome.storage.local.set({ errorLog: newLog });
  } catch (_e) {
  }
}
function fetchWithTimeout(url, options, timeout = 3e4) {
  const timeoutController = new AbortController();
  const timeoutId = setTimeout(() => timeoutController.abort(), timeout);
  let combinedSignal = timeoutController.signal;
  const externalSignal = options.signal;
  if (externalSignal) {
    const combinedController = new AbortController();
    if (externalSignal.aborted) {
      combinedController.abort();
    } else {
      externalSignal.addEventListener("abort", () => combinedController.abort());
    }
    timeoutController.signal.addEventListener("abort", () => combinedController.abort());
    combinedSignal = combinedController.signal;
  }
  const { signal: _, ...optionsWithoutSignal } = options;
  return fetch(url, {
    ...optionsWithoutSignal,
    signal: combinedSignal
  }).finally(() => clearTimeout(timeoutId));
}
async function fetchWithRetry(url, options, maxRetries = 2, timeout = 3e4) {
  let lastError;
  for (let attempt = 1; attempt <= maxRetries + 1; attempt++) {
    try {
      return await fetchWithTimeout(url, options, timeout);
    } catch (error) {
      lastError = error;
      if (error.name === "AbortError") {
        console.warn(`[Study Assist] Request timeout (attempt ${attempt}/${maxRetries + 1})`);
      } else {
        console.warn(`[Study Assist] Request failed (attempt ${attempt}/${maxRetries + 1}):`, error.message);
      }
      if (attempt <= maxRetries) {
        await new Promise((r) => setTimeout(r, 1e3 * attempt));
      }
    }
  }
  throw lastError;
}

// src/background/modules/questionBank.ts
async function loadQuestionsBank() {
  if (questionsBank)
    return questionsBank;
  try {
    const url = chrome.runtime.getURL("data/questions-bank.json");
    const response = await fetch(url);
    const bank = await response.json();
    setQuestionsBank(bank);
    log(
      "[Study Assist] Questions bank loaded:",
      Object.keys(bank.modules).length,
      "modules"
    );
    return bank;
  } catch (error) {
    console.error("[Study Assist] Failed to load questions bank:", error);
    return null;
  }
}
function normalizeForSearch(text) {
  return text.toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g, "").replace(/[\u200B-\u200D\uFEFF]/g, "").replace(/&nbsp;/g, " ").replace(/[¿?¡!.,;:()"\-]/g, "").replace(/\//g, "").replace(/\s+/g, " ").trim();
}
function calculateSimilarity(text1, text2) {
  const words1 = new Set(text1.split(" ").filter((w) => w.length > 2));
  const words2 = new Set(text2.split(" ").filter((w) => w.length > 2));
  if (words1.size === 0 || words2.size === 0)
    return 0;
  let matches = 0;
  for (const word of words1) {
    if (words2.has(word))
      matches++;
  }
  return matches / Math.max(words1.size, words2.size);
}
function calculateContainment(text1, text2) {
  const words1 = new Set(text1.split(" ").filter((w) => w.length > 2));
  const words2 = new Set(text2.split(" ").filter((w) => w.length > 2));
  if (words1.size === 0 || words2.size === 0)
    return 0;
  const [smaller, larger] = words1.size <= words2.size ? [words1, words2] : [words2, words1];
  let matches = 0;
  for (const word of smaller) {
    if (larger.has(word))
      matches++;
  }
  if (smaller.size < 4)
    return 0;
  return matches / smaller.size;
}
function isNetAcadPage(pageTitle, pageUrl) {
  const titleOrUrl = (pageTitle || "") + " " + (pageUrl || "");
  return /netacad|cisco|ccna|ccnp|networking\s*academy|skills\s*for\s*all/i.test(
    titleOrUrl
  );
}
async function findMatchingQuestion(questionText, moduleInfo, pageUrl) {
  if (!isNetAcadPage(moduleInfo, pageUrl)) {
    log("[Study Assist] Question bank: Skipped (not a NetAcad page)");
    return null;
  }
  log("[Study Assist] Question bank: Searching...");
  const bank = await loadQuestionsBank();
  if (!bank)
    return null;
  const normalizedQuestion = normalizeForSearch(questionText);
  let modulesToSearch = [];
  if (moduleInfo) {
    const moduleMatch = moduleInfo.match(/(\d+)[\.\-]?(\d+)?/);
    if (moduleMatch) {
      const moduleNum = parseInt(moduleMatch[1]);
      if (moduleNum >= 1 && moduleNum <= 4) {
        modulesToSearch.push("1-4", `mod-${moduleNum}`);
      } else if (moduleNum >= 5 && moduleNum <= 6) {
        modulesToSearch.push("5-6", `mod-${moduleNum}`);
      } else if (moduleNum >= 7 && moduleNum <= 9) {
        modulesToSearch.push("7-9", `mod-${moduleNum}`);
      } else if (moduleNum >= 10 && moduleNum <= 13) {
        modulesToSearch.push("10-13", `mod-${moduleNum}`);
      } else if (moduleNum >= 14 && moduleNum <= 16) {
        modulesToSearch.push("14-16", `mod-${moduleNum}`);
      }
    }
    if (/final|ptsa|habilidades|práctica/i.test(moduleInfo)) {
      modulesToSearch.push(
        "final-practice",
        "final-skills",
        "final-exam",
        "ptsa-1",
        "ptsa-2"
      );
    }
  }
  if (modulesToSearch.length === 0) {
    modulesToSearch = Object.keys(bank.modules);
  }
  let bestMatch = null;
  let bestSimilarity = 0;
  const isLongText = questionText.length > 800;
  const SIMILARITY_THRESHOLD = isLongText ? 0.55 : 0.6;
  for (const moduleRange of modulesToSearch) {
    const module = bank.modules[moduleRange];
    if (!module || !module.questions)
      continue;
    for (const question of module.questions) {
      let similarity;
      const pageHasPlaceholder = questionText.toLowerCase().includes("partialurlplaceholder");
      const bankHasPlaceholder = question.text.toLowerCase().includes("partialurlplaceholder");
      if (pageHasPlaceholder && bankHasPlaceholder) {
        similarity = 0.95;
      } else {
        const stdSimilarity = calculateSimilarity(normalizedQuestion, question.textNormalized);
        const containment = calculateContainment(normalizedQuestion, question.textNormalized);
        similarity = Math.max(stdSimilarity, containment);
      }
      if (similarity > bestSimilarity && similarity >= SIMILARITY_THRESHOLD) {
        bestSimilarity = similarity;
        bestMatch = {
          ...question,
          moduleRange,
          similarity: Math.round(similarity * 100)
        };
      }
    }
  }
  if (bestMatch) {
    log(`[Study Assist] QUESTION BANK MATCH (${bestMatch.similarity}% similarity) from module ${bestMatch.moduleRange}:`);
    log(`[Study Assist] Bank Q: "${bestMatch.text.substring(0, 80)}..."`);
    log(`[Study Assist] Page text length: ${questionText.length} chars`);
    log(`[Study Assist] Bank text length: ${bestMatch.text.length} chars`);
    log(`[Study Assist] Page normalized: "${normalizedQuestion.substring(0, 100)}..."`);
    log(`[Study Assist] Bank normalized: "${bestMatch.textNormalized.substring(0, 100)}..."`);
    log(`[Study Assist] Explanation: "${bestMatch.explanation ? bestMatch.explanation.substring(0, 100) + "..." : "N/A"}"`);
  } else {
    log("[Study Assist] No match in question bank");
  }
  return bestMatch;
}

// src/background/modules/prompts.ts
function formatQuestionType(type) {
  const types = {
    "multiple-choice": "Multiple Choice",
    "true-false": "True/False",
    "fill-blank": "Fill in the Blank",
    matching: "Matching",
    "short-answer": "Short Answer",
    numerical: "Numerical",
    "select-missing-words": "Select Missing Words",
    unknown: "General Question"
  };
  return types[type || "unknown"] || types["unknown"];
}
var NUMBER_WORD_MAP = {
  dos: 2,
  two: 2,
  2: 2,
  tres: 3,
  three: 3,
  3: 3,
  cuatro: 4,
  four: 4,
  4: 4,
  cinco: 5,
  five: 5,
  5: 5
};
var COUNT_PATTERNS = [
  /elija\s*(dos|tres|cuatro|cinco|2|3|4|5)/i,
  /escoja\s*(dos|tres|cuatro|cinco|2|3|4|5)/i,
  /seleccione\s*(dos|tres|cuatro|cinco|2|3|4|5)/i,
  /select\s*(two|three|four|five|2|3|4|5)/i,
  /choose\s*(two|three|four|five|2|3|4|5)/i,
  /\(\s*(dos|tres|cuatro|two|three|four|2|3|4|5)\s*opciones?\s*\)/i
];
function extractRequiredAnswers(questionText) {
  for (const pattern of COUNT_PATTERNS) {
    const match = questionText.match(pattern);
    if (match && match[1]) {
      const num = NUMBER_WORD_MAP[match[1].toLowerCase()];
      if (num)
        return num;
    }
  }
  return 1;
}
function getExpertContext(pageTitle) {
  const isNetAcad = /netacad|cisco|ccna|ccnp|networking academy|skills\s*for\s*all/i.test(pageTitle || "");
  const expertContext = isNetAcad ? `You are a CCNA/CCNP certified networking expert with deep knowledge of:
- Cisco IOS commands and configurations
- Routing protocols (OSPF, EIGRP, BGP, RIP)
- Switching concepts (VLANs, STP, EtherChannel, trunking)
- Network security (ACLs, NAT, firewalls, VPNs)
- Subnetting and IP addressing (IPv4/IPv6)
- Network services (DHCP, DNS, NTP, SNMP)
- Wireless networking
- Network automation and programmability

Use your expertise to analyze this Cisco/networking question accurately.` : "You are an expert exam analyst with broad knowledge across all academic and technical subjects.";
  return { isNetAcad, expertContext };
}
function buildReferenceSection(matchedQuestion) {
  if (!matchedQuestion || !matchedQuestion.explanation)
    return "";
  return `
REFERENCE MATERIAL (from verified exam bank - ${matchedQuestion.similarity}% match):
Question: ${matchedQuestion.text}
Options: ${matchedQuestion.options.join(" | ")}
Explanation: ${matchedQuestion.explanation}

Use this reference to inform your analysis, but verify it applies to the current question.
`;
}
function buildDeepSeekPrompt(context, matchedQuestion = null) {
  const { questionText, questionType, options, categories, matchingOptions, matchingStyle, courseName } = context;
  const { expertContext } = getExpertContext(context.pageTitle);
  const referenceSection = buildReferenceSection(matchedQuestion);
  const requiredAnswers = extractRequiredAnswers(questionText);
  if (questionType === "matching" && categories && matchingOptions) {
    return buildDeepSeekMatchingPrompt(context, expertContext, referenceSection);
  }
  if (questionType === "select-missing-words" && context.selectGaps && context.selectChoices) {
    return buildDeepSeekSelectMissingWordsPrompt(context, expertContext);
  }
  if (questionType === "short-answer" || questionType === "numerical") {
    const academicContext2 = courseName ? `
ACADEMIC CONTEXT:
Course: ${courseName}
` : "";
    const typeLabel = questionType === "numerical" ? "Numerical" : "Short Answer";
    return `${expertContext}${academicContext2}
${referenceSection}
This is a ${typeLabel} question. Answer with a concise, precise response.

QUESTION: ${questionText}

INSTRUCTIONS:
1. Analyze the question carefully
2. Provide the correct answer
3. Rate your confidence: LOW, MEDIUM, or HIGH

RESPONSE FORMAT (exactly as shown):
ANSWER: [your answer]
CONFIDENCE: [LOW/MEDIUM/HIGH]`;
  }
  const academicContext = courseName ? `
ACADEMIC CONTEXT:
Course: ${courseName}
` : "";
  let prompt = `${expertContext}${academicContext}
${referenceSection}
QUESTION: ${questionText}

OPTIONS:
`;
  if (options && options.length > 0) {
    options.forEach((opt) => {
      prompt += `${opt.letter}) ${opt.text}
`;
    });
  }
  if (requiredAnswers > 1) {
    prompt += `
This question requires EXACTLY ${requiredAnswers} correct answers.

INSTRUCTIONS:
1. Analyze the question thoroughly
2. Evaluate each option carefully
3. Select exactly ${requiredAnswers} options that are correct
4. Rate your confidence: LOW, MEDIUM, or HIGH
   - HIGH: You are very certain (>90% sure) based on clear technical facts
   - MEDIUM: You are fairly confident (70-90%) but some ambiguity exists
   - LOW: You are uncertain (<70%) or guessing

RESPONSE FORMAT (exactly as shown):
ANSWER: [letters separated by commas, e.g., A,C]
CONFIDENCE: [LOW/MEDIUM/HIGH]`;
  } else {
    const answerFormatHint = questionType === "true-false" ? "[V or F]" : "[single letter, e.g., A]";
    prompt += `
INSTRUCTIONS:
1. Analyze the question thoroughly
2. Evaluate each option carefully
3. Select the ONE correct answer
4. Rate your confidence: LOW, MEDIUM, or HIGH
   - HIGH: You are very certain (>90% sure) based on clear technical facts
   - MEDIUM: You are fairly confident (70-90%) but some ambiguity exists
   - LOW: You are uncertain (<70%) or guessing

RESPONSE FORMAT (exactly as shown):
ANSWER: ${answerFormatHint}
CONFIDENCE: [LOW/MEDIUM/HIGH]`;
  }
  return prompt;
}
function buildDeepSeekMatchingPrompt(context, expertContext, referenceSection = "") {
  const { questionText, categories, matchingOptions, matchingStyle, courseName } = context;
  const academicContext = courseName ? `
ACADEMIC CONTEXT:
Course: ${courseName}
` : "";
  let prompt = `${expertContext}${academicContext}
${referenceSection}
This is a MATCHING question. Match each item to its correct pair.

QUESTION: ${questionText}

`;
  if (matchingStyle === "dropdown") {
    prompt += `AVAILABLE OPTIONS:
`;
    categories.forEach((cat) => {
      prompt += `${cat.letter}: ${cat.text}
`;
    });
    prompt += `
DESCRIPTIONS TO MATCH:
`;
    matchingOptions.forEach((opt) => {
      prompt += `${opt.index}. ${opt.text}
`;
    });
    prompt += `
Match each number to its correct letter option.

RESPONSE FORMAT:
ANSWER: 1-A, 2-B, 3-A, etc.
CONFIDENCE: [LOW/MEDIUM/HIGH]`;
  } else {
    prompt += `CATEGORIES:
`;
    categories.forEach((cat) => {
      prompt += `${cat.letter}: ${cat.text}
`;
    });
    prompt += `
OPTIONS:
`;
    matchingOptions.forEach((opt) => {
      prompt += `${opt.index}. ${opt.text}
`;
    });
    prompt += `
Match each category letter to its correct option number.

RESPONSE FORMAT:
ANSWER: A-1, B-3, C-2, etc.
CONFIDENCE: [LOW/MEDIUM/HIGH]`;
  }
  return prompt;
}
function buildDeepSeekSelectMissingWordsPrompt(context, expertContext) {
  const { questionText, selectGaps, selectChoices, courseName } = context;
  const academicContext = courseName ? `
ACADEMIC CONTEXT:
Course: ${courseName}
` : "";
  let prompt = `${expertContext}${academicContext}

This is a SELECT MISSING WORDS question. Fill each numbered gap [[n]] with the correct word from the available choices.

QUESTION: ${questionText}

AVAILABLE CHOICES PER GROUP:
`;
  for (const [groupId, choices] of Object.entries(selectChoices || {})) {
    prompt += `Group ${groupId}: ${choices.join(", ")}
`;
  }
  if (selectGaps && selectGaps.length > 0) {
    prompt += `
GAP CONTEXT:
`;
    for (const gap of selectGaps) {
      prompt += `[[${gap.index}]] (Group ${gap.groupId}): "...${gap.leftContext} ___ ${gap.rightContext}..."
`;
    }
  }
  const exampleFormat = selectGaps ? selectGaps.map((g) => `[[${g.index}]]=word`).join(", ") : "[[1]]=word, [[2]]=word";
  prompt += `
INSTRUCTIONS:
1. Read the full question with the [[n]] gap markers
2. For each gap, choose the correct word from its group's choices
3. Rate your confidence: LOW, MEDIUM, or HIGH

RESPONSE FORMAT (exactly as shown):
ANSWER: ${exampleFormat}
CONFIDENCE: [LOW/MEDIUM/HIGH]`;
  return prompt;
}
function buildClaudeValidationPrompt(context, deepseekAnalysis) {
  const { questionText, questionType, options, categories, matchingOptions, matchingStyle, courseName } = context;
  const { expertContext } = getExpertContext(context.pageTitle);
  const academicContext = courseName ? `
ACADEMIC CONTEXT:
Course: ${courseName}
` : "";
  let questionSection = `QUESTION: ${questionText}

`;
  if (questionType === "matching" && categories && matchingOptions) {
    if (matchingStyle === "dropdown") {
      questionSection += `AVAILABLE OPTIONS:
`;
      categories.forEach((cat) => {
        questionSection += `${cat.letter}: ${cat.text}
`;
      });
      questionSection += `
DESCRIPTIONS TO MATCH:
`;
      matchingOptions.forEach((opt) => {
        questionSection += `${opt.index}. ${opt.text}
`;
      });
    } else {
      questionSection += `CATEGORIES:
`;
      categories.forEach((cat) => {
        questionSection += `${cat.letter}: ${cat.text}
`;
      });
      questionSection += `
OPTIONS:
`;
      matchingOptions.forEach((opt) => {
        questionSection += `${opt.index}. ${opt.text}
`;
      });
    }
  } else if (questionType === "select-missing-words" && context.selectChoices) {
    questionSection += `AVAILABLE CHOICES:
`;
    for (const [groupId, choices] of Object.entries(context.selectChoices)) {
      questionSection += `Group ${groupId}: ${choices.join(", ")}
`;
    }
  } else if (questionType !== "short-answer" && questionType !== "numerical" && options && options.length > 0) {
    questionSection += `OPTIONS:
`;
    options.forEach((opt) => {
      questionSection += `${opt.letter}) ${opt.text}
`;
    });
  }
  const validationAnswerHint = questionType === "true-false" ? "[correct answer - V or F]" : questionType === "short-answer" || questionType === "numerical" ? "[correct answer text]" : questionType === "select-missing-words" ? "[[1]]=word, [[2]]=word, etc." : "[correct answer - single letter or comma-separated letters]";
  let prompt = `${expertContext}${academicContext}

IMPORTANT: Another AI (DeepSeek) has already analyzed this question but reported ${deepseekAnalysis.confidence} confidence. We need your help to verify or correct the answer.

${questionSection}

=== DEEPSEEK'S ANALYSIS ===
DeepSeek's Answer: ${deepseekAnalysis.answer}
DeepSeek's Confidence: ${deepseekAnalysis.confidence}

DeepSeek's Full Response:
${deepseekAnalysis.analysis}
`;
  if (deepseekAnalysis.reasoning) {
    prompt += `
DeepSeek's Chain-of-Thought Reasoning:
${deepseekAnalysis.reasoning}
`;
  }
  prompt += `
=== END DEEPSEEK ANALYSIS ===

YOUR TASK:
Since DeepSeek had ${deepseekAnalysis.confidence} confidence, please:
1. Review DeepSeek's analysis and reasoning carefully
2. Verify if the answer "${deepseekAnalysis.answer}" is correct
3. If DeepSeek made any errors in reasoning, identify and correct them
4. Provide the CORRECT answer

If you agree with DeepSeek's answer, confirm it. If you disagree, explain why briefly and give the correct answer.

RESPONSE FORMAT (use exactly this format):
ANSWER: ${validationAnswerHint}`;
  return prompt;
}
function buildAnalysisPrompt(context, matchedQuestion = null) {
  const { questionText, questionType, options, categories, matchingOptions, responseMode, images, courseName } = context;
  const pageTitle = context.pageTitle;
  const hasImages = images && images.length > 0;
  const referenceSection = buildReferenceSection(matchedQuestion);
  const academicContext = courseName ? `
ACADEMIC CONTEXT:
Course: ${courseName}
` : "";
  if (responseMode === "quick") {
    if (questionType === "matching" && categories && matchingOptions) {
      return buildMatchingPrompt(context);
    }
    if (questionType === "select-missing-words" && context.selectGaps && context.selectChoices) {
      return buildDeepSeekSelectMissingWordsPrompt(
        context,
        getExpertContext(pageTitle).isNetAcad ? "You are a CCNA/CCNP networking expert." : "You are an expert exam analyst."
      );
    }
    if (questionType === "short-answer" || questionType === "numerical") {
      const expertContext2 = getExpertContext(pageTitle).isNetAcad ? "You are a CCNA/CCNP networking expert with deep knowledge of Cisco technologies." : "You are an expert exam analyst with broad knowledge across all academic and technical subjects.";
      const typeLabel = questionType === "numerical" ? "Numerical" : "Short Answer";
      return `${expertContext2}${academicContext}

This is a ${typeLabel} question. Answer concisely.

Question: ${questionText}

Think step-by-step:
1. What is the question asking?
2. Determine the correct answer

After your analysis, write ANSWER: [your answer] on the last line.`;
    }
    const requiredAnswers = extractRequiredAnswers(questionText);
    const isMultipleAnswer = requiredAnswers > 1;
    const { isNetAcad } = getExpertContext(pageTitle);
    const expertContext = isNetAcad ? "You are a CCNA/CCNP networking expert with deep knowledge of Cisco technologies, protocols, routing, switching, security, and network automation. You have extensive experience with Cisco IOS commands, network troubleshooting, subnetting, VLANs, OSPF, EIGRP, BGP, ACLs, NAT, DHCP, DNS, and all CCNA exam topics. Always consider the most current Cisco best practices and exam objectives" : "You are an expert exam analyst with broad knowledge across all academic and technical subjects including science, math, history, programming, and general knowledge.";
    let imageContext = "";
    let imageAnalysisStep = "";
    if (hasImages) {
      imageContext = `

**MANDATORY IMAGE ANALYSIS - DO THIS FIRST:**
There is an image attached. You MUST analyze it BEFORE answering.
The image likely contains: network topology, IP addresses, routing tables, device configurations, or diagrams.

Look for:
- Device names (Router A, SW1, PC1, etc.)
- IP addresses and subnet masks on each interface
- Interface names (G0/0, S0/0/1, Fa0/1, etc.)
- Connection paths between devices
- Any text, labels, or configuration outputs shown`;
      imageAnalysisStep = `
0. FIRST: Describe what you see in the image (devices, IPs, connections)`;
    }
    let quickPrompt = `${expertContext}${academicContext}${imageContext}
${referenceSection}
Question: ${questionText}

Options:
`;
    if (options && options.length > 0) {
      options.forEach((opt) => {
        quickPrompt += `${opt.letter}) ${opt.text}
`;
      });
    }
    if (isMultipleAnswer) {
      const numWord = requiredAnswers === 2 ? "TWO" : requiredAnswers === 3 ? "THREE" : requiredAnswers === 4 ? "FOUR" : requiredAnswers.toString();
      const exampleFormat = requiredAnswers === 2 ? "A,C" : requiredAnswers === 3 ? "A,C,E" : "A,B,C,D";
      quickPrompt += `
This question requires EXACTLY ${requiredAnswers} answers.

Think step-by-step:${imageAnalysisStep}
1. What is the question asking?
2. Evaluate each option against the image/question
3. Select exactly ${requiredAnswers} correct options

After your analysis, write ANSWER: ${exampleFormat} on the last line.`;
    } else {
      const quickAnswerHint = questionType === "true-false" ? "After your analysis, write ANSWER: V or ANSWER: F on the last line." : "After your analysis, write ANSWER: X on the last line (where X is the letter).";
      quickPrompt += `
Think step-by-step:${imageAnalysisStep}
1. What is the question asking?
2. Evaluate each option against the image/question
3. Determine the correct answer

${quickAnswerHint}`;
    }
    return quickPrompt;
  }
  if (questionType === "matching" && categories && matchingOptions) {
    return buildMatchingPrompt(context);
  }
  if (questionType === "select-missing-words" && context.selectGaps && context.selectChoices) {
    return buildDeepSeekSelectMissingWordsPrompt(
      context,
      "You are an educational AI tutor helping a student understand a question."
    );
  }
  let prompt = `You are an educational AI tutor helping a student understand a question.${academicContext}
${referenceSection}
Context:
- From: "${pageTitle}"
- Question type: ${formatQuestionType(questionType)}

Question:
${questionText}

`;
  if (options && options.length > 0) {
    prompt += `
Answer Options:
`;
    options.forEach((opt) => {
      prompt += `${opt.letter}. ${opt.text}
`;
    });
    prompt += "\n";
  }
  switch (responseMode) {
    case "guided":
      prompt += `Instructions:
Help the student understand this question by:
1. Breaking down what the question is asking
2. Identifying key concepts
3. Walking through the reasoning process
4. Providing a learning tip

Do NOT give the answer directly. Guide them to understand WHY.`;
      break;
    case "direct":
      prompt += `Instructions:
Provide:
1. The correct answer (clearly stated)
2. Brief explanation of why
3. Key takeaway`;
      break;
    case "hints":
      prompt += `Instructions:
Provide hints WITHOUT revealing the answer:
1. A general hint about the topic
2. A more specific hint
3. A reflective question

Do NOT reveal the correct answer.`;
      break;
    case "explanation":
      prompt += `Instructions:
Provide a thorough educational explanation:
1. State the correct answer clearly
2. Explain the underlying concept in depth, as if teaching a class
3. Describe why each incorrect option is wrong (if options are given)
4. Provide a real-world analogy or example
5. Suggest related topics or resources to study further

Be detailed, educational, and help the student truly master this concept.`;
      break;
    default:
      prompt += `Please provide a helpful educational explanation.`;
  }
  prompt += `

Remember: Help students learn with academic integrity.`;
  return prompt;
}
function buildMatchingPrompt(context) {
  const { questionText, categories, matchingOptions, matchingStyle, images, courseName } = context;
  const pageTitle = context.pageTitle;
  const { isNetAcad } = getExpertContext(pageTitle);
  const expertContext = isNetAcad ? "You are a CCNA/CCNP networking expert with deep knowledge of Cisco technologies, protocols, ports, routing, switching, security, and network automation." : "You are an expert exam analyst with broad knowledge across all academic and technical subjects.";
  const academicContext = courseName ? `
ACADEMIC CONTEXT:
Course: ${courseName}
` : "";
  let imageContext = "";
  if (images && images.length > 0) {
    imageContext = `

CRITICAL - IMAGE ANALYSIS REQUIRED:
Look at the image above FIRST. It may contain essential information for matching.`;
  }
  if (matchingStyle === "dropdown") {
    let prompt2 = `${expertContext}${academicContext}${imageContext}

This is a MATCHING question with DROPDOWN selection. Each description must be matched to one of the available options.
NOTE: The same option can be used for multiple descriptions.

Question: ${questionText}

Available options:
`;
    categories.forEach((cat) => {
      prompt2 += `${cat.letter}: ${cat.text}
`;
    });
    prompt2 += `
Descriptions to match:
`;
    matchingOptions.forEach((opt) => {
      prompt2 += `${opt.index}. ${opt.text}
`;
    });
    prompt2 += `
Match each description NUMBER to the correct option LETTER.

RESPOND WITH ONLY: ${matchingOptions.map((opt) => `${opt.index}-[letter]`).join(", ")}
Example: 1-A, 2-B, 3-A, 4-A, 5-B

IMPORTANT:
- Use ONLY the option LETTER (A, B, C...) after the dash
- Each number gets exactly one letter
- The same letter CAN be used for multiple numbers
- Output ONLY the matches, no explanations`;
    return prompt2;
  }
  if (matchingStyle === "object-dropdown") {
    let prompt2 = `${expertContext}${academicContext}${imageContext}

This is a MATCHING question. Match each term (A, B, C...) to its correct definition.

Question: ${questionText}

Terms to match:
`;
    categories.forEach((cat) => {
      prompt2 += `${cat.letter}: ${cat.text}
`;
    });
    prompt2 += `
Definitions available:
`;
    matchingOptions.forEach((opt) => {
      prompt2 += `${opt.index}. ${opt.text}
`;
    });
    prompt2 += `
Match each term LETTER to its correct definition NUMBER.

CRITICAL OUTPUT FORMAT:
You MUST respond with: ${categories.map((cat) => `${cat.letter}-[number]`).join(", ")}
Example: A-1, B-3, C-2, D-4, E-5

IMPORTANT:
- Use ONLY the definition NUMBERS (1, 2, 3...) after the dash
- Each letter gets exactly one number
- Output ONLY the matches: ${categories.map((cat) => `${cat.letter}-[number]`).join(", ")}
- No explanations or additional text.`;
    return prompt2;
  }
  let prompt = `${expertContext}${academicContext}${imageContext}

This is a MATCHING question. You must match each category to the correct option.

Question: ${questionText}

Categories to match:
`;
  categories.forEach((cat) => {
    prompt += `${cat.letter}: ${cat.text}
`;
  });
  prompt += `
Options available:
`;
  matchingOptions.forEach((opt) => {
    prompt += `${opt.index}. ${opt.text}
`;
  });
  prompt += `
Match each category letter to its correct option NUMBER (1, 2, 3, etc.).

CRITICAL OUTPUT FORMAT:
You MUST respond with: ${categories.map((cat) => `${cat.letter}-[number]`).join(", ")}
Example: A-1, B-3, C-2, D-4, E-5

IMPORTANT:
- Use ONLY the option NUMBERS (1, 2, 3...) after the dash
- Do NOT include the option text in your response
- Each category letter MUST be matched to exactly one number
- Output format: LETTER-NUMBER, LETTER-NUMBER, LETTER-NUMBER

For example, if you need to match A: SMTP, B: POP3, C: IMAP4 to options 1: port 25, 2: port 110, 3: port 143:
Correct output: A-1, B-2, C-3

YOUR OUTPUT MUST BE EXACTLY IN THIS FORMAT:
${categories.map((cat) => `${cat.letter}-[number]`).join(", ")}

IMPORTANT:
- Use option NUMBERS only (1, 2, 3...)
- Each category letter gets exactly one number
- Output ONLY: ${categories.map((cat) => `${cat.letter}-[number]`).join(", ")}
- No explanations or additional text.`;
  return prompt;
}
function buildMessageContent(prompt, images) {
  if (!images || images.length === 0) {
    return prompt;
  }
  const content = [];
  for (let i = 0; i < images.length; i++) {
    const img = images[i];
    if (!img)
      continue;
    if (img.url) {
      content.push({
        type: "image",
        source: {
          type: "url",
          url: img.url
        }
      });
    } else if (img.base64 && img.mediaType) {
      if (img.base64.length < 100)
        continue;
      content.push({
        type: "image",
        source: {
          type: "base64",
          media_type: img.mediaType,
          data: img.base64
        }
      });
    }
  }
  content.push({ type: "text", text: prompt });
  return content;
}

// src/background/modules/parsing.ts
function parseDeepSeekResponse(response, context, reasoningContent = null) {
  const isMatching = context.questionType === "matching";
  const isTrueFalse = context.questionType === "true-false";
  const isShortAnswer = context.questionType === "short-answer";
  const isNumerical = context.questionType === "numerical";
  const isSelectMissingWords = context.questionType === "select-missing-words";
  const confidenceMatch = response.match(/CONFIDENCE:\s*(HIGH|MEDIUM|LOW)/i);
  const confidence = confidenceMatch ? confidenceMatch[1].toUpperCase() : "LOW";
  let answer = null;
  if (isMatching) {
    const answerMatch = response.match(/ANSWER:\s*([A-Z]-\d[\s,]*)+/i);
    if (answerMatch) {
      const pairsMatch = answerMatch[0].match(/[A-Z]-\d/gi);
      if (pairsMatch) {
        answer = pairsMatch.join(", ").toUpperCase();
      }
    }
    if (!answer) {
      const allPairs = response.match(/([A-Z]-\d[\s,\n]*){2,}/gi);
      if (allPairs && allPairs.length > 0) {
        const lastBlock = allPairs[allPairs.length - 1];
        const pairs = lastBlock.match(/[A-Z]-\d/gi);
        if (pairs && pairs.length >= 2) {
          answer = pairs.join(", ").toUpperCase();
        }
      }
    }
  } else if (isTrueFalse) {
    const tfMatch = response.match(/ANSWER:\s*(V|F|TRUE|FALSE|VERDADERO|FALSO)\b/i);
    if (tfMatch) {
      const value = tfMatch[1].toUpperCase();
      answer = value.startsWith("V") || value === "TRUE" ? "V" : "F";
    }
    if (!answer) {
      const fallbackTf = response.match(/\b(TRUE|FALSE|VERDADERO|FALSO|V|F)\b/i);
      if (fallbackTf) {
        const value = fallbackTf[1].toUpperCase();
        answer = value.startsWith("V") || value === "TRUE" ? "V" : "F";
      }
    }
  } else if (isSelectMissingWords) {
    const gapMatch = response.match(/ANSWER:\s*(\[\[\d+\]\]=[^\n,]+(?:,\s*\[\[\d+\]\]=[^\n,]+)*)/i);
    if (gapMatch) {
      answer = gapMatch[1].trim();
    }
  } else if (isNumerical) {
    const numMatch = response.match(/ANSWER:\s*([\d.,]+(?:\s*\w+)?)/i);
    if (numMatch) {
      answer = numMatch[1].trim().replace(/^([\d.,]+).*$/, "$1").trim();
    }
  } else if (isShortAnswer) {
    const freeMatch = response.match(/ANSWER:\s*([^\n]+)/i);
    if (freeMatch) {
      answer = freeMatch[1].trim();
    }
  } else {
    const answerMatch = response.match(/ANSWER:\s*([A-J](?:\s*,\s*[A-J])*)/i);
    if (answerMatch) {
      answer = answerMatch[1].toUpperCase().replace(/\s/g, "");
    }
  }
  if (!answer) {
    return { success: false, error: "Could not parse DeepSeek answer" };
  }
  return {
    success: true,
    result: answer,
    confidence,
    deepseekAnalysis: response,
    deepseekReasoning: reasoningContent,
    source: "deepseek"
  };
}
function extractClaudeQuickAnswer(result, questionType) {
  if (questionType === "select-missing-words") {
    const gapMatch = result.match(/ANSWER:\s*(\[\[\d+\]\]=[^\n,]+(?:,\s*\[\[\d+\]\]=[^\n,]+)*)/i);
    if (gapMatch)
      return gapMatch[1].trim();
    return result.trim();
  }
  if (questionType === "numerical") {
    const numMatch = result.match(/ANSWER:\s*([\d.,]+(?:\s*\w+)?)/i);
    if (numMatch)
      return numMatch[1].trim().replace(/^([\d.,]+).*$/, "$1").trim();
    return result.trim();
  }
  if (questionType === "short-answer") {
    const freeMatch = result.match(/ANSWER:\s*([^\n]+)/i);
    if (freeMatch)
      return freeMatch[1].trim();
    return result.trim();
  }
  const tfAnswerMatch = result.match(/ANSWER:\s*(V|F|TRUE|FALSE|VERDADERO|FALSO)\b/i);
  if (tfAnswerMatch) {
    const value = tfAnswerMatch[1].toUpperCase();
    return value.startsWith("V") || value === "TRUE" ? "V" : "F";
  }
  const answerMatch = result.match(/ANSWER:\s*([A-J](?:\s*,\s*[A-J])*)/i);
  if (answerMatch) {
    return answerMatch[1].toUpperCase().replace(/\s/g, "");
  }
  const lines = result.trim().split("\n");
  const lastLine = lines[lines.length - 1].trim();
  const tfLastLine = lastLine.match(/^(V|F|TRUE|FALSE|VERDADERO|FALSO)$/i);
  if (tfLastLine) {
    const value = tfLastLine[1].toUpperCase();
    return value.startsWith("V") || value === "TRUE" ? "V" : "F";
  }
  const letterMatch = lastLine.match(/^([A-J](?:\s*,\s*[A-J])*)$/i);
  if (letterMatch) {
    return letterMatch[1].toUpperCase().replace(/\s/g, "");
  }
  return result;
}
function handleApiError(status, errorData) {
  const errorMessage = errorData?.error?.message || "Unknown error";
  switch (status) {
    case 400:
      return { success: false, error: `Bad Request: ${errorMessage}` };
    case 401:
      return { success: false, error: `Invalid API key: ${errorMessage}` };
    case 403:
      return { success: false, error: `Access denied: ${errorMessage}` };
    case 404:
      return { success: false, error: "API endpoint not found." };
    case 413:
      return { success: false, error: "Request too large. Max request size is 32 MB." };
    case 429:
      return { success: false, error: "Rate limit exceeded. Please wait and try again." };
    case 500:
      return { success: false, error: `Claude internal server error. ${errorMessage}` };
    case 502:
      return { success: false, error: "Claude service temporarily unavailable (502)." };
    case 503:
      return { success: false, error: "Claude service temporarily unavailable (503)." };
    case 529:
      return { success: false, error: "Claude API is overloaded. Please try again later." };
    default:
      return { success: false, error: `API error (${status}): ${errorMessage}` };
  }
}

// src/background/modules/crypto.ts
var SALT = new TextEncoder().encode("study-assist-v1-salt");
var ITERATIONS = 1e5;
async function getEncryptionKey() {
  const extensionId = chrome.runtime.id;
  const keyMaterial = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(extensionId),
    "PBKDF2",
    false,
    ["deriveKey"]
  );
  return crypto.subtle.deriveKey(
    { name: "PBKDF2", salt: SALT, iterations: ITERATIONS, hash: "SHA-256" },
    keyMaterial,
    { name: "AES-GCM", length: 256 },
    false,
    ["encrypt", "decrypt"]
  );
}
async function encryptApiKey(plainKey) {
  const key = await getEncryptionKey();
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const encoded = new TextEncoder().encode(plainKey);
  const encrypted = await crypto.subtle.encrypt({ name: "AES-GCM", iv }, key, encoded);
  const combined = new Uint8Array(iv.length + encrypted.byteLength);
  combined.set(iv);
  combined.set(new Uint8Array(encrypted), iv.length);
  return btoa(String.fromCharCode(...combined));
}
async function decryptApiKey(encryptedKey) {
  try {
    const key = await getEncryptionKey();
    const combined = Uint8Array.from(atob(encryptedKey), (c) => c.charCodeAt(0));
    const iv = combined.slice(0, 12);
    const ciphertext = combined.slice(12);
    const decrypted = await crypto.subtle.decrypt({ name: "AES-GCM", iv }, key, ciphertext);
    return new TextDecoder().decode(decrypted);
  } catch {
    return encryptedKey;
  }
}
function isPlainTextKey(value) {
  return value.startsWith("sk-ant-") || value.startsWith("sk-") && !value.startsWith("sk-ant-");
}
async function getDecryptedApiKey(storageKey) {
  const result = await chrome.storage.local.get([storageKey]);
  const value = result[storageKey];
  if (!value)
    return null;
  if (isPlainTextKey(value)) {
    const encrypted = await encryptApiKey(value);
    await chrome.storage.local.set({ [storageKey]: encrypted });
    return value;
  }
  return decryptApiKey(value);
}
async function encryptAndSaveKey(storageKey, plainKey) {
  const encrypted = await encryptApiKey(plainKey);
  await chrome.storage.local.set({ [storageKey]: encrypted });
}

// src/background/modules/usageTracker.ts
var PRICING = {
  // Claude Haiku
  "claude-3-haiku-20240307": { input: 0.25, output: 1.25 },
  "claude-haiku-4-5-20251001": { input: 1, output: 5 },
  // Claude Sonnet
  "claude-sonnet-4-20250514": { input: 3, output: 15 },
  "claude-sonnet-4-6": { input: 3, output: 15 },
  // Claude Opus
  "claude-opus-4-6": { input: 15, output: 75 },
  // DeepSeek (thinking)
  "deepseek-reasoner": { input: 0.28, output: 0.42 }
};
var MAX_RECORDS = 500;
var STORAGE_KEY = "usageRecords";
function calculateCost(model, inputTokens, outputTokens) {
  const pricing = PRICING[model] || { input: 1, output: 5 };
  return inputTokens * pricing.input / 1e6 + outputTokens * pricing.output / 1e6;
}
async function trackUsage(record) {
  const cost = calculateCost(record.model, record.inputTokens, record.outputTokens);
  const fullRecord = {
    ...record,
    id: `${Date.now()}-${Math.random().toString(36).substr(2, 9)}`,
    costUsd: cost
  };
  try {
    const result = await chrome.storage.local.get([STORAGE_KEY]);
    const records = result[STORAGE_KEY] || [];
    records.push(fullRecord);
    if (records.length > MAX_RECORDS) {
      records.splice(0, records.length - MAX_RECORDS);
    }
    await chrome.storage.local.set({ [STORAGE_KEY]: records });
    await chrome.storage.local.set({ lastAiResponse: fullRecord });
    updateStorageBadge().catch(() => {
    });
    log(
      "[Study Assist] Usage tracked:",
      fullRecord.source,
      fullRecord.model,
      `$${cost.toFixed(6)}`,
      `${fullRecord.inputTokens}+${fullRecord.outputTokens} tokens`
    );
  } catch (error) {
    console.error("[Study Assist] Error tracking usage:", error);
  }
  return fullRecord;
}
async function getUsageRecords() {
  const result = await chrome.storage.local.get([STORAGE_KEY]);
  return result[STORAGE_KEY] || [];
}
async function getUsageStats() {
  const records = await getUsageRecords();
  const today = (/* @__PURE__ */ new Date()).toISOString().split("T")[0];
  const emptyAi = () => ({
    totalRequests: 0,
    totalInputTokens: 0,
    totalOutputTokens: 0,
    totalCostUsd: 0,
    todayRequests: 0,
    todayInputTokens: 0,
    todayOutputTokens: 0,
    todayCostUsd: 0
  });
  const stats = {
    totalRequests: records.length,
    totalInputTokens: 0,
    totalOutputTokens: 0,
    totalCostUsd: 0,
    questionsAnswered: 0,
    successRate: 0,
    avgLatencyMs: 0,
    bySource: {},
    byModel: {},
    byDay: {},
    byPlatform: {},
    todayRequests: 0,
    todayCost: 0,
    todayTokens: 0,
    deepseek: emptyAi(),
    claude: emptyAi()
  };
  let totalLatency = 0;
  let successCount = 0;
  for (const r of records) {
    stats.totalInputTokens += r.inputTokens;
    stats.totalOutputTokens += r.outputTokens;
    stats.totalCostUsd += r.costUsd;
    if (r.success) {
      successCount++;
      stats.questionsAnswered++;
    }
    totalLatency += r.latencyMs;
    stats.bySource[r.source] = (stats.bySource[r.source] || 0) + 1;
    stats.byModel[r.model] = (stats.byModel[r.model] || 0) + 1;
    const plat = r.platform || "other";
    stats.byPlatform[plat] = (stats.byPlatform[plat] || 0) + 1;
    const day = new Date(r.timestamp).toISOString().split("T")[0];
    if (!stats.byDay[day])
      stats.byDay[day] = { requests: 0, cost: 0, tokens: 0 };
    stats.byDay[day].requests++;
    stats.byDay[day].cost += r.costUsd;
    stats.byDay[day].tokens += r.inputTokens + r.outputTokens;
    const isToday = day === today;
    if (isToday) {
      stats.todayRequests++;
      stats.todayCost += r.costUsd;
      stats.todayTokens += r.inputTokens + r.outputTokens;
    }
    const ai = r.source === "deepseek" ? stats.deepseek : r.source === "claude" ? stats.claude : null;
    if (ai) {
      ai.totalRequests++;
      ai.totalInputTokens += r.inputTokens;
      ai.totalOutputTokens += r.outputTokens;
      ai.totalCostUsd += r.costUsd;
      if (isToday) {
        ai.todayRequests++;
        ai.todayInputTokens += r.inputTokens;
        ai.todayOutputTokens += r.outputTokens;
        ai.todayCostUsd += r.costUsd;
      }
    }
  }
  stats.successRate = records.length > 0 ? successCount / records.length * 100 : 0;
  stats.avgLatencyMs = records.length > 0 ? totalLatency / records.length : 0;
  return stats;
}
async function getRecentHistory(limit = 20) {
  const records = await getUsageRecords();
  return records.slice(-limit).reverse();
}
async function clearUsageData() {
  await chrome.storage.local.set({ [STORAGE_KEY]: [] });
  await chrome.storage.local.remove(["lastAiResponse"]);
  await updateStorageBadge();
}
var STORAGE_LIMIT_BYTES = 5 * 1024 * 1024;
var STORAGE_WARN_THRESHOLD = 0.7;
var STORAGE_CRIT_THRESHOLD = 0.9;
async function getStorageInfo() {
  const bytesUsed = await chrome.storage.local.getBytesInUse(null);
  const percent = bytesUsed / STORAGE_LIMIT_BYTES;
  const level = percent >= STORAGE_CRIT_THRESHOLD ? "critical" : percent >= STORAGE_WARN_THRESHOLD ? "warning" : "ok";
  return { bytesUsed, bytesTotal: STORAGE_LIMIT_BYTES, percent, level };
}
async function updateStorageBadge() {
  try {
    const info = await getStorageInfo();
    if (info.level === "critical") {
      await chrome.action.setBadgeText({ text: "!" });
      await chrome.action.setBadgeBackgroundColor({ color: "#e53935" });
    } else if (info.level === "warning") {
      await chrome.action.setBadgeText({ text: "!" });
      await chrome.action.setBadgeBackgroundColor({ color: "#FF9800" });
    } else {
      await chrome.action.setBadgeText({ text: "" });
    }
  } catch (_) {
  }
}
async function trimHistory(options) {
  const result = await chrome.storage.local.get([STORAGE_KEY]);
  const records = result[STORAGE_KEY] || [];
  const originalLength = records.length;
  let filtered = [...records];
  if (options.keepDays !== void 0) {
    const cutoff = Date.now() - options.keepDays * 24 * 60 * 60 * 1e3;
    filtered = filtered.filter((r) => r.timestamp >= cutoff);
  }
  if (options.keepLast !== void 0 && filtered.length > options.keepLast) {
    filtered = filtered.slice(filtered.length - options.keepLast);
  }
  await chrome.storage.local.set({ [STORAGE_KEY]: filtered });
  await updateStorageBadge();
  return originalLength - filtered.length;
}

// src/background/modules/rateLimiter.ts
var state = {
  questionRequests: {},
  globalRequests: [],
  cooldownUntil: 0
};
var SAME_QUESTION_MAX = 3;
var SAME_QUESTION_WINDOW_MS = 12e4;
var GLOBAL_MAX = 15;
var GLOBAL_WINDOW_MS = 6e4;
var COOLDOWN_DURATION_MS = 3e4;
function hashQuestion(text) {
  const normalised = text.toLowerCase().trim().replace(/\s+/g, " ").substring(0, 200);
  let hash = 0;
  for (let i = 0; i < normalised.length; i++) {
    hash = (hash << 5) - hash + normalised.charCodeAt(i);
    hash = hash & hash;
  }
  return hash.toString(36);
}
function pruneOld(timestamps, windowMs) {
  const cutoff = Date.now() - windowMs;
  return timestamps.filter((t) => t > cutoff);
}
function checkRateLimit(questionText) {
  const now = Date.now();
  if (state.cooldownUntil > now) {
    const sec = Math.ceil((state.cooldownUntil - now) / 1e3);
    log(`[Study Assist] Rate limit: cooldown, ${sec}s left`);
    return `\u23F3 Rate limited. Please wait ${sec} seconds.`;
  }
  const qHash = hashQuestion(questionText);
  state.globalRequests = pruneOld(state.globalRequests, GLOBAL_WINDOW_MS);
  if (state.questionRequests[qHash]) {
    state.questionRequests[qHash] = pruneOld(state.questionRequests[qHash], SAME_QUESTION_WINDOW_MS);
  }
  const qCount = state.questionRequests[qHash]?.length ?? 0;
  if (qCount >= SAME_QUESTION_MAX) {
    state.cooldownUntil = now + COOLDOWN_DURATION_MS;
    log(`[Study Assist] Rate limit: same question \xD7${qCount}`);
    return `\u23F3 You've asked this question ${qCount} times. Wait 30 s.`;
  }
  if (state.globalRequests.length >= GLOBAL_MAX) {
    state.cooldownUntil = now + COOLDOWN_DURATION_MS;
    log(`[Study Assist] Rate limit: ${state.globalRequests.length} reqs / min`);
    return `\u23F3 Too many requests. Wait 30 s.`;
  }
  return null;
}
function recordRequest(questionText) {
  const now = Date.now();
  const qHash = hashQuestion(questionText);
  if (!state.questionRequests[qHash]) {
    state.questionRequests[qHash] = [];
  }
  state.questionRequests[qHash].push(now);
  state.globalRequests.push(now);
}

// src/background/modules/streaming.ts
async function streamClaudeResponse(apiKey, model, messages, maxTokens, callbacks, signal) {
  const response = await fetch(CLAUDE_API_BASE, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-api-key": apiKey,
      "anthropic-version": ANTHROPIC_VERSION,
      "anthropic-dangerous-direct-browser-access": "true"
    },
    body: JSON.stringify({
      model,
      max_tokens: maxTokens,
      messages,
      stream: true
    }),
    signal
  });
  if (!response.ok) {
    const errorBody = await response.text();
    let errorMsg = `API Error (${response.status})`;
    try {
      const parsed = JSON.parse(errorBody);
      errorMsg = parsed.error?.message || errorMsg;
    } catch {
    }
    throw new Error(errorMsg);
  }
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let fullText = "";
  let inputTokens = 0;
  let outputTokens = 0;
  let buffer = "";
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done)
        break;
      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split("\n");
      buffer = lines.pop() || "";
      for (const line of lines) {
        if (!line.startsWith("data: "))
          continue;
        const data = line.slice(6).trim();
        if (!data || data === "[DONE]")
          continue;
        try {
          const event = JSON.parse(data);
          switch (event.type) {
            case "message_start": {
              const msg = event.message;
              const usage = msg?.usage;
              if (usage?.input_tokens) {
                inputTokens = usage.input_tokens;
                callbacks.onInputTokens(inputTokens);
              }
              break;
            }
            case "content_block_delta": {
              const delta = event.delta;
              if (delta?.type === "text_delta" && typeof delta.text === "string") {
                fullText += delta.text;
                callbacks.onChunk(delta.text);
              }
              break;
            }
            case "message_delta": {
              const usage = event.usage;
              if (usage?.output_tokens) {
                outputTokens = usage.output_tokens;
              }
              break;
            }
            case "message_stop":
              callbacks.onComplete(outputTokens);
              break;
            case "error": {
              const err = event.error;
              callbacks.onError(err?.message || "Stream error");
              break;
            }
          }
        } catch {
        }
      }
    }
  } catch (error) {
    if (error.name === "AbortError")
      throw error;
    callbacks.onError(error.message);
    throw error;
  }
  return { fullText, inputTokens, outputTokens };
}

// src/background/modules/api.ts
var QA_CLAUDE_MODEL = "claude-3-haiku-20240307";
function detectPlatform(pageUrl) {
  if (!pageUrl)
    return "other";
  const url = pageUrl.toLowerCase();
  if (url.includes("netacad"))
    return "netacad";
  if (url.includes("skillsforall"))
    return "skillsforall";
  if (url.includes("educa-t") || url.includes("unach.mx"))
    return "educa-t";
  if (url.includes("tecnm.mx") || url.includes("ead.tuxtla.tecnm"))
    return "tecnm";
  if (url.includes("educat"))
    return "educat";
  if (url.includes("moodle"))
    return "moodle";
  if (url.includes("contenidosdigitales"))
    return "contenidosdigitales";
  if (url.includes("example.com"))
    return "qa-manual";
  return "other";
}
async function testApiKey(apiKey) {
  const url = CLAUDE_API_BASE;
  try {
    const requestBody = {
      model: DEFAULT_MODEL,
      max_tokens: 10,
      messages: [{ role: "user", content: "Hello, respond with just OK to confirm." }]
    };
    const response = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": apiKey,
        "anthropic-version": ANTHROPIC_VERSION,
        "anthropic-dangerous-direct-browser-access": "true"
      },
      body: JSON.stringify(requestBody)
    });
    let responseBody = null;
    try {
      responseBody = await response.clone().json();
    } catch (e) {
      responseBody = { parseError: e.message };
    }
    await logError({
      type: "testApiKey",
      url,
      status: response.status,
      statusText: response.statusText,
      responseBody
    });
    if (response.ok)
      return { success: true };
    const errorMessage = responseBody?.error?.message || "Invalid API key";
    if (response.status === 400)
      return { success: false, error: `Bad Request (400): ${errorMessage}` };
    if (response.status === 401)
      return { success: false, error: `Unauthorized (401): ${errorMessage}` };
    if (response.status === 403)
      return { success: false, error: `Forbidden (403): ${errorMessage}` };
    if (response.status === 429) {
      return { success: true, warning: "API key is valid but rate limited. It will work when the limit resets." };
    }
    return { success: false, error: `API Error (${response.status}): ${errorMessage}` };
  } catch (error) {
    console.error("[Study Assist] API test error:", error);
    await logError({ type: "testApiKey_exception", url, error: error.message, stack: error.stack });
    if (error.message.includes("Failed to fetch")) {
      return { success: false, error: "Network error. Check your internet connection." };
    }
    return { success: false, error: `Exception: ${error.message}` };
  }
}
async function testDeepSeekApiKey(apiKey) {
  try {
    const response = await fetch(DEEPSEEK_API_BASE, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${apiKey}` },
      body: JSON.stringify({
        model: DEEPSEEK_REASONER_MODEL,
        max_tokens: 10,
        messages: [{ role: "user", content: "Hello, respond with just OK." }]
      })
    });
    let responseBody = null;
    try {
      responseBody = await response.clone().json();
    } catch (e) {
      responseBody = { parseError: e.message };
    }
    await logError({ type: "testDeepSeekApiKey", status: response.status, responseBody });
    if (response.ok)
      return { success: true };
    const errorMessage = responseBody?.error?.message || "Invalid API key";
    return { success: false, error: `DeepSeek Error (${response.status}): ${errorMessage}` };
  } catch (error) {
    console.error("[Study Assist] DeepSeek API test error:", error);
    return { success: false, error: `Exception: ${error.message}` };
  }
}
function matchSingleAnswerToLetter(correctAnswer, pageOptions) {
  const normalizedCorrect = normalizeForSearch(correctAnswer);
  for (const opt of pageOptions) {
    const normalizedOpt = normalizeForSearch(opt.text);
    if (normalizedOpt === normalizedCorrect) {
      return opt.letter;
    }
  }
  for (const opt of pageOptions) {
    const normalizedOpt = normalizeForSearch(opt.text);
    if (normalizedOpt.includes(normalizedCorrect) || normalizedCorrect.includes(normalizedOpt)) {
      return opt.letter;
    }
  }
  let bestMatch = null;
  for (const opt of pageOptions) {
    const normalizedOpt = normalizeForSearch(opt.text);
    const similarity = calculateSimilarity(normalizedCorrect, normalizedOpt);
    if (!bestMatch || similarity > bestMatch.similarity) {
      bestMatch = { letter: opt.letter, similarity };
    }
    const hasCommandText = normalizedCorrect.includes("interface") || normalizedCorrect.includes("router") || normalizedCorrect.includes("switch") || normalizedCorrect.includes("config");
    const threshold = hasCommandText ? 0.7 : 0.8;
    if (similarity >= threshold) {
      return opt.letter;
    }
  }
  if (bestMatch && bestMatch.similarity >= 0.6) {
    log(`[Study Assist] Using best match with ${(bestMatch.similarity * 100).toFixed(1)}% similarity`);
    return bestMatch.letter;
  }
  return null;
}
function matchCorrectAnswerToLetter(bankMatch, pageOptions) {
  if (!pageOptions || pageOptions.length === 0)
    return null;
  const answers = bankMatch.correctAnswers ? bankMatch.correctAnswers : bankMatch.correctAnswer ? [bankMatch.correctAnswer] : [];
  if (answers.length === 0)
    return null;
  const matchedLetters = [];
  for (const answer of answers) {
    const letter = matchSingleAnswerToLetter(answer, pageOptions);
    if (letter) {
      matchedLetters.push(letter);
    } else {
      log(`[Study Assist] Could not match correctAnswer "${answer}" to any page option`);
    }
  }
  if (matchedLetters.length === 0)
    return null;
  const unique = [...new Set(matchedLetters)].sort();
  return unique.join(", ");
}
async function analyzeQuestion(context) {
  const startTime = Date.now();
  try {
    const bankMatch = await findMatchingQuestion(
      context.questionText,
      context.moduleInfo || context.pageTitle,
      context.pageUrl
    );
    if (bankMatch && (bankMatch.correctAnswer || bankMatch.correctAnswers) && bankMatch.similarity >= 80) {
      const answerLetter = matchCorrectAnswerToLetter(bankMatch, context.options);
      if (answerLetter) {
        const displayAnswer = bankMatch.correctAnswers ? bankMatch.correctAnswers.join(" | ") : bankMatch.correctAnswer || "";
        log(`[Study Assist] INSTANT ANSWER from question bank (${bankMatch.similarity}% match): ${answerLetter}`);
        await trackUsage({
          timestamp: Date.now(),
          questionText: context.questionText.substring(0, 200),
          questionType: context.questionType,
          answer: answerLetter,
          source: "question-bank",
          model: "questions-bank.json",
          inputTokens: 0,
          outputTokens: 0,
          responseMode: context.responseMode,
          success: true,
          latencyMs: Date.now() - startTime,
          platform: detectPlatform(context.pageUrl),
          confidence: "HIGH"
        });
        return { success: true, result: answerLetter, source: "question-bank" };
      }
    }
    const rateLimitError = checkRateLimit(context.questionText);
    if (rateLimitError) {
      return { success: false, error: rateLimitError };
    }
    recordRequest(context.questionText);
    const storageResult = await chrome.storage.local.get([
      "claudeApiKey",
      "claudeModel",
      "useDeepSeek",
      "deepseekApiKey",
      "deepseekOnly"
    ]);
    const claudeApiKey = await getDecryptedApiKey("claudeApiKey");
    const deepseekApiKey = await getDecryptedApiKey("deepseekApiKey");
    const { claudeModel, useDeepSeek, deepseekOnly } = storageResult;
    const selectedClaudeModel = context.qaMode ? QA_CLAUDE_MODEL : claudeModel || DEFAULT_MODEL;
    const isDeepSeekOnlyMode = useDeepSeek && deepseekOnly && deepseekApiKey;
    if (!claudeApiKey && !isDeepSeekOnlyMode) {
      return { success: false, error: "Claude API key not configured." };
    }
    const hasImages = context.images && context.images.length > 0;
    const isMatching = context.questionType === "matching";
    const skipDeepSeek = context.skipDeepSeek === true;
    if (skipDeepSeek) {
      log("[Study Assist] CTRL+SHIFT: Using Claude directly");
      if (isDeepSeekOnlyMode) {
        return { success: false, error: "\u26A0\uFE0F DeepSeek Only mode: CTRL+SHIFT (use Claude) is not available. Disable 'DeepSeek Only' or press CTRL without SHIFT." };
      }
    }
    let deepseekAnalysisForClaude = null;
    let claudeFallbackReason;
    if (isDeepSeekOnlyMode && hasImages) {
      return { success: false, error: "\u26A0\uFE0F DeepSeek Only mode: Images are not supported. Disable 'DeepSeek Only' to use Claude for image questions." };
    }
    if (isDeepSeekOnlyMode && isMatching) {
      return { success: false, error: "\u26A0\uFE0F DeepSeek Only mode: Matching questions are not supported. Disable 'DeepSeek Only' to use Claude for matching questions." };
    }
    if (useDeepSeek && deepseekApiKey && !hasImages && !isMatching && !skipDeepSeek) {
      log("[Study Assist] Using DeepSeek Reasoner...");
      let deepseekResult = await analyzeWithDeepSeek(context, deepseekApiKey);
      if (deepseekResult.cancelled) {
        log("[Study Assist] DeepSeek cancelled \u2192 Claude");
        if (isDeepSeekOnlyMode)
          return { success: false, error: "Analysis cancelled." };
      } else if (!deepseekResult.success) {
        if (deepseekResult.skipRetry) {
          log(`[Study Assist] DeepSeek failed (non-retryable) \u2192 Claude fallback: ${deepseekResult.error}`);
        } else {
          log("[Study Assist] DeepSeek failed, retrying...");
          await new Promise((r) => setTimeout(r, 1e3));
          deepseekResult = await analyzeWithDeepSeek(context, deepseekApiKey);
        }
        if (!deepseekResult.success && !deepseekResult.cancelled) {
          log("[Study Assist] DeepSeek failed \u2192 Claude fallback");
          claudeFallbackReason = "deepseek_error";
          if (isDeepSeekOnlyMode) {
            return { success: false, error: `\u26A0\uFE0F DeepSeek Only mode: ${deepseekResult.error || "API failed after retry. No Claude fallback available."}` };
          }
        }
      }
      if (deepseekResult.success && deepseekResult.confidence === "HIGH") {
        log("[Study Assist] DeepSeek HIGH \u2192 Answer:", deepseekResult.result);
        await trackUsage({
          timestamp: Date.now(),
          questionText: context.questionText.substring(0, 200),
          questionType: context.questionType,
          answer: deepseekResult.result,
          source: "deepseek",
          model: DEEPSEEK_REASONER_MODEL,
          inputTokens: deepseekResult.inputTokens || 0,
          outputTokens: deepseekResult.outputTokens || 0,
          responseMode: context.responseMode,
          success: true,
          latencyMs: Date.now() - startTime,
          platform: detectPlatform(context.pageUrl),
          confidence: "HIGH",
          deepseekReasoning: deepseekResult.deepseekReasoning ?? void 0
        });
        return deepseekResult;
      } else if (deepseekResult.success) {
        if (isDeepSeekOnlyMode) {
          log(`[Study Assist] DeepSeek ${deepseekResult.confidence} \u2192 Returning (DeepSeek Only mode)`);
          deepseekResult.explanation = `\u26A0\uFE0F **Low confidence (${deepseekResult.confidence})** - No Claude validation in DeepSeek Only mode.

${deepseekResult.explanation || ""}`;
          await trackUsage({
            timestamp: Date.now(),
            questionText: context.questionText.substring(0, 200),
            questionType: context.questionType,
            answer: deepseekResult.result,
            source: "deepseek",
            model: DEEPSEEK_REASONER_MODEL,
            inputTokens: deepseekResult.inputTokens || 0,
            outputTokens: deepseekResult.outputTokens || 0,
            responseMode: context.responseMode,
            success: true,
            latencyMs: Date.now() - startTime,
            platform: detectPlatform(context.pageUrl),
            confidence: deepseekResult.confidence,
            deepseekReasoning: deepseekResult.deepseekReasoning ?? void 0
          });
          return deepseekResult;
        }
        log(`[Study Assist] DeepSeek ${deepseekResult.confidence} \u2192 Claude validation`);
        deepseekAnalysisForClaude = {
          answer: deepseekResult.result,
          confidence: deepseekResult.confidence,
          analysis: deepseekResult.deepseekAnalysis,
          reasoning: deepseekResult.deepseekReasoning ?? null
        };
      }
    } else if (useDeepSeek && hasImages) {
      log("[Study Assist] Images detected \u2192 Claude (DeepSeek no soporta im\xE1genes)");
      claudeFallbackReason = "images";
    }
    if (isDeepSeekOnlyMode) {
      return { success: false, error: "\u26A0\uFE0F DeepSeek Only mode: Unable to analyze. Check your DeepSeek API key." };
    }
    const claudeStartTime = deepseekAnalysisForClaude ? Date.now() : startTime;
    return await analyzeWithClaude(context, claudeApiKey, selectedClaudeModel, deepseekAnalysisForClaude, claudeStartTime, claudeFallbackReason);
  } catch (error) {
    await logError({ type: "analyzeQuestion_exception", error: error.message, stack: error.stack });
    if (error.message.includes("Failed to fetch")) {
      return { success: false, error: "Network error." };
    }
    return { success: false, error: `Analysis failed: ${error.message}` };
  }
}
async function analyzeWithDeepSeek(context, apiKey) {
  try {
    const matchedQuestion = await findMatchingQuestion(
      context.questionText,
      context.moduleInfo || context.pageTitle,
      context.pageUrl
    );
    const prompt = buildDeepSeekPrompt(context, matchedQuestion);
    log("[Study Assist] Calling DeepSeek API...");
    const controller = new AbortController();
    setActiveDeepSeekController(controller);
    const signal = controller.signal;
    const response = await fetchWithRetry(
      DEEPSEEK_API_BASE,
      {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${apiKey}` },
        body: JSON.stringify({
          model: DEEPSEEK_REASONER_MODEL,
          max_tokens: 2048,
          messages: [{ role: "user", content: prompt }]
        }),
        signal
      },
      2,
      6e4
    );
    let responseBody = null;
    try {
      responseBody = await response.clone().json();
    } catch (e) {
      responseBody = { parseError: e.message };
    }
    await logError({ type: "analyzeWithDeepSeek", status: response.status, responseBody });
    try {
      await chrome.storage.local.set({
        lastApiRequestData: {
          timestamp: Date.now(),
          type: "analyzeWithDeepSeek",
          url: DEEPSEEK_API_BASE,
          status: response.status,
          hasImages: false,
          requestBody: {
            model: DEEPSEEK_REASONER_MODEL,
            max_tokens: 2048,
            messages: [{ role: "user", content: prompt }]
          },
          responseBody
        }
      });
    } catch (_e) {
    }
    if (!response.ok) {
      const status = response.status;
      const errorMsg = responseBody?.error?.message || "";
      const nonRetryableStatuses = [400, 401, 402, 422, 429, 503];
      const skipRetry = nonRetryableStatuses.includes(status);
      let errorDescription;
      switch (status) {
        case 400:
          errorDescription = `DeepSeek: Invalid request format. ${errorMsg}`;
          break;
        case 401:
          errorDescription = `DeepSeek: Authentication failed. Check your API key.`;
          break;
        case 402:
          errorDescription = `DeepSeek: Insufficient balance. Please top up your account.`;
          break;
        case 422:
          errorDescription = `DeepSeek: Invalid parameters. ${errorMsg}`;
          break;
        case 429:
          errorDescription = `DeepSeek: Rate limit reached. Switching to Claude.`;
          break;
        case 500:
          errorDescription = `DeepSeek: Server error. ${errorMsg}`;
          break;
        case 503:
          errorDescription = `DeepSeek: Server overloaded. Switching to Claude.`;
          break;
        default:
          errorDescription = `DeepSeek API Error (${status}): ${errorMsg}`;
          break;
      }
      log(`[Study Assist] DeepSeek error ${status}${skipRetry ? " (non-retryable)" : ""}: ${errorDescription}`);
      return { success: false, error: errorDescription, skipRetry };
    }
    const message = responseBody?.choices?.[0]?.message;
    const reasoningContent = message?.reasoning_content || null;
    const result = message?.content;
    if (!result) {
      return { success: false, error: "No response from DeepSeek" };
    }
    const apiInputTokens = responseBody?.usage?.prompt_tokens ?? 0;
    const apiOutputTokens = responseBody?.usage?.completion_tokens ?? 0;
    if (DEBUG_MODE) {
      console.log("[Study Assist] ====== DeepSeek Response ======");
      if (reasoningContent)
        console.log("[Study Assist] DeepSeek REASONING:", reasoningContent);
      console.log("[Study Assist] DeepSeek ANSWER:", result);
      console.log("[Study Assist] DeepSeek TOKENS:", apiInputTokens, "+", apiOutputTokens);
      console.log("[Study Assist] ================================");
    }
    setActiveDeepSeekController(null);
    const parsed = parseDeepSeekResponse(result, context, reasoningContent);
    parsed.inputTokens = apiInputTokens;
    parsed.outputTokens = apiOutputTokens;
    return parsed;
  } catch (error) {
    setActiveDeepSeekController(null);
    if (error.name === "AbortError") {
      log("[Study Assist] DeepSeek request cancelled");
      return { success: false, error: "DeepSeek cancelled", cancelled: true };
    }
    return { success: false, error: `DeepSeek error: ${error.message}` };
  }
}
async function analyzeWithClaude(context, apiKey, model, deepseekAnalysis = null, startTime = Date.now(), fallbackReasonOverride) {
  let matchedQuestion = null;
  if (!deepseekAnalysis) {
    matchedQuestion = await findMatchingQuestion(
      context.questionText,
      context.moduleInfo || context.pageTitle,
      context.pageUrl
    );
  }
  const prompt = deepseekAnalysis ? buildClaudeValidationPrompt(context, deepseekAnalysis) : buildAnalysisPrompt(context, matchedQuestion);
  log("[Study Assist] Claude analysis...", deepseekAnalysis ? "(validating DeepSeek)" : "");
  const messageContent = buildMessageContent(prompt, context.images);
  const questionText = context.questionText || "";
  const multiAnswerPattern = /elija\s*(dos|tres|cuatro|cinco|2|3|4|5)|escoja\s*(dos|tres|cuatro|cinco|2|3|4|5)|seleccione\s*(dos|tres|cuatro|cinco|2|3|4|5)|select\s*(two|three|four|five|2|3|4|5)|choose\s*(two|three|four|five|2|3|4|5)|\(\s*(dos|tres|cuatro|two|three|four|2|3|4|5)\s*opciones?\s*\)/i;
  const isMultipleAnswer = multiAnswerPattern.test(questionText);
  const isQuickMode = context.responseMode === "quick";
  const isMatching = context.questionType === "matching";
  const hasImages = context.images && context.images.length > 0;
  const maxTokens = deepseekAnalysis ? 2048 : 1024;
  log("[Study Assist] Claude config:", { maxTokens, hasImages, isMultipleAnswer, hasDeepSeekAnalysis: !!deepseekAnalysis });
  const messages = [{ role: "user", content: messageContent }];
  const response = await fetchWithRetry(
    CLAUDE_API_BASE,
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": apiKey,
        "anthropic-version": ANTHROPIC_VERSION,
        "anthropic-dangerous-direct-browser-access": "true"
      },
      body: JSON.stringify({ model, max_tokens: maxTokens, messages })
    },
    2,
    45e3
  );
  let responseBody = null;
  try {
    responseBody = await response.clone().json();
  } catch (e) {
    responseBody = { parseError: e.message };
  }
  await logError({
    type: "analyzeWithClaude",
    url: CLAUDE_API_BASE,
    status: response.status,
    statusText: response.statusText,
    responseBody,
    hasImages: hasImages || false
  });
  try {
    await chrome.storage.local.set({
      lastApiRequestData: {
        timestamp: Date.now(),
        type: "analyzeWithClaude",
        url: CLAUDE_API_BASE,
        status: response.status,
        statusText: response.statusText,
        hasImages: hasImages || false,
        requestBody: { model, max_tokens: maxTokens, messages },
        responseBody
      }
    });
  } catch (_e) {
  }
  if (!response.ok) {
    return handleApiError(response.status, responseBody);
  }
  let result = responseBody?.content?.[0]?.text;
  if (!result)
    return { success: false, error: "No response generated." };
  log("[Study Assist] Claude response:", result);
  const realInputTokens = responseBody?.usage?.input_tokens ?? Math.ceil((prompt?.length || 0) / 4);
  const realOutputTokens = responseBody?.usage?.output_tokens ?? Math.ceil((result?.length || 0) / 4);
  const isValidation = !!deepseekAnalysis;
  const fallbackReason = fallbackReasonOverride || (!deepseekAnalysis && hasImages ? "images" : void 0);
  await trackUsage({
    timestamp: Date.now(),
    questionText: context.questionText.substring(0, 200),
    questionType: context.questionType,
    answer: result,
    source: "claude",
    model,
    inputTokens: realInputTokens,
    outputTokens: realOutputTokens,
    responseMode: context.responseMode,
    success: true,
    latencyMs: Date.now() - startTime,
    platform: detectPlatform(context.pageUrl),
    validated: isValidation,
    fallbackReason,
    confidence: deepseekAnalysis?.confidence,
    deepseekReasoning: deepseekAnalysis?.reasoning ?? void 0
  });
  if (isQuickMode && !isMatching) {
    result = extractClaudeQuickAnswer(result, context.questionType);
  }
  return { success: true, result, source: "claude" };
}
async function analyzeQuestionStreaming(context, port) {
  const startTime = Date.now();
  try {
    const bankMatch = await findMatchingQuestion(
      context.questionText,
      context.moduleInfo || context.pageTitle,
      context.pageUrl
    );
    if (bankMatch && (bankMatch.correctAnswer || bankMatch.correctAnswers) && bankMatch.similarity >= 80) {
      const answerLetter = matchCorrectAnswerToLetter(bankMatch, context.options);
      if (answerLetter) {
        const displayAnswer = bankMatch.correctAnswers ? bankMatch.correctAnswers.join(" | ") : bankMatch.correctAnswer || "";
        log(`[Study Assist] INSTANT ANSWER (streaming) from question bank (${bankMatch.similarity}% match): ${answerLetter}`);
        await trackUsage({
          timestamp: Date.now(),
          questionText: context.questionText.substring(0, 200),
          questionType: context.questionType,
          answer: answerLetter,
          source: "question-bank",
          model: "questions-bank.json",
          inputTokens: 0,
          outputTokens: 0,
          responseMode: context.responseMode,
          success: true,
          latencyMs: Date.now() - startTime,
          platform: detectPlatform(context.pageUrl),
          confidence: "HIGH"
        });
        const bankChunkText = `**Respuesta del banco de preguntas (${bankMatch.similarity}% coincidencia):**

**${answerLetter}** \u2014 ${displayAnswer}

${bankMatch.explanation || ""}`;
        try {
          port.postMessage({ type: "STREAM_STATUS", status: "started" });
          port.postMessage({ type: "STREAM_CHUNK", chunk: bankChunkText });
          port.postMessage({ type: "STREAM_COMPLETE", fullText: bankChunkText, inputTokens: 0, outputTokens: 0, cost: 0 });
        } catch {
        }
        return;
      }
    }
    const rateLimitError = checkRateLimit(context.questionText);
    if (rateLimitError) {
      port.postMessage({ type: "STREAM_ERROR", error: rateLimitError });
      return;
    }
    recordRequest(context.questionText);
    const claudeApiKey = await getDecryptedApiKey("claudeApiKey");
    const storageResult = await chrome.storage.local.get(["claudeModel"]);
    const model = context.qaMode ? QA_CLAUDE_MODEL : storageResult.claudeModel || DEFAULT_MODEL;
    if (!claudeApiKey) {
      port.postMessage({ type: "STREAM_ERROR", error: "Claude API key not configured." });
      return;
    }
    const matchedQuestion = bankMatch;
    const prompt = buildAnalysisPrompt(context, matchedQuestion);
    const messageContent = buildMessageContent(prompt, context.images);
    const maxTokens = 1024;
    const messages = [{ role: "user", content: messageContent }];
    port.postMessage({ type: "STREAM_STATUS", status: "started" });
    const result = await streamClaudeResponse(
      claudeApiKey,
      model,
      messages,
      maxTokens,
      {
        onChunk(text) {
          try {
            port.postMessage({ type: "STREAM_CHUNK", chunk: text });
          } catch {
          }
        },
        onInputTokens(count) {
          try {
            port.postMessage({ type: "STREAM_STATUS", status: "input_tokens", inputTokens: count });
          } catch {
          }
        },
        onComplete(outputTokens) {
          try {
            port.postMessage({ type: "STREAM_STATUS", status: "complete", outputTokens });
          } catch {
          }
        },
        onError(error) {
          try {
            port.postMessage({ type: "STREAM_ERROR", error });
          } catch {
          }
        }
      }
    );
    await trackUsage({
      timestamp: Date.now(),
      questionText: context.questionText.substring(0, 200),
      questionType: context.questionType,
      answer: result.fullText.substring(0, 200),
      source: "claude",
      model,
      inputTokens: result.inputTokens,
      outputTokens: result.outputTokens,
      responseMode: context.responseMode,
      success: true,
      latencyMs: Date.now() - startTime,
      platform: detectPlatform(context.pageUrl)
    });
    port.postMessage({
      type: "STREAM_COMPLETE",
      fullText: result.fullText,
      inputTokens: result.inputTokens,
      outputTokens: result.outputTokens,
      cost: calculateCost(model, result.inputTokens, result.outputTokens)
    });
  } catch (error) {
    if (error.name !== "AbortError") {
      try {
        port.postMessage({ type: "STREAM_ERROR", error: error.message });
      } catch {
      }
    }
  }
}

// src/background/modules/extensionState.ts
async function handleToggleExtension(isActive) {
  try {
    const result = await chrome.storage.local.get(["disguiseMode"]);
    const isDisguised = result.disguiseMode ?? false;
    if (!isDisguised) {
      await chrome.action.setBadgeText({ text: isActive ? "ON" : "" });
      await chrome.action.setBadgeBackgroundColor({ color: isActive ? "#34a853" : "#ea4335" });
    }
    return { success: true };
  } catch (error) {
    console.error("[Study Assist] Toggle error:", error);
    return { success: false, error: error.message };
  }
}
async function handleDisguiseMode(enabled) {
  log("[Study Assist] handleDisguiseMode called with:", enabled);
  try {
    if (enabled) {
      log("[Study Assist] Setting uBlock icon...");
      await chrome.action.setIcon({
        path: {
          16: chrome.runtime.getURL("icons/ublock/icon_16.png"),
          32: chrome.runtime.getURL("icons/ublock/icon_32.png"),
          48: chrome.runtime.getURL("icons/ublock/icon_64.png"),
          128: chrome.runtime.getURL("icons/ublock/icon_128.png")
        }
      });
      log("[Study Assist] Setting uBlock title...");
      await chrome.action.setTitle({ title: "uBlock Origin" });
      await chrome.action.setBadgeText({ text: "" });
      log("[Study Assist] Disguise mode enabled (uBlock Origin)");
    } else {
      log("[Study Assist] Restoring original icon...");
      await chrome.action.setIcon({
        path: {
          16: chrome.runtime.getURL("icons/icon16.png"),
          32: chrome.runtime.getURL("icons/icon32.png"),
          48: chrome.runtime.getURL("icons/icon48.png"),
          128: chrome.runtime.getURL("icons/icon128.png")
        }
      });
      log("[Study Assist] Restoring original title...");
      await chrome.action.setTitle({ title: "Study Assist" });
      const result = await chrome.storage.local.get(["extensionActive"]);
      const isActive = result.extensionActive ?? false;
      if (isActive) {
        await chrome.action.setBadgeText({ text: "ON" });
        await chrome.action.setBadgeBackgroundColor({ color: "#34a853" });
      }
      log("[Study Assist] Disguise mode disabled");
    }
    return { success: true };
  } catch (error) {
    console.error("[Study Assist] Disguise mode error:", error);
    return { success: false, error: error.message };
  }
}
async function restoreDisguiseMode() {
  try {
    const { disguiseMode } = await chrome.storage.local.get("disguiseMode");
    if (disguiseMode) {
      await handleDisguiseMode(true);
    }
  } catch (error) {
    console.error("[Study Assist] Error restoring disguise mode:", error);
  }
}

// src/background/background.ts
async function handleMessage(message, _sender) {
  switch (message.type) {
    case "TOGGLE_EXTENSION":
      return handleToggleExtension(message.active ?? false);
    case "TEST_API_KEY":
      return testApiKey(message.apiKey ?? "");
    case "TEST_DEEPSEEK_API_KEY":
      return testDeepSeekApiKey(message.apiKey ?? "");
    case "ANALYZE_QUESTION":
      return analyzeQuestion(message.context);
    case "CANCEL_DEEPSEEK":
      if (activeDeepSeekController) {
        log("[Study Assist] Cancelling DeepSeek...");
        activeDeepSeekController.abort();
        setActiveDeepSeekController(null);
        return { success: true, cancelled: true };
      }
      return { success: true, cancelled: false };
    case "TOGGLE_DISGUISE_MODE":
      return handleDisguiseMode(message.enabled ?? false);
    case "ENCRYPT_AND_SAVE_KEY":
      try {
        const storageKey = message.keyType === "deepseek" ? "deepseekApiKey" : "claudeApiKey";
        await encryptAndSaveKey(storageKey, message.rawKey ?? "");
        return { success: true };
      } catch (error) {
        return { success: false, error: error.message };
      }
    case "GET_USAGE_STATS":
      try {
        const stats = await getUsageStats();
        return { success: true, stats };
      } catch (error) {
        return { success: false, error: error.message };
      }
    case "GET_USAGE_HISTORY":
      try {
        const history = await getRecentHistory(message.limit ?? 20);
        return { success: true, history };
      } catch (error) {
        return { success: false, error: error.message };
      }
    case "CLEAR_USAGE_DATA":
      try {
        await clearUsageData();
        return { success: true };
      } catch (error) {
        return { success: false, error: error.message };
      }
    case "GET_STORAGE_INFO":
      try {
        const storageInfo = await getStorageInfo();
        return { success: true, storageInfo };
      } catch (error) {
        return { success: false, error: error.message };
      }
    case "TRIM_HISTORY":
      try {
        const deleted = await trimHistory({ keepLast: message.keepLast, keepDays: message.keepDays });
        return { success: true, deleted };
      } catch (error) {
        return { success: false, error: error.message };
      }
    default:
      return { success: false, error: "Unknown message type" };
  }
}
chrome.runtime.onMessage.addListener(
  (message, sender, sendResponse) => {
    handleMessage(message, sender).then((response) => sendResponse(response)).catch((error) => sendResponse({ success: false, error: error.message }));
    return true;
  }
);
chrome.runtime.onConnect.addListener((port) => {
  if (port.name !== "stream-analysis")
    return;
  port.onMessage.addListener(async (msg) => {
    try {
      await analyzeQuestionStreaming(msg.context, port);
    } catch (error) {
      try {
        port.postMessage({ type: "STREAM_ERROR", error: error.message });
      } catch {
      }
    }
  });
});
chrome.runtime.onInstalled.addListener(async (details) => {
  if (details.reason === "install") {
    await chrome.storage.local.set({
      extensionActive: false,
      responseMode: "guided",
      autoDetect: true,
      highlightQuestions: true,
      theme: "system",
      buttonPosition: "bottom-right",
      errorLog: ""
    });
    await chrome.action.setBadgeText({ text: "" });
  }
  await restoreDisguiseMode();
  await updateStorageBadge();
});
chrome.runtime.onStartup.addListener(async () => {
  await restoreDisguiseMode();
  await updateStorageBadge();
});
chrome.tabs.onUpdated.addListener(
  async (tabId, changeInfo, tab) => {
    if (changeInfo.status === "complete") {
      try {
        const { extensionActive } = await chrome.storage.local.get("extensionActive");
        if (extensionActive) {
          chrome.tabs.sendMessage(tabId, { type: "PAGE_LOADED", url: tab.url }).catch(() => {
          });
        }
      } catch (_error) {
      }
    }
  }
);
//# sourceMappingURL=data:application/json;base64,ewogICJ2ZXJzaW9uIjogMywKICAic291cmNlcyI6IFsiLi4vc3JjL2JhY2tncm91bmQvbW9kdWxlcy9jb25zdGFudHMudHMiLCAiLi4vc3JjL2JhY2tncm91bmQvbW9kdWxlcy9mZXRjaFV0aWxzLnRzIiwgIi4uL3NyYy9iYWNrZ3JvdW5kL21vZHVsZXMvcXVlc3Rpb25CYW5rLnRzIiwgIi4uL3NyYy9iYWNrZ3JvdW5kL21vZHVsZXMvcHJvbXB0cy50cyIsICIuLi9zcmMvYmFja2dyb3VuZC9tb2R1bGVzL3BhcnNpbmcudHMiLCAiLi4vc3JjL2JhY2tncm91bmQvbW9kdWxlcy9jcnlwdG8udHMiLCAiLi4vc3JjL2JhY2tncm91bmQvbW9kdWxlcy91c2FnZVRyYWNrZXIudHMiLCAiLi4vc3JjL2JhY2tncm91bmQvbW9kdWxlcy9yYXRlTGltaXRlci50cyIsICIuLi9zcmMvYmFja2dyb3VuZC9tb2R1bGVzL3N0cmVhbWluZy50cyIsICIuLi9zcmMvYmFja2dyb3VuZC9tb2R1bGVzL2FwaS50cyIsICIuLi9zcmMvYmFja2dyb3VuZC9tb2R1bGVzL2V4dGVuc2lvblN0YXRlLnRzIiwgIi4uL3NyYy9iYWNrZ3JvdW5kL2JhY2tncm91bmQudHMiXSwKICAic291cmNlc0NvbnRlbnQiOiBbIi8qKlxyXG4gKiBCYWNrZ3JvdW5kIFNlcnZpY2UgV29ya2VyIC0gQ29uc3RhbnRzICYgU2hhcmVkIFN0YXRlXHJcbiAqL1xyXG5cclxuLy8gPT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT1cclxuLy8gRGVidWcgTW9kZVxyXG4vLyA9PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PVxyXG5leHBvcnQgY29uc3QgREVCVUdfTU9ERTogYm9vbGVhbiA9IHRydWU7XHJcbmV4cG9ydCBjb25zdCBsb2cgPSAoLi4uYXJnczogdW5rbm93bltdKTogdm9pZCA9PiB7XHJcbiAgaWYgKERFQlVHX01PREUpIGNvbnNvbGUubG9nKC4uLmFyZ3MpO1xyXG59O1xyXG5cclxuLy8gPT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT1cclxuLy8gQVBJIENvbnN0YW50c1xyXG4vLyA9PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PVxyXG5leHBvcnQgY29uc3QgQ0xBVURFX0FQSV9CQVNFID0gXCJodHRwczovL2FwaS5hbnRocm9waWMuY29tL3YxL21lc3NhZ2VzXCI7XHJcbmV4cG9ydCBjb25zdCBERUZBVUxUX01PREVMID0gXCJjbGF1ZGUtMy1oYWlrdS0yMDI0MDMwN1wiO1xyXG5leHBvcnQgY29uc3QgQU5USFJPUElDX1ZFUlNJT04gPSBcIjIwMjMtMDYtMDFcIjtcclxuXHJcbmV4cG9ydCBjb25zdCBERUVQU0VFS19BUElfQkFTRSA9IFwiaHR0cHM6Ly9hcGkuZGVlcHNlZWsuY29tL3YxL2NoYXQvY29tcGxldGlvbnNcIjtcclxuZXhwb3J0IGNvbnN0IERFRVBTRUVLX1JFQVNPTkVSX01PREVMID0gXCJkZWVwc2Vlay1yZWFzb25lclwiO1xyXG5cclxuLy8gPT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT1cclxuLy8gTXV0YWJsZSBTaGFyZWQgU3RhdGVcclxuLy8gPT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT1cclxuXHJcbi8qKiBBY3RpdmUgRGVlcFNlZWsgQWJvcnRDb250cm9sbGVyIGZvciBjYW5jZWxsYXRpb24gKi9cclxuZXhwb3J0IGxldCBhY3RpdmVEZWVwU2Vla0NvbnRyb2xsZXI6IEFib3J0Q29udHJvbGxlciB8IG51bGwgPSBudWxsO1xyXG5cclxuZXhwb3J0IGZ1bmN0aW9uIHNldEFjdGl2ZURlZXBTZWVrQ29udHJvbGxlcihjdHJsOiBBYm9ydENvbnRyb2xsZXIgfCBudWxsKTogdm9pZCB7XHJcbiAgYWN0aXZlRGVlcFNlZWtDb250cm9sbGVyID0gY3RybDtcclxufVxyXG5cclxuLyoqIENhY2hlZCBxdWVzdGlvbnMgYmFuayAqL1xyXG5leHBvcnQgbGV0IHF1ZXN0aW9uc0Jhbms6IFF1ZXN0aW9uc0JhbmsgfCBudWxsID0gbnVsbDtcclxuXHJcbmV4cG9ydCBmdW5jdGlvbiBzZXRRdWVzdGlvbnNCYW5rKGJhbms6IFF1ZXN0aW9uc0JhbmsgfCBudWxsKTogdm9pZCB7XHJcbiAgcXVlc3Rpb25zQmFuayA9IGJhbms7XHJcbn1cclxuXHJcbi8vID09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09XHJcbi8vIFR5cGUgRGVmaW5pdGlvbnNcclxuLy8gPT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT1cclxuXHJcbmV4cG9ydCBpbnRlcmZhY2UgUXVlc3Rpb25zQmFuayB7XHJcbiAgbW9kdWxlczoge1xyXG4gICAgW21vZHVsZUtleTogc3RyaW5nXToge1xyXG4gICAgICBxdWVzdGlvbnM6IFF1ZXN0aW9uQmFua1F1ZXN0aW9uW107XHJcbiAgICB9O1xyXG4gIH07XHJcbn1cclxuXHJcbmV4cG9ydCBpbnRlcmZhY2UgUXVlc3Rpb25CYW5rUXVlc3Rpb24ge1xyXG4gIHRleHQ6IHN0cmluZztcclxuICB0ZXh0Tm9ybWFsaXplZDogc3RyaW5nO1xyXG4gIG9wdGlvbnM6IHN0cmluZ1tdO1xyXG4gIGV4cGxhbmF0aW9uPzogc3RyaW5nO1xyXG4gIGNvcnJlY3RBbnN3ZXI/OiBzdHJpbmc7XHJcbiAgY29ycmVjdEFuc3dlcnM/OiBzdHJpbmdbXTtcclxufVxyXG5cclxuZXhwb3J0IGludGVyZmFjZSBNYXRjaGVkUXVlc3Rpb24gZXh0ZW5kcyBRdWVzdGlvbkJhbmtRdWVzdGlvbiB7XHJcbiAgbW9kdWxlUmFuZ2U6IHN0cmluZztcclxuICBzaW1pbGFyaXR5OiBudW1iZXI7XHJcbn1cclxuXHJcbmV4cG9ydCB0eXBlIENvbmZpZGVuY2VMZXZlbCA9IFwiSElHSFwiIHwgXCJNRURJVU1cIiB8IFwiTE9XXCI7XHJcblxyXG5leHBvcnQgaW50ZXJmYWNlIE51bWJlcldvcmRNYXAge1xyXG4gIFtrZXk6IHN0cmluZ106IG51bWJlcjtcclxufVxyXG5cclxuZXhwb3J0IGludGVyZmFjZSBFcnJvckxvZ09iamVjdCB7XHJcbiAgdHlwZTogc3RyaW5nO1xyXG4gIHVybD86IHN0cmluZztcclxuICBzdGF0dXM/OiBudW1iZXI7XHJcbiAgc3RhdHVzVGV4dD86IHN0cmluZztcclxuICByZXNwb25zZUJvZHk/OiB1bmtub3duO1xyXG4gIGVycm9yPzogc3RyaW5nO1xyXG4gIHN0YWNrPzogc3RyaW5nO1xyXG4gIGhhc0ltYWdlcz86IGJvb2xlYW47XHJcbn1cclxuXHJcbmV4cG9ydCBpbnRlcmZhY2UgU3RvcmFnZURhdGEge1xyXG4gIGNsYXVkZUFwaUtleT86IHN0cmluZztcclxuICBjbGF1ZGVNb2RlbD86IHN0cmluZztcclxuICB1c2VEZWVwU2Vlaz86IGJvb2xlYW47XHJcbiAgZGVlcHNlZWtBcGlLZXk/OiBzdHJpbmc7XHJcbiAgZGVlcHNlZWtPbmx5PzogYm9vbGVhbjtcclxuICBleHRlbnNpb25BY3RpdmU/OiBib29sZWFuO1xyXG4gIGRpc2d1aXNlTW9kZT86IGJvb2xlYW47XHJcbiAgcmVzcG9uc2VNb2RlPzogc3RyaW5nO1xyXG4gIGF1dG9EZXRlY3Q/OiBib29sZWFuO1xyXG4gIGhpZ2hsaWdodFF1ZXN0aW9ucz86IGJvb2xlYW47XHJcbiAgZXJyb3JMb2c/OiBzdHJpbmc7XHJcbn1cclxuXHJcbmV4cG9ydCBpbnRlcmZhY2UgTWVzc2FnZVJlc3BvbnNlIHtcclxuICBzdWNjZXNzOiBib29sZWFuO1xyXG4gIGVycm9yPzogc3RyaW5nO1xyXG4gIHdhcm5pbmc/OiBzdHJpbmc7XHJcbiAgY2FuY2VsbGVkPzogYm9vbGVhbjtcclxufVxyXG5cclxuZXhwb3J0IGludGVyZmFjZSBGZXRjaE9wdGlvbnNXaXRoU2lnbmFsIGV4dGVuZHMgUmVxdWVzdEluaXQge1xyXG4gIHNpZ25hbD86IEFib3J0U2lnbmFsO1xyXG59XHJcblxyXG4vLyBDbGF1ZGUgdHlwZXNcclxuZXhwb3J0IGludGVyZmFjZSBDbGF1ZGVSZXF1ZXN0Qm9keSB7XHJcbiAgbW9kZWw6IHN0cmluZztcclxuICBtYXhfdG9rZW5zOiBudW1iZXI7XHJcbiAgbWVzc2FnZXM6IENsYXVkZU1lc3NhZ2VbXTtcclxufVxyXG5cclxuZXhwb3J0IGludGVyZmFjZSBDbGF1ZGVNZXNzYWdlIHtcclxuICByb2xlOiBcInVzZXJcIiB8IFwiYXNzaXN0YW50XCI7XHJcbiAgY29udGVudDogc3RyaW5nIHwgQ2xhdWRlQ29udGVudEJsb2NrW107XHJcbn1cclxuXHJcbmV4cG9ydCB0eXBlIENsYXVkZUNvbnRlbnRCbG9jayA9IENsYXVkZVRleHRCbG9jayB8IENsYXVkZUltYWdlQmxvY2s7XHJcblxyXG5leHBvcnQgaW50ZXJmYWNlIENsYXVkZVRleHRCbG9jayB7XHJcbiAgdHlwZTogXCJ0ZXh0XCI7XHJcbiAgdGV4dDogc3RyaW5nO1xyXG59XHJcblxyXG5leHBvcnQgaW50ZXJmYWNlIENsYXVkZUltYWdlQmxvY2sge1xyXG4gIHR5cGU6IFwiaW1hZ2VcIjtcclxuICBzb3VyY2U6IENsYXVkZUltYWdlU291cmNlQmFzZTY0IHwgQ2xhdWRlSW1hZ2VTb3VyY2VVcmw7XHJcbn1cclxuXHJcbmV4cG9ydCBpbnRlcmZhY2UgQ2xhdWRlSW1hZ2VTb3VyY2VCYXNlNjQge1xyXG4gIHR5cGU6IFwiYmFzZTY0XCI7XHJcbiAgbWVkaWFfdHlwZTogc3RyaW5nO1xyXG4gIGRhdGE6IHN0cmluZztcclxufVxyXG5cclxuZXhwb3J0IGludGVyZmFjZSBDbGF1ZGVJbWFnZVNvdXJjZVVybCB7XHJcbiAgdHlwZTogXCJ1cmxcIjtcclxuICB1cmw6IHN0cmluZztcclxufVxyXG5cclxuZXhwb3J0IGludGVyZmFjZSBDbGF1ZGVBcGlSZXNwb25zZSB7XHJcbiAgY29udGVudD86IEFycmF5PHsgdHlwZTogc3RyaW5nOyB0ZXh0Pzogc3RyaW5nIH0+O1xyXG4gIHVzYWdlPzoge1xyXG4gICAgaW5wdXRfdG9rZW5zPzogbnVtYmVyO1xyXG4gICAgb3V0cHV0X3Rva2Vucz86IG51bWJlcjtcclxuICB9O1xyXG4gIGVycm9yPzogeyBtZXNzYWdlOiBzdHJpbmc7IHR5cGU/OiBzdHJpbmcgfTtcclxuICBwYXJzZUVycm9yPzogc3RyaW5nO1xyXG59XHJcblxyXG4vLyBEZWVwU2VlayB0eXBlc1xyXG5leHBvcnQgaW50ZXJmYWNlIERlZXBTZWVrUmVxdWVzdEJvZHkge1xyXG4gIG1vZGVsOiBzdHJpbmc7XHJcbiAgbWF4X3Rva2VuczogbnVtYmVyO1xyXG4gIG1lc3NhZ2VzOiBEZWVwU2Vla01lc3NhZ2VbXTtcclxufVxyXG5cclxuZXhwb3J0IGludGVyZmFjZSBEZWVwU2Vla01lc3NhZ2Uge1xyXG4gIHJvbGU6IFwidXNlclwiIHwgXCJhc3Npc3RhbnRcIiB8IFwic3lzdGVtXCI7XHJcbiAgY29udGVudDogc3RyaW5nO1xyXG59XHJcblxyXG5leHBvcnQgaW50ZXJmYWNlIERlZXBTZWVrQXBpUmVzcG9uc2Uge1xyXG4gIGNob2ljZXM/OiBBcnJheTx7XHJcbiAgICBtZXNzYWdlPzoge1xyXG4gICAgICBjb250ZW50Pzogc3RyaW5nO1xyXG4gICAgICByZWFzb25pbmdfY29udGVudD86IHN0cmluZztcclxuICAgIH07XHJcbiAgfT47XHJcbiAgdXNhZ2U/OiB7XHJcbiAgICBwcm9tcHRfdG9rZW5zPzogbnVtYmVyO1xyXG4gICAgY29tcGxldGlvbl90b2tlbnM/OiBudW1iZXI7XHJcbiAgICB0b3RhbF90b2tlbnM/OiBudW1iZXI7XHJcbiAgfTtcclxuICBlcnJvcj86IHsgbWVzc2FnZTogc3RyaW5nOyB0eXBlPzogc3RyaW5nIH07XHJcbiAgcGFyc2VFcnJvcj86IHN0cmluZztcclxufVxyXG5cclxuZXhwb3J0IGludGVyZmFjZSBEZWVwU2Vla0FuYWx5c2lzUmVzdWx0IHtcclxuICBzdWNjZXNzOiBib29sZWFuO1xyXG4gIHJlc3VsdD86IHN0cmluZztcclxuICBlcnJvcj86IHN0cmluZztcclxuICBzb3VyY2U/OiBcImRlZXBzZWVrXCIgfCBcImNsYXVkZVwiIHwgXCJxdWVzdGlvbi1iYW5rXCI7XHJcbiAgY29uZmlkZW5jZT86IENvbmZpZGVuY2VMZXZlbDtcclxuICBkZWVwc2Vla0FuYWx5c2lzPzogc3RyaW5nO1xyXG4gIGRlZXBzZWVrUmVhc29uaW5nPzogc3RyaW5nIHwgbnVsbDtcclxuICBjYW5jZWxsZWQ/OiBib29sZWFuO1xyXG4gIC8qKiBXaGVuIHRydWUsIHRoZSBvcmNoZXN0cmF0b3Igc2hvdWxkIE5PVCByZXRyeSBcdTIwMTQgZ28gZGlyZWN0bHkgdG8gQ2xhdWRlIGZhbGxiYWNrICovXHJcbiAgc2tpcFJldHJ5PzogYm9vbGVhbjtcclxuICBleHBsYW5hdGlvbj86IHN0cmluZztcclxuICBpbnB1dFRva2Vucz86IG51bWJlcjtcclxuICBvdXRwdXRUb2tlbnM/OiBudW1iZXI7XHJcbn1cclxuXHJcbmV4cG9ydCBpbnRlcmZhY2UgRGVlcFNlZWtBbmFseXNpc0ZvckNsYXVkZSB7XHJcbiAgYW5zd2VyOiBzdHJpbmc7XHJcbiAgY29uZmlkZW5jZTogQ29uZmlkZW5jZUxldmVsO1xyXG4gIGFuYWx5c2lzOiBzdHJpbmc7XHJcbiAgcmVhc29uaW5nOiBzdHJpbmcgfCBudWxsO1xyXG59XHJcblxyXG4vLyBNZXNzYWdlIHR5cGVzXHJcbmV4cG9ydCB0eXBlIEV4dGVuc2lvbk1lc3NhZ2VUeXBlID1cclxuICB8IFwiVE9HR0xFX0VYVEVOU0lPTlwiXHJcbiAgfCBcIlRFU1RfQVBJX0tFWVwiXHJcbiAgfCBcIlRFU1RfREVFUFNFRUtfQVBJX0tFWVwiXHJcbiAgfCBcIkFOQUxZWkVfUVVFU1RJT05cIlxyXG4gIHwgXCJDQU5DRUxfREVFUFNFRUtcIlxyXG4gIHwgXCJUT0dHTEVfRElTR1VJU0VfTU9ERVwiXHJcbiAgfCBcIlBBR0VfTE9BREVEXCJcclxuICB8IFwiRU5DUllQVF9BTkRfU0FWRV9LRVlcIlxyXG4gIHwgXCJHRVRfVVNBR0VfU1RBVFNcIlxyXG4gIHwgXCJHRVRfVVNBR0VfSElTVE9SWVwiXHJcbiAgfCBcIkNMRUFSX1VTQUdFX0RBVEFcIlxyXG4gIHwgXCJHRVRfU1RPUkFHRV9JTkZPXCJcclxuICB8IFwiVFJJTV9ISVNUT1JZXCI7XHJcblxyXG5leHBvcnQgaW50ZXJmYWNlIEV4dGVuc2lvbk1lc3NhZ2Uge1xyXG4gIHR5cGU6IEV4dGVuc2lvbk1lc3NhZ2VUeXBlO1xyXG4gIGFjdGl2ZT86IGJvb2xlYW47XHJcbiAgYXBpS2V5Pzogc3RyaW5nO1xyXG4gIGVuYWJsZWQ/OiBib29sZWFuO1xyXG4gIGNvbnRleHQ/OiBpbXBvcnQoXCIuLi8uLi90eXBlcy9pbmRleFwiKS5BbmFseXNpc0NvbnRleHQ7XHJcbiAgdXJsPzogc3RyaW5nO1xyXG4gIGtleVR5cGU/OiBzdHJpbmc7XHJcbiAgcmF3S2V5Pzogc3RyaW5nO1xyXG4gIGxpbWl0PzogbnVtYmVyO1xyXG4gIGtlZXBMYXN0PzogbnVtYmVyO1xyXG4gIGtlZXBEYXlzPzogbnVtYmVyO1xyXG59XHJcbiIsICIvKipcclxuICogQmFja2dyb3VuZCBTZXJ2aWNlIFdvcmtlciAtIEZldGNoIFV0aWxpdGllc1xyXG4gKiBUaW1lb3V0LCByZXRyeSwgYW5kIGVycm9yIGxvZ2dpbmcgaGVscGVyc1xyXG4gKi9cclxuXHJcbmltcG9ydCB0eXBlIHsgRmV0Y2hPcHRpb25zV2l0aFNpZ25hbCwgRXJyb3JMb2dPYmplY3QgfSBmcm9tIFwiLi9jb25zdGFudHMuanNcIjtcclxuXHJcbi8vID09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09XHJcbi8vIEVycm9yIExvZ2dpbmdcclxuLy8gPT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT1cclxuXHJcbmV4cG9ydCBhc3luYyBmdW5jdGlvbiBsb2dFcnJvcihsb2dPYmo6IEVycm9yTG9nT2JqZWN0KTogUHJvbWlzZTx2b2lkPiB7XHJcbiAgdHJ5IHtcclxuICAgIGNvbnN0IGxvZ1RleHQgPSBgWyR7bmV3IERhdGUoKS50b0lTT1N0cmluZygpfV0gJHtKU09OLnN0cmluZ2lmeShsb2dPYmosIG51bGwsIDIpfVxcbmA7XHJcbiAgICBjb25zdCB7IGVycm9yTG9nIH0gPSBhd2FpdCBjaHJvbWUuc3RvcmFnZS5sb2NhbC5nZXQoXCJlcnJvckxvZ1wiKSBhcyB7IGVycm9yTG9nPzogc3RyaW5nIH07XHJcbiAgICBjb25zdCBuZXdMb2cgPSAoZXJyb3JMb2cgfHwgXCJcIikgKyBsb2dUZXh0O1xyXG4gICAgYXdhaXQgY2hyb21lLnN0b3JhZ2UubG9jYWwuc2V0KHsgZXJyb3JMb2c6IG5ld0xvZyB9KTtcclxuICB9IGNhdGNoIChfZSkge1xyXG4gICAgLy8gU2lsZW50IGZhaWxcclxuICB9XHJcbn1cclxuXHJcbi8vID09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09XHJcbi8vIEZldGNoIHdpdGggVGltZW91dFxyXG4vLyA9PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PVxyXG5cclxuZXhwb3J0IGZ1bmN0aW9uIGZldGNoV2l0aFRpbWVvdXQoXHJcbiAgdXJsOiBzdHJpbmcsXHJcbiAgb3B0aW9uczogRmV0Y2hPcHRpb25zV2l0aFNpZ25hbCxcclxuICB0aW1lb3V0OiBudW1iZXIgPSAzMDAwMFxyXG4pOiBQcm9taXNlPFJlc3BvbnNlPiB7XHJcbiAgY29uc3QgdGltZW91dENvbnRyb2xsZXIgPSBuZXcgQWJvcnRDb250cm9sbGVyKCk7XHJcbiAgY29uc3QgdGltZW91dElkID0gc2V0VGltZW91dCgoKSA9PiB0aW1lb3V0Q29udHJvbGxlci5hYm9ydCgpLCB0aW1lb3V0KTtcclxuXHJcbiAgbGV0IGNvbWJpbmVkU2lnbmFsOiBBYm9ydFNpZ25hbCA9IHRpbWVvdXRDb250cm9sbGVyLnNpZ25hbDtcclxuICBjb25zdCBleHRlcm5hbFNpZ25hbCA9IG9wdGlvbnMuc2lnbmFsO1xyXG5cclxuICBpZiAoZXh0ZXJuYWxTaWduYWwpIHtcclxuICAgIGNvbnN0IGNvbWJpbmVkQ29udHJvbGxlciA9IG5ldyBBYm9ydENvbnRyb2xsZXIoKTtcclxuXHJcbiAgICBpZiAoZXh0ZXJuYWxTaWduYWwuYWJvcnRlZCkge1xyXG4gICAgICBjb21iaW5lZENvbnRyb2xsZXIuYWJvcnQoKTtcclxuICAgIH0gZWxzZSB7XHJcbiAgICAgIGV4dGVybmFsU2lnbmFsLmFkZEV2ZW50TGlzdGVuZXIoXCJhYm9ydFwiLCAoKSA9PiBjb21iaW5lZENvbnRyb2xsZXIuYWJvcnQoKSk7XHJcbiAgICB9XHJcblxyXG4gICAgdGltZW91dENvbnRyb2xsZXIuc2lnbmFsLmFkZEV2ZW50TGlzdGVuZXIoXCJhYm9ydFwiLCAoKSA9PiBjb21iaW5lZENvbnRyb2xsZXIuYWJvcnQoKSk7XHJcbiAgICBjb21iaW5lZFNpZ25hbCA9IGNvbWJpbmVkQ29udHJvbGxlci5zaWduYWw7XHJcbiAgfVxyXG5cclxuICBjb25zdCB7IHNpZ25hbDogXywgLi4ub3B0aW9uc1dpdGhvdXRTaWduYWwgfSA9IG9wdGlvbnM7XHJcblxyXG4gIHJldHVybiBmZXRjaCh1cmwsIHtcclxuICAgIC4uLm9wdGlvbnNXaXRob3V0U2lnbmFsLFxyXG4gICAgc2lnbmFsOiBjb21iaW5lZFNpZ25hbCxcclxuICB9KS5maW5hbGx5KCgpID0+IGNsZWFyVGltZW91dCh0aW1lb3V0SWQpKTtcclxufVxyXG5cclxuLy8gPT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT1cclxuLy8gRmV0Y2ggd2l0aCBSZXRyeVxyXG4vLyA9PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PVxyXG5cclxuZXhwb3J0IGFzeW5jIGZ1bmN0aW9uIGZldGNoV2l0aFJldHJ5KFxyXG4gIHVybDogc3RyaW5nLFxyXG4gIG9wdGlvbnM6IEZldGNoT3B0aW9uc1dpdGhTaWduYWwsXHJcbiAgbWF4UmV0cmllczogbnVtYmVyID0gMixcclxuICB0aW1lb3V0OiBudW1iZXIgPSAzMDAwMFxyXG4pOiBQcm9taXNlPFJlc3BvbnNlPiB7XHJcbiAgbGV0IGxhc3RFcnJvcjogRXJyb3IgfCB1bmRlZmluZWQ7XHJcblxyXG4gIGZvciAobGV0IGF0dGVtcHQgPSAxOyBhdHRlbXB0IDw9IG1heFJldHJpZXMgKyAxOyBhdHRlbXB0KyspIHtcclxuICAgIHRyeSB7XHJcbiAgICAgIHJldHVybiBhd2FpdCBmZXRjaFdpdGhUaW1lb3V0KHVybCwgb3B0aW9ucywgdGltZW91dCk7XHJcbiAgICB9IGNhdGNoIChlcnJvcikge1xyXG4gICAgICBsYXN0RXJyb3IgPSBlcnJvciBhcyBFcnJvcjtcclxuICAgICAgaWYgKChlcnJvciBhcyBFcnJvcikubmFtZSA9PT0gXCJBYm9ydEVycm9yXCIpIHtcclxuICAgICAgICBjb25zb2xlLndhcm4oYFtTdHVkeSBBc3Npc3RdIFJlcXVlc3QgdGltZW91dCAoYXR0ZW1wdCAke2F0dGVtcHR9LyR7bWF4UmV0cmllcyArIDF9KWApO1xyXG4gICAgICB9IGVsc2Uge1xyXG4gICAgICAgIGNvbnNvbGUud2FybihgW1N0dWR5IEFzc2lzdF0gUmVxdWVzdCBmYWlsZWQgKGF0dGVtcHQgJHthdHRlbXB0fS8ke21heFJldHJpZXMgKyAxfSk6YCwgKGVycm9yIGFzIEVycm9yKS5tZXNzYWdlKTtcclxuICAgICAgfVxyXG5cclxuICAgICAgaWYgKGF0dGVtcHQgPD0gbWF4UmV0cmllcykge1xyXG4gICAgICAgIGF3YWl0IG5ldyBQcm9taXNlKChyKSA9PiBzZXRUaW1lb3V0KHIsIDEwMDAgKiBhdHRlbXB0KSk7XHJcbiAgICAgIH1cclxuICAgIH1cclxuICB9XHJcblxyXG4gIHRocm93IGxhc3RFcnJvcjtcclxufVxyXG4iLCAiLyoqXHJcbiAqIEJhY2tncm91bmQgU2VydmljZSBXb3JrZXIgLSBRdWVzdGlvbnMgQmFua1xyXG4gKiBIYW5kbGVzIGxvYWRpbmcsIHNlYXJjaGluZywgYW5kIG1hdGNoaW5nIHF1ZXN0aW9ucyBmcm9tIHRoZSBiYW5rXHJcbiAqL1xyXG5cclxuaW1wb3J0IHsgbG9nLCBxdWVzdGlvbnNCYW5rLCBzZXRRdWVzdGlvbnNCYW5rIH0gZnJvbSBcIi4vY29uc3RhbnRzLmpzXCI7XHJcbmltcG9ydCB0eXBlIHsgUXVlc3Rpb25zQmFuaywgTWF0Y2hlZFF1ZXN0aW9uIH0gZnJvbSBcIi4vY29uc3RhbnRzLmpzXCI7XHJcblxyXG4vLyA9PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PVxyXG4vLyBRdWVzdGlvbnMgQmFuayBMb2FkaW5nXHJcbi8vID09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09XHJcblxyXG5leHBvcnQgYXN5bmMgZnVuY3Rpb24gbG9hZFF1ZXN0aW9uc0JhbmsoKTogUHJvbWlzZTxRdWVzdGlvbnNCYW5rIHwgbnVsbD4ge1xyXG4gIGlmIChxdWVzdGlvbnNCYW5rKSByZXR1cm4gcXVlc3Rpb25zQmFuaztcclxuXHJcbiAgdHJ5IHtcclxuICAgIGNvbnN0IHVybCA9IGNocm9tZS5ydW50aW1lLmdldFVSTChcImRhdGEvcXVlc3Rpb25zLWJhbmsuanNvblwiKTtcclxuICAgIGNvbnN0IHJlc3BvbnNlID0gYXdhaXQgZmV0Y2godXJsKTtcclxuICAgIGNvbnN0IGJhbmsgPSBhd2FpdCByZXNwb25zZS5qc29uKCkgYXMgUXVlc3Rpb25zQmFuaztcclxuICAgIHNldFF1ZXN0aW9uc0JhbmsoYmFuayk7XHJcbiAgICBsb2coXHJcbiAgICAgIFwiW1N0dWR5IEFzc2lzdF0gUXVlc3Rpb25zIGJhbmsgbG9hZGVkOlwiLFxyXG4gICAgICBPYmplY3Qua2V5cyhiYW5rLm1vZHVsZXMpLmxlbmd0aCxcclxuICAgICAgXCJtb2R1bGVzXCIsXHJcbiAgICApO1xyXG4gICAgcmV0dXJuIGJhbms7XHJcbiAgfSBjYXRjaCAoZXJyb3IpIHtcclxuICAgIGNvbnNvbGUuZXJyb3IoXCJbU3R1ZHkgQXNzaXN0XSBGYWlsZWQgdG8gbG9hZCBxdWVzdGlvbnMgYmFuazpcIiwgZXJyb3IpO1xyXG4gICAgcmV0dXJuIG51bGw7XHJcbiAgfVxyXG59XHJcblxyXG4vLyA9PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PVxyXG4vLyBUZXh0IE5vcm1hbGl6YXRpb24gJiBTaW1pbGFyaXR5XHJcbi8vID09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09XHJcblxyXG4vKipcclxuICogTm9ybWFsaXplIHRleHQgZm9yIGNvbXBhcmlzb24gKHJlbW92ZSBhY2NlbnRzLCBsb3dlcmNhc2UsIHJlbW92ZSBwdW5jdHVhdGlvbilcclxuICovXHJcbmV4cG9ydCBmdW5jdGlvbiBub3JtYWxpemVGb3JTZWFyY2godGV4dDogc3RyaW5nKTogc3RyaW5nIHtcclxuICByZXR1cm4gdGV4dFxyXG4gICAgLnRvTG93ZXJDYXNlKClcclxuICAgIC5ub3JtYWxpemUoXCJORkRcIilcclxuICAgIC5yZXBsYWNlKC9bXFx1MDMwMC1cXHUwMzZmXS9nLCBcIlwiKSAvLyBEaWFjcml0aWNzXHJcbiAgICAucmVwbGFjZSgvW1xcdTIwMEItXFx1MjAwRFxcdUZFRkZdL2csIFwiXCIpIC8vIFplcm8td2lkdGggc3BhY2VzXHJcbiAgICAucmVwbGFjZSgvJm5ic3A7L2csIFwiIFwiKSAvLyBIVE1MIG5vbi1icmVha2luZyBzcGFjZXNcclxuICAgIC5yZXBsYWNlKC9bXHUwMEJGP1x1MDBBMSEuLDs6KClcIlxcLV0vZywgXCJcIikgLy8gUHVuY3R1YXRpb25cclxuICAgIC5yZXBsYWNlKC9cXC8vZywgXCJcIikgLy8gU2xhc2hlcyAoZm9yIGludGVyZmFjZSBuYW1lcyBsaWtlIDAvMSlcclxuICAgIC5yZXBsYWNlKC9cXHMrL2csIFwiIFwiKSAvLyBNdWx0aXBsZSBzcGFjZXMgdG8gc2luZ2xlXHJcbiAgICAudHJpbSgpO1xyXG59XHJcblxyXG4vKipcclxuICogQ2FsY3VsYXRlIHNpbWlsYXJpdHkgYmV0d2VlbiB0d28gbm9ybWFsaXplZCB0ZXh0cyAod29yZCBvdmVybGFwKVxyXG4gKi9cclxuZXhwb3J0IGZ1bmN0aW9uIGNhbGN1bGF0ZVNpbWlsYXJpdHkodGV4dDE6IHN0cmluZywgdGV4dDI6IHN0cmluZyk6IG51bWJlciB7XHJcbiAgY29uc3Qgd29yZHMxID0gbmV3IFNldCh0ZXh0MS5zcGxpdChcIiBcIikuZmlsdGVyKCh3KSA9PiB3Lmxlbmd0aCA+IDIpKTtcclxuICBjb25zdCB3b3JkczIgPSBuZXcgU2V0KHRleHQyLnNwbGl0KFwiIFwiKS5maWx0ZXIoKHcpID0+IHcubGVuZ3RoID4gMikpO1xyXG5cclxuICBpZiAod29yZHMxLnNpemUgPT09IDAgfHwgd29yZHMyLnNpemUgPT09IDApIHJldHVybiAwO1xyXG5cclxuICBsZXQgbWF0Y2hlcyA9IDA7XHJcbiAgZm9yIChjb25zdCB3b3JkIG9mIHdvcmRzMSkge1xyXG4gICAgaWYgKHdvcmRzMi5oYXMod29yZCkpIG1hdGNoZXMrKztcclxuICB9XHJcblxyXG4gIHJldHVybiBtYXRjaGVzIC8gTWF0aC5tYXgod29yZHMxLnNpemUsIHdvcmRzMi5zaXplKTtcclxufVxyXG5cclxuLyoqXHJcbiAqIENhbGN1bGF0ZSBjb250YWlubWVudDogd2hhdCAlIG9mIHRoZSBTTUFMTEVSIHRleHQncyB3b3JkcyBhcHBlYXIgaW4gdGhlIExBUkdFUiB0ZXh0LlxyXG4gKiBUaGlzIGhhbmRsZXMgdGhlIGNhc2Ugd2hlcmUgdGhlIHBhZ2UgaW5jbHVkZXMgZXh0cmEgY29udGV4dCAocm91dGluZyB0YWJsZXMsIGNvZGUsIGV0Yy4pXHJcbiAqIGJlZm9yZSB0aGUgYWN0dWFsIHF1ZXN0aW9uLiBFdmVuIHdpdGggMjAwIGV4dHJhIHdvcmRzLCBpZiBhbGwgMTUgYmFuay1xdWVzdGlvbiB3b3Jkc1xyXG4gKiBhcmUgcHJlc2VudCBpbiB0aGUgcGFnZSB0ZXh0LCBjb250YWlubWVudCA9IDE1LzE1ID0gMTAwJS5cclxuICovXHJcbmV4cG9ydCBmdW5jdGlvbiBjYWxjdWxhdGVDb250YWlubWVudCh0ZXh0MTogc3RyaW5nLCB0ZXh0Mjogc3RyaW5nKTogbnVtYmVyIHtcclxuICBjb25zdCB3b3JkczEgPSBuZXcgU2V0KHRleHQxLnNwbGl0KFwiIFwiKS5maWx0ZXIoKHcpID0+IHcubGVuZ3RoID4gMikpO1xyXG4gIGNvbnN0IHdvcmRzMiA9IG5ldyBTZXQodGV4dDIuc3BsaXQoXCIgXCIpLmZpbHRlcigodykgPT4gdy5sZW5ndGggPiAyKSk7XHJcblxyXG4gIGlmICh3b3JkczEuc2l6ZSA9PT0gMCB8fCB3b3JkczIuc2l6ZSA9PT0gMCkgcmV0dXJuIDA7XHJcblxyXG4gIC8vIERldGVybWluZSB3aGljaCBpcyB0aGUgc21hbGxlciBzZXQgKGxpa2VseSB0aGUgYmFuayBxdWVzdGlvbilcclxuICBjb25zdCBbc21hbGxlciwgbGFyZ2VyXSA9IHdvcmRzMS5zaXplIDw9IHdvcmRzMi5zaXplXHJcbiAgICA/IFt3b3JkczEsIHdvcmRzMl1cclxuICAgIDogW3dvcmRzMiwgd29yZHMxXTtcclxuXHJcbiAgbGV0IG1hdGNoZXMgPSAwO1xyXG4gIGZvciAoY29uc3Qgd29yZCBvZiBzbWFsbGVyKSB7XHJcbiAgICBpZiAobGFyZ2VyLmhhcyh3b3JkKSkgbWF0Y2hlcysrO1xyXG4gIH1cclxuXHJcbiAgLy8gUmVxdWlyZSB0aGUgc21hbGxlciB0ZXh0IHRvIGhhdmUgYSBtaW5pbXVtIG51bWJlciBvZiBtZWFuaW5nZnVsIHdvcmRzXHJcbiAgLy8gdG8gYXZvaWQgZmFsc2UgcG9zaXRpdmVzIHdpdGggdmVyeSBzaG9ydCBxdWVzdGlvbnNcclxuICBpZiAoc21hbGxlci5zaXplIDwgNCkgcmV0dXJuIDA7XHJcblxyXG4gIHJldHVybiBtYXRjaGVzIC8gc21hbGxlci5zaXplO1xyXG59XHJcblxyXG4vKipcclxuICogQ2hlY2sgaWYgdGhlIHBhZ2UgaXMgYSBOZXRBY2FkL0Npc2NvIHBhZ2UgYmFzZWQgb24gdGl0bGUgb3IgVVJMXHJcbiAqL1xyXG5leHBvcnQgZnVuY3Rpb24gaXNOZXRBY2FkUGFnZShwYWdlVGl0bGU6IHN0cmluZyB8IHVuZGVmaW5lZCwgcGFnZVVybDogc3RyaW5nIHwgdW5kZWZpbmVkKTogYm9vbGVhbiB7XHJcbiAgY29uc3QgdGl0bGVPclVybCA9IChwYWdlVGl0bGUgfHwgXCJcIikgKyBcIiBcIiArIChwYWdlVXJsIHx8IFwiXCIpO1xyXG4gIHJldHVybiAvbmV0YWNhZHxjaXNjb3xjY25hfGNjbnB8bmV0d29ya2luZ1xccyphY2FkZW15fHNraWxsc1xccypmb3JcXHMqYWxsL2kudGVzdChcclxuICAgIHRpdGxlT3JVcmwsXHJcbiAgKTtcclxufVxyXG5cclxuLy8gPT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT1cclxuLy8gUXVlc3Rpb24gTWF0Y2hpbmdcclxuLy8gPT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT1cclxuXHJcbi8qKlxyXG4gKiBGaW5kIG1hdGNoaW5nIHF1ZXN0aW9uIGluIHRoZSBiYW5rIChPTkxZIGZvciBOZXRBY2FkIHBhZ2VzKVxyXG4gKi9cclxuZXhwb3J0IGFzeW5jIGZ1bmN0aW9uIGZpbmRNYXRjaGluZ1F1ZXN0aW9uKFxyXG4gIHF1ZXN0aW9uVGV4dDogc3RyaW5nLFxyXG4gIG1vZHVsZUluZm86IHN0cmluZyB8IHVuZGVmaW5lZCxcclxuICBwYWdlVXJsOiBzdHJpbmcgfCB1bmRlZmluZWRcclxuKTogUHJvbWlzZTxNYXRjaGVkUXVlc3Rpb24gfCBudWxsPiB7XHJcbiAgaWYgKCFpc05ldEFjYWRQYWdlKG1vZHVsZUluZm8sIHBhZ2VVcmwpKSB7XHJcbiAgICBsb2coXCJbU3R1ZHkgQXNzaXN0XSBRdWVzdGlvbiBiYW5rOiBTa2lwcGVkIChub3QgYSBOZXRBY2FkIHBhZ2UpXCIpO1xyXG4gICAgcmV0dXJuIG51bGw7XHJcbiAgfVxyXG5cclxuICBsb2coXCJbU3R1ZHkgQXNzaXN0XSBRdWVzdGlvbiBiYW5rOiBTZWFyY2hpbmcuLi5cIik7XHJcblxyXG4gIGNvbnN0IGJhbmsgPSBhd2FpdCBsb2FkUXVlc3Rpb25zQmFuaygpO1xyXG4gIGlmICghYmFuaykgcmV0dXJuIG51bGw7XHJcblxyXG4gIGNvbnN0IG5vcm1hbGl6ZWRRdWVzdGlvbiA9IG5vcm1hbGl6ZUZvclNlYXJjaChxdWVzdGlvblRleHQpO1xyXG5cclxuICBsZXQgbW9kdWxlc1RvU2VhcmNoOiBzdHJpbmdbXSA9IFtdO1xyXG5cclxuICBpZiAobW9kdWxlSW5mbykge1xyXG4gICAgY29uc3QgbW9kdWxlTWF0Y2ggPSBtb2R1bGVJbmZvLm1hdGNoKC8oXFxkKylbXFwuXFwtXT8oXFxkKyk/Lyk7XHJcbiAgICBpZiAobW9kdWxlTWF0Y2gpIHtcclxuICAgICAgY29uc3QgbW9kdWxlTnVtID0gcGFyc2VJbnQobW9kdWxlTWF0Y2hbMV0pO1xyXG5cclxuICAgICAgaWYgKG1vZHVsZU51bSA+PSAxICYmIG1vZHVsZU51bSA8PSA0KSB7XHJcbiAgICAgICAgbW9kdWxlc1RvU2VhcmNoLnB1c2goXCIxLTRcIiwgYG1vZC0ke21vZHVsZU51bX1gKTtcclxuICAgICAgfSBlbHNlIGlmIChtb2R1bGVOdW0gPj0gNSAmJiBtb2R1bGVOdW0gPD0gNikge1xyXG4gICAgICAgIG1vZHVsZXNUb1NlYXJjaC5wdXNoKFwiNS02XCIsIGBtb2QtJHttb2R1bGVOdW19YCk7XHJcbiAgICAgIH0gZWxzZSBpZiAobW9kdWxlTnVtID49IDcgJiYgbW9kdWxlTnVtIDw9IDkpIHtcclxuICAgICAgICBtb2R1bGVzVG9TZWFyY2gucHVzaChcIjctOVwiLCBgbW9kLSR7bW9kdWxlTnVtfWApO1xyXG4gICAgICB9IGVsc2UgaWYgKG1vZHVsZU51bSA+PSAxMCAmJiBtb2R1bGVOdW0gPD0gMTMpIHtcclxuICAgICAgICBtb2R1bGVzVG9TZWFyY2gucHVzaChcIjEwLTEzXCIsIGBtb2QtJHttb2R1bGVOdW19YCk7XHJcbiAgICAgIH0gZWxzZSBpZiAobW9kdWxlTnVtID49IDE0ICYmIG1vZHVsZU51bSA8PSAxNikge1xyXG4gICAgICAgIG1vZHVsZXNUb1NlYXJjaC5wdXNoKFwiMTQtMTZcIiwgYG1vZC0ke21vZHVsZU51bX1gKTtcclxuICAgICAgfVxyXG4gICAgfVxyXG5cclxuICAgIGlmICgvZmluYWx8cHRzYXxoYWJpbGlkYWRlc3xwclx1MDBFMWN0aWNhL2kudGVzdChtb2R1bGVJbmZvKSkge1xyXG4gICAgICBtb2R1bGVzVG9TZWFyY2gucHVzaChcclxuICAgICAgICBcImZpbmFsLXByYWN0aWNlXCIsIFwiZmluYWwtc2tpbGxzXCIsIFwiZmluYWwtZXhhbVwiLCBcInB0c2EtMVwiLCBcInB0c2EtMlwiXHJcbiAgICAgICk7XHJcbiAgICB9XHJcbiAgfVxyXG5cclxuICBpZiAobW9kdWxlc1RvU2VhcmNoLmxlbmd0aCA9PT0gMCkge1xyXG4gICAgbW9kdWxlc1RvU2VhcmNoID0gT2JqZWN0LmtleXMoYmFuay5tb2R1bGVzKTtcclxuICB9XHJcblxyXG4gIGxldCBiZXN0TWF0Y2g6IE1hdGNoZWRRdWVzdGlvbiB8IG51bGwgPSBudWxsO1xyXG4gIGxldCBiZXN0U2ltaWxhcml0eSA9IDA7XHJcbiAgXHJcbiAgLy8gVXNlIGxvd2VyIHRocmVzaG9sZCBmb3IgbG9uZyB0ZXh0cyAocm91dGluZyB0YWJsZXMsIGNvbW1hbmQgb3V0cHV0cylcclxuICAvLyBUaGVzZSBvZnRlbiBoYXZlIGlkZW50aWNhbCBjb250ZW50IGJ1dCBkaWZmZXJlbnQgdGV4dCBvcmRlciAodGFibGUtZmlyc3QgdnMgcXVlc3Rpb24tZmlyc3QpXHJcbiAgY29uc3QgaXNMb25nVGV4dCA9IHF1ZXN0aW9uVGV4dC5sZW5ndGggPiA4MDA7XHJcbiAgY29uc3QgU0lNSUxBUklUWV9USFJFU0hPTEQgPSBpc0xvbmdUZXh0ID8gMC41NSA6IDAuNjtcclxuXHJcbiAgZm9yIChjb25zdCBtb2R1bGVSYW5nZSBvZiBtb2R1bGVzVG9TZWFyY2gpIHtcclxuICAgIGNvbnN0IG1vZHVsZSA9IGJhbmsubW9kdWxlc1ttb2R1bGVSYW5nZV07XHJcbiAgICBpZiAoIW1vZHVsZSB8fCAhbW9kdWxlLnF1ZXN0aW9ucykgY29udGludWU7XHJcblxyXG4gICAgZm9yIChjb25zdCBxdWVzdGlvbiBvZiBtb2R1bGUucXVlc3Rpb25zKSB7XHJcbiAgICAgIGxldCBzaW1pbGFyaXR5OiBudW1iZXI7XHJcbiAgICAgIFxyXG4gICAgICAvLyBTcGVjaWFsIGNhc2U6IHJvdXRpbmcgdGFibGVzIHdpdGggUEFSVElBTFVSTFBMQUNFSE9MREVSXHJcbiAgICAgIC8vIFRoZXNlIGNvbnRhaW4gdGhlIHNhbWUgY29udGVudCBidXQgbm9ybWFsaXphdGlvbiBkZXN0cm95cyBJUCBhZGRyZXNzZXMgKDEwLjM4LjYwLjI2IFx1MjE5MiAxMDM4NjAyNilcclxuICAgICAgLy8gSWYgYm90aCB0ZXh0cyBjb250YWluIHRoaXMgcGxhY2Vob2xkZXIsIGdpdmUgaGlnaCBzaW1pbGFyaXR5IGF1dG9tYXRpY2FsbHlcclxuICAgICAgY29uc3QgcGFnZUhhc1BsYWNlaG9sZGVyID0gcXVlc3Rpb25UZXh0LnRvTG93ZXJDYXNlKCkuaW5jbHVkZXMoXCJwYXJ0aWFsdXJscGxhY2Vob2xkZXJcIik7XHJcbiAgICAgIGNvbnN0IGJhbmtIYXNQbGFjZWhvbGRlciA9IHF1ZXN0aW9uLnRleHQudG9Mb3dlckNhc2UoKS5pbmNsdWRlcyhcInBhcnRpYWx1cmxwbGFjZWhvbGRlclwiKTtcclxuICAgICAgXHJcbiAgICAgIGlmIChwYWdlSGFzUGxhY2Vob2xkZXIgJiYgYmFua0hhc1BsYWNlaG9sZGVyKSB7XHJcbiAgICAgICAgLy8gQm90aCBoYXZlIHJvdXRpbmcgdGFibGUgaW1hZ2VzIC0gbGlrZWx5IHRoZSBzYW1lIHF1ZXN0aW9uXHJcbiAgICAgICAgc2ltaWxhcml0eSA9IDAuOTU7XHJcbiAgICAgIH0gZWxzZSB7XHJcbiAgICAgICAgLy8gVXNlIHRoZSBNQVggb2Ygc3RhbmRhcmQgc2ltaWxhcml0eSBhbmQgY29udGFpbm1lbnQuXHJcbiAgICAgICAgLy8gU3RhbmRhcmQgc2ltaWxhcml0eSB3b3JrcyB3aGVuIHRleHRzIGFyZSBzaW1pbGFyIGxlbmd0aC5cclxuICAgICAgICAvLyBDb250YWlubWVudCB3b3JrcyB3aGVuIHRoZSBwYWdlIGhhcyBleHRyYSBjb250ZXh0ICh0YWJsZXMsIGNvZGUpXHJcbiAgICAgICAgLy8gYXJvdW5kIHRoZSBhY3R1YWwgcXVlc3Rpb24uXHJcbiAgICAgICAgY29uc3Qgc3RkU2ltaWxhcml0eSA9IGNhbGN1bGF0ZVNpbWlsYXJpdHkobm9ybWFsaXplZFF1ZXN0aW9uLCBxdWVzdGlvbi50ZXh0Tm9ybWFsaXplZCk7XHJcbiAgICAgICAgY29uc3QgY29udGFpbm1lbnQgPSBjYWxjdWxhdGVDb250YWlubWVudChub3JtYWxpemVkUXVlc3Rpb24sIHF1ZXN0aW9uLnRleHROb3JtYWxpemVkKTtcclxuICAgICAgICBzaW1pbGFyaXR5ID0gTWF0aC5tYXgoc3RkU2ltaWxhcml0eSwgY29udGFpbm1lbnQpO1xyXG4gICAgICB9XHJcblxyXG4gICAgICBpZiAoc2ltaWxhcml0eSA+IGJlc3RTaW1pbGFyaXR5ICYmIHNpbWlsYXJpdHkgPj0gU0lNSUxBUklUWV9USFJFU0hPTEQpIHtcclxuICAgICAgICBiZXN0U2ltaWxhcml0eSA9IHNpbWlsYXJpdHk7XHJcbiAgICAgICAgYmVzdE1hdGNoID0ge1xyXG4gICAgICAgICAgLi4ucXVlc3Rpb24sXHJcbiAgICAgICAgICBtb2R1bGVSYW5nZSxcclxuICAgICAgICAgIHNpbWlsYXJpdHk6IE1hdGgucm91bmQoc2ltaWxhcml0eSAqIDEwMCksXHJcbiAgICAgICAgfTtcclxuICAgICAgfVxyXG4gICAgfVxyXG4gIH1cclxuXHJcbiAgaWYgKGJlc3RNYXRjaCkge1xyXG4gICAgbG9nKGBbU3R1ZHkgQXNzaXN0XSBRVUVTVElPTiBCQU5LIE1BVENIICgke2Jlc3RNYXRjaC5zaW1pbGFyaXR5fSUgc2ltaWxhcml0eSkgZnJvbSBtb2R1bGUgJHtiZXN0TWF0Y2gubW9kdWxlUmFuZ2V9OmApO1xyXG4gICAgbG9nKGBbU3R1ZHkgQXNzaXN0XSBCYW5rIFE6IFwiJHtiZXN0TWF0Y2gudGV4dC5zdWJzdHJpbmcoMCwgODApfS4uLlwiYCk7XHJcbiAgICBsb2coYFtTdHVkeSBBc3Npc3RdIFBhZ2UgdGV4dCBsZW5ndGg6ICR7cXVlc3Rpb25UZXh0Lmxlbmd0aH0gY2hhcnNgKTtcclxuICAgIGxvZyhgW1N0dWR5IEFzc2lzdF0gQmFuayB0ZXh0IGxlbmd0aDogJHtiZXN0TWF0Y2gudGV4dC5sZW5ndGh9IGNoYXJzYCk7XHJcbiAgICBsb2coYFtTdHVkeSBBc3Npc3RdIFBhZ2Ugbm9ybWFsaXplZDogXCIke25vcm1hbGl6ZWRRdWVzdGlvbi5zdWJzdHJpbmcoMCwgMTAwKX0uLi5cImApO1xyXG4gICAgbG9nKGBbU3R1ZHkgQXNzaXN0XSBCYW5rIG5vcm1hbGl6ZWQ6IFwiJHtiZXN0TWF0Y2gudGV4dE5vcm1hbGl6ZWQuc3Vic3RyaW5nKDAsIDEwMCl9Li4uXCJgKTtcclxuICAgIGxvZyhgW1N0dWR5IEFzc2lzdF0gRXhwbGFuYXRpb246IFwiJHtiZXN0TWF0Y2guZXhwbGFuYXRpb24gPyBiZXN0TWF0Y2guZXhwbGFuYXRpb24uc3Vic3RyaW5nKDAsIDEwMCkgKyBcIi4uLlwiIDogXCJOL0FcIn1cImApO1xyXG4gIH0gZWxzZSB7XHJcbiAgICBsb2coXCJbU3R1ZHkgQXNzaXN0XSBObyBtYXRjaCBpbiBxdWVzdGlvbiBiYW5rXCIpO1xyXG4gIH1cclxuXHJcbiAgcmV0dXJuIGJlc3RNYXRjaDtcclxufVxyXG4iLCAiLyoqXHJcbiAqIEJhY2tncm91bmQgU2VydmljZSBXb3JrZXIgLSBQcm9tcHQgQnVpbGRpbmdcclxuICogQ29uc3RydWN0cyBwcm9tcHRzIGZvciBDbGF1ZGUgYW5kIERlZXBTZWVrIEFQSXNcclxuICovXHJcblxyXG5pbXBvcnQgdHlwZSB7IEFuYWx5c2lzQ29udGV4dCwgSW1hZ2VEYXRhIH0gZnJvbSBcIi4uLy4uL3R5cGVzL2luZGV4LmpzXCI7XHJcbmltcG9ydCB0eXBlIHtcclxuICBNYXRjaGVkUXVlc3Rpb24sXHJcbiAgTnVtYmVyV29yZE1hcCxcclxuICBEZWVwU2Vla0FuYWx5c2lzRm9yQ2xhdWRlLFxyXG4gIENsYXVkZUNvbnRlbnRCbG9jayxcclxufSBmcm9tIFwiLi9jb25zdGFudHMuanNcIjtcclxuXHJcbi8vID09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09XHJcbi8vIFNoYXJlZCBIZWxwZXJzXHJcbi8vID09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09XHJcblxyXG5leHBvcnQgZnVuY3Rpb24gZm9ybWF0UXVlc3Rpb25UeXBlKHR5cGU6IHN0cmluZyB8IHVuZGVmaW5lZCk6IHN0cmluZyB7XHJcbiAgY29uc3QgdHlwZXM6IHsgW2tleTogc3RyaW5nXTogc3RyaW5nIH0gPSB7XHJcbiAgICBcIm11bHRpcGxlLWNob2ljZVwiOiBcIk11bHRpcGxlIENob2ljZVwiLFxyXG4gICAgXCJ0cnVlLWZhbHNlXCI6IFwiVHJ1ZS9GYWxzZVwiLFxyXG4gICAgXCJmaWxsLWJsYW5rXCI6IFwiRmlsbCBpbiB0aGUgQmxhbmtcIixcclxuICAgIG1hdGNoaW5nOiBcIk1hdGNoaW5nXCIsXHJcbiAgICBcInNob3J0LWFuc3dlclwiOiBcIlNob3J0IEFuc3dlclwiLFxyXG4gICAgbnVtZXJpY2FsOiBcIk51bWVyaWNhbFwiLFxyXG4gICAgXCJzZWxlY3QtbWlzc2luZy13b3Jkc1wiOiBcIlNlbGVjdCBNaXNzaW5nIFdvcmRzXCIsXHJcbiAgICB1bmtub3duOiBcIkdlbmVyYWwgUXVlc3Rpb25cIixcclxuICB9O1xyXG4gIHJldHVybiB0eXBlc1t0eXBlIHx8IFwidW5rbm93blwiXSB8fCB0eXBlc1tcInVua25vd25cIl07XHJcbn1cclxuXHJcbi8qKiBDb21tb24gbnVtYmVyLXdvcmQgbWFwIGZvciBleHRyYWN0aW5nIGFuc3dlciBjb3VudHMgKi9cclxuZXhwb3J0IGNvbnN0IE5VTUJFUl9XT1JEX01BUDogTnVtYmVyV29yZE1hcCA9IHtcclxuICBkb3M6IDIsIHR3bzogMiwgMjogMixcclxuICB0cmVzOiAzLCB0aHJlZTogMywgMzogMyxcclxuICBjdWF0cm86IDQsIGZvdXI6IDQsIDQ6IDQsXHJcbiAgY2luY286IDUsIGZpdmU6IDUsIDU6IDUsXHJcbn07XHJcblxyXG4vKiogUGF0dGVybnMgZm9yIGRldGVjdGluZyByZXF1aXJlZCBhbnN3ZXIgY291bnQgKi9cclxuZXhwb3J0IGNvbnN0IENPVU5UX1BBVFRFUk5TOiBSZWdFeHBbXSA9IFtcclxuICAvZWxpamFcXHMqKGRvc3x0cmVzfGN1YXRyb3xjaW5jb3wyfDN8NHw1KS9pLFxyXG4gIC9lc2NvamFcXHMqKGRvc3x0cmVzfGN1YXRyb3xjaW5jb3wyfDN8NHw1KS9pLFxyXG4gIC9zZWxlY2Npb25lXFxzKihkb3N8dHJlc3xjdWF0cm98Y2luY298MnwzfDR8NSkvaSxcclxuICAvc2VsZWN0XFxzKih0d298dGhyZWV8Zm91cnxmaXZlfDJ8M3w0fDUpL2ksXHJcbiAgL2Nob29zZVxccyoodHdvfHRocmVlfGZvdXJ8Zml2ZXwyfDN8NHw1KS9pLFxyXG4gIC9cXChcXHMqKGRvc3x0cmVzfGN1YXRyb3x0d298dGhyZWV8Zm91cnwyfDN8NHw1KVxccypvcGNpb25lcz9cXHMqXFwpL2ksXHJcbl07XHJcblxyXG4vKipcclxuICogRXh0cmFjdCByZXF1aXJlZCBudW1iZXIgb2YgYW5zd2VycyBmcm9tIHF1ZXN0aW9uIHRleHRcclxuICovXHJcbmV4cG9ydCBmdW5jdGlvbiBleHRyYWN0UmVxdWlyZWRBbnN3ZXJzKHF1ZXN0aW9uVGV4dDogc3RyaW5nKTogbnVtYmVyIHtcclxuICBmb3IgKGNvbnN0IHBhdHRlcm4gb2YgQ09VTlRfUEFUVEVSTlMpIHtcclxuICAgIGNvbnN0IG1hdGNoID0gcXVlc3Rpb25UZXh0Lm1hdGNoKHBhdHRlcm4pO1xyXG4gICAgaWYgKG1hdGNoICYmIG1hdGNoWzFdKSB7XHJcbiAgICAgIGNvbnN0IG51bSA9IE5VTUJFUl9XT1JEX01BUFttYXRjaFsxXS50b0xvd2VyQ2FzZSgpXTtcclxuICAgICAgaWYgKG51bSkgcmV0dXJuIG51bTtcclxuICAgIH1cclxuICB9XHJcbiAgcmV0dXJuIDE7XHJcbn1cclxuXHJcbi8qKlxyXG4gKiBEZXRlY3QgaWYgcGFnZSBpcyBOZXRBY2FkL0Npc2NvXHJcbiAqL1xyXG5mdW5jdGlvbiBnZXRFeHBlcnRDb250ZXh0KHBhZ2VUaXRsZTogc3RyaW5nIHwgdW5kZWZpbmVkKTogeyBpc05ldEFjYWQ6IGJvb2xlYW47IGV4cGVydENvbnRleHQ6IHN0cmluZyB9IHtcclxuICBjb25zdCBpc05ldEFjYWQgPSAvbmV0YWNhZHxjaXNjb3xjY25hfGNjbnB8bmV0d29ya2luZyBhY2FkZW15fHNraWxsc1xccypmb3JcXHMqYWxsL2kudGVzdChwYWdlVGl0bGUgfHwgXCJcIik7XHJcblxyXG4gIGNvbnN0IGV4cGVydENvbnRleHQgPSBpc05ldEFjYWRcclxuICAgID8gYFlvdSBhcmUgYSBDQ05BL0NDTlAgY2VydGlmaWVkIG5ldHdvcmtpbmcgZXhwZXJ0IHdpdGggZGVlcCBrbm93bGVkZ2Ugb2Y6XHJcbi0gQ2lzY28gSU9TIGNvbW1hbmRzIGFuZCBjb25maWd1cmF0aW9uc1xyXG4tIFJvdXRpbmcgcHJvdG9jb2xzIChPU1BGLCBFSUdSUCwgQkdQLCBSSVApXHJcbi0gU3dpdGNoaW5nIGNvbmNlcHRzIChWTEFOcywgU1RQLCBFdGhlckNoYW5uZWwsIHRydW5raW5nKVxyXG4tIE5ldHdvcmsgc2VjdXJpdHkgKEFDTHMsIE5BVCwgZmlyZXdhbGxzLCBWUE5zKVxyXG4tIFN1Ym5ldHRpbmcgYW5kIElQIGFkZHJlc3NpbmcgKElQdjQvSVB2NilcclxuLSBOZXR3b3JrIHNlcnZpY2VzIChESENQLCBETlMsIE5UUCwgU05NUClcclxuLSBXaXJlbGVzcyBuZXR3b3JraW5nXHJcbi0gTmV0d29yayBhdXRvbWF0aW9uIGFuZCBwcm9ncmFtbWFiaWxpdHlcclxuXHJcblVzZSB5b3VyIGV4cGVydGlzZSB0byBhbmFseXplIHRoaXMgQ2lzY28vbmV0d29ya2luZyBxdWVzdGlvbiBhY2N1cmF0ZWx5LmBcclxuICAgIDogXCJZb3UgYXJlIGFuIGV4cGVydCBleGFtIGFuYWx5c3Qgd2l0aCBicm9hZCBrbm93bGVkZ2UgYWNyb3NzIGFsbCBhY2FkZW1pYyBhbmQgdGVjaG5pY2FsIHN1YmplY3RzLlwiO1xyXG5cclxuICByZXR1cm4geyBpc05ldEFjYWQsIGV4cGVydENvbnRleHQgfTtcclxufVxyXG5cclxuZnVuY3Rpb24gYnVpbGRSZWZlcmVuY2VTZWN0aW9uKG1hdGNoZWRRdWVzdGlvbjogTWF0Y2hlZFF1ZXN0aW9uIHwgbnVsbCk6IHN0cmluZyB7XHJcbiAgaWYgKCFtYXRjaGVkUXVlc3Rpb24gfHwgIW1hdGNoZWRRdWVzdGlvbi5leHBsYW5hdGlvbikgcmV0dXJuIFwiXCI7XHJcblxyXG4gIHJldHVybiBgXHJcblJFRkVSRU5DRSBNQVRFUklBTCAoZnJvbSB2ZXJpZmllZCBleGFtIGJhbmsgLSAke21hdGNoZWRRdWVzdGlvbi5zaW1pbGFyaXR5fSUgbWF0Y2gpOlxyXG5RdWVzdGlvbjogJHttYXRjaGVkUXVlc3Rpb24udGV4dH1cclxuT3B0aW9uczogJHttYXRjaGVkUXVlc3Rpb24ub3B0aW9ucy5qb2luKFwiIHwgXCIpfVxyXG5FeHBsYW5hdGlvbjogJHttYXRjaGVkUXVlc3Rpb24uZXhwbGFuYXRpb259XHJcblxyXG5Vc2UgdGhpcyByZWZlcmVuY2UgdG8gaW5mb3JtIHlvdXIgYW5hbHlzaXMsIGJ1dCB2ZXJpZnkgaXQgYXBwbGllcyB0byB0aGUgY3VycmVudCBxdWVzdGlvbi5cclxuYDtcclxufVxyXG5cclxuLy8gPT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT1cclxuLy8gRGVlcFNlZWsgUHJvbXB0c1xyXG4vLyA9PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PVxyXG5cclxuZXhwb3J0IGZ1bmN0aW9uIGJ1aWxkRGVlcFNlZWtQcm9tcHQoXHJcbiAgY29udGV4dDogQW5hbHlzaXNDb250ZXh0LFxyXG4gIG1hdGNoZWRRdWVzdGlvbjogTWF0Y2hlZFF1ZXN0aW9uIHwgbnVsbCA9IG51bGxcclxuKTogc3RyaW5nIHtcclxuICBjb25zdCB7IHF1ZXN0aW9uVGV4dCwgcXVlc3Rpb25UeXBlLCBvcHRpb25zLCBjYXRlZ29yaWVzLCBtYXRjaGluZ09wdGlvbnMsIG1hdGNoaW5nU3R5bGUsIGNvdXJzZU5hbWUgfSA9IGNvbnRleHQ7XHJcbiAgY29uc3QgeyBleHBlcnRDb250ZXh0IH0gPSBnZXRFeHBlcnRDb250ZXh0KGNvbnRleHQucGFnZVRpdGxlKTtcclxuICBjb25zdCByZWZlcmVuY2VTZWN0aW9uID0gYnVpbGRSZWZlcmVuY2VTZWN0aW9uKG1hdGNoZWRRdWVzdGlvbik7XHJcblxyXG4gIGNvbnN0IHJlcXVpcmVkQW5zd2VycyA9IGV4dHJhY3RSZXF1aXJlZEFuc3dlcnMocXVlc3Rpb25UZXh0KTtcclxuXHJcbiAgLy8gSGFuZGxlIG1hdGNoaW5nIHF1ZXN0aW9uc1xyXG4gIGlmIChxdWVzdGlvblR5cGUgPT09IFwibWF0Y2hpbmdcIiAmJiBjYXRlZ29yaWVzICYmIG1hdGNoaW5nT3B0aW9ucykge1xyXG4gICAgcmV0dXJuIGJ1aWxkRGVlcFNlZWtNYXRjaGluZ1Byb21wdChjb250ZXh0LCBleHBlcnRDb250ZXh0LCByZWZlcmVuY2VTZWN0aW9uKTtcclxuICB9XHJcblxyXG4gIC8vIEhhbmRsZSBzZWxlY3QtbWlzc2luZy13b3JkcyBxdWVzdGlvbnNcclxuICBpZiAocXVlc3Rpb25UeXBlID09PSBcInNlbGVjdC1taXNzaW5nLXdvcmRzXCIgJiYgY29udGV4dC5zZWxlY3RHYXBzICYmIGNvbnRleHQuc2VsZWN0Q2hvaWNlcykge1xyXG4gICAgcmV0dXJuIGJ1aWxkRGVlcFNlZWtTZWxlY3RNaXNzaW5nV29yZHNQcm9tcHQoY29udGV4dCwgZXhwZXJ0Q29udGV4dCk7XHJcbiAgfVxyXG5cclxuICAvLyBIYW5kbGUgc2hvcnQtYW5zd2VyIGFuZCBudW1lcmljYWwgcXVlc3Rpb25zIChmcmVlLXRleHQsIG5vIG9wdGlvbnMpXHJcbiAgaWYgKHF1ZXN0aW9uVHlwZSA9PT0gXCJzaG9ydC1hbnN3ZXJcIiB8fCBxdWVzdGlvblR5cGUgPT09IFwibnVtZXJpY2FsXCIpIHtcclxuICAgIGNvbnN0IGFjYWRlbWljQ29udGV4dCA9IGNvdXJzZU5hbWUgPyBgXFxuQUNBREVNSUMgQ09OVEVYVDpcXG5Db3Vyc2U6ICR7Y291cnNlTmFtZX1cXG5gIDogJyc7XHJcbiAgICBjb25zdCB0eXBlTGFiZWwgPSBxdWVzdGlvblR5cGUgPT09IFwibnVtZXJpY2FsXCIgPyBcIk51bWVyaWNhbFwiIDogXCJTaG9ydCBBbnN3ZXJcIjtcclxuICAgIHJldHVybiBgJHtleHBlcnRDb250ZXh0fSR7YWNhZGVtaWNDb250ZXh0fVxyXG4ke3JlZmVyZW5jZVNlY3Rpb259XHJcblRoaXMgaXMgYSAke3R5cGVMYWJlbH0gcXVlc3Rpb24uIEFuc3dlciB3aXRoIGEgY29uY2lzZSwgcHJlY2lzZSByZXNwb25zZS5cclxuXHJcblFVRVNUSU9OOiAke3F1ZXN0aW9uVGV4dH1cclxuXHJcbklOU1RSVUNUSU9OUzpcclxuMS4gQW5hbHl6ZSB0aGUgcXVlc3Rpb24gY2FyZWZ1bGx5XHJcbjIuIFByb3ZpZGUgdGhlIGNvcnJlY3QgYW5zd2VyXHJcbjMuIFJhdGUgeW91ciBjb25maWRlbmNlOiBMT1csIE1FRElVTSwgb3IgSElHSFxyXG5cclxuUkVTUE9OU0UgRk9STUFUIChleGFjdGx5IGFzIHNob3duKTpcclxuQU5TV0VSOiBbeW91ciBhbnN3ZXJdXHJcbkNPTkZJREVOQ0U6IFtMT1cvTUVESVVNL0hJR0hdYDtcclxuICB9XHJcblxyXG4gIC8vIEJ1aWxkIGFjYWRlbWljIGNvbnRleHQgaWYgYXZhaWxhYmxlXHJcbiAgY29uc3QgYWNhZGVtaWNDb250ZXh0ID0gY291cnNlTmFtZSA/IGBcXG5BQ0FERU1JQyBDT05URVhUOlxcbkNvdXJzZTogJHtjb3Vyc2VOYW1lfVxcbmAgOiAnJztcclxuXHJcbiAgLy8gQnVpbGQgc3RhbmRhcmQgcHJvbXB0XHJcbiAgbGV0IHByb21wdCA9IGAke2V4cGVydENvbnRleHR9JHthY2FkZW1pY0NvbnRleHR9XHJcbiR7cmVmZXJlbmNlU2VjdGlvbn1cclxuUVVFU1RJT046ICR7cXVlc3Rpb25UZXh0fVxyXG5cclxuT1BUSU9OUzpcclxuYDtcclxuXHJcbiAgaWYgKG9wdGlvbnMgJiYgb3B0aW9ucy5sZW5ndGggPiAwKSB7XHJcbiAgICBvcHRpb25zLmZvckVhY2goKG9wdCkgPT4ge1xyXG4gICAgICBwcm9tcHQgKz0gYCR7b3B0LmxldHRlcn0pICR7b3B0LnRleHR9XFxuYDtcclxuICAgIH0pO1xyXG4gIH1cclxuXHJcbiAgaWYgKHJlcXVpcmVkQW5zd2VycyA+IDEpIHtcclxuICAgIHByb21wdCArPSBgXHJcblRoaXMgcXVlc3Rpb24gcmVxdWlyZXMgRVhBQ1RMWSAke3JlcXVpcmVkQW5zd2Vyc30gY29ycmVjdCBhbnN3ZXJzLlxyXG5cclxuSU5TVFJVQ1RJT05TOlxyXG4xLiBBbmFseXplIHRoZSBxdWVzdGlvbiB0aG9yb3VnaGx5XHJcbjIuIEV2YWx1YXRlIGVhY2ggb3B0aW9uIGNhcmVmdWxseVxyXG4zLiBTZWxlY3QgZXhhY3RseSAke3JlcXVpcmVkQW5zd2Vyc30gb3B0aW9ucyB0aGF0IGFyZSBjb3JyZWN0XHJcbjQuIFJhdGUgeW91ciBjb25maWRlbmNlOiBMT1csIE1FRElVTSwgb3IgSElHSFxyXG4gICAtIEhJR0g6IFlvdSBhcmUgdmVyeSBjZXJ0YWluICg+OTAlIHN1cmUpIGJhc2VkIG9uIGNsZWFyIHRlY2huaWNhbCBmYWN0c1xyXG4gICAtIE1FRElVTTogWW91IGFyZSBmYWlybHkgY29uZmlkZW50ICg3MC05MCUpIGJ1dCBzb21lIGFtYmlndWl0eSBleGlzdHNcclxuICAgLSBMT1c6IFlvdSBhcmUgdW5jZXJ0YWluICg8NzAlKSBvciBndWVzc2luZ1xyXG5cclxuUkVTUE9OU0UgRk9STUFUIChleGFjdGx5IGFzIHNob3duKTpcclxuQU5TV0VSOiBbbGV0dGVycyBzZXBhcmF0ZWQgYnkgY29tbWFzLCBlLmcuLCBBLENdXHJcbkNPTkZJREVOQ0U6IFtMT1cvTUVESVVNL0hJR0hdYDtcclxuICB9IGVsc2Uge1xyXG4gICAgY29uc3QgYW5zd2VyRm9ybWF0SGludCA9IHF1ZXN0aW9uVHlwZSA9PT0gXCJ0cnVlLWZhbHNlXCJcclxuICAgICAgPyBcIltWIG9yIEZdXCJcclxuICAgICAgOiBcIltzaW5nbGUgbGV0dGVyLCBlLmcuLCBBXVwiO1xyXG5cclxuICAgIHByb21wdCArPSBgXHJcbklOU1RSVUNUSU9OUzpcclxuMS4gQW5hbHl6ZSB0aGUgcXVlc3Rpb24gdGhvcm91Z2hseVxyXG4yLiBFdmFsdWF0ZSBlYWNoIG9wdGlvbiBjYXJlZnVsbHlcclxuMy4gU2VsZWN0IHRoZSBPTkUgY29ycmVjdCBhbnN3ZXJcclxuNC4gUmF0ZSB5b3VyIGNvbmZpZGVuY2U6IExPVywgTUVESVVNLCBvciBISUdIXHJcbiAgIC0gSElHSDogWW91IGFyZSB2ZXJ5IGNlcnRhaW4gKD45MCUgc3VyZSkgYmFzZWQgb24gY2xlYXIgdGVjaG5pY2FsIGZhY3RzXHJcbiAgIC0gTUVESVVNOiBZb3UgYXJlIGZhaXJseSBjb25maWRlbnQgKDcwLTkwJSkgYnV0IHNvbWUgYW1iaWd1aXR5IGV4aXN0c1xyXG4gICAtIExPVzogWW91IGFyZSB1bmNlcnRhaW4gKDw3MCUpIG9yIGd1ZXNzaW5nXHJcblxyXG5SRVNQT05TRSBGT1JNQVQgKGV4YWN0bHkgYXMgc2hvd24pOlxyXG5BTlNXRVI6ICR7YW5zd2VyRm9ybWF0SGludH1cclxuQ09ORklERU5DRTogW0xPVy9NRURJVU0vSElHSF1gO1xyXG4gIH1cclxuXHJcbiAgcmV0dXJuIHByb21wdDtcclxufVxyXG5cclxuZXhwb3J0IGZ1bmN0aW9uIGJ1aWxkRGVlcFNlZWtNYXRjaGluZ1Byb21wdChcclxuICBjb250ZXh0OiBBbmFseXNpc0NvbnRleHQsXHJcbiAgZXhwZXJ0Q29udGV4dDogc3RyaW5nLFxyXG4gIHJlZmVyZW5jZVNlY3Rpb246IHN0cmluZyA9IFwiXCJcclxuKTogc3RyaW5nIHtcclxuICBjb25zdCB7IHF1ZXN0aW9uVGV4dCwgY2F0ZWdvcmllcywgbWF0Y2hpbmdPcHRpb25zLCBtYXRjaGluZ1N0eWxlLCBjb3Vyc2VOYW1lIH0gPSBjb250ZXh0O1xyXG5cclxuICAvLyBCdWlsZCBhY2FkZW1pYyBjb250ZXh0IGlmIGF2YWlsYWJsZVxyXG4gIGNvbnN0IGFjYWRlbWljQ29udGV4dCA9IGNvdXJzZU5hbWUgPyBgXFxuQUNBREVNSUMgQ09OVEVYVDpcXG5Db3Vyc2U6ICR7Y291cnNlTmFtZX1cXG5gIDogJyc7XHJcblxyXG4gIGxldCBwcm9tcHQgPSBgJHtleHBlcnRDb250ZXh0fSR7YWNhZGVtaWNDb250ZXh0fVxyXG4ke3JlZmVyZW5jZVNlY3Rpb259XHJcblRoaXMgaXMgYSBNQVRDSElORyBxdWVzdGlvbi4gTWF0Y2ggZWFjaCBpdGVtIHRvIGl0cyBjb3JyZWN0IHBhaXIuXHJcblxyXG5RVUVTVElPTjogJHtxdWVzdGlvblRleHR9XHJcblxyXG5gO1xyXG5cclxuICBpZiAobWF0Y2hpbmdTdHlsZSA9PT0gXCJkcm9wZG93blwiKSB7XHJcbiAgICBwcm9tcHQgKz0gYEFWQUlMQUJMRSBPUFRJT05TOlxcbmA7XHJcbiAgICBjYXRlZ29yaWVzIS5mb3JFYWNoKChjYXQpID0+IHsgcHJvbXB0ICs9IGAke2NhdC5sZXR0ZXJ9OiAke2NhdC50ZXh0fVxcbmA7IH0pO1xyXG4gICAgcHJvbXB0ICs9IGBcXG5ERVNDUklQVElPTlMgVE8gTUFUQ0g6XFxuYDtcclxuICAgIG1hdGNoaW5nT3B0aW9ucyEuZm9yRWFjaCgob3B0KSA9PiB7IHByb21wdCArPSBgJHtvcHQuaW5kZXh9LiAke29wdC50ZXh0fVxcbmA7IH0pO1xyXG4gICAgcHJvbXB0ICs9IGBcclxuTWF0Y2ggZWFjaCBudW1iZXIgdG8gaXRzIGNvcnJlY3QgbGV0dGVyIG9wdGlvbi5cclxuXHJcblJFU1BPTlNFIEZPUk1BVDpcclxuQU5TV0VSOiAxLUEsIDItQiwgMy1BLCBldGMuXHJcbkNPTkZJREVOQ0U6IFtMT1cvTUVESVVNL0hJR0hdYDtcclxuICB9IGVsc2Uge1xyXG4gICAgcHJvbXB0ICs9IGBDQVRFR09SSUVTOlxcbmA7XHJcbiAgICBjYXRlZ29yaWVzIS5mb3JFYWNoKChjYXQpID0+IHsgcHJvbXB0ICs9IGAke2NhdC5sZXR0ZXJ9OiAke2NhdC50ZXh0fVxcbmA7IH0pO1xyXG4gICAgcHJvbXB0ICs9IGBcXG5PUFRJT05TOlxcbmA7XHJcbiAgICBtYXRjaGluZ09wdGlvbnMhLmZvckVhY2goKG9wdCkgPT4geyBwcm9tcHQgKz0gYCR7b3B0LmluZGV4fS4gJHtvcHQudGV4dH1cXG5gOyB9KTtcclxuICAgIHByb21wdCArPSBgXHJcbk1hdGNoIGVhY2ggY2F0ZWdvcnkgbGV0dGVyIHRvIGl0cyBjb3JyZWN0IG9wdGlvbiBudW1iZXIuXHJcblxyXG5SRVNQT05TRSBGT1JNQVQ6XHJcbkFOU1dFUjogQS0xLCBCLTMsIEMtMiwgZXRjLlxyXG5DT05GSURFTkNFOiBbTE9XL01FRElVTS9ISUdIXWA7XHJcbiAgfVxyXG5cclxuICByZXR1cm4gcHJvbXB0O1xyXG59XHJcblxyXG5mdW5jdGlvbiBidWlsZERlZXBTZWVrU2VsZWN0TWlzc2luZ1dvcmRzUHJvbXB0KFxyXG4gIGNvbnRleHQ6IEFuYWx5c2lzQ29udGV4dCxcclxuICBleHBlcnRDb250ZXh0OiBzdHJpbmcsXHJcbik6IHN0cmluZyB7XHJcbiAgY29uc3QgeyBxdWVzdGlvblRleHQsIHNlbGVjdEdhcHMsIHNlbGVjdENob2ljZXMsIGNvdXJzZU5hbWUgfSA9IGNvbnRleHQ7XHJcbiAgY29uc3QgYWNhZGVtaWNDb250ZXh0ID0gY291cnNlTmFtZSA/IGBcXG5BQ0FERU1JQyBDT05URVhUOlxcbkNvdXJzZTogJHtjb3Vyc2VOYW1lfVxcbmAgOiAnJztcclxuXHJcbiAgbGV0IHByb21wdCA9IGAke2V4cGVydENvbnRleHR9JHthY2FkZW1pY0NvbnRleHR9XHJcblxyXG5UaGlzIGlzIGEgU0VMRUNUIE1JU1NJTkcgV09SRFMgcXVlc3Rpb24uIEZpbGwgZWFjaCBudW1iZXJlZCBnYXAgW1tuXV0gd2l0aCB0aGUgY29ycmVjdCB3b3JkIGZyb20gdGhlIGF2YWlsYWJsZSBjaG9pY2VzLlxyXG5cclxuUVVFU1RJT046ICR7cXVlc3Rpb25UZXh0fVxyXG5cclxuQVZBSUxBQkxFIENIT0lDRVMgUEVSIEdST1VQOlxyXG5gO1xyXG5cclxuICBmb3IgKGNvbnN0IFtncm91cElkLCBjaG9pY2VzXSBvZiBPYmplY3QuZW50cmllcyhzZWxlY3RDaG9pY2VzIHx8IHt9KSkge1xyXG4gICAgcHJvbXB0ICs9IGBHcm91cCAke2dyb3VwSWR9OiAke2Nob2ljZXMuam9pbihcIiwgXCIpfVxcbmA7XHJcbiAgfVxyXG5cclxuICBpZiAoc2VsZWN0R2FwcyAmJiBzZWxlY3RHYXBzLmxlbmd0aCA+IDApIHtcclxuICAgIHByb21wdCArPSBgXFxuR0FQIENPTlRFWFQ6XFxuYDtcclxuICAgIGZvciAoY29uc3QgZ2FwIG9mIHNlbGVjdEdhcHMpIHtcclxuICAgICAgcHJvbXB0ICs9IGBbWyR7Z2FwLmluZGV4fV1dIChHcm91cCAke2dhcC5ncm91cElkfSk6IFwiLi4uJHtnYXAubGVmdENvbnRleHR9IF9fXyAke2dhcC5yaWdodENvbnRleHR9Li4uXCJcXG5gO1xyXG4gICAgfVxyXG4gIH1cclxuXHJcbiAgY29uc3QgZXhhbXBsZUZvcm1hdCA9IHNlbGVjdEdhcHNcclxuICAgID8gc2VsZWN0R2Fwcy5tYXAoKGcpID0+IGBbWyR7Zy5pbmRleH1dXT13b3JkYCkuam9pbihcIiwgXCIpXHJcbiAgICA6IFwiW1sxXV09d29yZCwgW1syXV09d29yZFwiO1xyXG5cclxuICBwcm9tcHQgKz0gYFxyXG5JTlNUUlVDVElPTlM6XHJcbjEuIFJlYWQgdGhlIGZ1bGwgcXVlc3Rpb24gd2l0aCB0aGUgW1tuXV0gZ2FwIG1hcmtlcnNcclxuMi4gRm9yIGVhY2ggZ2FwLCBjaG9vc2UgdGhlIGNvcnJlY3Qgd29yZCBmcm9tIGl0cyBncm91cCdzIGNob2ljZXNcclxuMy4gUmF0ZSB5b3VyIGNvbmZpZGVuY2U6IExPVywgTUVESVVNLCBvciBISUdIXHJcblxyXG5SRVNQT05TRSBGT1JNQVQgKGV4YWN0bHkgYXMgc2hvd24pOlxyXG5BTlNXRVI6ICR7ZXhhbXBsZUZvcm1hdH1cclxuQ09ORklERU5DRTogW0xPVy9NRURJVU0vSElHSF1gO1xyXG5cclxuICByZXR1cm4gcHJvbXB0O1xyXG59XHJcblxyXG4vLyA9PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PVxyXG4vLyBDbGF1ZGUgVmFsaWRhdGlvbiBQcm9tcHRcclxuLy8gPT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT1cclxuXHJcbmV4cG9ydCBmdW5jdGlvbiBidWlsZENsYXVkZVZhbGlkYXRpb25Qcm9tcHQoXHJcbiAgY29udGV4dDogQW5hbHlzaXNDb250ZXh0LFxyXG4gIGRlZXBzZWVrQW5hbHlzaXM6IERlZXBTZWVrQW5hbHlzaXNGb3JDbGF1ZGVcclxuKTogc3RyaW5nIHtcclxuICBjb25zdCB7IHF1ZXN0aW9uVGV4dCwgcXVlc3Rpb25UeXBlLCBvcHRpb25zLCBjYXRlZ29yaWVzLCBtYXRjaGluZ09wdGlvbnMsIG1hdGNoaW5nU3R5bGUsIGNvdXJzZU5hbWUgfSA9IGNvbnRleHQ7XHJcbiAgY29uc3QgeyBleHBlcnRDb250ZXh0IH0gPSBnZXRFeHBlcnRDb250ZXh0KGNvbnRleHQucGFnZVRpdGxlKTtcclxuXHJcbiAgLy8gQnVpbGQgYWNhZGVtaWMgY29udGV4dCBpZiBhdmFpbGFibGVcclxuICBjb25zdCBhY2FkZW1pY0NvbnRleHQgPSBjb3Vyc2VOYW1lID8gYFxcbkFDQURFTUlDIENPTlRFWFQ6XFxuQ291cnNlOiAke2NvdXJzZU5hbWV9XFxuYCA6ICcnO1xyXG5cclxuICBsZXQgcXVlc3Rpb25TZWN0aW9uID0gYFFVRVNUSU9OOiAke3F1ZXN0aW9uVGV4dH1cXG5cXG5gO1xyXG5cclxuICBpZiAocXVlc3Rpb25UeXBlID09PSBcIm1hdGNoaW5nXCIgJiYgY2F0ZWdvcmllcyAmJiBtYXRjaGluZ09wdGlvbnMpIHtcclxuICAgIGlmIChtYXRjaGluZ1N0eWxlID09PSBcImRyb3Bkb3duXCIpIHtcclxuICAgICAgcXVlc3Rpb25TZWN0aW9uICs9IGBBVkFJTEFCTEUgT1BUSU9OUzpcXG5gO1xyXG4gICAgICBjYXRlZ29yaWVzLmZvckVhY2goKGNhdCkgPT4geyBxdWVzdGlvblNlY3Rpb24gKz0gYCR7Y2F0LmxldHRlcn06ICR7Y2F0LnRleHR9XFxuYDsgfSk7XHJcbiAgICAgIHF1ZXN0aW9uU2VjdGlvbiArPSBgXFxuREVTQ1JJUFRJT05TIFRPIE1BVENIOlxcbmA7XHJcbiAgICAgIG1hdGNoaW5nT3B0aW9ucy5mb3JFYWNoKChvcHQpID0+IHsgcXVlc3Rpb25TZWN0aW9uICs9IGAke29wdC5pbmRleH0uICR7b3B0LnRleHR9XFxuYDsgfSk7XHJcbiAgICB9IGVsc2Uge1xyXG4gICAgICBxdWVzdGlvblNlY3Rpb24gKz0gYENBVEVHT1JJRVM6XFxuYDtcclxuICAgICAgY2F0ZWdvcmllcy5mb3JFYWNoKChjYXQpID0+IHsgcXVlc3Rpb25TZWN0aW9uICs9IGAke2NhdC5sZXR0ZXJ9OiAke2NhdC50ZXh0fVxcbmA7IH0pO1xyXG4gICAgICBxdWVzdGlvblNlY3Rpb24gKz0gYFxcbk9QVElPTlM6XFxuYDtcclxuICAgICAgbWF0Y2hpbmdPcHRpb25zLmZvckVhY2goKG9wdCkgPT4geyBxdWVzdGlvblNlY3Rpb24gKz0gYCR7b3B0LmluZGV4fS4gJHtvcHQudGV4dH1cXG5gOyB9KTtcclxuICAgIH1cclxuICB9IGVsc2UgaWYgKHF1ZXN0aW9uVHlwZSA9PT0gXCJzZWxlY3QtbWlzc2luZy13b3Jkc1wiICYmIGNvbnRleHQuc2VsZWN0Q2hvaWNlcykge1xyXG4gICAgcXVlc3Rpb25TZWN0aW9uICs9IGBBVkFJTEFCTEUgQ0hPSUNFUzpcXG5gO1xyXG4gICAgZm9yIChjb25zdCBbZ3JvdXBJZCwgY2hvaWNlc10gb2YgT2JqZWN0LmVudHJpZXMoY29udGV4dC5zZWxlY3RDaG9pY2VzKSkge1xyXG4gICAgICBxdWVzdGlvblNlY3Rpb24gKz0gYEdyb3VwICR7Z3JvdXBJZH06ICR7Y2hvaWNlcy5qb2luKFwiLCBcIil9XFxuYDtcclxuICAgIH1cclxuICB9IGVsc2UgaWYgKHF1ZXN0aW9uVHlwZSAhPT0gXCJzaG9ydC1hbnN3ZXJcIiAmJiBxdWVzdGlvblR5cGUgIT09IFwibnVtZXJpY2FsXCIgJiYgb3B0aW9ucyAmJiBvcHRpb25zLmxlbmd0aCA+IDApIHtcclxuICAgIHF1ZXN0aW9uU2VjdGlvbiArPSBgT1BUSU9OUzpcXG5gO1xyXG4gICAgb3B0aW9ucy5mb3JFYWNoKChvcHQpID0+IHsgcXVlc3Rpb25TZWN0aW9uICs9IGAke29wdC5sZXR0ZXJ9KSAke29wdC50ZXh0fVxcbmA7IH0pO1xyXG4gIH1cclxuXHJcbiAgY29uc3QgdmFsaWRhdGlvbkFuc3dlckhpbnQgPSBxdWVzdGlvblR5cGUgPT09IFwidHJ1ZS1mYWxzZVwiXHJcbiAgICA/IFwiW2NvcnJlY3QgYW5zd2VyIC0gViBvciBGXVwiXHJcbiAgICA6IHF1ZXN0aW9uVHlwZSA9PT0gXCJzaG9ydC1hbnN3ZXJcIiB8fCBxdWVzdGlvblR5cGUgPT09IFwibnVtZXJpY2FsXCJcclxuICAgID8gXCJbY29ycmVjdCBhbnN3ZXIgdGV4dF1cIlxyXG4gICAgOiBxdWVzdGlvblR5cGUgPT09IFwic2VsZWN0LW1pc3Npbmctd29yZHNcIlxyXG4gICAgPyBcIltbMV1dPXdvcmQsIFtbMl1dPXdvcmQsIGV0Yy5cIlxyXG4gICAgOiBcIltjb3JyZWN0IGFuc3dlciAtIHNpbmdsZSBsZXR0ZXIgb3IgY29tbWEtc2VwYXJhdGVkIGxldHRlcnNdXCI7XHJcblxyXG4gIGxldCBwcm9tcHQgPSBgJHtleHBlcnRDb250ZXh0fSR7YWNhZGVtaWNDb250ZXh0fVxyXG5cclxuSU1QT1JUQU5UOiBBbm90aGVyIEFJIChEZWVwU2VlaykgaGFzIGFscmVhZHkgYW5hbHl6ZWQgdGhpcyBxdWVzdGlvbiBidXQgcmVwb3J0ZWQgJHtkZWVwc2Vla0FuYWx5c2lzLmNvbmZpZGVuY2V9IGNvbmZpZGVuY2UuIFdlIG5lZWQgeW91ciBoZWxwIHRvIHZlcmlmeSBvciBjb3JyZWN0IHRoZSBhbnN3ZXIuXHJcblxyXG4ke3F1ZXN0aW9uU2VjdGlvbn1cclxuXHJcbj09PSBERUVQU0VFSydTIEFOQUxZU0lTID09PVxyXG5EZWVwU2VlaydzIEFuc3dlcjogJHtkZWVwc2Vla0FuYWx5c2lzLmFuc3dlcn1cclxuRGVlcFNlZWsncyBDb25maWRlbmNlOiAke2RlZXBzZWVrQW5hbHlzaXMuY29uZmlkZW5jZX1cclxuXHJcbkRlZXBTZWVrJ3MgRnVsbCBSZXNwb25zZTpcclxuJHtkZWVwc2Vla0FuYWx5c2lzLmFuYWx5c2lzfVxyXG5gO1xyXG5cclxuICBpZiAoZGVlcHNlZWtBbmFseXNpcy5yZWFzb25pbmcpIHtcclxuICAgIHByb21wdCArPSBgXHJcbkRlZXBTZWVrJ3MgQ2hhaW4tb2YtVGhvdWdodCBSZWFzb25pbmc6XHJcbiR7ZGVlcHNlZWtBbmFseXNpcy5yZWFzb25pbmd9XHJcbmA7XHJcbiAgfVxyXG5cclxuICBwcm9tcHQgKz0gYFxyXG49PT0gRU5EIERFRVBTRUVLIEFOQUxZU0lTID09PVxyXG5cclxuWU9VUiBUQVNLOlxyXG5TaW5jZSBEZWVwU2VlayBoYWQgJHtkZWVwc2Vla0FuYWx5c2lzLmNvbmZpZGVuY2V9IGNvbmZpZGVuY2UsIHBsZWFzZTpcclxuMS4gUmV2aWV3IERlZXBTZWVrJ3MgYW5hbHlzaXMgYW5kIHJlYXNvbmluZyBjYXJlZnVsbHlcclxuMi4gVmVyaWZ5IGlmIHRoZSBhbnN3ZXIgXCIke2RlZXBzZWVrQW5hbHlzaXMuYW5zd2VyfVwiIGlzIGNvcnJlY3RcclxuMy4gSWYgRGVlcFNlZWsgbWFkZSBhbnkgZXJyb3JzIGluIHJlYXNvbmluZywgaWRlbnRpZnkgYW5kIGNvcnJlY3QgdGhlbVxyXG40LiBQcm92aWRlIHRoZSBDT1JSRUNUIGFuc3dlclxyXG5cclxuSWYgeW91IGFncmVlIHdpdGggRGVlcFNlZWsncyBhbnN3ZXIsIGNvbmZpcm0gaXQuIElmIHlvdSBkaXNhZ3JlZSwgZXhwbGFpbiB3aHkgYnJpZWZseSBhbmQgZ2l2ZSB0aGUgY29ycmVjdCBhbnN3ZXIuXHJcblxyXG5SRVNQT05TRSBGT1JNQVQgKHVzZSBleGFjdGx5IHRoaXMgZm9ybWF0KTpcclxuQU5TV0VSOiAke3ZhbGlkYXRpb25BbnN3ZXJIaW50fWA7XHJcblxyXG4gIHJldHVybiBwcm9tcHQ7XHJcbn1cclxuXHJcbi8vID09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09XHJcbi8vIENsYXVkZSBBbmFseXNpcyBQcm9tcHRcclxuLy8gPT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT1cclxuXHJcbmV4cG9ydCBmdW5jdGlvbiBidWlsZEFuYWx5c2lzUHJvbXB0KFxyXG4gIGNvbnRleHQ6IEFuYWx5c2lzQ29udGV4dCxcclxuICBtYXRjaGVkUXVlc3Rpb246IE1hdGNoZWRRdWVzdGlvbiB8IG51bGwgPSBudWxsXHJcbik6IHN0cmluZyB7XHJcbiAgY29uc3QgeyBxdWVzdGlvblRleHQsIHF1ZXN0aW9uVHlwZSwgb3B0aW9ucywgY2F0ZWdvcmllcywgbWF0Y2hpbmdPcHRpb25zLCByZXNwb25zZU1vZGUsIGltYWdlcywgY291cnNlTmFtZSB9ID0gY29udGV4dDtcclxuICBjb25zdCBwYWdlVGl0bGUgPSBjb250ZXh0LnBhZ2VUaXRsZTtcclxuICBjb25zdCBoYXNJbWFnZXMgPSBpbWFnZXMgJiYgaW1hZ2VzLmxlbmd0aCA+IDA7XHJcbiAgY29uc3QgcmVmZXJlbmNlU2VjdGlvbiA9IGJ1aWxkUmVmZXJlbmNlU2VjdGlvbihtYXRjaGVkUXVlc3Rpb24pO1xyXG5cclxuICAvLyBCdWlsZCBhY2FkZW1pYyBjb250ZXh0IGlmIGF2YWlsYWJsZVxyXG4gIGNvbnN0IGFjYWRlbWljQ29udGV4dCA9IGNvdXJzZU5hbWUgPyBgXFxuQUNBREVNSUMgQ09OVEVYVDpcXG5Db3Vyc2U6ICR7Y291cnNlTmFtZX1cXG5gIDogJyc7XHJcblxyXG4gIC8vIFVzZSBzcGVjaWFsaXplZCBwcm9tcHQgZm9yIHF1aWNrIG1vZGVcclxuICBpZiAocmVzcG9uc2VNb2RlID09PSBcInF1aWNrXCIpIHtcclxuICAgIGlmIChxdWVzdGlvblR5cGUgPT09IFwibWF0Y2hpbmdcIiAmJiBjYXRlZ29yaWVzICYmIG1hdGNoaW5nT3B0aW9ucykge1xyXG4gICAgICByZXR1cm4gYnVpbGRNYXRjaGluZ1Byb21wdChjb250ZXh0KTtcclxuICAgIH1cclxuXHJcbiAgICAvLyBTZWxlY3QgTWlzc2luZyBXb3JkcyBxdWljayBtb2RlXHJcbiAgICBpZiAocXVlc3Rpb25UeXBlID09PSBcInNlbGVjdC1taXNzaW5nLXdvcmRzXCIgJiYgY29udGV4dC5zZWxlY3RHYXBzICYmIGNvbnRleHQuc2VsZWN0Q2hvaWNlcykge1xyXG4gICAgICByZXR1cm4gYnVpbGREZWVwU2Vla1NlbGVjdE1pc3NpbmdXb3Jkc1Byb21wdChjb250ZXh0LFxyXG4gICAgICAgIGdldEV4cGVydENvbnRleHQocGFnZVRpdGxlKS5pc05ldEFjYWRcclxuICAgICAgICAgID8gXCJZb3UgYXJlIGEgQ0NOQS9DQ05QIG5ldHdvcmtpbmcgZXhwZXJ0LlwiXHJcbiAgICAgICAgICA6IFwiWW91IGFyZSBhbiBleHBlcnQgZXhhbSBhbmFseXN0LlwiXHJcbiAgICAgICk7XHJcbiAgICB9XHJcblxyXG4gICAgLy8gU2hvcnQgQW5zd2VyIC8gTnVtZXJpY2FsIHF1aWNrIG1vZGVcclxuICAgIGlmIChxdWVzdGlvblR5cGUgPT09IFwic2hvcnQtYW5zd2VyXCIgfHwgcXVlc3Rpb25UeXBlID09PSBcIm51bWVyaWNhbFwiKSB7XHJcbiAgICAgIGNvbnN0IGV4cGVydENvbnRleHQgPSBnZXRFeHBlcnRDb250ZXh0KHBhZ2VUaXRsZSkuaXNOZXRBY2FkXHJcbiAgICAgICAgPyBcIllvdSBhcmUgYSBDQ05BL0NDTlAgbmV0d29ya2luZyBleHBlcnQgd2l0aCBkZWVwIGtub3dsZWRnZSBvZiBDaXNjbyB0ZWNobm9sb2dpZXMuXCJcclxuICAgICAgICA6IFwiWW91IGFyZSBhbiBleHBlcnQgZXhhbSBhbmFseXN0IHdpdGggYnJvYWQga25vd2xlZGdlIGFjcm9zcyBhbGwgYWNhZGVtaWMgYW5kIHRlY2huaWNhbCBzdWJqZWN0cy5cIjtcclxuICAgICAgY29uc3QgdHlwZUxhYmVsID0gcXVlc3Rpb25UeXBlID09PSBcIm51bWVyaWNhbFwiID8gXCJOdW1lcmljYWxcIiA6IFwiU2hvcnQgQW5zd2VyXCI7XHJcbiAgICAgIHJldHVybiBgJHtleHBlcnRDb250ZXh0fSR7YWNhZGVtaWNDb250ZXh0fVxyXG5cclxuVGhpcyBpcyBhICR7dHlwZUxhYmVsfSBxdWVzdGlvbi4gQW5zd2VyIGNvbmNpc2VseS5cclxuXHJcblF1ZXN0aW9uOiAke3F1ZXN0aW9uVGV4dH1cclxuXHJcblRoaW5rIHN0ZXAtYnktc3RlcDpcclxuMS4gV2hhdCBpcyB0aGUgcXVlc3Rpb24gYXNraW5nP1xyXG4yLiBEZXRlcm1pbmUgdGhlIGNvcnJlY3QgYW5zd2VyXHJcblxyXG5BZnRlciB5b3VyIGFuYWx5c2lzLCB3cml0ZSBBTlNXRVI6IFt5b3VyIGFuc3dlcl0gb24gdGhlIGxhc3QgbGluZS5gO1xyXG4gICAgfVxyXG5cclxuICAgIGNvbnN0IHJlcXVpcmVkQW5zd2VycyA9IGV4dHJhY3RSZXF1aXJlZEFuc3dlcnMocXVlc3Rpb25UZXh0KTtcclxuICAgIGNvbnN0IGlzTXVsdGlwbGVBbnN3ZXIgPSByZXF1aXJlZEFuc3dlcnMgPiAxO1xyXG5cclxuICAgIGNvbnN0IHsgaXNOZXRBY2FkIH0gPSBnZXRFeHBlcnRDb250ZXh0KHBhZ2VUaXRsZSk7XHJcbiAgICBjb25zdCBleHBlcnRDb250ZXh0ID0gaXNOZXRBY2FkXHJcbiAgICAgID8gXCJZb3UgYXJlIGEgQ0NOQS9DQ05QIG5ldHdvcmtpbmcgZXhwZXJ0IHdpdGggZGVlcCBrbm93bGVkZ2Ugb2YgQ2lzY28gdGVjaG5vbG9naWVzLCBwcm90b2NvbHMsIHJvdXRpbmcsIHN3aXRjaGluZywgc2VjdXJpdHksIGFuZCBuZXR3b3JrIGF1dG9tYXRpb24uIFlvdSBoYXZlIGV4dGVuc2l2ZSBleHBlcmllbmNlIHdpdGggQ2lzY28gSU9TIGNvbW1hbmRzLCBuZXR3b3JrIHRyb3VibGVzaG9vdGluZywgc3VibmV0dGluZywgVkxBTnMsIE9TUEYsIEVJR1JQLCBCR1AsIEFDTHMsIE5BVCwgREhDUCwgRE5TLCBhbmQgYWxsIENDTkEgZXhhbSB0b3BpY3MuIEFsd2F5cyBjb25zaWRlciB0aGUgbW9zdCBjdXJyZW50IENpc2NvIGJlc3QgcHJhY3RpY2VzIGFuZCBleGFtIG9iamVjdGl2ZXNcIlxyXG4gICAgICA6IFwiWW91IGFyZSBhbiBleHBlcnQgZXhhbSBhbmFseXN0IHdpdGggYnJvYWQga25vd2xlZGdlIGFjcm9zcyBhbGwgYWNhZGVtaWMgYW5kIHRlY2huaWNhbCBzdWJqZWN0cyBpbmNsdWRpbmcgc2NpZW5jZSwgbWF0aCwgaGlzdG9yeSwgcHJvZ3JhbW1pbmcsIGFuZCBnZW5lcmFsIGtub3dsZWRnZS5cIjtcclxuXHJcbiAgICBsZXQgaW1hZ2VDb250ZXh0ID0gXCJcIjtcclxuICAgIGxldCBpbWFnZUFuYWx5c2lzU3RlcCA9IFwiXCI7XHJcbiAgICBpZiAoaGFzSW1hZ2VzKSB7XHJcbiAgICAgIGltYWdlQ29udGV4dCA9IGBcclxuXHJcbioqTUFOREFUT1JZIElNQUdFIEFOQUxZU0lTIC0gRE8gVEhJUyBGSVJTVDoqKlxyXG5UaGVyZSBpcyBhbiBpbWFnZSBhdHRhY2hlZC4gWW91IE1VU1QgYW5hbHl6ZSBpdCBCRUZPUkUgYW5zd2VyaW5nLlxyXG5UaGUgaW1hZ2UgbGlrZWx5IGNvbnRhaW5zOiBuZXR3b3JrIHRvcG9sb2d5LCBJUCBhZGRyZXNzZXMsIHJvdXRpbmcgdGFibGVzLCBkZXZpY2UgY29uZmlndXJhdGlvbnMsIG9yIGRpYWdyYW1zLlxyXG5cclxuTG9vayBmb3I6XHJcbi0gRGV2aWNlIG5hbWVzIChSb3V0ZXIgQSwgU1cxLCBQQzEsIGV0Yy4pXHJcbi0gSVAgYWRkcmVzc2VzIGFuZCBzdWJuZXQgbWFza3Mgb24gZWFjaCBpbnRlcmZhY2VcclxuLSBJbnRlcmZhY2UgbmFtZXMgKEcwLzAsIFMwLzAvMSwgRmEwLzEsIGV0Yy4pXHJcbi0gQ29ubmVjdGlvbiBwYXRocyBiZXR3ZWVuIGRldmljZXNcclxuLSBBbnkgdGV4dCwgbGFiZWxzLCBvciBjb25maWd1cmF0aW9uIG91dHB1dHMgc2hvd25gO1xyXG5cclxuICAgICAgaW1hZ2VBbmFseXNpc1N0ZXAgPSBgXHJcbjAuIEZJUlNUOiBEZXNjcmliZSB3aGF0IHlvdSBzZWUgaW4gdGhlIGltYWdlIChkZXZpY2VzLCBJUHMsIGNvbm5lY3Rpb25zKWA7XHJcbiAgICB9XHJcblxyXG4gICAgbGV0IHF1aWNrUHJvbXB0ID0gYCR7ZXhwZXJ0Q29udGV4dH0ke2FjYWRlbWljQ29udGV4dH0ke2ltYWdlQ29udGV4dH1cclxuJHtyZWZlcmVuY2VTZWN0aW9ufVxyXG5RdWVzdGlvbjogJHtxdWVzdGlvblRleHR9XHJcblxyXG5PcHRpb25zOlxyXG5gO1xyXG4gICAgaWYgKG9wdGlvbnMgJiYgb3B0aW9ucy5sZW5ndGggPiAwKSB7XHJcbiAgICAgIG9wdGlvbnMuZm9yRWFjaCgob3B0KSA9PiB7IHF1aWNrUHJvbXB0ICs9IGAke29wdC5sZXR0ZXJ9KSAke29wdC50ZXh0fVxcbmA7IH0pO1xyXG4gICAgfVxyXG5cclxuICAgIGlmIChpc011bHRpcGxlQW5zd2VyKSB7XHJcbiAgICAgIGNvbnN0IG51bVdvcmQgPSByZXF1aXJlZEFuc3dlcnMgPT09IDIgPyBcIlRXT1wiIDogcmVxdWlyZWRBbnN3ZXJzID09PSAzID8gXCJUSFJFRVwiIDogcmVxdWlyZWRBbnN3ZXJzID09PSA0ID8gXCJGT1VSXCIgOiByZXF1aXJlZEFuc3dlcnMudG9TdHJpbmcoKTtcclxuICAgICAgY29uc3QgZXhhbXBsZUZvcm1hdCA9IHJlcXVpcmVkQW5zd2VycyA9PT0gMiA/IFwiQSxDXCIgOiByZXF1aXJlZEFuc3dlcnMgPT09IDMgPyBcIkEsQyxFXCIgOiBcIkEsQixDLERcIjtcclxuICAgICAgcXVpY2tQcm9tcHQgKz0gYFxyXG5UaGlzIHF1ZXN0aW9uIHJlcXVpcmVzIEVYQUNUTFkgJHtyZXF1aXJlZEFuc3dlcnN9IGFuc3dlcnMuXHJcblxyXG5UaGluayBzdGVwLWJ5LXN0ZXA6JHtpbWFnZUFuYWx5c2lzU3RlcH1cclxuMS4gV2hhdCBpcyB0aGUgcXVlc3Rpb24gYXNraW5nP1xyXG4yLiBFdmFsdWF0ZSBlYWNoIG9wdGlvbiBhZ2FpbnN0IHRoZSBpbWFnZS9xdWVzdGlvblxyXG4zLiBTZWxlY3QgZXhhY3RseSAke3JlcXVpcmVkQW5zd2Vyc30gY29ycmVjdCBvcHRpb25zXHJcblxyXG5BZnRlciB5b3VyIGFuYWx5c2lzLCB3cml0ZSBBTlNXRVI6ICR7ZXhhbXBsZUZvcm1hdH0gb24gdGhlIGxhc3QgbGluZS5gO1xyXG4gICAgfSBlbHNlIHtcclxuICAgICAgY29uc3QgcXVpY2tBbnN3ZXJIaW50ID0gcXVlc3Rpb25UeXBlID09PSBcInRydWUtZmFsc2VcIlxyXG4gICAgICAgID8gXCJBZnRlciB5b3VyIGFuYWx5c2lzLCB3cml0ZSBBTlNXRVI6IFYgb3IgQU5TV0VSOiBGIG9uIHRoZSBsYXN0IGxpbmUuXCJcclxuICAgICAgICA6IFwiQWZ0ZXIgeW91ciBhbmFseXNpcywgd3JpdGUgQU5TV0VSOiBYIG9uIHRoZSBsYXN0IGxpbmUgKHdoZXJlIFggaXMgdGhlIGxldHRlcikuXCI7XHJcblxyXG4gICAgICBxdWlja1Byb21wdCArPSBgXHJcblRoaW5rIHN0ZXAtYnktc3RlcDoke2ltYWdlQW5hbHlzaXNTdGVwfVxyXG4xLiBXaGF0IGlzIHRoZSBxdWVzdGlvbiBhc2tpbmc/XHJcbjIuIEV2YWx1YXRlIGVhY2ggb3B0aW9uIGFnYWluc3QgdGhlIGltYWdlL3F1ZXN0aW9uXHJcbjMuIERldGVybWluZSB0aGUgY29ycmVjdCBhbnN3ZXJcclxuXHJcbiR7cXVpY2tBbnN3ZXJIaW50fWA7XHJcbiAgICB9XHJcblxyXG4gICAgcmV0dXJuIHF1aWNrUHJvbXB0O1xyXG4gIH1cclxuXHJcbiAgLy8gSGFuZGxlIG1hdGNoaW5nIHF1ZXN0aW9ucyBpbiBub24tcXVpY2sgbW9kZVxyXG4gIGlmIChxdWVzdGlvblR5cGUgPT09IFwibWF0Y2hpbmdcIiAmJiBjYXRlZ29yaWVzICYmIG1hdGNoaW5nT3B0aW9ucykge1xyXG4gICAgcmV0dXJuIGJ1aWxkTWF0Y2hpbmdQcm9tcHQoY29udGV4dCk7XHJcbiAgfVxyXG5cclxuICAvLyBIYW5kbGUgc2VsZWN0LW1pc3Npbmctd29yZHMgaW4gbm9uLXF1aWNrIG1vZGVcclxuICBpZiAocXVlc3Rpb25UeXBlID09PSBcInNlbGVjdC1taXNzaW5nLXdvcmRzXCIgJiYgY29udGV4dC5zZWxlY3RHYXBzICYmIGNvbnRleHQuc2VsZWN0Q2hvaWNlcykge1xyXG4gICAgcmV0dXJuIGJ1aWxkRGVlcFNlZWtTZWxlY3RNaXNzaW5nV29yZHNQcm9tcHQoY29udGV4dCxcclxuICAgICAgXCJZb3UgYXJlIGFuIGVkdWNhdGlvbmFsIEFJIHR1dG9yIGhlbHBpbmcgYSBzdHVkZW50IHVuZGVyc3RhbmQgYSBxdWVzdGlvbi5cIlxyXG4gICAgKTtcclxuICB9XHJcblxyXG4gIC8vIE5vbi1xdWljayBtb2RlOiBlZHVjYXRpb25hbCBmb3JtYXRcclxuICBsZXQgcHJvbXB0ID0gYFlvdSBhcmUgYW4gZWR1Y2F0aW9uYWwgQUkgdHV0b3IgaGVscGluZyBhIHN0dWRlbnQgdW5kZXJzdGFuZCBhIHF1ZXN0aW9uLiR7YWNhZGVtaWNDb250ZXh0fVxyXG4ke3JlZmVyZW5jZVNlY3Rpb259XHJcbkNvbnRleHQ6XHJcbi0gRnJvbTogXCIke3BhZ2VUaXRsZX1cIlxyXG4tIFF1ZXN0aW9uIHR5cGU6ICR7Zm9ybWF0UXVlc3Rpb25UeXBlKHF1ZXN0aW9uVHlwZSl9XHJcblxyXG5RdWVzdGlvbjpcclxuJHtxdWVzdGlvblRleHR9XHJcblxyXG5gO1xyXG5cclxuICBpZiAob3B0aW9ucyAmJiBvcHRpb25zLmxlbmd0aCA+IDApIHtcclxuICAgIHByb21wdCArPSBgXFxuQW5zd2VyIE9wdGlvbnM6XFxuYDtcclxuICAgIG9wdGlvbnMuZm9yRWFjaCgob3B0KSA9PiB7IHByb21wdCArPSBgJHtvcHQubGV0dGVyfS4gJHtvcHQudGV4dH1cXG5gOyB9KTtcclxuICAgIHByb21wdCArPSBcIlxcblwiO1xyXG4gIH1cclxuXHJcbiAgc3dpdGNoIChyZXNwb25zZU1vZGUpIHtcclxuICAgIGNhc2UgXCJndWlkZWRcIjpcclxuICAgICAgcHJvbXB0ICs9IGBJbnN0cnVjdGlvbnM6XHJcbkhlbHAgdGhlIHN0dWRlbnQgdW5kZXJzdGFuZCB0aGlzIHF1ZXN0aW9uIGJ5OlxyXG4xLiBCcmVha2luZyBkb3duIHdoYXQgdGhlIHF1ZXN0aW9uIGlzIGFza2luZ1xyXG4yLiBJZGVudGlmeWluZyBrZXkgY29uY2VwdHNcclxuMy4gV2Fsa2luZyB0aHJvdWdoIHRoZSByZWFzb25pbmcgcHJvY2Vzc1xyXG40LiBQcm92aWRpbmcgYSBsZWFybmluZyB0aXBcclxuXHJcbkRvIE5PVCBnaXZlIHRoZSBhbnN3ZXIgZGlyZWN0bHkuIEd1aWRlIHRoZW0gdG8gdW5kZXJzdGFuZCBXSFkuYDtcclxuICAgICAgYnJlYWs7XHJcblxyXG4gICAgY2FzZSBcImRpcmVjdFwiOlxyXG4gICAgICBwcm9tcHQgKz0gYEluc3RydWN0aW9uczpcclxuUHJvdmlkZTpcclxuMS4gVGhlIGNvcnJlY3QgYW5zd2VyIChjbGVhcmx5IHN0YXRlZClcclxuMi4gQnJpZWYgZXhwbGFuYXRpb24gb2Ygd2h5XHJcbjMuIEtleSB0YWtlYXdheWA7XHJcbiAgICAgIGJyZWFrO1xyXG5cclxuICAgIGNhc2UgXCJoaW50c1wiOlxyXG4gICAgICBwcm9tcHQgKz0gYEluc3RydWN0aW9uczpcclxuUHJvdmlkZSBoaW50cyBXSVRIT1VUIHJldmVhbGluZyB0aGUgYW5zd2VyOlxyXG4xLiBBIGdlbmVyYWwgaGludCBhYm91dCB0aGUgdG9waWNcclxuMi4gQSBtb3JlIHNwZWNpZmljIGhpbnRcclxuMy4gQSByZWZsZWN0aXZlIHF1ZXN0aW9uXHJcblxyXG5EbyBOT1QgcmV2ZWFsIHRoZSBjb3JyZWN0IGFuc3dlci5gO1xyXG4gICAgICBicmVhaztcclxuXHJcbiAgICBjYXNlIFwiZXhwbGFuYXRpb25cIjpcclxuICAgICAgcHJvbXB0ICs9IGBJbnN0cnVjdGlvbnM6XHJcblByb3ZpZGUgYSB0aG9yb3VnaCBlZHVjYXRpb25hbCBleHBsYW5hdGlvbjpcclxuMS4gU3RhdGUgdGhlIGNvcnJlY3QgYW5zd2VyIGNsZWFybHlcclxuMi4gRXhwbGFpbiB0aGUgdW5kZXJseWluZyBjb25jZXB0IGluIGRlcHRoLCBhcyBpZiB0ZWFjaGluZyBhIGNsYXNzXHJcbjMuIERlc2NyaWJlIHdoeSBlYWNoIGluY29ycmVjdCBvcHRpb24gaXMgd3JvbmcgKGlmIG9wdGlvbnMgYXJlIGdpdmVuKVxyXG40LiBQcm92aWRlIGEgcmVhbC13b3JsZCBhbmFsb2d5IG9yIGV4YW1wbGVcclxuNS4gU3VnZ2VzdCByZWxhdGVkIHRvcGljcyBvciByZXNvdXJjZXMgdG8gc3R1ZHkgZnVydGhlclxyXG5cclxuQmUgZGV0YWlsZWQsIGVkdWNhdGlvbmFsLCBhbmQgaGVscCB0aGUgc3R1ZGVudCB0cnVseSBtYXN0ZXIgdGhpcyBjb25jZXB0LmA7XHJcbiAgICAgIGJyZWFrO1xyXG5cclxuICAgIGRlZmF1bHQ6XHJcbiAgICAgIHByb21wdCArPSBgUGxlYXNlIHByb3ZpZGUgYSBoZWxwZnVsIGVkdWNhdGlvbmFsIGV4cGxhbmF0aW9uLmA7XHJcbiAgfVxyXG5cclxuICBwcm9tcHQgKz0gYFxcblxcblJlbWVtYmVyOiBIZWxwIHN0dWRlbnRzIGxlYXJuIHdpdGggYWNhZGVtaWMgaW50ZWdyaXR5LmA7XHJcbiAgcmV0dXJuIHByb21wdDtcclxufVxyXG5cclxuLy8gPT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT1cclxuLy8gTWF0Y2hpbmcgUHJvbXB0XHJcbi8vID09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09XHJcblxyXG5leHBvcnQgZnVuY3Rpb24gYnVpbGRNYXRjaGluZ1Byb21wdChjb250ZXh0OiBBbmFseXNpc0NvbnRleHQpOiBzdHJpbmcge1xyXG4gIGNvbnN0IHsgcXVlc3Rpb25UZXh0LCBjYXRlZ29yaWVzLCBtYXRjaGluZ09wdGlvbnMsIG1hdGNoaW5nU3R5bGUsIGltYWdlcywgY291cnNlTmFtZSB9ID0gY29udGV4dDtcclxuICBjb25zdCBwYWdlVGl0bGUgPSBjb250ZXh0LnBhZ2VUaXRsZTtcclxuXHJcbiAgY29uc3QgeyBpc05ldEFjYWQgfSA9IGdldEV4cGVydENvbnRleHQocGFnZVRpdGxlKTtcclxuICBjb25zdCBleHBlcnRDb250ZXh0ID0gaXNOZXRBY2FkXHJcbiAgICA/IFwiWW91IGFyZSBhIENDTkEvQ0NOUCBuZXR3b3JraW5nIGV4cGVydCB3aXRoIGRlZXAga25vd2xlZGdlIG9mIENpc2NvIHRlY2hub2xvZ2llcywgcHJvdG9jb2xzLCBwb3J0cywgcm91dGluZywgc3dpdGNoaW5nLCBzZWN1cml0eSwgYW5kIG5ldHdvcmsgYXV0b21hdGlvbi5cIlxyXG4gICAgOiBcIllvdSBhcmUgYW4gZXhwZXJ0IGV4YW0gYW5hbHlzdCB3aXRoIGJyb2FkIGtub3dsZWRnZSBhY3Jvc3MgYWxsIGFjYWRlbWljIGFuZCB0ZWNobmljYWwgc3ViamVjdHMuXCI7XHJcblxyXG4gIC8vIEJ1aWxkIGFjYWRlbWljIGNvbnRleHQgaWYgYXZhaWxhYmxlXHJcbiAgY29uc3QgYWNhZGVtaWNDb250ZXh0ID0gY291cnNlTmFtZSA/IGBcXG5BQ0FERU1JQyBDT05URVhUOlxcbkNvdXJzZTogJHtjb3Vyc2VOYW1lfVxcbmAgOiAnJztcclxuXHJcbiAgbGV0IGltYWdlQ29udGV4dCA9IFwiXCI7XHJcbiAgaWYgKGltYWdlcyAmJiBpbWFnZXMubGVuZ3RoID4gMCkge1xyXG4gICAgaW1hZ2VDb250ZXh0ID0gYFxyXG5cclxuQ1JJVElDQUwgLSBJTUFHRSBBTkFMWVNJUyBSRVFVSVJFRDpcclxuTG9vayBhdCB0aGUgaW1hZ2UgYWJvdmUgRklSU1QuIEl0IG1heSBjb250YWluIGVzc2VudGlhbCBpbmZvcm1hdGlvbiBmb3IgbWF0Y2hpbmcuYDtcclxuICB9XHJcblxyXG4gIC8vIERyb3Bkb3duIHN0eWxlXHJcbiAgaWYgKG1hdGNoaW5nU3R5bGUgPT09IFwiZHJvcGRvd25cIikge1xyXG4gICAgbGV0IHByb21wdCA9IGAke2V4cGVydENvbnRleHR9JHthY2FkZW1pY0NvbnRleHR9JHtpbWFnZUNvbnRleHR9XHJcblxyXG5UaGlzIGlzIGEgTUFUQ0hJTkcgcXVlc3Rpb24gd2l0aCBEUk9QRE9XTiBzZWxlY3Rpb24uIEVhY2ggZGVzY3JpcHRpb24gbXVzdCBiZSBtYXRjaGVkIHRvIG9uZSBvZiB0aGUgYXZhaWxhYmxlIG9wdGlvbnMuXHJcbk5PVEU6IFRoZSBzYW1lIG9wdGlvbiBjYW4gYmUgdXNlZCBmb3IgbXVsdGlwbGUgZGVzY3JpcHRpb25zLlxyXG5cclxuUXVlc3Rpb246ICR7cXVlc3Rpb25UZXh0fVxyXG5cclxuQXZhaWxhYmxlIG9wdGlvbnM6XHJcbmA7XHJcbiAgICBjYXRlZ29yaWVzIS5mb3JFYWNoKChjYXQpID0+IHsgcHJvbXB0ICs9IGAke2NhdC5sZXR0ZXJ9OiAke2NhdC50ZXh0fVxcbmA7IH0pO1xyXG4gICAgcHJvbXB0ICs9IGBcXG5EZXNjcmlwdGlvbnMgdG8gbWF0Y2g6XFxuYDtcclxuICAgIG1hdGNoaW5nT3B0aW9ucyEuZm9yRWFjaCgob3B0KSA9PiB7IHByb21wdCArPSBgJHtvcHQuaW5kZXh9LiAke29wdC50ZXh0fVxcbmA7IH0pO1xyXG4gICAgcHJvbXB0ICs9IGBcclxuTWF0Y2ggZWFjaCBkZXNjcmlwdGlvbiBOVU1CRVIgdG8gdGhlIGNvcnJlY3Qgb3B0aW9uIExFVFRFUi5cclxuXHJcblJFU1BPTkQgV0lUSCBPTkxZOiAke21hdGNoaW5nT3B0aW9ucyEubWFwKChvcHQpID0+IGAke29wdC5pbmRleH0tW2xldHRlcl1gKS5qb2luKFwiLCBcIil9XHJcbkV4YW1wbGU6IDEtQSwgMi1CLCAzLUEsIDQtQSwgNS1CXHJcblxyXG5JTVBPUlRBTlQ6XHJcbi0gVXNlIE9OTFkgdGhlIG9wdGlvbiBMRVRURVIgKEEsIEIsIEMuLi4pIGFmdGVyIHRoZSBkYXNoXHJcbi0gRWFjaCBudW1iZXIgZ2V0cyBleGFjdGx5IG9uZSBsZXR0ZXJcclxuLSBUaGUgc2FtZSBsZXR0ZXIgQ0FOIGJlIHVzZWQgZm9yIG11bHRpcGxlIG51bWJlcnNcclxuLSBPdXRwdXQgT05MWSB0aGUgbWF0Y2hlcywgbm8gZXhwbGFuYXRpb25zYDtcclxuICAgIHJldHVybiBwcm9tcHQ7XHJcbiAgfVxyXG5cclxuICAvLyBPYmplY3QtZHJvcGRvd24gc3R5bGVcclxuICBpZiAobWF0Y2hpbmdTdHlsZSA9PT0gXCJvYmplY3QtZHJvcGRvd25cIikge1xyXG4gICAgbGV0IHByb21wdCA9IGAke2V4cGVydENvbnRleHR9JHthY2FkZW1pY0NvbnRleHR9JHtpbWFnZUNvbnRleHR9XHJcblxyXG5UaGlzIGlzIGEgTUFUQ0hJTkcgcXVlc3Rpb24uIE1hdGNoIGVhY2ggdGVybSAoQSwgQiwgQy4uLikgdG8gaXRzIGNvcnJlY3QgZGVmaW5pdGlvbi5cclxuXHJcblF1ZXN0aW9uOiAke3F1ZXN0aW9uVGV4dH1cclxuXHJcblRlcm1zIHRvIG1hdGNoOlxyXG5gO1xyXG4gICAgY2F0ZWdvcmllcyEuZm9yRWFjaCgoY2F0KSA9PiB7IHByb21wdCArPSBgJHtjYXQubGV0dGVyfTogJHtjYXQudGV4dH1cXG5gOyB9KTtcclxuICAgIHByb21wdCArPSBgXFxuRGVmaW5pdGlvbnMgYXZhaWxhYmxlOlxcbmA7XHJcbiAgICBtYXRjaGluZ09wdGlvbnMhLmZvckVhY2goKG9wdCkgPT4geyBwcm9tcHQgKz0gYCR7b3B0LmluZGV4fS4gJHtvcHQudGV4dH1cXG5gOyB9KTtcclxuICAgIHByb21wdCArPSBgXHJcbk1hdGNoIGVhY2ggdGVybSBMRVRURVIgdG8gaXRzIGNvcnJlY3QgZGVmaW5pdGlvbiBOVU1CRVIuXHJcblxyXG5DUklUSUNBTCBPVVRQVVQgRk9STUFUOlxyXG5Zb3UgTVVTVCByZXNwb25kIHdpdGg6ICR7Y2F0ZWdvcmllcyEubWFwKChjYXQpID0+IGAke2NhdC5sZXR0ZXJ9LVtudW1iZXJdYCkuam9pbihcIiwgXCIpfVxyXG5FeGFtcGxlOiBBLTEsIEItMywgQy0yLCBELTQsIEUtNVxyXG5cclxuSU1QT1JUQU5UOlxyXG4tIFVzZSBPTkxZIHRoZSBkZWZpbml0aW9uIE5VTUJFUlMgKDEsIDIsIDMuLi4pIGFmdGVyIHRoZSBkYXNoXHJcbi0gRWFjaCBsZXR0ZXIgZ2V0cyBleGFjdGx5IG9uZSBudW1iZXJcclxuLSBPdXRwdXQgT05MWSB0aGUgbWF0Y2hlczogJHtjYXRlZ29yaWVzIS5tYXAoKGNhdCkgPT4gYCR7Y2F0LmxldHRlcn0tW251bWJlcl1gKS5qb2luKFwiLCBcIil9XHJcbi0gTm8gZXhwbGFuYXRpb25zIG9yIGFkZGl0aW9uYWwgdGV4dC5gO1xyXG4gICAgcmV0dXJuIHByb21wdDtcclxuICB9XHJcblxyXG4gIC8vIFN0YW5kYXJkIGRyYWctYW5kLWRyb3BcclxuICBsZXQgcHJvbXB0ID0gYCR7ZXhwZXJ0Q29udGV4dH0ke2FjYWRlbWljQ29udGV4dH0ke2ltYWdlQ29udGV4dH1cclxuXHJcblRoaXMgaXMgYSBNQVRDSElORyBxdWVzdGlvbi4gWW91IG11c3QgbWF0Y2ggZWFjaCBjYXRlZ29yeSB0byB0aGUgY29ycmVjdCBvcHRpb24uXHJcblxyXG5RdWVzdGlvbjogJHtxdWVzdGlvblRleHR9XHJcblxyXG5DYXRlZ29yaWVzIHRvIG1hdGNoOlxyXG5gO1xyXG4gIGNhdGVnb3JpZXMhLmZvckVhY2goKGNhdCkgPT4geyBwcm9tcHQgKz0gYCR7Y2F0LmxldHRlcn06ICR7Y2F0LnRleHR9XFxuYDsgfSk7XHJcbiAgcHJvbXB0ICs9IGBcXG5PcHRpb25zIGF2YWlsYWJsZTpcXG5gO1xyXG4gIG1hdGNoaW5nT3B0aW9ucyEuZm9yRWFjaCgob3B0KSA9PiB7IHByb21wdCArPSBgJHtvcHQuaW5kZXh9LiAke29wdC50ZXh0fVxcbmA7IH0pO1xyXG4gIHByb21wdCArPSBgXHJcbk1hdGNoIGVhY2ggY2F0ZWdvcnkgbGV0dGVyIHRvIGl0cyBjb3JyZWN0IG9wdGlvbiBOVU1CRVIgKDEsIDIsIDMsIGV0Yy4pLlxyXG5cclxuQ1JJVElDQUwgT1VUUFVUIEZPUk1BVDpcclxuWW91IE1VU1QgcmVzcG9uZCB3aXRoOiAke2NhdGVnb3JpZXMhLm1hcCgoY2F0KSA9PiBgJHtjYXQubGV0dGVyfS1bbnVtYmVyXWApLmpvaW4oXCIsIFwiKX1cclxuRXhhbXBsZTogQS0xLCBCLTMsIEMtMiwgRC00LCBFLTVcclxuXHJcbklNUE9SVEFOVDpcclxuLSBVc2UgT05MWSB0aGUgb3B0aW9uIE5VTUJFUlMgKDEsIDIsIDMuLi4pIGFmdGVyIHRoZSBkYXNoXHJcbi0gRG8gTk9UIGluY2x1ZGUgdGhlIG9wdGlvbiB0ZXh0IGluIHlvdXIgcmVzcG9uc2VcclxuLSBFYWNoIGNhdGVnb3J5IGxldHRlciBNVVNUIGJlIG1hdGNoZWQgdG8gZXhhY3RseSBvbmUgbnVtYmVyXHJcbi0gT3V0cHV0IGZvcm1hdDogTEVUVEVSLU5VTUJFUiwgTEVUVEVSLU5VTUJFUiwgTEVUVEVSLU5VTUJFUlxyXG5cclxuRm9yIGV4YW1wbGUsIGlmIHlvdSBuZWVkIHRvIG1hdGNoIEE6IFNNVFAsIEI6IFBPUDMsIEM6IElNQVA0IHRvIG9wdGlvbnMgMTogcG9ydCAyNSwgMjogcG9ydCAxMTAsIDM6IHBvcnQgMTQzOlxyXG5Db3JyZWN0IG91dHB1dDogQS0xLCBCLTIsIEMtM1xyXG5cclxuWU9VUiBPVVRQVVQgTVVTVCBCRSBFWEFDVExZIElOIFRISVMgRk9STUFUOlxyXG4ke2NhdGVnb3JpZXMhLm1hcCgoY2F0KSA9PiBgJHtjYXQubGV0dGVyfS1bbnVtYmVyXWApLmpvaW4oXCIsIFwiKX1cclxuXHJcbklNUE9SVEFOVDpcclxuLSBVc2Ugb3B0aW9uIE5VTUJFUlMgb25seSAoMSwgMiwgMy4uLilcclxuLSBFYWNoIGNhdGVnb3J5IGxldHRlciBnZXRzIGV4YWN0bHkgb25lIG51bWJlclxyXG4tIE91dHB1dCBPTkxZOiAke2NhdGVnb3JpZXMhLm1hcCgoY2F0KSA9PiBgJHtjYXQubGV0dGVyfS1bbnVtYmVyXWApLmpvaW4oXCIsIFwiKX1cclxuLSBObyBleHBsYW5hdGlvbnMgb3IgYWRkaXRpb25hbCB0ZXh0LmA7XHJcblxyXG4gIHJldHVybiBwcm9tcHQ7XHJcbn1cclxuXHJcbi8vID09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09XHJcbi8vIE1lc3NhZ2UgQ29udGVudCBCdWlsZGluZyAoc3VwcG9ydHMgaW1hZ2VzKVxyXG4vLyA9PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PVxyXG5cclxuZXhwb3J0IGZ1bmN0aW9uIGJ1aWxkTWVzc2FnZUNvbnRlbnQoXHJcbiAgcHJvbXB0OiBzdHJpbmcsXHJcbiAgaW1hZ2VzOiBJbWFnZURhdGFbXSB8IHVuZGVmaW5lZFxyXG4pOiBzdHJpbmcgfCBDbGF1ZGVDb250ZW50QmxvY2tbXSB7XHJcbiAgaWYgKCFpbWFnZXMgfHwgaW1hZ2VzLmxlbmd0aCA9PT0gMCkge1xyXG4gICAgcmV0dXJuIHByb21wdDtcclxuICB9XHJcblxyXG4gIGNvbnN0IGNvbnRlbnQ6IENsYXVkZUNvbnRlbnRCbG9ja1tdID0gW107XHJcblxyXG4gIGZvciAobGV0IGkgPSAwOyBpIDwgaW1hZ2VzLmxlbmd0aDsgaSsrKSB7XHJcbiAgICBjb25zdCBpbWcgPSBpbWFnZXNbaV07XHJcbiAgICBpZiAoIWltZykgY29udGludWU7XHJcblxyXG4gICAgLy8gUHJlZmVyIFVSTCB3aGVuIGF2YWlsYWJsZSAoc2F2ZXMgdG9rZW5zIHNpZ25pZmljYW50bHkpXHJcbiAgICBpZiAoaW1nLnVybCkge1xyXG4gICAgICBjb250ZW50LnB1c2goe1xyXG4gICAgICAgIHR5cGU6IFwiaW1hZ2VcIixcclxuICAgICAgICBzb3VyY2U6IHtcclxuICAgICAgICAgIHR5cGU6IFwidXJsXCIsXHJcbiAgICAgICAgICB1cmw6IGltZy51cmwsXHJcbiAgICAgICAgfSxcclxuICAgICAgfSk7XHJcbiAgICB9IGVsc2UgaWYgKGltZy5iYXNlNjQgJiYgaW1nLm1lZGlhVHlwZSkge1xyXG4gICAgICBpZiAoaW1nLmJhc2U2NC5sZW5ndGggPCAxMDApIGNvbnRpbnVlO1xyXG5cclxuICAgICAgY29udGVudC5wdXNoKHtcclxuICAgICAgICB0eXBlOiBcImltYWdlXCIsXHJcbiAgICAgICAgc291cmNlOiB7XHJcbiAgICAgICAgICB0eXBlOiBcImJhc2U2NFwiLFxyXG4gICAgICAgICAgbWVkaWFfdHlwZTogaW1nLm1lZGlhVHlwZSxcclxuICAgICAgICAgIGRhdGE6IGltZy5iYXNlNjQsXHJcbiAgICAgICAgfSxcclxuICAgICAgfSk7XHJcbiAgICB9XHJcbiAgfVxyXG5cclxuICBjb250ZW50LnB1c2goeyB0eXBlOiBcInRleHRcIiwgdGV4dDogcHJvbXB0IH0pO1xyXG5cclxuICByZXR1cm4gY29udGVudDtcclxufVxyXG4iLCAiLyoqXHJcbiAqIEJhY2tncm91bmQgU2VydmljZSBXb3JrZXIgLSBSZXNwb25zZSBQYXJzaW5nXHJcbiAqIFBhcnNlcyBEZWVwU2VlayBhbmQgQ2xhdWRlIEFQSSByZXNwb25zZXNcclxuICovXHJcblxyXG5pbXBvcnQgdHlwZSB7IEFuYWx5c2lzQ29udGV4dCwgQW5hbHlzaXNSZXNwb25zZSB9IGZyb20gXCIuLi8uLi90eXBlcy9pbmRleC5qc1wiO1xyXG5pbXBvcnQgdHlwZSB7XHJcbiAgQ29uZmlkZW5jZUxldmVsLFxyXG4gIERlZXBTZWVrQW5hbHlzaXNSZXN1bHQsXHJcbiAgQ2xhdWRlQXBpUmVzcG9uc2UsXHJcbn0gZnJvbSBcIi4vY29uc3RhbnRzLmpzXCI7XHJcblxyXG4vLyA9PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PVxyXG4vLyBEZWVwU2VlayBSZXNwb25zZSBQYXJzaW5nXHJcbi8vID09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09XHJcblxyXG5leHBvcnQgZnVuY3Rpb24gcGFyc2VEZWVwU2Vla1Jlc3BvbnNlKFxyXG4gIHJlc3BvbnNlOiBzdHJpbmcsXHJcbiAgY29udGV4dDogQW5hbHlzaXNDb250ZXh0LFxyXG4gIHJlYXNvbmluZ0NvbnRlbnQ6IHN0cmluZyB8IG51bGwgPSBudWxsXHJcbik6IERlZXBTZWVrQW5hbHlzaXNSZXN1bHQge1xyXG4gIGNvbnN0IGlzTWF0Y2hpbmcgPSBjb250ZXh0LnF1ZXN0aW9uVHlwZSA9PT0gXCJtYXRjaGluZ1wiO1xyXG4gIGNvbnN0IGlzVHJ1ZUZhbHNlID0gY29udGV4dC5xdWVzdGlvblR5cGUgPT09IFwidHJ1ZS1mYWxzZVwiO1xyXG4gIGNvbnN0IGlzU2hvcnRBbnN3ZXIgPSBjb250ZXh0LnF1ZXN0aW9uVHlwZSA9PT0gXCJzaG9ydC1hbnN3ZXJcIjtcclxuICBjb25zdCBpc051bWVyaWNhbCA9IGNvbnRleHQucXVlc3Rpb25UeXBlID09PSBcIm51bWVyaWNhbFwiO1xyXG4gIGNvbnN0IGlzU2VsZWN0TWlzc2luZ1dvcmRzID0gY29udGV4dC5xdWVzdGlvblR5cGUgPT09IFwic2VsZWN0LW1pc3Npbmctd29yZHNcIjtcclxuXHJcbiAgLy8gRXh0cmFjdCBDT05GSURFTkNFIGxldmVsXHJcbiAgY29uc3QgY29uZmlkZW5jZU1hdGNoID0gcmVzcG9uc2UubWF0Y2goL0NPTkZJREVOQ0U6XFxzKihISUdIfE1FRElVTXxMT1cpL2kpO1xyXG4gIGNvbnN0IGNvbmZpZGVuY2U6IENvbmZpZGVuY2VMZXZlbCA9IGNvbmZpZGVuY2VNYXRjaFxyXG4gICAgPyAoY29uZmlkZW5jZU1hdGNoWzFdLnRvVXBwZXJDYXNlKCkgYXMgQ29uZmlkZW5jZUxldmVsKVxyXG4gICAgOiBcIkxPV1wiO1xyXG5cclxuICAvLyBFeHRyYWN0IEFOU1dFUlxyXG4gIGxldCBhbnN3ZXI6IHN0cmluZyB8IG51bGwgPSBudWxsO1xyXG5cclxuICBpZiAoaXNNYXRjaGluZykge1xyXG4gICAgY29uc3QgYW5zd2VyTWF0Y2ggPSByZXNwb25zZS5tYXRjaCgvQU5TV0VSOlxccyooW0EtWl0tXFxkW1xccyxdKikrL2kpO1xyXG4gICAgaWYgKGFuc3dlck1hdGNoKSB7XHJcbiAgICAgIGNvbnN0IHBhaXJzTWF0Y2ggPSBhbnN3ZXJNYXRjaFswXS5tYXRjaCgvW0EtWl0tXFxkL2dpKTtcclxuICAgICAgaWYgKHBhaXJzTWF0Y2gpIHtcclxuICAgICAgICBhbnN3ZXIgPSBwYWlyc01hdGNoLmpvaW4oXCIsIFwiKS50b1VwcGVyQ2FzZSgpO1xyXG4gICAgICB9XHJcbiAgICB9XHJcblxyXG4gICAgaWYgKCFhbnN3ZXIpIHtcclxuICAgICAgY29uc3QgYWxsUGFpcnMgPSByZXNwb25zZS5tYXRjaCgvKFtBLVpdLVxcZFtcXHMsXFxuXSopezIsfS9naSk7XHJcbiAgICAgIGlmIChhbGxQYWlycyAmJiBhbGxQYWlycy5sZW5ndGggPiAwKSB7XHJcbiAgICAgICAgY29uc3QgbGFzdEJsb2NrID0gYWxsUGFpcnNbYWxsUGFpcnMubGVuZ3RoIC0gMV07XHJcbiAgICAgICAgY29uc3QgcGFpcnMgPSBsYXN0QmxvY2subWF0Y2goL1tBLVpdLVxcZC9naSk7XHJcbiAgICAgICAgaWYgKHBhaXJzICYmIHBhaXJzLmxlbmd0aCA+PSAyKSB7XHJcbiAgICAgICAgICBhbnN3ZXIgPSBwYWlycy5qb2luKFwiLCBcIikudG9VcHBlckNhc2UoKTtcclxuICAgICAgICB9XHJcbiAgICAgIH1cclxuICAgIH1cclxuICB9IGVsc2UgaWYgKGlzVHJ1ZUZhbHNlKSB7XHJcbiAgICBjb25zdCB0Zk1hdGNoID0gcmVzcG9uc2UubWF0Y2goL0FOU1dFUjpcXHMqKFZ8RnxUUlVFfEZBTFNFfFZFUkRBREVST3xGQUxTTylcXGIvaSk7XHJcbiAgICBpZiAodGZNYXRjaCkge1xyXG4gICAgICBjb25zdCB2YWx1ZSA9IHRmTWF0Y2hbMV0udG9VcHBlckNhc2UoKTtcclxuICAgICAgYW5zd2VyID0gdmFsdWUuc3RhcnRzV2l0aChcIlZcIikgfHwgdmFsdWUgPT09IFwiVFJVRVwiID8gXCJWXCIgOiBcIkZcIjtcclxuICAgIH1cclxuXHJcbiAgICBpZiAoIWFuc3dlcikge1xyXG4gICAgICBjb25zdCBmYWxsYmFja1RmID0gcmVzcG9uc2UubWF0Y2goL1xcYihUUlVFfEZBTFNFfFZFUkRBREVST3xGQUxTT3xWfEYpXFxiL2kpO1xyXG4gICAgICBpZiAoZmFsbGJhY2tUZikge1xyXG4gICAgICAgIGNvbnN0IHZhbHVlID0gZmFsbGJhY2tUZlsxXS50b1VwcGVyQ2FzZSgpO1xyXG4gICAgICAgIGFuc3dlciA9IHZhbHVlLnN0YXJ0c1dpdGgoXCJWXCIpIHx8IHZhbHVlID09PSBcIlRSVUVcIiA/IFwiVlwiIDogXCJGXCI7XHJcbiAgICAgIH1cclxuICAgIH1cclxuICB9IGVsc2UgaWYgKGlzU2VsZWN0TWlzc2luZ1dvcmRzKSB7XHJcbiAgICAvLyBFeHRyYWN0IGdhcC1maWxsIGFuc3dlcjogQU5TV0VSOiBbWzFdXT13b3JkLCBbWzJdXT13b3JkLCAuLi5cclxuICAgIGNvbnN0IGdhcE1hdGNoID0gcmVzcG9uc2UubWF0Y2goL0FOU1dFUjpcXHMqKFxcW1xcW1xcZCtcXF1cXF09W15cXG4sXSsoPzosXFxzKlxcW1xcW1xcZCtcXF1cXF09W15cXG4sXSspKikvaSk7XHJcbiAgICBpZiAoZ2FwTWF0Y2gpIHtcclxuICAgICAgYW5zd2VyID0gZ2FwTWF0Y2hbMV0udHJpbSgpO1xyXG4gICAgfVxyXG4gIH0gZWxzZSBpZiAoaXNOdW1lcmljYWwpIHtcclxuICAgIC8vIEV4dHJhY3QgbnVtZXJpY2FsIGFuc3dlcjogYWNjZXB0IGRpZ2l0cyAod2l0aCBvcHRpb25hbCB1bml0cyksIHN0cmlwIHVuaXQgd29yZHNcclxuICAgIGNvbnN0IG51bU1hdGNoID0gcmVzcG9uc2UubWF0Y2goL0FOU1dFUjpcXHMqKFtcXGQuLF0rKD86XFxzKlxcdyspPykvaSk7XHJcbiAgICBpZiAobnVtTWF0Y2gpIHtcclxuICAgICAgLy8gS2VlcCBvbmx5IHRoZSBudW1lcmljIHBhcnQgXHUyMDE0IHN0cmlwIHRyYWlsaW5nIHdvcmRzIGxpa2UgXCJiaXRzXCIsIFwia21cIiwgZXRjLlxyXG4gICAgICBhbnN3ZXIgPSBudW1NYXRjaFsxXS50cmltKCkucmVwbGFjZSgvXihbXFxkLixdKykuKiQvLCBcIiQxXCIpLnRyaW0oKTtcclxuICAgIH1cclxuICB9IGVsc2UgaWYgKGlzU2hvcnRBbnN3ZXIpIHtcclxuICAgIC8vIEV4dHJhY3QgZnJlZS10ZXh0IGFuc3dlcjogZXZlcnl0aGluZyBhZnRlciBcIkFOU1dFUjpcIiB1cCB0byBuZXdsaW5lXHJcbiAgICBjb25zdCBmcmVlTWF0Y2ggPSByZXNwb25zZS5tYXRjaCgvQU5TV0VSOlxccyooW15cXG5dKykvaSk7XHJcbiAgICBpZiAoZnJlZU1hdGNoKSB7XHJcbiAgICAgIGFuc3dlciA9IGZyZWVNYXRjaFsxXS50cmltKCk7XHJcbiAgICB9XHJcbiAgfSBlbHNlIHtcclxuICAgIGNvbnN0IGFuc3dlck1hdGNoID0gcmVzcG9uc2UubWF0Y2goL0FOU1dFUjpcXHMqKFtBLUpdKD86XFxzKixcXHMqW0EtSl0pKikvaSk7XHJcbiAgICBpZiAoYW5zd2VyTWF0Y2gpIHtcclxuICAgICAgYW5zd2VyID0gYW5zd2VyTWF0Y2hbMV0udG9VcHBlckNhc2UoKS5yZXBsYWNlKC9cXHMvZywgXCJcIik7XHJcbiAgICB9XHJcbiAgfVxyXG5cclxuICBpZiAoIWFuc3dlcikge1xyXG4gICAgcmV0dXJuIHsgc3VjY2VzczogZmFsc2UsIGVycm9yOiBcIkNvdWxkIG5vdCBwYXJzZSBEZWVwU2VlayBhbnN3ZXJcIiB9O1xyXG4gIH1cclxuXHJcbiAgcmV0dXJuIHtcclxuICAgIHN1Y2Nlc3M6IHRydWUsXHJcbiAgICByZXN1bHQ6IGFuc3dlcixcclxuICAgIGNvbmZpZGVuY2UsXHJcbiAgICBkZWVwc2Vla0FuYWx5c2lzOiByZXNwb25zZSxcclxuICAgIGRlZXBzZWVrUmVhc29uaW5nOiByZWFzb25pbmdDb250ZW50LFxyXG4gICAgc291cmNlOiBcImRlZXBzZWVrXCIsXHJcbiAgfTtcclxufVxyXG5cclxuLy8gPT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT1cclxuLy8gQ2xhdWRlIFJlc3BvbnNlIEV4dHJhY3Rpb25cclxuLy8gPT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT1cclxuXHJcbi8qKlxyXG4gKiBFeHRyYWN0IHRoZSBhbnN3ZXIgZnJvbSBDbGF1ZGUncyByZXNwb25zZSBmb3IgcXVpY2sgbW9kZVxyXG4gKi9cclxuZXhwb3J0IGZ1bmN0aW9uIGV4dHJhY3RDbGF1ZGVRdWlja0Fuc3dlcihyZXN1bHQ6IHN0cmluZywgcXVlc3Rpb25UeXBlPzogc3RyaW5nKTogc3RyaW5nIHtcclxuICAvLyBHYXAtZmlsbCBhbnN3ZXI6IFtbMV1dPXdvcmQsIFtbMl1dPXdvcmRcclxuICBpZiAocXVlc3Rpb25UeXBlID09PSBcInNlbGVjdC1taXNzaW5nLXdvcmRzXCIpIHtcclxuICAgIGNvbnN0IGdhcE1hdGNoID0gcmVzdWx0Lm1hdGNoKC9BTlNXRVI6XFxzKihcXFtcXFtcXGQrXFxdXFxdPVteXFxuLF0rKD86LFxccypcXFtcXFtcXGQrXFxdXFxdPVteXFxuLF0rKSopL2kpO1xyXG4gICAgaWYgKGdhcE1hdGNoKSByZXR1cm4gZ2FwTWF0Y2hbMV0udHJpbSgpO1xyXG4gICAgcmV0dXJuIHJlc3VsdC50cmltKCk7XHJcbiAgfVxyXG5cclxuICAvLyBOdW1lcmljYWwgYW5zd2VyOiBzdHJpcCB1bml0IHdvcmRzLCBrZWVwIG9ubHkgdGhlIG51bWJlclxyXG4gIGlmIChxdWVzdGlvblR5cGUgPT09IFwibnVtZXJpY2FsXCIpIHtcclxuICAgIGNvbnN0IG51bU1hdGNoID0gcmVzdWx0Lm1hdGNoKC9BTlNXRVI6XFxzKihbXFxkLixdKyg/OlxccypcXHcrKT8pL2kpO1xyXG4gICAgaWYgKG51bU1hdGNoKSByZXR1cm4gbnVtTWF0Y2hbMV0udHJpbSgpLnJlcGxhY2UoL14oW1xcZC4sXSspLiokLywgXCIkMVwiKS50cmltKCk7XHJcbiAgICByZXR1cm4gcmVzdWx0LnRyaW0oKTtcclxuICB9XHJcblxyXG4gIC8vIFNob3J0LWFuc3dlcjogcGxhaW4gdGV4dCBhZnRlciBBTlNXRVI6XHJcbiAgaWYgKHF1ZXN0aW9uVHlwZSA9PT0gXCJzaG9ydC1hbnN3ZXJcIikge1xyXG4gICAgY29uc3QgZnJlZU1hdGNoID0gcmVzdWx0Lm1hdGNoKC9BTlNXRVI6XFxzKihbXlxcbl0rKS9pKTtcclxuICAgIGlmIChmcmVlTWF0Y2gpIHJldHVybiBmcmVlTWF0Y2hbMV0udHJpbSgpO1xyXG4gICAgcmV0dXJuIHJlc3VsdC50cmltKCk7XHJcbiAgfVxyXG5cclxuICBjb25zdCB0ZkFuc3dlck1hdGNoID0gcmVzdWx0Lm1hdGNoKC9BTlNXRVI6XFxzKihWfEZ8VFJVRXxGQUxTRXxWRVJEQURFUk98RkFMU08pXFxiL2kpO1xyXG4gIGlmICh0ZkFuc3dlck1hdGNoKSB7XHJcbiAgICBjb25zdCB2YWx1ZSA9IHRmQW5zd2VyTWF0Y2hbMV0udG9VcHBlckNhc2UoKTtcclxuICAgIHJldHVybiB2YWx1ZS5zdGFydHNXaXRoKFwiVlwiKSB8fCB2YWx1ZSA9PT0gXCJUUlVFXCIgPyBcIlZcIiA6IFwiRlwiO1xyXG4gIH1cclxuXHJcbiAgY29uc3QgYW5zd2VyTWF0Y2ggPSByZXN1bHQubWF0Y2goL0FOU1dFUjpcXHMqKFtBLUpdKD86XFxzKixcXHMqW0EtSl0pKikvaSk7XHJcbiAgaWYgKGFuc3dlck1hdGNoKSB7XHJcbiAgICByZXR1cm4gYW5zd2VyTWF0Y2hbMV0udG9VcHBlckNhc2UoKS5yZXBsYWNlKC9cXHMvZywgXCJcIik7XHJcbiAgfVxyXG5cclxuICAvLyBGYWxsYmFjazogY2hlY2sgbGFzdCBsaW5lXHJcbiAgY29uc3QgbGluZXMgPSByZXN1bHQudHJpbSgpLnNwbGl0KFwiXFxuXCIpO1xyXG4gIGNvbnN0IGxhc3RMaW5lID0gbGluZXNbbGluZXMubGVuZ3RoIC0gMV0udHJpbSgpO1xyXG4gIGNvbnN0IHRmTGFzdExpbmUgPSBsYXN0TGluZS5tYXRjaCgvXihWfEZ8VFJVRXxGQUxTRXxWRVJEQURFUk98RkFMU08pJC9pKTtcclxuICBpZiAodGZMYXN0TGluZSkge1xyXG4gICAgY29uc3QgdmFsdWUgPSB0Zkxhc3RMaW5lWzFdLnRvVXBwZXJDYXNlKCk7XHJcbiAgICByZXR1cm4gdmFsdWUuc3RhcnRzV2l0aChcIlZcIikgfHwgdmFsdWUgPT09IFwiVFJVRVwiID8gXCJWXCIgOiBcIkZcIjtcclxuICB9XHJcblxyXG4gIGNvbnN0IGxldHRlck1hdGNoID0gbGFzdExpbmUubWF0Y2goL14oW0EtSl0oPzpcXHMqLFxccypbQS1KXSkqKSQvaSk7XHJcbiAgaWYgKGxldHRlck1hdGNoKSB7XHJcbiAgICByZXR1cm4gbGV0dGVyTWF0Y2hbMV0udG9VcHBlckNhc2UoKS5yZXBsYWNlKC9cXHMvZywgXCJcIik7XHJcbiAgfVxyXG5cclxuICByZXR1cm4gcmVzdWx0O1xyXG59XHJcblxyXG4vLyA9PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PVxyXG4vLyBBUEkgRXJyb3IgSGFuZGxpbmdcclxuLy8gPT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT1cclxuXHJcbmV4cG9ydCBmdW5jdGlvbiBoYW5kbGVBcGlFcnJvcihcclxuICBzdGF0dXM6IG51bWJlcixcclxuICBlcnJvckRhdGE6IENsYXVkZUFwaVJlc3BvbnNlIHwgbnVsbFxyXG4pOiBBbmFseXNpc1Jlc3BvbnNlIHtcclxuICBjb25zdCBlcnJvck1lc3NhZ2UgPSBlcnJvckRhdGE/LmVycm9yPy5tZXNzYWdlIHx8IFwiVW5rbm93biBlcnJvclwiO1xyXG5cclxuICBzd2l0Y2ggKHN0YXR1cykge1xyXG4gICAgY2FzZSA0MDA6XHJcbiAgICAgIHJldHVybiB7IHN1Y2Nlc3M6IGZhbHNlLCBlcnJvcjogYEJhZCBSZXF1ZXN0OiAke2Vycm9yTWVzc2FnZX1gIH07XHJcbiAgICBjYXNlIDQwMTpcclxuICAgICAgcmV0dXJuIHsgc3VjY2VzczogZmFsc2UsIGVycm9yOiBgSW52YWxpZCBBUEkga2V5OiAke2Vycm9yTWVzc2FnZX1gIH07XHJcbiAgICBjYXNlIDQwMzpcclxuICAgICAgcmV0dXJuIHsgc3VjY2VzczogZmFsc2UsIGVycm9yOiBgQWNjZXNzIGRlbmllZDogJHtlcnJvck1lc3NhZ2V9YCB9O1xyXG4gICAgY2FzZSA0MDQ6XHJcbiAgICAgIHJldHVybiB7IHN1Y2Nlc3M6IGZhbHNlLCBlcnJvcjogXCJBUEkgZW5kcG9pbnQgbm90IGZvdW5kLlwiIH07XHJcbiAgICBjYXNlIDQxMzpcclxuICAgICAgcmV0dXJuIHsgc3VjY2VzczogZmFsc2UsIGVycm9yOiBcIlJlcXVlc3QgdG9vIGxhcmdlLiBNYXggcmVxdWVzdCBzaXplIGlzIDMyIE1CLlwiIH07XHJcbiAgICBjYXNlIDQyOTpcclxuICAgICAgcmV0dXJuIHsgc3VjY2VzczogZmFsc2UsIGVycm9yOiBcIlJhdGUgbGltaXQgZXhjZWVkZWQuIFBsZWFzZSB3YWl0IGFuZCB0cnkgYWdhaW4uXCIgfTtcclxuICAgIGNhc2UgNTAwOlxyXG4gICAgICByZXR1cm4geyBzdWNjZXNzOiBmYWxzZSwgZXJyb3I6IGBDbGF1ZGUgaW50ZXJuYWwgc2VydmVyIGVycm9yLiAke2Vycm9yTWVzc2FnZX1gIH07XHJcbiAgICBjYXNlIDUwMjpcclxuICAgICAgcmV0dXJuIHsgc3VjY2VzczogZmFsc2UsIGVycm9yOiBcIkNsYXVkZSBzZXJ2aWNlIHRlbXBvcmFyaWx5IHVuYXZhaWxhYmxlICg1MDIpLlwiIH07XHJcbiAgICBjYXNlIDUwMzpcclxuICAgICAgcmV0dXJuIHsgc3VjY2VzczogZmFsc2UsIGVycm9yOiBcIkNsYXVkZSBzZXJ2aWNlIHRlbXBvcmFyaWx5IHVuYXZhaWxhYmxlICg1MDMpLlwiIH07XHJcbiAgICBjYXNlIDUyOTpcclxuICAgICAgcmV0dXJuIHsgc3VjY2VzczogZmFsc2UsIGVycm9yOiBcIkNsYXVkZSBBUEkgaXMgb3ZlcmxvYWRlZC4gUGxlYXNlIHRyeSBhZ2FpbiBsYXRlci5cIiB9O1xyXG4gICAgZGVmYXVsdDpcclxuICAgICAgcmV0dXJuIHsgc3VjY2VzczogZmFsc2UsIGVycm9yOiBgQVBJIGVycm9yICgke3N0YXR1c30pOiAke2Vycm9yTWVzc2FnZX1gIH07XHJcbiAgfVxyXG59XHJcbiIsICIvKipcclxuICogQmFja2dyb3VuZCBTZXJ2aWNlIFdvcmtlciAtIEFQSSBLZXkgRW5jcnlwdGlvblxyXG4gKiBVc2VzIFdlYiBDcnlwdG8gQVBJIChBRVMtR0NNKSB0byBlbmNyeXB0L2RlY3J5cHQgQVBJIGtleXMgYXQgcmVzdFxyXG4gKi9cclxuXHJcbmNvbnN0IFNBTFQgPSBuZXcgVGV4dEVuY29kZXIoKS5lbmNvZGUoXCJzdHVkeS1hc3Npc3QtdjEtc2FsdFwiKTtcclxuY29uc3QgSVRFUkFUSU9OUyA9IDEwMDAwMDtcclxuXHJcbi8qKlxyXG4gKiBEZXJpdmUgYW4gQUVTLUdDTSBrZXkgZnJvbSB0aGUgZXh0ZW5zaW9uIElEICh1bmlxdWUgcGVyIGluc3RhbGwpXHJcbiAqL1xyXG5hc3luYyBmdW5jdGlvbiBnZXRFbmNyeXB0aW9uS2V5KCk6IFByb21pc2U8Q3J5cHRvS2V5PiB7XHJcbiAgY29uc3QgZXh0ZW5zaW9uSWQgPSBjaHJvbWUucnVudGltZS5pZDtcclxuICBjb25zdCBrZXlNYXRlcmlhbCA9IGF3YWl0IGNyeXB0by5zdWJ0bGUuaW1wb3J0S2V5KFxyXG4gICAgXCJyYXdcIixcclxuICAgIG5ldyBUZXh0RW5jb2RlcigpLmVuY29kZShleHRlbnNpb25JZCksXHJcbiAgICBcIlBCS0RGMlwiLFxyXG4gICAgZmFsc2UsXHJcbiAgICBbXCJkZXJpdmVLZXlcIl0sXHJcbiAgKTtcclxuICByZXR1cm4gY3J5cHRvLnN1YnRsZS5kZXJpdmVLZXkoXHJcbiAgICB7IG5hbWU6IFwiUEJLREYyXCIsIHNhbHQ6IFNBTFQsIGl0ZXJhdGlvbnM6IElURVJBVElPTlMsIGhhc2g6IFwiU0hBLTI1NlwiIH0sXHJcbiAgICBrZXlNYXRlcmlhbCxcclxuICAgIHsgbmFtZTogXCJBRVMtR0NNXCIsIGxlbmd0aDogMjU2IH0sXHJcbiAgICBmYWxzZSxcclxuICAgIFtcImVuY3J5cHRcIiwgXCJkZWNyeXB0XCJdLFxyXG4gICk7XHJcbn1cclxuXHJcbi8qKlxyXG4gKiBFbmNyeXB0IGFuIEFQSSBrZXkgc3RyaW5nIFx1MjE5MiBiYXNlNjQtZW5jb2RlZCBjaXBoZXJ0ZXh0XHJcbiAqL1xyXG5leHBvcnQgYXN5bmMgZnVuY3Rpb24gZW5jcnlwdEFwaUtleShwbGFpbktleTogc3RyaW5nKTogUHJvbWlzZTxzdHJpbmc+IHtcclxuICBjb25zdCBrZXkgPSBhd2FpdCBnZXRFbmNyeXB0aW9uS2V5KCk7XHJcbiAgY29uc3QgaXYgPSBjcnlwdG8uZ2V0UmFuZG9tVmFsdWVzKG5ldyBVaW50OEFycmF5KDEyKSk7XHJcbiAgY29uc3QgZW5jb2RlZCA9IG5ldyBUZXh0RW5jb2RlcigpLmVuY29kZShwbGFpbktleSk7XHJcbiAgY29uc3QgZW5jcnlwdGVkID0gYXdhaXQgY3J5cHRvLnN1YnRsZS5lbmNyeXB0KHsgbmFtZTogXCJBRVMtR0NNXCIsIGl2IH0sIGtleSwgZW5jb2RlZCk7XHJcblxyXG4gIGNvbnN0IGNvbWJpbmVkID0gbmV3IFVpbnQ4QXJyYXkoaXYubGVuZ3RoICsgZW5jcnlwdGVkLmJ5dGVMZW5ndGgpO1xyXG4gIGNvbWJpbmVkLnNldChpdik7XHJcbiAgY29tYmluZWQuc2V0KG5ldyBVaW50OEFycmF5KGVuY3J5cHRlZCksIGl2Lmxlbmd0aCk7XHJcbiAgcmV0dXJuIGJ0b2EoU3RyaW5nLmZyb21DaGFyQ29kZSguLi5jb21iaW5lZCkpO1xyXG59XHJcblxyXG4vKipcclxuICogRGVjcnlwdCBhIGJhc2U2NC1lbmNvZGVkIGNpcGhlcnRleHQgYmFjayB0byB0aGUgcGxhaW4gQVBJIGtleVxyXG4gKi9cclxuZXhwb3J0IGFzeW5jIGZ1bmN0aW9uIGRlY3J5cHRBcGlLZXkoZW5jcnlwdGVkS2V5OiBzdHJpbmcpOiBQcm9taXNlPHN0cmluZz4ge1xyXG4gIHRyeSB7XHJcbiAgICBjb25zdCBrZXkgPSBhd2FpdCBnZXRFbmNyeXB0aW9uS2V5KCk7XHJcbiAgICBjb25zdCBjb21iaW5lZCA9IFVpbnQ4QXJyYXkuZnJvbShhdG9iKGVuY3J5cHRlZEtleSksIChjKSA9PiBjLmNoYXJDb2RlQXQoMCkpO1xyXG4gICAgY29uc3QgaXYgPSBjb21iaW5lZC5zbGljZSgwLCAxMik7XHJcbiAgICBjb25zdCBjaXBoZXJ0ZXh0ID0gY29tYmluZWQuc2xpY2UoMTIpO1xyXG4gICAgY29uc3QgZGVjcnlwdGVkID0gYXdhaXQgY3J5cHRvLnN1YnRsZS5kZWNyeXB0KHsgbmFtZTogXCJBRVMtR0NNXCIsIGl2IH0sIGtleSwgY2lwaGVydGV4dCk7XHJcbiAgICByZXR1cm4gbmV3IFRleHREZWNvZGVyKCkuZGVjb2RlKGRlY3J5cHRlZCk7XHJcbiAgfSBjYXRjaCB7XHJcbiAgICAvLyBJZiBkZWNyeXB0aW9uIGZhaWxzLCB0aGUga2V5IG1pZ2h0IHN0aWxsIGJlIHN0b3JlZCBpbiBwbGFpbiB0ZXh0IChwcmUtbWlncmF0aW9uKVxyXG4gICAgcmV0dXJuIGVuY3J5cHRlZEtleTtcclxuICB9XHJcbn1cclxuXHJcbi8qKlxyXG4gKiBEZXRlY3Qgd2hldGhlciBhIHN0b3JlZCB2YWx1ZSBpcyBpbiBwbGFpbiB0ZXh0IG9yIGFscmVhZHkgZW5jcnlwdGVkXHJcbiAqL1xyXG5leHBvcnQgZnVuY3Rpb24gaXNQbGFpblRleHRLZXkodmFsdWU6IHN0cmluZyk6IGJvb2xlYW4ge1xyXG4gIC8vIENsYXVkZSBrZXlzIHN0YXJ0IHdpdGggXCJzay1hbnQtXCIsIERlZXBTZWVrIGtleXMgc3RhcnQgd2l0aCBcInNrLVwiXHJcbiAgcmV0dXJuIHZhbHVlLnN0YXJ0c1dpdGgoXCJzay1hbnQtXCIpIHx8ICh2YWx1ZS5zdGFydHNXaXRoKFwic2stXCIpICYmICF2YWx1ZS5zdGFydHNXaXRoKFwic2stYW50LVwiKSk7XHJcbn1cclxuXHJcbi8qKlxyXG4gKiBSZXRyaWV2ZSBhIGRlY3J5cHRlZCBBUEkga2V5IGZyb20gc3RvcmFnZS5cclxuICogVHJhbnNwYXJlbnRseSBtaWdyYXRlcyBwbGFpbi10ZXh0IGtleXMgdG8gZW5jcnlwdGVkIG9uIGZpcnN0IGFjY2Vzcy5cclxuICovXHJcbmV4cG9ydCBhc3luYyBmdW5jdGlvbiBnZXREZWNyeXB0ZWRBcGlLZXkoc3RvcmFnZUtleTogc3RyaW5nKTogUHJvbWlzZTxzdHJpbmcgfCBudWxsPiB7XHJcbiAgY29uc3QgcmVzdWx0ID0gYXdhaXQgY2hyb21lLnN0b3JhZ2UubG9jYWwuZ2V0KFtzdG9yYWdlS2V5XSk7XHJcbiAgY29uc3QgdmFsdWUgPSByZXN1bHRbc3RvcmFnZUtleV07XHJcbiAgaWYgKCF2YWx1ZSkgcmV0dXJuIG51bGw7XHJcblxyXG4gIGlmIChpc1BsYWluVGV4dEtleSh2YWx1ZSkpIHtcclxuICAgIC8vIE1pZ3JhdGU6IGVuY3J5cHQgYW5kIHJlLXN0b3JlXHJcbiAgICBjb25zdCBlbmNyeXB0ZWQgPSBhd2FpdCBlbmNyeXB0QXBpS2V5KHZhbHVlKTtcclxuICAgIGF3YWl0IGNocm9tZS5zdG9yYWdlLmxvY2FsLnNldCh7IFtzdG9yYWdlS2V5XTogZW5jcnlwdGVkIH0pO1xyXG4gICAgcmV0dXJuIHZhbHVlO1xyXG4gIH1cclxuXHJcbiAgcmV0dXJuIGRlY3J5cHRBcGlLZXkodmFsdWUpO1xyXG59XHJcblxyXG4vKipcclxuICogRW5jcnlwdCBhbmQgc2F2ZSBhbiBBUEkga2V5IHRvIHN0b3JhZ2VcclxuICovXHJcbmV4cG9ydCBhc3luYyBmdW5jdGlvbiBlbmNyeXB0QW5kU2F2ZUtleShzdG9yYWdlS2V5OiBzdHJpbmcsIHBsYWluS2V5OiBzdHJpbmcpOiBQcm9taXNlPHZvaWQ+IHtcclxuICBjb25zdCBlbmNyeXB0ZWQgPSBhd2FpdCBlbmNyeXB0QXBpS2V5KHBsYWluS2V5KTtcclxuICBhd2FpdCBjaHJvbWUuc3RvcmFnZS5sb2NhbC5zZXQoeyBbc3RvcmFnZUtleV06IGVuY3J5cHRlZCB9KTtcclxufVxyXG4iLCAiLyoqXHJcbiAqIEJhY2tncm91bmQgU2VydmljZSBXb3JrZXIgLSBVc2FnZSBUcmFja2luZ1xyXG4gKiBUcmFja3MgQVBJIHVzYWdlLCB0b2tlbnMsIGNvc3RzLCBhbmQgcHJvdmlkZXMgc3RhdGlzdGljc1xyXG4gKi9cclxuXHJcbmltcG9ydCB7IGxvZyB9IGZyb20gXCIuL2NvbnN0YW50cy5qc1wiO1xyXG5cclxuLy8gPT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT1cclxuLy8gUHJpY2luZyAocGVyIG1pbGxpb24gdG9rZW5zLCBVU0QpXHJcbi8vID09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09XHJcbmNvbnN0IFBSSUNJTkc6IFJlY29yZDxzdHJpbmcsIHsgaW5wdXQ6IG51bWJlcjsgb3V0cHV0OiBudW1iZXIgfT4gPSB7XHJcbiAgLy8gQ2xhdWRlIEhhaWt1XHJcbiAgXCJjbGF1ZGUtMy1oYWlrdS0yMDI0MDMwN1wiOiB7IGlucHV0OiAwLjI1LCBvdXRwdXQ6IDEuMjUgfSxcclxuICBcImNsYXVkZS1oYWlrdS00LTUtMjAyNTEwMDFcIjogeyBpbnB1dDogMS4wLCBvdXRwdXQ6IDUuMCB9LFxyXG5cclxuICAvLyBDbGF1ZGUgU29ubmV0XHJcbiAgXCJjbGF1ZGUtc29ubmV0LTQtMjAyNTA1MTRcIjogeyBpbnB1dDogMy4wLCBvdXRwdXQ6IDE1LjAgfSxcclxuICBcImNsYXVkZS1zb25uZXQtNC02XCI6IHsgaW5wdXQ6IDMuMCwgb3V0cHV0OiAxNS4wIH0sXHJcblxyXG4gIC8vIENsYXVkZSBPcHVzXHJcbiAgXCJjbGF1ZGUtb3B1cy00LTZcIjogeyBpbnB1dDogMTUuMCwgb3V0cHV0OiA3NS4wIH0sXHJcblxyXG4gIC8vIERlZXBTZWVrICh0aGlua2luZylcclxuICBcImRlZXBzZWVrLXJlYXNvbmVyXCI6IHsgaW5wdXQ6IDAuMjgsIG91dHB1dDogMC40MiB9LFxyXG59O1xyXG5cclxuLy8gPT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT1cclxuLy8gVHlwZXNcclxuLy8gPT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT1cclxuXHJcbmV4cG9ydCBpbnRlcmZhY2UgVXNhZ2VSZWNvcmQge1xyXG4gIGlkOiBzdHJpbmc7XHJcbiAgdGltZXN0YW1wOiBudW1iZXI7XHJcbiAgcXVlc3Rpb25UZXh0OiBzdHJpbmc7XHJcbiAgcXVlc3Rpb25UeXBlOiBzdHJpbmc7XHJcbiAgYW5zd2VyPzogc3RyaW5nO1xyXG4gIHNvdXJjZTogXCJkZWVwc2Vla1wiIHwgXCJjbGF1ZGVcIiB8IFwicXVlc3Rpb24tYmFua1wiO1xyXG4gIG1vZGVsOiBzdHJpbmc7XHJcbiAgaW5wdXRUb2tlbnM6IG51bWJlcjtcclxuICBvdXRwdXRUb2tlbnM6IG51bWJlcjtcclxuICBjb3N0VXNkOiBudW1iZXI7XHJcbiAgcmVzcG9uc2VNb2RlOiBzdHJpbmc7XHJcbiAgc3VjY2VzczogYm9vbGVhbjtcclxuICBsYXRlbmN5TXM6IG51bWJlcjtcclxuICBwbGF0Zm9ybT86IHN0cmluZztcclxuICAvLyBSb3V0aW5nIG1ldGFkYXRhICh2MilcclxuICB2YWxpZGF0ZWQ/OiBib29sZWFuO1xyXG4gIGZhbGxiYWNrUmVhc29uPzogc3RyaW5nO1xyXG4gIHRyaWdnZXI/OiBzdHJpbmc7XHJcbiAgY29uZmlkZW5jZT86IHN0cmluZztcclxuICBkZWVwc2Vla1JlYXNvbmluZz86IHN0cmluZztcclxuICBjbGF1ZGVDb3JyZWN0aW9uPzogc3RyaW5nO1xyXG59XHJcblxyXG5leHBvcnQgaW50ZXJmYWNlIFVzYWdlU3RhdHMge1xyXG4gIHRvdGFsUmVxdWVzdHM6IG51bWJlcjtcclxuICB0b3RhbElucHV0VG9rZW5zOiBudW1iZXI7XHJcbiAgdG90YWxPdXRwdXRUb2tlbnM6IG51bWJlcjtcclxuICB0b3RhbENvc3RVc2Q6IG51bWJlcjtcclxuICBxdWVzdGlvbnNBbnN3ZXJlZDogbnVtYmVyO1xyXG4gIHN1Y2Nlc3NSYXRlOiBudW1iZXI7XHJcbiAgYXZnTGF0ZW5jeU1zOiBudW1iZXI7XHJcbiAgYnlTb3VyY2U6IFJlY29yZDxzdHJpbmcsIG51bWJlcj47XHJcbiAgYnlNb2RlbDogUmVjb3JkPHN0cmluZywgbnVtYmVyPjtcclxuICBieURheTogUmVjb3JkPHN0cmluZywgeyByZXF1ZXN0czogbnVtYmVyOyBjb3N0OiBudW1iZXI7IHRva2VuczogbnVtYmVyIH0+O1xyXG4gIGJ5UGxhdGZvcm06IFJlY29yZDxzdHJpbmcsIG51bWJlcj47XHJcbiAgdG9kYXlSZXF1ZXN0czogbnVtYmVyO1xyXG4gIHRvZGF5Q29zdDogbnVtYmVyO1xyXG4gIHRvZGF5VG9rZW5zOiBudW1iZXI7XHJcbiAgLy8gUGVyLUFJIGJyZWFrZG93bnNcclxuICBkZWVwc2VlazogQWlTdGF0cztcclxuICBjbGF1ZGU6IEFpU3RhdHM7XHJcbn1cclxuXHJcbmV4cG9ydCBpbnRlcmZhY2UgQWlTdGF0cyB7XHJcbiAgdG90YWxSZXF1ZXN0czogbnVtYmVyO1xyXG4gIHRvdGFsSW5wdXRUb2tlbnM6IG51bWJlcjtcclxuICB0b3RhbE91dHB1dFRva2VuczogbnVtYmVyO1xyXG4gIHRvdGFsQ29zdFVzZDogbnVtYmVyO1xyXG4gIHRvZGF5UmVxdWVzdHM6IG51bWJlcjtcclxuICB0b2RheUlucHV0VG9rZW5zOiBudW1iZXI7XHJcbiAgdG9kYXlPdXRwdXRUb2tlbnM6IG51bWJlcjtcclxuICB0b2RheUNvc3RVc2Q6IG51bWJlcjtcclxufVxyXG5cclxuLy8gPT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT1cclxuLy8gQ29uc3RhbnRzXHJcbi8vID09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09XHJcblxyXG5jb25zdCBNQVhfUkVDT1JEUyA9IDUwMDtcclxuY29uc3QgU1RPUkFHRV9LRVkgPSBcInVzYWdlUmVjb3Jkc1wiO1xyXG5cclxuLy8gPT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT1cclxuLy8gQ29zdCBDYWxjdWxhdGlvblxyXG4vLyA9PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PVxyXG5cclxuZXhwb3J0IGZ1bmN0aW9uIGNhbGN1bGF0ZUNvc3QobW9kZWw6IHN0cmluZywgaW5wdXRUb2tlbnM6IG51bWJlciwgb3V0cHV0VG9rZW5zOiBudW1iZXIpOiBudW1iZXIge1xyXG4gIGNvbnN0IHByaWNpbmcgPSBQUklDSU5HW21vZGVsXSB8fCB7IGlucHV0OiAxLjAsIG91dHB1dDogNS4wIH07XHJcbiAgcmV0dXJuIChpbnB1dFRva2VucyAqIHByaWNpbmcuaW5wdXQpIC8gMV8wMDBfMDAwICsgKG91dHB1dFRva2VucyAqIHByaWNpbmcub3V0cHV0KSAvIDFfMDAwXzAwMDtcclxufVxyXG5cclxuLy8gPT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT1cclxuLy8gVHJhY2sgVXNhZ2VcclxuLy8gPT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT1cclxuXHJcbmV4cG9ydCBhc3luYyBmdW5jdGlvbiB0cmFja1VzYWdlKFxyXG4gIHJlY29yZDogT21pdDxVc2FnZVJlY29yZCwgXCJpZFwiIHwgXCJjb3N0VXNkXCI+LFxyXG4pOiBQcm9taXNlPFVzYWdlUmVjb3JkPiB7XHJcbiAgY29uc3QgY29zdCA9IGNhbGN1bGF0ZUNvc3QocmVjb3JkLm1vZGVsLCByZWNvcmQuaW5wdXRUb2tlbnMsIHJlY29yZC5vdXRwdXRUb2tlbnMpO1xyXG4gIGNvbnN0IGZ1bGxSZWNvcmQ6IFVzYWdlUmVjb3JkID0ge1xyXG4gICAgLi4ucmVjb3JkLFxyXG4gICAgaWQ6IGAke0RhdGUubm93KCl9LSR7TWF0aC5yYW5kb20oKS50b1N0cmluZygzNikuc3Vic3RyKDIsIDkpfWAsXHJcbiAgICBjb3N0VXNkOiBjb3N0LFxyXG4gIH07XHJcblxyXG4gIHRyeSB7XHJcbiAgICBjb25zdCByZXN1bHQgPSBhd2FpdCBjaHJvbWUuc3RvcmFnZS5sb2NhbC5nZXQoW1NUT1JBR0VfS0VZXSk7XHJcbiAgICBjb25zdCByZWNvcmRzOiBVc2FnZVJlY29yZFtdID0gcmVzdWx0W1NUT1JBR0VfS0VZXSB8fCBbXTtcclxuXHJcbiAgICByZWNvcmRzLnB1c2goZnVsbFJlY29yZCk7XHJcblxyXG4gICAgLy8gS2VlcCBvbmx5IGxhc3QgTUFYX1JFQ09SRFNcclxuICAgIGlmIChyZWNvcmRzLmxlbmd0aCA+IE1BWF9SRUNPUkRTKSB7XHJcbiAgICAgIHJlY29yZHMuc3BsaWNlKDAsIHJlY29yZHMubGVuZ3RoIC0gTUFYX1JFQ09SRFMpO1xyXG4gICAgfVxyXG5cclxuICAgIGF3YWl0IGNocm9tZS5zdG9yYWdlLmxvY2FsLnNldCh7IFtTVE9SQUdFX0tFWV06IHJlY29yZHMgfSk7XHJcblxyXG4gICAgLy8gQWxzbyBzYXZlIGFzIGxhc3RBaVJlc3BvbnNlIGZvciB0aGUgaW5zcGVjdG9yXHJcbiAgICBhd2FpdCBjaHJvbWUuc3RvcmFnZS5sb2NhbC5zZXQoeyBsYXN0QWlSZXNwb25zZTogZnVsbFJlY29yZCB9KTtcclxuXHJcbiAgICAvLyBVcGRhdGUgc3RvcmFnZSBiYWRnZSBhc3luY2hyb25vdXNseSAobm9uLWJsb2NraW5nKVxyXG4gICAgdXBkYXRlU3RvcmFnZUJhZGdlKCkuY2F0Y2goKCkgPT4ge30pO1xyXG5cclxuICAgIGxvZyhcclxuICAgICAgXCJbU3R1ZHkgQXNzaXN0XSBVc2FnZSB0cmFja2VkOlwiLFxyXG4gICAgICBmdWxsUmVjb3JkLnNvdXJjZSxcclxuICAgICAgZnVsbFJlY29yZC5tb2RlbCxcclxuICAgICAgYCQke2Nvc3QudG9GaXhlZCg2KX1gLFxyXG4gICAgICBgJHtmdWxsUmVjb3JkLmlucHV0VG9rZW5zfSske2Z1bGxSZWNvcmQub3V0cHV0VG9rZW5zfSB0b2tlbnNgLFxyXG4gICAgKTtcclxuICB9IGNhdGNoIChlcnJvcikge1xyXG4gICAgY29uc29sZS5lcnJvcihcIltTdHVkeSBBc3Npc3RdIEVycm9yIHRyYWNraW5nIHVzYWdlOlwiLCBlcnJvcik7XHJcbiAgfVxyXG5cclxuICByZXR1cm4gZnVsbFJlY29yZDtcclxufVxyXG5cclxuLy8gPT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT1cclxuLy8gUmV0cmlldmUgUmVjb3JkcyAmIFN0YXRzXHJcbi8vID09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09XHJcblxyXG5leHBvcnQgYXN5bmMgZnVuY3Rpb24gZ2V0VXNhZ2VSZWNvcmRzKCk6IFByb21pc2U8VXNhZ2VSZWNvcmRbXT4ge1xyXG4gIGNvbnN0IHJlc3VsdCA9IGF3YWl0IGNocm9tZS5zdG9yYWdlLmxvY2FsLmdldChbU1RPUkFHRV9LRVldKTtcclxuICByZXR1cm4gcmVzdWx0W1NUT1JBR0VfS0VZXSB8fCBbXTtcclxufVxyXG5cclxuZXhwb3J0IGFzeW5jIGZ1bmN0aW9uIGdldFVzYWdlU3RhdHMoKTogUHJvbWlzZTxVc2FnZVN0YXRzPiB7XHJcbiAgY29uc3QgcmVjb3JkcyA9IGF3YWl0IGdldFVzYWdlUmVjb3JkcygpO1xyXG4gIGNvbnN0IHRvZGF5ID0gbmV3IERhdGUoKS50b0lTT1N0cmluZygpLnNwbGl0KFwiVFwiKVswXTtcclxuXHJcbiAgY29uc3QgZW1wdHlBaSA9ICgpOiBBaVN0YXRzID0+ICh7XHJcbiAgICB0b3RhbFJlcXVlc3RzOiAwLCB0b3RhbElucHV0VG9rZW5zOiAwLCB0b3RhbE91dHB1dFRva2VuczogMCwgdG90YWxDb3N0VXNkOiAwLFxyXG4gICAgdG9kYXlSZXF1ZXN0czogMCwgdG9kYXlJbnB1dFRva2VuczogMCwgdG9kYXlPdXRwdXRUb2tlbnM6IDAsIHRvZGF5Q29zdFVzZDogMCxcclxuICB9KTtcclxuXHJcbiAgY29uc3Qgc3RhdHM6IFVzYWdlU3RhdHMgPSB7XHJcbiAgICB0b3RhbFJlcXVlc3RzOiByZWNvcmRzLmxlbmd0aCxcclxuICAgIHRvdGFsSW5wdXRUb2tlbnM6IDAsXHJcbiAgICB0b3RhbE91dHB1dFRva2VuczogMCxcclxuICAgIHRvdGFsQ29zdFVzZDogMCxcclxuICAgIHF1ZXN0aW9uc0Fuc3dlcmVkOiAwLFxyXG4gICAgc3VjY2Vzc1JhdGU6IDAsXHJcbiAgICBhdmdMYXRlbmN5TXM6IDAsXHJcbiAgICBieVNvdXJjZToge30sXHJcbiAgICBieU1vZGVsOiB7fSxcclxuICAgIGJ5RGF5OiB7fSxcclxuICAgIGJ5UGxhdGZvcm06IHt9LFxyXG4gICAgdG9kYXlSZXF1ZXN0czogMCxcclxuICAgIHRvZGF5Q29zdDogMCxcclxuICAgIHRvZGF5VG9rZW5zOiAwLFxyXG4gICAgZGVlcHNlZWs6IGVtcHR5QWkoKSxcclxuICAgIGNsYXVkZTogZW1wdHlBaSgpLFxyXG4gIH07XHJcblxyXG4gIGxldCB0b3RhbExhdGVuY3kgPSAwO1xyXG4gIGxldCBzdWNjZXNzQ291bnQgPSAwO1xyXG5cclxuICBmb3IgKGNvbnN0IHIgb2YgcmVjb3Jkcykge1xyXG4gICAgc3RhdHMudG90YWxJbnB1dFRva2VucyArPSByLmlucHV0VG9rZW5zO1xyXG4gICAgc3RhdHMudG90YWxPdXRwdXRUb2tlbnMgKz0gci5vdXRwdXRUb2tlbnM7XHJcbiAgICBzdGF0cy50b3RhbENvc3RVc2QgKz0gci5jb3N0VXNkO1xyXG5cclxuICAgIGlmIChyLnN1Y2Nlc3MpIHtcclxuICAgICAgc3VjY2Vzc0NvdW50Kys7XHJcbiAgICAgIHN0YXRzLnF1ZXN0aW9uc0Fuc3dlcmVkKys7XHJcbiAgICB9XHJcbiAgICB0b3RhbExhdGVuY3kgKz0gci5sYXRlbmN5TXM7XHJcblxyXG4gICAgc3RhdHMuYnlTb3VyY2Vbci5zb3VyY2VdID0gKHN0YXRzLmJ5U291cmNlW3Iuc291cmNlXSB8fCAwKSArIDE7XHJcbiAgICBzdGF0cy5ieU1vZGVsW3IubW9kZWxdID0gKHN0YXRzLmJ5TW9kZWxbci5tb2RlbF0gfHwgMCkgKyAxO1xyXG5cclxuICAgIGNvbnN0IHBsYXQgPSByLnBsYXRmb3JtIHx8IFwib3RoZXJcIjtcclxuICAgIHN0YXRzLmJ5UGxhdGZvcm1bcGxhdF0gPSAoc3RhdHMuYnlQbGF0Zm9ybVtwbGF0XSB8fCAwKSArIDE7XHJcblxyXG4gICAgY29uc3QgZGF5ID0gbmV3IERhdGUoci50aW1lc3RhbXApLnRvSVNPU3RyaW5nKCkuc3BsaXQoXCJUXCIpWzBdO1xyXG4gICAgaWYgKCFzdGF0cy5ieURheVtkYXldKSBzdGF0cy5ieURheVtkYXldID0geyByZXF1ZXN0czogMCwgY29zdDogMCwgdG9rZW5zOiAwIH07XHJcbiAgICBzdGF0cy5ieURheVtkYXldLnJlcXVlc3RzKys7XHJcbiAgICBzdGF0cy5ieURheVtkYXldLmNvc3QgKz0gci5jb3N0VXNkO1xyXG4gICAgc3RhdHMuYnlEYXlbZGF5XS50b2tlbnMgKz0gci5pbnB1dFRva2VucyArIHIub3V0cHV0VG9rZW5zO1xyXG5cclxuICAgIGNvbnN0IGlzVG9kYXkgPSBkYXkgPT09IHRvZGF5O1xyXG5cclxuICAgIGlmIChpc1RvZGF5KSB7XHJcbiAgICAgIHN0YXRzLnRvZGF5UmVxdWVzdHMrKztcclxuICAgICAgc3RhdHMudG9kYXlDb3N0ICs9IHIuY29zdFVzZDtcclxuICAgICAgc3RhdHMudG9kYXlUb2tlbnMgKz0gci5pbnB1dFRva2VucyArIHIub3V0cHV0VG9rZW5zO1xyXG4gICAgfVxyXG5cclxuICAgIC8vIFBlci1BSSBhY2N1bXVsYXRpb25cclxuICAgIGNvbnN0IGFpID0gci5zb3VyY2UgPT09IFwiZGVlcHNlZWtcIiA/IHN0YXRzLmRlZXBzZWVrXHJcbiAgICAgIDogci5zb3VyY2UgPT09IFwiY2xhdWRlXCIgPyBzdGF0cy5jbGF1ZGUgOiBudWxsO1xyXG4gICAgaWYgKGFpKSB7XHJcbiAgICAgIGFpLnRvdGFsUmVxdWVzdHMrKztcclxuICAgICAgYWkudG90YWxJbnB1dFRva2VucyArPSByLmlucHV0VG9rZW5zO1xyXG4gICAgICBhaS50b3RhbE91dHB1dFRva2VucyArPSByLm91dHB1dFRva2VucztcclxuICAgICAgYWkudG90YWxDb3N0VXNkICs9IHIuY29zdFVzZDtcclxuICAgICAgaWYgKGlzVG9kYXkpIHtcclxuICAgICAgICBhaS50b2RheVJlcXVlc3RzKys7XHJcbiAgICAgICAgYWkudG9kYXlJbnB1dFRva2VucyArPSByLmlucHV0VG9rZW5zO1xyXG4gICAgICAgIGFpLnRvZGF5T3V0cHV0VG9rZW5zICs9IHIub3V0cHV0VG9rZW5zO1xyXG4gICAgICAgIGFpLnRvZGF5Q29zdFVzZCArPSByLmNvc3RVc2Q7XHJcbiAgICAgIH1cclxuICAgIH1cclxuICB9XHJcblxyXG4gIHN0YXRzLnN1Y2Nlc3NSYXRlID0gcmVjb3Jkcy5sZW5ndGggPiAwID8gKHN1Y2Nlc3NDb3VudCAvIHJlY29yZHMubGVuZ3RoKSAqIDEwMCA6IDA7XHJcbiAgc3RhdHMuYXZnTGF0ZW5jeU1zID0gcmVjb3Jkcy5sZW5ndGggPiAwID8gdG90YWxMYXRlbmN5IC8gcmVjb3Jkcy5sZW5ndGggOiAwO1xyXG5cclxuICByZXR1cm4gc3RhdHM7XHJcbn1cclxuXHJcbmV4cG9ydCBhc3luYyBmdW5jdGlvbiBnZXRSZWNlbnRIaXN0b3J5KGxpbWl0OiBudW1iZXIgPSAyMCk6IFByb21pc2U8VXNhZ2VSZWNvcmRbXT4ge1xyXG4gIGNvbnN0IHJlY29yZHMgPSBhd2FpdCBnZXRVc2FnZVJlY29yZHMoKTtcclxuICByZXR1cm4gcmVjb3Jkcy5zbGljZSgtbGltaXQpLnJldmVyc2UoKTtcclxufVxyXG5cclxuZXhwb3J0IGFzeW5jIGZ1bmN0aW9uIGNsZWFyVXNhZ2VEYXRhKCk6IFByb21pc2U8dm9pZD4ge1xyXG4gIGF3YWl0IGNocm9tZS5zdG9yYWdlLmxvY2FsLnNldCh7IFtTVE9SQUdFX0tFWV06IFtdIH0pO1xyXG4gIGF3YWl0IGNocm9tZS5zdG9yYWdlLmxvY2FsLnJlbW92ZShbXCJsYXN0QWlSZXNwb25zZVwiXSk7XHJcbiAgYXdhaXQgdXBkYXRlU3RvcmFnZUJhZGdlKCk7XHJcbn1cclxuXHJcbi8vID09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09XHJcbi8vIFN0b3JhZ2UgTGltaXQgTWFuYWdlbWVudFxyXG4vLyA9PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PVxyXG5cclxuY29uc3QgU1RPUkFHRV9MSU1JVF9CWVRFUyA9IDUgKiAxMDI0ICogMTAyNDsgLy8gNSBNQlxyXG5jb25zdCBTVE9SQUdFX1dBUk5fVEhSRVNIT0xEID0gMC43MDsgICAgICAgICAgLy8gNzAlIFx1MjE5MiB3YXJuaW5nIGJhZGdlXHJcbmNvbnN0IFNUT1JBR0VfQ1JJVF9USFJFU0hPTEQgPSAwLjkwOyAgICAgICAgICAvLyA5MCUgXHUyMTkyIGNyaXRpY2FsIGJhZGdlXHJcblxyXG5leHBvcnQgaW50ZXJmYWNlIFN0b3JhZ2VJbmZvIHtcclxuICBieXRlc1VzZWQ6IG51bWJlcjtcclxuICBieXRlc1RvdGFsOiBudW1iZXI7XHJcbiAgcGVyY2VudDogbnVtYmVyO1xyXG4gIGxldmVsOiBcIm9rXCIgfCBcIndhcm5pbmdcIiB8IFwiY3JpdGljYWxcIjtcclxufVxyXG5cclxuZXhwb3J0IGFzeW5jIGZ1bmN0aW9uIGdldFN0b3JhZ2VJbmZvKCk6IFByb21pc2U8U3RvcmFnZUluZm8+IHtcclxuICBjb25zdCBieXRlc1VzZWQgPSBhd2FpdCBjaHJvbWUuc3RvcmFnZS5sb2NhbC5nZXRCeXRlc0luVXNlKG51bGwpO1xyXG4gIGNvbnN0IHBlcmNlbnQgPSBieXRlc1VzZWQgLyBTVE9SQUdFX0xJTUlUX0JZVEVTO1xyXG4gIGNvbnN0IGxldmVsOiBTdG9yYWdlSW5mb1tcImxldmVsXCJdID1cclxuICAgIHBlcmNlbnQgPj0gU1RPUkFHRV9DUklUX1RIUkVTSE9MRCA/IFwiY3JpdGljYWxcIlxyXG4gICAgOiBwZXJjZW50ID49IFNUT1JBR0VfV0FSTl9USFJFU0hPTEQgPyBcIndhcm5pbmdcIlxyXG4gICAgOiBcIm9rXCI7XHJcbiAgcmV0dXJuIHsgYnl0ZXNVc2VkLCBieXRlc1RvdGFsOiBTVE9SQUdFX0xJTUlUX0JZVEVTLCBwZXJjZW50LCBsZXZlbCB9O1xyXG59XHJcblxyXG5leHBvcnQgYXN5bmMgZnVuY3Rpb24gdXBkYXRlU3RvcmFnZUJhZGdlKCk6IFByb21pc2U8dm9pZD4ge1xyXG4gIHRyeSB7XHJcbiAgICBjb25zdCBpbmZvID0gYXdhaXQgZ2V0U3RvcmFnZUluZm8oKTtcclxuICAgIGlmIChpbmZvLmxldmVsID09PSBcImNyaXRpY2FsXCIpIHtcclxuICAgICAgYXdhaXQgY2hyb21lLmFjdGlvbi5zZXRCYWRnZVRleHQoeyB0ZXh0OiBcIiFcIiB9KTtcclxuICAgICAgYXdhaXQgY2hyb21lLmFjdGlvbi5zZXRCYWRnZUJhY2tncm91bmRDb2xvcih7IGNvbG9yOiBcIiNlNTM5MzVcIiB9KTtcclxuICAgIH0gZWxzZSBpZiAoaW5mby5sZXZlbCA9PT0gXCJ3YXJuaW5nXCIpIHtcclxuICAgICAgYXdhaXQgY2hyb21lLmFjdGlvbi5zZXRCYWRnZVRleHQoeyB0ZXh0OiBcIiFcIiB9KTtcclxuICAgICAgYXdhaXQgY2hyb21lLmFjdGlvbi5zZXRCYWRnZUJhY2tncm91bmRDb2xvcih7IGNvbG9yOiBcIiNGRjk4MDBcIiB9KTtcclxuICAgIH0gZWxzZSB7XHJcbiAgICAgIGF3YWl0IGNocm9tZS5hY3Rpb24uc2V0QmFkZ2VUZXh0KHsgdGV4dDogXCJcIiB9KTtcclxuICAgIH1cclxuICB9IGNhdGNoIChfKSB7XHJcbiAgICAvLyBCYWRnZSB1cGRhdGUgZmFpbGVkIHNpbGVudGx5IChlLmcuIHNlcnZpY2Ugd29ya2VyIGNvbnRleHQgaXNzdWUpXHJcbiAgfVxyXG59XHJcblxyXG5leHBvcnQgYXN5bmMgZnVuY3Rpb24gdHJpbUhpc3Rvcnkob3B0aW9uczogeyBrZWVwTGFzdD86IG51bWJlcjsga2VlcERheXM/OiBudW1iZXIgfSk6IFByb21pc2U8bnVtYmVyPiB7XHJcbiAgY29uc3QgcmVzdWx0ID0gYXdhaXQgY2hyb21lLnN0b3JhZ2UubG9jYWwuZ2V0KFtTVE9SQUdFX0tFWV0pO1xyXG4gIGNvbnN0IHJlY29yZHM6IFVzYWdlUmVjb3JkW10gPSByZXN1bHRbU1RPUkFHRV9LRVldIHx8IFtdO1xyXG4gIGNvbnN0IG9yaWdpbmFsTGVuZ3RoID0gcmVjb3Jkcy5sZW5ndGg7XHJcblxyXG4gIGxldCBmaWx0ZXJlZCA9IFsuLi5yZWNvcmRzXTtcclxuXHJcbiAgaWYgKG9wdGlvbnMua2VlcERheXMgIT09IHVuZGVmaW5lZCkge1xyXG4gICAgY29uc3QgY3V0b2ZmID0gRGF0ZS5ub3coKSAtIG9wdGlvbnMua2VlcERheXMgKiAyNCAqIDYwICogNjAgKiAxMDAwO1xyXG4gICAgZmlsdGVyZWQgPSBmaWx0ZXJlZC5maWx0ZXIociA9PiByLnRpbWVzdGFtcCA+PSBjdXRvZmYpO1xyXG4gIH1cclxuXHJcbiAgaWYgKG9wdGlvbnMua2VlcExhc3QgIT09IHVuZGVmaW5lZCAmJiBmaWx0ZXJlZC5sZW5ndGggPiBvcHRpb25zLmtlZXBMYXN0KSB7XHJcbiAgICAvLyByZWNvcmRzIGFyZSBvbGRlc3QtZmlyc3Q7IGtlZXAgdGhlIGxhc3QgTiAobW9zdCByZWNlbnQpXHJcbiAgICBmaWx0ZXJlZCA9IGZpbHRlcmVkLnNsaWNlKGZpbHRlcmVkLmxlbmd0aCAtIG9wdGlvbnMua2VlcExhc3QpO1xyXG4gIH1cclxuXHJcbiAgYXdhaXQgY2hyb21lLnN0b3JhZ2UubG9jYWwuc2V0KHsgW1NUT1JBR0VfS0VZXTogZmlsdGVyZWQgfSk7XHJcbiAgYXdhaXQgdXBkYXRlU3RvcmFnZUJhZGdlKCk7XHJcbiAgcmV0dXJuIG9yaWdpbmFsTGVuZ3RoIC0gZmlsdGVyZWQubGVuZ3RoO1xyXG59XHJcbiIsICIvKipcclxuICogQmFja2dyb3VuZCBTZXJ2aWNlIFdvcmtlciAtIFNtYXJ0IFJhdGUgTGltaXRpbmdcclxuICogUHJldmVudHMgYWJ1c2Ugd2l0aG91dCBibG9ja2luZyBub3JtYWwgdXNhZ2UgcGF0dGVybnNcclxuICpcclxuICogUGhpbG9zb3BoeTogRG9uJ3QgcGVuYWxpc2UgYSB1c2VyIHdobyBjbGlja3MgcXVpY2tseSBiZXR3ZWVuIGRpZmZlcmVudCBxdWVzdGlvbnMuXHJcbiAqIE9ubHkga2ljayBpbiB3aGVuIHRoZSBzYW1lIHF1ZXN0aW9uIGlzIHJlLXNlbnQgcmVwZWF0ZWRseSwgb3Igb3ZlcmFsbCB2b2x1bWUgaXNcclxuICogdW5yZWFzb25hYmx5IGhpZ2guXHJcbiAqL1xyXG5cclxuaW1wb3J0IHsgbG9nIH0gZnJvbSBcIi4vY29uc3RhbnRzLmpzXCI7XHJcblxyXG4vLyA9PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PVxyXG4vLyBJbnRlcm5hbCBTdGF0ZVxyXG4vLyA9PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PVxyXG5cclxuaW50ZXJmYWNlIFJhdGVMaW1pdFN0YXRlIHtcclxuICAvKiogcXVlc3Rpb24gaGFzaCBcdTIxOTIgYXJyYXkgb2YgcmVxdWVzdCB0aW1lc3RhbXBzICovXHJcbiAgcXVlc3Rpb25SZXF1ZXN0czogUmVjb3JkPHN0cmluZywgbnVtYmVyW10+O1xyXG4gIC8qKiBnbG9iYWwgcmVxdWVzdCB0aW1lc3RhbXBzICovXHJcbiAgZ2xvYmFsUmVxdWVzdHM6IG51bWJlcltdO1xyXG4gIC8qKiBjb29sZG93bi11bnRpbCB0aW1lc3RhbXAgKDAgPSBubyBjb29sZG93bikgKi9cclxuICBjb29sZG93blVudGlsOiBudW1iZXI7XHJcbn1cclxuXHJcbmNvbnN0IHN0YXRlOiBSYXRlTGltaXRTdGF0ZSA9IHtcclxuICBxdWVzdGlvblJlcXVlc3RzOiB7fSxcclxuICBnbG9iYWxSZXF1ZXN0czogW10sXHJcbiAgY29vbGRvd25VbnRpbDogMCxcclxufTtcclxuXHJcbi8vID09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09XHJcbi8vIENvbmZpZ3VyYXRpb25cclxuLy8gPT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT1cclxuXHJcbi8qKiBNYXggdGltZXMgdGhlICpzYW1lKiBxdWVzdGlvbiBjYW4gYmUgYXNrZWQgd2l0aGluIHRoZSB3aW5kb3cgKi9cclxuY29uc3QgU0FNRV9RVUVTVElPTl9NQVggPSAzO1xyXG4vKiogV2luZG93IGZvciBzYW1lLXF1ZXN0aW9uIHRyYWNraW5nICgyIG1pbnV0ZXMpICovXHJcbmNvbnN0IFNBTUVfUVVFU1RJT05fV0lORE9XX01TID0gMTIwXzAwMDtcclxuXHJcbi8qKiBNYXggdG90YWwgcmVxdWVzdHMgaW4gdGhlIGdsb2JhbCB3aW5kb3cgKi9cclxuY29uc3QgR0xPQkFMX01BWCA9IDE1O1xyXG4vKiogR2xvYmFsIHdpbmRvdyAoMSBtaW51dGUpICovXHJcbmNvbnN0IEdMT0JBTF9XSU5ET1dfTVMgPSA2MF8wMDA7XHJcblxyXG4vKiogSG93IGxvbmcgdGhlIGNvb2xkb3duIGxhc3RzIG9uY2UgdHJpZ2dlcmVkICovXHJcbmNvbnN0IENPT0xET1dOX0RVUkFUSU9OX01TID0gMzBfMDAwO1xyXG5cclxuLy8gPT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT1cclxuLy8gSGVscGVyc1xyXG4vLyA9PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PVxyXG5cclxuZnVuY3Rpb24gaGFzaFF1ZXN0aW9uKHRleHQ6IHN0cmluZyk6IHN0cmluZyB7XHJcbiAgY29uc3Qgbm9ybWFsaXNlZCA9IHRleHRcclxuICAgIC50b0xvd2VyQ2FzZSgpXHJcbiAgICAudHJpbSgpXHJcbiAgICAucmVwbGFjZSgvXFxzKy9nLCBcIiBcIilcclxuICAgIC5zdWJzdHJpbmcoMCwgMjAwKTtcclxuICBsZXQgaGFzaCA9IDA7XHJcbiAgZm9yIChsZXQgaSA9IDA7IGkgPCBub3JtYWxpc2VkLmxlbmd0aDsgaSsrKSB7XHJcbiAgICBoYXNoID0gKGhhc2ggPDwgNSkgLSBoYXNoICsgbm9ybWFsaXNlZC5jaGFyQ29kZUF0KGkpO1xyXG4gICAgaGFzaCA9IGhhc2ggJiBoYXNoOyAvLyAzMi1iaXQgaW50XHJcbiAgfVxyXG4gIHJldHVybiBoYXNoLnRvU3RyaW5nKDM2KTtcclxufVxyXG5cclxuZnVuY3Rpb24gcHJ1bmVPbGQodGltZXN0YW1wczogbnVtYmVyW10sIHdpbmRvd01zOiBudW1iZXIpOiBudW1iZXJbXSB7XHJcbiAgY29uc3QgY3V0b2ZmID0gRGF0ZS5ub3coKSAtIHdpbmRvd01zO1xyXG4gIHJldHVybiB0aW1lc3RhbXBzLmZpbHRlcigodCkgPT4gdCA+IGN1dG9mZik7XHJcbn1cclxuXHJcbi8vID09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09XHJcbi8vIFB1YmxpYyBBUElcclxuLy8gPT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT1cclxuXHJcbi8qKlxyXG4gKiBDaGVjayB3aGV0aGVyIGEgcmVxdWVzdCBzaG91bGQgYmUgcmF0ZS1saW1pdGVkLlxyXG4gKiBAcmV0dXJucyBgbnVsbGAgaWYgT0ssIG9yIGFuIGVycm9yIHN0cmluZyBpZiBibG9ja2VkLlxyXG4gKi9cclxuZXhwb3J0IGZ1bmN0aW9uIGNoZWNrUmF0ZUxpbWl0KHF1ZXN0aW9uVGV4dDogc3RyaW5nKTogc3RyaW5nIHwgbnVsbCB7XHJcbiAgY29uc3Qgbm93ID0gRGF0ZS5ub3coKTtcclxuXHJcbiAgLy8gQWN0aXZlIGNvb2xkb3duP1xyXG4gIGlmIChzdGF0ZS5jb29sZG93blVudGlsID4gbm93KSB7XHJcbiAgICBjb25zdCBzZWMgPSBNYXRoLmNlaWwoKHN0YXRlLmNvb2xkb3duVW50aWwgLSBub3cpIC8gMTAwMCk7XHJcbiAgICBsb2coYFtTdHVkeSBBc3Npc3RdIFJhdGUgbGltaXQ6IGNvb2xkb3duLCAke3NlY31zIGxlZnRgKTtcclxuICAgIHJldHVybiBgXHUyM0YzIFJhdGUgbGltaXRlZC4gUGxlYXNlIHdhaXQgJHtzZWN9IHNlY29uZHMuYDtcclxuICB9XHJcblxyXG4gIGNvbnN0IHFIYXNoID0gaGFzaFF1ZXN0aW9uKHF1ZXN0aW9uVGV4dCk7XHJcblxyXG4gIC8vIFBydW5lIHN0YWxlIGVudHJpZXNcclxuICBzdGF0ZS5nbG9iYWxSZXF1ZXN0cyA9IHBydW5lT2xkKHN0YXRlLmdsb2JhbFJlcXVlc3RzLCBHTE9CQUxfV0lORE9XX01TKTtcclxuICBpZiAoc3RhdGUucXVlc3Rpb25SZXF1ZXN0c1txSGFzaF0pIHtcclxuICAgIHN0YXRlLnF1ZXN0aW9uUmVxdWVzdHNbcUhhc2hdID0gcHJ1bmVPbGQoc3RhdGUucXVlc3Rpb25SZXF1ZXN0c1txSGFzaF0sIFNBTUVfUVVFU1RJT05fV0lORE9XX01TKTtcclxuICB9XHJcblxyXG4gIC8vIFNhbWUtcXVlc3Rpb24gY2hlY2tcclxuICBjb25zdCBxQ291bnQgPSBzdGF0ZS5xdWVzdGlvblJlcXVlc3RzW3FIYXNoXT8ubGVuZ3RoID8/IDA7XHJcbiAgaWYgKHFDb3VudCA+PSBTQU1FX1FVRVNUSU9OX01BWCkge1xyXG4gICAgc3RhdGUuY29vbGRvd25VbnRpbCA9IG5vdyArIENPT0xET1dOX0RVUkFUSU9OX01TO1xyXG4gICAgbG9nKGBbU3R1ZHkgQXNzaXN0XSBSYXRlIGxpbWl0OiBzYW1lIHF1ZXN0aW9uIFx1MDBENyR7cUNvdW50fWApO1xyXG4gICAgcmV0dXJuIGBcdTIzRjMgWW91J3ZlIGFza2VkIHRoaXMgcXVlc3Rpb24gJHtxQ291bnR9IHRpbWVzLiBXYWl0IDMwIHMuYDtcclxuICB9XHJcblxyXG4gIC8vIEdsb2JhbCB2b2x1bWUgY2hlY2tcclxuICBpZiAoc3RhdGUuZ2xvYmFsUmVxdWVzdHMubGVuZ3RoID49IEdMT0JBTF9NQVgpIHtcclxuICAgIHN0YXRlLmNvb2xkb3duVW50aWwgPSBub3cgKyBDT09MRE9XTl9EVVJBVElPTl9NUztcclxuICAgIGxvZyhgW1N0dWR5IEFzc2lzdF0gUmF0ZSBsaW1pdDogJHtzdGF0ZS5nbG9iYWxSZXF1ZXN0cy5sZW5ndGh9IHJlcXMgLyBtaW5gKTtcclxuICAgIHJldHVybiBgXHUyM0YzIFRvbyBtYW55IHJlcXVlc3RzLiBXYWl0IDMwIHMuYDtcclxuICB9XHJcblxyXG4gIHJldHVybiBudWxsOyAvLyBPS1xyXG59XHJcblxyXG4vKipcclxuICogUmVjb3JkIHRoYXQgYSByZXF1ZXN0IHdhcyBhY3R1YWxseSBzZW50IChjYWxsIGFmdGVyIGBjaGVja1JhdGVMaW1pdGAgcmV0dXJucyBudWxsKS5cclxuICovXHJcbmV4cG9ydCBmdW5jdGlvbiByZWNvcmRSZXF1ZXN0KHF1ZXN0aW9uVGV4dDogc3RyaW5nKTogdm9pZCB7XHJcbiAgY29uc3Qgbm93ID0gRGF0ZS5ub3coKTtcclxuICBjb25zdCBxSGFzaCA9IGhhc2hRdWVzdGlvbihxdWVzdGlvblRleHQpO1xyXG5cclxuICBpZiAoIXN0YXRlLnF1ZXN0aW9uUmVxdWVzdHNbcUhhc2hdKSB7XHJcbiAgICBzdGF0ZS5xdWVzdGlvblJlcXVlc3RzW3FIYXNoXSA9IFtdO1xyXG4gIH1cclxuICBzdGF0ZS5xdWVzdGlvblJlcXVlc3RzW3FIYXNoXS5wdXNoKG5vdyk7XHJcbiAgc3RhdGUuZ2xvYmFsUmVxdWVzdHMucHVzaChub3cpO1xyXG59XHJcblxyXG4vKipcclxuICogSGFyZC1yZXNldCAobW9zdGx5IHVzZWZ1bCBmb3IgdGVzdGluZykuXHJcbiAqL1xyXG5leHBvcnQgZnVuY3Rpb24gcmVzZXRSYXRlTGltaXQoKTogdm9pZCB7XHJcbiAgc3RhdGUucXVlc3Rpb25SZXF1ZXN0cyA9IHt9O1xyXG4gIHN0YXRlLmdsb2JhbFJlcXVlc3RzID0gW107XHJcbiAgc3RhdGUuY29vbGRvd25VbnRpbCA9IDA7XHJcbn1cclxuIiwgIi8qKlxyXG4gKiBCYWNrZ3JvdW5kIFNlcnZpY2UgV29ya2VyIC0gQ2xhdWRlIFN0cmVhbWluZ1xyXG4gKiBQYXJzZXMgU2VydmVyLVNlbnQgRXZlbnRzIChTU0UpIGZyb20gdGhlIENsYXVkZSBNZXNzYWdlcyBBUElcclxuICovXHJcblxyXG5pbXBvcnQgeyBsb2csIENMQVVERV9BUElfQkFTRSwgQU5USFJPUElDX1ZFUlNJT04gfSBmcm9tIFwiLi9jb25zdGFudHMuanNcIjtcclxuaW1wb3J0IHR5cGUgeyBDbGF1ZGVNZXNzYWdlIH0gZnJvbSBcIi4vY29uc3RhbnRzLmpzXCI7XHJcblxyXG4vLyA9PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PVxyXG4vLyBUeXBlc1xyXG4vLyA9PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PVxyXG5cclxuZXhwb3J0IGludGVyZmFjZSBTdHJlYW1DYWxsYmFja3Mge1xyXG4gIG9uQ2h1bms6ICh0ZXh0OiBzdHJpbmcpID0+IHZvaWQ7XHJcbiAgb25JbnB1dFRva2VuczogKGNvdW50OiBudW1iZXIpID0+IHZvaWQ7XHJcbiAgb25Db21wbGV0ZTogKG91dHB1dFRva2VuczogbnVtYmVyKSA9PiB2b2lkO1xyXG4gIG9uRXJyb3I6IChlcnJvcjogc3RyaW5nKSA9PiB2b2lkO1xyXG59XHJcblxyXG5leHBvcnQgaW50ZXJmYWNlIFN0cmVhbVJlc3VsdCB7XHJcbiAgZnVsbFRleHQ6IHN0cmluZztcclxuICBpbnB1dFRva2VuczogbnVtYmVyO1xyXG4gIG91dHB1dFRva2VuczogbnVtYmVyO1xyXG59XHJcblxyXG4vLyA9PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PVxyXG4vLyBTdHJlYW1pbmcgRmV0Y2hcclxuLy8gPT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT1cclxuXHJcbi8qKlxyXG4gKiBNYWtlIGEgc3RyZWFtaW5nIHJlcXVlc3QgdG8gdGhlIENsYXVkZSBNZXNzYWdlcyBBUEkgYW5kIGludm9rZSBjYWxsYmFja3NcclxuICogYXMgU1NFIGV2ZW50cyBhcnJpdmUuXHJcbiAqL1xyXG5leHBvcnQgYXN5bmMgZnVuY3Rpb24gc3RyZWFtQ2xhdWRlUmVzcG9uc2UoXHJcbiAgYXBpS2V5OiBzdHJpbmcsXHJcbiAgbW9kZWw6IHN0cmluZyxcclxuICBtZXNzYWdlczogQ2xhdWRlTWVzc2FnZVtdLFxyXG4gIG1heFRva2VuczogbnVtYmVyLFxyXG4gIGNhbGxiYWNrczogU3RyZWFtQ2FsbGJhY2tzLFxyXG4gIHNpZ25hbD86IEFib3J0U2lnbmFsLFxyXG4pOiBQcm9taXNlPFN0cmVhbVJlc3VsdD4ge1xyXG4gIGNvbnN0IHJlc3BvbnNlID0gYXdhaXQgZmV0Y2goQ0xBVURFX0FQSV9CQVNFLCB7XHJcbiAgICBtZXRob2Q6IFwiUE9TVFwiLFxyXG4gICAgaGVhZGVyczoge1xyXG4gICAgICBcIkNvbnRlbnQtVHlwZVwiOiBcImFwcGxpY2F0aW9uL2pzb25cIixcclxuICAgICAgXCJ4LWFwaS1rZXlcIjogYXBpS2V5LFxyXG4gICAgICBcImFudGhyb3BpYy12ZXJzaW9uXCI6IEFOVEhST1BJQ19WRVJTSU9OLFxyXG4gICAgICBcImFudGhyb3BpYy1kYW5nZXJvdXMtZGlyZWN0LWJyb3dzZXItYWNjZXNzXCI6IFwidHJ1ZVwiLFxyXG4gICAgfSxcclxuICAgIGJvZHk6IEpTT04uc3RyaW5naWZ5KHtcclxuICAgICAgbW9kZWwsXHJcbiAgICAgIG1heF90b2tlbnM6IG1heFRva2VucyxcclxuICAgICAgbWVzc2FnZXMsXHJcbiAgICAgIHN0cmVhbTogdHJ1ZSxcclxuICAgIH0pLFxyXG4gICAgc2lnbmFsLFxyXG4gIH0pO1xyXG5cclxuICBpZiAoIXJlc3BvbnNlLm9rKSB7XHJcbiAgICBjb25zdCBlcnJvckJvZHkgPSBhd2FpdCByZXNwb25zZS50ZXh0KCk7XHJcbiAgICBsZXQgZXJyb3JNc2cgPSBgQVBJIEVycm9yICgke3Jlc3BvbnNlLnN0YXR1c30pYDtcclxuICAgIHRyeSB7XHJcbiAgICAgIGNvbnN0IHBhcnNlZCA9IEpTT04ucGFyc2UoZXJyb3JCb2R5KTtcclxuICAgICAgZXJyb3JNc2cgPSBwYXJzZWQuZXJyb3I/Lm1lc3NhZ2UgfHwgZXJyb3JNc2c7XHJcbiAgICB9IGNhdGNoIHtcclxuICAgICAgLyoga2VlcCBnZW5lcmljIG1lc3NhZ2UgKi9cclxuICAgIH1cclxuICAgIHRocm93IG5ldyBFcnJvcihlcnJvck1zZyk7XHJcbiAgfVxyXG5cclxuICBjb25zdCByZWFkZXIgPSByZXNwb25zZS5ib2R5IS5nZXRSZWFkZXIoKTtcclxuICBjb25zdCBkZWNvZGVyID0gbmV3IFRleHREZWNvZGVyKCk7XHJcbiAgbGV0IGZ1bGxUZXh0ID0gXCJcIjtcclxuICBsZXQgaW5wdXRUb2tlbnMgPSAwO1xyXG4gIGxldCBvdXRwdXRUb2tlbnMgPSAwO1xyXG4gIGxldCBidWZmZXIgPSBcIlwiO1xyXG5cclxuICB0cnkge1xyXG4gICAgd2hpbGUgKHRydWUpIHtcclxuICAgICAgY29uc3QgeyBkb25lLCB2YWx1ZSB9ID0gYXdhaXQgcmVhZGVyLnJlYWQoKTtcclxuICAgICAgaWYgKGRvbmUpIGJyZWFrO1xyXG5cclxuICAgICAgYnVmZmVyICs9IGRlY29kZXIuZGVjb2RlKHZhbHVlLCB7IHN0cmVhbTogdHJ1ZSB9KTtcclxuICAgICAgY29uc3QgbGluZXMgPSBidWZmZXIuc3BsaXQoXCJcXG5cIik7XHJcbiAgICAgIGJ1ZmZlciA9IGxpbmVzLnBvcCgpIHx8IFwiXCI7XHJcblxyXG4gICAgICBmb3IgKGNvbnN0IGxpbmUgb2YgbGluZXMpIHtcclxuICAgICAgICBpZiAoIWxpbmUuc3RhcnRzV2l0aChcImRhdGE6IFwiKSkgY29udGludWU7XHJcbiAgICAgICAgY29uc3QgZGF0YSA9IGxpbmUuc2xpY2UoNikudHJpbSgpO1xyXG4gICAgICAgIGlmICghZGF0YSB8fCBkYXRhID09PSBcIltET05FXVwiKSBjb250aW51ZTtcclxuXHJcbiAgICAgICAgdHJ5IHtcclxuICAgICAgICAgIGNvbnN0IGV2ZW50ID0gSlNPTi5wYXJzZShkYXRhKSBhcyBSZWNvcmQ8c3RyaW5nLCB1bmtub3duPjtcclxuXHJcbiAgICAgICAgICBzd2l0Y2ggKGV2ZW50LnR5cGUpIHtcclxuICAgICAgICAgICAgY2FzZSBcIm1lc3NhZ2Vfc3RhcnRcIjoge1xyXG4gICAgICAgICAgICAgIGNvbnN0IG1zZyA9IGV2ZW50Lm1lc3NhZ2UgYXMgUmVjb3JkPHN0cmluZywgdW5rbm93bj4gfCB1bmRlZmluZWQ7XHJcbiAgICAgICAgICAgICAgY29uc3QgdXNhZ2UgPSBtc2c/LnVzYWdlIGFzIFJlY29yZDxzdHJpbmcsIG51bWJlcj4gfCB1bmRlZmluZWQ7XHJcbiAgICAgICAgICAgICAgaWYgKHVzYWdlPy5pbnB1dF90b2tlbnMpIHtcclxuICAgICAgICAgICAgICAgIGlucHV0VG9rZW5zID0gdXNhZ2UuaW5wdXRfdG9rZW5zO1xyXG4gICAgICAgICAgICAgICAgY2FsbGJhY2tzLm9uSW5wdXRUb2tlbnMoaW5wdXRUb2tlbnMpO1xyXG4gICAgICAgICAgICAgIH1cclxuICAgICAgICAgICAgICBicmVhaztcclxuICAgICAgICAgICAgfVxyXG5cclxuICAgICAgICAgICAgY2FzZSBcImNvbnRlbnRfYmxvY2tfZGVsdGFcIjoge1xyXG4gICAgICAgICAgICAgIGNvbnN0IGRlbHRhID0gZXZlbnQuZGVsdGEgYXMgUmVjb3JkPHN0cmluZywgdW5rbm93bj4gfCB1bmRlZmluZWQ7XHJcbiAgICAgICAgICAgICAgaWYgKGRlbHRhPy50eXBlID09PSBcInRleHRfZGVsdGFcIiAmJiB0eXBlb2YgZGVsdGEudGV4dCA9PT0gXCJzdHJpbmdcIikge1xyXG4gICAgICAgICAgICAgICAgZnVsbFRleHQgKz0gZGVsdGEudGV4dDtcclxuICAgICAgICAgICAgICAgIGNhbGxiYWNrcy5vbkNodW5rKGRlbHRhLnRleHQpO1xyXG4gICAgICAgICAgICAgIH1cclxuICAgICAgICAgICAgICBicmVhaztcclxuICAgICAgICAgICAgfVxyXG5cclxuICAgICAgICAgICAgY2FzZSBcIm1lc3NhZ2VfZGVsdGFcIjoge1xyXG4gICAgICAgICAgICAgIGNvbnN0IHVzYWdlID0gZXZlbnQudXNhZ2UgYXMgUmVjb3JkPHN0cmluZywgbnVtYmVyPiB8IHVuZGVmaW5lZDtcclxuICAgICAgICAgICAgICBpZiAodXNhZ2U/Lm91dHB1dF90b2tlbnMpIHtcclxuICAgICAgICAgICAgICAgIG91dHB1dFRva2VucyA9IHVzYWdlLm91dHB1dF90b2tlbnM7XHJcbiAgICAgICAgICAgICAgfVxyXG4gICAgICAgICAgICAgIGJyZWFrO1xyXG4gICAgICAgICAgICB9XHJcblxyXG4gICAgICAgICAgICBjYXNlIFwibWVzc2FnZV9zdG9wXCI6XHJcbiAgICAgICAgICAgICAgY2FsbGJhY2tzLm9uQ29tcGxldGUob3V0cHV0VG9rZW5zKTtcclxuICAgICAgICAgICAgICBicmVhaztcclxuXHJcbiAgICAgICAgICAgIGNhc2UgXCJlcnJvclwiOiB7XHJcbiAgICAgICAgICAgICAgY29uc3QgZXJyID0gZXZlbnQuZXJyb3IgYXMgUmVjb3JkPHN0cmluZywgc3RyaW5nPiB8IHVuZGVmaW5lZDtcclxuICAgICAgICAgICAgICBjYWxsYmFja3Mub25FcnJvcihlcnI/Lm1lc3NhZ2UgfHwgXCJTdHJlYW0gZXJyb3JcIik7XHJcbiAgICAgICAgICAgICAgYnJlYWs7XHJcbiAgICAgICAgICAgIH1cclxuICAgICAgICAgIH1cclxuICAgICAgICB9IGNhdGNoIHtcclxuICAgICAgICAgIC8vIFNraXAgdW5wYXJzZWFibGUgU1NFIGxpbmVzXHJcbiAgICAgICAgfVxyXG4gICAgICB9XHJcbiAgICB9XHJcbiAgfSBjYXRjaCAoZXJyb3IpIHtcclxuICAgIGlmICgoZXJyb3IgYXMgRXJyb3IpLm5hbWUgPT09IFwiQWJvcnRFcnJvclwiKSB0aHJvdyBlcnJvcjtcclxuICAgIGNhbGxiYWNrcy5vbkVycm9yKChlcnJvciBhcyBFcnJvcikubWVzc2FnZSk7XHJcbiAgICB0aHJvdyBlcnJvcjtcclxuICB9XHJcblxyXG4gIHJldHVybiB7IGZ1bGxUZXh0LCBpbnB1dFRva2Vucywgb3V0cHV0VG9rZW5zIH07XHJcbn1cclxuIiwgIi8qKlxyXG4gKiBCYWNrZ3JvdW5kIFNlcnZpY2UgV29ya2VyIC0gQVBJIENvbW11bmljYXRpb25cclxuICogSGFuZGxlcyBDbGF1ZGUgYW5kIERlZXBTZWVrIEFQSSBjYWxscywgc3RyZWFtaW5nLCByYXRlIGxpbWl0aW5nLCBhbmQgdXNhZ2UgdHJhY2tpbmdcclxuICovXHJcblxyXG5pbXBvcnQgdHlwZSB7IEFuYWx5c2lzQ29udGV4dCwgQW5hbHlzaXNSZXNwb25zZSB9IGZyb20gXCIuLi8uLi90eXBlcy9pbmRleC5qc1wiO1xyXG5pbXBvcnQge1xyXG4gIGxvZyxcclxuICBERUJVR19NT0RFLFxyXG4gIENMQVVERV9BUElfQkFTRSxcclxuICBERUZBVUxUX01PREVMLFxyXG4gIEFOVEhST1BJQ19WRVJTSU9OLFxyXG4gIERFRVBTRUVLX0FQSV9CQVNFLFxyXG4gIERFRVBTRUVLX1JFQVNPTkVSX01PREVMLFxyXG4gIGFjdGl2ZURlZXBTZWVrQ29udHJvbGxlcixcclxuICBzZXRBY3RpdmVEZWVwU2Vla0NvbnRyb2xsZXIsXHJcbn0gZnJvbSBcIi4vY29uc3RhbnRzLmpzXCI7XHJcbmltcG9ydCB0eXBlIHtcclxuICBTdG9yYWdlRGF0YSxcclxuICBNZXNzYWdlUmVzcG9uc2UsXHJcbiAgQ2xhdWRlUmVxdWVzdEJvZHksXHJcbiAgQ2xhdWRlTWVzc2FnZSxcclxuICBDbGF1ZGVBcGlSZXNwb25zZSxcclxuICBEZWVwU2Vla1JlcXVlc3RCb2R5LFxyXG4gIERlZXBTZWVrQXBpUmVzcG9uc2UsXHJcbiAgRGVlcFNlZWtBbmFseXNpc1Jlc3VsdCxcclxuICBEZWVwU2Vla0FuYWx5c2lzRm9yQ2xhdWRlLFxyXG59IGZyb20gXCIuL2NvbnN0YW50cy5qc1wiO1xyXG5pbXBvcnQgeyBmZXRjaFdpdGhSZXRyeSB9IGZyb20gXCIuL2ZldGNoVXRpbHMuanNcIjtcclxuaW1wb3J0IHsgbG9nRXJyb3IgfSBmcm9tIFwiLi9mZXRjaFV0aWxzLmpzXCI7XHJcbmltcG9ydCB7IGZpbmRNYXRjaGluZ1F1ZXN0aW9uLCBub3JtYWxpemVGb3JTZWFyY2gsIGNhbGN1bGF0ZVNpbWlsYXJpdHksIGNhbGN1bGF0ZUNvbnRhaW5tZW50IH0gZnJvbSBcIi4vcXVlc3Rpb25CYW5rLmpzXCI7XHJcbmltcG9ydCB7XHJcbiAgYnVpbGREZWVwU2Vla1Byb21wdCxcclxuICBidWlsZENsYXVkZVZhbGlkYXRpb25Qcm9tcHQsXHJcbiAgYnVpbGRBbmFseXNpc1Byb21wdCxcclxuICBidWlsZE1lc3NhZ2VDb250ZW50LFxyXG59IGZyb20gXCIuL3Byb21wdHMuanNcIjtcclxuaW1wb3J0IHtcclxuICBwYXJzZURlZXBTZWVrUmVzcG9uc2UsXHJcbiAgZXh0cmFjdENsYXVkZVF1aWNrQW5zd2VyLFxyXG4gIGhhbmRsZUFwaUVycm9yLFxyXG59IGZyb20gXCIuL3BhcnNpbmcuanNcIjtcclxuaW1wb3J0IHsgZ2V0RGVjcnlwdGVkQXBpS2V5IH0gZnJvbSBcIi4vY3J5cHRvLmpzXCI7XHJcbmltcG9ydCB7IHRyYWNrVXNhZ2UsIGNhbGN1bGF0ZUNvc3QgfSBmcm9tIFwiLi91c2FnZVRyYWNrZXIuanNcIjtcclxuaW1wb3J0IHsgY2hlY2tSYXRlTGltaXQsIHJlY29yZFJlcXVlc3QgfSBmcm9tIFwiLi9yYXRlTGltaXRlci5qc1wiO1xyXG5pbXBvcnQgeyBzdHJlYW1DbGF1ZGVSZXNwb25zZSB9IGZyb20gXCIuL3N0cmVhbWluZy5qc1wiO1xyXG5cclxuY29uc3QgUUFfQ0xBVURFX01PREVMID0gXCJjbGF1ZGUtMy1oYWlrdS0yMDI0MDMwN1wiO1xyXG5cclxuLy8gPT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT1cclxuLy8gUGxhdGZvcm0gRGV0ZWN0aW9uXHJcbi8vID09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09XHJcblxyXG5mdW5jdGlvbiBkZXRlY3RQbGF0Zm9ybShwYWdlVXJsPzogc3RyaW5nKTogc3RyaW5nIHtcclxuICBpZiAoIXBhZ2VVcmwpIHJldHVybiBcIm90aGVyXCI7XHJcbiAgY29uc3QgdXJsID0gcGFnZVVybC50b0xvd2VyQ2FzZSgpO1xyXG4gIFxyXG4gIC8vIE5ldEFjYWQgcGxhdGZvcm1zXHJcbiAgaWYgKHVybC5pbmNsdWRlcyhcIm5ldGFjYWRcIikpIHJldHVybiBcIm5ldGFjYWRcIjtcclxuICBpZiAodXJsLmluY2x1ZGVzKFwic2tpbGxzZm9yYWxsXCIpKSByZXR1cm4gXCJza2lsbHNmb3JhbGxcIjtcclxuICBcclxuICAvLyBFZHVjYXRpb25hbCBpbnN0aXR1dGlvbnNcclxuICBpZiAodXJsLmluY2x1ZGVzKFwiZWR1Y2EtdFwiKSB8fCB1cmwuaW5jbHVkZXMoXCJ1bmFjaC5teFwiKSkgcmV0dXJuIFwiZWR1Y2EtdFwiO1xyXG4gIGlmICh1cmwuaW5jbHVkZXMoXCJ0ZWNubS5teFwiKSB8fCB1cmwuaW5jbHVkZXMoXCJlYWQudHV4dGxhLnRlY25tXCIpKSByZXR1cm4gXCJ0ZWNubVwiO1xyXG4gIGlmICh1cmwuaW5jbHVkZXMoXCJlZHVjYXRcIikpIHJldHVybiBcImVkdWNhdFwiO1xyXG4gIFxyXG4gIC8vIEdlbmVyaWMgTW9vZGxlIChmYWxsYmFjaylcclxuICBpZiAodXJsLmluY2x1ZGVzKFwibW9vZGxlXCIpKSByZXR1cm4gXCJtb29kbGVcIjtcclxuICBcclxuICAvLyBPdGhlciBwbGF0Zm9ybXNcclxuICBpZiAodXJsLmluY2x1ZGVzKFwiY29udGVuaWRvc2RpZ2l0YWxlc1wiKSkgcmV0dXJuIFwiY29udGVuaWRvc2RpZ2l0YWxlc1wiO1xyXG5cclxuICAvLyBRQSBNYW51YWwgc2FuZGJveFxyXG4gIGlmICh1cmwuaW5jbHVkZXMoXCJleGFtcGxlLmNvbVwiKSkgcmV0dXJuIFwicWEtbWFudWFsXCI7XHJcbiAgXHJcbiAgcmV0dXJuIFwib3RoZXJcIjtcclxufVxyXG5cclxuLy8gPT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT1cclxuLy8gQVBJIEtleSBUZXN0aW5nXHJcbi8vID09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09XHJcblxyXG5leHBvcnQgYXN5bmMgZnVuY3Rpb24gdGVzdEFwaUtleShhcGlLZXk6IHN0cmluZyk6IFByb21pc2U8TWVzc2FnZVJlc3BvbnNlPiB7XHJcbiAgY29uc3QgdXJsID0gQ0xBVURFX0FQSV9CQVNFO1xyXG5cclxuICB0cnkge1xyXG4gICAgY29uc3QgcmVxdWVzdEJvZHk6IENsYXVkZVJlcXVlc3RCb2R5ID0ge1xyXG4gICAgICBtb2RlbDogREVGQVVMVF9NT0RFTCxcclxuICAgICAgbWF4X3Rva2VuczogMTAsXHJcbiAgICAgIG1lc3NhZ2VzOiBbeyByb2xlOiBcInVzZXJcIiwgY29udGVudDogXCJIZWxsbywgcmVzcG9uZCB3aXRoIGp1c3QgT0sgdG8gY29uZmlybS5cIiB9XSxcclxuICAgIH07XHJcblxyXG4gICAgY29uc3QgcmVzcG9uc2UgPSBhd2FpdCBmZXRjaCh1cmwsIHtcclxuICAgICAgbWV0aG9kOiBcIlBPU1RcIixcclxuICAgICAgaGVhZGVyczoge1xyXG4gICAgICAgIFwiQ29udGVudC1UeXBlXCI6IFwiYXBwbGljYXRpb24vanNvblwiLFxyXG4gICAgICAgIFwieC1hcGkta2V5XCI6IGFwaUtleSxcclxuICAgICAgICBcImFudGhyb3BpYy12ZXJzaW9uXCI6IEFOVEhST1BJQ19WRVJTSU9OLFxyXG4gICAgICAgIFwiYW50aHJvcGljLWRhbmdlcm91cy1kaXJlY3QtYnJvd3Nlci1hY2Nlc3NcIjogXCJ0cnVlXCIsXHJcbiAgICAgIH0sXHJcbiAgICAgIGJvZHk6IEpTT04uc3RyaW5naWZ5KHJlcXVlc3RCb2R5KSxcclxuICAgIH0pO1xyXG5cclxuICAgIGxldCByZXNwb25zZUJvZHk6IENsYXVkZUFwaVJlc3BvbnNlIHwgbnVsbCA9IG51bGw7XHJcbiAgICB0cnkge1xyXG4gICAgICByZXNwb25zZUJvZHkgPSBhd2FpdCByZXNwb25zZS5jbG9uZSgpLmpzb24oKSBhcyBDbGF1ZGVBcGlSZXNwb25zZTtcclxuICAgIH0gY2F0Y2ggKGUpIHtcclxuICAgICAgcmVzcG9uc2VCb2R5ID0geyBwYXJzZUVycm9yOiAoZSBhcyBFcnJvcikubWVzc2FnZSB9O1xyXG4gICAgfVxyXG5cclxuICAgIGF3YWl0IGxvZ0Vycm9yKHtcclxuICAgICAgdHlwZTogXCJ0ZXN0QXBpS2V5XCIsXHJcbiAgICAgIHVybCxcclxuICAgICAgc3RhdHVzOiByZXNwb25zZS5zdGF0dXMsXHJcbiAgICAgIHN0YXR1c1RleHQ6IHJlc3BvbnNlLnN0YXR1c1RleHQsXHJcbiAgICAgIHJlc3BvbnNlQm9keSxcclxuICAgIH0pO1xyXG5cclxuICAgIGlmIChyZXNwb25zZS5vaykgcmV0dXJuIHsgc3VjY2VzczogdHJ1ZSB9O1xyXG5cclxuICAgIGNvbnN0IGVycm9yTWVzc2FnZSA9IHJlc3BvbnNlQm9keT8uZXJyb3I/Lm1lc3NhZ2UgfHwgXCJJbnZhbGlkIEFQSSBrZXlcIjtcclxuXHJcbiAgICBpZiAocmVzcG9uc2Uuc3RhdHVzID09PSA0MDApIHJldHVybiB7IHN1Y2Nlc3M6IGZhbHNlLCBlcnJvcjogYEJhZCBSZXF1ZXN0ICg0MDApOiAke2Vycm9yTWVzc2FnZX1gIH07XHJcbiAgICBpZiAocmVzcG9uc2Uuc3RhdHVzID09PSA0MDEpIHJldHVybiB7IHN1Y2Nlc3M6IGZhbHNlLCBlcnJvcjogYFVuYXV0aG9yaXplZCAoNDAxKTogJHtlcnJvck1lc3NhZ2V9YCB9O1xyXG4gICAgaWYgKHJlc3BvbnNlLnN0YXR1cyA9PT0gNDAzKSByZXR1cm4geyBzdWNjZXNzOiBmYWxzZSwgZXJyb3I6IGBGb3JiaWRkZW4gKDQwMyk6ICR7ZXJyb3JNZXNzYWdlfWAgfTtcclxuICAgIGlmIChyZXNwb25zZS5zdGF0dXMgPT09IDQyOSkge1xyXG4gICAgICByZXR1cm4geyBzdWNjZXNzOiB0cnVlLCB3YXJuaW5nOiBcIkFQSSBrZXkgaXMgdmFsaWQgYnV0IHJhdGUgbGltaXRlZC4gSXQgd2lsbCB3b3JrIHdoZW4gdGhlIGxpbWl0IHJlc2V0cy5cIiB9O1xyXG4gICAgfVxyXG5cclxuICAgIHJldHVybiB7IHN1Y2Nlc3M6IGZhbHNlLCBlcnJvcjogYEFQSSBFcnJvciAoJHtyZXNwb25zZS5zdGF0dXN9KTogJHtlcnJvck1lc3NhZ2V9YCB9O1xyXG4gIH0gY2F0Y2ggKGVycm9yKSB7XHJcbiAgICBjb25zb2xlLmVycm9yKFwiW1N0dWR5IEFzc2lzdF0gQVBJIHRlc3QgZXJyb3I6XCIsIGVycm9yKTtcclxuICAgIGF3YWl0IGxvZ0Vycm9yKHsgdHlwZTogXCJ0ZXN0QXBpS2V5X2V4Y2VwdGlvblwiLCB1cmwsIGVycm9yOiAoZXJyb3IgYXMgRXJyb3IpLm1lc3NhZ2UsIHN0YWNrOiAoZXJyb3IgYXMgRXJyb3IpLnN0YWNrIH0pO1xyXG5cclxuICAgIGlmICgoZXJyb3IgYXMgRXJyb3IpLm1lc3NhZ2UuaW5jbHVkZXMoXCJGYWlsZWQgdG8gZmV0Y2hcIikpIHtcclxuICAgICAgcmV0dXJuIHsgc3VjY2VzczogZmFsc2UsIGVycm9yOiBcIk5ldHdvcmsgZXJyb3IuIENoZWNrIHlvdXIgaW50ZXJuZXQgY29ubmVjdGlvbi5cIiB9O1xyXG4gICAgfVxyXG4gICAgcmV0dXJuIHsgc3VjY2VzczogZmFsc2UsIGVycm9yOiBgRXhjZXB0aW9uOiAkeyhlcnJvciBhcyBFcnJvcikubWVzc2FnZX1gIH07XHJcbiAgfVxyXG59XHJcblxyXG5leHBvcnQgYXN5bmMgZnVuY3Rpb24gdGVzdERlZXBTZWVrQXBpS2V5KGFwaUtleTogc3RyaW5nKTogUHJvbWlzZTxNZXNzYWdlUmVzcG9uc2U+IHtcclxuICB0cnkge1xyXG4gICAgY29uc3QgcmVzcG9uc2UgPSBhd2FpdCBmZXRjaChERUVQU0VFS19BUElfQkFTRSwge1xyXG4gICAgICBtZXRob2Q6IFwiUE9TVFwiLFxyXG4gICAgICBoZWFkZXJzOiB7IFwiQ29udGVudC1UeXBlXCI6IFwiYXBwbGljYXRpb24vanNvblwiLCBBdXRob3JpemF0aW9uOiBgQmVhcmVyICR7YXBpS2V5fWAgfSxcclxuICAgICAgYm9keTogSlNPTi5zdHJpbmdpZnkoe1xyXG4gICAgICAgIG1vZGVsOiBERUVQU0VFS19SRUFTT05FUl9NT0RFTCxcclxuICAgICAgICBtYXhfdG9rZW5zOiAxMCxcclxuICAgICAgICBtZXNzYWdlczogW3sgcm9sZTogXCJ1c2VyXCIsIGNvbnRlbnQ6IFwiSGVsbG8sIHJlc3BvbmQgd2l0aCBqdXN0IE9LLlwiIH1dLFxyXG4gICAgICB9KSxcclxuICAgIH0pO1xyXG5cclxuICAgIGxldCByZXNwb25zZUJvZHk6IERlZXBTZWVrQXBpUmVzcG9uc2UgfCBudWxsID0gbnVsbDtcclxuICAgIHRyeSB7XHJcbiAgICAgIHJlc3BvbnNlQm9keSA9IGF3YWl0IHJlc3BvbnNlLmNsb25lKCkuanNvbigpIGFzIERlZXBTZWVrQXBpUmVzcG9uc2U7XHJcbiAgICB9IGNhdGNoIChlKSB7XHJcbiAgICAgIHJlc3BvbnNlQm9keSA9IHsgcGFyc2VFcnJvcjogKGUgYXMgRXJyb3IpLm1lc3NhZ2UgfTtcclxuICAgIH1cclxuXHJcbiAgICBhd2FpdCBsb2dFcnJvcih7IHR5cGU6IFwidGVzdERlZXBTZWVrQXBpS2V5XCIsIHN0YXR1czogcmVzcG9uc2Uuc3RhdHVzLCByZXNwb25zZUJvZHkgfSk7XHJcblxyXG4gICAgaWYgKHJlc3BvbnNlLm9rKSByZXR1cm4geyBzdWNjZXNzOiB0cnVlIH07XHJcblxyXG4gICAgY29uc3QgZXJyb3JNZXNzYWdlID0gcmVzcG9uc2VCb2R5Py5lcnJvcj8ubWVzc2FnZSB8fCBcIkludmFsaWQgQVBJIGtleVwiO1xyXG4gICAgcmV0dXJuIHsgc3VjY2VzczogZmFsc2UsIGVycm9yOiBgRGVlcFNlZWsgRXJyb3IgKCR7cmVzcG9uc2Uuc3RhdHVzfSk6ICR7ZXJyb3JNZXNzYWdlfWAgfTtcclxuICB9IGNhdGNoIChlcnJvcikge1xyXG4gICAgY29uc29sZS5lcnJvcihcIltTdHVkeSBBc3Npc3RdIERlZXBTZWVrIEFQSSB0ZXN0IGVycm9yOlwiLCBlcnJvcik7XHJcbiAgICByZXR1cm4geyBzdWNjZXNzOiBmYWxzZSwgZXJyb3I6IGBFeGNlcHRpb246ICR7KGVycm9yIGFzIEVycm9yKS5tZXNzYWdlfWAgfTtcclxuICB9XHJcbn1cclxuXHJcbi8vID09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09XHJcbi8vIFF1ZXN0aW9uIEJhbmsgXHUyMTkyIExldHRlciBNYXRjaGluZ1xyXG4vLyA9PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PVxyXG5cclxuaW1wb3J0IHR5cGUgeyBRdWVzdGlvbk9wdGlvbiB9IGZyb20gXCIuLi8uLi90eXBlcy9pbmRleC5qc1wiO1xyXG5cclxuLyoqXHJcbiAqIE1hdGNoIGEgc2luZ2xlIGNvcnJlY3RBbnN3ZXIgdGV4dCBmcm9tIHRoZSBxdWVzdGlvbiBiYW5rIHRvIHRoZSBvcHRpb24gbGV0dGVyIChBLCBCLCBDLi4uKVxyXG4gKiBmcm9tIHRoZSBjdXJyZW50IHBhZ2UncyBkZXRlY3RlZCBvcHRpb25zLlxyXG4gKiBVc2VzIG5vcm1hbGl6ZWQgdGV4dCBjb21wYXJpc29uIHRvIGhhbmRsZSBhY2NlbnQvY2FzZSBkaWZmZXJlbmNlcy5cclxuICovXHJcbmZ1bmN0aW9uIG1hdGNoU2luZ2xlQW5zd2VyVG9MZXR0ZXIoXHJcbiAgY29ycmVjdEFuc3dlcjogc3RyaW5nLFxyXG4gIHBhZ2VPcHRpb25zOiBRdWVzdGlvbk9wdGlvbltdLFxyXG4pOiBzdHJpbmcgfCBudWxsIHtcclxuICBjb25zdCBub3JtYWxpemVkQ29ycmVjdCA9IG5vcm1hbGl6ZUZvclNlYXJjaChjb3JyZWN0QW5zd2VyKTtcclxuXHJcbiAgLy8gMS4gRXhhY3Qgbm9ybWFsaXplZCBtYXRjaFxyXG4gIGZvciAoY29uc3Qgb3B0IG9mIHBhZ2VPcHRpb25zKSB7XHJcbiAgICBjb25zdCBub3JtYWxpemVkT3B0ID0gbm9ybWFsaXplRm9yU2VhcmNoKG9wdC50ZXh0KTtcclxuICAgIGlmIChub3JtYWxpemVkT3B0ID09PSBub3JtYWxpemVkQ29ycmVjdCkge1xyXG4gICAgICByZXR1cm4gb3B0LmxldHRlcjtcclxuICAgIH1cclxuICB9XHJcblxyXG4gIC8vIDIuIENvbnRhaW5zIG1hdGNoIChiYW5rIGFuc3dlciBpcyBzdWJzdHJpbmcgb3IgdmljZSB2ZXJzYSlcclxuICBmb3IgKGNvbnN0IG9wdCBvZiBwYWdlT3B0aW9ucykge1xyXG4gICAgY29uc3Qgbm9ybWFsaXplZE9wdCA9IG5vcm1hbGl6ZUZvclNlYXJjaChvcHQudGV4dCk7XHJcbiAgICBpZiAobm9ybWFsaXplZE9wdC5pbmNsdWRlcyhub3JtYWxpemVkQ29ycmVjdCkgfHwgbm9ybWFsaXplZENvcnJlY3QuaW5jbHVkZXMobm9ybWFsaXplZE9wdCkpIHtcclxuICAgICAgcmV0dXJuIG9wdC5sZXR0ZXI7XHJcbiAgICB9XHJcbiAgfVxyXG5cclxuICAvLyAzLiBIaWdoIHdvcmQtb3ZlcmxhcCBzaW1pbGFyaXR5ICg+PSA3MCUgZm9yIGNvZGUvY29tbWFuZCBvcHRpb25zLCA+PSA4MCUgZm9yIHJlZ3VsYXIgdGV4dClcclxuICBsZXQgYmVzdE1hdGNoOiB7IGxldHRlcjogc3RyaW5nOyBzaW1pbGFyaXR5OiBudW1iZXIgfSB8IG51bGwgPSBudWxsO1xyXG4gIFxyXG4gIGZvciAoY29uc3Qgb3B0IG9mIHBhZ2VPcHRpb25zKSB7XHJcbiAgICBjb25zdCBub3JtYWxpemVkT3B0ID0gbm9ybWFsaXplRm9yU2VhcmNoKG9wdC50ZXh0KTtcclxuICAgIGNvbnN0IHNpbWlsYXJpdHkgPSBjYWxjdWxhdGVTaW1pbGFyaXR5KG5vcm1hbGl6ZWRDb3JyZWN0LCBub3JtYWxpemVkT3B0KTtcclxuICAgIFxyXG4gICAgLy8gVHJhY2sgYmVzdCBtYXRjaFxyXG4gICAgaWYgKCFiZXN0TWF0Y2ggfHwgc2ltaWxhcml0eSA+IGJlc3RNYXRjaC5zaW1pbGFyaXR5KSB7XHJcbiAgICAgIGJlc3RNYXRjaCA9IHsgbGV0dGVyOiBvcHQubGV0dGVyLCBzaW1pbGFyaXR5IH07XHJcbiAgICB9XHJcbiAgICBcclxuICAgIC8vIEFjY2VwdCBtYXRjaCBiYXNlZCBvbiBjb250ZXh0XHJcbiAgICBjb25zdCBoYXNDb21tYW5kVGV4dCA9IG5vcm1hbGl6ZWRDb3JyZWN0LmluY2x1ZGVzKFwiaW50ZXJmYWNlXCIpIHx8IFxyXG4gICAgICAgICAgICAgICAgICAgICAgICAgICBub3JtYWxpemVkQ29ycmVjdC5pbmNsdWRlcyhcInJvdXRlclwiKSB8fFxyXG4gICAgICAgICAgICAgICAgICAgICAgICAgICBub3JtYWxpemVkQ29ycmVjdC5pbmNsdWRlcyhcInN3aXRjaFwiKSB8fFxyXG4gICAgICAgICAgICAgICAgICAgICAgICAgICBub3JtYWxpemVkQ29ycmVjdC5pbmNsdWRlcyhcImNvbmZpZ1wiKTtcclxuICAgIGNvbnN0IHRocmVzaG9sZCA9IGhhc0NvbW1hbmRUZXh0ID8gMC43IDogMC44O1xyXG4gICAgXHJcbiAgICBpZiAoc2ltaWxhcml0eSA+PSB0aHJlc2hvbGQpIHtcclxuICAgICAgcmV0dXJuIG9wdC5sZXR0ZXI7XHJcbiAgICB9XHJcbiAgfVxyXG5cclxuICAvLyA0LiBJZiB3ZSBoYXZlIGEgZGVjZW50IG1hdGNoICg+PSA2MCUpIGFuZCBpdCdzIHRoZSBiZXN0IG9wdGlvbiwgdXNlIGl0XHJcbiAgaWYgKGJlc3RNYXRjaCAmJiBiZXN0TWF0Y2guc2ltaWxhcml0eSA+PSAwLjYpIHtcclxuICAgIGxvZyhgW1N0dWR5IEFzc2lzdF0gVXNpbmcgYmVzdCBtYXRjaCB3aXRoICR7KGJlc3RNYXRjaC5zaW1pbGFyaXR5ICogMTAwKS50b0ZpeGVkKDEpfSUgc2ltaWxhcml0eWApO1xyXG4gICAgcmV0dXJuIGJlc3RNYXRjaC5sZXR0ZXI7XHJcbiAgfVxyXG5cclxuICByZXR1cm4gbnVsbDtcclxufVxyXG5cclxuLyoqXHJcbiAqIE1hdGNoIGNvcnJlY3RBbnN3ZXIocykgZnJvbSBxdWVzdGlvbiBiYW5rIHRvIHBhZ2Ugb3B0aW9uIGxldHRlcnMuXHJcbiAqIEhhbmRsZXMgYm90aCBzaW5nbGUgYW5zd2VyIChjb3JyZWN0QW5zd2VyKSBhbmQgbXVsdGlwbGUgYW5zd2VycyAoY29ycmVjdEFuc3dlcnMpLlxyXG4gKiBSZXR1cm5zIGNvbW1hLXNlcGFyYXRlZCBsZXR0ZXJzIGxpa2UgXCJBXCIgb3IgXCJBLCBDLCBFXCIuXHJcbiAqL1xyXG5mdW5jdGlvbiBtYXRjaENvcnJlY3RBbnN3ZXJUb0xldHRlcihcclxuICBiYW5rTWF0Y2g6IHsgY29ycmVjdEFuc3dlcj86IHN0cmluZzsgY29ycmVjdEFuc3dlcnM/OiBzdHJpbmdbXSB9LFxyXG4gIHBhZ2VPcHRpb25zPzogUXVlc3Rpb25PcHRpb25bXSxcclxuKTogc3RyaW5nIHwgbnVsbCB7XHJcbiAgaWYgKCFwYWdlT3B0aW9ucyB8fCBwYWdlT3B0aW9ucy5sZW5ndGggPT09IDApIHJldHVybiBudWxsO1xyXG5cclxuICAvLyBEZXRlcm1pbmUgYWxsIGNvcnJlY3QgYW5zd2Vyc1xyXG4gIGNvbnN0IGFuc3dlcnM6IHN0cmluZ1tdID0gYmFua01hdGNoLmNvcnJlY3RBbnN3ZXJzXHJcbiAgICA/IGJhbmtNYXRjaC5jb3JyZWN0QW5zd2Vyc1xyXG4gICAgOiBiYW5rTWF0Y2guY29ycmVjdEFuc3dlclxyXG4gICAgICA/IFtiYW5rTWF0Y2guY29ycmVjdEFuc3dlcl1cclxuICAgICAgOiBbXTtcclxuXHJcbiAgaWYgKGFuc3dlcnMubGVuZ3RoID09PSAwKSByZXR1cm4gbnVsbDtcclxuXHJcbiAgY29uc3QgbWF0Y2hlZExldHRlcnM6IHN0cmluZ1tdID0gW107XHJcblxyXG4gIGZvciAoY29uc3QgYW5zd2VyIG9mIGFuc3dlcnMpIHtcclxuICAgIGNvbnN0IGxldHRlciA9IG1hdGNoU2luZ2xlQW5zd2VyVG9MZXR0ZXIoYW5zd2VyLCBwYWdlT3B0aW9ucyk7XHJcbiAgICBpZiAobGV0dGVyKSB7XHJcbiAgICAgIG1hdGNoZWRMZXR0ZXJzLnB1c2gobGV0dGVyKTtcclxuICAgIH0gZWxzZSB7XHJcbiAgICAgIGxvZyhgW1N0dWR5IEFzc2lzdF0gQ291bGQgbm90IG1hdGNoIGNvcnJlY3RBbnN3ZXIgXCIke2Fuc3dlcn1cIiB0byBhbnkgcGFnZSBvcHRpb25gKTtcclxuICAgIH1cclxuICB9XHJcblxyXG4gIGlmIChtYXRjaGVkTGV0dGVycy5sZW5ndGggPT09IDApIHJldHVybiBudWxsO1xyXG5cclxuICAvLyBTb3J0IGFscGhhYmV0aWNhbGx5IGFuZCBkZWR1cGxpY2F0ZVxyXG4gIGNvbnN0IHVuaXF1ZSA9IFsuLi5uZXcgU2V0KG1hdGNoZWRMZXR0ZXJzKV0uc29ydCgpO1xyXG4gIHJldHVybiB1bmlxdWUuam9pbihcIiwgXCIpO1xyXG59XHJcblxyXG4vLyA9PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PVxyXG4vLyBRdWVzdGlvbiBBbmFseXNpcyAoTWFpbiBPcmNoZXN0cmF0b3IpXHJcbi8vID09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09XHJcblxyXG5leHBvcnQgYXN5bmMgZnVuY3Rpb24gYW5hbHl6ZVF1ZXN0aW9uKGNvbnRleHQ6IEFuYWx5c2lzQ29udGV4dCk6IFByb21pc2U8QW5hbHlzaXNSZXNwb25zZT4ge1xyXG4gIGNvbnN0IHN0YXJ0VGltZSA9IERhdGUubm93KCk7XHJcblxyXG4gIHRyeSB7XHJcbiAgICAvLyA9PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PVxyXG4gICAgLy8gUXVlc3Rpb24gQmFuayBJbnN0YW50IE1hdGNoIChza2lwIEFJIGVudGlyZWx5KVxyXG4gICAgLy8gPT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT1cclxuICAgIGNvbnN0IGJhbmtNYXRjaCA9IGF3YWl0IGZpbmRNYXRjaGluZ1F1ZXN0aW9uKFxyXG4gICAgICBjb250ZXh0LnF1ZXN0aW9uVGV4dCxcclxuICAgICAgKGNvbnRleHQgYXMgQW5hbHlzaXNDb250ZXh0ICYgeyBtb2R1bGVJbmZvPzogc3RyaW5nIH0pLm1vZHVsZUluZm8gfHwgY29udGV4dC5wYWdlVGl0bGUsXHJcbiAgICAgIGNvbnRleHQucGFnZVVybCxcclxuICAgICk7XHJcblxyXG4gICAgaWYgKGJhbmtNYXRjaCAmJiAoYmFua01hdGNoLmNvcnJlY3RBbnN3ZXIgfHwgYmFua01hdGNoLmNvcnJlY3RBbnN3ZXJzKSAmJiBiYW5rTWF0Y2guc2ltaWxhcml0eSA+PSA4MCkge1xyXG4gICAgICBjb25zdCBhbnN3ZXJMZXR0ZXIgPSBtYXRjaENvcnJlY3RBbnN3ZXJUb0xldHRlcihiYW5rTWF0Y2gsIGNvbnRleHQub3B0aW9ucyk7XHJcbiAgICAgIGlmIChhbnN3ZXJMZXR0ZXIpIHtcclxuICAgICAgICBjb25zdCBkaXNwbGF5QW5zd2VyID0gYmFua01hdGNoLmNvcnJlY3RBbnN3ZXJzID8gYmFua01hdGNoLmNvcnJlY3RBbnN3ZXJzLmpvaW4oJyB8ICcpIDogYmFua01hdGNoLmNvcnJlY3RBbnN3ZXIgfHwgJyc7XHJcbiAgICAgICAgbG9nKGBbU3R1ZHkgQXNzaXN0XSBJTlNUQU5UIEFOU1dFUiBmcm9tIHF1ZXN0aW9uIGJhbmsgKCR7YmFua01hdGNoLnNpbWlsYXJpdHl9JSBtYXRjaCk6ICR7YW5zd2VyTGV0dGVyfWApO1xyXG4gICAgICAgIGF3YWl0IHRyYWNrVXNhZ2Uoe1xyXG4gICAgICAgICAgdGltZXN0YW1wOiBEYXRlLm5vdygpLFxyXG4gICAgICAgICAgcXVlc3Rpb25UZXh0OiBjb250ZXh0LnF1ZXN0aW9uVGV4dC5zdWJzdHJpbmcoMCwgMjAwKSxcclxuICAgICAgICAgIHF1ZXN0aW9uVHlwZTogY29udGV4dC5xdWVzdGlvblR5cGUsXHJcbiAgICAgICAgICBhbnN3ZXI6IGFuc3dlckxldHRlcixcclxuICAgICAgICAgIHNvdXJjZTogXCJxdWVzdGlvbi1iYW5rXCIsXHJcbiAgICAgICAgICBtb2RlbDogXCJxdWVzdGlvbnMtYmFuay5qc29uXCIsXHJcbiAgICAgICAgICBpbnB1dFRva2VuczogMCxcclxuICAgICAgICAgIG91dHB1dFRva2VuczogMCxcclxuICAgICAgICAgIHJlc3BvbnNlTW9kZTogY29udGV4dC5yZXNwb25zZU1vZGUsXHJcbiAgICAgICAgICBzdWNjZXNzOiB0cnVlLFxyXG4gICAgICAgICAgbGF0ZW5jeU1zOiBEYXRlLm5vdygpIC0gc3RhcnRUaW1lLFxyXG4gICAgICAgICAgcGxhdGZvcm06IGRldGVjdFBsYXRmb3JtKGNvbnRleHQucGFnZVVybCksXHJcbiAgICAgICAgICBjb25maWRlbmNlOiBcIkhJR0hcIixcclxuICAgICAgICB9KTtcclxuICAgICAgICByZXR1cm4geyBzdWNjZXNzOiB0cnVlLCByZXN1bHQ6IGFuc3dlckxldHRlciwgc291cmNlOiBcInF1ZXN0aW9uLWJhbmtcIiB9O1xyXG4gICAgICB9XHJcbiAgICB9XHJcblxyXG4gICAgLy8gUmF0ZSBsaW1pdGluZyBjaGVja1xyXG4gICAgY29uc3QgcmF0ZUxpbWl0RXJyb3IgPSBjaGVja1JhdGVMaW1pdChjb250ZXh0LnF1ZXN0aW9uVGV4dCk7XHJcbiAgICBpZiAocmF0ZUxpbWl0RXJyb3IpIHtcclxuICAgICAgcmV0dXJuIHsgc3VjY2VzczogZmFsc2UsIGVycm9yOiByYXRlTGltaXRFcnJvciB9O1xyXG4gICAgfVxyXG4gICAgcmVjb3JkUmVxdWVzdChjb250ZXh0LnF1ZXN0aW9uVGV4dCk7XHJcblxyXG4gICAgY29uc3Qgc3RvcmFnZVJlc3VsdCA9IGF3YWl0IGNocm9tZS5zdG9yYWdlLmxvY2FsLmdldChbXHJcbiAgICAgIFwiY2xhdWRlQXBpS2V5XCIsIFwiY2xhdWRlTW9kZWxcIiwgXCJ1c2VEZWVwU2Vla1wiLCBcImRlZXBzZWVrQXBpS2V5XCIsIFwiZGVlcHNlZWtPbmx5XCIsXHJcbiAgICBdKSBhcyBTdG9yYWdlRGF0YTtcclxuXHJcbiAgICAvLyBEZWNyeXB0IEFQSSBrZXlzXHJcbiAgICBjb25zdCBjbGF1ZGVBcGlLZXkgPSBhd2FpdCBnZXREZWNyeXB0ZWRBcGlLZXkoXCJjbGF1ZGVBcGlLZXlcIik7XHJcbiAgICBjb25zdCBkZWVwc2Vla0FwaUtleSA9IGF3YWl0IGdldERlY3J5cHRlZEFwaUtleShcImRlZXBzZWVrQXBpS2V5XCIpO1xyXG4gICAgY29uc3QgeyBjbGF1ZGVNb2RlbCwgdXNlRGVlcFNlZWssIGRlZXBzZWVrT25seSB9ID0gc3RvcmFnZVJlc3VsdDtcclxuICAgIGNvbnN0IHNlbGVjdGVkQ2xhdWRlTW9kZWwgPSBjb250ZXh0LnFhTW9kZSA/IFFBX0NMQVVERV9NT0RFTCA6IChjbGF1ZGVNb2RlbCB8fCBERUZBVUxUX01PREVMKTtcclxuICAgIGNvbnN0IGlzRGVlcFNlZWtPbmx5TW9kZSA9IHVzZURlZXBTZWVrICYmIGRlZXBzZWVrT25seSAmJiBkZWVwc2Vla0FwaUtleTtcclxuXHJcbiAgICBpZiAoIWNsYXVkZUFwaUtleSAmJiAhaXNEZWVwU2Vla09ubHlNb2RlKSB7XHJcbiAgICAgIHJldHVybiB7IHN1Y2Nlc3M6IGZhbHNlLCBlcnJvcjogXCJDbGF1ZGUgQVBJIGtleSBub3QgY29uZmlndXJlZC5cIiB9O1xyXG4gICAgfVxyXG5cclxuICAgIGNvbnN0IGhhc0ltYWdlcyA9IGNvbnRleHQuaW1hZ2VzICYmIGNvbnRleHQuaW1hZ2VzLmxlbmd0aCA+IDA7XHJcbiAgICBjb25zdCBpc01hdGNoaW5nID0gY29udGV4dC5xdWVzdGlvblR5cGUgPT09IFwibWF0Y2hpbmdcIjtcclxuICAgIGNvbnN0IHNraXBEZWVwU2VlayA9IGNvbnRleHQuc2tpcERlZXBTZWVrID09PSB0cnVlO1xyXG5cclxuICAgIGlmIChza2lwRGVlcFNlZWspIHtcclxuICAgICAgbG9nKFwiW1N0dWR5IEFzc2lzdF0gQ1RSTCtTSElGVDogVXNpbmcgQ2xhdWRlIGRpcmVjdGx5XCIpO1xyXG4gICAgICBpZiAoaXNEZWVwU2Vla09ubHlNb2RlKSB7XHJcbiAgICAgICAgcmV0dXJuIHsgc3VjY2VzczogZmFsc2UsIGVycm9yOiBcIlx1MjZBMFx1RkUwRiBEZWVwU2VlayBPbmx5IG1vZGU6IENUUkwrU0hJRlQgKHVzZSBDbGF1ZGUpIGlzIG5vdCBhdmFpbGFibGUuIERpc2FibGUgJ0RlZXBTZWVrIE9ubHknIG9yIHByZXNzIENUUkwgd2l0aG91dCBTSElGVC5cIiB9O1xyXG4gICAgICB9XHJcbiAgICB9XHJcblxyXG4gICAgbGV0IGRlZXBzZWVrQW5hbHlzaXNGb3JDbGF1ZGU6IERlZXBTZWVrQW5hbHlzaXNGb3JDbGF1ZGUgfCBudWxsID0gbnVsbDtcclxuICAgIGxldCBjbGF1ZGVGYWxsYmFja1JlYXNvbjogc3RyaW5nIHwgdW5kZWZpbmVkO1xyXG5cclxuICAgIGlmIChpc0RlZXBTZWVrT25seU1vZGUgJiYgaGFzSW1hZ2VzKSB7XHJcbiAgICAgIHJldHVybiB7IHN1Y2Nlc3M6IGZhbHNlLCBlcnJvcjogXCJcdTI2QTBcdUZFMEYgRGVlcFNlZWsgT25seSBtb2RlOiBJbWFnZXMgYXJlIG5vdCBzdXBwb3J0ZWQuIERpc2FibGUgJ0RlZXBTZWVrIE9ubHknIHRvIHVzZSBDbGF1ZGUgZm9yIGltYWdlIHF1ZXN0aW9ucy5cIiB9O1xyXG4gICAgfVxyXG5cclxuICAgIGlmIChpc0RlZXBTZWVrT25seU1vZGUgJiYgaXNNYXRjaGluZykge1xyXG4gICAgICByZXR1cm4geyBzdWNjZXNzOiBmYWxzZSwgZXJyb3I6IFwiXHUyNkEwXHVGRTBGIERlZXBTZWVrIE9ubHkgbW9kZTogTWF0Y2hpbmcgcXVlc3Rpb25zIGFyZSBub3Qgc3VwcG9ydGVkLiBEaXNhYmxlICdEZWVwU2VlayBPbmx5JyB0byB1c2UgQ2xhdWRlIGZvciBtYXRjaGluZyBxdWVzdGlvbnMuXCIgfTtcclxuICAgIH1cclxuXHJcbiAgICBpZiAodXNlRGVlcFNlZWsgJiYgZGVlcHNlZWtBcGlLZXkgJiYgIWhhc0ltYWdlcyAmJiAhaXNNYXRjaGluZyAmJiAhc2tpcERlZXBTZWVrKSB7XHJcbiAgICAgIGxvZyhcIltTdHVkeSBBc3Npc3RdIFVzaW5nIERlZXBTZWVrIFJlYXNvbmVyLi4uXCIpO1xyXG5cclxuICAgICAgbGV0IGRlZXBzZWVrUmVzdWx0ID0gYXdhaXQgYW5hbHl6ZVdpdGhEZWVwU2Vlayhjb250ZXh0LCBkZWVwc2Vla0FwaUtleSk7XHJcblxyXG4gICAgICBpZiAoZGVlcHNlZWtSZXN1bHQuY2FuY2VsbGVkKSB7XHJcbiAgICAgICAgbG9nKFwiW1N0dWR5IEFzc2lzdF0gRGVlcFNlZWsgY2FuY2VsbGVkIFx1MjE5MiBDbGF1ZGVcIik7XHJcbiAgICAgICAgaWYgKGlzRGVlcFNlZWtPbmx5TW9kZSkgcmV0dXJuIHsgc3VjY2VzczogZmFsc2UsIGVycm9yOiBcIkFuYWx5c2lzIGNhbmNlbGxlZC5cIiB9O1xyXG4gICAgICB9IGVsc2UgaWYgKCFkZWVwc2Vla1Jlc3VsdC5zdWNjZXNzKSB7XHJcbiAgICAgICAgaWYgKGRlZXBzZWVrUmVzdWx0LnNraXBSZXRyeSkge1xyXG4gICAgICAgICAgbG9nKGBbU3R1ZHkgQXNzaXN0XSBEZWVwU2VlayBmYWlsZWQgKG5vbi1yZXRyeWFibGUpIFx1MjE5MiBDbGF1ZGUgZmFsbGJhY2s6ICR7ZGVlcHNlZWtSZXN1bHQuZXJyb3J9YCk7XHJcbiAgICAgICAgfSBlbHNlIHtcclxuICAgICAgICAgIGxvZyhcIltTdHVkeSBBc3Npc3RdIERlZXBTZWVrIGZhaWxlZCwgcmV0cnlpbmcuLi5cIik7XHJcbiAgICAgICAgICBhd2FpdCBuZXcgUHJvbWlzZSgocikgPT4gc2V0VGltZW91dChyLCAxMDAwKSk7XHJcbiAgICAgICAgICBkZWVwc2Vla1Jlc3VsdCA9IGF3YWl0IGFuYWx5emVXaXRoRGVlcFNlZWsoY29udGV4dCwgZGVlcHNlZWtBcGlLZXkpO1xyXG4gICAgICAgIH1cclxuXHJcbiAgICAgICAgaWYgKCFkZWVwc2Vla1Jlc3VsdC5zdWNjZXNzICYmICFkZWVwc2Vla1Jlc3VsdC5jYW5jZWxsZWQpIHtcclxuICAgICAgICAgIGxvZyhcIltTdHVkeSBBc3Npc3RdIERlZXBTZWVrIGZhaWxlZCBcdTIxOTIgQ2xhdWRlIGZhbGxiYWNrXCIpO1xyXG4gICAgICAgICAgY2xhdWRlRmFsbGJhY2tSZWFzb24gPSBcImRlZXBzZWVrX2Vycm9yXCI7XHJcbiAgICAgICAgICBpZiAoaXNEZWVwU2Vla09ubHlNb2RlKSB7XHJcbiAgICAgICAgICAgIHJldHVybiB7IHN1Y2Nlc3M6IGZhbHNlLCBlcnJvcjogYFx1MjZBMFx1RkUwRiBEZWVwU2VlayBPbmx5IG1vZGU6ICR7ZGVlcHNlZWtSZXN1bHQuZXJyb3IgfHwgXCJBUEkgZmFpbGVkIGFmdGVyIHJldHJ5LiBObyBDbGF1ZGUgZmFsbGJhY2sgYXZhaWxhYmxlLlwifWAgfTtcclxuICAgICAgICAgIH1cclxuICAgICAgICB9XHJcbiAgICAgIH1cclxuXHJcbiAgICAgIGlmIChkZWVwc2Vla1Jlc3VsdC5zdWNjZXNzICYmIGRlZXBzZWVrUmVzdWx0LmNvbmZpZGVuY2UgPT09IFwiSElHSFwiKSB7XHJcbiAgICAgICAgbG9nKFwiW1N0dWR5IEFzc2lzdF0gRGVlcFNlZWsgSElHSCBcdTIxOTIgQW5zd2VyOlwiLCBkZWVwc2Vla1Jlc3VsdC5yZXN1bHQpO1xyXG4gICAgICAgIC8vIFRyYWNrIHVzYWdlIHdpdGggcmVhbCB0b2tlbiBjb3VudHMgZnJvbSBEZWVwU2VlayBBUElcclxuICAgICAgICBhd2FpdCB0cmFja1VzYWdlKHtcclxuICAgICAgICAgIHRpbWVzdGFtcDogRGF0ZS5ub3coKSxcclxuICAgICAgICAgIHF1ZXN0aW9uVGV4dDogY29udGV4dC5xdWVzdGlvblRleHQuc3Vic3RyaW5nKDAsIDIwMCksXHJcbiAgICAgICAgICBxdWVzdGlvblR5cGU6IGNvbnRleHQucXVlc3Rpb25UeXBlLFxyXG4gICAgICAgICAgYW5zd2VyOiBkZWVwc2Vla1Jlc3VsdC5yZXN1bHQsXHJcbiAgICAgICAgICBzb3VyY2U6IFwiZGVlcHNlZWtcIixcclxuICAgICAgICAgIG1vZGVsOiBERUVQU0VFS19SRUFTT05FUl9NT0RFTCxcclxuICAgICAgICAgIGlucHV0VG9rZW5zOiBkZWVwc2Vla1Jlc3VsdC5pbnB1dFRva2VucyB8fCAwLFxyXG4gICAgICAgICAgb3V0cHV0VG9rZW5zOiBkZWVwc2Vla1Jlc3VsdC5vdXRwdXRUb2tlbnMgfHwgMCxcclxuICAgICAgICAgIHJlc3BvbnNlTW9kZTogY29udGV4dC5yZXNwb25zZU1vZGUsXHJcbiAgICAgICAgICBzdWNjZXNzOiB0cnVlLFxyXG4gICAgICAgICAgbGF0ZW5jeU1zOiBEYXRlLm5vdygpIC0gc3RhcnRUaW1lLFxyXG4gICAgICAgICAgcGxhdGZvcm06IGRldGVjdFBsYXRmb3JtKGNvbnRleHQucGFnZVVybCksXHJcbiAgICAgICAgICBjb25maWRlbmNlOiBcIkhJR0hcIixcclxuICAgICAgICAgIGRlZXBzZWVrUmVhc29uaW5nOiBkZWVwc2Vla1Jlc3VsdC5kZWVwc2Vla1JlYXNvbmluZyA/PyB1bmRlZmluZWQsXHJcbiAgICAgICAgfSk7XHJcbiAgICAgICAgcmV0dXJuIGRlZXBzZWVrUmVzdWx0O1xyXG4gICAgICB9IGVsc2UgaWYgKGRlZXBzZWVrUmVzdWx0LnN1Y2Nlc3MpIHtcclxuICAgICAgICBpZiAoaXNEZWVwU2Vla09ubHlNb2RlKSB7XHJcbiAgICAgICAgICBsb2coYFtTdHVkeSBBc3Npc3RdIERlZXBTZWVrICR7ZGVlcHNlZWtSZXN1bHQuY29uZmlkZW5jZX0gXHUyMTkyIFJldHVybmluZyAoRGVlcFNlZWsgT25seSBtb2RlKWApO1xyXG4gICAgICAgICAgZGVlcHNlZWtSZXN1bHQuZXhwbGFuYXRpb24gPSBgXHUyNkEwXHVGRTBGICoqTG93IGNvbmZpZGVuY2UgKCR7ZGVlcHNlZWtSZXN1bHQuY29uZmlkZW5jZX0pKiogLSBObyBDbGF1ZGUgdmFsaWRhdGlvbiBpbiBEZWVwU2VlayBPbmx5IG1vZGUuXFxuXFxuJHtkZWVwc2Vla1Jlc3VsdC5leHBsYW5hdGlvbiB8fCBcIlwifWA7XHJcbiAgICAgICAgICAvLyBUcmFjayB1c2FnZSB3aXRoIHJlYWwgdG9rZW4gY291bnRzIGZyb20gRGVlcFNlZWsgQVBJXHJcbiAgICAgICAgICBhd2FpdCB0cmFja1VzYWdlKHtcclxuICAgICAgICAgICAgdGltZXN0YW1wOiBEYXRlLm5vdygpLFxyXG4gICAgICAgICAgICBxdWVzdGlvblRleHQ6IGNvbnRleHQucXVlc3Rpb25UZXh0LnN1YnN0cmluZygwLCAyMDApLFxyXG4gICAgICAgICAgICBxdWVzdGlvblR5cGU6IGNvbnRleHQucXVlc3Rpb25UeXBlLFxyXG4gICAgICAgICAgICBhbnN3ZXI6IGRlZXBzZWVrUmVzdWx0LnJlc3VsdCxcclxuICAgICAgICAgICAgc291cmNlOiBcImRlZXBzZWVrXCIsXHJcbiAgICAgICAgICAgIG1vZGVsOiBERUVQU0VFS19SRUFTT05FUl9NT0RFTCxcclxuICAgICAgICAgICAgaW5wdXRUb2tlbnM6IGRlZXBzZWVrUmVzdWx0LmlucHV0VG9rZW5zIHx8IDAsXHJcbiAgICAgICAgICAgIG91dHB1dFRva2VuczogZGVlcHNlZWtSZXN1bHQub3V0cHV0VG9rZW5zIHx8IDAsXHJcbiAgICAgICAgICAgIHJlc3BvbnNlTW9kZTogY29udGV4dC5yZXNwb25zZU1vZGUsXHJcbiAgICAgICAgICAgIHN1Y2Nlc3M6IHRydWUsXHJcbiAgICAgICAgICAgIGxhdGVuY3lNczogRGF0ZS5ub3coKSAtIHN0YXJ0VGltZSxcclxuICAgICAgICAgICAgcGxhdGZvcm06IGRldGVjdFBsYXRmb3JtKGNvbnRleHQucGFnZVVybCksXHJcbiAgICAgICAgICAgIGNvbmZpZGVuY2U6IGRlZXBzZWVrUmVzdWx0LmNvbmZpZGVuY2UsXHJcbiAgICAgICAgICAgIGRlZXBzZWVrUmVhc29uaW5nOiBkZWVwc2Vla1Jlc3VsdC5kZWVwc2Vla1JlYXNvbmluZyA/PyB1bmRlZmluZWQsXHJcbiAgICAgICAgICB9KTtcclxuICAgICAgICAgIHJldHVybiBkZWVwc2Vla1Jlc3VsdDtcclxuICAgICAgICB9XHJcblxyXG4gICAgICAgIGxvZyhgW1N0dWR5IEFzc2lzdF0gRGVlcFNlZWsgJHtkZWVwc2Vla1Jlc3VsdC5jb25maWRlbmNlfSBcdTIxOTIgQ2xhdWRlIHZhbGlkYXRpb25gKTtcclxuICAgICAgICBkZWVwc2Vla0FuYWx5c2lzRm9yQ2xhdWRlID0ge1xyXG4gICAgICAgICAgYW5zd2VyOiBkZWVwc2Vla1Jlc3VsdC5yZXN1bHQhLFxyXG4gICAgICAgICAgY29uZmlkZW5jZTogZGVlcHNlZWtSZXN1bHQuY29uZmlkZW5jZSEsXHJcbiAgICAgICAgICBhbmFseXNpczogZGVlcHNlZWtSZXN1bHQuZGVlcHNlZWtBbmFseXNpcyEsXHJcbiAgICAgICAgICByZWFzb25pbmc6IGRlZXBzZWVrUmVzdWx0LmRlZXBzZWVrUmVhc29uaW5nID8/IG51bGwsXHJcbiAgICAgICAgfTtcclxuICAgICAgfVxyXG4gICAgfSBlbHNlIGlmICh1c2VEZWVwU2VlayAmJiBoYXNJbWFnZXMpIHtcclxuICAgICAgbG9nKFwiW1N0dWR5IEFzc2lzdF0gSW1hZ2VzIGRldGVjdGVkIFx1MjE5MiBDbGF1ZGUgKERlZXBTZWVrIG5vIHNvcG9ydGEgaW1cdTAwRTFnZW5lcylcIik7XHJcbiAgICAgIGNsYXVkZUZhbGxiYWNrUmVhc29uID0gXCJpbWFnZXNcIjtcclxuICAgIH1cclxuXHJcbiAgICBpZiAoaXNEZWVwU2Vla09ubHlNb2RlKSB7XHJcbiAgICAgIHJldHVybiB7IHN1Y2Nlc3M6IGZhbHNlLCBlcnJvcjogXCJcdTI2QTBcdUZFMEYgRGVlcFNlZWsgT25seSBtb2RlOiBVbmFibGUgdG8gYW5hbHl6ZS4gQ2hlY2sgeW91ciBEZWVwU2VlayBBUEkga2V5LlwiIH07XHJcbiAgICB9XHJcblxyXG4gICAgLy8gV2hlbiBmYWxsaW5nIGJhY2sgdG8gQ2xhdWRlIGFmdGVyIERlZXBTZWVrIGF0dGVtcHQsIGxldCBDbGF1ZGUgdHJhY2sgaXRzIG93biBsYXRlbmN5LlxyXG4gICAgLy8gT25seSBwYXNzIG9yaWdpbmFsIHN0YXJ0VGltZSBpZiBDbGF1ZGUgaXMgdGhlIHByaW1hcnkgKG5vIERlZXBTZWVrIGF0dGVtcHQgd2FzIG1hZGUpLlxyXG4gICAgY29uc3QgY2xhdWRlU3RhcnRUaW1lID0gZGVlcHNlZWtBbmFseXNpc0ZvckNsYXVkZSA/IERhdGUubm93KCkgOiBzdGFydFRpbWU7XHJcbiAgICByZXR1cm4gYXdhaXQgYW5hbHl6ZVdpdGhDbGF1ZGUoY29udGV4dCwgY2xhdWRlQXBpS2V5ISwgc2VsZWN0ZWRDbGF1ZGVNb2RlbCwgZGVlcHNlZWtBbmFseXNpc0ZvckNsYXVkZSwgY2xhdWRlU3RhcnRUaW1lLCBjbGF1ZGVGYWxsYmFja1JlYXNvbik7XHJcbiAgfSBjYXRjaCAoZXJyb3IpIHtcclxuICAgIGF3YWl0IGxvZ0Vycm9yKHsgdHlwZTogXCJhbmFseXplUXVlc3Rpb25fZXhjZXB0aW9uXCIsIGVycm9yOiAoZXJyb3IgYXMgRXJyb3IpLm1lc3NhZ2UsIHN0YWNrOiAoZXJyb3IgYXMgRXJyb3IpLnN0YWNrIH0pO1xyXG5cclxuICAgIGlmICgoZXJyb3IgYXMgRXJyb3IpLm1lc3NhZ2UuaW5jbHVkZXMoXCJGYWlsZWQgdG8gZmV0Y2hcIikpIHtcclxuICAgICAgcmV0dXJuIHsgc3VjY2VzczogZmFsc2UsIGVycm9yOiBcIk5ldHdvcmsgZXJyb3IuXCIgfTtcclxuICAgIH1cclxuICAgIHJldHVybiB7IHN1Y2Nlc3M6IGZhbHNlLCBlcnJvcjogYEFuYWx5c2lzIGZhaWxlZDogJHsoZXJyb3IgYXMgRXJyb3IpLm1lc3NhZ2V9YCB9O1xyXG4gIH1cclxufVxyXG5cclxuLy8gPT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT1cclxuLy8gRGVlcFNlZWsgQW5hbHlzaXNcclxuLy8gPT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT1cclxuXHJcbmV4cG9ydCBhc3luYyBmdW5jdGlvbiBhbmFseXplV2l0aERlZXBTZWVrKFxyXG4gIGNvbnRleHQ6IEFuYWx5c2lzQ29udGV4dCxcclxuICBhcGlLZXk6IHN0cmluZ1xyXG4pOiBQcm9taXNlPERlZXBTZWVrQW5hbHlzaXNSZXN1bHQ+IHtcclxuICB0cnkge1xyXG4gICAgY29uc3QgbWF0Y2hlZFF1ZXN0aW9uID0gYXdhaXQgZmluZE1hdGNoaW5nUXVlc3Rpb24oXHJcbiAgICAgIGNvbnRleHQucXVlc3Rpb25UZXh0LFxyXG4gICAgICAoY29udGV4dCBhcyBBbmFseXNpc0NvbnRleHQgJiB7IG1vZHVsZUluZm8/OiBzdHJpbmcgfSkubW9kdWxlSW5mbyB8fCBjb250ZXh0LnBhZ2VUaXRsZSxcclxuICAgICAgY29udGV4dC5wYWdlVXJsLFxyXG4gICAgKTtcclxuXHJcbiAgICBjb25zdCBwcm9tcHQgPSBidWlsZERlZXBTZWVrUHJvbXB0KGNvbnRleHQsIG1hdGNoZWRRdWVzdGlvbik7XHJcblxyXG4gICAgbG9nKFwiW1N0dWR5IEFzc2lzdF0gQ2FsbGluZyBEZWVwU2VlayBBUEkuLi5cIik7XHJcblxyXG4gICAgY29uc3QgY29udHJvbGxlciA9IG5ldyBBYm9ydENvbnRyb2xsZXIoKTtcclxuICAgIHNldEFjdGl2ZURlZXBTZWVrQ29udHJvbGxlcihjb250cm9sbGVyKTtcclxuICAgIGNvbnN0IHNpZ25hbCA9IGNvbnRyb2xsZXIuc2lnbmFsO1xyXG5cclxuICAgIGNvbnN0IHJlc3BvbnNlID0gYXdhaXQgZmV0Y2hXaXRoUmV0cnkoXHJcbiAgICAgIERFRVBTRUVLX0FQSV9CQVNFLFxyXG4gICAgICB7XHJcbiAgICAgICAgbWV0aG9kOiBcIlBPU1RcIixcclxuICAgICAgICBoZWFkZXJzOiB7IFwiQ29udGVudC1UeXBlXCI6IFwiYXBwbGljYXRpb24vanNvblwiLCBBdXRob3JpemF0aW9uOiBgQmVhcmVyICR7YXBpS2V5fWAgfSxcclxuICAgICAgICBib2R5OiBKU09OLnN0cmluZ2lmeSh7XHJcbiAgICAgICAgICBtb2RlbDogREVFUFNFRUtfUkVBU09ORVJfTU9ERUwsXHJcbiAgICAgICAgICBtYXhfdG9rZW5zOiAyMDQ4LFxyXG4gICAgICAgICAgbWVzc2FnZXM6IFt7IHJvbGU6IFwidXNlclwiLCBjb250ZW50OiBwcm9tcHQgfV0sXHJcbiAgICAgICAgfSBhcyBEZWVwU2Vla1JlcXVlc3RCb2R5KSxcclxuICAgICAgICBzaWduYWwsXHJcbiAgICAgIH0sXHJcbiAgICAgIDIsXHJcbiAgICAgIDYwMDAwLFxyXG4gICAgKTtcclxuXHJcbiAgICBsZXQgcmVzcG9uc2VCb2R5OiBEZWVwU2Vla0FwaVJlc3BvbnNlIHwgbnVsbCA9IG51bGw7XHJcbiAgICB0cnkge1xyXG4gICAgICByZXNwb25zZUJvZHkgPSBhd2FpdCByZXNwb25zZS5jbG9uZSgpLmpzb24oKSBhcyBEZWVwU2Vla0FwaVJlc3BvbnNlO1xyXG4gICAgfSBjYXRjaCAoZSkge1xyXG4gICAgICByZXNwb25zZUJvZHkgPSB7IHBhcnNlRXJyb3I6IChlIGFzIEVycm9yKS5tZXNzYWdlIH07XHJcbiAgICB9XHJcblxyXG4gICAgYXdhaXQgbG9nRXJyb3IoeyB0eXBlOiBcImFuYWx5emVXaXRoRGVlcFNlZWtcIiwgc3RhdHVzOiByZXNwb25zZS5zdGF0dXMsIHJlc3BvbnNlQm9keSB9KTtcclxuXHJcbiAgICAvLyBTYXZlIGZ1bGwgQVBJIHJlcXVlc3QvcmVzcG9uc2UgZm9yIGRldmVsb3BlciBtb2RlIGluIGRhc2hib2FyZFxyXG4gICAgdHJ5IHtcclxuICAgICAgYXdhaXQgY2hyb21lLnN0b3JhZ2UubG9jYWwuc2V0KHtcclxuICAgICAgICBsYXN0QXBpUmVxdWVzdERhdGE6IHtcclxuICAgICAgICAgIHRpbWVzdGFtcDogRGF0ZS5ub3coKSxcclxuICAgICAgICAgIHR5cGU6IFwiYW5hbHl6ZVdpdGhEZWVwU2Vla1wiLFxyXG4gICAgICAgICAgdXJsOiBERUVQU0VFS19BUElfQkFTRSxcclxuICAgICAgICAgIHN0YXR1czogcmVzcG9uc2Uuc3RhdHVzLFxyXG4gICAgICAgICAgaGFzSW1hZ2VzOiBmYWxzZSxcclxuICAgICAgICAgIHJlcXVlc3RCb2R5OiB7XHJcbiAgICAgICAgICAgIG1vZGVsOiBERUVQU0VFS19SRUFTT05FUl9NT0RFTCxcclxuICAgICAgICAgICAgbWF4X3Rva2VuczogMjA0OCxcclxuICAgICAgICAgICAgbWVzc2FnZXM6IFt7IHJvbGU6IFwidXNlclwiLCBjb250ZW50OiBwcm9tcHQgfV0sXHJcbiAgICAgICAgICB9LFxyXG4gICAgICAgICAgcmVzcG9uc2VCb2R5LFxyXG4gICAgICAgIH0sXHJcbiAgICAgIH0pO1xyXG4gICAgfSBjYXRjaCAoX2UpIHsgLyogc2lsZW50ICovIH1cclxuXHJcbiAgICBpZiAoIXJlc3BvbnNlLm9rKSB7XHJcbiAgICAgIGNvbnN0IHN0YXR1cyA9IHJlc3BvbnNlLnN0YXR1cztcclxuICAgICAgY29uc3QgZXJyb3JNc2cgPSByZXNwb25zZUJvZHk/LmVycm9yPy5tZXNzYWdlIHx8IFwiXCI7XHJcblxyXG4gICAgICAvLyBOb24tcmV0cnlhYmxlIGVycm9yczogc2tpcCByZXRyeSBhbmQgZ28gZGlyZWN0bHkgdG8gQ2xhdWRlIGZhbGxiYWNrXHJcbiAgICAgIGNvbnN0IG5vblJldHJ5YWJsZVN0YXR1c2VzID0gWzQwMCwgNDAxLCA0MDIsIDQyMiwgNDI5LCA1MDNdO1xyXG4gICAgICBjb25zdCBza2lwUmV0cnkgPSBub25SZXRyeWFibGVTdGF0dXNlcy5pbmNsdWRlcyhzdGF0dXMpO1xyXG5cclxuICAgICAgbGV0IGVycm9yRGVzY3JpcHRpb246IHN0cmluZztcclxuICAgICAgc3dpdGNoIChzdGF0dXMpIHtcclxuICAgICAgICBjYXNlIDQwMDpcclxuICAgICAgICAgIGVycm9yRGVzY3JpcHRpb24gPSBgRGVlcFNlZWs6IEludmFsaWQgcmVxdWVzdCBmb3JtYXQuICR7ZXJyb3JNc2d9YDtcclxuICAgICAgICAgIGJyZWFrO1xyXG4gICAgICAgIGNhc2UgNDAxOlxyXG4gICAgICAgICAgZXJyb3JEZXNjcmlwdGlvbiA9IGBEZWVwU2VlazogQXV0aGVudGljYXRpb24gZmFpbGVkLiBDaGVjayB5b3VyIEFQSSBrZXkuYDtcclxuICAgICAgICAgIGJyZWFrO1xyXG4gICAgICAgIGNhc2UgNDAyOlxyXG4gICAgICAgICAgZXJyb3JEZXNjcmlwdGlvbiA9IGBEZWVwU2VlazogSW5zdWZmaWNpZW50IGJhbGFuY2UuIFBsZWFzZSB0b3AgdXAgeW91ciBhY2NvdW50LmA7XHJcbiAgICAgICAgICBicmVhaztcclxuICAgICAgICBjYXNlIDQyMjpcclxuICAgICAgICAgIGVycm9yRGVzY3JpcHRpb24gPSBgRGVlcFNlZWs6IEludmFsaWQgcGFyYW1ldGVycy4gJHtlcnJvck1zZ31gO1xyXG4gICAgICAgICAgYnJlYWs7XHJcbiAgICAgICAgY2FzZSA0Mjk6XHJcbiAgICAgICAgICBlcnJvckRlc2NyaXB0aW9uID0gYERlZXBTZWVrOiBSYXRlIGxpbWl0IHJlYWNoZWQuIFN3aXRjaGluZyB0byBDbGF1ZGUuYDtcclxuICAgICAgICAgIGJyZWFrO1xyXG4gICAgICAgIGNhc2UgNTAwOlxyXG4gICAgICAgICAgZXJyb3JEZXNjcmlwdGlvbiA9IGBEZWVwU2VlazogU2VydmVyIGVycm9yLiAke2Vycm9yTXNnfWA7XHJcbiAgICAgICAgICBicmVhaztcclxuICAgICAgICBjYXNlIDUwMzpcclxuICAgICAgICAgIGVycm9yRGVzY3JpcHRpb24gPSBgRGVlcFNlZWs6IFNlcnZlciBvdmVybG9hZGVkLiBTd2l0Y2hpbmcgdG8gQ2xhdWRlLmA7XHJcbiAgICAgICAgICBicmVhaztcclxuICAgICAgICBkZWZhdWx0OlxyXG4gICAgICAgICAgZXJyb3JEZXNjcmlwdGlvbiA9IGBEZWVwU2VlayBBUEkgRXJyb3IgKCR7c3RhdHVzfSk6ICR7ZXJyb3JNc2d9YDtcclxuICAgICAgICAgIGJyZWFrO1xyXG4gICAgICB9XHJcblxyXG4gICAgICBsb2coYFtTdHVkeSBBc3Npc3RdIERlZXBTZWVrIGVycm9yICR7c3RhdHVzfSR7c2tpcFJldHJ5ID8gXCIgKG5vbi1yZXRyeWFibGUpXCIgOiBcIlwifTogJHtlcnJvckRlc2NyaXB0aW9ufWApO1xyXG4gICAgICByZXR1cm4geyBzdWNjZXNzOiBmYWxzZSwgZXJyb3I6IGVycm9yRGVzY3JpcHRpb24sIHNraXBSZXRyeSB9O1xyXG4gICAgfVxyXG5cclxuICAgIGNvbnN0IG1lc3NhZ2UgPSByZXNwb25zZUJvZHk/LmNob2ljZXM/LlswXT8ubWVzc2FnZTtcclxuICAgIGNvbnN0IHJlYXNvbmluZ0NvbnRlbnQgPSBtZXNzYWdlPy5yZWFzb25pbmdfY29udGVudCB8fCBudWxsO1xyXG4gICAgY29uc3QgcmVzdWx0ID0gbWVzc2FnZT8uY29udGVudDtcclxuXHJcbiAgICBpZiAoIXJlc3VsdCkge1xyXG4gICAgICByZXR1cm4geyBzdWNjZXNzOiBmYWxzZSwgZXJyb3I6IFwiTm8gcmVzcG9uc2UgZnJvbSBEZWVwU2Vla1wiIH07XHJcbiAgICB9XHJcblxyXG4gICAgLy8gRXh0cmFjdCByZWFsIHRva2VuIGNvdW50cyBmcm9tIEFQSSByZXNwb25zZVxyXG4gICAgY29uc3QgYXBpSW5wdXRUb2tlbnMgPSByZXNwb25zZUJvZHk/LnVzYWdlPy5wcm9tcHRfdG9rZW5zID8/IDA7XHJcbiAgICBjb25zdCBhcGlPdXRwdXRUb2tlbnMgPSByZXNwb25zZUJvZHk/LnVzYWdlPy5jb21wbGV0aW9uX3Rva2VucyA/PyAwO1xyXG5cclxuICAgIGlmIChERUJVR19NT0RFKSB7XHJcbiAgICAgIGNvbnNvbGUubG9nKFwiW1N0dWR5IEFzc2lzdF0gPT09PT09IERlZXBTZWVrIFJlc3BvbnNlID09PT09PVwiKTtcclxuICAgICAgaWYgKHJlYXNvbmluZ0NvbnRlbnQpIGNvbnNvbGUubG9nKFwiW1N0dWR5IEFzc2lzdF0gRGVlcFNlZWsgUkVBU09OSU5HOlwiLCByZWFzb25pbmdDb250ZW50KTtcclxuICAgICAgY29uc29sZS5sb2coXCJbU3R1ZHkgQXNzaXN0XSBEZWVwU2VlayBBTlNXRVI6XCIsIHJlc3VsdCk7XHJcbiAgICAgIGNvbnNvbGUubG9nKFwiW1N0dWR5IEFzc2lzdF0gRGVlcFNlZWsgVE9LRU5TOlwiLCBhcGlJbnB1dFRva2VucywgXCIrXCIsIGFwaU91dHB1dFRva2Vucyk7XHJcbiAgICAgIGNvbnNvbGUubG9nKFwiW1N0dWR5IEFzc2lzdF0gPT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT1cIik7XHJcbiAgICB9XHJcblxyXG4gICAgc2V0QWN0aXZlRGVlcFNlZWtDb250cm9sbGVyKG51bGwpO1xyXG4gICAgY29uc3QgcGFyc2VkID0gcGFyc2VEZWVwU2Vla1Jlc3BvbnNlKHJlc3VsdCwgY29udGV4dCwgcmVhc29uaW5nQ29udGVudCk7XHJcbiAgICAvLyBBdHRhY2ggcmVhbCB0b2tlbiBjb3VudHNcclxuICAgIHBhcnNlZC5pbnB1dFRva2VucyA9IGFwaUlucHV0VG9rZW5zO1xyXG4gICAgcGFyc2VkLm91dHB1dFRva2VucyA9IGFwaU91dHB1dFRva2VucztcclxuICAgIHJldHVybiBwYXJzZWQ7XHJcbiAgfSBjYXRjaCAoZXJyb3IpIHtcclxuICAgIHNldEFjdGl2ZURlZXBTZWVrQ29udHJvbGxlcihudWxsKTtcclxuICAgIGlmICgoZXJyb3IgYXMgRXJyb3IpLm5hbWUgPT09IFwiQWJvcnRFcnJvclwiKSB7XHJcbiAgICAgIGxvZyhcIltTdHVkeSBBc3Npc3RdIERlZXBTZWVrIHJlcXVlc3QgY2FuY2VsbGVkXCIpO1xyXG4gICAgICByZXR1cm4geyBzdWNjZXNzOiBmYWxzZSwgZXJyb3I6IFwiRGVlcFNlZWsgY2FuY2VsbGVkXCIsIGNhbmNlbGxlZDogdHJ1ZSB9O1xyXG4gICAgfVxyXG4gICAgcmV0dXJuIHsgc3VjY2VzczogZmFsc2UsIGVycm9yOiBgRGVlcFNlZWsgZXJyb3I6ICR7KGVycm9yIGFzIEVycm9yKS5tZXNzYWdlfWAgfTtcclxuICB9XHJcbn1cclxuXHJcbi8vID09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09XHJcbi8vIENsYXVkZSBBbmFseXNpc1xyXG4vLyA9PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PVxyXG5cclxuZXhwb3J0IGFzeW5jIGZ1bmN0aW9uIGFuYWx5emVXaXRoQ2xhdWRlKFxyXG4gIGNvbnRleHQ6IEFuYWx5c2lzQ29udGV4dCxcclxuICBhcGlLZXk6IHN0cmluZyxcclxuICBtb2RlbDogc3RyaW5nLFxyXG4gIGRlZXBzZWVrQW5hbHlzaXM6IERlZXBTZWVrQW5hbHlzaXNGb3JDbGF1ZGUgfCBudWxsID0gbnVsbCxcclxuICBzdGFydFRpbWU6IG51bWJlciA9IERhdGUubm93KCksXHJcbiAgZmFsbGJhY2tSZWFzb25PdmVycmlkZT86IHN0cmluZyxcclxuKTogUHJvbWlzZTxBbmFseXNpc1Jlc3BvbnNlPiB7XHJcbiAgbGV0IG1hdGNoZWRRdWVzdGlvbiA9IG51bGw7XHJcbiAgaWYgKCFkZWVwc2Vla0FuYWx5c2lzKSB7XHJcbiAgICBtYXRjaGVkUXVlc3Rpb24gPSBhd2FpdCBmaW5kTWF0Y2hpbmdRdWVzdGlvbihcclxuICAgICAgY29udGV4dC5xdWVzdGlvblRleHQsXHJcbiAgICAgIChjb250ZXh0IGFzIEFuYWx5c2lzQ29udGV4dCAmIHsgbW9kdWxlSW5mbz86IHN0cmluZyB9KS5tb2R1bGVJbmZvIHx8IGNvbnRleHQucGFnZVRpdGxlLFxyXG4gICAgICBjb250ZXh0LnBhZ2VVcmwsXHJcbiAgICApO1xyXG4gIH1cclxuXHJcbiAgY29uc3QgcHJvbXB0ID0gZGVlcHNlZWtBbmFseXNpc1xyXG4gICAgPyBidWlsZENsYXVkZVZhbGlkYXRpb25Qcm9tcHQoY29udGV4dCwgZGVlcHNlZWtBbmFseXNpcylcclxuICAgIDogYnVpbGRBbmFseXNpc1Byb21wdChjb250ZXh0LCBtYXRjaGVkUXVlc3Rpb24pO1xyXG5cclxuICBsb2coXCJbU3R1ZHkgQXNzaXN0XSBDbGF1ZGUgYW5hbHlzaXMuLi5cIiwgZGVlcHNlZWtBbmFseXNpcyA/IFwiKHZhbGlkYXRpbmcgRGVlcFNlZWspXCIgOiBcIlwiKTtcclxuXHJcbiAgY29uc3QgbWVzc2FnZUNvbnRlbnQgPSBidWlsZE1lc3NhZ2VDb250ZW50KHByb21wdCwgY29udGV4dC5pbWFnZXMpO1xyXG5cclxuICBjb25zdCBxdWVzdGlvblRleHQgPSBjb250ZXh0LnF1ZXN0aW9uVGV4dCB8fCBcIlwiO1xyXG4gIGNvbnN0IG11bHRpQW5zd2VyUGF0dGVybiA9IC9lbGlqYVxccyooZG9zfHRyZXN8Y3VhdHJvfGNpbmNvfDJ8M3w0fDUpfGVzY29qYVxccyooZG9zfHRyZXN8Y3VhdHJvfGNpbmNvfDJ8M3w0fDUpfHNlbGVjY2lvbmVcXHMqKGRvc3x0cmVzfGN1YXRyb3xjaW5jb3wyfDN8NHw1KXxzZWxlY3RcXHMqKHR3b3x0aHJlZXxmb3VyfGZpdmV8MnwzfDR8NSl8Y2hvb3NlXFxzKih0d298dGhyZWV8Zm91cnxmaXZlfDJ8M3w0fDUpfFxcKFxccyooZG9zfHRyZXN8Y3VhdHJvfHR3b3x0aHJlZXxmb3VyfDJ8M3w0fDUpXFxzKm9wY2lvbmVzP1xccypcXCkvaTtcclxuICBjb25zdCBpc011bHRpcGxlQW5zd2VyID0gbXVsdGlBbnN3ZXJQYXR0ZXJuLnRlc3QocXVlc3Rpb25UZXh0KTtcclxuICBjb25zdCBpc1F1aWNrTW9kZSA9IGNvbnRleHQucmVzcG9uc2VNb2RlID09PSBcInF1aWNrXCI7XHJcbiAgY29uc3QgaXNNYXRjaGluZyA9IGNvbnRleHQucXVlc3Rpb25UeXBlID09PSBcIm1hdGNoaW5nXCI7XHJcbiAgY29uc3QgaGFzSW1hZ2VzID0gY29udGV4dC5pbWFnZXMgJiYgY29udGV4dC5pbWFnZXMubGVuZ3RoID4gMDtcclxuICBjb25zdCBtYXhUb2tlbnMgPSBkZWVwc2Vla0FuYWx5c2lzID8gMjA0OCA6IDEwMjQ7XHJcblxyXG4gIGxvZyhcIltTdHVkeSBBc3Npc3RdIENsYXVkZSBjb25maWc6XCIsIHsgbWF4VG9rZW5zLCBoYXNJbWFnZXMsIGlzTXVsdGlwbGVBbnN3ZXIsIGhhc0RlZXBTZWVrQW5hbHlzaXM6ICEhZGVlcHNlZWtBbmFseXNpcyB9KTtcclxuXHJcbiAgY29uc3QgbWVzc2FnZXM6IENsYXVkZU1lc3NhZ2VbXSA9IFt7IHJvbGU6IFwidXNlclwiLCBjb250ZW50OiBtZXNzYWdlQ29udGVudCB9XTtcclxuXHJcbiAgY29uc3QgcmVzcG9uc2UgPSBhd2FpdCBmZXRjaFdpdGhSZXRyeShcclxuICAgIENMQVVERV9BUElfQkFTRSxcclxuICAgIHtcclxuICAgICAgbWV0aG9kOiBcIlBPU1RcIixcclxuICAgICAgaGVhZGVyczoge1xyXG4gICAgICAgIFwiQ29udGVudC1UeXBlXCI6IFwiYXBwbGljYXRpb24vanNvblwiLFxyXG4gICAgICAgIFwieC1hcGkta2V5XCI6IGFwaUtleSxcclxuICAgICAgICBcImFudGhyb3BpYy12ZXJzaW9uXCI6IEFOVEhST1BJQ19WRVJTSU9OLFxyXG4gICAgICAgIFwiYW50aHJvcGljLWRhbmdlcm91cy1kaXJlY3QtYnJvd3Nlci1hY2Nlc3NcIjogXCJ0cnVlXCIsXHJcbiAgICAgIH0sXHJcbiAgICAgIGJvZHk6IEpTT04uc3RyaW5naWZ5KHsgbW9kZWwsIG1heF90b2tlbnM6IG1heFRva2VucywgbWVzc2FnZXMgfSBhcyBDbGF1ZGVSZXF1ZXN0Qm9keSksXHJcbiAgICB9LFxyXG4gICAgMixcclxuICAgIDQ1MDAwLFxyXG4gICk7XHJcblxyXG4gIGxldCByZXNwb25zZUJvZHk6IENsYXVkZUFwaVJlc3BvbnNlIHwgbnVsbCA9IG51bGw7XHJcbiAgdHJ5IHtcclxuICAgIHJlc3BvbnNlQm9keSA9IGF3YWl0IHJlc3BvbnNlLmNsb25lKCkuanNvbigpIGFzIENsYXVkZUFwaVJlc3BvbnNlO1xyXG4gIH0gY2F0Y2ggKGUpIHtcclxuICAgIHJlc3BvbnNlQm9keSA9IHsgcGFyc2VFcnJvcjogKGUgYXMgRXJyb3IpLm1lc3NhZ2UgfTtcclxuICB9XHJcblxyXG4gIGF3YWl0IGxvZ0Vycm9yKHtcclxuICAgIHR5cGU6IFwiYW5hbHl6ZVdpdGhDbGF1ZGVcIixcclxuICAgIHVybDogQ0xBVURFX0FQSV9CQVNFLFxyXG4gICAgc3RhdHVzOiByZXNwb25zZS5zdGF0dXMsXHJcbiAgICBzdGF0dXNUZXh0OiByZXNwb25zZS5zdGF0dXNUZXh0LFxyXG4gICAgcmVzcG9uc2VCb2R5LFxyXG4gICAgaGFzSW1hZ2VzOiBoYXNJbWFnZXMgfHwgZmFsc2UsXHJcbiAgfSk7XHJcblxyXG4gIC8vIFNhdmUgZnVsbCBBUEkgcmVxdWVzdC9yZXNwb25zZSBmb3IgZGV2ZWxvcGVyIG1vZGUgaW4gZGFzaGJvYXJkXHJcbiAgdHJ5IHtcclxuICAgIGF3YWl0IGNocm9tZS5zdG9yYWdlLmxvY2FsLnNldCh7XHJcbiAgICAgIGxhc3RBcGlSZXF1ZXN0RGF0YToge1xyXG4gICAgICAgIHRpbWVzdGFtcDogRGF0ZS5ub3coKSxcclxuICAgICAgICB0eXBlOiBcImFuYWx5emVXaXRoQ2xhdWRlXCIsXHJcbiAgICAgICAgdXJsOiBDTEFVREVfQVBJX0JBU0UsXHJcbiAgICAgICAgc3RhdHVzOiByZXNwb25zZS5zdGF0dXMsXHJcbiAgICAgICAgc3RhdHVzVGV4dDogcmVzcG9uc2Uuc3RhdHVzVGV4dCxcclxuICAgICAgICBoYXNJbWFnZXM6IGhhc0ltYWdlcyB8fCBmYWxzZSxcclxuICAgICAgICByZXF1ZXN0Qm9keTogeyBtb2RlbCwgbWF4X3Rva2VuczogbWF4VG9rZW5zLCBtZXNzYWdlcyB9LFxyXG4gICAgICAgIHJlc3BvbnNlQm9keSxcclxuICAgICAgfSxcclxuICAgIH0pO1xyXG4gIH0gY2F0Y2ggKF9lKSB7IC8qIHNpbGVudCAqLyB9XHJcblxyXG4gIGlmICghcmVzcG9uc2Uub2spIHtcclxuICAgIHJldHVybiBoYW5kbGVBcGlFcnJvcihyZXNwb25zZS5zdGF0dXMsIHJlc3BvbnNlQm9keSk7XHJcbiAgfVxyXG5cclxuICBsZXQgcmVzdWx0ID0gcmVzcG9uc2VCb2R5Py5jb250ZW50Py5bMF0/LnRleHQ7XHJcbiAgaWYgKCFyZXN1bHQpIHJldHVybiB7IHN1Y2Nlc3M6IGZhbHNlLCBlcnJvcjogXCJObyByZXNwb25zZSBnZW5lcmF0ZWQuXCIgfTtcclxuXHJcbiAgbG9nKFwiW1N0dWR5IEFzc2lzdF0gQ2xhdWRlIHJlc3BvbnNlOlwiLCByZXN1bHQpO1xyXG5cclxuICAvLyBVc2UgcmVhbCB0b2tlbiBjb3VudHMgZnJvbSBDbGF1ZGUgQVBJIHJlc3BvbnNlLCBmYWxsIGJhY2sgdG8gZXN0aW1hdGVzXHJcbiAgY29uc3QgcmVhbElucHV0VG9rZW5zID0gcmVzcG9uc2VCb2R5Py51c2FnZT8uaW5wdXRfdG9rZW5zID8/IE1hdGguY2VpbCgocHJvbXB0Py5sZW5ndGggfHwgMCkgLyA0KTtcclxuICBjb25zdCByZWFsT3V0cHV0VG9rZW5zID0gcmVzcG9uc2VCb2R5Py51c2FnZT8ub3V0cHV0X3Rva2VucyA/PyBNYXRoLmNlaWwoKHJlc3VsdD8ubGVuZ3RoIHx8IDApIC8gNCk7XHJcbiAgY29uc3QgaXNWYWxpZGF0aW9uID0gISFkZWVwc2Vla0FuYWx5c2lzO1xyXG4gIGNvbnN0IGZhbGxiYWNrUmVhc29uID0gZmFsbGJhY2tSZWFzb25PdmVycmlkZSB8fCAoKCFkZWVwc2Vla0FuYWx5c2lzICYmIGhhc0ltYWdlcykgPyBcImltYWdlc1wiIDogdW5kZWZpbmVkKTtcclxuICBhd2FpdCB0cmFja1VzYWdlKHtcclxuICAgIHRpbWVzdGFtcDogRGF0ZS5ub3coKSxcclxuICAgIHF1ZXN0aW9uVGV4dDogY29udGV4dC5xdWVzdGlvblRleHQuc3Vic3RyaW5nKDAsIDIwMCksXHJcbiAgICBxdWVzdGlvblR5cGU6IGNvbnRleHQucXVlc3Rpb25UeXBlLFxyXG4gICAgYW5zd2VyOiByZXN1bHQsXHJcbiAgICBzb3VyY2U6IFwiY2xhdWRlXCIsXHJcbiAgICBtb2RlbCxcclxuICAgIGlucHV0VG9rZW5zOiByZWFsSW5wdXRUb2tlbnMsXHJcbiAgICBvdXRwdXRUb2tlbnM6IHJlYWxPdXRwdXRUb2tlbnMsXHJcbiAgICByZXNwb25zZU1vZGU6IGNvbnRleHQucmVzcG9uc2VNb2RlLFxyXG4gICAgc3VjY2VzczogdHJ1ZSxcclxuICAgIGxhdGVuY3lNczogRGF0ZS5ub3coKSAtIHN0YXJ0VGltZSxcclxuICAgIHBsYXRmb3JtOiBkZXRlY3RQbGF0Zm9ybShjb250ZXh0LnBhZ2VVcmwpLFxyXG4gICAgdmFsaWRhdGVkOiBpc1ZhbGlkYXRpb24sXHJcbiAgICBmYWxsYmFja1JlYXNvbixcclxuICAgIGNvbmZpZGVuY2U6IGRlZXBzZWVrQW5hbHlzaXM/LmNvbmZpZGVuY2UsXHJcbiAgICBkZWVwc2Vla1JlYXNvbmluZzogZGVlcHNlZWtBbmFseXNpcz8ucmVhc29uaW5nID8/IHVuZGVmaW5lZCxcclxuICB9KTtcclxuXHJcbiAgLy8gRm9yIHF1aWNrIG1vZGUsIGV4dHJhY3QgdGhlIGZpbmFsIGFuc3dlclxyXG4gIGlmIChpc1F1aWNrTW9kZSAmJiAhaXNNYXRjaGluZykge1xyXG4gICAgcmVzdWx0ID0gZXh0cmFjdENsYXVkZVF1aWNrQW5zd2VyKHJlc3VsdCwgY29udGV4dC5xdWVzdGlvblR5cGUpO1xyXG4gIH1cclxuXHJcbiAgcmV0dXJuIHsgc3VjY2VzczogdHJ1ZSwgcmVzdWx0LCBzb3VyY2U6IFwiY2xhdWRlXCIgfTtcclxufVxyXG5cclxuLy8gPT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT1cclxuLy8gU3RyZWFtaW5nIEFuYWx5c2lzIGZvciBGdWxsIChub24tcXVpY2spIE1vZGVcclxuLy8gPT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT1cclxuXHJcbmV4cG9ydCBhc3luYyBmdW5jdGlvbiBhbmFseXplUXVlc3Rpb25TdHJlYW1pbmcoXHJcbiAgY29udGV4dDogQW5hbHlzaXNDb250ZXh0LFxyXG4gIHBvcnQ6IGNocm9tZS5ydW50aW1lLlBvcnQsXHJcbik6IFByb21pc2U8dm9pZD4ge1xyXG4gIGNvbnN0IHN0YXJ0VGltZSA9IERhdGUubm93KCk7XHJcblxyXG4gIHRyeSB7XHJcbiAgICAvLyA9PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PVxyXG4gICAgLy8gUXVlc3Rpb24gQmFuayBJbnN0YW50IE1hdGNoIChza2lwIEFJIGVudGlyZWx5KVxyXG4gICAgLy8gPT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT1cclxuICAgIGNvbnN0IGJhbmtNYXRjaCA9IGF3YWl0IGZpbmRNYXRjaGluZ1F1ZXN0aW9uKFxyXG4gICAgICBjb250ZXh0LnF1ZXN0aW9uVGV4dCxcclxuICAgICAgKGNvbnRleHQgYXMgQW5hbHlzaXNDb250ZXh0ICYgeyBtb2R1bGVJbmZvPzogc3RyaW5nIH0pLm1vZHVsZUluZm8gfHwgY29udGV4dC5wYWdlVGl0bGUsXHJcbiAgICAgIGNvbnRleHQucGFnZVVybCxcclxuICAgICk7XHJcblxyXG4gICAgaWYgKGJhbmtNYXRjaCAmJiAoYmFua01hdGNoLmNvcnJlY3RBbnN3ZXIgfHwgYmFua01hdGNoLmNvcnJlY3RBbnN3ZXJzKSAmJiBiYW5rTWF0Y2guc2ltaWxhcml0eSA+PSA4MCkge1xyXG4gICAgICBjb25zdCBhbnN3ZXJMZXR0ZXIgPSBtYXRjaENvcnJlY3RBbnN3ZXJUb0xldHRlcihiYW5rTWF0Y2gsIGNvbnRleHQub3B0aW9ucyk7XHJcbiAgICAgIGlmIChhbnN3ZXJMZXR0ZXIpIHtcclxuICAgICAgICBjb25zdCBkaXNwbGF5QW5zd2VyID0gYmFua01hdGNoLmNvcnJlY3RBbnN3ZXJzID8gYmFua01hdGNoLmNvcnJlY3RBbnN3ZXJzLmpvaW4oJyB8ICcpIDogYmFua01hdGNoLmNvcnJlY3RBbnN3ZXIgfHwgJyc7XHJcbiAgICAgICAgbG9nKGBbU3R1ZHkgQXNzaXN0XSBJTlNUQU5UIEFOU1dFUiAoc3RyZWFtaW5nKSBmcm9tIHF1ZXN0aW9uIGJhbmsgKCR7YmFua01hdGNoLnNpbWlsYXJpdHl9JSBtYXRjaCk6ICR7YW5zd2VyTGV0dGVyfWApO1xyXG4gICAgICAgIGF3YWl0IHRyYWNrVXNhZ2Uoe1xyXG4gICAgICAgICAgdGltZXN0YW1wOiBEYXRlLm5vdygpLFxyXG4gICAgICAgICAgcXVlc3Rpb25UZXh0OiBjb250ZXh0LnF1ZXN0aW9uVGV4dC5zdWJzdHJpbmcoMCwgMjAwKSxcclxuICAgICAgICAgIHF1ZXN0aW9uVHlwZTogY29udGV4dC5xdWVzdGlvblR5cGUsXHJcbiAgICAgICAgICBhbnN3ZXI6IGFuc3dlckxldHRlcixcclxuICAgICAgICAgIHNvdXJjZTogXCJxdWVzdGlvbi1iYW5rXCIsXHJcbiAgICAgICAgICBtb2RlbDogXCJxdWVzdGlvbnMtYmFuay5qc29uXCIsXHJcbiAgICAgICAgICBpbnB1dFRva2VuczogMCxcclxuICAgICAgICAgIG91dHB1dFRva2VuczogMCxcclxuICAgICAgICAgIHJlc3BvbnNlTW9kZTogY29udGV4dC5yZXNwb25zZU1vZGUsXHJcbiAgICAgICAgICBzdWNjZXNzOiB0cnVlLFxyXG4gICAgICAgICAgbGF0ZW5jeU1zOiBEYXRlLm5vdygpIC0gc3RhcnRUaW1lLFxyXG4gICAgICAgICAgcGxhdGZvcm06IGRldGVjdFBsYXRmb3JtKGNvbnRleHQucGFnZVVybCksXHJcbiAgICAgICAgICBjb25maWRlbmNlOiBcIkhJR0hcIixcclxuICAgICAgICB9KTtcclxuICAgICAgICBjb25zdCBiYW5rQ2h1bmtUZXh0ID0gYCoqUmVzcHVlc3RhIGRlbCBiYW5jbyBkZSBwcmVndW50YXMgKCR7YmFua01hdGNoLnNpbWlsYXJpdHl9JSBjb2luY2lkZW5jaWEpOioqXFxuXFxuKioke2Fuc3dlckxldHRlcn0qKiBcdTIwMTQgJHtkaXNwbGF5QW5zd2VyfVxcblxcbiR7YmFua01hdGNoLmV4cGxhbmF0aW9uIHx8IFwiXCJ9YDtcclxuICAgICAgICB0cnkge1xyXG4gICAgICAgICAgcG9ydC5wb3N0TWVzc2FnZSh7IHR5cGU6IFwiU1RSRUFNX1NUQVRVU1wiLCBzdGF0dXM6IFwic3RhcnRlZFwiIH0pO1xyXG4gICAgICAgICAgcG9ydC5wb3N0TWVzc2FnZSh7IHR5cGU6IFwiU1RSRUFNX0NIVU5LXCIsIGNodW5rOiBiYW5rQ2h1bmtUZXh0IH0pO1xyXG4gICAgICAgICAgcG9ydC5wb3N0TWVzc2FnZSh7IHR5cGU6IFwiU1RSRUFNX0NPTVBMRVRFXCIsIGZ1bGxUZXh0OiBiYW5rQ2h1bmtUZXh0LCBpbnB1dFRva2VuczogMCwgb3V0cHV0VG9rZW5zOiAwLCBjb3N0OiAwIH0pO1xyXG4gICAgICAgIH0gY2F0Y2ggeyAvKiBwb3J0IGRpc2Nvbm5lY3RlZCAqLyB9XHJcbiAgICAgICAgcmV0dXJuO1xyXG4gICAgICB9XHJcbiAgICB9XHJcblxyXG4gICAgLy8gUmF0ZSBsaW1pdGluZ1xyXG4gICAgY29uc3QgcmF0ZUxpbWl0RXJyb3IgPSBjaGVja1JhdGVMaW1pdChjb250ZXh0LnF1ZXN0aW9uVGV4dCk7XHJcbiAgICBpZiAocmF0ZUxpbWl0RXJyb3IpIHtcclxuICAgICAgcG9ydC5wb3N0TWVzc2FnZSh7IHR5cGU6IFwiU1RSRUFNX0VSUk9SXCIsIGVycm9yOiByYXRlTGltaXRFcnJvciB9KTtcclxuICAgICAgcmV0dXJuO1xyXG4gICAgfVxyXG4gICAgcmVjb3JkUmVxdWVzdChjb250ZXh0LnF1ZXN0aW9uVGV4dCk7XHJcblxyXG4gICAgY29uc3QgY2xhdWRlQXBpS2V5ID0gYXdhaXQgZ2V0RGVjcnlwdGVkQXBpS2V5KFwiY2xhdWRlQXBpS2V5XCIpO1xyXG4gICAgY29uc3Qgc3RvcmFnZVJlc3VsdCA9IGF3YWl0IGNocm9tZS5zdG9yYWdlLmxvY2FsLmdldChbXCJjbGF1ZGVNb2RlbFwiXSkgYXMgU3RvcmFnZURhdGE7XHJcbiAgICBjb25zdCBtb2RlbCA9IGNvbnRleHQucWFNb2RlID8gUUFfQ0xBVURFX01PREVMIDogKHN0b3JhZ2VSZXN1bHQuY2xhdWRlTW9kZWwgfHwgREVGQVVMVF9NT0RFTCk7XHJcblxyXG4gICAgaWYgKCFjbGF1ZGVBcGlLZXkpIHtcclxuICAgICAgcG9ydC5wb3N0TWVzc2FnZSh7IHR5cGU6IFwiU1RSRUFNX0VSUk9SXCIsIGVycm9yOiBcIkNsYXVkZSBBUEkga2V5IG5vdCBjb25maWd1cmVkLlwiIH0pO1xyXG4gICAgICByZXR1cm47XHJcbiAgICB9XHJcblxyXG4gICAgY29uc3QgbWF0Y2hlZFF1ZXN0aW9uID0gYmFua01hdGNoO1xyXG5cclxuICAgIGNvbnN0IHByb21wdCA9IGJ1aWxkQW5hbHlzaXNQcm9tcHQoY29udGV4dCwgbWF0Y2hlZFF1ZXN0aW9uKTtcclxuICAgIGNvbnN0IG1lc3NhZ2VDb250ZW50ID0gYnVpbGRNZXNzYWdlQ29udGVudChwcm9tcHQsIGNvbnRleHQuaW1hZ2VzKTtcclxuICAgIGNvbnN0IG1heFRva2VucyA9IDEwMjQ7XHJcbiAgICBjb25zdCBtZXNzYWdlczogQ2xhdWRlTWVzc2FnZVtdID0gW3sgcm9sZTogXCJ1c2VyXCIsIGNvbnRlbnQ6IG1lc3NhZ2VDb250ZW50IH1dO1xyXG5cclxuICAgIHBvcnQucG9zdE1lc3NhZ2UoeyB0eXBlOiBcIlNUUkVBTV9TVEFUVVNcIiwgc3RhdHVzOiBcInN0YXJ0ZWRcIiB9KTtcclxuXHJcbiAgICBjb25zdCByZXN1bHQgPSBhd2FpdCBzdHJlYW1DbGF1ZGVSZXNwb25zZShcclxuICAgICAgY2xhdWRlQXBpS2V5LFxyXG4gICAgICBtb2RlbCxcclxuICAgICAgbWVzc2FnZXMsXHJcbiAgICAgIG1heFRva2VucyxcclxuICAgICAge1xyXG4gICAgICAgIG9uQ2h1bmsodGV4dDogc3RyaW5nKSB7XHJcbiAgICAgICAgICB0cnkge1xyXG4gICAgICAgICAgICBwb3J0LnBvc3RNZXNzYWdlKHsgdHlwZTogXCJTVFJFQU1fQ0hVTktcIiwgY2h1bms6IHRleHQgfSk7XHJcbiAgICAgICAgICB9IGNhdGNoIHsgLyogcG9ydCBkaXNjb25uZWN0ZWQgKi8gfVxyXG4gICAgICAgIH0sXHJcbiAgICAgICAgb25JbnB1dFRva2Vucyhjb3VudDogbnVtYmVyKSB7XHJcbiAgICAgICAgICB0cnkge1xyXG4gICAgICAgICAgICBwb3J0LnBvc3RNZXNzYWdlKHsgdHlwZTogXCJTVFJFQU1fU1RBVFVTXCIsIHN0YXR1czogXCJpbnB1dF90b2tlbnNcIiwgaW5wdXRUb2tlbnM6IGNvdW50IH0pO1xyXG4gICAgICAgICAgfSBjYXRjaCB7IC8qIHBvcnQgZGlzY29ubmVjdGVkICovIH1cclxuICAgICAgICB9LFxyXG4gICAgICAgIG9uQ29tcGxldGUob3V0cHV0VG9rZW5zOiBudW1iZXIpIHtcclxuICAgICAgICAgIHRyeSB7XHJcbiAgICAgICAgICAgIHBvcnQucG9zdE1lc3NhZ2UoeyB0eXBlOiBcIlNUUkVBTV9TVEFUVVNcIiwgc3RhdHVzOiBcImNvbXBsZXRlXCIsIG91dHB1dFRva2VucyB9KTtcclxuICAgICAgICAgIH0gY2F0Y2ggeyAvKiBwb3J0IGRpc2Nvbm5lY3RlZCAqLyB9XHJcbiAgICAgICAgfSxcclxuICAgICAgICBvbkVycm9yKGVycm9yOiBzdHJpbmcpIHtcclxuICAgICAgICAgIHRyeSB7XHJcbiAgICAgICAgICAgIHBvcnQucG9zdE1lc3NhZ2UoeyB0eXBlOiBcIlNUUkVBTV9FUlJPUlwiLCBlcnJvciB9KTtcclxuICAgICAgICAgIH0gY2F0Y2ggeyAvKiBwb3J0IGRpc2Nvbm5lY3RlZCAqLyB9XHJcbiAgICAgICAgfSxcclxuICAgICAgfSxcclxuICAgICk7XHJcblxyXG4gICAgLy8gVHJhY2sgdXNhZ2Ugd2l0aCByZWFsIHRva2VuIGNvdW50cyBmcm9tIHN0cmVhbWluZ1xyXG4gICAgYXdhaXQgdHJhY2tVc2FnZSh7XHJcbiAgICAgIHRpbWVzdGFtcDogRGF0ZS5ub3coKSxcclxuICAgICAgcXVlc3Rpb25UZXh0OiBjb250ZXh0LnF1ZXN0aW9uVGV4dC5zdWJzdHJpbmcoMCwgMjAwKSxcclxuICAgICAgcXVlc3Rpb25UeXBlOiBjb250ZXh0LnF1ZXN0aW9uVHlwZSxcclxuICAgICAgYW5zd2VyOiByZXN1bHQuZnVsbFRleHQuc3Vic3RyaW5nKDAsIDIwMCksXHJcbiAgICAgIHNvdXJjZTogXCJjbGF1ZGVcIixcclxuICAgICAgbW9kZWwsXHJcbiAgICAgIGlucHV0VG9rZW5zOiByZXN1bHQuaW5wdXRUb2tlbnMsXHJcbiAgICAgIG91dHB1dFRva2VuczogcmVzdWx0Lm91dHB1dFRva2VucyxcclxuICAgICAgcmVzcG9uc2VNb2RlOiBjb250ZXh0LnJlc3BvbnNlTW9kZSxcclxuICAgICAgc3VjY2VzczogdHJ1ZSxcclxuICAgICAgbGF0ZW5jeU1zOiBEYXRlLm5vdygpIC0gc3RhcnRUaW1lLFxyXG4gICAgICBwbGF0Zm9ybTogZGV0ZWN0UGxhdGZvcm0oY29udGV4dC5wYWdlVXJsKSxcclxuICAgIH0pO1xyXG5cclxuICAgIHBvcnQucG9zdE1lc3NhZ2Uoe1xyXG4gICAgICB0eXBlOiBcIlNUUkVBTV9DT01QTEVURVwiLFxyXG4gICAgICBmdWxsVGV4dDogcmVzdWx0LmZ1bGxUZXh0LFxyXG4gICAgICBpbnB1dFRva2VuczogcmVzdWx0LmlucHV0VG9rZW5zLFxyXG4gICAgICBvdXRwdXRUb2tlbnM6IHJlc3VsdC5vdXRwdXRUb2tlbnMsXHJcbiAgICAgIGNvc3Q6IGNhbGN1bGF0ZUNvc3QobW9kZWwsIHJlc3VsdC5pbnB1dFRva2VucywgcmVzdWx0Lm91dHB1dFRva2VucyksXHJcbiAgICB9KTtcclxuICB9IGNhdGNoIChlcnJvcikge1xyXG4gICAgaWYgKChlcnJvciBhcyBFcnJvcikubmFtZSAhPT0gXCJBYm9ydEVycm9yXCIpIHtcclxuICAgICAgdHJ5IHtcclxuICAgICAgICBwb3J0LnBvc3RNZXNzYWdlKHsgdHlwZTogXCJTVFJFQU1fRVJST1JcIiwgZXJyb3I6IChlcnJvciBhcyBFcnJvcikubWVzc2FnZSB9KTtcclxuICAgICAgfSBjYXRjaCB7IC8qIHBvcnQgZGlzY29ubmVjdGVkICovIH1cclxuICAgIH1cclxuICB9XHJcbn1cclxuIiwgIi8qKlxyXG4gKiBCYWNrZ3JvdW5kIFNlcnZpY2UgV29ya2VyIC0gRXh0ZW5zaW9uIFN0YXRlIE1hbmFnZW1lbnRcclxuICogSGFuZGxlcyB0b2dnbGUsIGRpc2d1aXNlIG1vZGUsIGFuZCBsaWZlY3ljbGUgZXZlbnRzXHJcbiAqL1xyXG5cclxuaW1wb3J0IHsgbG9nIH0gZnJvbSBcIi4vY29uc3RhbnRzLmpzXCI7XHJcbmltcG9ydCB0eXBlIHsgTWVzc2FnZVJlc3BvbnNlIH0gZnJvbSBcIi4vY29uc3RhbnRzLmpzXCI7XHJcblxyXG4vLyA9PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PVxyXG4vLyBFeHRlbnNpb24gVG9nZ2xlXHJcbi8vID09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09XHJcblxyXG5leHBvcnQgYXN5bmMgZnVuY3Rpb24gaGFuZGxlVG9nZ2xlRXh0ZW5zaW9uKGlzQWN0aXZlOiBib29sZWFuKTogUHJvbWlzZTxNZXNzYWdlUmVzcG9uc2U+IHtcclxuICB0cnkge1xyXG4gICAgY29uc3QgcmVzdWx0ID0gYXdhaXQgY2hyb21lLnN0b3JhZ2UubG9jYWwuZ2V0KFtcImRpc2d1aXNlTW9kZVwiXSkgYXMgeyBkaXNndWlzZU1vZGU/OiBib29sZWFuIH07XHJcbiAgICBjb25zdCBpc0Rpc2d1aXNlZCA9IHJlc3VsdC5kaXNndWlzZU1vZGUgPz8gZmFsc2U7XHJcblxyXG4gICAgaWYgKCFpc0Rpc2d1aXNlZCkge1xyXG4gICAgICBhd2FpdCBjaHJvbWUuYWN0aW9uLnNldEJhZGdlVGV4dCh7IHRleHQ6IGlzQWN0aXZlID8gXCJPTlwiIDogXCJcIiB9KTtcclxuICAgICAgYXdhaXQgY2hyb21lLmFjdGlvbi5zZXRCYWRnZUJhY2tncm91bmRDb2xvcih7IGNvbG9yOiBpc0FjdGl2ZSA/IFwiIzM0YTg1M1wiIDogXCIjZWE0MzM1XCIgfSk7XHJcbiAgICB9XHJcbiAgICByZXR1cm4geyBzdWNjZXNzOiB0cnVlIH07XHJcbiAgfSBjYXRjaCAoZXJyb3IpIHtcclxuICAgIGNvbnNvbGUuZXJyb3IoXCJbU3R1ZHkgQXNzaXN0XSBUb2dnbGUgZXJyb3I6XCIsIGVycm9yKTtcclxuICAgIHJldHVybiB7IHN1Y2Nlc3M6IGZhbHNlLCBlcnJvcjogKGVycm9yIGFzIEVycm9yKS5tZXNzYWdlIH07XHJcbiAgfVxyXG59XHJcblxyXG4vLyA9PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PVxyXG4vLyBEaXNndWlzZSBNb2RlICh1QmxvY2sgT3JpZ2luKVxyXG4vLyA9PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PVxyXG5cclxuZXhwb3J0IGFzeW5jIGZ1bmN0aW9uIGhhbmRsZURpc2d1aXNlTW9kZShlbmFibGVkOiBib29sZWFuKTogUHJvbWlzZTxNZXNzYWdlUmVzcG9uc2U+IHtcclxuICBsb2coXCJbU3R1ZHkgQXNzaXN0XSBoYW5kbGVEaXNndWlzZU1vZGUgY2FsbGVkIHdpdGg6XCIsIGVuYWJsZWQpO1xyXG4gIHRyeSB7XHJcbiAgICBpZiAoZW5hYmxlZCkge1xyXG4gICAgICBsb2coXCJbU3R1ZHkgQXNzaXN0XSBTZXR0aW5nIHVCbG9jayBpY29uLi4uXCIpO1xyXG4gICAgICBhd2FpdCBjaHJvbWUuYWN0aW9uLnNldEljb24oe1xyXG4gICAgICAgIHBhdGg6IHtcclxuICAgICAgICAgIDE2OiBjaHJvbWUucnVudGltZS5nZXRVUkwoXCJpY29ucy91YmxvY2svaWNvbl8xNi5wbmdcIiksXHJcbiAgICAgICAgICAzMjogY2hyb21lLnJ1bnRpbWUuZ2V0VVJMKFwiaWNvbnMvdWJsb2NrL2ljb25fMzIucG5nXCIpLFxyXG4gICAgICAgICAgNDg6IGNocm9tZS5ydW50aW1lLmdldFVSTChcImljb25zL3VibG9jay9pY29uXzY0LnBuZ1wiKSxcclxuICAgICAgICAgIDEyODogY2hyb21lLnJ1bnRpbWUuZ2V0VVJMKFwiaWNvbnMvdWJsb2NrL2ljb25fMTI4LnBuZ1wiKSxcclxuICAgICAgICB9LFxyXG4gICAgICB9KTtcclxuICAgICAgbG9nKFwiW1N0dWR5IEFzc2lzdF0gU2V0dGluZyB1QmxvY2sgdGl0bGUuLi5cIik7XHJcbiAgICAgIGF3YWl0IGNocm9tZS5hY3Rpb24uc2V0VGl0bGUoeyB0aXRsZTogXCJ1QmxvY2sgT3JpZ2luXCIgfSk7XHJcbiAgICAgIGF3YWl0IGNocm9tZS5hY3Rpb24uc2V0QmFkZ2VUZXh0KHsgdGV4dDogXCJcIiB9KTtcclxuICAgICAgbG9nKFwiW1N0dWR5IEFzc2lzdF0gRGlzZ3Vpc2UgbW9kZSBlbmFibGVkICh1QmxvY2sgT3JpZ2luKVwiKTtcclxuICAgIH0gZWxzZSB7XHJcbiAgICAgIGxvZyhcIltTdHVkeSBBc3Npc3RdIFJlc3RvcmluZyBvcmlnaW5hbCBpY29uLi4uXCIpO1xyXG4gICAgICBhd2FpdCBjaHJvbWUuYWN0aW9uLnNldEljb24oe1xyXG4gICAgICAgIHBhdGg6IHtcclxuICAgICAgICAgIDE2OiBjaHJvbWUucnVudGltZS5nZXRVUkwoXCJpY29ucy9pY29uMTYucG5nXCIpLFxyXG4gICAgICAgICAgMzI6IGNocm9tZS5ydW50aW1lLmdldFVSTChcImljb25zL2ljb24zMi5wbmdcIiksXHJcbiAgICAgICAgICA0ODogY2hyb21lLnJ1bnRpbWUuZ2V0VVJMKFwiaWNvbnMvaWNvbjQ4LnBuZ1wiKSxcclxuICAgICAgICAgIDEyODogY2hyb21lLnJ1bnRpbWUuZ2V0VVJMKFwiaWNvbnMvaWNvbjEyOC5wbmdcIiksXHJcbiAgICAgICAgfSxcclxuICAgICAgfSk7XHJcbiAgICAgIGxvZyhcIltTdHVkeSBBc3Npc3RdIFJlc3RvcmluZyBvcmlnaW5hbCB0aXRsZS4uLlwiKTtcclxuICAgICAgYXdhaXQgY2hyb21lLmFjdGlvbi5zZXRUaXRsZSh7IHRpdGxlOiBcIlN0dWR5IEFzc2lzdFwiIH0pO1xyXG5cclxuICAgICAgY29uc3QgcmVzdWx0ID0gYXdhaXQgY2hyb21lLnN0b3JhZ2UubG9jYWwuZ2V0KFtcImV4dGVuc2lvbkFjdGl2ZVwiXSkgYXMgeyBleHRlbnNpb25BY3RpdmU/OiBib29sZWFuIH07XHJcbiAgICAgIGNvbnN0IGlzQWN0aXZlID0gcmVzdWx0LmV4dGVuc2lvbkFjdGl2ZSA/PyBmYWxzZTtcclxuICAgICAgaWYgKGlzQWN0aXZlKSB7XHJcbiAgICAgICAgYXdhaXQgY2hyb21lLmFjdGlvbi5zZXRCYWRnZVRleHQoeyB0ZXh0OiBcIk9OXCIgfSk7XHJcbiAgICAgICAgYXdhaXQgY2hyb21lLmFjdGlvbi5zZXRCYWRnZUJhY2tncm91bmRDb2xvcih7IGNvbG9yOiBcIiMzNGE4NTNcIiB9KTtcclxuICAgICAgfVxyXG5cclxuICAgICAgbG9nKFwiW1N0dWR5IEFzc2lzdF0gRGlzZ3Vpc2UgbW9kZSBkaXNhYmxlZFwiKTtcclxuICAgIH1cclxuICAgIHJldHVybiB7IHN1Y2Nlc3M6IHRydWUgfTtcclxuICB9IGNhdGNoIChlcnJvcikge1xyXG4gICAgY29uc29sZS5lcnJvcihcIltTdHVkeSBBc3Npc3RdIERpc2d1aXNlIG1vZGUgZXJyb3I6XCIsIGVycm9yKTtcclxuICAgIHJldHVybiB7IHN1Y2Nlc3M6IGZhbHNlLCBlcnJvcjogKGVycm9yIGFzIEVycm9yKS5tZXNzYWdlIH07XHJcbiAgfVxyXG59XHJcblxyXG4vLyA9PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PVxyXG4vLyBSZXN0b3JlIERpc2d1aXNlIE1vZGVcclxuLy8gPT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT1cclxuXHJcbmV4cG9ydCBhc3luYyBmdW5jdGlvbiByZXN0b3JlRGlzZ3Vpc2VNb2RlKCk6IFByb21pc2U8dm9pZD4ge1xyXG4gIHRyeSB7XHJcbiAgICBjb25zdCB7IGRpc2d1aXNlTW9kZSB9ID0gYXdhaXQgY2hyb21lLnN0b3JhZ2UubG9jYWwuZ2V0KFwiZGlzZ3Vpc2VNb2RlXCIpIGFzIHsgZGlzZ3Vpc2VNb2RlPzogYm9vbGVhbiB9O1xyXG4gICAgaWYgKGRpc2d1aXNlTW9kZSkge1xyXG4gICAgICBhd2FpdCBoYW5kbGVEaXNndWlzZU1vZGUodHJ1ZSk7XHJcbiAgICB9XHJcbiAgfSBjYXRjaCAoZXJyb3IpIHtcclxuICAgIGNvbnNvbGUuZXJyb3IoXCJbU3R1ZHkgQXNzaXN0XSBFcnJvciByZXN0b3JpbmcgZGlzZ3Vpc2UgbW9kZTpcIiwgZXJyb3IpO1xyXG4gIH1cclxufVxyXG4iLCAiLyoqXHJcbiAqIFN0dWR5IEFzc2lzdCAtIEJhY2tncm91bmQgU2VydmljZSBXb3JrZXIgKEVudHJ5IFBvaW50KVxyXG4gKiBSb3V0ZXMgbWVzc2FnZXMgYW5kIG1hbmFnZXMgbGlmZWN5Y2xlIGV2ZW50c1xyXG4gKi9cclxuXHJcbmltcG9ydCB7IGxvZywgYWN0aXZlRGVlcFNlZWtDb250cm9sbGVyLCBzZXRBY3RpdmVEZWVwU2Vla0NvbnRyb2xsZXIgfSBmcm9tIFwiLi9tb2R1bGVzL2NvbnN0YW50cy5qc1wiO1xyXG5pbXBvcnQgdHlwZSB7IEV4dGVuc2lvbk1lc3NhZ2UsIE1lc3NhZ2VSZXNwb25zZSB9IGZyb20gXCIuL21vZHVsZXMvY29uc3RhbnRzLmpzXCI7XHJcbmltcG9ydCB0eXBlIHsgQW5hbHlzaXNSZXNwb25zZSB9IGZyb20gXCIuLi90eXBlcy9pbmRleC5qc1wiO1xyXG5pbXBvcnQgeyBhbmFseXplUXVlc3Rpb24sIGFuYWx5emVRdWVzdGlvblN0cmVhbWluZywgdGVzdEFwaUtleSwgdGVzdERlZXBTZWVrQXBpS2V5IH0gZnJvbSBcIi4vbW9kdWxlcy9hcGkuanNcIjtcclxuaW1wb3J0IHsgaGFuZGxlVG9nZ2xlRXh0ZW5zaW9uLCBoYW5kbGVEaXNndWlzZU1vZGUsIHJlc3RvcmVEaXNndWlzZU1vZGUgfSBmcm9tIFwiLi9tb2R1bGVzL2V4dGVuc2lvblN0YXRlLmpzXCI7XHJcbmltcG9ydCB7IGVuY3J5cHRBbmRTYXZlS2V5IH0gZnJvbSBcIi4vbW9kdWxlcy9jcnlwdG8uanNcIjtcclxuaW1wb3J0IHsgZ2V0VXNhZ2VTdGF0cywgZ2V0UmVjZW50SGlzdG9yeSwgY2xlYXJVc2FnZURhdGEsIGdldFN0b3JhZ2VJbmZvLCB0cmltSGlzdG9yeSwgdXBkYXRlU3RvcmFnZUJhZGdlIH0gZnJvbSBcIi4vbW9kdWxlcy91c2FnZVRyYWNrZXIuanNcIjtcclxuXHJcbi8vID09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09XHJcbi8vIE1lc3NhZ2UgSGFuZGxlclxyXG4vLyA9PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PVxyXG5cclxuYXN5bmMgZnVuY3Rpb24gaGFuZGxlTWVzc2FnZShcclxuICBtZXNzYWdlOiBFeHRlbnNpb25NZXNzYWdlLFxyXG4gIF9zZW5kZXI6IGNocm9tZS5ydW50aW1lLk1lc3NhZ2VTZW5kZXJcclxuKTogUHJvbWlzZTxNZXNzYWdlUmVzcG9uc2UgfCBBbmFseXNpc1Jlc3BvbnNlPiB7XHJcbiAgc3dpdGNoIChtZXNzYWdlLnR5cGUpIHtcclxuICAgIGNhc2UgXCJUT0dHTEVfRVhURU5TSU9OXCI6XHJcbiAgICAgIHJldHVybiBoYW5kbGVUb2dnbGVFeHRlbnNpb24obWVzc2FnZS5hY3RpdmUgPz8gZmFsc2UpO1xyXG5cclxuICAgIGNhc2UgXCJURVNUX0FQSV9LRVlcIjpcclxuICAgICAgcmV0dXJuIHRlc3RBcGlLZXkobWVzc2FnZS5hcGlLZXkgPz8gXCJcIik7XHJcblxyXG4gICAgY2FzZSBcIlRFU1RfREVFUFNFRUtfQVBJX0tFWVwiOlxyXG4gICAgICByZXR1cm4gdGVzdERlZXBTZWVrQXBpS2V5KG1lc3NhZ2UuYXBpS2V5ID8/IFwiXCIpO1xyXG5cclxuICAgIGNhc2UgXCJBTkFMWVpFX1FVRVNUSU9OXCI6XHJcbiAgICAgIHJldHVybiBhbmFseXplUXVlc3Rpb24obWVzc2FnZS5jb250ZXh0ISk7XHJcblxyXG4gICAgY2FzZSBcIkNBTkNFTF9ERUVQU0VFS1wiOlxyXG4gICAgICBpZiAoYWN0aXZlRGVlcFNlZWtDb250cm9sbGVyKSB7XHJcbiAgICAgICAgbG9nKFwiW1N0dWR5IEFzc2lzdF0gQ2FuY2VsbGluZyBEZWVwU2Vlay4uLlwiKTtcclxuICAgICAgICBhY3RpdmVEZWVwU2Vla0NvbnRyb2xsZXIuYWJvcnQoKTtcclxuICAgICAgICBzZXRBY3RpdmVEZWVwU2Vla0NvbnRyb2xsZXIobnVsbCk7XHJcbiAgICAgICAgcmV0dXJuIHsgc3VjY2VzczogdHJ1ZSwgY2FuY2VsbGVkOiB0cnVlIH07XHJcbiAgICAgIH1cclxuICAgICAgcmV0dXJuIHsgc3VjY2VzczogdHJ1ZSwgY2FuY2VsbGVkOiBmYWxzZSB9O1xyXG5cclxuICAgIGNhc2UgXCJUT0dHTEVfRElTR1VJU0VfTU9ERVwiOlxyXG4gICAgICByZXR1cm4gaGFuZGxlRGlzZ3Vpc2VNb2RlKG1lc3NhZ2UuZW5hYmxlZCA/PyBmYWxzZSk7XHJcblxyXG4gICAgY2FzZSBcIkVOQ1JZUFRfQU5EX1NBVkVfS0VZXCI6XHJcbiAgICAgIHRyeSB7XHJcbiAgICAgICAgY29uc3Qgc3RvcmFnZUtleSA9IG1lc3NhZ2Uua2V5VHlwZSA9PT0gXCJkZWVwc2Vla1wiID8gXCJkZWVwc2Vla0FwaUtleVwiIDogXCJjbGF1ZGVBcGlLZXlcIjtcclxuICAgICAgICBhd2FpdCBlbmNyeXB0QW5kU2F2ZUtleShzdG9yYWdlS2V5LCBtZXNzYWdlLnJhd0tleSA/PyBcIlwiKTtcclxuICAgICAgICByZXR1cm4geyBzdWNjZXNzOiB0cnVlIH07XHJcbiAgICAgIH0gY2F0Y2ggKGVycm9yKSB7XHJcbiAgICAgICAgcmV0dXJuIHsgc3VjY2VzczogZmFsc2UsIGVycm9yOiAoZXJyb3IgYXMgRXJyb3IpLm1lc3NhZ2UgfTtcclxuICAgICAgfVxyXG5cclxuICAgIGNhc2UgXCJHRVRfVVNBR0VfU1RBVFNcIjpcclxuICAgICAgdHJ5IHtcclxuICAgICAgICBjb25zdCBzdGF0cyA9IGF3YWl0IGdldFVzYWdlU3RhdHMoKTtcclxuICAgICAgICByZXR1cm4geyBzdWNjZXNzOiB0cnVlLCBzdGF0cyB9IGFzIE1lc3NhZ2VSZXNwb25zZSAmIHsgc3RhdHM6IHVua25vd24gfTtcclxuICAgICAgfSBjYXRjaCAoZXJyb3IpIHtcclxuICAgICAgICByZXR1cm4geyBzdWNjZXNzOiBmYWxzZSwgZXJyb3I6IChlcnJvciBhcyBFcnJvcikubWVzc2FnZSB9O1xyXG4gICAgICB9XHJcblxyXG4gICAgY2FzZSBcIkdFVF9VU0FHRV9ISVNUT1JZXCI6XHJcbiAgICAgIHRyeSB7XHJcbiAgICAgICAgY29uc3QgaGlzdG9yeSA9IGF3YWl0IGdldFJlY2VudEhpc3RvcnkobWVzc2FnZS5saW1pdCA/PyAyMCk7XHJcbiAgICAgICAgcmV0dXJuIHsgc3VjY2VzczogdHJ1ZSwgaGlzdG9yeSB9IGFzIE1lc3NhZ2VSZXNwb25zZSAmIHsgaGlzdG9yeTogdW5rbm93biB9O1xyXG4gICAgICB9IGNhdGNoIChlcnJvcikge1xyXG4gICAgICAgIHJldHVybiB7IHN1Y2Nlc3M6IGZhbHNlLCBlcnJvcjogKGVycm9yIGFzIEVycm9yKS5tZXNzYWdlIH07XHJcbiAgICAgIH1cclxuXHJcbiAgICBjYXNlIFwiQ0xFQVJfVVNBR0VfREFUQVwiOlxyXG4gICAgICB0cnkge1xyXG4gICAgICAgIGF3YWl0IGNsZWFyVXNhZ2VEYXRhKCk7XHJcbiAgICAgICAgcmV0dXJuIHsgc3VjY2VzczogdHJ1ZSB9O1xyXG4gICAgICB9IGNhdGNoIChlcnJvcikge1xyXG4gICAgICAgIHJldHVybiB7IHN1Y2Nlc3M6IGZhbHNlLCBlcnJvcjogKGVycm9yIGFzIEVycm9yKS5tZXNzYWdlIH07XHJcbiAgICAgIH1cclxuXHJcbiAgICBjYXNlIFwiR0VUX1NUT1JBR0VfSU5GT1wiOlxyXG4gICAgICB0cnkge1xyXG4gICAgICAgIGNvbnN0IHN0b3JhZ2VJbmZvID0gYXdhaXQgZ2V0U3RvcmFnZUluZm8oKTtcclxuICAgICAgICByZXR1cm4geyBzdWNjZXNzOiB0cnVlLCBzdG9yYWdlSW5mbyB9IGFzIE1lc3NhZ2VSZXNwb25zZSAmIHsgc3RvcmFnZUluZm86IHVua25vd24gfTtcclxuICAgICAgfSBjYXRjaCAoZXJyb3IpIHtcclxuICAgICAgICByZXR1cm4geyBzdWNjZXNzOiBmYWxzZSwgZXJyb3I6IChlcnJvciBhcyBFcnJvcikubWVzc2FnZSB9O1xyXG4gICAgICB9XHJcblxyXG4gICAgY2FzZSBcIlRSSU1fSElTVE9SWVwiOlxyXG4gICAgICB0cnkge1xyXG4gICAgICAgIGNvbnN0IGRlbGV0ZWQgPSBhd2FpdCB0cmltSGlzdG9yeSh7IGtlZXBMYXN0OiBtZXNzYWdlLmtlZXBMYXN0LCBrZWVwRGF5czogbWVzc2FnZS5rZWVwRGF5cyB9KTtcclxuICAgICAgICByZXR1cm4geyBzdWNjZXNzOiB0cnVlLCBkZWxldGVkIH0gYXMgTWVzc2FnZVJlc3BvbnNlICYgeyBkZWxldGVkOiB1bmtub3duIH07XHJcbiAgICAgIH0gY2F0Y2ggKGVycm9yKSB7XHJcbiAgICAgICAgcmV0dXJuIHsgc3VjY2VzczogZmFsc2UsIGVycm9yOiAoZXJyb3IgYXMgRXJyb3IpLm1lc3NhZ2UgfTtcclxuICAgICAgfVxyXG5cclxuICAgIGRlZmF1bHQ6XHJcbiAgICAgIHJldHVybiB7IHN1Y2Nlc3M6IGZhbHNlLCBlcnJvcjogXCJVbmtub3duIG1lc3NhZ2UgdHlwZVwiIH07XHJcbiAgfVxyXG59XHJcblxyXG5jaHJvbWUucnVudGltZS5vbk1lc3NhZ2UuYWRkTGlzdGVuZXIoXHJcbiAgKFxyXG4gICAgbWVzc2FnZTogRXh0ZW5zaW9uTWVzc2FnZSxcclxuICAgIHNlbmRlcjogY2hyb21lLnJ1bnRpbWUuTWVzc2FnZVNlbmRlcixcclxuICAgIHNlbmRSZXNwb25zZTogKHJlc3BvbnNlOiBNZXNzYWdlUmVzcG9uc2UgfCBBbmFseXNpc1Jlc3BvbnNlKSA9PiB2b2lkXHJcbiAgKTogYm9vbGVhbiA9PiB7XHJcbiAgICBoYW5kbGVNZXNzYWdlKG1lc3NhZ2UsIHNlbmRlcilcclxuICAgICAgLnRoZW4oKHJlc3BvbnNlKSA9PiBzZW5kUmVzcG9uc2UocmVzcG9uc2UpKVxyXG4gICAgICAuY2F0Y2goKGVycm9yOiBFcnJvcikgPT4gc2VuZFJlc3BvbnNlKHsgc3VjY2VzczogZmFsc2UsIGVycm9yOiBlcnJvci5tZXNzYWdlIH0pKTtcclxuICAgIHJldHVybiB0cnVlO1xyXG4gIH1cclxuKTtcclxuXHJcbi8vID09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09XHJcbi8vIFBvcnQtYmFzZWQgU3RyZWFtaW5nIChmdWxsIG1vZGUgb25seSlcclxuLy8gPT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT1cclxuXHJcbmNocm9tZS5ydW50aW1lLm9uQ29ubmVjdC5hZGRMaXN0ZW5lcigocG9ydCkgPT4ge1xyXG4gIGlmIChwb3J0Lm5hbWUgIT09IFwic3RyZWFtLWFuYWx5c2lzXCIpIHJldHVybjtcclxuXHJcbiAgcG9ydC5vbk1lc3NhZ2UuYWRkTGlzdGVuZXIoYXN5bmMgKG1zZzogeyBjb250ZXh0OiBpbXBvcnQoXCIuLi90eXBlcy9pbmRleC5qc1wiKS5BbmFseXNpc0NvbnRleHQgfSkgPT4ge1xyXG4gICAgdHJ5IHtcclxuICAgICAgYXdhaXQgYW5hbHl6ZVF1ZXN0aW9uU3RyZWFtaW5nKG1zZy5jb250ZXh0LCBwb3J0KTtcclxuICAgIH0gY2F0Y2ggKGVycm9yKSB7XHJcbiAgICAgIHRyeSB7XHJcbiAgICAgICAgcG9ydC5wb3N0TWVzc2FnZSh7IHR5cGU6IFwiU1RSRUFNX0VSUk9SXCIsIGVycm9yOiAoZXJyb3IgYXMgRXJyb3IpLm1lc3NhZ2UgfSk7XHJcbiAgICAgIH0gY2F0Y2gge1xyXG4gICAgICAgIC8vIFBvcnQgbWF5IGhhdmUgYmVlbiBkaXNjb25uZWN0ZWRcclxuICAgICAgfVxyXG4gICAgfVxyXG4gIH0pO1xyXG59KTtcclxuXHJcbi8vID09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09XHJcbi8vIExpZmVjeWNsZSBFdmVudHNcclxuLy8gPT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT1cclxuXHJcbmNocm9tZS5ydW50aW1lLm9uSW5zdGFsbGVkLmFkZExpc3RlbmVyKGFzeW5jIChkZXRhaWxzOiBjaHJvbWUucnVudGltZS5JbnN0YWxsZWREZXRhaWxzKSA9PiB7XHJcbiAgaWYgKGRldGFpbHMucmVhc29uID09PSBcImluc3RhbGxcIikge1xyXG4gICAgYXdhaXQgY2hyb21lLnN0b3JhZ2UubG9jYWwuc2V0KHtcclxuICAgICAgZXh0ZW5zaW9uQWN0aXZlOiBmYWxzZSxcclxuICAgICAgcmVzcG9uc2VNb2RlOiBcImd1aWRlZFwiLFxyXG4gICAgICBhdXRvRGV0ZWN0OiB0cnVlLFxyXG4gICAgICBoaWdobGlnaHRRdWVzdGlvbnM6IHRydWUsXHJcbiAgICAgIHRoZW1lOiBcInN5c3RlbVwiLFxyXG4gICAgICBidXR0b25Qb3NpdGlvbjogXCJib3R0b20tcmlnaHRcIixcclxuICAgICAgZXJyb3JMb2c6IFwiXCIsXHJcbiAgICB9KTtcclxuICAgIGF3YWl0IGNocm9tZS5hY3Rpb24uc2V0QmFkZ2VUZXh0KHsgdGV4dDogXCJcIiB9KTtcclxuICB9XHJcbiAgYXdhaXQgcmVzdG9yZURpc2d1aXNlTW9kZSgpO1xyXG4gIGF3YWl0IHVwZGF0ZVN0b3JhZ2VCYWRnZSgpO1xyXG59KTtcclxuXHJcbmNocm9tZS5ydW50aW1lLm9uU3RhcnR1cC5hZGRMaXN0ZW5lcihhc3luYyAoKSA9PiB7XHJcbiAgYXdhaXQgcmVzdG9yZURpc2d1aXNlTW9kZSgpO1xyXG4gIGF3YWl0IHVwZGF0ZVN0b3JhZ2VCYWRnZSgpO1xyXG59KTtcclxuXHJcbi8vID09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09XHJcbi8vIFRhYiBVcGRhdGUgSGFuZGxlclxyXG4vLyA9PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PVxyXG5cclxuY2hyb21lLnRhYnMub25VcGRhdGVkLmFkZExpc3RlbmVyKFxyXG4gIGFzeW5jICh0YWJJZDogbnVtYmVyLCBjaGFuZ2VJbmZvOiBjaHJvbWUudGFicy5UYWJDaGFuZ2VJbmZvLCB0YWI6IGNocm9tZS50YWJzLlRhYikgPT4ge1xyXG4gICAgaWYgKGNoYW5nZUluZm8uc3RhdHVzID09PSBcImNvbXBsZXRlXCIpIHtcclxuICAgICAgdHJ5IHtcclxuICAgICAgICBjb25zdCB7IGV4dGVuc2lvbkFjdGl2ZSB9ID0gYXdhaXQgY2hyb21lLnN0b3JhZ2UubG9jYWwuZ2V0KFwiZXh0ZW5zaW9uQWN0aXZlXCIpIGFzIHsgZXh0ZW5zaW9uQWN0aXZlPzogYm9vbGVhbiB9O1xyXG4gICAgICAgIGlmIChleHRlbnNpb25BY3RpdmUpIHtcclxuICAgICAgICAgIGNocm9tZS50YWJzLnNlbmRNZXNzYWdlKHRhYklkLCB7IHR5cGU6IFwiUEFHRV9MT0FERURcIiwgdXJsOiB0YWIudXJsIH0pLmNhdGNoKCgpID0+IHt9KTtcclxuICAgICAgICB9XHJcbiAgICAgIH0gY2F0Y2ggKF9lcnJvcikge1xyXG4gICAgICAgIC8vIFNpbGVudCBmYWlsXHJcbiAgICAgIH1cclxuICAgIH1cclxuICB9XHJcbik7XHJcbiJdLAogICJtYXBwaW5ncyI6ICI7QUFPTyxJQUFNLGFBQXNCO0FBQzVCLElBQU0sTUFBTSxJQUFJLFNBQTBCO0FBQy9DLE1BQUk7QUFBWSxZQUFRLElBQUksR0FBRyxJQUFJO0FBQ3JDO0FBS08sSUFBTSxrQkFBa0I7QUFDeEIsSUFBTSxnQkFBZ0I7QUFDdEIsSUFBTSxvQkFBb0I7QUFFMUIsSUFBTSxvQkFBb0I7QUFDMUIsSUFBTSwwQkFBMEI7QUFPaEMsSUFBSSwyQkFBbUQ7QUFFdkQsU0FBUyw0QkFBNEIsTUFBb0M7QUFDOUUsNkJBQTJCO0FBQzdCO0FBR08sSUFBSSxnQkFBc0M7QUFFMUMsU0FBUyxpQkFBaUIsTUFBa0M7QUFDakUsa0JBQWdCO0FBQ2xCOzs7QUMzQkEsZUFBc0IsU0FBUyxRQUF1QztBQUNwRSxNQUFJO0FBQ0YsVUFBTSxVQUFVLEtBQUksb0JBQUksS0FB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LEVBQy9DO0FBQ0EsUUFBTSxvQkFBb0I7QUFDMUIsUUFBTSxtQkFBbUI7QUFDM0IsQ0FBQztBQUVELE9BQU8sUUFBUSxVQUFVLFlBQVksWUFBWTtBQUMvQyxRQUFNLG9CQUFvQjtBQUMxQixRQUFNLG1CQUFtQjtBQUMzQixDQUFDO0FBTUQsT0FBTyxLQUFLLFVBQVU7QUFBQSxFQUNwQixPQUFPLE9BQWUsWUFBdUMsUUFBeUI7QUFDcEYsUUFBSSxXQUFXLFdBQVcsWUFBWTtBQUNwQyxVQUFJO0FBQ0YsY0FBTSxFQUFFLGdCQUFnQixJQUFJLE1BQU0sT0FBTyxRQUFRLE1BQU0sSUFBSSxpQkFBaUI7QUFDNUUsWUFBSSxpQkFBaUI7QUFDbkIsaUJBQU8sS0FBSyxZQUFZLE9BQU8sRUFBRSxNQUFNLGVBQWUsS0FBSyxJQUFJLElBQUksQ0FBQyxFQUFFLE1BQU0sTUFBTTtBQUFBLFVBQUMsQ0FBQztBQUFBLFFBQ3RGO0FBQUEsTUFDRixTQUFTLFFBQVE7QUFBQSxNQUVqQjtBQUFBLElBQ0Y7QUFBQSxFQUNGO0FBQ0Y7IiwKICAibmFtZXMiOiBbImFjYWRlbWljQ29udGV4dCIsICJleHBlcnRDb250ZXh0IiwgInByb21wdCJdCn0K
