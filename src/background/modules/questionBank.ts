/**
 * Background Service Worker - Questions Bank
 * Handles loading, searching, and matching questions from the bank
 */

import { log, questionsBank, setQuestionsBank } from "./constants.js";
import type { QuestionsBank, MatchedQuestion } from "./constants.js";

// ============================================
// Questions Bank Loading
// ============================================

export async function loadQuestionsBank(): Promise<QuestionsBank | null> {
  if (questionsBank) return questionsBank;

  try {
    const url = chrome.runtime.getURL("data/questions-bank.json");
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

  const bank = await loadQuestionsBank();
  if (!bank) return null;

  const normalizedQuestion = normalizeForSearch(questionText);

  let modulesToSearch: string[] = [];

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

  if (modulesToSearch.length === 0) {
    modulesToSearch = Object.keys(bank.modules);
  }

  let bestMatch: MatchedQuestion | null = null;
  let bestSimilarity = 0;
  
  // Use lower threshold for long texts (routing tables, command outputs)
  // These often have identical content but different text order (table-first vs question-first)
  const isLongText = questionText.length > 800;
  const SIMILARITY_THRESHOLD = isLongText ? 0.55 : 0.6;

  for (const moduleRange of modulesToSearch) {
    const module = bank.modules[moduleRange];
    if (!module || !module.questions) continue;

    for (const question of module.questions) {
      let similarity: number;
      
      // Special case: routing tables with PARTIALURLPLACEHOLDER
      // These contain the same content but normalization destroys IP addresses (10.38.60.26 → 10386026)
      // If both texts contain this placeholder, give high similarity automatically
      const pageHasPlaceholder = questionText.toLowerCase().includes("partialurlplaceholder");
      const bankHasPlaceholder = question.text.toLowerCase().includes("partialurlplaceholder");
      
      if (pageHasPlaceholder && bankHasPlaceholder) {
        // Both have routing table images - likely the same question
        similarity = 0.95;
      } else {
        // Use the MAX of standard similarity and containment.
        // Standard similarity works when texts are similar length.
        // Containment works when the page has extra context (tables, code)
        // around the actual question.
        const stdSimilarity = calculateSimilarity(normalizedQuestion, question.textNormalized);
        const containment = calculateContainment(normalizedQuestion, question.textNormalized);
        similarity = Math.max(stdSimilarity, containment);
      }

      if (similarity > bestSimilarity && similarity >= SIMILARITY_THRESHOLD) {
        bestSimilarity = similarity;
        bestMatch = {
          ...question,
          moduleRange,
          similarity: Math.round(similarity * 100),
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
