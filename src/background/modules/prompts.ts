/**
 * Background Service Worker - Prompt Building
 * Constructs prompts for Claude and DeepSeek APIs
 */

import type { AnalysisContext, ImageData } from "../../types/index.js";
import type {
  MatchedQuestion,
  NumberWordMap,
  DeepSeekAnalysisForClaude,
  ClaudeContentBlock,
} from "./constants.js";

// ============================================
// Shared Helpers
// ============================================

export function formatQuestionType(type: string | undefined): string {
  const types: { [key: string]: string } = {
    "multiple-choice": "Multiple Choice",
    "true-false": "True/False",
    "fill-blank": "Fill in the Blank",
    matching: "Matching",
    unknown: "General Question",
  };
  return types[type || "unknown"] || types["unknown"];
}

/** Common number-word map for extracting answer counts */
export const NUMBER_WORD_MAP: NumberWordMap = {
  dos: 2, two: 2, 2: 2,
  tres: 3, three: 3, 3: 3,
  cuatro: 4, four: 4, 4: 4,
  cinco: 5, five: 5, 5: 5,
};

/** Patterns for detecting required answer count */
export const COUNT_PATTERNS: RegExp[] = [
  /elija\s*(dos|tres|cuatro|cinco|2|3|4|5)/i,
  /escoja\s*(dos|tres|cuatro|cinco|2|3|4|5)/i,
  /seleccione\s*(dos|tres|cuatro|cinco|2|3|4|5)/i,
  /select\s*(two|three|four|five|2|3|4|5)/i,
  /choose\s*(two|three|four|five|2|3|4|5)/i,
  /\(\s*(dos|tres|cuatro|two|three|four|2|3|4|5)\s*opciones?\s*\)/i,
];

/**
 * Extract required number of answers from question text
 */
export function extractRequiredAnswers(questionText: string): number {
  for (const pattern of COUNT_PATTERNS) {
    const match = questionText.match(pattern);
    if (match && match[1]) {
      const num = NUMBER_WORD_MAP[match[1].toLowerCase()];
      if (num) return num;
    }
  }
  return 1;
}

/**
 * Detect if page is NetAcad/Cisco
 */
function getExpertContext(pageTitle: string | undefined): { isNetAcad: boolean; expertContext: string } {
  const isNetAcad = /netacad|cisco|ccna|ccnp|networking academy|skills\s*for\s*all/i.test(pageTitle || "");

  const expertContext = isNetAcad
    ? `You are a CCNA/CCNP certified networking expert with deep knowledge of:
- Cisco IOS commands and configurations
- Routing protocols (OSPF, EIGRP, BGP, RIP)
- Switching concepts (VLANs, STP, EtherChannel, trunking)
- Network security (ACLs, NAT, firewalls, VPNs)
- Subnetting and IP addressing (IPv4/IPv6)
- Network services (DHCP, DNS, NTP, SNMP)
- Wireless networking
- Network automation and programmability

Use your expertise to analyze this Cisco/networking question accurately.`
    : "You are an expert exam analyst with broad knowledge across all academic and technical subjects.";

  return { isNetAcad, expertContext };
}

function buildReferenceSection(matchedQuestion: MatchedQuestion | null): string {
  if (!matchedQuestion || !matchedQuestion.explanation) return "";

  return `
REFERENCE MATERIAL (from verified exam bank - ${matchedQuestion.similarity}% match):
Question: ${matchedQuestion.text}
Options: ${matchedQuestion.options.join(" | ")}
Explanation: ${matchedQuestion.explanation}

Use this reference to inform your analysis, but verify it applies to the current question.
`;
}

// ============================================
// DeepSeek Prompts
// ============================================

