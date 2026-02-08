/**
 * ExamenRedes Scraper
 * Extrae preguntas y explicaciones de examenredes.com usando Serper API
 *
 * Uso:
 *   node scrape-examenredes.js          # Scrapea todas las URLs
 *   node scrape-examenredes.js --test   # Scrapea solo la primera URL (para probar)
 */

import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// ============================================
// Configuración
// ============================================
const SERPER_API_KEY = "";
const SERPER_API_URL = "https://scrape.serper.dev";

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
    url: "https://examenredes.com/prueba-del-modulo-13-configuraciones-de-wlan/",
  },
  {
    moduleRange: "mod-14",
    title: "Prueba del Módulo 14 - Conceptos de routers",
    url: "https://examenredes.com/prueba-del-modulo-14-conceptos-de-routers/",
  },
  {
    moduleRange: "mod-15",
    title: "Prueba del Módulo 15 - Rutas IP estáticas",
    url: "https://examenredes.com/prueba-del-modulo-15-rutas-ip-estaticas/",
  },
  {
    moduleRange: "mod-16",
    title: "Prueba del Módulo 16 - Resuelve problemas de rutas",
    url: "https://examenredes.com/prueba-del-modulo-16-resuelve-problemas-de-rutas/",
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
    .replace(/[¿?¡!.,;:()"\-]/g, "") // Quitar signos de puntuación
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
// Serper API
// ============================================

/**
 * Scrapea una URL usando Serper API
 */
async function scrapeUrl(url) {
  console.log(`  📡 Llamando Serper API...`);

  const response = await fetch(SERPER_API_URL, {
    method: "POST",
    headers: {
      "X-API-KEY": SERPER_API_KEY,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      url,
      includeMarkdown: true, // Incluir markdown para detectar imágenes
    }),
  });

  if (!response.ok) {
    throw new Error(
      `Serper API error: ${response.status} ${response.statusText}`,
    );
  }

  const text = await response.text();
  return text;
}

// ============================================
// Parser de preguntas
// ============================================

/**
 * Extrae preguntas del texto scrapeado
 */
function parseQuestions(rawText, moduleRange) {
  const questions = [];

  // IMPORTANTE: El texto viene con \n como caracteres literales (escapados)
  // Necesitamos convertirlos a saltos de línea reales
  let text = rawText
    .replace(/\\n/g, "\n") // Convertir \n literal a salto de línea real
    .replace(/\\t/g, "\t") // Convertir \t literal a tab real
    .replace(/\\"/g, '"'); // Convertir \" a comilla real

  // Limpiar metadata JSON que viene al final del response de Serper
  // Buscar patrones como: ","markdown":" o ","metadata":{
  const metadataIndex = text.search(/","(markdown|metadata)":/);
  if (metadataIndex > 0) {
    text = text.substring(0, metadataIndex);
  }

  // Dividir el texto por números de pregunta (ej: "1. ", "2. ", etc.)
  // El patrón busca un salto de línea seguido de número + punto + espacio + texto de pregunta (con ¿ o mayúscula)
  // Esto evita dividir en listas numeradas dentro de explicaciones (1.-, 2.-, etc.)
  const questionBlocks = text.split(/\n(?=\d+\.\s+[¿A-Z])/);

  let questionNumber = 0;

  for (const block of questionBlocks) {
    // Verificar que es un bloque de pregunta válido (empieza con número)
    const questionMatch = block.match(/^(\d+)\.\s+(.+?\?)/s);
    if (!questionMatch) continue;

    questionNumber++;
    const questionText = questionMatch[2].replace(/\n/g, " ").trim();

    // Extraer opciones (líneas que empiezan con * o -)
    const optionsMatch = block.match(/(?:^|\n)\s*[\*\-]\s+(.+?)(?=\n|$)/g);
    const options = optionsMatch
      ? optionsMatch.map((opt) => opt.replace(/^\s*[\*\-]\s+/, "").trim())
      : [];

    // Extraer explicación - buscar desde "Explique:" hasta el final del bloque
    // No cortar en \n\d+\. porque las explicaciones pueden tener listas numeradas
    const explainMatch = block.match(/Expli(?:que|cación)[:\s]*(.+?)$/is);
    const explanation = explainMatch
      ? explainMatch[1].replace(/\n/g, " ").trim()
      : "";

    // Crear ID único
    const id = `${moduleRange}_${String(questionNumber).padStart(3, "0")}`;

    questions.push({
      id,
      text: questionText,
      textNormalized: normalizeText(questionText),
      options,
      explanation,
    });
  }

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
    console.log("🧪 MODO TEST: Solo se procesará la primera URL\n");
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
    console.log(`  📎 URL: ${url}`);

    try {
      // Scrapear la URL
      const rawText = await scrapeUrl(url);

      console.log(`  📄 Texto recibido: ${rawText.length} caracteres`);

      // Guardar raw text para debug (solo en modo test)
      if (isTestMode) {
        const debugPath = path.join(
          __dirname,
          "..",
          "data",
          `debug-${moduleRange}-raw.txt`,
        );
        fs.mkdirSync(path.dirname(debugPath), { recursive: true });
        fs.writeFileSync(debugPath, rawText, "utf-8");
        console.log(`  💾 Raw text guardado en: debug-${moduleRange}-raw.txt`);
      }

      // Parsear preguntas
      const questions = parseQuestions(rawText, moduleRange);

      console.log(`  ✅ Preguntas extraídas: ${questions.length}`);

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
        console.log(`  ⏳ Esperando 2 segundos...\n`);
        await sleep(2000);
      }
    } catch (error) {
      console.log(`  ❌ Error: ${error.message}`);
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
  console.log(`✅ Banco de preguntas generado: data/questions-bank.json`);
  console.log(`📊 Total de preguntas: ${totalQuestions}`);
  console.log(
    `📦 Módulos procesados: ${Object.keys(questionsBank.modules).length}`,
  );
  console.log("════════════════════════════════════════════════════════\n");

  // Mostrar resumen por módulo
  console.log("Resumen por módulo:");
  for (const [range, module] of Object.entries(questionsBank.modules)) {
    const status = module.error ? "❌" : "✅";
    console.log(
      `  ${status} ${range}: ${module.questionCount} preguntas - ${module.title}`,
    );
  }
}

main().catch((error) => {
  console.error("Error fatal:", error);
  process.exit(1);
});
