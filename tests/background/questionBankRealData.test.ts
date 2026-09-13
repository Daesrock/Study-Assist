/**
 * Question-bank real-data self-match harness.
 *
 * Loads the ACTUAL bank JSON files and runs the matcher against a sample of
 * their own questions to verify that the data, similarity scoring and module
 * routing (including CCNA 3 grouped ranges like "1-2", "9-12") all work.
 *
 * This does not replace an end-to-end check on a real NetAcad page (which also
 * validates wording variations), but it catches data/routing regressions.
 *
 * Run alone: `npm run test:bank`
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { promises as fs } from "fs";
import path from "path";
import {
  findMatchingQuestion,
  __resetQuestionBankCachesForTests,
} from "../../src/background/modules/questionBank";

const BANK_FILES = [
  "data/questions-bank.json",
  "data/questions-bank-ccnadesdecero.json",
  "data/questions-bank-ccna3.json",
  "data/questions-bank-ccna3-ccnadesdecero.json",
];

const MAX_PER_MODULE = 1;
const MAX_PER_BANK = 24;

interface BankModule {
  questions?: Array<{ text?: string }>;
}
interface Bank {
  modules: Record<string, BankModule>;
}

async function loadBank(file: string): Promise<Bank> {
  const raw = await fs.readFile(path.join(process.cwd(), file), "utf8");
  return JSON.parse(raw) as Bank;
}

/** A NetAcad-ish title that keeps the module key so routing can pick it up. */
function moduleInfoFor(moduleKey: string): string {
  return `CCNA - ${moduleKey}`;
}

/** Stub fetch so only `activeFile` returns real data; the rest are empty. */
function stubFetch(activeFile: string, bank: Bank): void {
  const mock = vi.fn(async (input: string | URL | Request) => {
    const url = String(input);
    if (url.includes(activeFile)) return { json: async () => bank };
    return { json: async () => ({ modules: {} }) };
  });
  vi.stubGlobal("fetch", mock);
}

function sampleQuestions(bank: Bank): Array<{ moduleKey: string; text: string }> {
  const samples: Array<{ moduleKey: string; text: string }> = [];
  for (const [moduleKey, mod] of Object.entries(bank.modules)) {
    const questions = (mod?.questions ?? []).filter((q) => q?.text);
    for (const question of questions.slice(0, MAX_PER_MODULE)) {
      if (samples.length >= MAX_PER_BANK) break;
      samples.push({ moduleKey, text: question.text as string });
    }
    if (samples.length >= MAX_PER_BANK) break;
  }
  return samples;
}

describe("question bank real-data self-match", () => {
  beforeEach(() => {
    __resetQuestionBankCachesForTests();
  });

  afterEach(() => {
    __resetQuestionBankCachesForTests();
    vi.unstubAllGlobals();
  });

  for (const file of BANK_FILES) {
    it(`self-matches sampled questions from ${path.basename(file)}`, async () => {
      const bank = await loadBank(file);
      stubFetch(file, bank);

      const expectedBankModel = path.basename(file);
      const samples = sampleQuestions(bank);
      expect(samples.length).toBeGreaterThan(0);

      let matched = 0;
      let moduleRangeHits = 0;
      let minSimilarity = Number.POSITIVE_INFINITY;
      const misses: string[] = [];

      for (const sample of samples) {
        const result = await findMatchingQuestion(
          sample.text,
          moduleInfoFor(sample.moduleKey),
          "https://www.netacad.com/",
        );

        if (result && result.similarity >= 80 && result.bankModel === expectedBankModel) {
          matched++;
          minSimilarity = Math.min(minSimilarity, result.similarity);
          if (result.moduleRange === sample.moduleKey) moduleRangeHits++;
        } else {
          misses.push(
            `${sample.moduleKey}: ${sample.text.slice(0, 70)} | got: ${
              result ? `${result.bankModel}/${result.moduleRange}/${result.similarity}%` : "none"
            }`,
          );
        }
      }

      console.log(
        `[bank self-match] ${path.basename(file)}: ${matched}/${samples.length} matched, ` +
          `min similarity ${matched ? minSimilarity : "n/a"}%, module-range hits ${moduleRangeHits}/${samples.length}`,
      );
      if (misses.length) console.log(`[bank self-match] misses:\n${misses.slice(0, 8).join("\n")}`);

      expect(misses).toEqual([]);
      expect(matched).toBe(samples.length);
    }, 60000);
  }
});
