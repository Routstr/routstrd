import { openSync, statSync, renameSync, existsSync, unlinkSync } from "fs";
import { fileURLToPath } from "url";
import { logger } from "./utils/logger";
import { CONFIG_DIR, LOGS_DIR } from "./utils/config";
import { withCrossProcessLock } from "./utils/process-lock";

const DAEMON_STARTUP_LOCK_PATH = `${CONFIG_DIR}/routstrd-startup.lock`;
const STDOUT_LOG_PATH = `${CONFIG_DIR}/stdout.log`;
const STDERR_LOG_PATH = `${CONFIG_DIR}/stderr.log`;

// Rotate the stdout/stderr capture files before attaching so they don't grow
// without bound (the old single debug.log hit 195 MB and contributed to an
// OOM crash). Keep a handful of archives. Set ROUTSTRD_CAPTURE_MAX_BYTES=0 to
// disable. 50 MB default matches the structured log rotation.
const CAPTURE_MAX_BYTES = (() => {
  const raw = process.env.ROUTSTRD_CAPTURE_MAX_BYTES;
  if (!raw) return 50 * 1024 * 1024;
  const n = Number.parseInt(raw, 10);
  return Number.isFinite(n) ? n : 50 * 1024 * 1024;
})();
const CAPTURE_MAX_ARCHIVES = 3;

function rotateCaptureFile(path: string): void {
  if (CAPTURE_MAX_BYTES <= 0) return;
  let size = 0;
  try {
    size = statSync(path).size;
  } catch {
    return; // doesn't exist yet
  }
  if (size < CAPTURE_MAX_BYTES) return;

  // Drop oldest, shift the rest down: .2 → .3, .1 → .2, current → .1
  for (let i = CAPTURE_MAX_ARCHIVES - 1; i >= 1; i--) {
    const older = `${path}.${i}`;
    const newer = `${path}.${i + 1}`;
    try {
      if (existsSync(older)) {
        if (i + 1 > CAPTURE_MAX_ARCHIVES) {
          unlinkSync(older);
        } else {
          renameSync(older, newer);
        }
      }
    } catch {
      // best-effort
    }
  }
  try {
    renameSync(path, `${path}.1`);
  } catch {
    // best-effort
  }
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
    console.log(`Routstr daemon already running on http://localhost:${port}/v1`);
    return;
  }

  if (options.port) {
    args.push("--port", options.port);
  }
  if (options.provider) {
    args.push("--provider", options.provider);
  }

  let daemonScript = fileURLToPath(new URL("./daemon/index.js", import.meta.url));
  if (!existsSync(daemonScript)) {
    daemonScript = fileURLToPath(new URL("./daemon/index.ts", import.meta.url));
  }

  // Rotate capture files before attaching so they never grow unbounded.
  rotateCaptureFile(STDOUT_LOG_PATH);
  rotateCaptureFile(STDERR_LOG_PATH);

  const stdoutFd = openSync(STDOUT_LOG_PATH, "a");
  const stderrFd = openSync(STDERR_LOG_PATH, "a");

  const proc = Bun.spawn(["bun", daemonScript, ...args], {
    stdout: stdoutFd,
    stderr: stderrFd,
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
        `Daemon process exited early with code ${exitCode}. Check stderr log: ${STDERR_LOG_PATH} and structured logs: ${LOGS_DIR}`,
      );
    }

    if (await isDaemonHealthy(port)) {
      console.log(`Routstr daemon started (PID: ${proc.pid}).`);
      console.log(`  stdout → ${STDOUT_LOG_PATH}`);
      console.log(`  stderr → ${STDERR_LOG_PATH}`);
      console.log(`  logs   → ${LOGS_DIR}`);
      return;
    }
  }

  throw new Error(
    `Daemon failed to start within ${Math.round(startupTimeoutMs / 1000)} seconds. Check stderr log: ${STDERR_LOG_PATH} and structured logs: ${LOGS_DIR}`,
  );
}

export async function startDaemon(
  options: { port?: string; provider?: string } = {},
): Promise<void> {
  const port = options.port || "8008";
  const startupTimeoutMs = 10 * 60 * 1000;

  if (await isDaemonHealthy(port)) {
    console.log(`Routstr daemon already running on http://localhost:${port}/v1`);
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
