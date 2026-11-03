/**
 * Recover pending melts with expired/purged quotes only after NUT-07 checks.
 *
 * coco 1.0.1's melt handler already maps error 20007 ("quote expired") to
 * UNPAID in `recoverExecuting`, but its `checkPending` asks the mint without
 * that catch. A pending melt whose quote the mint has purged therefore throws,
 * which leaves the operation stuck forever: `refresh()` fails and `reclaim()`
 * re-runs the same check and throws at the same place. Quote expiry alone is
 * not evidence of payment failure: proofs can still be PENDING or SPENT.
 *
 * - every actual melt input UNSPENT  -> rollback (the payment did not happen)
 * - every actual melt input SPENT    -> finalize (the mint burned the inputs,
 *   which only happens after a successful Lightning payment)
 * - any input PENDING                -> stay pending (HTLC still live)
 * - mixed / missing / malformed      -> stay pending
 *
 * Request failures propagate so recovery callers can classify and back off an
 * unreachable mint instead of interpreting the lookup as a successful check.
 *
 * Finalizing is not just returning "finalize": coco's `MeltBolt11Handler.finalize`
 * asks the mint for the quote again and throws 20007 at the same purged quote.
 * It is wrapped too, re-verifies the SPENT states under the operation lock, and
 * recovers change through NUT-09 restore because the quote no longer carries
 * the mint's change signatures. The blank change outputs are deterministic and
 * stored on the operation, so the mint can still report which of them it signed.
 *
 * This is a version-sensitive bridge in the same spirit as
 * `sendRecoveryServiceOf` and `cleanupLocalRecoveryState`: if coco's handler
 * shape changes, installation reports it instead of silently doing nothing.
 * Errors are matched by numeric code as well as by class because the throw
 * crosses the coco package boundary.
 */
import { hashToCurve } from "@cashu/cashu-ts";
import {
  HttpResponseError,
  MintOperationError,
  NetworkError,
  type Manager,
  type MeltOperation,
} from "@cashu/coco-core";
import { logger } from "../../utils/logger";

/** NUT-05 melt error code for an expired quote. */
const MELT_QUOTE_EXPIRED_CODE = 20007;

export function isMeltQuoteExpiredError(error: unknown): boolean {
  if (error instanceof MintOperationError && error.code === MELT_QUOTE_EXPIRED_CODE) {
    return true;
  }
  return (
    typeof error === "object" &&
    error !== null &&
    (error as { code?: unknown }).code === MELT_QUOTE_EXPIRED_CODE
  );
}

type PendingMeltOperation = Extract<MeltOperation, { state: "pending" }>;

/** NUT-07 verdict for the proofs a melt actually handed to the mint. */
type ExpiredInputStates = "all_unspent" | "all_spent" | "pending" | "indeterminate";

/** One entry of coco's serialized `SerializedOutputData` (change outputs). */
interface SerializedChangeOutput {
  blindedMessage: { amount: number; id: string; B_: string };
  blindingFactor: string;
  secret: string;
}

interface MeltHandlerLike {
  checkPending?: (ctx: unknown) => Promise<unknown>;
  finalize?: (ctx: unknown) => Promise<unknown>;
  /** Coco 1.0.1 helper: selects swap-send secrets rather than spent swap inputs. */
  getMeltInputSecrets?: (operation: PendingMeltOperation) => string[];
  /** Coco 1.0.1 helper: amount actually sent to the melt (swap-send sum if swapped). */
  getMeltInputAmount?: (operation: PendingMeltOperation) => number;
  /** Coco 1.0.1 helper: derives changeAmount/effectiveFee from change proofs. */
  calculateSettlementAmounts?: (
    meltInputAmount: number,
    meltAmount: number,
    changeProofs?: Array<{ amount: number }>,
  ) => { changeAmount: number; effectiveFee: number };
  /** Coco 1.0.1 helper: marks melt inputs spent and saves change proofs. */
  finalizeOperation?: (ctx: unknown, change?: unknown[]) => Promise<void>;
}

interface MeltContextLike {
  operation?: PendingMeltOperation;
  mintAdapter?: {
    checkProofStates?: (mintUrl: string, Ys: string[]) => Promise<unknown>;
  };
  walletService?: {
    getWalletWithActiveKeysetId?: (
      mintUrl: string,
    ) => Promise<{ wallet?: unknown }>;
  };
  proofService?: { unblindAndSaveChangeProofs?: unknown };
  proofRepository?: {
    getProofBySecret?: (
      mintUrl: string,
      secret: string,
    ) => Promise<{ secret?: unknown } | null>;
  };
}

