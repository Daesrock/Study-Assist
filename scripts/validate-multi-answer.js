import { promises as fs } from "fs";
import path from "path";
import { fileURLToPath } from "url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const ROOT = path.resolve(__dirname, "..");

const BANK_FILES = [
  "data/questions-bank.json",
  "data/questions-bank-ccnadesdecero.json",
];

function normalizeForSearch(text) {
  return String(text || "")
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[\u200B-\u200D\uFEFF]/g, "")
    .replace(/&nbsp;/g, " ")
    .replace(/[¿?¡!.,;:()"\-]/g, "")
    .replace(/\//g, "")
    .replace(/\s+/g, " ")
    .trim();
}

function tokenCount(text) {
  return normalizeForSearch(text).split(" ").filter(Boolean).length;
}

function calculateSimilarity(a, b) {
  const wordsA = new Set(
    normalizeForSearch(a)
      .split(" ")
      .filter((w) => w.length > 2),
  );
  const wordsB = new Set(
    normalizeForSearch(b)
      .split(" ")
      .filter((w) => w.length > 2),
  );
  if (wordsA.size === 0 || wordsB.size === 0) return 0;

  let matches = 0;
  for (const w of wordsA) {
    if (wordsB.has(w)) matches += 1;
  }
  return matches / Math.max(wordsA.size, wordsB.size);
}

function hasCommandLikeText(text) {
  return /\bconfig\b|\binterface\b|\bswitchport\b|\bip\b|\brouter\b|\bvlan\b/.test(
    normalizeForSearch(text),
  );
}

function findOptionMatch(answer, options) {
  const normalizedAnswer = normalizeForSearch(answer);
  const answerTokens = tokenCount(answer);
  const answerIsCommandLike = hasCommandLikeText(answer);

  for (let i = 0; i < options.length; i += 1) {
    if (normalizeForSearch(options[i]) === normalizedAnswer)
      return { index: i, method: "exact" };
  }

  for (let i = 0; i < options.length; i += 1) {
    const normalizedOption = normalizeForSearch(options[i]);

    if (normalizedOption.includes(normalizedAnswer)) {
      return { index: i, method: "contains" };
    }

    if (normalizedAnswer.includes(normalizedOption)) {
      const optionTokenCount = tokenCount(options[i]);
      const lengthRatio =
        normalizedOption.length / Math.max(normalizedAnswer.length, 1);
      const tokenRatio = optionTokenCount / Math.max(answerTokens, 1);
      if (lengthRatio >= 0.8 || tokenRatio >= 0.8) {
        return { index: i, method: "reverse-contains-safe" };
      }
    }
  }

  let best = null;
  for (let i = 0; i < options.length; i += 1) {
    const similarity = calculateSimilarity(answer, options[i]);
    if (!best || similarity > best.similarity) {
      best = { index: i, similarity };
    }

    const threshold = answerIsCommandLike ? 0.7 : 0.8;
    if (similarity >= threshold) {
      return { index: i, method: "high-similarity", similarity };
    }
  }

  const fallbackThreshold = answerIsCommandLike ? 0.62 : 0.6;
  if (best && best.similarity >= fallbackThreshold) {
    return {
      index: best.index,
      method: "fallback-similarity",
      similarity: best.similarity,
    };
  }

  return null;
}

function isMultiAnswerQuestion(text) {
  const t = normalizeForSearch(text);
  return /\belija\s+(dos|tres|cuatro|2|3|4)\b|\bescoja\s+(dos|tres|cuatro|2|3|4)\b|\bseleccione\s+(dos|tres|cuatro|2|3|4)\b|\bchoose\s+(two|three|four|2|3|4)\b|\bselect\s+(two|three|four|2|3|4)\b/.test(
    t,
  );
}

function looksLikeAmbiguousConfigSnippet(optionText, previousOptionText) {
  const current = normalizeForSearch(optionText);
  const prev = normalizeForSearch(previousOptionText || "");

  if (!current.startsWith("config ip")) return false;
  if (!prev.includes("config interface")) return false;
  return true;
}

async function loadBank(relativePath) {
  const absPath = path.join(ROOT, relativePath);
  const raw = await fs.readFile(absPath, "utf8");
  const data = JSON.parse(raw);
  return { absPath, data };
}

function pushIssue(store, level, bank, moduleRange, questionId, message) {
  store.push({ level, bank, moduleRange, questionId, message });
}

function validateQuestion(bankName, moduleRange, question, issues) {
  const id = question.id || "<missing-id>";
  const options = Array.isArray(question.options) ? question.options : [];
  const hasSingle =
    typeof question.correctAnswer === "string" &&
    question.correctAnswer.trim().length > 0;
  const hasMulti = Array.isArray(question.correctAnswers);
  const multiQuestion = isMultiAnswerQuestion(question.text || "");

  if (!Array.isArray(question.options) || question.options.length === 0) {
    pushIssue(
      issues,
      "critical",
      bankName,
      moduleRange,
      id,
      "Question without options array",
    );
  }

  if (!hasSingle && !hasMulti) {
    pushIssue(
      issues,
      "critical",
      bankName,
      moduleRange,
      id,
      "Question without correctAnswer/correctAnswers",
    );
    return;
  }

  if (hasSingle && hasMulti) {
    pushIssue(
      issues,
      "warning",
      bankName,
      moduleRange,
      id,
      "Question has both correctAnswer and correctAnswers",
    );
  }

  if (multiQuestion && hasSingle && !hasMulti) {
    pushIssue(
      issues,
      "warning",
      bankName,
      moduleRange,
      id,
      "Question text suggests multiple answers but uses singular correctAnswer",
    );
  }

  if (!hasMulti) {
    return;
  }

  if (question.correctAnswers.length === 0) {
    pushIssue(
      issues,
      "critical",
      bankName,
      moduleRange,
      id,
      "correctAnswers is empty",
    );
    return;
  }

  if (question.correctAnswers.length === 1) {
    pushIssue(
      issues,
      "warning",
      bankName,
      moduleRange,
      id,
      "correctAnswers has only one element",
    );
  }

  const normalizedSet = new Set();
  for (let i = 0; i < question.correctAnswers.length; i += 1) {
    const answer = question.correctAnswers[i];
    if (typeof answer !== "string" || answer.trim().length === 0) {
      pushIssue(
        issues,
        "critical",
        bankName,
        moduleRange,
        id,
        `correctAnswers[${i}] is not a non-empty string`,
      );
      continue;
    }

    const normalized = normalizeForSearch(answer);
    if (normalizedSet.has(normalized)) {
      pushIssue(
        issues,
        "warning",
        bankName,
        moduleRange,
        id,
        `Duplicated answer in correctAnswers[${i}]`,
      );
    }
    normalizedSet.add(normalized);
  }

  const usedOptionIndices = new Set();
  for (const answer of question.correctAnswers) {
    if (typeof answer !== "string" || answer.trim().length === 0) continue;

    const candidateOptions = options
      .map((text, index) => ({ text, index }))
      .filter((entry) => !usedOptionIndices.has(entry.index));

    const match = findOptionMatch(
      answer,
      candidateOptions.map((entry) => entry.text),
    );
    if (!match) {
      pushIssue(
        issues,
        "warning",
        bankName,
        moduleRange,
        id,
        `No option match found for answer: ${answer.slice(0, 80)}`,
      );
      continue;
    }

    const realOptionIndex = candidateOptions[match.index]?.index;
    if (typeof realOptionIndex === "number") {
      usedOptionIndices.add(realOptionIndex);
    }
  }

  for (let i = 1; i < options.length; i += 1) {
    if (looksLikeAmbiguousConfigSnippet(options[i], options[i - 1])) {
      pushIssue(
        issues,
        "info",
        bankName,
        moduleRange,
        id,
        `Potential ambiguous config snippet in option index ${i}`,
      );
    }
  }
}

function summarizeIssues(issues) {
  const counts = { critical: 0, warning: 0, info: 0 };
  for (const issue of issues) {
    counts[issue.level] += 1;
  }
  return counts;
}

async function main() {
  const allIssues = [];

  for (const relativePath of BANK_FILES) {
    const { absPath, data } = await loadBank(relativePath);
    const bankName = path.basename(absPath);

    if (
      !data ||
      typeof data !== "object" ||
      !data.modules ||
      typeof data.modules !== "object"
    ) {
      pushIssue(
        allIssues,
        "critical",
        bankName,
        "<root>",
        "<root>",
        "Invalid bank structure: missing modules",
      );
      continue;
    }

    for (const [moduleRange, moduleData] of Object.entries(data.modules)) {
      const questions = Array.isArray(moduleData?.questions)
        ? moduleData.questions
        : [];
      if (!Array.isArray(moduleData?.questions)) {
        pushIssue(
          allIssues,
          "critical",
          bankName,
          moduleRange,
          "<module>",
          "Module missing questions array",
        );
        continue;
      }

      for (const question of questions) {
        validateQuestion(bankName, moduleRange, question, allIssues);
      }
    }
  }

  const counts = summarizeIssues(allIssues);
  const important = allIssues.filter((i) => i.level !== "info");

  console.log("[validate-multi-answer] Validation summary");
  console.log(`- critical: ${counts.critical}`);
  console.log(`- warning:  ${counts.warning}`);
  console.log(`- info:     ${counts.info}`);

  if (important.length > 0) {
    console.log("\n[validate-multi-answer] Findings:");
    for (const issue of important.slice(0, 200)) {
      console.log(
        `- [${issue.level}] ${issue.bank} / ${issue.moduleRange} / ${issue.questionId}: ${issue.message}`,
      );
    }
    if (important.length > 200) {
      console.log(
        `- ... ${important.length - 200} additional findings omitted`,
      );
    }
  }

  if (counts.critical > 0) {
    console.error("\n[validate-multi-answer] Failed: critical issues found.");
    process.exit(1);
  }

  console.log("\n[validate-multi-answer] OK: no critical issues.");
}

main().catch((error) => {
  console.error("[validate-multi-answer] Unexpected error:", error);
  process.exit(1);
});
