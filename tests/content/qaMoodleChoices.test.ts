import { beforeEach, describe, expect, it } from "vitest";

const { __testOnlyQA } = await import("../../src/content/content.js");
const { detectMoodleQuestions } = await import("../../src/content/modules/detection.js");
const { state } = await import("../../src/content/modules/state.js");

describe("QA Moodle multiple-choice interactions", () => {
  beforeEach(() => {
    document.body.innerHTML = "";
    state.detectedQuestions = [];
    state.isActive = true;
    state.isDomainAllowed = true;
    state.settings.quickMode = true;
  });

  it.each([
    ["moodle-mcq", 1],
    ["moodle-quiz", 1],
    ["moodle-multi", 2],
  ] as const)("adds labeled single-choice controls to %s without changing detection", async (scenario, expectedQuestions) => {
    __testOnlyQA.injectQAScenario(scenario);

    const questions = Array.from(document.querySelectorAll<HTMLElement>("#study-assist-qa-sandbox .que.multichoice"));
    expect(questions).toHaveLength(expectedQuestions);
    for (const [index, question] of questions.entries()) {
      const radios = Array.from(question.querySelectorAll<HTMLInputElement>("input[type=radio]"));
      expect(radios.length).toBeGreaterThanOrEqual(2);
      expect(new Set(radios.map((radio) => radio.name)).size).toBe(1);
      expect(question.querySelector(".answer")?.getAttribute("role")).toBe("radiogroup");
      expect(question.querySelector(".answer")?.getAttribute("aria-labelledby")).toBeTruthy();
      expect(radios.every((radio) => radio.labels?.length === 1)).toBe(true);
      expect(new Set(radios.map((radio) => radio.id)).size).toBe(radios.length);
      expect(questions[index].querySelectorAll(".answernumber")).toHaveLength(radios.length);
    }

    await detectMoodleQuestions();
    const detectedMcq = state.detectedQuestions.filter((question) => question.type === "multiple-choice");
    expect(detectedMcq).toHaveLength(expectedQuestions);
    expect(detectedMcq[0].options.map((option) => option.text)).toEqual(
      scenario === "moodle-mcq" || scenario === "moodle-quiz"
        ? ["HTTP", "HTTPS", "FTP", "Telnet"]
        : ["Base de datos", "Seguridad Informatica", "Derecho Informatico", "Auditoria Informatica"],
    );
    if (scenario === "moodle-multi") {
      expect(detectedMcq[1].options.map((option) => option.text)).toEqual([
        "Verificar", "Hacer", "Actuar", "Planificar",
      ]);
    }
  });

  it("keeps groups independent and selection through quiz navigation without grading", () => {
    __testOnlyQA.injectQAScenario("moodle-quiz");
    const slides = document.querySelectorAll<HTMLElement>("#study-assist-qa-sandbox .qa-slide");
    const firstQuestion = slides[0].querySelector<HTMLElement>(".que.multichoice")!;
    const radios = firstQuestion.querySelectorAll<HTMLInputElement>("input[type=radio]");
    radios[1].focus();
    expect(document.activeElement).toBe(radios[1]);
    radios[1].click();
    expect(radios[1].checked).toBe(true);
    expect(radios[1].closest(".qa-moodle-mcq-option")?.classList.contains("is-selected")).toBe(true);

    document.querySelector<HTMLButtonElement>("#qa-nav-next")!.click();
    expect(slides[0].style.display).toBe("none");
    expect(radios[1].checked).toBe(true);
    document.querySelector<HTMLButtonElement>("#qa-nav-prev")!.click();
    expect(radios[1].checked).toBe(true);
    expect(document.querySelector("#study-assist-qa-sandbox .qa-feedback")).toBeNull();
  });

  it("allows one selection per question while preserving choices in other questions", () => {
    __testOnlyQA.injectQAScenario("moodle-multi");
    const questions = document.querySelectorAll<HTMLElement>("#study-assist-qa-sandbox .que.multichoice");
    const first = questions[0].querySelectorAll<HTMLInputElement>("input[type=radio]");
    const second = questions[1].querySelectorAll<HTMLInputElement>("input[type=radio]");

    first[0].click();
    second[1].click();
    expect(first[0].checked).toBe(true);
    expect(second[1].checked).toBe(true);
    first[2].click();
    expect(first[0].checked).toBe(false);
    expect(first[2].checked).toBe(true);
    expect(second[1].checked).toBe(true);
  });
});