interface RestoreWalletLike {
  mint?: {
    restore?: (payload: {
      outputs: Array<{ amount: number; id: string; B_: string }>;
    }) => Promise<unknown>;
  };
}

interface RestoreResultLike {
  outputs?: Array<{ B_?: unknown }>;
  signatures?: unknown[];
}

interface ChangeRecovery {
  /** Every change output the mint signed, for settlement accounting. */
  all: SerializedChangeOutput[];
  /**
   * Amounts taken from the mint's signatures, aligned with `all`.
   *
   * Coco prepares every blank change output with amount 0 (NUT-08); the mint
   * picks the denomination when it signs. The output amounts are therefore
   * useless for accounting and must not be summed.
   */
  allAmounts: number[];
  /** Change outputs that should be unblinded/saved, aligned with `signatures`. */
  outputs: SerializedChangeOutput[];
  signatures: unknown[];
}

/** Decode coco's hex-encoded OutputData secret into proof-secret form. */
function decodeSerializedSecret(hex: string): string | undefined {
  if (typeof hex !== "string" || hex.length === 0 || hex.length % 2 !== 0) return undefined;
  const bytes = new Uint8Array(hex.length / 2);
  for (let index = 0; index < hex.length; index += 2) {
    const byte = Number.parseInt(hex.slice(index, index + 2), 16);
    if (!Number.isFinite(byte)) return undefined;
    bytes[index / 2] = byte;
  }
  return new TextDecoder().decode(bytes);
}

/** Read the amount the mint assigned to a restored signature. */
function signatureAmount(signature: unknown): number {
  const raw = (signature as { amount?: unknown } | null)?.amount;
  if (typeof raw === "number" && Number.isFinite(raw)) return raw;
  if (typeof raw === "string") {
    const parsed = Number(raw);
    return Number.isFinite(parsed) ? parsed : 0;
  }
  const toNumber = (raw as { toNumber?: unknown } | null)?.toNumber;
  if (typeof toNumber === "function") {
    try {
      const parsed = (toNumber as () => unknown).call(raw);
      return typeof parsed === "number" && Number.isFinite(parsed) ? parsed : 0;
    } catch {
      return 0;
    }
  }
  return 0;
}

/**
 * True for a mint response that means "this mint has no usable NUT-09 restore"
 * rather than "try again later". Client errors other than timeout/rate-limit
 * are permanent; transport and 5xx failures must propagate so the sweep backs
 * off and retries the operation.
 */
function isRestoreUnsupportedError(error: unknown, depth = 0): boolean {
  if (!(error instanceof Error) || depth > 5) return false;
  if (error instanceof NetworkError || error.name === "NetworkError") return false;
  // MintRequestProvider maps HTTP 400 + a NUT error body (and some direct
  // calls) to MintOperationError: semantic rejection, not worth retrying.
  if (error instanceof MintOperationError) return true;
  if (error instanceof HttpResponseError || error.name === "HttpResponseError") {
    const status = (error as { status?: unknown }).status;
    if (typeof status === "number") {
      return status !== 408 && status !== 429 && status < 500;
    }
  }
  return isRestoreUnsupportedError((error as { cause?: unknown }).cause, depth + 1);
}

const INPUT_STATE_MEANING: Record<ExpiredInputStates, string> = {
  all_unspent: "all UNSPENT",
  all_spent: "all SPENT",
  pending: "PENDING",
  indeterminate: "unverifiable",
};

function operationIdOf(context: unknown): string | undefined {
  const operation = (context as MeltContextLike)?.operation;
  return typeof operation?.id === "string" ? operation.id : undefined;
}

/**
 * Classify the NUT-07 states of the proofs a melt actually sent.
 *
 * Strict on purpose: only a complete, unique, matching set of results may
 * produce a payment verdict. Returns `"indeterminate"` for anything else and
 * lets proof-state request failures reject, so the sweep can back off.
 */
