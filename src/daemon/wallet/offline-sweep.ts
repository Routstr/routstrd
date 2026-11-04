import { normalizeMintUrl, type CoreProof, type Manager, type PendingSendOperation, type RollingBackSendOperation } from "@cashu/coco-core";
import { withTimeout } from "../../utils/with-timeout";

export const OFFLINE_SWEEP_MIN_AGE_MS = 7 * 24 * 60 * 60 * 1000;
const STUCK_RECLAIM_WARNING = "Reclaim is rolling_back; no automatic retry or normal startup recovery. Inspect history and preserve wallet backups; manual recovery via seed restore may be needed. SPENT inputs alone cannot distinguish recipient redemption from a completed reclaim with a lost response.";

/** Reject a supplied invalid filter rather than accidentally sweeping all mints. */
export function normalizeOfflineSweepMintUrl(value: unknown): string {
  if (typeof value !== "string" || !value.trim()) throw new Error("'mintUrl' must be a non-empty HTTP(S) URL.");
  try {
    const url = new URL(value.trim());
    if (!["http:", "https:"].includes(url.protocol) || !url.hostname || url.username || url.password || url.search || url.hash) {
      throw new Error("Invalid mint URL");
    }
    return normalizeMintUrl(url.href);
  } catch {
    throw new Error("'mintUrl' must be a valid HTTP(S) URL without credentials, query or fragment.");
  }
}

export interface OfflineSweepOptions {
  mintUrl?: string;
  /** Age since token creation, not its last refresh; defaults to seven days. */
  minAgeMs?: number;
  /** List candidates locally without checking or changing anything. */
  dryRun?: boolean;
  /** Explicit consent to invalidate outstanding, unclaimed tokens. */
  confirmed?: boolean;
}

export interface OfflineSweepEntry {
  operationId: string;
  mintUrl: string;
  amount: number;
  createdAt: number;
  outcome: "candidate" | "claimed" | "reclaimed" | "unresolved" | "failed" | "stuck";
  error?: string;
}

export interface OfflineSweepResult {
  dryRun: boolean;
  minAgeMs: number;
  candidates: number;
  skipped: number;
  /** Interrupted/failed reclaims requiring manual recovery; never retried here. */
  stuck: number;
  claimed: number;
  reclaimed: number;
  unresolved: number;
  failed: number;
  operations: OfflineSweepEntry[];
}

/** Coco's existing mint-backed services; no cached proof state is trusted here. */
interface SweepInternals {
  proofRepository: {
    getProofsBySecrets(mintUrl: string, secrets: string[]): Promise<CoreProof[]>;
  };
  walletService: {
    getWalletWithActiveKeysetId(mintUrl: string): Promise<{
      wallet: {
        checkProofsStates(proofs: Array<{ secret: string }>): Promise<Array<{ state?: string }>>;
        getFeesForProofs(proofs: NonNullable<PendingSendOperation["token"]>["proofs"]): number;
      };
    }>;
  };
  proofService: {
    setProofState(mintUrl: string, secrets: string[], state: "spent"): Promise<void>;
  };
}

/**
 * Explicit operator action, never called during startup. A shared token is not
 * expired by age: successful reclaim spends it at the mint and invalidates it.
 * Coco owns locks and output counters. Failed/interrupted swaps may require
 * manual seed restoration; rolling_back must never be silently retried.
 */
