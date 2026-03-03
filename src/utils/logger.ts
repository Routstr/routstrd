import { appendFile, mkdir } from "fs/promises";
import { existsSync } from "fs";
import { join } from "path";

const HOME = process.env.HOME || process.env.USERPROFILE || "";
const LOG_DIR = process.env.ROUTSTRD_DIR || `${HOME}/.routstrd`;
const LOG_FILE = join(LOG_DIR, "routstrd.log");

async function ensureLogDir() {
  if (!existsSync(LOG_DIR)) {
    await mkdir(LOG_DIR, { recursive: true });
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
  try {
    await appendFile(LOG_FILE, line);
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
