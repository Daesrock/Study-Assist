/**
 * Generate `data/model-prices.json` from LiteLLM's public price catalog.
 *
 * Usage: npm run update:prices
 *
 * The raw file is ~2.4 MB and covers every provider/back-end. We trim it to
 * the providers this extension supports and to the fields we actually use, so
 * the bundled snapshot stays small (tens of KB) and offline-friendly.
 */

import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const SOURCE_URL =
  "https://raw.githubusercontent.com/BerriAI/litellm/main/model_prices_and_context_window.json";

const OUT_FILE = resolve(
  dirname(fileURLToPath(import.meta.url)),
  "..",
  "data",
  "model-prices.json",
);

const WANTED_PROVIDERS = new Set(["anthropic", "openai", "deepseek"]);

function isRecord(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function toNumber(value) {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function toInfo(entry) {
  if (!isRecord(entry)) return null;
  const provider = entry.litellm_provider;
  if (typeof provider !== "string" || !WANTED_PROVIDERS.has(provider)) return null;

  const input = toNumber(entry.input_cost_per_token);
  const output = toNumber(entry.output_cost_per_token);
  if (input === undefined && output === undefined) return null;

  const cacheRead = toNumber(entry.cache_read_input_token_cost);
  const cacheWrite = toNumber(entry.cache_creation_input_token_cost);

  const vision =
    entry.supports_vision === true ? true : entry.supports_vision === false ? false : null;

  const reasoning =
    entry.supports_reasoning === true
      ? true
      : entry.supports_reasoning === false
        ? false
        : null;

  const adaptive =
    entry.supports_adaptive_thinking === true
      ? true
      : entry.supports_adaptive_thinking === false
        ? false
        : null;

  return {
    inputPer1M: (input ?? 0) * 1_000_000,
    outputPer1M: (output ?? 0) * 1_000_000,
    cacheReadPer1M: cacheRead === undefined ? null : cacheRead * 1_000_000,
    cacheWritePer1M: cacheWrite === undefined ? null : cacheWrite * 1_000_000,
    vision,
    reasoning,
    adaptive,
    deprecationDate:
      typeof entry.deprecation_date === "string" ? entry.deprecation_date : null,
    maxInput: toNumber(entry.max_input_tokens),
    maxOutput: toNumber(entry.max_output_tokens),
    provider,
    mode: typeof entry.mode === "string" ? entry.mode : undefined,
  };
}

async function main() {
  if (typeof fetch !== "function") {
    console.error("This script needs Node.js 18+ (global fetch).");
    process.exit(1);
  }

  console.log("Fetching", SOURCE_URL);
  const response = await fetch(SOURCE_URL);
  if (!response.ok) {
    console.error(`HTTP ${response.status} ${response.statusText}`);
    process.exit(1);
  }

  const raw = await response.json();
  const models = {};
  for (const key of Object.keys(raw)) {
    const info = toInfo(raw[key]);
    if (info) models[key] = info;
  }

  const count = Object.keys(models).length;
  if (count === 0) {
    console.error("No matching models found; aborting without writing.");
    process.exit(1);
  }

  const output = {
    generatedAt: new Date().toISOString(),
    source: SOURCE_URL,
    count,
    models,
  };

  mkdirSync(dirname(OUT_FILE), { recursive: true });
  writeFileSync(OUT_FILE, `${JSON.stringify(output)}\n`, "utf8");
  console.log(`Wrote ${count} models to ${OUT_FILE}`);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
