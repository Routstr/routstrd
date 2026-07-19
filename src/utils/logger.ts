import { appendFile, mkdir, stat } from "fs/promises";
import { existsSync } from "fs";
import { join } from "path";

const HOME = process.env.HOME || process.env.USERPROFILE || "";
const LOG_DIR = process.env.ROUTSTRD_DIR || `${HOME}/.routstrd`;
const LOGS_DIR = join(LOG_DIR, "logs");

// Max log file size before rotation kicks in (50 MB). Prevents the runaway
// log growth that previously filled swap and killed the daemon (a 195 MB
// debug.log full of per-token SSE spam was the root cause of silent OOM
// crashes). Set ROUTSTRD_LOG_MAX_BYTES=0 to disable rotation.
const DEFAULT_MAX_BYTES = 50 * 1024 * 1024;
const MAX_BYTES =
  (() => {
    const raw = process.env.ROUTSTRD_LOG_MAX_BYTES;
    if (!raw) return DEFAULT_MAX_BYTES;
    const n = Number.parseInt(raw, 10);
    return Number.isFinite(n) ? n : DEFAULT_MAX_BYTES;
  })();

// Keep this many rotated archives (file.log.1, file.log.2, ...).
const MAX_ARCHIVES = 3;

function getLogFileForDate(date: Date = new Date()): string {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return join(LOGS_DIR, `${year}-${month}-${day}.log`);
}

async function ensureLogDir() {
  if (!existsSync(LOGS_DIR)) {
    await mkdir(LOGS_DIR, { recursive: true });
  }
}

/**
 * Rotate the log file if it has grown past MAX_BYTES.
 * Renames the current file to file.log.1 (shifting older archives down),
 * then the caller creates a fresh file. Keeps at most MAX_ARCHIVES archives.
 */
async function rotateIfNeeded(logFile: string): Promise<void> {
  if (MAX_BYTES <= 0) return;
  let size: number;
  try {
    const info = await stat(logFile);
    size = info.size;
  } catch {
    return; // file doesn't exist yet — nothing to rotate
  }
  if (size < MAX_BYTES) return;

  // Shift archives: .2 → .3, .1 → .2, then current → .1
  for (let i = MAX_ARCHIVES - 1; i >= 1; i--) {
    const older = `${logFile}.${i}`;
    const newer = `${logFile}.${i + 1}`;
    try {
      if (existsSync(older)) {
        const { rename } = await import("fs/promises");
        if (i + 1 > MAX_ARCHIVES) {
          // Drop the oldest archive
          const { unlink } = await import("fs/promises");
          await unlink(older).catch(() => {});
        } else {
          await rename(older, newer).catch(() => {});
        }
      }
    } catch {
      // best-effort
    }
  }
  try {
    const { rename } = await import("fs/promises");
    await rename(logFile, `${logFile}.1`);
  } catch {
    // best-effort — if rename fails (e.g. permissions), we keep appending
  }
}

async function writeLog(level: string, ...args: unknown[]) {
  await ensureLogDir();
  const timestamp = new Date().toISOString();
  const message = args
    .map((a) => {
      if (a instanceof Error) {
        return `${a.message}${a.stack ? `\n${a.stack}` : ""}`;
      }
      if (typeof a === "object") {
        try {
          return JSON.stringify(a);
        } catch {
          return String(a);
        }
      }
      return String(a);
    })
    .join(" ");
  const line = `[${timestamp}] [${level}] ${message}\n`;
  const logFile = getLogFileForDate(new Date(timestamp));
  try {
    await rotateIfNeeded(logFile);
    await appendFile(logFile, line);
  } catch (error) {
    console.error("Failed to write log:", error);
  }
}

export const logger = {
  log: (...args: unknown[]) => {
    writeLog("INFO", ...args);
  },
  debug: (...args: unknown[]) => {
    writeLog("DEBUG", ...args);
  },
  warn: (...args: unknown[]) => {
    writeLog("WARN", ...args);
  },
  error: (...args: unknown[]) => {
    writeLog("ERROR", ...args);
  },
  info: (...args: unknown[]) => {
    writeLog("INFO", ...args);
  },
};