async function classifyExpiredMeltInputStates(
  handler: MeltHandlerLike,
  context: unknown,
  method: string,
): Promise<ExpiredInputStates> {
  const ctx = context as MeltContextLike;
  let Ys: string[];
  let expected: Set<string>;
  try {
    const operation = ctx.operation;
    if (!operation || typeof operation.needsSwap !== "boolean") return "indeterminate";
    const secrets = handler.getMeltInputSecrets?.(operation);
    if (!Array.isArray(secrets) || secrets.length === 0 ||
        secrets.some((secret) => typeof secret !== "string" || secret.length === 0) ||
        new Set(secrets).size !== secrets.length) return "indeterminate";

    const encoder = new TextEncoder();
    Ys = secrets.map((secret) => hashToCurve(encoder.encode(secret)).toHex(true));
    expected = new Set(Ys);
    if (expected.size !== Ys.length ||
        typeof ctx.mintAdapter?.checkProofStates !== "function") return "indeterminate";
  } catch (error) {
    logger.warn("Could not verify expired melt input states; preserving reservations", {
      method,
      operationId: operationIdOf(context),
      error: error instanceof Error ? error.message : String(error),
    });
    return "indeterminate";
  }

  // Use raw NUT-07 results: wallet.checkProofsStates() maps by Y and can hide
  // duplicate responses. Do not swallow request errors: the sweep needs their
  // transport classification to back off this mint, while proofs stay reserved.
  const states = await ctx.mintAdapter!.checkProofStates!(ctx.operation!.mintUrl, Ys);
  if (!Array.isArray(states) || states.length !== Ys.length) {
    logger.warn("Mint returned an incomplete expired-melt proof-state set; preserving reservations", {
      method,
      operationId: operationIdOf(context),
      expected: Ys.length,
      received: Array.isArray(states) ? states.length : null,
    });
    return "indeterminate";
  }

  const seen = new Set<string>();
  let unspent = 0;
  let spent = 0;
  let pending = 0;
  for (const entry of states) {
    const state = (entry as { state?: unknown } | null)?.state;
    const Y = (entry as { Y?: unknown } | null)?.Y;
    if (typeof Y !== "string" || !expected.has(Y) || seen.has(Y)) {
      logger.warn("Mint returned an unexpected expired-melt proof-state entry; preserving reservations", {
        method,
        operationId: operationIdOf(context),
      });
      return "indeterminate";
    }
    seen.add(Y);
    if (state === "UNSPENT") unspent++;
    else if (state === "SPENT") spent++;
    else if (state === "PENDING") pending++;
    else {
      logger.warn("Mint returned an unknown expired-melt proof state; preserving reservations", {
        method,
        operationId: operationIdOf(context),
        state: typeof state === "string" ? state : null,
      });
      return "indeterminate";
    }
  }

  if (seen.size !== expected.size) return "indeterminate";
  // A live HTLC dominates any other classification: never touch a melt whose
  // proof states are still in flux.
  if (pending > 0) return "pending";
  if (spent === Ys.length) return "all_spent";
  if (unspent === Ys.length) return "all_unspent";
  logger.warn("Expired melt inputs are split between SPENT and UNSPENT; preserving reservations", {
    method,
    operationId: operationIdOf(context),
    spent,
    unspent,
  });
  return "indeterminate";
}

/** Helpers the finalize path needs; missing ones make installation fail closed. */
function missingFinalizeHelpers(handler: MeltHandlerLike): string[] {
  const missing: string[] = [];
  if (typeof handler.getMeltInputSecrets !== "function") missing.push("getMeltInputSecrets");
  if (typeof handler.getMeltInputAmount !== "function") missing.push("getMeltInputAmount");
  if (typeof handler.calculateSettlementAmounts !== "function") missing.push("calculateSettlementAmounts");
  if (typeof handler.finalizeOperation !== "function") missing.push("finalizeOperation");
  return missing;
}

/**
 * Ask the mint which of the operation's blank change outputs it signed (NUT-09).
 *
 * The expired quote no longer hands back change signatures, but the outputs are
 * deterministic and stored on the operation. Restore may return any subset in
 * any order, so results are matched by `B_` and re-aligned with their
 * OutputData before coco unblinds them; coco pairs the two arrays by index.
 */
