import type { HistoryEntry } from "@cashu/coco-core";

/**
 * Contract shared by every wallet implementation.
 *
 * The wallet runs in-process (`createCocoClient` in `./coco-client`); this
 * module only describes what the rest of routstrd is allowed to ask of it.
 * Historically this lived in a `cocod-client` module that also shipped an
 * HTTP/unix-socket client for the external `cocod` binary. That client was
 * removed once the in-process wallet replaced it — see `./migration` and the
 * `legacyCocod*` path helpers in `./paths` for the migration-only code that
 * still knows about external cocod installs.
 */

export type WalletRuntimeState =
  | "UNINITIALIZED"
  | "LOCKED"
  | "UNLOCKED"
  | "RECOVERING"
  | "ERROR";

/** Live progress for background wallet recovery started at daemon startup. */
export interface WalletRecoveryProgress {
  state: "RECOVERING" | "UNLOCKED" | "ERROR";
  /** Current recovery phase, e.g. "Mint recovery" or "done". */
  phase: string;
  pendingSends: number;
  inflightProofs: number;
  pendingMints: number;
  /** Expired unpaid mint quotes failed locally without a mint round-trip. */
  failedMintQuotes: number;
  error?: string;
}

/** NPC (npubx.cash) Lightning address details for this wallet. */
export interface NpcAddress {
  /** Full Lightning address, e.g. "alice@npubx.cash" (npub fallback when no username is set). */
  address: string;
  /** NPC username, when one has been claimed. */
  name?: string;
  /** Nostr hex pubkey of the NPC account (only available from the in-process wallet). */
  pubkey?: string;
}

/** Result of an NPC username claim attempt. */
export interface NpcUsernameResult {
  success: boolean;
  /** Present when NPC requires payment to claim the username. */
  paymentRequest?: {
    amount?: number;
    mints?: string[];
    [key: string]: unknown;
  };
}

/** Options for the wallet cleanup command. */
export interface WalletCleanupOptions {
  /** Only clean up operations for this mint URL. */
  mintUrl?: string;
  /** Minimum operation age in milliseconds (defaults to 7 days / 1 week). */
  minAgeMs?: number;
  /** Report what would be cleaned without applying changes. */
  dryRun?: boolean;
  /**
   * Fail expired mint quotes without confirming UNPAID with the mint. Only for
   * operators who accept the risk of stranding a quote that was paid before
   * its invoice expired; recovery is the safe default.
   */
  force?: boolean;
}

/** Summary of a wallet cleanup run. */
export interface WalletCleanupResult {
  dryRun: boolean;
  /** Expired quotes selected for checking; dry runs do not contact the mint. */
  mintQuoteCandidates: number;
  /** Number actually marked failed (always zero in a dry run). */
  failedMintQuotes: number;
  /** Expired quotes kept pending because they are paid/issued or unverified. */
  leftForRecovery: number;
  /** Number of stale pending send operations reclaimed. */
  reclaimedSends: number;
  /** Number of stale prepared melt operations cancelled. */
  cancelledMelts: number;
  /** Number of in-flight operations that were left untouched. */
  skipped: number;
  errors: Array<{ operationId: string; error: string }>;
}

export class WalletHttpError extends Error {
  status: number;

  constructor(status: number, message: string) {
    super(message);
    this.name = "WalletHttpError";
    this.status = status;
  }
}

/** Progress of a Lightning top-up created with `receiveBolt11`. */
export interface MintQuoteStatus {
  operationId: string;
  state: "pending" | "executing" | "finalized" | "failed";
  /** Last quote state reported by the mint (UNPAID, PAID, ISSUED). */
  mintState?: string;
  amount: number;
  mintUrl: string;
  error?: string;
}

/** Options for explicit PAID mint-quote recovery. */
export interface WalletMintQuoteRecoveryOptions {
  /** Target only these operation ids (may include failed operations). */
  operationIds?: string[];
  /** Re-open failed operations instead of skipping them. */
  includeFailed?: boolean;
  /** Per-quote mint timeout in milliseconds. */
  timeoutMs?: number;
}

/** Summary of a PAID mint-quote recovery run. */
export interface WalletMintQuoteRecoveryResult {
  /** Operations whose quote state was checked with the mint. */
  checked: number;
  /** Operations whose paid sats were minted or restored. */
  recovered: number;
  /** Quotes the mint still reports UNPAID; left pending. */
  waiting: number;
  /** Quotes the mint can no longer issue. */
  terminal: number;
  /** Failed operations moved back to pending before checking. */
  reopened: number;
  /** Operations left to a later run (mint unreachable, budget spent, non-terminal). */
  retryable: number;
  /** Operations skipped because an earlier recovery of them is still running. */
  busy: number;
  errors: Array<{ operationId: string; error: string }>;
}

/** Summary of a stuck-operation (send/melt/mint) recovery run. */
export interface WalletStuckOperationRecoveryResult {
  /** Timed-out waits; the underlying operation remains tracked. */
  timedOut: number;
  /** Operations for which recovery was attempted (not necessarily completed). */
  attempted: number;
  /** Locked operations or unfinished work from another pass; retry later. */
  busy: number;
  /** Operations skipped for unreachable mints, shutdown, or pass budget exhaustion. */
  skipped: number;
  /** Operations at reachable mints whose recovery still failed. */
  failed: number;
  /** Unreachable mint URL -> number of operations skipped there. */
  skippedMints: Record<string, number>;
}

