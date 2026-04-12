import { describe, it, expect } from "vitest";
import {
  normalizeAnswerSemantic,
  compareAnswerSetsSemantically,
} from "../../src/background/modules/answerEquivalences";

describe("normalizeAnswerSemantic", () => {
  it("normalizes wording variants to similar semantic tokens", () => {
    const a = normalizeAnswerSemantic("Ingresa al modo de configuracion global");
    const b = normalizeAnswerSemantic("Entra en el modo de configuracion global");

    expect(a).toBe(b);
  });

  it("normalizes technical spanish/english aliases", () => {
    const a = normalizeAnswerSemantic("Wireless WideArea Network");
    const b = normalizeAnswerSemantic("Red inalambrica de area amplia");

    expect(a).toBe("wwan");
    expect(a).toBe(b);
  });
});

describe("compareAnswerSetsSemantically", () => {
  it("marks equivalent answer sets with semantic variations", () => {
    const result = compareAnswerSetsSemantically(
      ["Las tramas se reenvian sin ninguna verificacion de errores"],
      ["Las tramas se reenvian sin ninguna comprobacion de errores"],
    );

    expect(result.equivalent).toBe(true);
    expect(result.similarity).toBeGreaterThanOrEqual(0.8);
  });

  it("detects real conflicts for different protocol answers", () => {
    const result = compareAnswerSetsSemantically(["SSH"], ["Telnet"]);

    expect(result.equivalent).toBe(false);
    expect(result.similarity).toBeLessThan(0.8);
  });
});
