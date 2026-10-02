/**
 * Mint reachability probing and targeted (per-operation) wallet recovery.
 *
 * Coco's global recovery sweeps walk every non-terminal operation one at a
 * time; each operation at an unreachable mint costs a full network timeout.
 * This module probes every mint that has stuck operations once, in parallel,
 * and drives recovery per operation only for mints that answer — so one dead
 * mint costs a single short probe instead of N sequential timeouts, and its
 * operations stay parked (exactly as coco's "will retry later" path leaves
 * them) until an explicit mid-session recovery (see recoverStuckOperations
 * in coco-client.ts) or a later startup finds the mint reachable.
 */
import { normalizeMintUrl, type Manager } from "@cashu/coco-core";
import { recoveryKey, trackRecovery, waitForRecoveryWork, RecoveryWaitTimeout, type RecoveryWork } from "./recovery-work";
import { logger } from "../../utils/logger";

/** Short probe: a mint that cannot answer /v1/info in 2s slows every op. */
export const MINT_PROBE_TIMEOUT_MS = 2_000;

type OpsApi = Manager["ops"];

/** Structural subset of the ops APIs used to enumerate and recover operations. */
export interface StuckOperationSource {
  send: Pick<OpsApi["send"], "listInFlight" | "refresh" | "diagnostics" | "get">;
  melt: Pick<OpsApi["melt"], "listInFlight" | "refresh" | "diagnostics">;
  receive: Pick<OpsApi["receive"], "listInFlight" | "refresh" | "diagnostics">;
  mint: Pick<OpsApi["mint"], "listInFlight" | "refresh" | "diagnostics">;
}

export type StuckOperationKind = "send" | "melt" | "receive" | "mint";

export interface StuckOperation {
  kind: StuckOperationKind;
  id: string;
  /** Normalized mint URL. */
  mintUrl: string;
  state: string;
  /** The operation object as returned by the API (needed by service-level recovery). */
  raw: unknown;
}

/**
 * The per-operation send recovery entry points coco keeps private. Send is the
 * only operation family whose public `refresh()` does not cover `executing`
 * operations; routstrd already reaches into coco internals the same way for
 * `mintOperationService` (see coco-client.ts).
 */
export interface SendRecoveryService {
  recoverExecutingOperation(op: unknown): Promise<void>;
  /**
   * coco's per-operation lock. It is fail-fast: acquiring an id a live
   * execute/finalize/recover already holds throws OperationInProgressError
   * instead of waiting. Holding it across the state re-read and the drive
   * makes executing-send recovery atomic against a live execute — the same
   * pattern reopenFailedMintOperation uses for mint operations
   * (see coco-client.ts).
   */
  acquireOperationLock(operationId: string): Promise<() => void>;
}

export interface RecoveryRunResult {
  /** Operations for which recovery was attempted (not necessarily completed). */
  attempted: number;
  /** Timed-out waits, also included in attempted; underlying work remains tracked. */
  timedOut: number;
  /** Locked operations or unfinished work from another pass; retry later. */
  busy: number;
  /** Operations skipped for unreachable mints, shutdown, or pass budget exhaustion. */
  skipped: number;
  /** Attempts that threw a non-busy, non-timeout error. */
  failed: number;
  /** Unreachable mint URL -> number of operations skipped there. */
  skippedMints: Map<string, number>;
}

export interface TargetedRecoveryOptions {
  outstanding?: RecoveryWork;
  timeoutMs?: number;
  deadlineMs?: number;
  shouldStop?: () => boolean;
  probeTimeoutMs?: number;
  fetchImpl?: typeof fetch;
  /** Operation families to recover. Defaults to all four. */
  kinds?: StuckOperationKind[];
  /** Pre-collected operations (e.g. from startup gating); default: enumerate now. */
  stuckOperations?: StuckOperation[];
  /** Pre-probed unreachable mints; default: probe now. */
  unreachableMints?: Set<string>;
  /** Called once per unreachable mint with the number of skipped operations. */
  onSkippedMint?: (mintUrl: string, opCount: number) => void;
}