async function recoverExpiredMeltChange(
  context: unknown,
  method: string,
): Promise<ChangeRecovery> {
  const empty: ChangeRecovery = { all: [], allAmounts: [], outputs: [], signatures: [] };
  const ctx = context as MeltContextLike;
  const operation = ctx.operation!;
  const keep = operation.changeOutputData?.keep;
  if (!Array.isArray(keep) || keep.length === 0) return empty;

  const walletService = ctx.walletService;
  if (typeof walletService?.getWalletWithActiveKeysetId !== "function") {
    throw new Error("Coco wallet service unavailable; cannot restore expired-melt change");
  }
  const { wallet } = await walletService.getWalletWithActiveKeysetId(operation.mintUrl);
  const walletLike = wallet as RestoreWalletLike | undefined;
  const restore = walletLike?.mint?.restore;
  if (typeof restore !== "function") {
    throw new Error("Wallet has no NUT-09 restore; cannot recover expired-melt change");
  }

  let result: RestoreResultLike;
  try {
    result = (await restore.call(walletLike!.mint, {
      outputs: keep.map((output) => output.blindedMessage),
    })) as RestoreResultLike;
  } catch (error) {
    if (!isRestoreUnsupportedError(error)) {
      // Transport/5xx: the operation stays pending and the sweep backs off.
      throw error;
    }
    logger.warn(
      "Mint has no usable NUT-09 restore; finalizing expired melt without change",
      {
        method,
        operationId: operation.id,
        mintUrl: operation.mintUrl,
        error: error instanceof Error ? error.message : String(error),
      },
    );
    return empty;
  }

  const restoredOutputs = Array.isArray(result?.outputs) ? result.outputs : [];
  const restoredSignatures = Array.isArray(result?.signatures) ? result.signatures : [];
  const unmatched = new Map(
    keep
      .filter((output) => typeof output?.blindedMessage?.B_ === "string")
      .map((output) => [output.blindedMessage.B_, output] as const),
  );

  const all: SerializedChangeOutput[] = [];
  const allSignatures: unknown[] = [];
  const allAmounts: number[] = [];
  for (let index = 0; index < restoredOutputs.length; index++) {
    const restored = restoredOutputs[index];
    const signature = restoredSignatures[index];
    const B_ = restored?.B_;
    if (typeof B_ !== "string" || !signature) continue;
    const output = unmatched.get(B_);
    if (!output) continue;
    unmatched.delete(B_);
    all.push(output);
    allSignatures.push(signature);
    // Blank outputs carry amount 0; the signature carries the real amount.
    allAmounts.push(signatureAmount(signature));
  }

  if (all.length === 0) {
    logger.warn(
      "Mint restored no change signatures for expired melt; finalizing without change",
      { method, operationId: operation.id, mintUrl: operation.mintUrl, changeOutputs: keep.length },
    );
    return empty;
  }
  if (all.length < keep.length) {
    logger.info("Mint restored only part of the expired melt change", {
      method,
      operationId: operation.id,
      restored: all.length,
      changeOutputs: keep.length,
    });
  }

  // Never re-save a secret the wallet already holds (from an earlier attempt or
  // a seed restore under another operation), and only save change the mint
  // reports UNSPENT so spent change is not resurrected as spendable.
  const candidates: number[] = [];
  let alreadyKnown = 0;
  for (let index = 0; index < all.length; index++) {
    const secret = decodeSerializedSecret(all[index]!.secret);
    if (!secret) continue;
    if (await walletHoldsSecret(ctx, operation.mintUrl, secret)) {
      alreadyKnown++;
      continue;
    }
    candidates.push(index);
  }

  const unspent = await unspentChangeIndexes(ctx, operation.mintUrl, all, candidates, method);
  const outputs: SerializedChangeOutput[] = [];
  const signatures: unknown[] = [];
  for (const index of unspent) {
    outputs.push(all[index]!);
    signatures.push(allSignatures[index]);
  }

  const skipped = all.length - outputs.length;
  if (skipped > 0) {
    logger.info("Skipped some restored melt change", {
      method,
      operationId: operation.id,
      alreadyKnown,
      notUnspent: candidates.length - unspent.length,
      restored: all.length,
      saved: outputs.length,
    });
  }

  return { all, allAmounts, outputs, signatures };
}

/** Whether any proof with this secret is already persisted for this mint. */
async function walletHoldsSecret(
  ctx: MeltContextLike,
  mintUrl: string,
  secret: string,
): Promise<boolean> {
  const repository = ctx.proofRepository;
  if (typeof repository?.getProofBySecret !== "function") return false;
  try {
    return (await repository.getProofBySecret(mintUrl, secret)) !== null;
  } catch {
    // A read failure must not risk a duplicate save: treat as already present.
    return true;
  }
}

