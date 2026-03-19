import { LOG_FILE } from "./utils/config";
import { logger } from "./utils/logger";

export async function startDaemon(
  options: { port?: string; provider?: string } = {},
): Promise<void> {
  const args: string[] = [];
  const port = options.port || "8008";
  const pollIntervalMs = 250;
  const startupTimeoutMs = 10 * 60 * 1000;

  try {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 2000);
    const existing = await fetch(`http://localhost:${port}/health`, {
      signal: controller.signal,
    });
    clearTimeout(timeoutId);
    if (existing.ok) {
      logger.log(`Routstr daemon already running on http://localhost:${port}`);
      return;
    }
  } catch {
    // Daemon is not running yet; continue with startup.
  }

  if (options.port) {
    args.push("--port", options.port);
  }
  if (options.provider) {
    args.push("--provider", options.provider);
  }

  const logFile = Bun.file(LOG_FILE);

  const proc = Bun.spawn(
    ["bun", "run", `${import.meta.dir}/daemon/index.ts`, ...args],
    {
      stdout: logFile,
      stderr: logFile,
      stdin: "ignore",
      detached: true,
    },
  );

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
        `Daemon process exited early with code ${exitCode}. Check logs at ${LOG_FILE}`,
      );
    }

    try {
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), 2000);
      const res = await fetch(`http://localhost:${port}/health`, {
        signal: controller.signal,
      });
      clearTimeout(timeoutId);
      if (res.ok) {
        logger.log(`Routstr daemon started (PID: ${proc.pid}).`);
        return;
      }
    } catch {
      // Not ready yet
    }
  }

  throw new Error(
    `Daemon failed to start within ${Math.round(startupTimeoutMs / 1000)} seconds. Check logs at ${LOG_FILE}`,
  );
}
