import { existsSync, readFileSync } from "fs";
import { isDaemonRunning } from "./daemon-client";
import { defaultIsProcessRunning } from "../daemon/wallet/coco-client";
import { walletPidPath } from "../daemon/wallet/paths";
import { formatElapsed } from "../start-daemon";

/**
 * Wait for a daemon that was asked to stop (POST /stop) to fully exit.
 *
 * The daemon shuts down gracefully: it stops accepting new connections
 * right away, but keeps serving ongoing requests until they finish; only
 * then does it dispose of the wallet, release the wallet PID lock, and
 * exit. Spawning a replacement before the lock is released makes it abort
 * with "Cannot claim the routstrd wallet lock", so restarts must wait for
 * the old process to fully exit — telling the user why it is taking a
 * while ("Finishing all ongoing requests...") and how to force it
 * ("run 'kill -9 <PID>' to force stop") instead of racing ahead.
 */
export interface WaitForDaemonToExitOptions {
  /** Wallet PID lock file held by the running daemon. */
  pidFilePath?: string;
  /** Returns true while the daemon still answers /health. */
  isHealthy?: () => Promise<boolean>;
  /** Returns the live PID recorded in the wallet lock file, or null when the
   * file is gone or unreadable. */
  readLockPid?: (pidFilePath: string) => number | null;
  /** Returns true when a PID is alive (zombies count as dead). */
  isProcessRunning?: (pid: number) => boolean;
  sleep?: (ms: number) => Promise<void>;
  log?: (message: string) => void;
  /** How long to wait for the health check to stop responding after /stop. */
  healthTimeoutMs?: number;
  /** Silent window before reporting that ongoing requests are finishing. */
  drainGraceMs?: number;
  /** How long to wait for the old daemon to exit and release the lock. */
  drainTimeoutMs?: number;
  /** How often to re-report that ongoing requests are still finishing. */
  drainHeartbeatMs?: number;
  /** Interval between health and lock polls. */
  pollIntervalMs?: number;
}

/** How often to re-report that the daemon is still finishing requests. */
const DRAIN_HEARTBEAT_MS = 10_000;

function defaultReadLockPid(pidFilePath: string): number | null {
  if (!existsSync(pidFilePath)) return null;
  try {
    const pid = Number.parseInt(readFileSync(pidFilePath, "utf8").trim(), 10);
    return Number.isInteger(pid) && pid > 0 ? pid : null;
  } catch {
    return null;
  }
}

export async function waitForDaemonToExit(
  options: WaitForDaemonToExitOptions = {},
): Promise<void> {
  const {
    pidFilePath = walletPidPath(),
    isHealthy = isDaemonRunning,
    readLockPid = defaultReadLockPid,
    isProcessRunning = defaultIsProcessRunning,
    sleep = (ms: number) =>
      new Promise<void>((resolve) => setTimeout(resolve, ms)),
    log = (message: string) => console.log(message),
    healthTimeoutMs = 10_000,
    drainGraceMs = 1_000,
    drainTimeoutMs = 10 * 60_000,
    drainHeartbeatMs = DRAIN_HEARTBEAT_MS,
    pollIntervalMs = 100,
  } = options;

  // Phase 1: the daemon stops accepting new connections promptly after
  // /stop, so its health check should stop responding within seconds.
  const healthDeadline = Date.now() + healthTimeoutMs;
  while (await isHealthy()) {
    if (Date.now() >= healthDeadline) {
      throw new Error(
        `routstrd did not stop within ${Math.round(healthTimeoutMs / 1000)} seconds`,
      );
    }
    await sleep(pollIntervalMs);
  }

  // Phase 2: the process stays alive while it finishes ongoing requests and
  // disposes of the wallet. The wallet PID lock is released only right before
  // the process exits, so wait for it (or for the recorded PID to die). Both
  // progress messages offer 'kill -9 <PID>': only SIGKILL interrupts a stuck
  // drain — a plain SIGTERM just re-runs the same graceful shutdown.
  const drainStartedAt = Date.now();
  const drainDeadline = drainStartedAt + drainTimeoutMs;
  let drainAnnounced = false;
  let nextHeartbeatAt = 0;

  for (;;) {
    const lockPid = readLockPid(pidFilePath);
    if (lockPid === null || !isProcessRunning(lockPid)) return;

    const now = Date.now();
    if (now >= drainDeadline) {
      throw new Error(
        `the previous daemon (PID ${lockPid}) did not finish its ongoing requests within ` +
          `${formatElapsed(drainTimeoutMs)} and still holds the wallet lock at ${pidFilePath}. ` +
          `Wait for it to exit and try again, or run 'kill -9 ${lockPid}' to force it.`,
      );
    }

    if (!drainAnnounced && now - drainStartedAt >= drainGraceMs) {
      drainAnnounced = true;
      log(
        `  Finishing all ongoing requests... (run 'kill -9 ${lockPid}' to force stop)`,
      );
      nextHeartbeatAt = now + drainHeartbeatMs;
    } else if (drainAnnounced && now >= nextHeartbeatAt) {
      log(
        `  Still finishing ongoing requests (${formatElapsed(now - drainStartedAt)} elapsed)... ` +
          `(run 'kill -9 ${lockPid}' to force stop)`,
      );
      nextHeartbeatAt += drainHeartbeatMs;
    }

    await sleep(pollIntervalMs);
  }
}
