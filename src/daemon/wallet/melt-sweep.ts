/**
 * Periodic melt-operation sweep.
 *
 * Coco recovers melt operations at startup (`MeltRecoveryApi.run()`) and when a
 * melt request observes its own failure in flight. A melt that was accepted and
 * then left `pending` or `executing` has no timer: if the mint later marks the
 * quote UNPAID (payment failed or expired), nothing notices until the next
 * daemon restart. Meanwhile the operation's input proofs stay reserved and
 * in-flight, so they are excluded from the spendable balance even though the
 * mint already returned them. That is a real production failure mode: a melt
 * can sit pending for hours with its proofs locked while the sats are
 * recoverable.
 *
 * This sweep closes that gap by re-checking every in-flight melt with its mint
 * on an interval. `MeltOpsApi.refresh()` already implements the correct state
 * machine — PAID -> finalize, PENDING -> stay, UNPAID -> rollback — so the sweep
 * only schedules the check, budgets it, and handles mints that do not answer.
 *
 * Invariants:
 * - A melt the mint still reports PENDING is never rolled back. PENDING means
 *   the Lightning HTLC is live; its proofs must stay reserved. Expiry does not
 *   make a PENDING melt recoverable — only the mint flipping it to UNPAID does.
 * - An unreachable or hung mint is left untouched and backed off per mint. A
 *   mint that answers `/v1/info` but stalls on its melt-quote endpoint costs one
 *   timeout per backoff window instead of one per operation per sweep.
 * - Operations a live execute holds are skipped; finalize/rollback still take
 *   coco's fail-fast per-operation lock as the authoritative guard.
 */
import {
  normalizeMintUrl,
  type Manager,
  type MeltOperation,
} from "@cashu/coco-core";
import {
  RecoveryWaitTimeout,
  recoveryKey,
  trackRecovery,
  waitForRecoveryWork,
  type RecoveryWork,
} from "./recovery-work";
import { logger } from "../../utils/logger";
import { withTimeout } from "../../utils/with-timeout";

/**
 * Default cadence. Cheap when idle: one local `listInFlight()` query returns an
 * empty list in the common case, so a short interval costs nothing. Five minutes
 * catches a UNPAID flip within one or two mint polls without hammering anything.
 */
export const MELT_SWEEP_INTERVAL_MS = 5 * 60_000;
/** Per-operation budget for one mint round-trip. */
export const MELT_SWEEP_OP_TIMEOUT_MS = 15_000;
/** Total budget for one pass; in-flight melts are normally zero to two. */
export const MELT_SWEEP_DEADLINE_MS = 60_000;
/** Best-effort drain when the sweep stops mid-pass. */
export const MELT_SWEEP_STOP_DRAIN_MS = 10_000;
/** Backoff for a mint whose melt checks keep timing out. */
export const MELT_SWEEP_BACKOFF_BASE_MS = 5 * 60_000;
export const MELT_SWEEP_BACKOFF_MAX_MS = 60 * 60_000;

export interface MeltSweepSource {
  ops: {
    melt: Pick<
      Manager["ops"]["melt"],
      "listInFlight" | "refresh" | "diagnostics"
    >;
  };
}

export interface MeltMintBackoff {
  failures: number;
  nextAttemptAt: number;
}

export interface MeltSweepState {
  /** Refreshes that outlived their wait; skipped until they settle. */
  outstanding: RecoveryWork;
  /** Per-mint failure counts and the next time they may be tried. */
  mintBackoff: Map<string, MeltMintBackoff>;
}

export interface MeltSweepOptions {
  deadlineMs?: number;
  opTimeoutMs?: number;
  state?: MeltSweepState;
  shouldStop?: () => boolean;
}

