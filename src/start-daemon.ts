import {
  closeSync,
  existsSync,
  fstatSync,
  openSync,
  readSync,
} from "fs";
import { logger } from "./utils/logger";
import { CONFIG_DIR, LOGS_DIR } from "./utils/config";
import { withCrossProcessLock } from "./utils/process-lock";
import { urlHosts } from "./utils/daemon-client";
import { fileURLToPath } from "url";

const DAEMON_STARTUP_LOCK_PATH = `${CONFIG_DIR}/routstrd-startup.lock`;
const DEBUG_LOG_PATH = `${CONFIG_DIR}/debug.log`;

/**
 * The spawned daemon's stdout/stderr is redirected to DEBUG_LOG_PATH, so when
 * it exits early we can surface its actual error from there instead of just
 * telling the user to go read logs.
 */
function readDaemonOutput(offset: number): string {
  let fd: number | undefined;
  try {
    if (!existsSync(DEBUG_LOG_PATH)) return "";
    fd = openSync(DEBUG_LOG_PATH, "r");
    const size = fstatSync(fd).size;
    if (size <= offset) return "";
    const bytesToRead = Math.min(size - offset, 256 * 1024);
    const buffer = Buffer.allocUnsafe(bytesToRead);
    const bytesRead = readSync(fd, buffer, 0, bytesToRead, offset);
    return buffer
      .toString("utf8", 0, bytesRead)
      .split("\n")
      .map((line) => line.trim())
      .filter(Boolean)
      .slice(-30)
      .join("\n");
  } catch {
    return "";
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}

const STARTUP_LOG_PREFIX = "[routstrd:start]";

/**
 * Print only explicitly tagged, user-safe progress emitted by the detached
 * daemon. Return the next byte offset so each line is shown exactly once.
 */
function printStartupProgress(offset: number): {
  offset: number;
  lastMessage?: string;
} {
  let fd: number | undefined;
  try {
    if (!existsSync(DEBUG_LOG_PATH)) return { offset };
    fd = openSync(DEBUG_LOG_PATH, "r");
    const size = fstatSync(fd).size;
    if (size <= offset) return { offset };

    // Startup messages are short. Bound each read so a noisy daemon cannot
    // make the waiting CLI repeatedly load a large debug log into memory.
    const bytesToRead = Math.min(size - offset, 64 * 1024);
    const buffer = Buffer.allocUnsafe(bytesToRead);
    const bytesRead = readSync(fd, buffer, 0, bytesToRead, offset);
    const lastNewlineIndex = buffer.subarray(0, bytesRead).lastIndexOf(0x0a);
    const completeBytes = lastNewlineIndex + 1;
    if (completeBytes === 0) return { offset };
    const appended = buffer.toString("utf8", 0, completeBytes);

    let lastMessage: string | undefined;
    for (const line of appended.split("\n")) {
      const markerIndex = line.indexOf(STARTUP_LOG_PREFIX);
      if (markerIndex === -1) continue;
      const message = line.slice(markerIndex + STARTUP_LOG_PREFIX.length).trim();
      if (message) {
        console.log(`  ${message}`);
        lastMessage = message;
      }
    }
    return { offset: offset + completeBytes, lastMessage };
  } catch {
    return { offset };
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}

function formatElapsed(elapsedMs: number): string {
  const seconds = Math.floor(elapsedMs / 1000);
  if (seconds < 60) return `${seconds}s`;
  return `${Math.floor(seconds / 60)}m ${seconds % 60}s`;
}

function fileSize(path: string): number {
  let fd: number | undefined;
  try {
    fd = openSync(path, "r");
    return fstatSync(fd).size;
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}

async function healthyDaemonHost(
  port: string,
  host = "127.0.0.1",
): Promise<string | null> {
  // Return the responding candidate so status output shows a connectable URL.
  for (const candidate of urlHosts(host)) {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 2000);
    try {
      const existing = await fetch(`http://${candidate}:${port}/health`, {
        signal: controller.signal,
      });
      if (existing.ok) return candidate;
    } catch {
      // Try the next candidate host.
    } finally {
      clearTimeout(timeoutId);
    }
  }
  return null;
}

async function startDaemonUnlocked(
  options: { port?: string; host?: string; provider?: string },
): Promise<void> {
  const args: string[] = [];
  const port = options.port || "8008";
  const host = options.host || "127.0.0.1";
  const pollIntervalMs = 250;
  const startupTimeoutMs = 10 * 60 * 1000;

  const existingHost = await healthyDaemonHost(port, host);
  if (existingHost) {
    console.log(`Routstr daemon already running on http://${existingHost}:${port}/v1`);
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

  let daemonScript = fileURLToPath(new URL("./daemon/index.js", import.meta.url));
  if (!existsSync(daemonScript)) {
    daemonScript = fileURLToPath(new URL("./daemon/index.ts", import.meta.url));
  }

  const debugLogOffset = existsSync(DEBUG_LOG_PATH)
    ? fileSize(DEBUG_LOG_PATH)
    : 0;
  const debugLogFd = openSync(DEBUG_LOG_PATH, "a");

  const proc = Bun.spawn(["bun", daemonScript, ...args], {
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

  const startedAt = Date.now();
  const heartbeatIntervalMs = 10_000;
  let nextHeartbeatAt = heartbeatIntervalMs;
  let progressLogOffset = debugLogOffset;
  let currentPhase = "starting daemon";

  const maxPolls = Math.ceil(startupTimeoutMs / pollIntervalMs);
  for (let i = 0; i < maxPolls; i++) {
    await new Promise((resolve) => setTimeout(resolve, pollIntervalMs));

    const progress = printStartupProgress(progressLogOffset);
    progressLogOffset = progress.offset;
    if (progress.lastMessage) {
      currentPhase = progress.lastMessage
        .replace(/\.$/, "")
        .toLowerCase();
    }

    const elapsedMs = Date.now() - startedAt;
    if (elapsedMs >= nextHeartbeatAt) {
      console.log(
        `  Still ${currentPhase} (${formatElapsed(elapsedMs)} elapsed)...`,
      );
      nextHeartbeatAt += heartbeatIntervalMs;
    }

    if (exitCode !== null) {
      const daemonOutput = readDaemonOutput(debugLogOffset);
      throw new Error(
        `Daemon process exited early with code ${exitCode}.` +
          (daemonOutput
            ? `\n\nDaemon output:\n${daemonOutput}`
            : ` Check logs in ${LOGS_DIR}`),
      );
    }

    if (await healthyDaemonHost(port, host)) {
      printStartupProgress(progressLogOffset);
      console.log(
        `Routstr daemon started (PID: ${proc.pid}, ${formatElapsed(Date.now() - startedAt)}).`,
      );
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
  const startupTimeoutMs = 10 * 60 * 1000;

  const existingHost = await healthyDaemonHost(port, host);
  if (existingHost) {
    console.log(`Routstr daemon already running on http://${existingHost}:${port}/v1`);
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
