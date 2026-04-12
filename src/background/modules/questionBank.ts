/**
 * Background Service Worker - Questions Bank
 * Handles loading, searching, and matching questions from the bank
 */

import { log, questionsBank, setQuestionsBank } from "./constants.js";
import type { QuestionsBank, MatchedQuestion } from "./constants.js";
import { compareAnswerSetsSemantically } from "./answerEquivalences.js";

const PRIMARY_BANK_FILE = "data/questions-bank.json";
const SECONDARY_BANK_FILE = "data/questions-bank-ccnadesdecero.json";

let secondaryQuestionsBank: QuestionsBank | null = null;
let secondaryLoadAttempted = false;
let useMultiBankCache: boolean | null = null;

// ============================================
// Questions Bank Loading
// ============================================

export async function loadQuestionsBank(): Promise<QuestionsBank | null> {
  if (questionsBank) return questionsBank;

  try {
    const url = chrome.runtime.getURL(PRIMARY_BANK_FILE);
    const response = await fetch(url);
    const bank = await response.json() as QuestionsBank;
    setQuestionsBank(bank);
    log(
      "[Study Assist] Questions bank loaded:",
      Object.keys(bank.modules).length,
      "modules",
    );
    return bank;
  } catch (error) {
    console.error("[Study Assist] Failed to load questions bank:", error);
    return null;
  }
}

export async function loadSecondaryQuestionsBank(): Promise<QuestionsBank | null> {
  if (secondaryQuestionsBank) return secondaryQuestionsBank;
  if (secondaryLoadAttempted) return null;
  secondaryLoadAttempted = true;

  try {
    const url = chrome.runtime.getURL(SECONDARY_BANK_FILE);
    const response = await fetch(url);
    const bank = await response.json() as QuestionsBank;
    secondaryQuestionsBank = bank;
    log(
      "[Study Assist] Secondary questions bank loaded:",
      Object.keys(bank.modules).length,
      "modules",
    );
    return bank;
  } catch (error) {
    console.warn("[Study Assist] Secondary questions bank not available:", error);
    return null;
  }
}

async function getUseMultiBankEnabled(): Promise<boolean> {
  if (useMultiBankCache !== null) return useMultiBankCache;

  try {
    const result = await chrome.storage.local.get(["useMultiBank"]);
    useMultiBankCache = typeof result.useMultiBank === "boolean"
      ? result.useMultiBank
      : true;
  } catch {
    // Keep hybrid mode enabled by default if storage is unavailable.
    useMultiBankCache = true;
  }

  return useMultiBankCache;
}

/**
 * Test-only helper to clear in-memory bank caches between unit tests.
 */
export function __resetQuestionBankCachesForTests(): void {
  setQuestionsBank(null);
  secondaryQuestionsBank = null;
  secondaryLoadAttempted = false;
  useMultiBankCache = null;
}

// ============================================
// Text Normalization & Similarity
// ============================================

/**
 * Normalize text for comparison (remove accents, lowercase, remove punctuation)
 */
export function normalizeForSearch(text: string): string {
  return text
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "") // Diacritics
    .replace(/[\u200B-\u200D\uFEFF]/g, "") // Zero-width spaces
    .replace(/&nbsp;/g, " ") // HTML non-breaking spaces
    .replace(/[¿?¡!.,;:()"\-]/g, "") // Punctuation
    .replace(/\//g, "") // Slashes (for interface names like 0/1)
    .replace(/\s+/g, " ") // Multiple spaces to single
    .trim();
}

/**
 * Calculate similarity between two normalized texts (word overlap)
 */
export function calculateSimilarity(text1: string, text2: string): number {
  const words1 = new Set(text1.split(" ").filter((w) => w.length > 2));
  const words2 = new Set(text2.split(" ").filter((w) => w.length > 2));

  if (words1.size === 0 || words2.size === 0) return 0;

  let matches = 0;
  for (const word of words1) {
    if (words2.has(word)) matches++;
  }

  return matches / Math.max(words1.size, words2.size);
}

/**
 * Calculate containment: what % of the SMALLER text's words appear in the LARGER text.
 * This handles the case where the page includes extra context (routing tables, code, etc.)
 * before the actual question. Even with 200 extra words, if all 15 bank-question words
 * are present in the page text, containment = 15/15 = 100%.
 */
export function calculateContainment(text1: string, text2: string): number {
  const words1 = new Set(text1.split(" ").filter((w) => w.length > 2));
  const words2 = new Set(text2.split(" ").filter((w) => w.length > 2));

  if (words1.size === 0 || words2.size === 0) return 0;

  // Determine which is the smaller set (likely the bank question)
  const [smaller, larger] = words1.size <= words2.size
    ? [words1, words2]
    : [words2, words1];

  let matches = 0;
  for (const word of smaller) {
    if (larger.has(word)) matches++;
  }

  // Require the smaller text to have a minimum number of meaningful words
  // to avoid false positives with very short questions
  if (smaller.size < 4) return 0;

  return matches / smaller.size;
}

/**
 * Check if the page is a NetAcad/Cisco page based on title or URL
 */
export function isNetAcadPage(pageTitle: string | undefined, pageUrl: string | undefined): boolean {
  const titleOrUrl = (pageTitle || "") + " " + (pageUrl || "");
  return /netacad|cisco|ccna|ccnp|networking\s*academy|skills\s*for\s*all/i.test(
    titleOrUrl,
  );
}

function buildModulesToSearch(moduleInfo: string | undefined, bank: QuestionsBank): string[] {
  const modulesToSearch: string[] = [];

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
        "final-practice", "final-skills", "final-exam", "ptsa-1", "ptsa-2"
      );
    }
  }

  return modulesToSearch.length > 0 ? modulesToSearch : Object.keys(bank.modules);
}

