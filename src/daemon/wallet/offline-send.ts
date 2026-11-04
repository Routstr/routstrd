import type {
  BasePrepareContext,
  CoreProof,
  ExecuteContext,
  ExecutionResult,
  Manager,
  PendingSendOperation,
  PreparedSendOperation,
  RecoverExecutingContext,
  RollbackContext,
  SendMethod,
  SendMethodHandler,
} from "@cashu/coco-core";
import type { MarkSendSpentResult } from "./wallet-client";

declare module "@cashu/coco-core" {
  interface SendMethodDefinitions {
    /** Create a token from existing proofs without a swap or change outputs. */
    offline: {
      /** Retained for diagnostics; prepared.inputAmount is the token value. */
      requestedAmount?: number;
      /**
       * Maximum token value as a multiple of the requested amount. When the
       * closest no-swap token would exceed it, fall back to an online send.
       */
      overpayCap?: number;
    };
  }
}

/**
 * Pick the smallest available value that covers amount without a swap.
 *
 * Binary denominations use two bounded greedy passes: maximize the excluded
 * value without exceeding total - amount, then minimize the proof count for
 * the resulting token value. For powers of two, largest-first is optimal for
 * both passes. Other denominations use a strictly budgeted subset-sum fallback.
 * Ties use fewer proofs, then secret order, independently of repository order.
 */
export function selectClosestProofs(
  proofs: readonly CoreProof[],
  amount: number,
): CoreProof[] | null {
  if (!Number.isSafeInteger(amount) || amount <= 0) {
    throw new Error("Offline send amount must be a positive integer");
  }

  const ordered = [...proofs].sort((a, b) => a.secret < b.secret ? -1 : a.secret > b.secret ? 1 : 0);
  const secrets = new Set<string>();
  for (const proof of ordered) {
    if (!Number.isSafeInteger(proof.amount) || proof.amount <= 0) {
      throw new Error("Offline send encountered a proof with an invalid amount");
    }
    if (!proof.secret || secrets.has(proof.secret)) {
      throw new Error("Offline send encountered a missing or duplicate proof secret");
    }
    secrets.add(proof.secret);
  }

  const total = ordered.reduce((sum, proof) => sum + proof.amount, 0);
  if (!Number.isSafeInteger(total)) {
    throw new Error("Offline send proof total exceeds the safe integer range");
  }
  if (total < amount) return null;

  // Avoid bitwise tests: Cashu amounts can exceed the 32-bit integer range.
  if (ordered.every((proof) => 2 ** Math.floor(Math.log2(proof.amount)) === proof.amount)) {
    const descending = [...ordered].sort((a, b) => b.amount - a.amount);
    let exclusionBudget = total - amount;
    for (const proof of descending) {
      if (proof.amount <= exclusionBudget) exclusionBudget -= proof.amount;
    }
    // The unused exclusion budget is the smallest unavoidable overpayment.
    let remaining = amount + exclusionBudget;
    const selected: CoreProof[] = [];
    // Stable sorting preserves secret order among equal denominations.
    for (const proof of descending) {
      if (proof.amount <= remaining) {
        selected.push(proof);
        remaining -= proof.amount;
      }
    }
    return selected.sort((a, b) => a.secret < b.secret ? -1 : a.secret > b.secret ? 1 : 0);
  }

  // Non-binary denominations are supported, but must never turn a send into
  // unbounded synchronous work on the daemon's event loop. Charge for copied
  // proof references as well as candidates; cap tie-key work separately below.
  let workRemaining = 1_000_000;
  const charge = (work: number) => {
    workRemaining -= work;
    if (workRemaining < 0) {
      throw new Error(
        "Offline proof selection exceeded its work limit; consolidate proofs with an online send or request a smaller amount",
      );
    }
  };

  const selectionKey = (selection: readonly CoreProof[]) => {
    // Selections already follow ordered secret order.
    charge(selection.reduce((size, proof) => size + proof.secret.length, 0));
    return selection.map((proof) => proof.secret).join("\u0000");
  };
  const isBetter = (
    candidate: readonly CoreProof[],
    current: readonly CoreProof[] | undefined,
  ) => {
    if (!current || candidate.length !== current.length) {
      return !current || candidate.length < current.length;
    }
    charge(candidate.length + current.length);
    return selectionKey(candidate) < selectionKey(current);
  };

  // Sums below the target remain reachable. Larger sums are tracked only as
  // the best answer because adding more proofs can never reduce them again.
  const reachable = new Map<number, CoreProof[]>([[0, []]]);
  let best: CoreProof[] | undefined;
  let bestAmount = Infinity;

  for (const proof of ordered) {
    const additions = Array.from(reachable, ([sum, selection]) => {
      charge(selection.length + 1);
      return { sum: sum + proof.amount, selection: [...selection, proof] };
    });

    for (const candidate of additions) {
      if (candidate.sum >= amount) {
        if (
          candidate.sum < bestAmount ||
          (candidate.sum === bestAmount && isBetter(candidate.selection, best))
        ) {
          best = candidate.selection;
          bestAmount = candidate.sum;
        }
        continue;
      }

      const current = reachable.get(candidate.sum);
      if (isBetter(candidate.selection, current)) {
        reachable.set(candidate.sum, candidate.selection);
      }
    }

    // One proof is the smallest possible token and no closer sum is possible.
    if (bestAmount === amount && best?.length === 1) break;
  }

  return best ?? null;
}

