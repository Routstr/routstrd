import { appendFileSync, existsSync, mkdirSync } from "fs";
import { join } from "path";

const HOME = process.env.HOME || process.env.USERPROFILE || "";

// `bun test` sets NODE_ENV=test. Test runs import modules that pull in this
// singleton, so without this guard their output would be written into the real
// ~/.routstrd log files alongside production daemon output.
const isTest = process.env.NODE_ENV === "test";

const LOG_DIR = process.env.ROUTSTRD_DIR || `${HOME}/.routstrd`;
const LOGS_DIR = join(LOG_DIR, "logs");
/** Wallet-engine (coco-core / Cashu) diagnostics land in their own directory. */
export const COCO_LOGS_DIR = join(LOG_DIR, "coco-logs");

function getLogFileForDate(logsDir: string, date: Date = new Date()): string {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return join(logsDir, `${year}-${month}-${day}.log`);
}

function ensureDir(dir: string) {
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
  }
}

// NOTE: writes are synchronous on purpose — the daemon calls process.exit()
// right after logger.error(...) on fatal paths, and async writes were being
// silently dropped, making startup failures invisible.
function writeLog(logsDir: string, level: string, ...args: unknown[]) {
  if (isTest) return;
  ensureDir(logsDir);
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
  const logFile = getLogFileForDate(logsDir, new Date(timestamp));
  try {
    appendFileSync(logFile, line);
  } catch (error) {
    console.error("Failed to write log:", error);
  }
}

export interface FileLogger {
  log: (...args: unknown[]) => void;
  debug: (...args: unknown[]) => void;
  warn: (...args: unknown[]) => void;
  error: (...args: unknown[]) => void;
  info: (...args: unknown[]) => void;
}

function createLogger(logsDir: string): FileLogger {
  return {
    log: (...args) => writeLog(logsDir, "INFO", ...args),
    debug: (...args) => writeLog(logsDir, "DEBUG", ...args),
    warn: (...args) => writeLog(logsDir, "WARN", ...args),
    error: (...args) => writeLog(logsDir, "ERROR", ...args),
    info: (...args) => writeLog(logsDir, "INFO", ...args),
  };
}

export const logger = createLogger(LOGS_DIR);
export const cocoLogger = createLogger(COCO_LOGS_DIR);
