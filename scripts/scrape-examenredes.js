/**
 * ExamenRedes Scraper
 * Extrae preguntas y explicaciones de examenredes.com usando fetch + cheerio
 *
 * Uso:
 *   node scrape-examenredes.js          # Scrapea todas las URLs
 *   node scrape-examenredes.js --test   # Scrapea solo la primera URL (para probar)
 */

import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import * as cheerio from "cheerio";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// ============================================
// Configuración
// ============================================
const USER_AGENT =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36";

// URLs de ExamenRedes para CCNA 2
const EXAMENREDES_URLS = [
  // Exámenes por grupo de módulos
  {
    moduleRange: "1-4",
    title: "Conceptos de conmutación, VLAN y enrutamiento entre VLAN",
    url: "https://examenredes.com/modulos-1-4-examen-de-conceptos-de-conmutacion-vlan-y-enrutamiento-entre-vlan-respuestas/",
  },
  {
    moduleRange: "5-6",
    title: "Redes redundantes",
    url: "https://examenredes.com/modulos-5-6-examen-de-redes-redundantes-respuestas/",
  },
  {
    moduleRange: "7-9",
    title: "Redes disponibles y confiables",
    url: "https://examenredes.com/modulos-7-9-examen-de-redes-disponibles-y-confiables-respuestas/",
  },
  {
    moduleRange: "10-13",
    title: "Seguridad L2 y WLAN",
    url: "https://examenredes.com/modulos-10-13-examen-de-seguridad-l2-y-wlan-respuestas/",
  },
  {
    moduleRange: "14-16",
    title: "Conceptos de enrutamiento y configuración",
    url: "https://examenredes.com/modulos-14-16-conceptos-de-enrutamiento-y-examen-de-configuracion-respuestas/",
  },
  {
    moduleRange: "14-16",
    title: "Conceptos de enrutamiento y configuración",
    url: "https://examenredes.com/modulos-14-16-conceptos-de-enrutamiento-y-examen-de-configuracion-respuestas/",
  },
  // Pruebas individuales por módulo
  {
    moduleRange: "mod-1",
    title: "Prueba del Módulo 1 - Configuración básica del dispositivo",
    url: "https://examenredes.com/prueba-del-modulo-1-configuracion-basica-del-dispositivo/",
  },
  {
    moduleRange: "mod-2",
    title: "Prueba del Módulo 2 - Conceptos de switches",
    url: "https://examenredes.com/prueba-del-modulo-2-conceptos-de-switches/",
  },
  {
    moduleRange: "mod-3",
    title: "Prueba del Módulo 3 - VLAN",
    url: "https://examenredes.com/prueba-del-modulo-3-vlan/",
  },
  {
    moduleRange: "mod-4",
    title: "Prueba del Módulo 4 - Inter-VLAN Routing",
    url: "https://examenredes.com/prueba-del-modulo-4-inter-vlan-routing/",
  },
  {
    moduleRange: "mod-5",
    title: "Prueba del Módulo 5 - STP",
    url: "https://examenredes.com/prueba-del-modulo-5-stp/",
  },
  {
    moduleRange: "mod-6",
    title: "Prueba del Módulo 6 - EtherChannel",
    url: "https://examenredes.com/prueba-del-modulo-6-etherchannel/",
  },
  {
    moduleRange: "mod-7",
    title: "Prueba del Módulo 7 - DHCPv4",
    url: "https://examenredes.com/prueba-del-modulo-7-dhcpv4/",
  },
  {
    moduleRange: "mod-8",
    title: "Prueba del Módulo 8 - SLAAC y DHCPv6",
    url: "https://examenredes.com/prueba-del-modulo-8-slaac-y-dhcpv6/",
  },
  {
    moduleRange: "mod-9",
    title: "Prueba del Módulo 9 - Conceptos de FHRP",
    url: "https://examenredes.com/prueba-del-modulo-9-conceptos-de-fhrp/",
  },
  {
    moduleRange: "mod-10",
    title: "Prueba del Módulo 10 - Conceptos de seguridad de LAN",
    url: "https://examenredes.com/prueba-del-modulo-10-conceptos-de-seguridad-de-lan/",
  },
  {
    moduleRange: "mod-11",
    title: "Prueba del Módulo 11 - Configuraciones de seguridad del switch",
    url: "https://examenredes.com/prueba-del-modulo-11-configuraciones-de-seguridad-del-switch/",
  },
  {
    moduleRange: "mod-12",
    title: "Prueba del Módulo 12 - Conceptos WLAN",
    url: "https://examenredes.com/prueba-del-modulo-12-conceptos-wlan/",
  },
  {
    moduleRange: "mod-13",
    title: "Prueba del Módulo 13 - Configuraciones de WLAN",
    url: "https://examenredes.com/prueba-del-modulo-13-configuracion-wlan/",
  },
  {
    moduleRange: "mod-14",
    title: "Prueba del Módulo 14 - Conceptos de routers",
    url: "https://examenredes.com/prueba-del-modulo-14-conceptos-de-routers/",
  },
  {
    moduleRange: "mod-15",
    title: "Prueba del Módulo 15 - Rutas IP estáticas",
    url: "https://examenredes.com/prueba-del-modulo-15-enrutamiento-estatico-ip/",
  },
  {
    moduleRange: "mod-16",
    title: "Prueba del Módulo 16 - Resuelve problemas de rutas",
    url: "https://examenredes.com/prueba-del-modulo-16-solucion-de-problemas-de-rutas-estaticas-y-predeterminadas/",
  },
  // Evaluaciones PTSA
  {
    moduleRange: "ptsa-1",
    title: "Evaluación de habilidades prácticas PT (Parte 1)",
    url: "https://examenredes.com/evaluacion-de-habilidades-practicas-de-pt-ptsa-srwe-parte-1-respuestas/",
  },
  {
    moduleRange: "ptsa-2",
    title: "Evaluación de habilidades prácticas PT (Parte 2)",
    url: "https://examenredes.com/evaluacion-de-habilidades-practicas-de-pt-ptsa-srwe-parte-2-respuestas/",
  },
  // Exámenes finales
  {
    moduleRange: "final-practice",
    title: "Examen final de práctica SRWE",
    url: "https://examenredes.com/examen-final-de-practica-srwe-preguntas-y-respuestas/",
  },
  {
    moduleRange: "final-skills",
    title: "Examen final de habilidades SRWE PTSA",
    url: "https://examenredes.com/ccna-2-examen-final-de-habilidades-srwe-ptsa-respuestas/",
  },
  {
    moduleRange: "final-exam",
    title: "Examen final de SRWE",
    url: "https://examenredes.com/ccna-2-v7-examen-final-de-srwe-preguntas-y-respuestas/",
  },
];

