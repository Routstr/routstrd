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

export type LogLevel = "debug" | "info" | "warn" | "error";

const LEVEL_RANK: Record<LogLevel, number> = {
  debug: 10,
  info: 20,
  warn: 30,
  error: 40,
};

export const DEFAULT_LOG_LEVEL: LogLevel = "info";

/**
 * Minimum level written to disk for a `ROUTSTRD_*_LOG_LEVEL` value.
 *
 * The daemon emits per-pass and per-provider diagnostics at `debug`, so by
 * default a recurring refresh costs one line instead of one line per provider.
 * `ROUTSTRD_LOG_LEVEL=debug` restores the full detail when investigating; an
 * unparseable or missing value falls back to `fallback` rather than muting the
 * log. The env read deliberately lives at the call site: an explicit
 * `undefined` argument would otherwise trigger a default parameter and let one
 * sink silently inherit another's variable.
 */
export function resolveLogLevel(
  raw: string | undefined,
  fallback: LogLevel = DEFAULT_LOG_LEVEL,
): LogLevel {
  const normalized = (raw ?? "").trim().toLowerCase();
  // `in` would also accept inherited keys: "constructor" and "__proto__" are
  // lowercase `Object.prototype` members, and ranking against `Object` makes
  // every level compare false, which would mute the log including errors.
  return Object.hasOwn(LEVEL_RANK, normalized)
    ? (normalized as LogLevel)
    : fallback;
}

export function isLevelEnabled(level: LogLevel, minLevel: LogLevel): boolean {
  return LEVEL_RANK[level] >= LEVEL_RANK[minLevel];
}

type LogSink = (logsDir: string, level: string, ...args: unknown[]) => void;

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

export function createLogger(
  logsDir: string,
  minLevel: LogLevel = resolveLogLevel(process.env.ROUTSTRD_LOG_LEVEL),
  sink: LogSink = writeLog,
): FileLogger {
  const write = (level: LogLevel, args: unknown[]) => {
    if (!isLevelEnabled(level, minLevel)) return;
    sink(logsDir, level.toUpperCase(), ...args);
  };
  return {
    log: (...args) => write("info", args),
    info: (...args) => write("info", args),
    debug: (...args) => write("debug", args),
    warn: (...args) => write("warn", args),
    error: (...args) => write("error", args),
  };
}

export const logger = createLogger(
  LOGS_DIR,
  resolveLogLevel(process.env.ROUTSTRD_LOG_LEVEL),
);
/**
 * Wallet-engine diagnostics live in their own directory precisely because they
 * are verbose (~87% `debug`), so this logger writes everything unless
 * `ROUTSTRD_COCO_LOG_LEVEL` asks for less. A separate knob keeps an explicit
 * `ROUTSTRD_LOG_LEVEL=info` from silently dropping wallet detail it never
 * touched before.
 */
export const cocoLogger = createLogger(
  COCO_LOGS_DIR,
  resolveLogLevel(process.env.ROUTSTRD_COCO_LOG_LEVEL, "debug"),
);
