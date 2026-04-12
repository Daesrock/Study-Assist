/**
 * CCNADesdeCero Scraper (Interactive)
 *
 * Extrae preguntas de ccnadesdecero.es para CCNA2.
 * Este sitio revela la respuesta correcta solo despues de seleccionar una opcion,
 * asi que usa navegacion real con Puppeteer y clic automatico por pregunta.
 *
 * Uso:
 *   node scrape-ccnadesdecero.js
 *   node scrape-ccnadesdecero.js --test
 *   node scrape-ccnadesdecero.js --url <URL> --module <RANGO>
 *   node scrape-ccnadesdecero.js --output ../data/questions-bank-ccna2.json
 */

import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const USER_AGENT =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/123.0.0.0 Safari/537.36";

const CCNADESDECERO_URLS = [
  {
    moduleRange: "1-4",
    title: "Conceptos de conmutacion, VLAN y enrutamiento entre VLAN",
    url: "https://ccnadesdecero.es/ccna2-v7-srwe-modulos-1-4-respuestas/",
  },
  {
    moduleRange: "5-6",
    title: "Redes redundantes",
    url: "https://ccnadesdecero.es/ccna2-v7-srwe-modulos-5-6-respuestas/",
  },
  {
    moduleRange: "7-9",
    title: "Redes disponibles y confiables",
    url: "https://ccnadesdecero.es/ccna2-v7-srwe-modulos-7-9-respuestas/",
  },
  {
    moduleRange: "10-13",
    title: "Seguridad L2 y WLAN",
    url: "https://ccnadesdecero.es/ccna2-v7-srwe-modulos-10-13-respuestas/",
  },
  {
    moduleRange: "14-16",
    title: "Conceptos de enrutamiento y configuracion",
    url: "https://ccnadesdecero.es/ccna2-v7-srwe-modulos-14-16-respuestas/",
  },
  {
    moduleRange: "final-practice",
    title: "Examen final de practica SRWE",
    url: "https://ccnadesdecero.es/ccna2-v7-srwe-practica-final-respuestas/",
  },
  {
    moduleRange: "final-exam",
    title: "Examen final de SRWE",
    url: "https://ccnadesdecero.es/ccna2-v7-srwe-examen-final-respuestas/",
  },
];

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function normalizeText(text) {
  return (text || "")
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[\u200B-\u200D\uFEFF]/g, "")
    .replace(/[¿?¡!.,;:()"'\-]/g, "")
    .replace(/\//g, "")
    .replace(/\s+/g, " ")
    .trim();
}

function parseArgs(argv) {
  const args = {
    isTestMode: argv.includes("--test"),
    url: null,
    moduleRange: null,
    output: null,
    headful: argv.includes("--headful"),
  };

  for (let i = 0; i < argv.length; i++) {
    const t = argv[i];
    if (t === "--url" && argv[i + 1]) {
      args.url = argv[i + 1];
      i++;
    } else if (t === "--module" && argv[i + 1]) {
      args.moduleRange = argv[i + 1];
      i++;
    } else if (t === "--output" && argv[i + 1]) {
      args.output = argv[i + 1];
      i++;
    }
  }

  return args;
}

function inferModuleRangeFromUrl(url) {
  const m = url.match(/modulos?-([0-9]+-[0-9]+)/i);
  if (m) return m[1];
  if (/practica-final/i.test(url)) return "final-practice";
  if (/examen-final/i.test(url)) return "final-exam";
  return "custom";
}

async function loadPuppeteer() {
  try {
    const mod = await import("puppeteer");
    return mod.default;
  } catch {
    throw new Error(
      "Puppeteer no esta instalado. Ejecuta: cd scripts && npm install",
    );
  }
}

async function scrapeInteractivePage({
  url,
  moduleRange,
  title,
  puppeteer,
  headful,
}) {
  const browser = await puppeteer.launch({
    headless: headful ? false : "new",
    defaultViewport: { width: 1366, height: 900 },
  });

  try {
    const page = await browser.newPage();
    await page.setUserAgent(USER_AGENT);
    await page.goto(url, { waitUntil: "domcontentloaded", timeout: 120000 });

    await page.waitForSelector(".wq_singleQuestionCtr", { timeout: 45000 });

    // Fuerza carga de bloques diferidos al recorrer la pagina.
    await page.evaluate(async () => {
      const wait = (ms) => new Promise((r) => setTimeout(r, ms));
      for (let i = 0; i < 8; i++) {
        window.scrollTo(0, document.body.scrollHeight);
        await wait(250);
      }
      window.scrollTo(0, 0);
    });

    const raw = await page.evaluate(async () => {
      const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
      const blocks = Array.from(
        document.querySelectorAll(".wq_singleQuestionCtr"),
      );
      const out = [];

      for (let index = 0; index < blocks.length; index++) {
        const block = blocks[index];
        const questionText =
          block.querySelector(".wq_questionTextCtr h4")?.textContent?.trim() ||
          "";

        const optionsNodes = Array.from(
          block.querySelectorAll(".wq_singleAnswerCtr"),
        );

        if (!questionText || optionsNodes.length < 2) {
          continue;
        }

        const getCorrectNodes = () =>
          optionsNodes.filter((n) => n.classList.contains("wq_correctAnswer"));

        const revealCorrect = async () => {
          for (let i = 0; i < optionsNodes.length; i++) {
            optionsNodes[i].click();
            for (let t = 0; t < 12; t++) {
              if (getCorrectNodes().length > 0) {
                return true;
              }
              await wait(120);
            }
          }
          return false;
        };

        if (getCorrectNodes().length === 0) {
          await revealCorrect();
        }

        const options = optionsNodes
          .map(
            (n) =>
              n.querySelector(".wq_answerTxtCtr")?.textContent?.trim() || "",
          )
          .filter(Boolean);

        const correctAnswers = getCorrectNodes()
          .map(
            (n) =>
              n.querySelector(".wq_answerTxtCtr")?.textContent?.trim() || "",
          )
          .filter(Boolean);

        const explanationRaw =
          block
            .querySelector(".wq_QuestionExplanationText")
            ?.textContent?.trim() || "";
        const explanation = explanationRaw
          .replace(/^Explicacion:\s*/i, "")
          .replace(/^Explicaci[oó]n:\s*/i, "")
          .trim();

        out.push({
          questionNumber: index + 1,
          text: questionText,
          options,
          correctAnswers,
          explanation,
        });
      }

      return out;
    });

    const questions = raw.map((q) => {
      const id = `${moduleRange}_${String(q.questionNumber).padStart(3, "0")}`;
      const item = {
        id,
        text: q.text,
        textNormalized: normalizeText(q.text),
        options: q.options,
        explanation: q.explanation,
      };

      if (q.correctAnswers.length === 1) {
        item.correctAnswer = q.correctAnswers[0];
      } else if (q.correctAnswers.length > 1) {
        item.correctAnswers = q.correctAnswers;
      }

      return item;
    });

    return {
      moduleRange,
      title,
      url,
      questionCount: questions.length,
      questions,
    };
  } finally {
    await browser.close();
  }
}

async function main() {
  const args = parseArgs(process.argv.slice(2));

  const urlsToProcess = args.url
    ? [
        {
          moduleRange: args.moduleRange || inferModuleRangeFromUrl(args.url),
          title: "URL personalizada",
          url: args.url,
        },
      ]
    : args.isTestMode
      ? [CCNADESDECERO_URLS[0]]
      : CCNADESDECERO_URLS;

  const outputPath = args.output
    ? path.isAbsolute(args.output)
      ? args.output
      : path.join(__dirname, args.output)
    : path.join(__dirname, "..", "data", "questions-bank-ccnadesdecero.json");

  console.log("╔══════════════════════════════════════════════════════╗");
  console.log("║   CCNADesdeCero Scraper - CCNA2 (Interactive Mode)   ║");
  console.log("╚══════════════════════════════════════════════════════╝");
  console.log();

  if (args.isTestMode) {
    console.log("MODO TEST: solo se procesara la primera URL\n");
  }

  const puppeteer = await loadPuppeteer();

  const bank = {
    version: "1.0",
    generated: new Date().toISOString(),
    source: "ccnadesdecero.es",
    course: "CCNA 2 - SRWE",
    modules: {},
  };

  let totalQuestions = 0;

  for (let i = 0; i < urlsToProcess.length; i++) {
    const current = urlsToProcess[i];
    console.log(
      `[${i + 1}/${urlsToProcess.length}] Procesando: ${current.title}`,
    );
    console.log(`  URL: ${current.url}`);

    try {
      const result = await scrapeInteractivePage({
        ...current,
        puppeteer,
        headful: args.headful,
      });

      bank.modules[current.moduleRange] = result;
      totalQuestions += result.questionCount;

      console.log(`  Preguntas extraidas: ${result.questionCount}`);

      if (i < urlsToProcess.length - 1) {
        console.log("  Esperando 2 segundos...\n");
        await sleep(2000);
      }
    } catch (error) {
      console.log(`  Error: ${error.message}`);
      bank.modules[current.moduleRange] = {
        url: current.url,
        title: current.title,
        error: error.message,
        questionCount: 0,
        questions: [],
      };
    }
  }

  fs.mkdirSync(path.dirname(outputPath), { recursive: true });
  fs.writeFileSync(outputPath, JSON.stringify(bank, null, 2), "utf-8");

  console.log("\n══════════════════════════════════════════════════════");
  console.log(`Banco generado: ${outputPath}`);
  console.log(`Total de preguntas: ${totalQuestions}`);
  console.log(`Modulos procesados: ${Object.keys(bank.modules).length}`);
  console.log("══════════════════════════════════════════════════════\n");

  console.log("Resumen por modulo:");
  for (const [range, mod] of Object.entries(bank.modules)) {
    const status = mod.error ? "ERR" : "OK";
    console.log(
      `  ${status} ${range}: ${mod.questionCount} preguntas - ${mod.title}`,
    );
  }
}

main().catch((error) => {
  console.error("Error fatal:", error);
  process.exit(1);
});
