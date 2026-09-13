/**
 * Background Service Worker - Questions Bank
 * Handles loading, searching, and matching questions from the bank
 */

import { log } from "./constants.js";
import type { QuestionsBank, MatchedQuestion } from "./constants.js";
import { compareAnswerSetsSemantically } from "./answerEquivalences.js";

/**
 * Question bank files, loaded and searched together. Each bank holds a single
 * course/source; the matcher picks the best match across all of them.
 */
const BANK_FILES = [
  { file: "data/questions-bank.json", name: "questions-bank.json" }, // CCNA 2 - examenredes.com (primary)
  { file: "data/questions-bank-ccnadesdecero.json", name: "questions-bank-ccnadesdecero.json" }, // CCNA 2 - ccnadesdecero.es
  { file: "data/questions-bank-ccna3.json", name: "questions-bank-ccna3.json" }, // CCNA 3 (ENSA) - examenredes.com
  { file: "data/questions-bank-ccna3-ccnadesdecero.json", name: "questions-bank-ccna3-ccnadesdecero.json" }, // CCNA 3 (ENSA) - ccnadesdecero.es
];

const PRIMARY_BANK_NAME = BANK_FILES[0].name;

const bankCache = new Map<string, QuestionsBank>();
const bankLoadAttempted = new Set<string>();

// ============================================
// Questions Bank Loading
// ============================================

/** Load a single bank file (cached). Returns null when unavailable. */
async function loadBank(file: string): Promise<QuestionsBank | null> {
  const cached = bankCache.get(file);
  if (cached) return cached;
  if (bankLoadAttempted.has(file)) return null;
  bankLoadAttempted.add(file);

  try {
    const url = chrome.runtime.getURL(file);
    const response = await fetch(url);
    const bank = (await response.json()) as QuestionsBank;
    bankCache.set(file, bank);
    log(
      "[Study Assist] Questions bank loaded:",
      file,
      Object.keys(bank.modules).length,
      "modules",
    );
    return bank;
  } catch (error) {
    console.warn(`[Study Assist] Questions bank not available: ${file}`, error);
    return null;
  }
}

export async function loadQuestionsBank(): Promise<QuestionsBank | null> {
  return loadBank(BANK_FILES[0].file);
}

/**
 * Test-only helper to clear in-memory bank caches between unit tests.
 */
export function __resetQuestionBankCachesForTests(): void {
  bankCache.clear();
  bankLoadAttempted.clear();
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
  const bankKeys = Object.keys(bank.modules);
  const candidates: string[] = [];

  if (moduleInfo) {
    // Drop the course/version tokens ("CCNA 2", "CCNA3 v7.0") so they are not
    // mistaken for a module number (e.g. "CCNA 3 | Módulos 1-2").
    const cleaned = moduleInfo
      .replace(/\bccna\s*\d+(?:\.\d+)?\b/gi, " ")
      .replace(/\bv\d+(?:\.\d+)?\b/gi, " ");

    // Prefer an explicit range ("Módulos 1-2", "modules 9 – 12"); else the first number.
    const numbers: number[] = [];
    const rangeMatch = cleaned.match(/(\d+)\s*[–-]\s*(\d+)/);
    if (rangeMatch) {
      numbers.push(parseInt(rangeMatch[1]), parseInt(rangeMatch[2]));
    } else {
      const single = cleaned.match(/\d+/);
      if (single) numbers.push(parseInt(single[0]));
    }

    for (const moduleNum of numbers) {
      candidates.push(`mod-${moduleNum}`);
      // Any bank range "a-b" that contains this module number
      // (e.g. CCNA 3 grouped checkpoints: "1-2", "3-5", "9-12", ...).
      for (const key of bankKeys) {
        const range = key.match(/^(\d+)-(\d+)$/);
        if (range && moduleNum >= parseInt(range[1]) && moduleNum <= parseInt(range[2])) {
          candidates.push(key);
        }
      }
    }

    // Legacy CCNA 2 fixed ranges (bank keys "1-4" .. "14-16").
    const base = numbers[0];
    if (base !== undefined) {
      if (base >= 1 && base <= 4) candidates.push("1-4");
      else if (base >= 5 && base <= 6) candidates.push("5-6");
      else if (base >= 7 && base <= 9) candidates.push("7-9");
      else if (base >= 10 && base <= 13) candidates.push("10-13");
      else if (base >= 14 && base <= 16) candidates.push("14-16");
    }

    if (/final|ptsa|habilidades|práctica/i.test(moduleInfo)) {
      candidates.push(
        "final-practice", "final-skills", "final-exam", "ptsa-1", "ptsa-2"
      );
    }
  }

  const existing = [...new Set(candidates)].filter((key) => bankKeys.includes(key));
  return existing.length > 0 ? existing : bankKeys;
}

