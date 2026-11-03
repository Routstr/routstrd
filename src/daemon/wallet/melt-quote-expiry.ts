/**
 * Recover pending melts with expired/purged quotes only after NUT-07 checks.
 *
 * coco 1.0.1's melt handler already maps error 20007 ("quote expired") to
 * UNPAID in `recoverExecuting`, but its `checkPending` asks the mint without
 * that catch. A pending melt whose quote the mint has purged therefore throws,
 * which leaves the operation stuck forever: `refresh()` fails and `reclaim()`
 * re-runs the same check and throws at the same place. Quote expiry alone is
 * not evidence of payment failure: proofs can still be PENDING or SPENT. Only
 * a complete, matching set of UNSPENT states permits rollback. Unknown states,
 * missing/malformed results, and lookup failures preserve the reservations.
 * Request failures propagate so recovery callers can classify and back off an
 * unreachable mint instead of interpreting the lookup as a successful check.
 *
 * This is a version-sensitive bridge in the same spirit as
 * `sendRecoveryServiceOf` and `cleanupLocalRecoveryState`: if coco's handler
 * shape changes, installation reports it instead of silently doing nothing.
 * Errors are matched by numeric code as well as by class because the throw
 * crosses the coco package boundary.
 */
import { hashToCurve } from "@cashu/cashu-ts";
import { MintOperationError, type Manager, type MeltOperation } from "@cashu/coco-core";
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

interface MeltHandlerLike {
  checkPending?: (ctx: unknown) => Promise<unknown>;
  /** Coco 1.0.1 helper: selects swap-send secrets rather than spent swap inputs. */
  getMeltInputSecrets?: (operation: PendingMeltOperation) => string[];
}

interface PendingContextLike {
  operation: PendingMeltOperation;
  mintAdapter: {
    checkProofStates: (mintUrl: string, Ys: string[]) => Promise<unknown>;
  };
}

async function expiredInputsAreUnspent(handler: MeltHandlerLike, context: unknown): Promise<boolean> {
  const ctx = context as PendingContextLike;
  let Ys: string[];
  let expected: Set<string>;
  try {
    if (typeof ctx.operation.needsSwap !== "boolean") return false;
    const secrets = handler.getMeltInputSecrets?.(ctx.operation);
    if (!Array.isArray(secrets) || secrets.length === 0 ||
        secrets.some((secret) => typeof secret !== "string" || secret.length === 0) ||
        new Set(secrets).size !== secrets.length) return false;

    const encoder = new TextEncoder();
    Ys = secrets.map((secret) => hashToCurve(encoder.encode(secret)).toHex(true));
    expected = new Set(Ys);
    if (expected.size !== Ys.length || typeof ctx.mintAdapter?.checkProofStates !== "function") return false;
  } catch (error) {
    logger.warn("Could not verify expired melt input states; preserving reservations", {
      error: error instanceof Error ? error.message : String(error),
    });
    return false;
  }
  // Use raw NUT-07 results: wallet.checkProofsStates() maps by Y and can hide
  // duplicate responses. Do not swallow request errors: the sweep needs their
  // transport classification to back off this mint, while proofs stay reserved.
  const states = await ctx.mintAdapter.checkProofStates(ctx.operation.mintUrl, Ys);
  if (!Array.isArray(states) || states.length !== Ys.length) return false;
  for (const entry of states) {
    if (!entry || typeof entry.Y !== "string" || entry.state !== "UNSPENT" ||
        !expected.delete(entry.Y)) return false;
  }
  return expected.size === 0;
}

interface MeltHandlerProviderLike {
  getAll?: () => Record<string, unknown>;
}

/**
 * Wrap every registered melt handler's `checkPending` so an expired quote
 * permits rollback only when all actual melt inputs are confirmed UNSPENT.
 * If Coco's input-secret helper changes, fail closed and keep the melt pending.
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
    if (typeof candidate.getMeltInputSecrets !== "function") {
      logger.warn("Coco melt input-secret helper unavailable; expired melts will remain pending", { method });
    }
    const original = candidate.checkPending.bind(candidate);
    candidate.checkPending = async (ctx: unknown) => {
      try {
        return await original(ctx);
      } catch (error) {
        if (isMeltQuoteExpiredError(error)) {
          if (await expiredInputsAreUnspent(candidate, ctx)) {
            logger.info("Expired melt inputs confirmed UNSPENT; allowing rollback", { method });
            return "rollback";
          }
          return "stay_pending";
        }
        throw error;
      }
    };
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
