import { logger } from "../utils/logger";

/**
 * Report an unrecoverable error, then exit.
 *
 * The daemon runs detached under a supervisor (pm2 via `routstrd service
 * install`, or the spawning CLI). An uncaught exception means the call stack
 * unwound unexpectedly mid-operation and process state can no longer be
 * trusted. Swallowing it once left a daemon alive with nothing listening
 * while it held both wallet PID locks, so every later start failed on the
 * lock and liveness-only supervisors never restarted it. Exiting lets the
 * supervisor bring up a healthy process instead.
 *
 * The file logger writes synchronously, so the record survives the exit.
 * The error is mirrored to stderr because the daemon's stdout/stderr are
 * redirected to debug.log, which is what the CLI surfaces when the daemon
 * exits early and what pm2 captures. process.exit() runs the synchronous
 * PID-lock exit hooks registered by claimPidFile, releasing the wallet
 * locks on the way out.
 *
 * `exit` is injectable for tests.
 */
export function exitOnUncaughtException(
  error: unknown,
  exit: (code: number) => void = (code) => process.exit(code),
): void {
  logger.error("UNCAUGHT EXCEPTION:", error);
  // Full error object (not just .message): this path means a bug, so the
  // stack is the most useful thing to have in debug.log.
  console.error("UNCAUGHT EXCEPTION:", error);
  exit(1);
}

/**
 * Install the process-level error handlers. Called once at daemon module
 * load, before main() runs.
 *
 * Only uncaught exceptions are fatal. An unhandled rejection means a
 * promise's failure went unobserved; the stack was not unwound and the
 * process is still in a consistent state, so it is logged and the daemon
 * keeps serving.
 */
export function installGlobalErrorHandlers(): void {
  process.on("uncaughtException", (error) => exitOnUncaughtException(error));
  process.on("unhandledRejection", (reason) => {
    logger.error("UNHANDLED REJECTION:", reason);
  });
}
