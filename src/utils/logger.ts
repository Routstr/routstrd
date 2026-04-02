import { appendFile, mkdir } from "fs/promises";
import { existsSync } from "fs";
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

async function ensureLogDir() {
  if (!existsSync(LOGS_DIR)) {
    await mkdir(LOGS_DIR, { recursive: true });
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
    await appendFile(logFile, line);
  } catch (error) {
    console.error("Failed to write log:", error);
  }
}

export const logger = {
  log: (...args: unknown[]) => {
    console.log(...args);
    writeLog("INFO", ...args);
  },
  error: (...args: unknown[]) => {
    console.error(...args);
    writeLog("ERROR", ...args);
  },
  info: (...args: unknown[]) => {
    console.log(...args);
    writeLog("INFO", ...args);
  },
};