function findBestMatchInBank(
  bank: QuestionsBank,
  modulesToSearch: string[],
  normalizedQuestion: string,
  questionText: string,
  similarityThreshold: number,
  bankModel: "questions-bank.json" | "questions-bank-ccnadesdecero.json",
): MatchedQuestion | null {
  let bestMatch: MatchedQuestion | null = null;
  let bestSimilarity = 0;

  for (const moduleRange of modulesToSearch) {
    const module = bank.modules[moduleRange];
    if (!module || !module.questions) continue;

    for (const question of module.questions) {
      let similarity: number;

      const pageHasPlaceholder = questionText.toLowerCase().includes("partialurlplaceholder");
      const bankHasPlaceholder = question.text.toLowerCase().includes("partialurlplaceholder");

      if (pageHasPlaceholder && bankHasPlaceholder) {
        similarity = 0.95;
      } else {
        const bankNormalized = question.textNormalized || normalizeForSearch(question.text);
        const stdSimilarity = calculateSimilarity(normalizedQuestion, bankNormalized);
        const containment = calculateContainment(normalizedQuestion, bankNormalized);
        similarity = Math.max(stdSimilarity, containment);
      }

      if (similarity > bestSimilarity && similarity >= similarityThreshold) {
        bestSimilarity = similarity;
        bestMatch = {
          ...question,
          moduleRange,
          similarity: Math.round(similarity * 100),
          bankModel,
        };
      }
    }
  }

  return bestMatch;
}

function getNormalizedAnswerSet(match: Pick<MatchedQuestion, "correctAnswer" | "correctAnswers">): string[] {
  const answers = match.correctAnswers && match.correctAnswers.length > 0
    ? match.correctAnswers
    : match.correctAnswer
      ? [match.correctAnswer]
      : [];

  return [...new Set(answers.map((a) => normalizeForSearch(a)).filter(Boolean))].sort();
}

interface DuplicateCheckResult {
  duplicateScore: number;
  answerEquivalent: boolean;
  answerSimilarity: number;
  normalizedPrimaryAnswers: string[];
  normalizedSecondaryAnswers: string[];
}

function evaluateDuplicateConflict(
  primaryMatch: MatchedQuestion,
  secondaryMatch: MatchedQuestion,
): DuplicateCheckResult | null {
  const primaryText = normalizeForSearch(primaryMatch.text);
  const secondaryText = normalizeForSearch(secondaryMatch.text);
  const duplicateScore = Math.max(
    calculateSimilarity(primaryText, secondaryText),
    calculateContainment(primaryText, secondaryText),
  );

  if (duplicateScore < 0.9) return null;

  const primaryAnswers = getNormalizedAnswerSet(primaryMatch);
  const secondaryAnswers = getNormalizedAnswerSet(secondaryMatch);
  const answerComparison = compareAnswerSetsSemantically(primaryAnswers, secondaryAnswers);

  return {
    duplicateScore,
    answerEquivalent: answerComparison.equivalent,
    answerSimilarity: answerComparison.similarity,
    normalizedPrimaryAnswers: answerComparison.normalizedPrimary,
    normalizedSecondaryAnswers: answerComparison.normalizedSecondary,
  };
}

