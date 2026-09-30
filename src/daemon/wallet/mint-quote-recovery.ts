/**
 * Pure helpers for PAID mint-quote recovery.
 *
 * A mint quote can be PAID at the mint while its local operation is still
 * `pending` (the Lightning payment landed before expiry while the daemon was
 * down, so no local observation was ever recorded) or even terminally
 * `failed` (coco gives up when the mint refuses to sign, for example after the
 * invoice expiry). The paid sats are claimable either way: NUT-04 lets the
 * holder submit outputs for any quote id while `amount_issued < amount_paid`.
 *
 * Recovery therefore has to ask the mint what it thinks, then re-issue the
 * quote. These helpers decide *what* to do from a remote observation; the
 * actual state transitions are applied by the in-process coco wallet client
 * so coco-core's operation services emit their normal events and release
 * proof reservations. Keeping the decisions here makes them unit testable
 * without a wallet database or network access.
 */

/** Subset of coco's mint operation rows that recovery needs. */
export interface MintQuoteRecoveryCandidate {
  id: string;
  mintUrl: string;
  quoteId?: string;
  state: string;
  /** Quote amount in sats. */
  amount: number;
  /** Quote expiry in epoch seconds. `0` means unknown/not applicable. */
  expiry: number;
  /** Last quote state observed from the mint (UNPAID, PAID, ISSUED). */
  lastObservedRemoteState?: string;
  error?: string;
}

/** Coco's classification of a fresh remote quote check. */
export type PendingMintCheckCategory =
  | "waiting"
  | "ready"
  | "completed"
  | "terminal";

/** What recovery should do with a quote after checking it with the mint. */
export type MintQuoteRecoveryDecision =
  | { action: "finalize"; observedRemoteState: "PAID" | "ISSUED" }
  | { action: "waiting" }
  | { action: "terminal" };

/**
 * Map a remote quote check onto a recovery action.
 *
 * - `ready` means the mint reports the quote PAID but never issued: submit the
 *   operation's stored outputs to claim the sats.
 * - `completed` means the mint already issued it: recover the signatures
 *   (NUT-09) instead of minting again.
 * - `waiting` means the mint still reports the quote UNPAID: nothing is
 *   claimable, so leave the operation alone.
 * - `terminal` means the quote can no longer be issued (for example the mint
 *   refused an expired quote). coco persists that verdict as a failed
 *   operation, so recovery must report it rather than treat it as progress.
 */
export function classifyMintQuoteObservation(
  category: PendingMintCheckCategory,
): MintQuoteRecoveryDecision {
  switch (category) {
    case "ready":
      return { action: "finalize", observedRemoteState: "PAID" };
    case "completed":
      return { action: "finalize", observedRemoteState: "ISSUED" };
    case "waiting":
      return { action: "waiting" };
    case "terminal":
      return { action: "terminal" };
  }
}

export interface MintQuoteRecoverySelectionOptions<
  T extends MintQuoteRecoveryCandidate,
> {
  mints: T[];
  /**
   * Also consider terminally failed operations. Off by default: re-opening a
   * failed operation is a mutation, so only an explicit user-invoked recovery
   * may do it. Startup recovery must never resurrect quotes on its own.
   */
  includeFailed?: boolean;
}

export interface MintQuoteRecoverySelection<
  T extends MintQuoteRecoveryCandidate,
> {
  /** Pending (or executing) operations that need a fresh mint observation. */
  pending: T[];
  /** Failed operations the caller may re-open and retry. */
  failed: T[];
}

/**
 * Split operations into those recovery should check and those that were
 * already given up on.
 *
 * Every `pending` operation is selected: only the mint knows whether an
 * expired quote was paid before the local invoice ran out. `executing`
 * operations are recovered too, since a crash mid-mint leaves outputs that
 * may already be signed.
 */
export function selectMintQuotesForRecovery<
  T extends MintQuoteRecoveryCandidate,
>(options: MintQuoteRecoverySelectionOptions<T>): MintQuoteRecoverySelection<T> {
  const { mints, includeFailed = false } = options;
  const pending = mints.filter(
    (op) => op.state === "pending" || op.state === "executing",
  );
  const failed = includeFailed
    ? mints.filter((op) => op.state === "failed")
    : [];
  return { pending, failed };
}
