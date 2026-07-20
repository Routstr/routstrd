import { appendFileSync, existsSync, mkdirSync } from "fs";
import { join } from "path";

const HOME = process.env.HOME || process.env.USERPROFILE || "";
const LOG_DIR = process.env.ROUTSTRD_DIR || `${HOME}/.routstrd`;
const LOGS_DIR = join(LOG_DIR, "logs");

function getLogFileForDate(date: Date = new Date()): string {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return join(LOGS_DIR, `${year}-${month}-${day}.log`);
}

function ensureLogDir() {
  if (!existsSync(LOGS_DIR)) {
    mkdirSync(LOGS_DIR, { recursive: true });
  }
}

// NOTE: writes are synchronous on purpose — the daemon calls process.exit()
// right after logger.error(...) on fatal paths, and async writes were being
// silently dropped, making startup failures invisible.
function writeLog(level: string, ...args: unknown[]) {
  ensureLogDir();
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
    appendFileSync(logFile, line);
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