interface SendHandlerRegistry {
  get<M extends SendMethod>(method: M): SendMethodHandler<M>;
  register<M extends SendMethod>(method: M, handler: SendMethodHandler<M>): void;
}

interface OfflineSendManagerInternals {
  sendOperationService: {
    handlerProvider: SendHandlerRegistry;
  };
  proofRepository?: {
    getAvailableProofs(mintUrl: string): Promise<CoreProof[]>;
  };
}

/**
 * The offline selection would leave more value on the table than the caller's
 * overpay cap allows. Callers may fall back to a regular online send.
 */
export class OfflineOverpayCapExceededError extends Error {
  constructor(
    readonly requestedAmount: number,
    readonly actualAmount: number,
    readonly overpayCap: number,
    readonly maxTokenAmount: number,
  ) {
    super(
      `Offline send token ${actualAmount} sats exceeds the ${overpayCap}x ` +
        `overpay cap (${maxTokenAmount} sats) for a ${requestedAmount} sat request`,
    );
    this.name = "OfflineOverpayCapExceededError";
  }
}

/** Select the proofs an offline send would use, without creating an operation. */
export async function previewOfflineSend(
  coco: Manager,
  mintUrl: string,
  amount: number,
): Promise<{ inputAmount: number; proofCount: number } | null> {
  const repo = (coco as unknown as OfflineSendManagerInternals).proofRepository;
  if (!repo || typeof repo.getAvailableProofs !== "function") {
    // Let prepare surface the real error rather than guessing here.
    return null;
  }
  const available = await repo.getAvailableProofs(mintUrl);
  const selected = selectClosestProofs(available, amount);
  if (!selected) {
    return null;
  }
  return {
    inputAmount: selected.reduce((sum, proof) => sum + proof.amount, 0),
    proofCount: selected.length,
  };
}

