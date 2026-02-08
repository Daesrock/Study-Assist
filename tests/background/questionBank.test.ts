/**
 * Tests for Question Bank Functions
 * Covers: normalizeForSearch, calculateSimilarity, isNetAcadPage, findMatchingQuestion
 */

import { describe, it, expect, beforeEach, vi } from "vitest";
import {
  normalizeForSearch,
  calculateSimilarity,
  isNetAcadPage,
} from "../../src/background/modules/questionBank";

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
