/**
 * Mint reachability probing and targeted (per-operation) wallet recovery.
 *
 * Coco's global recovery sweeps walk every non-terminal operation one at a
 * time; each operation at an unreachable mint costs a full network timeout.
 * This module probes every mint that has stuck operations once, in parallel,
 * and drives recovery per operation only for mints that answer — so one dead
 * mint costs a single short probe instead of N sequential timeouts, and its
 * operations stay parked (exactly as coco's "will retry later" path leaves
 * them) until a later startup finds the mint reachable.
 */
import { normalizeMintUrl, type Manager } from "@cashu/coco-core";
import { logger } from "../../utils/logger";

/** Short probe: a mint that cannot answer /v1/info in 2s slows every op. */
export const MINT_PROBE_TIMEOUT_MS = 2_000;

type OpsApi = Manager["ops"];

/** Structural subset of the ops APIs used to enumerate and recover operations. */
export interface StuckOperationSource {
  send: Pick<OpsApi["send"], "listInFlight" | "refresh" | "diagnostics">;
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
}

export interface RecoveryRunResult {
  /** Operations for which recovery was attempted (not necessarily completed). */
  attempted: number;
  /** Operations skipped because their mint did not answer the probe. */
  skipped: number;
  /** Operations at reachable mints whose recovery still failed. */
  failed: number;
  /** Unreachable mint URL -> number of operations skipped there. */
  skippedMints: Map<string, number>;
}

export interface TargetedRecoveryOptions {
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
        // Startup snapshot only; skip live operations in the driver below.
        await sendService.recoverExecutingOperation(op.raw);
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
    skipped: 0,
    failed: 0,
    skippedMints: new Map(),
  };

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
    if (source[op.kind].diagnostics.isLocked(op.id)) continue;
    if (op.kind === "send" && !["pending", "executing"].includes(op.state)) continue;
    result.attempted++;
    try {
      await recoverStuckOperation(source, sendService, op);
    } catch (error) {
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
