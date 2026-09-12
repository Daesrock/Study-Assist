/**
 * Dev log sink.
 *
 * Mirrors `[Study Assist]` logs to the local dev log server
 * (`scripts/dev-log-server.js`) so they are written to files inside the
 * project (`logs/background.log`, `logs/content.log`).
 *
 * Fails silently when the server is down or when running outside a real
 * extension context (e.g. unit tests).
 */

/** Flip to `false` for release builds. */
export const DEV_LOGGING = true;

const ENDPOINT = "http://127.0.0.1:8788/log";
const MAX_DATA_CHARS = 2000;
const RETRY_COOLDOWN_MS = 15000;

export type DevLogFile = "background" | "content";

let serverAvailable = true;
let lastFailure = 0;

function truncate(value: unknown): unknown {
  if (typeof value === "string") {
    return value.length > MAX_DATA_CHARS
      ? `${value.slice(0, MAX_DATA_CHARS)}…[truncated]`
      : value;
  }
  if (Array.isArray(value)) return value.map(truncate);
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [key, val] of Object.entries(value as Record<string, unknown>)) {
      out[key] = truncate(val);
    }
    return out;
  }
  return value;
}

function inExtension(): boolean {
  return typeof chrome !== "undefined" && !!chrome?.runtime?.id;
}

/** Send one log entry to the local dev log server (fire-and-forget). */
export function devLog(
  file: DevLogFile,
  level: string,
  message: string,
  data?: unknown,
): void {
  if (!DEV_LOGGING) return;
  if (!inExtension()) return;

  const now = Date.now();
  if (!serverAvailable && now - lastFailure < RETRY_COOLDOWN_MS) return;

  const payload = {
    file,
    level,
    ts: new Date().toISOString(),
    source: "study-assist",
    message,
    data: data === undefined ? undefined : truncate(data),
  };

  try {
    fetch(ENDPOINT, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    })
      .then(() => {
        serverAvailable = true;
      })
      .catch(() => {
        serverAvailable = false;
        lastFailure = Date.now();
      });
  } catch {
    serverAvailable = false;
    lastFailure = Date.now();
  }
}

/** Test seam: stop trying to reach the network sink. */
export function __disableDevLoggingForTests(): void {
  serverAvailable = false;
  lastFailure = Number.MAX_SAFE_INTEGER;
}