export interface MeltSweepResult {
  /** In-flight operations examined in this pass. */
  checked: number;
  /** Operations the mint reported UNPAID and were rolled back. */
  rolledBack: number;
  /** Operations the mint reported PAID and were finalized. */
  finalized: number;
  /** Operations still pending/executing at the mint. */
  stillInFlight: number;
  /** Per-operation waits that exceeded their budget; work remains tracked. */
  timedOut: number;
  /** Attempts that threw a non-timeout error. */
  failed: number;
  /** Locked operations or unfinished work from an earlier pass. */
  skippedLocked: number;
  /** Mint URLs skipped because they are in backoff. */
  skippedMints: Set<string>;
}

export function createMeltSweepState(outstanding: RecoveryWork): MeltSweepState {
  return { outstanding, mintBackoff: new Map() };
}

/**
 * Run one melt sweep pass.
 *
 * Enumeration is a single local query. Each in-flight operation is refreshed
 * within a per-operation budget and the whole pass within a deadline. A mint
 * whose check times out is backed off so the next pass skips its operations
 * until the window expires.
 */
export async function settleMeltOperations(
  source: MeltSweepSource,
  nowMs: number,
  options: MeltSweepOptions = {},
): Promise<MeltSweepResult> {
  const deadlineMs = options.deadlineMs ?? MELT_SWEEP_DEADLINE_MS;
  const opTimeoutMs = options.opTimeoutMs ?? MELT_SWEEP_OP_TIMEOUT_MS;
  const state = options.state ?? createMeltSweepState(new Map());
  const result: MeltSweepResult = {
    checked: 0,
    rolledBack: 0,
    finalized: 0,
    stillInFlight: 0,
    timedOut: 0,
    failed: 0,
    skippedLocked: 0,
    skippedMints: new Set(),
  };

  const inFlight = await source.ops.melt.listInFlight();
  if (inFlight.length === 0) return result;

  const startedAt = Date.now();
  const failedMints = new Set<string>();
  const succeededMints = new Set<string>();

  for (const op of inFlight) {
    if (options.shouldStop?.()) break;
    const remaining = deadlineMs - (Date.now() - startedAt);
    if (remaining <= 0) {
      result.timedOut++;
      break;
    }

    const mintUrl = safeNormalizeMintUrl(op.mintUrl);
    const backoff = state.mintBackoff.get(mintUrl);
    if (backoff && nowMs < backoff.nextAttemptAt) {
      result.skippedMints.add(mintUrl);
      continue;
    }

    const key = recoveryKey("melt", op.id);
    if (state.outstanding.has(key)) {
      result.skippedLocked++;
      continue;
    }
    // Cheap pre-filter; the lock inside finalize/rollback is authoritative.
    if (source.ops.melt.diagnostics.isLocked(op.id)) {
      result.skippedLocked++;
      continue;
    }

    result.checked++;
    const work = trackRecovery(state.outstanding, key, source.ops.melt.refresh(op.id));
    try {
      const updated = await waitForRecoveryWork(
        work,
        Math.min(opTimeoutMs, Math.max(1, remaining)),
      );
      succeededMints.add(mintUrl);
      classifyMeltOutcome(updated, result);
    } catch (error) {
      if (error instanceof RecoveryWaitTimeout) {
        result.timedOut++;
      } else {
        result.failed++;
      }
      failedMints.add(mintUrl);
      logger.warn("Melt sweep could not check an operation", {
        operationId: op.id,
        mintUrl,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  // A mint that answered at least once is healthy again: clear its backoff.
  for (const mintUrl of succeededMints) state.mintBackoff.delete(mintUrl);
  // Mints whose every check failed get an exponentially growing backoff.
  for (const mintUrl of failedMints) {
    if (succeededMints.has(mintUrl)) continue;
    const previous = state.mintBackoff.get(mintUrl);
    const failures = (previous?.failures ?? 0) + 1;
    const delay = Math.min(
      MELT_SWEEP_BACKOFF_BASE_MS * 2 ** Math.min(failures - 1, 10),
      MELT_SWEEP_BACKOFF_MAX_MS,
    );
    state.mintBackoff.set(mintUrl, {
      failures,
      nextAttemptAt: Date.now() + delay,
    });
  }

  return result;
}

export interface StartMeltSweepOptions {
  intervalMs?: number;
  opTimeoutMs?: number;
  deadlineMs?: number;
}

/**
 * Start the periodic melt sweep. Returns a stop function that waits for the
 * running pass and briefly drains outstanding refreshes.
 *
 * The interval is read from `ROUTSTRD_MELT_SWEEP_INTERVAL_MS`; setting
 * `ROUTSTRD_MELT_SWEEP_DISABLED=1` disables the sweep entirely. The timer is a
 * chained `setTimeout`, not `setInterval`, so a slow pass cannot stack.
 */
export function startMeltSweep(
  source: MeltSweepSource,
  outstanding: RecoveryWork,
  options: StartMeltSweepOptions = {},
): () => Promise<void> {
  const intervalMs = options.intervalMs ?? readIntervalFromEnv();
  if (!Number.isFinite(intervalMs) || intervalMs <= 0) {
    logger.log("Melt sweep disabled.");
    return async () => {};
  }

  let stopped = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let inFlight: Promise<void> = Promise.resolve();
  const state = createMeltSweepState(outstanding);
  let unreachableBefore = 0;

  const tick = async () => {
    if (stopped) return;
    inFlight = settleMeltOperations(source, Date.now(), {
      state,
      shouldStop: () => stopped,
      opTimeoutMs: options.opTimeoutMs,
      deadlineMs: options.deadlineMs,
    }).then(
      (result) => {
        const unreachable = result.timedOut + result.failed;
        // Report actions and reachability transitions only, so a healthy
        // idle wallet stays quiet.
        if (result.rolledBack || result.finalized) {
          logger.log(
            `Melt sweep: checked ${result.checked}, rolled back ${result.rolledBack}, ` +
              `finalized ${result.finalized}, still in flight ${result.stillInFlight}, ` +
              `unreachable ${unreachable}`,
          );
        }
        if (unreachable > 0 && unreachableBefore === 0) {
          logger.warn(
            `Could not check ${unreachable} in-flight melt(s); will keep retrying with backoff`,
          );
        } else if (unreachable === 0 && unreachableBefore > 0) {
          logger.log("In-flight melt checks are reaching the mint again");
        }
        unreachableBefore = unreachable;
      },
      (error: unknown) => {
        logger.warn(
          `Melt sweep failed: ${error instanceof Error ? error.message : String(error)}`,
        );
      },
    );
    await inFlight;
    if (!stopped) timer = setTimeout(tick, intervalMs);
  };
  timer = setTimeout(tick, intervalMs);

  return async () => {
    stopped = true;
    if (timer !== undefined) clearTimeout(timer);
    await inFlight;
    await withTimeout(
      Promise.allSettled(state.outstanding.values()),
      MELT_SWEEP_STOP_DRAIN_MS,
      "Melt sweep stop timed out",
    ).catch(() => {});
  };
}

function classifyMeltOutcome(op: MeltOperation, result: MeltSweepResult): void {
  switch (op.state) {
    case "rolled_back":
      result.rolledBack++;
      break;
    case "finalized":
      result.finalized++;
      break;
    default:
      // pending, executing, prepared, init, rolling_back: leave for the next pass.
      result.stillInFlight++;
      break;
  }
}

function safeNormalizeMintUrl(mintUrl: string): string {
  try {
    return normalizeMintUrl(mintUrl);
  } catch {
    return mintUrl;
  }
}

function readIntervalFromEnv(): number {
  if (process.env.ROUTSTRD_MELT_SWEEP_DISABLED === "1") return 0;
  const raw = process.env.ROUTSTRD_MELT_SWEEP_INTERVAL_MS;
  const parsed = raw ? Number(raw) : Number.NaN;
  return Number.isFinite(parsed) && parsed > 0 ? parsed : MELT_SWEEP_INTERVAL_MS;
}
