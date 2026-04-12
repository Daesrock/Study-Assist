/**
 * Tests for Question Bank Functions
 * Covers: normalizeForSearch, calculateSimilarity, isNetAcadPage, findMatchingQuestion
 */

import { describe, it, expect, beforeEach, vi } from "vitest";
import {
  normalizeForSearch,
  calculateSimilarity,
  isNetAcadPage,
  findMatchingQuestion,
  __resetQuestionBankCachesForTests,
} from "../../src/background/modules/questionBank";
import { mockStorage } from "../setup";

describe("normalizeForSearch", () => {
  it("should lowercase text", () => {
    expect(normalizeForSearch("Hello World")).toBe("hello world");
  });

  it("should remove accents", () => {
    expect(normalizeForSearch("dirección")).toBe("direccion");
    expect(normalizeForSearch("módulo")).toBe("modulo");
    expect(normalizeForSearch("práctica")).toBe("practica");
  });

  it("should remove punctuation", () => {
    expect(normalizeForSearch("¿Qué es esto?")).toBe("que es esto");
    expect(normalizeForSearch("Hello! World.")).toBe("hello world");
  });

  it("should normalize whitespace", () => {
    expect(normalizeForSearch("  hello   world  ")).toBe("hello world");
  });

  it("should handle complex Spanish exam text", () => {
    const input = "¿Cuál es la máscara de subred predeterminada para una dirección IPv4 de clase C?";
    const result = normalizeForSearch(input);
    expect(result).toBe("cual es la mascara de subred predeterminada para una direccion ipv4 de clase c");
    expect(result).not.toContain("¿");
    expect(result).not.toContain("á");
  });

  it("should handle empty string", () => {
    expect(normalizeForSearch("")).toBe("");
  });
});

describe("calculateSimilarity", () => {
  it("should return 1.0 for identical texts", () => {
    const text = "which routing protocol uses dijkstra algorithm";
    expect(calculateSimilarity(text, text)).toBe(1);
  });

  it("should return 0 for completely different texts", () => {
    const result = calculateSimilarity("apple banana cherry", "xyz uvw rst");
    expect(result).toBe(0);
  });

  it("should return partial score for overlapping texts", () => {
    const result = calculateSimilarity(
      "which protocol uses port 443",
      "what protocol operates port 443 https"
    );
    expect(result).toBeGreaterThan(0);
    expect(result).toBeLessThan(1);
  });

  it("should ignore short words (length <= 2)", () => {
    // "is" and "a" should be ignored, only comparing meaningful words
    const result = calculateSimilarity(
      "what is routing protocol",
      "what is switching protocol"
    );
    // "what", "routing"/"switching", "protocol" — 2 out of 3 match
    expect(result).toBeGreaterThan(0.5);
    expect(result).toBeLessThan(1);
  });

  it("should return 0 when both inputs are only short words", () => {
    expect(calculateSimilarity("is a to", "it an no")).toBe(0);
  });

  it("should return 0 for empty strings", () => {
    expect(calculateSimilarity("", "")).toBe(0);
    expect(calculateSimilarity("hello world", "")).toBe(0);
  });

  it("should handle common exam question comparison", () => {
    const bankQuestion = "cual protocolo capa transporte garantiza entrega paquetes";
    const pageQuestion = "cual protocolo capa transporte garantiza entrega confiable paquetes";
    const similarity = calculateSimilarity(bankQuestion, pageQuestion);
    expect(similarity).toBeGreaterThanOrEqual(0.6); // Should pass the 60% threshold
  });

  it("should detect questions with 55% similarity (modules 10+ calibration)", () => {
    // Real-world scenario: bank has "ataque de agotamiento de DHCP"
    // but page says "ataque agotamiento DHCP servidores"
    const bankQuestion = "cual es resultado ataque agotamiento dhcp";
    const pageQuestion = "cual resultado ataque agotamiento dhcp servidores red";
    const similarity = calculateSimilarity(bankQuestion, pageQuestion);
    // This should be around 55-75%, which should pass the lowered threshold of 55%
    expect(similarity).toBeGreaterThanOrEqual(0.5);
    expect(similarity).toBeLessThanOrEqual(0.8);
  });

  it("should handle questions with extra context words", () => {
    // Modules 10+ often have longer questions with more context
    const bankQuestion = "que representa practica recomendada protocolos descubrimiento cdp lldp dispositivos red";
    const pageQuestion = "que representa mejor practica recomendada relacion protocolos descubrimiento como cdp lldp dispositivos red empresa";
    const similarity = calculateSimilarity(bankQuestion, pageQuestion);
    // Should be around 55-70% due to extra words
    expect(similarity).toBeGreaterThanOrEqual(0.5);
  });
});