function asStuckOperations(
  kind: StuckOperationKind,
  ops: Array<{ id: string; mintUrl: string; state: string }>,
): StuckOperation[] {
  const stuck: StuckOperation[] = [];
  for (const op of ops) {
    try {
      stuck.push({
        kind,
        id: op.id,
        mintUrl: normalizeMintUrl(op.mintUrl),
        state: op.state,
        raw: op,
      });
    } catch {
      // Preserve malformed persisted URLs; the probe will classify them as
      // unreachable rather than attempting recovery against an invalid URL.
      stuck.push({ kind, id: op.id, mintUrl: op.mintUrl, state: op.state, raw: op });
    }
  }
  return stuck;
}

/**
 * Enumerate every non-terminal operation across all four operation families.
 * Returns [] quickly when nothing is stuck, which is the common case.
 */
export async function collectStuckOperations(
  source: StuckOperationSource,
): Promise<StuckOperation[]> {
  const [sends, melts, receives, mints] = await Promise.all([
    source.send.listInFlight(),
    source.melt.listInFlight(),
    source.receive.listInFlight(),
    source.mint.listInFlight(),
  ]);
  return [
    ...asStuckOperations("send", sends),
    ...asStuckOperations("melt", melts),
    ...asStuckOperations("receive", receives),
    ...asStuckOperations("mint", mints),
  ];
}

/**
 * Probe each mint once, in parallel, and return the set of mint URLs that did
 * not answer `GET /v1/info` in time. A mint that answers with an HTTP error is
 * still "reachable" — its operations will fail with a real mint error instead
 * of a network timeout, which is the information recovery needs.
 */
export async function probeMintReachability(
  mintUrls: string[],
  options: { timeoutMs?: number; fetchImpl?: typeof fetch } = {},
): Promise<Set<string>> {
  const fetcher = options.fetchImpl ?? fetch;
  const timeoutMs = options.timeoutMs ?? MINT_PROBE_TIMEOUT_MS;
  const unreachable = new Set<string>();

  await Promise.all(
    mintUrls.map(async (mintUrl) => {
      try {
        await fetcher(`${normalizeMintUrl(mintUrl)}/v1/info`, {
          signal: AbortSignal.timeout(timeoutMs),
        });
      } catch (error) {
        logger.debug("Mint did not answer recovery probe", {
          mintUrl,
          error: error instanceof Error ? error.message : String(error),
        });
        unreachable.add(mintUrl);
      }
    }),
  );

  return unreachable;
}

async function recoverStuckOperation(
  source: StuckOperationSource,
  sendService: SendRecoveryService,
  op: StuckOperation,
): Promise<void> {
  switch (op.kind) {
    case "send":
      if (op.state === "pending") {
        // Public API: actively re-checks the proofs with the mint.
        await source.send.refresh(op.id);
      } else if (op.state === "executing") {
        // Fail closed: the lock and the drive are private coco internals
        // (written against coco-core 1.0.1), so a coco bump that renames them
        // must fail this operation loudly instead of corrupting it.
        if (
          typeof sendService.acquireOperationLock !== "function" ||
          typeof sendService.recoverExecutingOperation !== "function"
        ) {
          throw new Error(
            "coco sendOperationService recovery internals are unavailable; refusing to recover an executing send",
          );
        }
        // recoverExecutingOperation takes no lock and does no state re-read,
        // so take coco's fail-fast per-operation lock first (throws
        // OperationInProgressError when a live execute holds the operation —
        // the driver counts that as busy, not failed) and re-read the state
        // under it: the snapshot op must still be executing before we drive.
        const release = await sendService.acquireOperationLock(op.id);
        try {
          const latest = await source.send.get(op.id);
          if (latest?.state === "executing") {
            await sendService.recoverExecutingOperation(latest);
          }
        } finally {
          release();
        }
      }
      // prepared / rolling_back: the global sweep only warns; nothing to do.
      return;
    case "melt":
      // refresh() covers both pending and executing melt operations.
      await source.melt.refresh(op.id);
      return;
    case "receive":
      // refresh() actively recovers executing receive operations.
      await source.receive.refresh(op.id);
      return;
    case "mint":
      // refresh() covers both pending and executing mint operations.
      await source.mint.refresh(op.id);
      return;
  }
}

