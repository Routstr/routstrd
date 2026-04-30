import { logger } from "./utils/logger";
import { existsSync } from "fs";
import { CONFIG_DIR, LOGS_DIR } from "./utils/config";
import { withCrossProcessLock } from "./utils/process-lock";

const DAEMON_STARTUP_LOCK_PATH = `${CONFIG_DIR}/routstrd-startup.lock`;

function getTodayLogFile(): string {
  const now = new Date();
  const year = now.getFullYear();
  const month = String(now.getMonth() + 1).padStart(2, "0");
  const day = String(now.getDate()).padStart(2, "0");
  return `${LOGS_DIR}/${year}-${month}-${day}.log`;
}

async function isDaemonHealthy(port: string): Promise<boolean> {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), 2000);
  try {
    const existing = await fetch(`http://localhost:${port}/health`, {
      signal: controller.signal,
    });
    return existing.ok;
  } catch {
    return false;
  } finally {
    clearTimeout(timeoutId);
  }
}

async function startDaemonUnlocked(
  options: { port?: string; provider?: string },
): Promise<void> {
  const args: string[] = [];
  const port = options.port || "8008";
  const pollIntervalMs = 250;
  const startupTimeoutMs = 10 * 60 * 1000;

  if (await isDaemonHealthy(port)) {
    logger.log(`Routstr daemon already running on http://localhost:${port}/v1`);
    return;
  }

  if (options.port) {
    args.push("--port", options.port);
  }
  if (options.provider) {
    args.push("--provider", options.provider);
  }

  // Ensure logs directory exists (logger handles date-based files)
  if (!existsSync(LOGS_DIR)) {
    await Bun.$`mkdir -p ${LOGS_DIR}`;
  }

  const daemonScript = new URL("./daemon/index.js", import.meta.url).pathname;
  const todayLogFile = getTodayLogFile();
  const shellCmd = `bun run "${daemonScript}" ${args.map((a) => `'${a}'`).join(" ")} >> "${todayLogFile}" 2>&1`;

  const proc = Bun.spawn(["sh", "-c", shellCmd], {
    stdout: "inherit",
    stderr: "inherit",
    stdin: "ignore",
    detached: true,
  });

  proc.unref();

  let exitCode: number | null = null;
  proc.exited.then((code) => {
    exitCode = code;
  });

  const maxPolls = Math.ceil(startupTimeoutMs / pollIntervalMs);
  for (let i = 0; i < maxPolls; i++) {
    await new Promise((resolve) => setTimeout(resolve, pollIntervalMs));

    if (exitCode !== null) {
      throw new Error(
        `Daemon process exited early with code ${exitCode}. Check logs in ${LOGS_DIR}`,
      );
    }

    if (await isDaemonHealthy(port)) {
      logger.log(`Routstr daemon started (PID: ${proc.pid}).`);
      return;
    }
  }

  throw new Error(
    `Daemon failed to start within ${Math.round(startupTimeoutMs / 1000)} seconds. Check logs in ${LOGS_DIR}`,
  );
}

export async function startDaemon(
  options: { port?: string; provider?: string } = {},
): Promise<void> {
  const port = options.port || "8008";
  const startupTimeoutMs = 10 * 60 * 1000;

  if (await isDaemonHealthy(port)) {
    logger.log(`Routstr daemon already running on http://localhost:${port}/v1`);
    return;
  }

  await withCrossProcessLock(
    DAEMON_STARTUP_LOCK_PATH,
    async () => {
      await startDaemonUnlocked(options);
    },
    {
      acquireTimeoutMs: startupTimeoutMs + 30_000,
      staleAfterMs: startupTimeoutMs + 30_000,
      log: (message) => logger.debug(message),
    },
  );
}
