/**
 * Map an expired or purged melt quote to UNPAID on the pending path.
 *
 * coco 1.0.1's melt handler already maps error 20007 ("quote expired") to
 * UNPAID in `recoverExecuting`, but its `checkPending` asks the mint without
 * that catch. A pending melt whose quote the mint has purged therefore throws,
 * which leaves the operation stuck forever: `refresh()` fails and `reclaim()`
 * re-runs the same check and throws at the same place. Applying the same
 * mapping to `checkPending` makes both paths work, so the operation can roll
 * back and its input proofs return to the spendable balance.
 *
 * This is a version-sensitive bridge in the same spirit as
 * `sendRecoveryServiceOf` and `cleanupLocalRecoveryState`: if coco's handler
 * shape changes, installation reports it instead of silently doing nothing.
 * Errors are matched by numeric code as well as by class because the throw
 * crosses the coco package boundary.
 */
import { MintOperationError, type Manager } from "@cashu/coco-core";
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

interface MeltHandlerLike {
  checkPending?: (ctx: unknown) => Promise<unknown>;
}

interface MeltHandlerProviderLike {
  getAll?: () => Record<string, unknown>;
}

/**
 * Wrap every registered melt handler's `checkPending` so an expired quote
 * becomes a rollback decision instead of a thrown error.
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
    const original = candidate.checkPending.bind(candidate);
    candidate.checkPending = async (ctx: unknown) => {
      try {
        return await original(ctx);
      } catch (error) {
        if (isMeltQuoteExpiredError(error)) {
          logger.info(
            "Melt quote expired at the mint; treating as UNPAID for rollback",
            { method },
          );
          return "rollback";
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
    `Melt quote expiry handler installed for ${installed} melt method(s) (20007 -> rollback)`,
  );
  return true;
}
