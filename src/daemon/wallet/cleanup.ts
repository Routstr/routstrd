/**
 * Pure selection helpers for the wallet cleanup command.
 *
 * These helpers decide *which* stuck operations are safe to clear. The actual
 * state transitions are applied by the in-process coco wallet client so that
 * coco-core's operation services emit their normal events and release proof
 * reservations. Keeping the selection logic here makes it easy to unit test
 * without a wallet database or network access.
 */

export interface MintCleanupCandidate {
  id: string;
  state: string;
  /** Quote expiry in epoch seconds. `0` means unknown/not applicable. */
  expiry: number;
  /** Last update time in epoch milliseconds. */
  updatedAt: number;
}

export interface NonMintCleanupCandidate {
  id: string;
  state: string;
  /** Last update time in epoch milliseconds. */
  updatedAt: number;
}

export interface CleanupSelectionOptions<
  TMint extends MintCleanupCandidate,
  TSend extends NonMintCleanupCandidate,
  TMelt extends NonMintCleanupCandidate,
> {
  mints: TMint[];
  sends: TSend[];
  melts: TMelt[];
  nowMs: number;
  minAgeMs: number;
}

export interface CleanupSelection<
  TMint extends MintCleanupCandidate,
  TSend extends NonMintCleanupCandidate,
  TMelt extends NonMintCleanupCandidate,
> {
  mintsToFail: TMint[];
  sendsToReclaim: TSend[];
  meltsToCancel: TMelt[];
}

/**
 * Select stuck operations that are old enough to be safe to clear.
 *
 * - Pending mint quotes are failed only when their bolt11 quote has expired
 *   (an expired Lightning invoice can never be paid).
 * - Pending sends are reclaimed (rolled back) only when they are older than
 *   `minAgeMs`, so we never roll back a token that a receiver might still
 *   legitimately claim.
 * - Prepared melts are cancelled under the same age guard.
 */
export function selectCleanupOperations<
  TMint extends MintCleanupCandidate,
  TSend extends NonMintCleanupCandidate,
  TMelt extends NonMintCleanupCandidate,
>(
  options: CleanupSelectionOptions<TMint, TSend, TMelt>,
): CleanupSelection<TMint, TSend, TMelt> {
  const { mints, sends, melts, nowMs, minAgeMs } = options;

  // Expiry alone is enough for mint quotes: once a bolt11 quote has expired it
  // can never be paid, regardless of when the watcher last touched the row.
  const mintsToFail = mints.filter(
    (op) =>
      op.state === "pending" &&
      op.expiry > 0 &&
      op.expiry * 1000 <= nowMs,
  );

  const sendsToReclaim = sends.filter(
    (op) => op.state === "pending" && nowMs - op.updatedAt >= minAgeMs,
  );

  const meltsToCancel = melts.filter(
    (op) => op.state === "prepared" && nowMs - op.updatedAt >= minAgeMs,
  );

  return { mintsToFail, sendsToReclaim, meltsToCancel };
}
