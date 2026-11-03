import type { Manager, PendingSendOperation } from "@cashu/coco-core";

export const OFFLINE_SWEEP_MIN_AGE_MS = 7 * 24 * 60 * 60 * 1000;

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
  outcome: "candidate" | "claimed" | "reclaimed" | "unresolved" | "failed";
  error?: string;
}

export interface OfflineSweepResult {
  dryRun: boolean;
  minAgeMs: number;
  candidates: number;
  skipped: number;
  claimed: number;
  reclaimed: number;
  unresolved: number;
  failed: number;
  operations: OfflineSweepEntry[];
}

/** Coco's existing mint-backed services; no cached proof state is trusted here. */
interface SweepInternals {
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
 * Coco owns locks, output counters, swap persistence and rollback recovery.
 */
export async function sweepOfflineSends(
  coco: Manager,
  options: OfflineSweepOptions = {},
  now = Date.now(),
): Promise<OfflineSweepResult> {
  const minAgeMs = options.minAgeMs ?? OFFLINE_SWEEP_MIN_AGE_MS;
  if (!Number.isSafeInteger(minAgeMs) || minAgeMs < 0) {
    throw new Error("Offline sweep minimum age must be a non-negative safe integer");
  }
  const dryRun = options.dryRun === true;
  if (!dryRun && options.confirmed !== true) {
    throw new Error("Offline sweep requires confirmation: outstanding tokens will be invalidated");
  }
  const operations = await coco.ops.send.listInFlight();
  const candidates = operations.filter((op): op is PendingSendOperation =>
    op.method === "offline" && op.state === "pending" &&
    (!options.mintUrl || op.mintUrl === options.mintUrl) &&
    Number.isSafeInteger(op.createdAt) && op.createdAt <= now - minAgeMs,
  );
  const result: OfflineSweepResult = {
    dryRun, minAgeMs, candidates: candidates.length,
    skipped: operations.length - candidates.length,
    claimed: 0, reclaimed: 0, unresolved: 0, failed: 0, operations: [],
  };
  const internals = coco as unknown as SweepInternals;
  for (const candidate of candidates) {
    const entry: OfflineSweepEntry = {
      operationId: candidate.id, mintUrl: candidate.mintUrl,
      amount: candidate.inputAmount, createdAt: candidate.createdAt,
      outcome: "candidate",
    };
    result.operations.push(entry);
    if (dryRun) continue;
    try {
      const operation = await coco.ops.send.get(candidate.id);
      if (!operation || operation.state !== "pending" || operation.method !== "offline") {
        throw new Error("Operation changed since sweep selection; retry after inspecting its state");
      }
      const proofs = operation.token?.proofs;
      if (!proofs?.length || proofs.length !== operation.inputProofSecrets.length ||
          new Set(proofs.map((proof) => proof.secret)).size !== proofs.length ||
          proofs.some((proof) => !operation.inputProofSecrets.includes(proof.secret))) {
        throw new Error("Offline token proofs do not match the operation inputs");
      }
      const { wallet } = await internals.walletService.getWalletWithActiveKeysetId(operation.mintUrl);
      const states = await wallet.checkProofsStates(proofs.map(({ secret }) => ({ secret })));
      if (!Array.isArray(states) || states.length !== proofs.length) {
        throw new Error("Mint returned an incomplete proof-state response");
      }
      if (states.every((state) => state?.state === "SPENT")) {
        // This is mint-verified settlement, not the manual mark-spent assertion.
        await internals.proofService.setProofState(operation.mintUrl, operation.inputProofSecrets, "spent");
        await coco.ops.send.finalize(operation.id);
        if ((await coco.ops.send.get(operation.id))?.state !== "finalized") {
          throw new Error("Claimed send could not be finalized; inspect its state");
        }
        entry.outcome = "claimed";
        result.claimed++;
      } else if (states.every((state) => state?.state === "UNSPENT")) {
        const fees = wallet.getFeesForProofs(proofs);
        if (!Number.isSafeInteger(fees) || fees < 0 || operation.inputAmount <= fees) {
          throw new Error("Token value does not cover reclaim fees; left pending");
        }
        // NEVER restore shared proofs to ready: Coco swaps for fresh proofs.
        // A recipient racing this swap may win; report the failure, not success.
        await coco.ops.send.reclaim(operation.id);
        if ((await coco.ops.send.get(operation.id))?.state !== "rolled_back") {
          throw new Error("Reclaim did not reach rolled_back; inspect operation state");
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
      result.failed++;
    }
  }
  return result;
}