export function createOfflineSendHandler(
  defaultHandler: SendMethodHandler<"default">,
): SendMethodHandler<"offline"> {
  return {
    requiresWallet: false,

    async prepare(ctx: BasePrepareContext): Promise<PreparedSendOperation> {
      const { operation, proofRepository, proofService, logger } = ctx;
      const { mintUrl, amount } = operation;
      // BasePrepareContext types methodData as the union of all methods; this
      // handler only runs for offline operations, which own `overpayCap`.
      const overpayCap = (operation.methodData as { overpayCap?: number } | undefined)
        ?.overpayCap;
      if (
        overpayCap !== undefined &&
        (!Number.isFinite(overpayCap) || overpayCap < 1)
      ) {
        throw new Error("Offline overpay cap must be a finite number >= 1");
      }

      const available = await proofRepository.getAvailableProofs(mintUrl);
      const selected = selectClosestProofs(available, amount);
      if (!selected) {
        const availableAmount = available.reduce(
          (sum, proof) => sum + proof.amount,
          0,
        );
        throw new Error(
          `Offline send cannot cover ${amount} sats without a swap ` +
            `(${availableAmount} sats available in ${available.length} proofs)`,
        );
      }

      const inputProofSecrets = selected.map((proof) => proof.secret);
      const inputAmount = selected.reduce((sum, proof) => sum + proof.amount, 0);

      if (overpayCap !== undefined) {
        const maxTokenAmount = Math.floor(amount * overpayCap);
        if (!Number.isSafeInteger(maxTokenAmount)) {
          throw new Error("Offline send amount is too large to apply an overpay cap");
        }
        if (inputAmount > maxTokenAmount) {
          logger?.info("Offline send exceeded its overpay cap", {
            operationId: operation.id,
            requestedAmount: amount,
            actualAmount: inputAmount,
            overpayment: inputAmount - amount,
            overpayCap,
            maxTokenAmount,
          });
          throw new OfflineOverpayCapExceededError(
            amount,
            inputAmount,
            overpayCap,
            maxTokenAmount,
          );
        }
      }

      await proofService.reserveProofs(mintUrl, inputProofSecrets, operation.id);

      logger?.info("Offline send prepared without a swap", {
        operationId: operation.id,
        requestedAmount: amount,
        actualAmount: inputAmount,
        overpayment: inputAmount - amount,
        proofCount: selected.length,
        ...(overpayCap !== undefined ? { overpayCap } : {}),
      });

      return {
        ...operation,
        state: "prepared",
        amount: inputAmount,
        updatedAt: Date.now(),
        needsSwap: false,
        fee: 0,
        inputAmount,
        inputProofSecrets,
        outputData: undefined,
        methodData: {
          requestedAmount: amount,
          ...(overpayCap !== undefined ? { overpayCap } : {}),
        },
      };
    },

    async execute(ctx: ExecuteContext): Promise<ExecutionResult> {
      const { operation, reservedProofs, proofRepository } = ctx;
      const { mintUrl, inputProofSecrets } = operation;
      const bySecret = new Map(reservedProofs.map((proof) => [proof.secret, proof]));
      const inputProofs = inputProofSecrets.map((secret) => bySecret.get(secret));
      if (inputProofs.some((proof) => !proof)) {
        throw new Error("Could not find all reserved proofs for offline send");
      }

      // Use the repository deliberately. ProofService.setProofState emits the
      // event that starts Coco's mint proof-state subscription. Offline sends
      // are settled explicitly by markSendSpent instead.
      await proofRepository.setProofState(mintUrl, inputProofSecrets, "inflight");

      const token = {
        mint: mintUrl,
        proofs: inputProofs as CoreProof[],
        // Coco wallets use sat; exporting existing sat proofs needs no wallet.
        unit: "sat",
      };
      const pending: PendingSendOperation = {
        ...operation,
        state: "pending",
        updatedAt: Date.now(),
        token,
      };
      return { status: "PENDING", pending, token };
    },

    async finalize(ctx) {
      await ctx.proofService.releaseProofs(
        ctx.operation.mintUrl,
        ctx.operation.inputProofSecrets,
      );
    },

    async rollback(ctx: RollbackContext): Promise<void> {
      if (ctx.operation.state === "prepared") {
        await ctx.proofService.releaseProofs(
          ctx.operation.mintUrl,
          ctx.operation.inputProofSecrets,
        );
        return;
      }
      if (!defaultHandler.rollback) {
        throw new Error("Coco's default send rollback handler is unavailable");
      }
      // Reclaiming an already shared token is an explicitly online operation:
      // the mint must swap it for fresh local proofs before they can be reused.
      await defaultHandler.rollback(ctx);
    },

    async checkPending() {
      // Startup recovery and ops.send.refresh() must not contact the mint for
      // an operation whose settlement is deliberately controlled by the user.
      return "stay_pending" as const;
    },

    async recoverExecuting(ctx: RecoverExecutingContext): Promise<ExecutionResult> {
      const { operation, proofService } = ctx;
      // No token was returned while the operation was still executing. Unlike
      // releaseProofs(), this also changes inflight proofs back to ready.
      await proofService.restoreProofsToReady(
        operation.mintUrl,
        operation.inputProofSecrets,
      );
      return {
        status: "FAILED",
        failed: {
          ...operation,
          state: "rolled_back",
          updatedAt: Date.now(),
          error: "Recovered offline send before its token was returned",
        },
      };
    },
  };
}

/** Mark a claimed offline token spent locally; never asks the mint for state. */
export async function markOfflineSendSpent(
  coco: Manager,
  operationId: string,
): Promise<MarkSendSpentResult> {
  const operation = await coco.ops.send.get(operationId);
  if (!operation) throw new Error(`Send operation ${operationId} not found`);
  if (operation.method !== "offline") {
    throw new Error("Only offline send operations can be marked spent manually");
  }
  if (operation.state === "finalized") {
    return {
      operationId,
      state: "finalized",
      markedSpent: 0,
      actualAmount: operation.inputAmount,
    };
  }
  if (operation.state !== "pending") {
    throw new Error(
      `Cannot mark offline send in state '${operation.state}' as spent`,
    );
  }

  const internals = coco as unknown as {
    proofService: {
      setProofState(
        mintUrl: string,
        secrets: string[],
        state: "spent",
      ): Promise<void>;
    };
  };
  await internals.proofService.setProofState(
    operation.mintUrl,
    operation.inputProofSecrets,
    "spent",
  );
  await coco.ops.send.finalize(operationId);
  return {
    operationId,
    state: "finalized",
    markedSpent: operation.inputProofSecrets.length,
    actualAmount: operation.inputAmount,
  };
}

/** Register before watchers or recovery can encounter a persisted offline op. */
export function registerOfflineSendHandler(coco: Manager): void {
  const internals = coco as unknown as OfflineSendManagerInternals;
  const provider = internals.sendOperationService?.handlerProvider;
  if (!provider || typeof provider.get !== "function" || typeof provider.register !== "function") {
    throw new Error("Coco's send handler registry is unavailable");
  }
  provider.register("offline", createOfflineSendHandler(provider.get("default")));
}
