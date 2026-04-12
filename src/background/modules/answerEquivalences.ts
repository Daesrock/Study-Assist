/**
 * Answer semantic normalization and equivalence helpers.
 * Focused on NetAcad/CCNA wording variations in ES/EN.
 */

const PHRASE_EQUIVALENCES: Array<[RegExp, string]> = [
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
  [/\bstp\b/gi, "stp"],
  [/\bspanning\s+tree\b/gi, "stp"],
  [/\barbol\s+de\s+expansion\b/gi, "stp"],
];

const TOKEN_EQUIVALENCES: Record<string, string> = {
  entra: "entrar",
  ingresar: "entrar",
  ingresa: "entrar",
  accede: "entrar",
  acceso: "entrar",
  acceder: "entrar",

  verificacion: "comprobacion",
  verificar: "comprobacion",
  comprobacion: "comprobacion",
  comprobar: "comprobacion",

  concentrador: "hub",
  hubs: "hub",
  hub: "hub",

  switches: "switch",

  puerto: "puertos",
  puertos: "puertos",

  protocolo: "protocolos",
  protocolos: "protocolos",

  retransmision: "reenvio",
  reenvio: "reenvio",

  transmitir: "transmision",
  transmision: "transmision",

  puente: "bridge",
  bridges: "bridge",

  routeronastick: "router_on_a_stick",
};

const STOP_WORDS = new Set([
  "el", "la", "los", "las", "un", "una", "unos", "unas", "de", "del", "al", "en",
  "para", "por", "que", "se", "lo", "su", "sus", "como", "con", "sin", "y", "o",
]);

function normalizeBase(text: string): string {
  return text
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[\u200B-\u200D\uFEFF]/g, "")
    .replace(/&nbsp;/g, " ")
    .replace(/[¿?¡!.,;:()"\-]/g, " ")
    .replace(/\//g, "")
    .replace(/\s+/g, " ")
    .trim();
}

function normalizeToken(token: string): string {
  if (!token) return "";

  const mapped = TOKEN_EQUIVALENCES[token] || token;

  // Lightweight singularization for common plural endings.
  if (mapped.length > 4 && mapped.endsWith("es") && !mapped.endsWith("ses")) {
    return mapped.slice(0, -2);
  }
  if (mapped.length > 3 && mapped.endsWith("s") && !mapped.endsWith("sis")) {
    return mapped.slice(0, -1);
  }

  return mapped;
}

function tokenizeSemantic(text: string): string[] {
  const base = normalizeBase(text);
  const withPhrases = PHRASE_EQUIVALENCES.reduce(
    (acc, [pattern, replacement]) => acc.replace(pattern, ` ${replacement} `),
    base,
  );

  return withPhrases
    .split(" ")
    .map((token) => normalizeToken(token.trim()))
    .filter((token) => token.length > 1 && !STOP_WORDS.has(token));
}

function jaccardTokenSimilarity(tokensA: string[], tokensB: string[]): number {
  const setA = new Set(tokensA);
  const setB = new Set(tokensB);

  if (setA.size === 0 || setB.size === 0) return 0;

  let intersection = 0;
  for (const token of setA) {
    if (setB.has(token)) intersection++;
  }

  return intersection / Math.max(setA.size, setB.size);
}

export function normalizeAnswerSemantic(text: string): string {
  return tokenizeSemantic(text).join(" ");
}

export function normalizeAnswerSetSemantic(answers: string[]): string[] {
  return [...new Set(answers.map((ans) => normalizeAnswerSemantic(ans)).filter(Boolean))].sort();
}

export interface AnswerEquivalenceResult {
  equivalent: boolean;
  similarity: number;
  normalizedPrimary: string[];
  normalizedSecondary: string[];
}

export function compareAnswerSetsSemantically(
  primaryAnswers: string[],
  secondaryAnswers: string[],
): AnswerEquivalenceResult {
  const normalizedPrimary = normalizeAnswerSetSemantic(primaryAnswers);
  const normalizedSecondary = normalizeAnswerSetSemantic(secondaryAnswers);

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

  if (JSON.stringify(normalizedPrimary) === JSON.stringify(normalizedSecondary)) {
    return {
      equivalent: true,
      similarity: 1,
      normalizedPrimary,
      normalizedSecondary,
    };
  }

  const [smaller, larger] = normalizedPrimary.length <= normalizedSecondary.length
    ? [normalizedPrimary, normalizedSecondary]
    : [normalizedSecondary, normalizedPrimary];

  const pairScores: number[] = [];

  for (const left of smaller) {
    const leftTokens = left.split(" ");
    let best = 0;
    for (const right of larger) {
      const score = jaccardTokenSimilarity(leftTokens, right.split(" "));
      if (score > best) best = score;
    }
    pairScores.push(best);
  }

  const similarity = pairScores.reduce((sum, score) => sum + score, 0) / pairScores.length;
  const equivalent = similarity >= 0.8 && normalizedPrimary.length === normalizedSecondary.length;

  return {
    equivalent,
    similarity,
    normalizedPrimary,
    normalizedSecondary,
  };
}