// ============================================
// Funciones de utilidad
// ============================================

/**
 * Normaliza texto para búsqueda (quita tildes, minúsculas, sin signos)
 */
function normalizeText(text) {
  return text
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "") // Quitar tildes
    .replace(/[\u200B-\u200D\uFEFF]/g, "") // Zero-width spaces
    .replace(/[¿?¡!.,;:()"\-]/g, "") // Quitar signos de puntuación
    .replace(/\//g, "") // Quitar slashes (para nombres de interfaces como 0/1)
    .replace(/\s+/g, " ") // Normalizar espacios
    .trim();
}

/**
 * Esperar X milisegundos
 */
function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// ============================================
// Scraping con fetch + cheerio
// ============================================

/**
 * Scrapea una URL usando fetch directo
 */
async function scrapeUrl(url) {
  console.log(`  Descargando HTML...`);

  const response = await fetch(url, {
    headers: {
      "User-Agent": USER_AGENT,
    },
  });

  if (!response.ok) {
    throw new Error(`HTTP error: ${response.status} ${response.statusText}`);
  }

  const html = await response.text();
  return html;
}

// ============================================
// Parser de preguntas con cheerio
// ============================================

/**
 * Extrae preguntas del HTML usando cheerio
 */
function parseQuestions(html, moduleRange) {
  const $ = cheerio.load(html);
  const questions = [];

  // Las preguntas están en <p><strong>NÚMERO. Texto?</strong></p> o <p><b>NÚMERO. Texto?</b></p>
  // IMPORTANTE: Puede haber múltiples <strong>/<b> dentro del mismo <p>
  // Algunos tienen prefijo _ antes del número (ej: _33. o 174.)
  const processedQuestions = new Set();

  // Buscar tanto <strong> como <b>
  $("p strong, p b").each((index, element) => {
    const $tag = $(element);
    const firstText = $tag.text().trim();

    // Verificar si este tag tiene número al inicio (con o sin prefijo _)
    const match = firstText.match(/^_?(\d+)\.\s+/);
    if (!match) return;

    const questionNumber = parseInt(match[1]);

    // Evitar procesar la misma pregunta dos veces
    if (processedQuestions.has(questionNumber)) return;
    processedQuestions.add(questionNumber);

    // Obtener el <p> padre y extraer TODO el texto de todos los <strong> y <b> dentro
    const $p = $tag.parent();
    const allTexts = [];

    $p.find("strong, b").each((i, el) => {
      const text = $(el).text().trim();
      if (text) {
        allTexts.push(text);
      }
    });

    // Unir todos los textos de <strong>/<b> y quitar el número inicial (con o sin prefijo _)
    const fullText = allTexts.join("\n").trim();
    const questionMatch = fullText.match(/^_?\d+\.\s+(.+)/s);
    if (!questionMatch) return;

    let questionText = questionMatch[1].trim();

    if (!questionText || questionText.length < 10) return;

    // Buscar la lista de opciones después de este <p> y capturar contexto adicional
    let $current = $p;
    let $ul = null;
    const contextParts = [questionText]; // Iniciar con el texto base de la pregunta

    // Buscar el siguiente <ul> (puede haber otros elementos en medio con contexto)
    while ($current.length && !$ul) {
      $current = $current.next();
      if ($current.is("ul")) {
        $ul = $current;
        break;
      }

      // Capturar contexto adicional de elementos entre la pregunta y las opciones
      if ($current.is("pre")) {
        // Capturar código/comandos en <pre>
        const preText = $current.text().trim();
        if (preText) {
          contextParts.push(preText);
        }
      } else if ($current.is("p")) {
        // Capturar texto adicional de <p><strong> o <p><b> sin número de pregunta
        const $strongOrB = $current.find("strong, b");
        if ($strongOrB.length > 0) {
          const pText = $current.text().trim();
          // Si tiene número al inicio, es una nueva pregunta - detener
          if (/^_?\d+\./.test(pText)) {
            break;
          }
          // Si no tiene número, es parte de la pregunta actual
          if (pText) {
            contextParts.push(pText);
          }
        }
      }
      // Ignorar otros elementos como <div>, <span>, etc.
    }

    // Unir todas las partes de la pregunta con saltos de línea
    questionText = contextParts.join("\n").trim();

    // Extraer opciones
    const options = [];
    const correctAnswers = [];
    let $afterOptions; // Elemento después de las opciones (para buscar explicación)

    if ($ul) {
      // === Formato estándar: opciones en <ul><li> ===
      $ul.find("li").each((i, li) => {
        const $li = $(li);
        const optionText = $li.text().trim();

        if (optionText) {
          options.push(optionText);

          // Verificar si es la respuesta correcta
          if ($li.hasClass("correct_answer")) {
            correctAnswers.push(optionText);
          }
        }
      });
      $afterOptions = $ul;
    } else {
      // === Formato alternativo: opciones en bloques <p> (command-block questions) ===
      // Cuando no hay <ul>, las opciones están en <p> entre la pregunta y la explicación.
      // Las respuestas correctas tienen <span class="correct_answer"> dentro del <p>.
      let $scan = $tag.parent().next();

      while ($scan.length) {
        // Detener si encontramos la siguiente pregunta (strong o b con número)
        if (
          $scan.is("p") &&
          ($scan.find("strong").length > 0 || $scan.find("b").length > 0) &&
          /^_?\d+\.\s/.test($scan.text().trim())
        ) {
          break;
        }

        // Detener si encontramos la caja de explicación
        if ($scan.hasClass("box") || $scan.find(".box").length > 0) {
          break;
        }

        // Saltar figuras/imágenes
        if ($scan.is("figure")) {
          $scan = $scan.next();
          continue;
        }

        // Cada <p> con texto es una opción
        if ($scan.is("p")) {
          const optionText = $scan.text().trim();
          if (optionText && optionText.length > 0) {
            options.push(optionText);

            // Si contiene <span class="correct_answer">, es la respuesta correcta
            if ($scan.find("span.correct_answer").length > 0) {
              correctAnswers.push(optionText);
            }
          }
        }

        $afterOptions = $scan;
        $scan = $scan.next();
      }
    }

    // Solo agregar si tiene al menos 2 opciones
    if (options.length < 2) return;

    // Buscar explicación (siguiente elemento después de las opciones)
    let explanation = "";
    let $next = $afterOptions ? $afterOptions.next() : null;

    while ($next && $next.length) {
      const nextText = $next.text().trim();

      // Detener si encontramos la siguiente pregunta (strong o b con número)
      if (
        ($next.find("strong").length > 0 || $next.find("b").length > 0) &&
        /^_?\d+\./.test(nextText)
      ) {
        break;
      }

      // Si encontramos "Explique" o "Explicación"
      if (/Expli(?:que|cación)/i.test(nextText)) {
        explanation = nextText.replace(/Expli(?:que|cación)[:\s]*/i, "").trim();
        break;
      }

      $next = $next.next();
    }

    const id = `${moduleRange}_${String(questionNumber).padStart(3, "0")}`;

    const question = {
      id,
      text: questionText,
      textNormalized: normalizeText(questionText),
      options,
      explanation,
    };

    // Agregar correctAnswer(s) solo si se encontraron
    if (correctAnswers.length === 1) {
      question.correctAnswer = correctAnswers[0];
    } else if (correctAnswers.length > 1) {
      question.correctAnswers = correctAnswers;
    }

    questions.push(question);
  });

  return questions;
}

// ============================================
// Main
// ============================================

async function main() {
  const args = process.argv.slice(2);
  const isTestMode = args.includes("--test");

  console.log("╔════════════════════════════════════════════════════════╗");
  console.log("║       ExamenRedes Scraper - CCNA 2 Question Bank       ║");
  console.log("╚════════════════════════════════════════════════════════╝");
  console.log();

  const urlsToProcess = isTestMode ? [EXAMENREDES_URLS[0]] : EXAMENREDES_URLS;

  if (isTestMode) {
    console.log("MODO TEST: Solo se procesará la primera URL\n");
  }

  const questionsBank = {
    version: "1.0",
    generated: new Date().toISOString(),
    source: "examenredes.com",
    course: "CCNA 2 - SRWE",
    modules: {},
  };

  let totalQuestions = 0;

  for (let i = 0; i < urlsToProcess.length; i++) {
    const { moduleRange, title, url } = urlsToProcess[i];

    console.log(`[${i + 1}/${urlsToProcess.length}] Procesando: ${title}`);
    console.log(`  URL: ${url}`);

    try {
      // Scrapear la URL
      const html = await scrapeUrl(url);

      console.log(`  HTML recibido: ${html.length} caracteres`);

      // Guardar HTML para debug (solo en modo test)
      if (isTestMode) {
        const debugPath = path.join(
          __dirname,
          "..",
          "data",
          `debug-${moduleRange}-raw.html`,
        );
        fs.mkdirSync(path.dirname(debugPath), { recursive: true });
        fs.writeFileSync(debugPath, html, "utf-8");
        console.log(`  HTML guardado en: debug-${moduleRange}-raw.html`);
      }

      // Parsear preguntas
      const questions = parseQuestions(html, moduleRange);

      console.log(`  Preguntas extraídas: ${questions.length}`);

      // Agregar al banco
      questionsBank.modules[moduleRange] = {
        url,
        title,
        questionCount: questions.length,
        questions,
      };

      totalQuestions += questions.length;

      // Esperar entre requests para no saturar la API
      if (i < urlsToProcess.length - 1) {
        console.log(`  Esperando 2 segundos...\n`);
        await sleep(2000);
      }
    } catch (error) {
      console.log(`  Error: ${error.message}`);
      questionsBank.modules[moduleRange] = {
        url,
        title,
        error: error.message,
        questionCount: 0,
        questions: [],
      };
    }
  }

  // Guardar el banco de preguntas
  const outputPath = path.join(__dirname, "..", "data", "questions-bank.json");
  fs.mkdirSync(path.dirname(outputPath), { recursive: true });
  fs.writeFileSync(outputPath, JSON.stringify(questionsBank, null, 2), "utf-8");

  console.log("\n════════════════════════════════════════════════════════");
  console.log(`Banco de preguntas generado: data/questions-bank.json`);
  console.log(`Total de preguntas: ${totalQuestions}`);
  console.log(
    `Módulos procesados: ${Object.keys(questionsBank.modules).length}`,
  );
  console.log("════════════════════════════════════════════════════════\n");

  // Mostrar resumen por módulo
  console.log("Resumen por módulo:");
  for (const [range, module] of Object.entries(questionsBank.modules)) {
    const status = module.error ? "ERR" : "OK";
    console.log(
      `  ${status} ${range}: ${module.questionCount} preguntas - ${module.title}`,
    );
  }
}

main().catch((error) => {
  console.error("Error fatal:", error);
  process.exit(1);
});