/** NUT-07 filter: only save restored change the mint reports UNSPENT. */
async function unspentChangeIndexes(
  ctx: MeltContextLike,
  mintUrl: string,
  outputs: SerializedChangeOutput[],
  candidates: number[],
  method: string,
): Promise<number[]> {
  if (candidates.length === 0) return [];
  const checkProofStates = ctx.mintAdapter?.checkProofStates;
  if (typeof checkProofStates !== "function") {
    logger.warn("Cannot verify restored change states; not saving change", {
      method,
      mintUrl,
      candidates: candidates.length,
    });
    return [];
  }

  const encoder = new TextEncoder();
  const Ys: string[] = [];
  const YByIndex = new Map<number, string>();
  for (const index of candidates) {
    const secret = decodeSerializedSecret(outputs[index]!.secret);
    if (!secret) continue;
    const Y = hashToCurve(encoder.encode(secret)).toHex(true);
    YByIndex.set(index, Y);
    Ys.push(Y);
  }
  if (Ys.length === 0) return [];

  // Request failures propagate before any local mutation; mixed or unknown
  // answers fail closed (skip saving) because the change stays recoverable
  // from the seed if the mint reports it later.
  const states = await checkProofStates(mintUrl, Ys);
  if (!Array.isArray(states)) return [];
  const unspent = new Set<string>();
  for (const entry of states) {
    if (entry && typeof entry.Y === "string" && entry.state === "UNSPENT") {
      unspent.add(entry.Y);
    }
  }
  return candidates.filter((index) => {
    const Y = YByIndex.get(index);
    return Y !== undefined && unspent.has(Y);
  });
}

/**
 * Finalize an expired melt whose inputs are provably SPENT, recovering change
 * through NUT-09. Returns the same settlement shape as the normal handler.
 */
async function finalizeExpiredMelt(
  handler: MeltHandlerLike,
  context: unknown,
  method: string,
): Promise<{ changeAmount: number; effectiveFee: number; finalizedData: undefined }> {
  const ctx = context as MeltContextLike;
  const operation = ctx.operation;
  const getInputSecrets = handler.getMeltInputSecrets;
  const getInputAmount = handler.getMeltInputAmount;
  const calculateSettlement = handler.calculateSettlementAmounts;
  const finalizeOperation = handler.finalizeOperation;
  if (!operation || !getInputSecrets || !getInputAmount ||
      !calculateSettlement || !finalizeOperation ||
      typeof ctx.proofService?.unblindAndSaveChangeProofs !== "function") {
    throw new Error("Coco melt finalize helpers unavailable; keeping expired melt pending");
  }

  // Recompute inputs from the operation itself; the strict SPENT check already
  // ran under the operation lock immediately before this call. Handlers are
  // called with their own `this`: `finalizeOperation` internally uses it.
  const meltInputSecrets = getInputSecrets.call(handler, operation);
  if (!Array.isArray(meltInputSecrets) || meltInputSecrets.length === 0) {
    throw new Error("Expired melt has no melt inputs; keeping it pending");
  }
  const meltInputAmount = getInputAmount.call(handler, operation);
  if (!Number.isFinite(meltInputAmount) || meltInputAmount <= 0) {
    throw new Error(`Expired melt has an unusable input amount (${meltInputAmount}); keeping it pending`);
  }

  const change = await recoverExpiredMeltChange(ctx, method);

  // Hand coco only the change outputs the mint signed, in restore order, so its
  // index-based unblinding pairs each OutputData with its own signature.
  const alignedOperation = {
    ...operation,
    changeOutputData: {
      keep: change.outputs,
      send: operation.changeOutputData?.send ?? [],
    },
  } as PendingMeltOperation;
  await finalizeOperation.call(handler, { ...ctx, operation: alignedOperation }, change.signatures);

  // Amounts come from the mint's signatures; blank outputs are always 0.
  const changeProofs = change.allAmounts.map((amount) => ({ amount }));
  const { changeAmount, effectiveFee } = calculateSettlement.call(
    handler,
    meltInputAmount,
    operation.amount,
    changeProofs,
  );

  logger.info("Expired melt finalized from SPENT inputs", {
    method,
    operationId: operation.id,
    mintUrl: operation.mintUrl,
    meltInputs: meltInputSecrets.length,
    changeProofs: changeProofs.length,
    changeAmount,
    effectiveFee,
  });

  return { changeAmount, effectiveFee, finalizedData: undefined };
}