function findBestMatchInBank(
  bank: QuestionsBank,
  modulesToSearch: string[],
  normalizedQuestion: string,
  questionText: string,
  similarityThreshold: number,
  bankModel: string,
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

  const banks = (
    await Promise.all(
      BANK_FILES.map(async ({ file, name }) => ({ name, bank: await loadBank(file) })),
    )
  ).filter((entry): entry is { name: string; bank: QuestionsBank } => !!entry.bank);

  if (banks.length === 0) return null;

  if (banks.length < BANK_FILES.length) {
    log(
      `[Study Assist] ${BANK_FILES.length - banks.length} question bank(s) unavailable`,
    );
  }

  const normalizedQuestion = normalizeForSearch(questionText);

  // Lowered threshold from 0.6 to 0.55 to improve detection for modules 10+
  // Previously, many valid questions from modules 10-13 and 14-16 were not being matched
  // due to slight variations in wording between the bank and actual exam questions
  const isLongText = questionText.length > 800;
  const SIMILARITY_THRESHOLD = isLongText ? 0.50 : 0.55;

  const matches: MatchedQuestion[] = [];
  for (const { name, bank } of banks) {
    const modulesToSearch = buildModulesToSearch(moduleInfo, bank);
    const match = findBestMatchInBank(
      bank,
      modulesToSearch,
      normalizedQuestion,
      questionText,
      SIMILARITY_THRESHOLD,
      name,
    );
    if (match) matches.push(match);
  }

  if (matches.length === 0) {
    log("[Study Assist] No match in question bank");
    return null;
  }

  // The primary bank wins when it is confident; otherwise the highest score wins.
  const primaryMatch = matches.find((m) => m.bankModel === PRIMARY_BANK_NAME) ?? null;
  const others = matches.filter((m) => m.bankModel !== PRIMARY_BANK_NAME);

  let bestMatch: MatchedQuestion;
  if (primaryMatch && primaryMatch.similarity >= 80) {
    bestMatch = primaryMatch;
  } else {
    const confident = others.filter((m) => m.similarity >= 80);
    const pool = confident.length
      ? confident
      : [...others, ...(primaryMatch ? [primaryMatch] : [])];
    bestMatch = pool.reduce((best, m) => (m.similarity > best.similarity ? m : best), pool[0]);
  }

  // Conflict detection against the best match coming from a different bank.
  const runnerUp = matches
    .filter((m) => m.bankModel !== bestMatch.bankModel)
    .sort((a, b) => b.similarity - a.similarity)[0];
  const duplicateInfo = runnerUp ? evaluateDuplicateConflict(bestMatch, runnerUp) : null;

  if (runnerUp && duplicateInfo) {
    logDuplicateIfNeeded(bestMatch, runnerUp, duplicateInfo);
    bestMatch.bankConflictDetected = !duplicateInfo.answerEquivalent;
    bestMatch.bankConflictType = duplicateInfo.answerEquivalent ? "semantic-equivalent" : "real-conflict";
    bestMatch.bankConflictAnswerSimilarity = Math.round(duplicateInfo.answerSimilarity * 100);
    bestMatch.bankSecondaryModel = runnerUp.bankModel;
  }

  log(`[Study Assist] QUESTION BANK MATCH (${bestMatch.similarity}% similarity) from module ${bestMatch.moduleRange} (${bestMatch.bankModel}):`);
  log(`[Study Assist] Bank Q: "${bestMatch.text.substring(0, 80)}..."`);
  log(`[Study Assist] Page text length: ${questionText.length} chars`);
  log(`[Study Assist] Bank text length: ${bestMatch.text.length} chars`);
  log(`[Study Assist] Page normalized: "${normalizedQuestion.substring(0, 100)}..."`);
  log(`[Study Assist] Bank normalized: "${bestMatch.textNormalized.substring(0, 100)}..."`);
  log(`[Study Assist] Explanation: "${bestMatch.explanation ? bestMatch.explanation.substring(0, 100) + "..." : "N/A"}"`);

  return bestMatch;
}
