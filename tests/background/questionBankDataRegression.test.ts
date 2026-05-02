import { describe, it, expect } from "vitest";
import { promises as fs } from "fs";
import path from "path";
import { __testOnlyApiMatching } from "../../src/background/modules/api";

const { matchCorrectAnswerToLetter } = __testOnlyApiMatching;

async function loadFinalExam005() {
  const bankPath = path.join(process.cwd(), "data", "questions-bank.json");
  const raw = await fs.readFile(bankPath, "utf8");
  const bank = JSON.parse(raw);
  const questions = bank?.modules?.["final-exam"]?.questions || [];
  return questions.find((q: { id?: string }) => q.id === "final-exam_005");
}

describe("question bank data regression", () => {
  it("should keep final-exam_005 resolvable to two letters", async () => {
    const question = await loadFinalExam005();

    expect(question).toBeTruthy();
    expect(Array.isArray(question.options)).toBe(true);
    expect(Array.isArray(question.correctAnswers)).toBe(true);
    expect(question.correctAnswers.length).toBe(2);

    const pageOptions = question.options.map((text: string, idx: number) => ({
      letter: String.fromCharCode(65 + idx),
      text,
    }));

    const result = matchCorrectAnswerToLetter(
      { correctAnswers: question.correctAnswers },
      pageOptions,
    );

    expect(result).toBe("B, C");
  });
});