export function buildDeepSeekPrompt(
  context: AnalysisContext,
  matchedQuestion: MatchedQuestion | null = null
): string {
  const { questionText, questionType, options, categories, matchingOptions, matchingStyle, courseName } = context;
  const { expertContext } = getExpertContext(context.pageTitle);
  const referenceSection = buildReferenceSection(matchedQuestion);

  const requiredAnswers = extractRequiredAnswers(questionText);

  // Handle matching questions
  if (questionType === "matching" && categories && matchingOptions) {
    return buildDeepSeekMatchingPrompt(context, expertContext, referenceSection);
  }

  // Build academic context if available
  const academicContext = courseName ? `\nACADEMIC CONTEXT:\nCourse: ${courseName}\n` : '';

  // Build standard prompt
  let prompt = `${expertContext}${academicContext}
${referenceSection}
QUESTION: ${questionText}

OPTIONS:
`;

  if (options && options.length > 0) {
    options.forEach((opt) => {
      prompt += `${opt.letter}) ${opt.text}\n`;
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
ANSWER: [single letter, e.g., A]
CONFIDENCE: [LOW/MEDIUM/HIGH]`;
  }

  return prompt;
}

export function buildDeepSeekMatchingPrompt(
  context: AnalysisContext,
  expertContext: string,
  referenceSection: string = ""
): string {
  const { questionText, categories, matchingOptions, matchingStyle, courseName } = context;

  // Build academic context if available
  const academicContext = courseName ? `\nACADEMIC CONTEXT:\nCourse: ${courseName}\n` : '';

  let prompt = `${expertContext}${academicContext}
${referenceSection}
This is a MATCHING question. Match each item to its correct pair.

QUESTION: ${questionText}

`;

  if (matchingStyle === "dropdown") {
    prompt += `AVAILABLE OPTIONS:\n`;
    categories!.forEach((cat) => { prompt += `${cat.letter}: ${cat.text}\n`; });
    prompt += `\nDESCRIPTIONS TO MATCH:\n`;
    matchingOptions!.forEach((opt) => { prompt += `${opt.index}. ${opt.text}\n`; });
    prompt += `
Match each number to its correct letter option.

RESPONSE FORMAT:
ANSWER: 1-A, 2-B, 3-A, etc.
CONFIDENCE: [LOW/MEDIUM/HIGH]`;
  } else {
    prompt += `CATEGORIES:\n`;
    categories!.forEach((cat) => { prompt += `${cat.letter}: ${cat.text}\n`; });
    prompt += `\nOPTIONS:\n`;
    matchingOptions!.forEach((opt) => { prompt += `${opt.index}. ${opt.text}\n`; });
    prompt += `
Match each category letter to its correct option number.

RESPONSE FORMAT:
ANSWER: A-1, B-3, C-2, etc.
CONFIDENCE: [LOW/MEDIUM/HIGH]`;
  }

  return prompt;
}

// ============================================
// Claude Validation Prompt
// ============================================

export function buildClaudeValidationPrompt(
  context: AnalysisContext,
  deepseekAnalysis: DeepSeekAnalysisForClaude
): string {
  const { questionText, questionType, options, categories, matchingOptions, matchingStyle, courseName } = context;
  const { expertContext } = getExpertContext(context.pageTitle);

  // Build academic context if available
  const academicContext = courseName ? `\nACADEMIC CONTEXT:\nCourse: ${courseName}\n` : '';

  let questionSection = `QUESTION: ${questionText}\n\n`;

  if (questionType === "matching" && categories && matchingOptions) {
    if (matchingStyle === "dropdown") {
      questionSection += `AVAILABLE OPTIONS:\n`;
      categories.forEach((cat) => { questionSection += `${cat.letter}: ${cat.text}\n`; });
      questionSection += `\nDESCRIPTIONS TO MATCH:\n`;
      matchingOptions.forEach((opt) => { questionSection += `${opt.index}. ${opt.text}\n`; });
    } else {
      questionSection += `CATEGORIES:\n`;
      categories.forEach((cat) => { questionSection += `${cat.letter}: ${cat.text}\n`; });
      questionSection += `\nOPTIONS:\n`;
      matchingOptions.forEach((opt) => { questionSection += `${opt.index}. ${opt.text}\n`; });
    }
  } else if (options && options.length > 0) {
    questionSection += `OPTIONS:\n`;
    options.forEach((opt) => { questionSection += `${opt.letter}) ${opt.text}\n`; });
  }

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
ANSWER: [correct answer - single letter or comma-separated letters]`;

  return prompt;
}

// ============================================
// Claude Analysis Prompt
// ============================================

export function buildAnalysisPrompt(
  context: AnalysisContext,
  matchedQuestion: MatchedQuestion | null = null
): string {
  const { questionText, questionType, options, categories, matchingOptions, responseMode, images, courseName } = context;
  const pageTitle = context.pageTitle;
  const hasImages = images && images.length > 0;
  const referenceSection = buildReferenceSection(matchedQuestion);

  // Build academic context if available
  const academicContext = courseName ? `\nACADEMIC CONTEXT:\nCourse: ${courseName}\n` : '';

  // Use specialized prompt for quick mode
  if (responseMode === "quick") {
    if (questionType === "matching" && categories && matchingOptions) {
      return buildMatchingPrompt(context);
    }

    const requiredAnswers = extractRequiredAnswers(questionText);
    const isMultipleAnswer = requiredAnswers > 1;

    const { isNetAcad } = getExpertContext(pageTitle);
    const expertContext = isNetAcad
      ? "You are a CCNA/CCNP networking expert with deep knowledge of Cisco technologies, protocols, routing, switching, security, and network automation. You have extensive experience with Cisco IOS commands, network troubleshooting, subnetting, VLANs, OSPF, EIGRP, BGP, ACLs, NAT, DHCP, DNS, and all CCNA exam topics. Always consider the most current Cisco best practices and exam objectives"
      : "You are an expert exam analyst with broad knowledge across all academic and technical subjects including science, math, history, programming, and general knowledge.";

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
      options.forEach((opt) => { quickPrompt += `${opt.letter}) ${opt.text}\n`; });
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
      quickPrompt += `
Think step-by-step:${imageAnalysisStep}
1. What is the question asking?
2. Evaluate each option against the image/question
3. Determine the correct answer

After your analysis, write ANSWER: X on the last line (where X is the letter).`;
    }

    return quickPrompt;
  }

  // Handle matching questions in non-quick mode
  if (questionType === "matching" && categories && matchingOptions) {
    return buildMatchingPrompt(context);
  }

  // Non-quick mode: educational format
  let prompt = `You are an educational AI tutor helping a student understand a question.
${referenceSection}
Context:
- From: "${pageTitle}"
- Question type: ${formatQuestionType(questionType)}

Question:
${questionText}

`;

  if (options && options.length > 0) {
    prompt += `\nAnswer Options:\n`;
    options.forEach((opt) => { prompt += `${opt.letter}. ${opt.text}\n`; });
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

  prompt += `\n\nRemember: Help students learn with academic integrity.`;
  return prompt;
}

// ============================================
// Matching Prompt
// ============================================

export function buildMatchingPrompt(context: AnalysisContext): string {
  const { questionText, categories, matchingOptions, matchingStyle, images, courseName } = context;
  const pageTitle = context.pageTitle;

  const { isNetAcad } = getExpertContext(pageTitle);
  const expertContext = isNetAcad
    ? "You are a CCNA/CCNP networking expert with deep knowledge of Cisco technologies, protocols, ports, routing, switching, security, and network automation."
    : "You are an expert exam analyst with broad knowledge across all academic and technical subjects.";

  // Build academic context if available
  const academicContext = courseName ? `\nACADEMIC CONTEXT:\nCourse: ${courseName}\n` : '';

  let imageContext = "";
  if (images && images.length > 0) {
    imageContext = `

CRITICAL - IMAGE ANALYSIS REQUIRED:
Look at the image above FIRST. It may contain essential information for matching.`;
  }

  // Dropdown style
  if (matchingStyle === "dropdown") {
    let prompt = `${expertContext}${academicContext}${imageContext}

This is a MATCHING question with DROPDOWN selection. Each description must be matched to one of the available options.
NOTE: The same option can be used for multiple descriptions.

Question: ${questionText}

Available options:
`;
    categories!.forEach((cat) => { prompt += `${cat.letter}: ${cat.text}\n`; });
    prompt += `\nDescriptions to match:\n`;
    matchingOptions!.forEach((opt) => { prompt += `${opt.index}. ${opt.text}\n`; });
    prompt += `
Match each description NUMBER to the correct option LETTER.

RESPOND WITH ONLY: ${matchingOptions!.map((opt) => `${opt.index}-[letter]`).join(", ")}
Example: 1-A, 2-B, 3-A, 4-A, 5-B

IMPORTANT:
- Use ONLY the option LETTER (A, B, C...) after the dash
- Each number gets exactly one letter
- The same letter CAN be used for multiple numbers
- Output ONLY the matches, no explanations`;
    return prompt;
  }

  // Object-dropdown style
  if (matchingStyle === "object-dropdown") {
    let prompt = `${expertContext}${academicContext}${imageContext}

This is a MATCHING question. Match each term (A, B, C...) to its correct definition.

Question: ${questionText}

Terms to match:
`;
    categories!.forEach((cat) => { prompt += `${cat.letter}: ${cat.text}\n`; });
    prompt += `\nDefinitions available:\n`;
    matchingOptions!.forEach((opt) => { prompt += `${opt.index}. ${opt.text}\n`; });
    prompt += `
Match each term LETTER to its correct definition NUMBER.

CRITICAL OUTPUT FORMAT:
You MUST respond with: ${categories!.map((cat) => `${cat.letter}-[number]`).join(", ")}
Example: A-1, B-3, C-2, D-4, E-5

IMPORTANT:
- Use ONLY the definition NUMBERS (1, 2, 3...) after the dash
- Each letter gets exactly one number
- Output ONLY the matches: ${categories!.map((cat) => `${cat.letter}-[number]`).join(", ")}
- No explanations or additional text.`;
    return prompt;
  }

  // Standard drag-and-drop
  let prompt = `${expertContext}${academicContext}${imageContext}

This is a MATCHING question. You must match each category to the correct option.

Question: ${questionText}

Categories to match:
`;
  categories!.forEach((cat) => { prompt += `${cat.letter}: ${cat.text}\n`; });
  prompt += `\nOptions available:\n`;
  matchingOptions!.forEach((opt) => { prompt += `${opt.index}. ${opt.text}\n`; });
  prompt += `
Match each category letter to its correct option NUMBER (1, 2, 3, etc.).

CRITICAL OUTPUT FORMAT:
You MUST respond with: ${categories!.map((cat) => `${cat.letter}-[number]`).join(", ")}
Example: A-1, B-3, C-2, D-4, E-5

IMPORTANT:
- Use ONLY the option NUMBERS (1, 2, 3...) after the dash
- Do NOT include the option text in your response
- Each category letter MUST be matched to exactly one number
- Output format: LETTER-NUMBER, LETTER-NUMBER, LETTER-NUMBER

For example, if you need to match A: SMTP, B: POP3, C: IMAP4 to options 1: port 25, 2: port 110, 3: port 143:
Correct output: A-1, B-2, C-3

YOUR OUTPUT MUST BE EXACTLY IN THIS FORMAT:
${categories!.map((cat) => `${cat.letter}-[number]`).join(", ")}

IMPORTANT:
- Use option NUMBERS only (1, 2, 3...)
- Each category letter gets exactly one number
- Output ONLY: ${categories!.map((cat) => `${cat.letter}-[number]`).join(", ")}
- No explanations or additional text.`;

  return prompt;
}

// ============================================
// Message Content Building (supports images)
// ============================================

export function buildMessageContent(
  prompt: string,
  images: ImageData[] | undefined
): string | ClaudeContentBlock[] {
  if (!images || images.length === 0) {
    return prompt;
  }

  const content: ClaudeContentBlock[] = [];

  for (let i = 0; i < images.length; i++) {
    const img = images[i];
    if (!img) continue;

    // Prefer URL when available (saves tokens significantly)
    if (img.url) {
      content.push({
        type: "image",
        source: {
          type: "url",
          url: img.url,
        },
      });
    } else if (img.base64 && img.mediaType) {
      if (img.base64.length < 100) continue;

      content.push({
        type: "image",
        source: {
          type: "base64",
          media_type: img.mediaType,
          data: img.base64,
        },
      });
    }
  }

  content.push({ type: "text", text: prompt });

  return content;
}