interface MeltHandlerProviderLike {
  getAll?: () => Record<string, unknown>;
}

/**
 * Wrap every registered melt handler's `checkPending` (and `finalize`) so an
 * expired quote still resolves: rollback only when all actual melt inputs are
 * confirmed UNSPENT, finalize only when they are all confirmed SPENT.
 * If Coco's input-secret or finalize helpers change, fail closed and keep the
 * melt pending.
 *
 * Returns true when at least one handler was wrapped. A false result is not
 * fatal: the daemon keeps running and only the expired-quote edge case stays
 * unfixed. Call once after the coco manager is constructed and enabled.
 */
export function installMeltQuoteExpiryHandler(coco: Manager): boolean {
  let registry: Record<string, unknown> | undefined;
  try {
    const service = (
      coco as unknown as {
        meltOperationService?: { handlerProvider?: MeltHandlerProviderLike };
      }
    ).meltOperationService;
    registry = service?.handlerProvider?.getAll?.();
  } catch (error) {
    logger.warn("Could not read coco melt handler registry", {
      error: error instanceof Error ? error.message : String(error),
    });
    return false;
  }

  if (!registry || Object.keys(registry).length === 0) {
    logger.warn(
      "Melt quote expiry handler not installed: coco melt handler registry unavailable",
    );
    return false;
  }

  let installed = 0;
  for (const [method, handler] of Object.entries(registry)) {
    const candidate = handler as MeltHandlerLike;
    if (typeof candidate.checkPending !== "function") continue;

    const missing = missingFinalizeHelpers(candidate);
    if (missing.length > 0) {
      logger.warn(
        "Coco melt finalize helpers unavailable; expired melts will remain pending",
        { method, missing },
      );
    }
    const canFinalize =
      typeof candidate.finalize === "function" && missing.length === 0;

    const originalCheckPending = candidate.checkPending.bind(candidate);
    candidate.checkPending = async (ctx: unknown) => {
      try {
        return await originalCheckPending(ctx);
      } catch (error) {
        if (!isMeltQuoteExpiredError(error)) throw error;
        const states = await classifyExpiredMeltInputStates(candidate, ctx, method);
        if (states === "all_unspent") {
          logger.info("Expired melt inputs confirmed UNSPENT; allowing rollback", {
            method,
            operationId: operationIdOf(ctx),
          });
          return "rollback";
        }
        if (states === "all_spent") {
          if (!canFinalize) {
            logger.warn(
              "Expired melt inputs are all SPENT but finalize helpers are unavailable; keeping it pending",
              { method, operationId: operationIdOf(ctx) },
            );
            return "stay_pending";
          }
          logger.info("Expired melt inputs confirmed SPENT; allowing finalize", {
            method,
            operationId: operationIdOf(ctx),
          });
          return "finalize";
        }
        logger.info("Expired melt stays pending; inputs are not conclusively spent or unspent", {
          method,
          operationId: operationIdOf(ctx),
          inputs: INPUT_STATE_MEANING[states],
        });
        return "stay_pending";
      }
    };

    if (typeof candidate.finalize === "function" && canFinalize) {
      const originalFinalize = candidate.finalize.bind(candidate);
      candidate.finalize = async (ctx: unknown) => {
        try {
          return await originalFinalize(ctx);
        } catch (error) {
          if (!isMeltQuoteExpiredError(error)) throw error;
          // Re-verify under the operation lock: proof states may have moved
          // between checkPending and finalize.
          const states = await classifyExpiredMeltInputStates(candidate, ctx, method);
          if (states !== "all_spent") {
            logger.warn(
              "Expired melt cannot be finalized: melt inputs are not all SPENT",
              {
                method,
                operationId: operationIdOf(ctx),
                inputs: INPUT_STATE_MEANING[states],
              },
            );
            throw new Error(
              `Expired melt quote cannot be finalized: melt inputs are ${INPUT_STATE_MEANING[states]}, expected all SPENT`,
            );
          }
          return await finalizeExpiredMelt(candidate, ctx, method);
        }
      };
    }

    installed++;
  }

  if (installed === 0) {
    logger.warn(
      "Melt quote expiry handler not installed: no melt handler exposes checkPending",
    );
    return false;
  }

  logger.log(
    `Melt quote expiry handler installed for ${installed} melt method(s) (20007 -> verify inputs)`,
  );
  return true;
}
