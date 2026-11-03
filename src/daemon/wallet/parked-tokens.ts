/**
 * Recovery of refund tokens the SDK parked after a failed receive.
 *
 * When a provider refund returns a Cashu token and the swap fails (typically
 * "Failed to fetch mint" while the mint is unreachable), `CashuSpender`
 * `cacheReceiveToken`s it and keeps it in `cachedReceiveTokens`. Those tokens
 * are already paid for, so they are money the wallet holds but has not
 * redeemed: the SDK only converts them into spendable proofs when something
 * calls `recoverCachedReceiveTokens()`.
 *
 * Every refund entry point runs through this helper so the scheduled job and
 * both manual routes recover the same set — the parked list is not part of the
 * store's `cachedTokens`/`apiKeys` buckets, so a caller that only looks at
 * those will happily report "nothing to refund" while funds sit unredeemed.
 */
import { logger } from "../../utils/logger";

/** One retried token, as reported by the SDK. */
export interface ParkedTokenResult {
  token: string;
  success: boolean;
}

/** Structural subset of `CashuSpender` needed here (keeps tests trivial). */
export interface ParkedTokenSpender {
  recoverCachedReceiveTokens(): Promise<ParkedTokenResult[]>;
}

/** Structural subset of the SDK client needed here. */
export interface ParkedTokenSource {
  getCashuSpender(): ParkedTokenSpender;
}

export interface ParkedTokenRecovery {
  /** Tokens retried this run (0 when none were parked). */
  attempted: number;
  /** Of those, how many were received and removed from the parked list. */
  succeeded: number;
  /** Set when the sweep itself failed; tokens stay parked either way. */
  error?: string;
}

/**
 * Retry every parked refund token.
 *
 * Never throws: a broken mint (or any unexpected SDK error) must not abort the
 * refund that follows it, because the parked tokens stay parked and the next
 * call retries them again.
 */
export async function recoverParkedTokens(
  refundClient: ParkedTokenSource,
): Promise<ParkedTokenRecovery> {
  let results: ParkedTokenResult[];
  try {
    results = await refundClient.getCashuSpender().recoverCachedReceiveTokens();
  } catch (error) {
    const error_ = error instanceof Error ? error.message : String(error);
    logger.warn(`Parked refund token recovery failed: ${error_}`);
    return { attempted: 0, succeeded: 0, error: error_ };
  }

  const succeeded = results.filter((r) => r.success).length;
  if (results.length > 0) {
    logger.log(
      `Retried ${results.length} parked refund token(s): ${succeeded} received, ${results.length - succeeded} still parked.`,
    );
  }
  return { attempted: results.length, succeeded };
}
