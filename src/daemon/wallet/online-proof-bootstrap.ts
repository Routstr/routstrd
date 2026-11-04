import type { CoreProof, Manager } from "@cashu/coco-core";

type Log = { warn(message: string, context: Record<string, unknown>): void };
interface Source {
  proofRepository: {
    getInflightProofs(): Promise<CoreProof[]>;
  };
}
interface Internals {
  proofStateWatcher?: {
    isRunning(): boolean;
    watchProof(mintUrl: string, secrets: string[]): Promise<void>;
  };
  walletService: {
    getWalletWithActiveKeysetId(mintUrl: string): Promise<{
      wallet: { checkProofsStates(proofs: CoreProof[]): Promise<Array<{ state: string }>> };
    }>;
  };
  proofService: {
    setProofState(mintUrl: string, secrets: string[], state: "spent"): Promise<void>;
  };
}

/** Start without gating wallet initialization; errors must remain observable. */
export function startOnlineProofBootstrap(
  coco: Manager, repo: Source, logger: Log, shouldStop: () => boolean,
): void {
  void watchOnlineInflightProofs(coco, repo, logger, shouldStop).catch((error) => {
    logger.warn("Failed to bootstrap online inflight proofs", { error });
  });
}

/** Preserve Coco's bootstrap check and subscriptions, excluding offline sends. */
export async function watchOnlineInflightProofs(
  coco: Manager, repo: Source, logger: Log, shouldStop: () => boolean = () => false,
): Promise<void> {
  const internals = coco as unknown as Internals;
  const watcher = internals.proofStateWatcher;
  if (!watcher || typeof watcher.watchProof !== "function" || typeof watcher.isRunning !== "function" ||
      typeof internals.walletService?.getWalletWithActiveKeysetId !== "function" ||
      typeof internals.proofService?.setProofState !== "function") {
    throw new Error("Coco's online proof bootstrap services are unavailable");
  }
  const active = () => !shouldStop() && internals.proofStateWatcher === watcher && watcher.isRunning();
  if (!active()) return;
  const operations = new Map<string, Awaited<ReturnType<typeof coco.ops.send.get>>>();
  const failedLookups = new Set<string>();
  const byMint = new Map<string, CoreProof[]>();
  for (const proof of await repo.proofRepository.getInflightProofs()) {
    if (!active()) return;
    if (!proof.mintUrl || !proof.secret) continue;
    const operationId = proof.usedByOperationId ?? proof.createdByOperationId;
    if (operationId) {
      if (failedLookups.has(operationId)) continue;
      if (!operations.has(operationId)) {
        try {
          operations.set(operationId, await coco.ops.send.get(operationId));
        } catch (error) {
          failedLookups.add(operationId);
          logger.warn("Skipping inflight proofs after send lookup failed", { operationId, error });
          continue;
        }
      }
      if (operations.get(operationId)?.method === "offline") continue;
    }
    // Missing send rows can also belong to receive/melt workflows. Like Coco,
    // preserve checks for all other inflight proofs, not just known sends.
    const proofs = byMint.get(proof.mintUrl) ?? [];
    proofs.push(proof);
    byMint.set(proof.mintUrl, proofs);
  }
  for (const [mintUrl, proofs] of byMint) {
    if (!active()) return;
    try {
      const { wallet } = await internals.walletService.getWalletWithActiveKeysetId(mintUrl);
      if (!active()) return;
      // cashu-ts checkProofsStates maps mint Y values back into INPUT order.
      // Never zip raw mint responses (whose ordering is not guaranteed).
      const states = await wallet.checkProofsStates(proofs);
      if (!active()) return;
      if (!Array.isArray(states) || states.length !== proofs.length ||
          states.some((state) => !state || !["SPENT", "UNSPENT", "PENDING"].includes(state.state))) {
        throw new Error("Malformed mint proof-state response");
      }
      const spent = proofs.filter((_, index) => states[index]!.state === "SPENT").map((proof) => proof.secret);
      if (spent.length) await internals.proofService.setProofState(mintUrl, spent, "spent");
    } catch (error) {
      logger.warn("Failed to check existing online inflight proofs", { mintUrl, error });
    }
    if (!active()) return;
    try {
      // Re-read after checking: recovery or an event may also have spent proofs.
      const inflight = new Set((await repo.proofRepository.getInflightProofs())
        .filter((proof) => proof.mintUrl === mintUrl).map((proof) => proof.secret));
      if (!active()) return;
      const secrets = proofs.filter((proof) => inflight.has(proof.secret)).map((proof) => proof.secret);
      if (secrets.length) await watcher.watchProof(mintUrl, secrets);
    } catch (error) {
      logger.warn("Failed to watch existing online inflight proofs", { mintUrl, error });
    }
  }
}