/** Options for the wallet proof-state check command. */
export interface WalletProofCheckOptions {
  /** Only check proofs held for this mint URL. */
  mintUrl?: string;
  /** Report what would be marked spent without applying changes. */
  dryRun?: boolean;
  /** Per-mint check timeout in milliseconds (defaults to 30s). */
  timeoutMs?: number;
}

/** Per-mint outcome of a wallet proof-state check. */
export interface WalletProofCheckMintResult {
  mintUrl: string;
  /** Ready + inflight proofs examined at this mint. */
  checked: number;
  /** Value those proofs represented locally, in sat. */
  checkedAmount: number;
  /** Proofs the mint reports SPENT. */
  spent: number;
  /** Value of the proofs the mint reports SPENT, in sat. */
  spentAmount: number;
  /** Proofs actually marked spent locally (always zero in a dry run). */
  markedSpent: number;
  /** Proofs the mint reports UNSPENT; left untouched. */
  unspent: number;
  /** Proofs the mint reports PENDING (or an unknown state); left to settle. */
  unresolved: number;
  /** Set when the mint could not be asked, or answered unusably. */
  error?: string;
}

/** Summary of a wallet proof-state check run. */
export interface WalletProofCheckResult {
  dryRun: boolean;
  /** Proofs examined across every mint. */
  checked: number;
  /** Proofs the mints report SPENT. */
  spent: number;
  /** Value of those proofs, in sat. */
  spentAmount: number;
  /** Proofs actually marked spent locally (always zero in a dry run). */
  markedSpent: number;
  /** Proofs the mints report UNSPENT. */
  unspent: number;
  /** Proofs the mints report PENDING (or an unknown state). */
  unresolved: number;
  /** Mints that could not be checked; their proofs were left untouched. */
  unreachableMints: string[];
  /** Per-mint breakdown, in check order. */
  mints: WalletProofCheckMintResult[];
}

export interface WalletClient {
  ping(): Promise<boolean>;
  getStatus(): Promise<WalletRuntimeState>;
  unlock(passphrase: string): Promise<string>;
  getBalances(): Promise<Record<string, number>>;
  receiveCashu(token: string): Promise<string>;
  receiveBolt11(
    amount: number,
    mintUrl?: string,
  ): Promise<{ invoice: string; operationId?: string }>;
  /** Progress of a top-up, when the wallet tracks mint operations. */
  getMintQuote?(operationId: string): Promise<MintQuoteStatus | null>;
  sendCashu(amount: number, mintUrl?: string): Promise<string>;
  sendBolt11(invoice: string, mintUrl?: string): Promise<string>;
  listMints(): Promise<string[]>;
  addMint(url: string): Promise<string>;
  getMintInfo(url: string): Promise<unknown>;
  getDefaultMint(): Promise<string | null>;
  setDefaultMint(url: string): Promise<string>;
  /** Release resources held by in-process wallet implementations. */
  dispose?(): Promise<void>;
  getHistory(offset?: number, limit?: number): Promise<HistoryEntry[]>;
  /** Look up a single transaction by its history entry ID. */
  getHistoryEntryById(id: string): Promise<HistoryEntry | null>;
  /** NPC (npubx.cash) Lightning address for this wallet. */
  getNpcAddress(): Promise<NpcAddress>;
  /** Claim an NPC username; pass confirm=true to pay the claim fee from the wallet. */
  setNpcUsername(username: string, confirm?: boolean): Promise<NpcUsernameResult>;
  /** Manually trigger an NPC quote sync into the wallet. */
  syncNpc(): Promise<void>;
  /** Clear stuck pending/in-flight wallet operations that are safe to resolve. */
  cleanupStuckOperations?(
    options?: WalletCleanupOptions,
  ): Promise<WalletCleanupResult>;
  /**
   * Re-issue PAID mint quotes whose sats were never claimed, optionally
   * targeting specific operations (including ones coco already failed).
   */
  recoverMintQuotes?(
    options?: WalletMintQuoteRecoveryOptions,
    onProgress?: (message: string) => void,
  ): Promise<WalletMintQuoteRecoveryResult>;
  /**
   * Recover stuck send/melt/mint operations whose mints answer a
   * reachability probe. Operations a live execute holds are reported busy,
   * never driven. Receive stays startup-only (receive dedup classification).
   */
  recoverStuckOperations?(): Promise<WalletStuckOperationRecoveryResult>;
  /**
   * Ask every mint holding our ready or inflight proofs what it thinks of
   * them (NUT-07 checkstate) and mark the ones it reports SPENT as spent
   * locally, reclaiming their balance. Mints that cannot be asked leave their
   * proofs untouched and are reported instead of guessed at.
   */
  checkProofs?(
    options?: WalletProofCheckOptions,
  ): Promise<WalletProofCheckResult>;
  /** Report background wallet recovery progress, when the wallet supports it. */
  getRecoveryProgress?(): Promise<WalletRecoveryProgress>;
}