export async function sweepOfflineSends(
  coco: Manager,
  options: OfflineSweepOptions = {},
  now = Date.now(),
  runtime: {
    readTimeoutMs?: number;
    shouldStop?: () => boolean;
    /** Metadata refresh can persist locally after a bounded wait expires. */
    trackRead?: (work: Promise<unknown>) => void;
  } = {},
): Promise<OfflineSweepResult> {
  const minAgeMs = options.minAgeMs ?? OFFLINE_SWEEP_MIN_AGE_MS;
  if (!Number.isSafeInteger(minAgeMs) || minAgeMs < 0) {
    throw new Error("Offline sweep minimum age must be a non-negative safe integer");
  }
  const dryRun = options.dryRun === true;
  if (!dryRun && options.confirmed !== true) {
    throw new Error("Offline sweep requires confirmation: outstanding tokens will be invalidated");
  }
  const mintUrl = options.mintUrl === undefined ? undefined : normalizeOfflineSweepMintUrl(options.mintUrl);
  const readTimeoutMs = runtime.readTimeoutMs ?? 30_000;
  const read = <T>(work: Promise<T>, message: string): Promise<T> => {
    runtime.trackRead?.(work);
    return withTimeout(work, readTimeoutMs, message);
  };
  const operations = await coco.ops.send.listInFlight();
  const selected = operations.filter((op): op is PendingSendOperation | RollingBackSendOperation =>
    op.method === "offline" && (op.state === "pending" || op.state === "rolling_back") &&
    (mintUrl === undefined || op.mintUrl === mintUrl) &&
    Number.isSafeInteger(op.createdAt) && op.createdAt <= now - minAgeMs,
  );
  const result: OfflineSweepResult = {
    dryRun, minAgeMs, candidates: selected.filter((op) => op.state === "pending").length,
    skipped: operations.length - selected.length, stuck: 0,
    claimed: 0, reclaimed: 0, unresolved: 0, failed: 0, operations: [],
  };
  const internals = coco as unknown as SweepInternals;
  for (const candidate of selected) {
    const entry: OfflineSweepEntry = {
      operationId: candidate.id, mintUrl: candidate.mintUrl,
      amount: candidate.inputAmount, createdAt: candidate.createdAt,
      outcome: "candidate",
    };
    result.operations.push(entry);
    const reportStuck = () => {
      entry.outcome = "stuck";
      entry.error = STUCK_RECLAIM_WARNING;
      result.stuck++;
    };
    if (candidate.state === "rolling_back") { reportStuck(); continue; }
    if (dryRun) continue;
    try {
      if (runtime.shouldStop?.()) throw new Error("Wallet is shutting down; token left untouched");
      const operation = await coco.ops.send.get(candidate.id);
      if (operation?.method === "offline" && operation.state === "rolling_back") { reportStuck(); continue; }
      if (!operation || operation.state !== "pending" || operation.method !== "offline") {
        throw new Error("Operation changed since sweep selection; retry after inspecting its state");
      }
      const proofs = operation.token?.proofs;
      const inputSecrets = new Set(operation.inputProofSecrets);
      if (!proofs?.length || proofs.length !== operation.inputProofSecrets.length ||
          new Set(proofs.map((proof) => proof.secret)).size !== proofs.length ||
          proofs.some((proof) => !inputSecrets.has(proof.secret))) {
        throw new Error("Offline token proofs do not match the operation inputs");
      }
      // Bound only read-only mint work. A timeout is not cancellation; a late
      // read may refresh local metadata, but cannot mutate proofs or start a swap.
      const { wallet } = await read(internals.walletService.getWalletWithActiveKeysetId(operation.mintUrl), "Mint metadata lookup timed out; token left untouched");
      if (runtime.shouldStop?.()) throw new Error("Wallet is shutting down; token left untouched");
      const states = await read(wallet.checkProofsStates(proofs.map(({ secret }) => ({ secret }))), "Mint proof-state check timed out; token left untouched");
      if (runtime.shouldStop?.()) throw new Error("Wallet is shutting down; token left untouched");
      if (!Array.isArray(states) || states.length !== proofs.length) {
        throw new Error("Mint returned an incomplete proof-state response");
      }
      if (states.every((state) => state?.state === "SPENT")) {
        // Mark spent BEFORE finalize: Coco releaseProofs only clears ownership,
        // preserving spent state. Reversing these steps could leave shared inputs spendable.
        await internals.proofService.setProofState(operation.mintUrl, operation.inputProofSecrets, "spent");
        await coco.ops.send.finalize(operation.id);
        if ((await coco.ops.send.get(operation.id))?.state !== "finalized") {
          throw new Error("Claimed send could not be finalized; inspect its state");
        }
        entry.outcome = "claimed";
        result.claimed++;
      } else if (states.every((state) => state?.state === "UNSPENT")) {
        const local = await internals.proofRepository.getProofsBySecrets(operation.mintUrl, operation.inputProofSecrets);
        if (local.length !== inputSecrets.size || new Set(local.map((proof) => proof.secret)).size !== inputSecrets.size ||
            local.some((proof) => !inputSecrets.has(proof.secret) || proof.state !== "inflight" || proof.usedByOperationId !== operation.id)) {
          throw new Error("Reclaim requires every input proof to be inflight and owned by this operation; left pending");
        }
        // Coco silently skips the swap for fee-exhausted inputs yet marks the
        // operation rolled_back. Keep this guard (fees use each proof's keyset).
        const fees = wallet.getFeesForProofs(proofs);
        if (!Number.isSafeInteger(fees) || fees < 0 || operation.inputAmount <= fees) {
          throw new Error("Token value does not cover reclaim fees; left pending");
        }
        // NEVER restore shared proofs to ready: Coco swaps for fresh proofs.
        // A recipient racing this swap may win; report the failure, not success.
        if (runtime.shouldStop?.()) throw new Error("Wallet is shutting down; token left untouched");
        // No timeout on value-moving work: shutdown tracks it until it settles.
        await coco.ops.send.reclaim(operation.id);
        if ((await coco.ops.send.get(operation.id))?.state !== "rolled_back") {
          throw new Error("Reclaim did not reach rolled_back; inspect operation state");
        }
        const after = await internals.proofRepository.getProofsBySecrets(operation.mintUrl, operation.inputProofSecrets);
        if (after.length !== inputSecrets.size || new Set(after.map((proof) => proof.secret)).size !== inputSecrets.size ||
            after.some((proof) => !inputSecrets.has(proof.secret) || proof.state !== "spent")) {
          throw new Error("Reclaim did not leave all shared inputs spent; inspect operation and proofs before retrying");
        }
        entry.outcome = "reclaimed";
        result.reclaimed++;
      } else {
        entry.outcome = "unresolved";
        entry.error = "Mixed, pending or unknown mint proof states; token left untouched";
        result.unresolved++;
      }
    } catch (error) {
      entry.outcome = "failed";
      entry.error = error instanceof Error ? error.message : String(error);
      // Surface the recovery warning on the first failed attempt too, not only
      // on subsequent sweeps. Do not change/reset a state after a swap error.
      try {
        if ((await coco.ops.send.get(candidate.id))?.state === "rolling_back") {
          entry.error += `. ${STUCK_RECLAIM_WARNING}`;
        }
      } catch { /* Preserve the original failure if the diagnostic read fails. */ }
      result.failed++;
    }
  }
  return result;
}