/**
 * Recover every stuck operation whose mint answers a reachability probe,
 * skipping operations at unreachable mints. Operations are recovered
 * sequentially per mint (matching the global sweep's ordering guarantees);
 * skipped operations are left untouched for a later pass, which is exactly
 * what coco's own "Could not reach mint for recovery, will retry later" path
 * does with them.
 */
export async function runTargetedRecovery(
  source: StuckOperationSource,
  sendService: SendRecoveryService,
  options: TargetedRecoveryOptions = {},
): Promise<RecoveryRunResult> {
  const result: RecoveryRunResult = {
    attempted: 0,
    timedOut: 0,
    busy: 0,
    skipped: 0,
    failed: 0,
    skippedMints: new Map(),
  };

  const timeoutMs = options.timeoutMs ?? 15_000;
  const deadlineMs = options.deadlineMs ?? 60_000;
  if (![timeoutMs, deadlineMs].every(n => Number.isFinite(n) && n > 0)) {
    throw new Error("Recovery budgets must be positive finite numbers");
  }
  const deadline = Date.now() + deadlineMs;
  const outstanding = options.outstanding ?? new Map();
  const kinds = options.kinds ?? ["send", "melt", "receive", "mint"];
  const stuck = (options.stuckOperations ?? (await collectStuckOperations(source))).filter(
    (op) => kinds.includes(op.kind),
  );
  if (stuck.length === 0) return result;

  const unreachable =
    options.unreachableMints ??
    (await probeMintReachability([...new Set(stuck.map((op) => op.mintUrl))], {
      timeoutMs: options.probeTimeoutMs,
      fetchImpl: options.fetchImpl,
    }));

  for (const mintUrl of unreachable) {
    const count = stuck.filter((op) => op.mintUrl === mintUrl).length;
    result.skippedMints.set(mintUrl, count);
    result.skipped += count;
    options.onSkippedMint?.(mintUrl, count);
  }

  for (const op of stuck) {
    if (unreachable.has(op.mintUrl)) continue;
    if (options.shouldStop?.() || Date.now() >= deadline) { result.skipped++; continue; }
    const key = recoveryKey(op.kind, op.id);
    if (outstanding.has(key)) { result.busy++; continue; }
    // Cheap pre-filter for live operations; the lock inside
    // recoverStuckOperation is what actually makes the drive atomic.
    if (source[op.kind].diagnostics.isLocked(op.id)) {
      result.busy++;
      continue;
    }
    if (op.kind === "send" && !["pending", "executing"].includes(op.state)) continue;
    result.attempted++;
    try {
      const work = trackRecovery(outstanding, key, recoverStuckOperation(source, sendService, op));
      await waitForRecoveryWork(work, Math.min(timeoutMs, Math.max(1, deadline - Date.now())));
    } catch (error) {
      if (error instanceof RecoveryWaitTimeout) { result.timedOut++; continue; }
      // A live execute grabbed the operation between the isLocked pre-filter
      // and the lock acquisition: busy, not failed — leave it for a later
      // pass. Name-matched like runMintQuoteRecovery does, because the error
      // crosses a package boundary.
      if (error instanceof Error && error.name === "OperationInProgressError") {
        result.busy++;
        continue;
      }
      // Same semantics as coco's tryRecover*: leave the operation for the
      // next pass. A reachable mint can still reject a specific operation.
      result.failed++;
      logger.warn("Targeted operation recovery did not complete", {
        kind: op.kind,
        operationId: op.id,
        mintUrl: op.mintUrl,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  return result;
}
