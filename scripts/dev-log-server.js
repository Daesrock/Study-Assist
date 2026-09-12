/**
 * Study Assist — dev log server.
 *
 * Collects logs POSTed by the extension (background/content) and appends them
 * to files inside the project so they can be inspected without the browser.
 *
 *   npm run dev:logs
 *
 * Endpoints:
 *   GET  /health  -> { ok: true }
 *   POST /log     -> { file, level, ts, source, message, data }
 *
 * Files: logs/background.log, logs/content.log (rotated to `<file>.1` at 5 MB).
 */

import { createServer } from "node:http";
import { appendFile, mkdir, rename, stat } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const LOG_DIR = resolve(ROOT, "logs");
const PORT = Number(process.env.STUDY_ASSIST_LOG_PORT || 8788);
const MAX_BYTES = 5 * 1024 * 1024;
const ALLOWED_FILES = new Set(["background", "content"]);

function safeJson(value) {
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

async function rotateIfNeeded(file) {
  try {
    const info = await stat(file);
    if (info.size > MAX_BYTES) {
      await rename(file, `${file}.1`).catch(() => {});
    }
  } catch {
    // No file yet.
  }
}

async function appendLine(file, line) {
  await mkdir(LOG_DIR, { recursive: true });
  await rotateIfNeeded(file);
  await appendFile(file, `${line}\n`, "utf8");
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let data = "";
    req.on("data", (chunk) => {
      data += chunk;
      if (data.length > 1_000_000) req.destroy();
    });
    req.on("end", () => resolve(data));
    req.on("error", reject);
  });
}

const server = createServer(async (req, res) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Headers", "content-type");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");

  if (req.method === "OPTIONS") {
    res.writeHead(204);
    res.end();
    return;
  }

  if (req.method === "GET" && req.url === "/health") {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ ok: true }));
    return;
  }

  if (req.method === "POST" && req.url === "/log") {
    try {
      const payload = JSON.parse((await readBody(req)) || "{}");
      const file = ALLOWED_FILES.has(payload.file) ? payload.file : "background";
      const ts = payload.ts || new Date().toISOString();
      const level = payload.level || "log";
      const source = payload.source || file;
      const message =
        typeof payload.message === "string"
          ? payload.message
          : safeJson(payload.message);
      const data =
        payload.data === undefined ? "" : ` ${safeJson(payload.data)}`;
      await appendLine(resolve(LOG_DIR, `${file}.log`), `${ts} [${level}] [${source}] ${message}${data}`);
      res.writeHead(204);
      res.end();
    } catch (error) {
      res.writeHead(400, { "content-type": "application/json" });
      res.end(JSON.stringify({ ok: false, error: error.message }));
    }
    return;
  }

  res.writeHead(404);
  res.end();
});

server.listen(PORT, "127.0.0.1", () => {
  console.log(`[study-assist] log server listening on http://127.0.0.1:${PORT}`);
  console.log(`[study-assist] writing to ${LOG_DIR}`);
});
