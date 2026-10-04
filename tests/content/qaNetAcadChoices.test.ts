import { beforeEach, describe, expect, it } from "vitest";

const { __testOnlyQA } = await import("../../src/content/content.js");
const { extractQuestionFromMcqView } = await import("../../src/content/modules/detection.js");
const { state } = await import("../../src/content/modules/state.js");

describe("QA NetAcad multiple-choice interactions", () => {
  beforeEach(() => {
    document.body.innerHTML = "";
    state.detectedQuestions = [];
    state.isActive = true;
    state.isDomainAllowed = true;
    state.settings.quickMode = true;
  });

  it.each([
    ["netacad-mcq", "qa-netacad-mcq", "¿Cuál capa del modelo OSI se encarga del enrutamiento?", ["Capa Física", "Capa de Enlace", "Capa de Red", "Capa de Aplicación"]],
    ["netacad-quiz", "qa-netacad-quiz-mcq", "¿Cuál capa del modelo OSI se encarga del enrutamiento lógico de paquetes?", ["Capa Física", "Capa de Enlace de Datos", "Capa de Red", "Capa de Transporte"]],
  ] as const)("adds accessible choices to %s without changing extracted content", (scenario, id, expectedText, expectedOptions) => {
    __testOnlyQA.injectQAScenario(scenario);

    const mcqView = document.querySelector<HTMLElement>(`#${id}`)!;
    const shadowRoot = mcqView.shadowRoot!;
    const radios = Array.from(shadowRoot.querySelectorAll<HTMLInputElement>("input[type=radio]"));
    const group = shadowRoot.querySelector<HTMLElement>("[role=radiogroup]")!;
    const detected = extractQuestionFromMcqView(mcqView, 1)!;

    expect(radios).toHaveLength(expectedOptions.length);
    expect(new Set(radios.map((radio) => radio.name)).size).toBe(1);
    expect(group.getAttribute("aria-labelledby")).toBe(shadowRoot.querySelector(".mcq__body-inner")?.id);
    expect(radios.every((radio) => radio.labels?.length === 1)).toBe(true);
    expect(detected.text).toBe(expectedText);
    expect(detected.options.map((option) => option.text)).toEqual(expectedOptions);
    expect(shadowRoot.querySelectorAll(".mcq__item-text-inner")).toHaveLength(expectedOptions.length);

    radios[1].focus();
    expect(shadowRoot.activeElement).toBe(radios[1]);
    radios[1].click();
    expect(radios[1].checked).toBe(true);
    expect(radios[1].closest(".mcq__item")?.classList.contains("is-selected")).toBe(true);
    radios[2].click();
    expect(radios[1].checked).toBe(false);
    expect(radios[2].checked).toBe(true);
    expect(Array.from(radios).filter((radio) => radio.checked)).toHaveLength(1);
    expect(extractQuestionFromMcqView(mcqView, 1)?.options.map((option) => option.text)).toEqual(expectedOptions);
  });

  it("keeps a quiz choice selected while navigating, and leaves matching unchanged", () => {
    __testOnlyQA.injectQAScenario("netacad-quiz");
    const mcqView = document.querySelector<HTMLElement>("#qa-netacad-quiz-mcq")!;
    const shadowRoot = mcqView.shadowRoot!;
    const radios = shadowRoot.querySelectorAll<HTMLInputElement>("input[type=radio]");
    const matchingView = document.querySelector<HTMLElement>("#qa-netacad-quiz-matching")!;

    radios[2].focus();
    expect(shadowRoot.activeElement).toBe(radios[2]);
    radios[2].click();
    expect(radios[2].checked).toBe(true);

    document.querySelector<HTMLButtonElement>("#qa-nav-next")!.click();
    expect(document.querySelector<HTMLElement>('[data-slide="0"]')!.style.display).toBe("none");
    expect(radios[2].checked).toBe(true);
    expect(matchingView.shadowRoot?.querySelector("input[type=radio]")).toBeNull();

    document.querySelector<HTMLButtonElement>("#qa-nav-prev")!.click();
    expect(radios[2].checked).toBe(true);
    expect(document.querySelector("#study-assist-qa-sandbox .qa-feedback")).toBeNull();
  });

  it("keeps only concise quick-mode guidance and removes duplicate QA headings", () => {
    __testOnlyQA.injectQAScenario("netacad-quiz");

    const sandbox = document.querySelector<HTMLElement>("#study-assist-qa-sandbox")!;
    expect(sandbox.querySelector("h2")).toBeNull();
    expect(sandbox.textContent).not.toContain("netacad-quiz");
    expect(sandbox.querySelector(".qa-meta")?.textContent).toContain("SHIFT para analizar");
    expect(sandbox.querySelector(".qa-meta")?.textContent).toContain("ALT+W para re-detectar");
    expect(sandbox.querySelector(".qa-quiz-platform")?.textContent).toContain("NetAcad — Quiz Real");
    expect(sandbox.querySelector('[data-slide="0"] .qa-question-title')).toBeNull();

    sandbox.remove();
    state.settings.quickMode = false;
    __testOnlyQA.injectQAScenario("netacad-quiz");
    const streamingSandbox = document.querySelector<HTMLElement>("#study-assist-qa-sandbox")!;
    expect(streamingSandbox.querySelector(".qa-meta")).toBeNull();
    expect(streamingSandbox.textContent).not.toContain("Clic en una pregunta");
    expect(streamingSandbox.textContent).not.toContain("SHIFT para analizar");
  });
});
