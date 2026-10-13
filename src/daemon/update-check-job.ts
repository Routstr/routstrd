import { logger } from "../utils/logger";
import {
  checkRoutstrdUpdate,
  type RoutstrdUpdateInfo,
} from "../utils/update-checker";
import { writeUpdateState, type UpdateState } from "../utils/update-state";

/**
 * How often the daemon re-checks for a newer routstrd. Slow on purpose: the
 * check is a politeness courtesy, not something anyone should route traffic by
 * — an hour keeps the cached answer reasonably current without hammering the
 * registry/GitHub.
 */
export const DEFAULT_UPDATE_CHECK_INTERVAL_MS = 60 * 60 * 1000;

/** Let startup/model bootstrap settle before the first background check. */
export const DEFAULT_UPDATE_CHECK_INITIAL_DELAY_MS = 30 * 1000;

/**
 * Bound on the network lookups. A background pass may wait longer than the
 * interactive `start`/`restart` prompt, since nothing is blocked on it.
 */
export const BACKGROUND_UPDATE_CHECK_TIMEOUT_MS = 30 * 1000;

export type UpdateCheckFn = (options: {
  timeoutMs: number;
}) => Promise<RoutstrdUpdateInfo>;

export interface UpdateCheckJobDeps {
  /** Performs the check; defaults to the shared routstrd checker. */
  check?: UpdateCheckFn;
  /** Persists the result; defaults to the on-disk update state. */
  save?: (state: UpdateState) => void;
  intervalMs?: number;
  initialDelayMs?: number;
  timeoutMs?: number;
  enabled?: boolean | (() => boolean);
  /** Injectable clock (tests). */
  now?: () => number;
}

export interface UpdateCheckJob {
  /** Begin the delayed, recurring checks. Idempotent. */
  start(): void;
  /** Cancel any pending check. Idempotent. */
  stop(): void;
  /** Run a single check immediately (exposed for tests and manual triggers). */
  runOnce(): Promise<void>;
}

/**
 * Low-frequency background job that keeps a cached answer to "is a newer
 * routstrd available?" in `${CONFIG_DIR}/update-state.json`, so the CLI and TUI
 * can surface it without each doing their own network call.
 *
 * Every failure is swallowed (logged at debug): an update check must never
 * disturb the daemon.
 */
export function createUpdateCheckJob(
  deps: UpdateCheckJobDeps = {},
): UpdateCheckJob {
  const intervalMs = deps.intervalMs ?? DEFAULT_UPDATE_CHECK_INTERVAL_MS;
  const initialDelayMs =
    deps.initialDelayMs ?? DEFAULT_UPDATE_CHECK_INITIAL_DELAY_MS;
  const timeoutMs = deps.timeoutMs ?? BACKGROUND_UPDATE_CHECK_TIMEOUT_MS;
  const isEnabled = () => typeof deps.enabled === "function"
    ? deps.enabled() : deps.enabled !== false;
  const now = deps.now ?? Date.now;
  const check: UpdateCheckFn =
    deps.check ?? (({ timeoutMs: ms }) => checkRoutstrdUpdate({ timeoutMs: ms }));
  const save = deps.save ?? writeUpdateState;

  let timer: ReturnType<typeof setTimeout> | null = null;
  let active = false;
  let running = false;
  let lastAdvertisedUpdate = false;

  const runOnce = async (): Promise<void> => {
    if (running || !isEnabled()) return;
    running = true;
    try {
      const info = await check({ timeoutMs });
      // The shared checker reports lookup failures as unknown, not exceptions.
      // Preserve the last successful result and its original expiry timestamp.
      if (info.latest === null || !isEnabled()) return;
      save({
        current: info.current,
        latest: info.latest,
        hasUpdate: info.hasUpdate,
        checkedAt: new Date(now()).toISOString(),
      });
      if (info.hasUpdate && !lastAdvertisedUpdate) {
        logger.log(
          `Update available: routstrd v${info.current} -> v${info.latest ?? "unknown"}`,
        );
      }
      lastAdvertisedUpdate = info.hasUpdate;
      logger.debug(
        `Update check complete (current v${info.current}, latest ${info.latest ?? "unknown"}).`,
      );
    } catch (error) {
      logger.debug("Background update check failed:", error);
    } finally {
      running = false;
    }
  };

  const scheduleNext = (): void => {
    if (!active) return;
    timer = setTimeout(() => {
      void runOnce().finally(scheduleNext);
    }, intervalMs);
    // Never keep the daemon process alive solely for an update check.
    timer.unref?.();
  };

  const start = (): void => {
    if (deps.enabled === false || active) return;
    active = true;
    logger.log(
      `Starting background update check (every ${Math.round(intervalMs / 3_600_000)}h)`,
    );
    timer = setTimeout(() => {
      void runOnce().finally(scheduleNext);
    }, initialDelayMs);
    timer.unref?.();
  };

  const stop = (): void => {
    active = false;
    if (timer) {
      clearTimeout(timer);
      timer = null;
    }
  };

  return { start, stop, runOnce };
}
