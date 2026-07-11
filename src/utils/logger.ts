import { appendFile, mkdir, readFile, readdir } from "fs/promises";
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

export interface ErrorLogEntry {
  timestamp: string;
  message: string;
}

export async function getRecentErrors(limit = 50): Promise<ErrorLogEntry[]> {
  if (!existsSync(LOGS_DIR)) return [];

  const files = (await readdir(LOGS_DIR))
    .filter((file) => /^\d{4}-\d{2}-\d{2}\.log$/.test(file))
    .sort()
    .reverse();
  const errors: ErrorLogEntry[] = [];

  for (const file of files) {
    const records: Array<{ timestamp: string; level: string; message: string }> = [];
    for (const line of (await readFile(join(LOGS_DIR, file), "utf8")).split("\n")) {
      const match = line.match(/^\[([^\]]+)] \[([^\]]+)] (.*)$/);
      if (match) {
        records.push({ timestamp: match[1]!, level: match[2]!, message: match[3]! });
      } else if (line && records.length > 0) {
        records[records.length - 1]!.message += `\n${line}`;
      }
    }

    for (const record of records.reverse()) {
      if (record.level === "ERROR") {
        errors.push({ timestamp: record.timestamp, message: record.message });
        if (errors.length === limit) return errors;
      }
    }
  }

  return errors;
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
