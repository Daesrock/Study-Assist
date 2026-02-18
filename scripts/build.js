/**
 * Build script for Study Assist Chrome Extension
 * Uses esbuild to bundle ES modules
 */

import * as esbuild from "esbuild";
import { existsSync, mkdirSync, copyFileSync } from "fs";
import { dirname, join } from "path";
import { fileURLToPath } from "url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, "..");

const isWatch = process.argv.includes("--watch");

// Common build options
const commonOptions = {
  bundle: true,
  format: "iife", // Immediately Invoked Function Expression - works in content scripts
  target: ["chrome91"],
  sourcemap: "inline",
  minify: !isWatch,
};

// Build configurations - output to content/ and background/ folders directly
const builds = [
  {
    entryPoints: [join(ROOT, "src/content/content.ts")],
    outfile: join(ROOT, "content/content.js"),
    ...commonOptions,
  },
  {
    entryPoints: [join(ROOT, "src/background/background.ts")],
    outfile: join(ROOT, "background/background.js"),
    ...commonOptions,
    format: "esm", // Background service worker can use ESM
  },
];

async function build() {
  console.log("Building Study Assist...\n");

  try {
    if (isWatch) {
      // Watch mode
      const contexts = await Promise.all(
        builds.map((config) => esbuild.context(config)),
      );

      await Promise.all(contexts.map((ctx) => ctx.watch()));
      console.log("Watching for changes...\n");

      // Copy static files initially
      copyStaticFiles();
    } else {
      // Production build
      await Promise.all(builds.map((config) => esbuild.build(config)));
      copyStaticFiles();
      console.log("Build complete!\n");
    }
  } catch (error) {
    console.error("Build failed:", error);
    process.exit(1);
  }
}

function copyStaticFiles() {
  // Copy CSS from src to content folder
  const cssSource = join(ROOT, "src/content/overlay.css");
  const cssDest = join(ROOT, "content/overlay.css");
  if (existsSync(cssSource)) {
    copyFileSync(cssSource, cssDest);
    console.log("Copied overlay.css");
  }
  console.log("");
}

build();
