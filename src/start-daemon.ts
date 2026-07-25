import { openSync, existsSync, readFileSync } from "fs";
import { logger } from "./utils/logger";
import { CONFIG_DIR, LOGS_DIR } from "./utils/config";
import { withCrossProcessLock } from "./utils/process-lock";

const DAEMON_STARTUP_LOCK_PATH = `${CONFIG_DIR}/routstrd-startup.lock`;
const DEBUG_LOG_PATH = `${CONFIG_DIR}/debug.log`;

/**
 * The spawned daemon's stdout/stderr is redirected to DEBUG_LOG_PATH, so when
 * it exits early we can surface its actual error from there instead of just
 * telling the user to go read logs.
 */
function readDaemonOutput(offset: number): string {
  try {
    if (!existsSync(DEBUG_LOG_PATH)) return "";
    const content = readFileSync(DEBUG_LOG_PATH, "utf-8");
    return content
      .slice(offset)
      .split("\n")
      .map((line) => line.trim())
      .filter(Boolean)
      .slice(-30)
      .join("\n");
  } catch {
    return "";
  }
}

async function isDaemonHealthy(port: string, host: string = "localhost"): Promise<boolean> {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), 2000);
  try {
    const existing = await fetch(`http://${host}:${port}/health`, {
      signal: controller.signal,
    });
    return existing.ok;
  } catch {
    return false;
  } finally {
    clearTimeout(timeoutId);
  }
}

/** When the daemon binds to 0.0.0.0, the CLI must still connect via
 * localhost (or 127.0.0.1) since 0.0.0.0 is not a connectable address. */
function clientHost(host: string | undefined): string {
  if (!host || host === "0.0.0.0") return "localhost";
  return host;
}

async function startDaemonUnlocked(
  options: { port?: string; host?: string; provider?: string },
): Promise<void> {
  const args: string[] = [];
  const port = options.port || "8008";
  const host = options.host || "127.0.0.1";
  const ch = clientHost(host);
  const pollIntervalMs = 250;
  const startupTimeoutMs = 10 * 60 * 1000;

  if (await isDaemonHealthy(port, ch)) {
    console.log(`Routstr daemon already running on http://${ch}:${port}/v1`);
    return;
  }

  if (options.port) {
    args.push("--port", options.port);
  }
  if (options.host) {
    args.push("--host", options.host);
  }
  if (options.provider) {
    args.push("--provider", options.provider);
  }

  const daemonScript = new URL("./daemon/index.js", import.meta.url).pathname;
  const shellCmd = `bun run "${daemonScript}" ${args.map((a) => `'${a}'`).join(" ")}`;

  const debugLogOffset = existsSync(DEBUG_LOG_PATH)
    ? readFileSync(DEBUG_LOG_PATH, "utf-8").length
    : 0;
  const debugLogFd = openSync(DEBUG_LOG_PATH, "a");

  const proc = Bun.spawn(["sh", "-c", shellCmd], {
    stdout: debugLogFd,
    stderr: debugLogFd,
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
      const daemonOutput = readDaemonOutput(debugLogOffset);
      throw new Error(
        `Daemon process exited early with code ${exitCode}.` +
          (daemonOutput
            ? `\n\nDaemon output:\n${daemonOutput}`
            : ` Check logs in ${LOGS_DIR}`),
      );
    }

    if (await isDaemonHealthy(port, ch)) {
      console.log(`Routstr daemon started (PID: ${proc.pid}).`);
      return;
    }
  }

  throw new Error(
    `Daemon failed to start within ${Math.round(startupTimeoutMs / 1000)} seconds. Check logs in ${LOGS_DIR}`,
  );
}

export async function startDaemon(
  options: { port?: string; host?: string; provider?: string } = {},
): Promise<void> {
  const port = options.port || "8008";
  const host = options.host || "127.0.0.1";
  const ch = clientHost(host);
  const startupTimeoutMs = 10 * 60 * 1000;

  if (await isDaemonHealthy(port, ch)) {
    console.log(`Routstr daemon already running on http://${ch}:${port}/v1`);
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