describe("isNetAcadPage", () => {
  it("should detect netacad.com in URL", () => {
    expect(isNetAcadPage(undefined, "https://www.netacad.com/courses/ccna")).toBe(true);
  });

  it("should detect Cisco in page title", () => {
    expect(isNetAcadPage("Cisco Networking Academy", undefined)).toBe(true);
  });

  it("should detect CCNA in title", () => {
    expect(isNetAcadPage("CCNA 7 - Module 1-4 Exam", undefined)).toBe(true);
  });

  it("should detect CCNP in title", () => {
    expect(isNetAcadPage("CCNP Enterprise Exam", undefined)).toBe(true);
  });

  it("should detect 'Skills for All'", () => {
    expect(isNetAcadPage("Skills for All - Module 1", undefined)).toBe(true);
  });

  it("should detect 'Networking Academy'", () => {
    expect(isNetAcadPage("Networking Academy Quiz", undefined)).toBe(true);
  });

  it("should return false for non-NetAcad pages", () => {
    expect(isNetAcadPage("Math Quiz", "https://example.com/quiz")).toBe(false);
  });

  it("should return false for undefined/empty", () => {
    expect(isNetAcadPage(undefined, undefined)).toBe(false);
  });
});

describe("findMatchingQuestion (hybrid banks)", () => {
  beforeEach(() => {
    __resetQuestionBankCachesForTests();
    mockStorage.useMultiBank = true;
    vi.restoreAllMocks();
  });

  it("should prioritize primary bank when both have high-confidence matches", async () => {
    const primaryQuestion = "what protocol provides secure remote access to a switch";
    const primaryBank = {
      modules: {
        "1-4": {
          questions: [{
            text: primaryQuestion,
            textNormalized: normalizeForSearch(primaryQuestion),
            options: ["SSH", "Telnet"],
            correctAnswer: "SSH",
          }],
        },
      },
    };

    const secondaryBank = {
      modules: {
        "1-4": {
          questions: [{
            text: primaryQuestion,
            textNormalized: normalizeForSearch(primaryQuestion),
            options: ["SSH", "Telnet"],
            correctAnswer: "Telnet",
          }],
        },
      },
    };

    const fetchMock = vi.fn(async (input: string | URL | Request) => {
      const url = String(input);
      if (url.includes("questions-bank-ccnadesdecero.json")) {
        return { json: async () => secondaryBank };
      }
      return { json: async () => primaryBank };
    });

    vi.stubGlobal("fetch", fetchMock);

    const result = await findMatchingQuestion(
      primaryQuestion,
      "CCNA 2 - Module 1",
      "https://www.netacad.com/test",
    );

    expect(result).not.toBeNull();
    expect(result?.bankModel).toBe("questions-bank.json");
    expect(result?.correctAnswer).toBe("SSH");
  });

  it("should fallback to secondary bank when primary has no match", async () => {
    const secondaryQuestion = "which command shows vlan trunk details on a switch";
    const primaryBank = {
      modules: {
        "1-4": {
          questions: [{
            text: "unrelated question text",
            textNormalized: "unrelated question text",
            options: ["A"],
            correctAnswer: "A",
          }],
        },
      },
    };

    const secondaryBank = {
      modules: {
        "1-4": {
          questions: [{
            text: secondaryQuestion,
            textNormalized: normalizeForSearch(secondaryQuestion),
            options: ["show interfaces trunk"],
            correctAnswer: "show interfaces trunk",
          }],
        },
      },
    };

    const fetchMock = vi.fn(async (input: string | URL | Request) => {
      const url = String(input);
      if (url.includes("questions-bank-ccnadesdecero.json")) {
        return { json: async () => secondaryBank };
      }
      return { json: async () => primaryBank };
    });

    vi.stubGlobal("fetch", fetchMock);

    const result = await findMatchingQuestion(
      secondaryQuestion,
      "CCNA 2 - Module 1",
      "https://www.netacad.com/test",
    );

    expect(result).not.toBeNull();
    expect(result?.bankModel).toBe("questions-bank-ccnadesdecero.json");
    expect(result?.correctAnswer).toBe("show interfaces trunk");
  });

  it("should skip lookup for non-NetAcad pages", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    const result = await findMatchingQuestion(
      "sample question",
      "Some random quiz",
      "https://example.org/course",
    );

    expect(result).toBeNull();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("should mark duplicate as semantic-equivalent when answers only differ in wording", async () => {
    const duplicateQuestion = "que comando entra al modo de configuracion global";
    const primaryBank = {
      modules: {
        "1-4": {
          questions: [{
            text: duplicateQuestion,
            textNormalized: normalizeForSearch(duplicateQuestion),
            options: ["A"],
            correctAnswer: "Ingresa al modo de configuracion global",
          }],
        },
      },
    };

    const secondaryBank = {
      modules: {
        "1-4": {
          questions: [{
            text: duplicateQuestion,
            textNormalized: normalizeForSearch(duplicateQuestion),
            options: ["A"],
            correctAnswer: "Entra en el modo de configuracion global",
          }],
        },
      },
    };

    const fetchMock = vi.fn(async (input: string | URL | Request) => {
      const url = String(input);
      if (url.includes("questions-bank-ccnadesdecero.json")) {
        return { json: async () => secondaryBank };
      }
      return { json: async () => primaryBank };
    });

    vi.stubGlobal("fetch", fetchMock);

    const result = await findMatchingQuestion(
      duplicateQuestion,
      "CCNA 2 - Module 1",
      "https://www.netacad.com/test",
    );

    expect(result).not.toBeNull();
    expect(result?.bankConflictDetected).toBe(false);
    expect(result?.bankConflictType).toBe("semantic-equivalent");
    expect(result?.bankConflictAnswerSimilarity).toBeGreaterThanOrEqual(80);
  });

  it("should mark duplicate as real-conflict when answers are semantically different", async () => {
    const duplicateQuestion = "what protocol provides secure remote access to a switch";
    const primaryBank = {
      modules: {
        "1-4": {
          questions: [{
            text: duplicateQuestion,
            textNormalized: normalizeForSearch(duplicateQuestion),
            options: ["SSH", "Telnet"],
            correctAnswer: "SSH",
          }],
        },
      },
    };

    const secondaryBank = {
      modules: {
        "1-4": {
          questions: [{
            text: duplicateQuestion,
            textNormalized: normalizeForSearch(duplicateQuestion),
            options: ["SSH", "Telnet"],
            correctAnswer: "Telnet",
          }],
        },
      },
    };

    const fetchMock = vi.fn(async (input: string | URL | Request) => {
      const url = String(input);
      if (url.includes("questions-bank-ccnadesdecero.json")) {
        return { json: async () => secondaryBank };
      }
      return { json: async () => primaryBank };
    });

    vi.stubGlobal("fetch", fetchMock);

    const result = await findMatchingQuestion(
      duplicateQuestion,
      "CCNA 2 - Module 1",
      "https://www.netacad.com/test",
    );

    expect(result).not.toBeNull();
    expect(result?.bankModel).toBe("questions-bank.json");
    expect(result?.bankConflictDetected).toBe(true);
    expect(result?.bankConflictType).toBe("real-conflict");
    expect(result?.bankConflictAnswerSimilarity).toBeLessThan(80);
  });

  it("should skip secondary bank when useMultiBank is disabled", async () => {
    mockStorage.useMultiBank = false;

    const primaryQuestion = "which command shows vlan trunk details";
    const primaryBank = {
      modules: {
        "1-4": {
          questions: [{
            text: primaryQuestion,
            textNormalized: normalizeForSearch(primaryQuestion),
            options: ["show interfaces trunk"],
            correctAnswer: "show interfaces trunk",
          }],
        },
      },
    };

    const fetchMock = vi.fn(async () => ({ json: async () => primaryBank }));
    vi.stubGlobal("fetch", fetchMock);

    const result = await findMatchingQuestion(
      primaryQuestion,
      "CCNA 2 - Module 1",
      "https://www.netacad.com/test",
    );

    expect(result).not.toBeNull();
    expect(result?.bankModel).toBe("questions-bank.json");
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});