function logDuplicateIfNeeded(
  primaryMatch: MatchedQuestion,
  secondaryMatch: MatchedQuestion,
  duplicateInfo: DuplicateCheckResult,
): void {
  if (!duplicateInfo.answerEquivalent) {
    console.warn(
      "[Study Assist] Question-bank REAL conflict detected (primary vs secondary):",
      {
        primaryModule: primaryMatch.moduleRange,
        secondaryModule: secondaryMatch.moduleRange,
        questionSimilarity: Math.round(duplicateInfo.duplicateScore * 100),
        answerSimilarity: Math.round(duplicateInfo.answerSimilarity * 100),
        primaryAnswers: duplicateInfo.normalizedPrimaryAnswers,
        secondaryAnswers: duplicateInfo.normalizedSecondaryAnswers,
      },
    );
    return;
  }

  log(
    "[Study Assist] Duplicate question detected across banks (semantic-equivalent answers)",
    {
      primaryModule: primaryMatch.moduleRange,
      secondaryModule: secondaryMatch.moduleRange,
      questionSimilarity: Math.round(duplicateInfo.duplicateScore * 100),
      answerSimilarity: Math.round(duplicateInfo.answerSimilarity * 100),
    },
  );
}

// ============================================
// Question Matching
// ============================================

/**
 * Find matching question in the bank (ONLY for NetAcad pages)
 */
export async function findMatchingQuestion(
  questionText: string,
  moduleInfo: string | undefined,
  pageUrl: string | undefined
): Promise<MatchedQuestion | null> {
  if (!isNetAcadPage(moduleInfo, pageUrl)) {
    log("[Study Assist] Question bank: Skipped (not a NetAcad page)");
    return null;
  }

  log("[Study Assist] Question bank: Searching...");

  const useMultiBank = await getUseMultiBankEnabled();
  const primaryBank = await loadQuestionsBank();
  const secondaryBank = useMultiBank ? await loadSecondaryQuestionsBank() : null;

  if (!useMultiBank) {
    log("[Study Assist] useMultiBank disabled: secondary bank lookup skipped");
  }

  if (!primaryBank && !secondaryBank) return null;

  const normalizedQuestion = normalizeForSearch(questionText);

  // Lowered threshold from 0.6 to 0.55 to improve detection for modules 10+
  // Previously, many valid questions from modules 10-13 and 14-16 were not being matched
  // due to slight variations in wording between the bank and actual exam questions
  const isLongText = questionText.length > 800;
  const SIMILARITY_THRESHOLD = isLongText ? 0.50 : 0.55;

  const primaryModulesToSearch = primaryBank
    ? buildModulesToSearch(moduleInfo, primaryBank)
    : [];

  const primaryMatch = primaryBank
    ? findBestMatchInBank(
      primaryBank,
      primaryModulesToSearch,
      normalizedQuestion,
      questionText,
      SIMILARITY_THRESHOLD,
      "questions-bank.json",
    )
    : null;

  let secondaryMatch: MatchedQuestion | null = null;
  if (secondaryBank) {
    const secondaryModulesToSearch = buildModulesToSearch(moduleInfo, secondaryBank);
    secondaryMatch = findBestMatchInBank(
      secondaryBank,
      secondaryModulesToSearch,
      normalizedQuestion,
      questionText,
      SIMILARITY_THRESHOLD,
      "questions-bank-ccnadesdecero.json",
    );
  }

  const duplicateInfo = primaryMatch && secondaryMatch
    ? evaluateDuplicateConflict(primaryMatch, secondaryMatch)
    : null;

  if (primaryMatch && secondaryMatch && duplicateInfo) {
    logDuplicateIfNeeded(primaryMatch, secondaryMatch, duplicateInfo);
  }

  let bestMatch: MatchedQuestion | null = null;

  if (primaryMatch && primaryMatch.similarity >= 80) {
    bestMatch = primaryMatch;
  } else if (secondaryMatch && secondaryMatch.similarity >= 80) {
    bestMatch = secondaryMatch;
  } else if (primaryMatch && secondaryMatch) {
    bestMatch = primaryMatch.similarity >= secondaryMatch.similarity
      ? primaryMatch
      : secondaryMatch;
  } else {
    bestMatch = primaryMatch || secondaryMatch;
  }

  if (bestMatch) {
    if (duplicateInfo) {
      bestMatch.bankConflictDetected = !duplicateInfo.answerEquivalent;
      bestMatch.bankConflictType = duplicateInfo.answerEquivalent ? "semantic-equivalent" : "real-conflict";
      bestMatch.bankConflictAnswerSimilarity = Math.round(duplicateInfo.answerSimilarity * 100);
      bestMatch.bankSecondaryModel = bestMatch.bankModel === "questions-bank.json"
        ? "questions-bank-ccnadesdecero.json"
        : "questions-bank.json";
    }

    log(`[Study Assist] QUESTION BANK MATCH (${bestMatch.similarity}% similarity) from module ${bestMatch.moduleRange} (${bestMatch.bankModel}):`);
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
