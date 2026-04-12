import { promises as fs } from "fs";
import path from "path";
import { fileURLToPath } from "url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const args = process.argv.slice(2);
const getArgValue = (flag, fallback) => {
  const idx = args.indexOf(flag);
  return idx >= 0 && args[idx + 1] ? args[idx + 1] : fallback;
};

const primaryPath = path.resolve(
  __dirname,
  "..",
  getArgValue("--primary", "data/questions-bank.json"),
);
const secondaryPath = path.resolve(
  __dirname,
  "..",
  getArgValue("--secondary", "data/questions-bank-ccnadesdecero.json"),
);
const outputPath = path.resolve(
  __dirname,
  "..",
  getArgValue("--output", "data/bank-overlap-report.json"),
);

function normalizeForSearch(text) {
  return (text || "")
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

const PHRASE_EQUIVALENCES = [
  [/\bwireless\s+wide\s*area\s+network\b/gi, "wwan"],
  [/\bred\s+inalambrica\s+de\s+area\s+amplia\b/gi, "wwan"],
  [/\bwireless\s+metropolitan\s*area\s+network\b/gi, "wman"],
  [/\bred\s+inalambrica\s+de\s+area\s+metropolitana\b/gi, "wman"],
  [/\bwireless\s+personal\s*area\s+network\b/gi, "wpan"],
  [/\bred\s+de\s+area\s+personal\s+inalambrica\b/gi, "wpan"],
  [/\blayer\s*2\b/gi, "capa2"],
  [/\bcapa\s*2\b/gi, "capa2"],
  [/\blayer\s*3\b/gi, "capa3"],
  [/\bcapa\s*3\b/gi, "capa3"],
  [/\barbol\s+de\s+expansion\b/gi, "stp"],
  [/\bspanning\s+tree\b/gi, "stp"],
];

const TOKEN_EQUIVALENCES = {
  entra: "entrar",
  ingresa: "entrar",
  ingresar: "entrar",
  accede: "entrar",

  verificacion: "comprobacion",
  comprobacion: "comprobacion",
  verificar: "comprobacion",
  comprobar: "comprobacion",

  concentrador: "hub",
  hub: "hub",
  hubs: "hub",

  puerto: "puertos",
  puertos: "puertos",

  protocolo: "protocolos",
  protocolos: "protocolos",

  retransmision: "reenvio",
  reenvio: "reenvio",

  puente: "bridge",
  bridges: "bridge",
};

const STOP_WORDS = new Set([
  "el",
  "la",
  "los",
  "las",
  "un",
  "una",
  "unos",
  "unas",
  "de",
  "del",
  "al",
  "en",
  "para",
  "por",
  "que",
  "se",
  "lo",
  "su",
  "sus",
  "como",
  "con",
  "sin",
  "y",
  "o",
]);

function normalizeToken(token) {
  const mapped = TOKEN_EQUIVALENCES[token] || token;

  if (mapped.length > 4 && mapped.endsWith("es") && !mapped.endsWith("ses")) {
    return mapped.slice(0, -2);
  }
  if (mapped.length > 3 && mapped.endsWith("s") && !mapped.endsWith("sis")) {
    return mapped.slice(0, -1);
  }

  return mapped;
}

function normalizeAnswerSemantic(text) {
  const base = normalizeForSearch(text || "");
  const withPhrases = PHRASE_EQUIVALENCES.reduce(
    (acc, [pattern, replacement]) => acc.replace(pattern, ` ${replacement} `),
    base,
  );

  return withPhrases
    .split(" ")
    .map((token) => normalizeToken(token.trim()))
    .filter((token) => token.length > 1 && !STOP_WORDS.has(token))
    .join(" ");
}

function jaccardTokenSimilarity(textA, textB) {
  const setA = new Set((textA || "").split(" ").filter(Boolean));
  const setB = new Set((textB || "").split(" ").filter(Boolean));

  if (setA.size === 0 || setB.size === 0) return 0;

  let matches = 0;
  for (const token of setA) {
    if (setB.has(token)) matches++;
  }

  return matches / Math.max(setA.size, setB.size);
}

function compareAnswerSetsSemantically(primaryAnswers, secondaryAnswers) {
  const normalizedPrimary = [
    ...new Set(
      (primaryAnswers || [])
        .map((a) => normalizeAnswerSemantic(a))
        .filter(Boolean),
    ),
  ].sort();
  const normalizedSecondary = [
    ...new Set(
      (secondaryAnswers || [])
        .map((a) => normalizeAnswerSemantic(a))
        .filter(Boolean),
    ),
  ].sort();

  if (normalizedPrimary.length === 0 && normalizedSecondary.length === 0) {
    return {
      equivalent: true,
      similarity: 1,
      normalizedPrimary,
      normalizedSecondary,
    };
  }

  if (normalizedPrimary.length === 0 || normalizedSecondary.length === 0) {
    return {
      equivalent: false,
      similarity: 0,
      normalizedPrimary,
      normalizedSecondary,
    };
  }

  if (
    JSON.stringify(normalizedPrimary) === JSON.stringify(normalizedSecondary)
  ) {
    return {
      equivalent: true,
      similarity: 1,
      normalizedPrimary,
      normalizedSecondary,
    };
  }

  const [smaller, larger] =
    normalizedPrimary.length <= normalizedSecondary.length
      ? [normalizedPrimary, normalizedSecondary]
      : [normalizedSecondary, normalizedPrimary];

  const scores = [];
  for (const left of smaller) {
    let best = 0;
    for (const right of larger) {
      const score = jaccardTokenSimilarity(left, right);
      if (score > best) best = score;
    }
    scores.push(best);
  }

  const similarity =
    scores.reduce((sum, score) => sum + score, 0) / scores.length;

  return {
    equivalent:
      similarity >= 0.8 &&
      normalizedPrimary.length === normalizedSecondary.length,
    similarity,
    normalizedPrimary,
    normalizedSecondary,
  };
}

function collectAnswerSet(question) {
  const answers =
    Array.isArray(question.correctAnswers) && question.correctAnswers.length > 0
      ? question.correctAnswers
      : question.correctAnswer
        ? [question.correctAnswer]
        : [];

  return [
    ...new Set(answers.map((a) => normalizeForSearch(a)).filter(Boolean)),
  ].sort();
}

function flattenQuestions(bank, bankId) {
  const rows = [];
  const modules = bank?.modules || {};

  for (const [moduleKey, moduleData] of Object.entries(modules)) {
    const questions = moduleData?.questions || [];
    for (const q of questions) {
      const normalized = q.textNormalized || normalizeForSearch(q.text || "");
      rows.push({
        bankId,
        moduleKey,
        id: q.id || null,
        text: q.text || "",
        normalized,
        answers: collectAnswerSet(q),
      });
    }
  }

  return rows;
}

function answerSignature(answerSet) {
  return JSON.stringify(answerSet || []);
}

async function main() {
  const [primaryRaw, secondaryRaw] = await Promise.all([
    fs.readFile(primaryPath, "utf8"),
    fs.readFile(secondaryPath, "utf8"),
  ]);

  const primaryBank = JSON.parse(primaryRaw);
  const secondaryBank = JSON.parse(secondaryRaw);

  const primaryRows = flattenQuestions(primaryBank, "primary");
  const secondaryRows = flattenQuestions(secondaryBank, "secondary");

  const primaryByText = new Map();
  for (const row of primaryRows) {
    if (!primaryByText.has(row.normalized))
      primaryByText.set(row.normalized, []);
    primaryByText.get(row.normalized).push(row);
  }

  let exactDuplicates = 0;
  let exactConflictsRaw = 0;
  let exactConflictsSemantic = 0;
  const samples = [];

  for (const row of secondaryRows) {
    const primaryMatches = primaryByText.get(row.normalized) || [];
    if (primaryMatches.length === 0) continue;

    for (const pm of primaryMatches) {
      exactDuplicates++;
      const sameAnswerRaw =
        answerSignature(pm.answers) === answerSignature(row.answers);
      if (!sameAnswerRaw) exactConflictsRaw++;

      const semanticCompare = compareAnswerSetsSemantically(
        pm.answers,
        row.answers,
      );
      if (!semanticCompare.equivalent) {
        exactConflictsSemantic++;
      }

      if (samples.length < 20) {
        samples.push({
          text: row.text.substring(0, 180),
          primaryModule: pm.moduleKey,
          secondaryModule: row.moduleKey,
          sameAnswerRaw,
          sameAnswerSemantic: semanticCompare.equivalent,
          answerSimilaritySemantic: Number(
            (semanticCompare.similarity * 100).toFixed(2),
          ),
          primaryAnswers: pm.answers,
          secondaryAnswers: row.answers,
          primaryAnswersSemantic: semanticCompare.normalizedPrimary,
          secondaryAnswersSemantic: semanticCompare.normalizedSecondary,
        });
      }
    }
  }

  const report = {
    generatedAt: new Date().toISOString(),
    files: {
      primary: path.relative(path.join(__dirname, ".."), primaryPath),
      secondary: path.relative(path.join(__dirname, ".."), secondaryPath),
    },
    totals: {
      primaryQuestions: primaryRows.length,
      secondaryQuestions: secondaryRows.length,
      exactDuplicates,
      exactConflictsRaw,
      exactConflictsSemantic,
      reducedFalsePositives: Math.max(
        exactConflictsRaw - exactConflictsSemantic,
        0,
      ),
      overlapPercentOfSecondary: secondaryRows.length
        ? Number(((exactDuplicates / secondaryRows.length) * 100).toFixed(2))
        : 0,
    },
    samples,
  };

  await fs.writeFile(outputPath, JSON.stringify(report, null, 2), "utf8");

  console.log("=== Bank Overlap Analysis ===");
  console.log(`Primary questions:   ${report.totals.primaryQuestions}`);
  console.log(`Secondary questions: ${report.totals.secondaryQuestions}`);
  console.log(`Exact duplicates:    ${report.totals.exactDuplicates}`);
  console.log(
    `Answer conflicts (raw):      ${report.totals.exactConflictsRaw}`,
  );
  console.log(
    `Answer conflicts (semantic): ${report.totals.exactConflictsSemantic}`,
  );
  console.log(
    `False positives reduced:     ${report.totals.reducedFalsePositives}`,
  );
  console.log(
    `Overlap % secondary: ${report.totals.overlapPercentOfSecondary}%`,
  );
  console.log(
    `Report: ${path.relative(path.join(__dirname, ".."), outputPath)}`,
  );
}

main().catch((error) => {
  console.error("Overlap analysis failed:", error);
  process.exit(1);
});
