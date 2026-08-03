import { createHash } from "crypto";
import { getDecodedToken, Amount } from "@cashu/cashu-ts";
import { WalletConnect } from "applesauce-wallet-connect";
import { RelayPool } from "applesauce-relay";
import { logger } from "../../utils/logger";
import { createCocodClient, type CocodClient } from "./cocod-client";
import { startAutoRefillLoop, type AutoRefillConfig } from "./auto-refill";
import { receiveBolt11WithMintFallback } from "./mint-fallback";

export function decodeCashuTokenAmount(token: string): {
  amount: number;
  unit: "sat" | "msat";
} {
  const decoded = getDecodedToken(token, []);
  const amount =
    decoded?.proofs?.reduce((sum, proof) => sum + proof.amount.toNumber(), 0) ?? 0;
  const unit = decoded?.unit === "msat" ? "msat" : "sat";
  return { amount, unit };
}

type SendCashuOptions = {
  maxRetries?: number;
  retryDelayMs?: number;
  minimumAmountSats?: number;
  fallbackAmounts?: number[];
};

const MIN_PROVIDER_TOKEN_AMOUNT_SATS = 2;

export function getSameMintSendAmounts(
  amount: number,
  availableBalance: number,
): number[] {
  const requestedAmount = Math.max(
    Math.ceil(amount),
    MIN_PROVIDER_TOKEN_AMOUNT_SATS,
  );
  const available = Math.floor(availableBalance);
  const candidates = [requestedAmount];

  if (available <= requestedAmount) return candidates;

  let denomination = 2 ** Math.ceil(Math.log2(requestedAmount));
  while (denomination <= available) {
    if (!candidates.includes(denomination)) candidates.push(denomination);
    denomination *= 2;
  }

  // The entire ready balance is always worth trying last: even when no single
  // power-of-two proof exists, all ready proofs together may be selectable.
  if (!candidates.includes(available)) candidates.push(available);
  return candidates;
}

/**
 * Create a token from exactly the requested mint.
 *
 * The SDK associates the returned token with `mintUrl`. Falling back to another
 * mint here makes that association false and can send providers a token from a
 * mint they cannot reach. Cross-mint fallback belongs above this adapter, where
 * the actual mint URL remains part of the request state.
 */
export async function sendCashuFromMint(
  client: Pick<CocodClient, "sendCashu">,
  mintUrl: string,
  amount: number,
  options: SendCashuOptions = {},
): Promise<string> {
  const maxRetries = options.maxRetries ?? 3;
  const retryDelayMs = options.retryDelayMs ?? 5000;
  const minimumAmountSats = options.minimumAmountSats ?? MIN_PROVIDER_TOKEN_AMOUNT_SATS;
  const sendAmounts = [
    Math.max(amount, minimumAmountSats),
    ...(options.fallbackAmounts ?? []),
  ].filter((candidate, index, all) => candidate > 0 && all.indexOf(candidate) === index);
  const retryErrorPattern = "Proof already reserved by operation";
  let lastInsufficientProofsError: unknown;

  for (const [amountIndex, sendAmount] of sendAmounts.entries()) {
    for (let attempt = 0; attempt <= maxRetries; attempt++) {
      try {
        return await client.sendCashu(sendAmount, mintUrl);
      } catch (error) {
        const errorMessage = error instanceof Error ? error.message : String(error);
        const shouldRetry =
          attempt < maxRetries && errorMessage.includes(retryErrorPattern);

        if (shouldRetry) {
          logger.log(
            `sendToken attempt ${attempt + 1} failed with reserved proof error for ${mintUrl}, retrying in ${retryDelayMs / 1000}s...`,
          );
          await new Promise((resolve) => setTimeout(resolve, retryDelayMs));
          continue;
        }

        if (
          errorMessage.includes("Not enough proofs") &&
          amountIndex + 1 < sendAmounts.length
        ) {
          lastInsufficientProofsError = error;
          logger.warn(
            `sendToken: ${mintUrl} cannot compose ${sendAmount} sats; trying ${sendAmounts[amountIndex + 1]} sats from the same mint`,
          );
          break;
        }

        throw error;
      }
    }
  }

  throw lastInsufficientProofsError ?? new Error("sendToken failed after max retries");
}

/**
 * Thrown when a mint is skipped because it is in the health cooldown.
 *
 * The message deliberately mimics a real fetch failure: the SDK's mint
 * rotation only advances to its next candidate when the error matches its
 * network-error patterns ("Failed to fetch", "Unable to connect", ...).
 * Anything else aborts the rotation after the first candidate. Since the
 * cooldown exists precisely because fetching this mint just failed, reporting
 * it as a fetch failure is both accurate and the signal that makes the caller
 * move on to the next mint.
 */
class MintInCooldownError extends Error {
  constructor(mintUrl: string) {
    super(`Failed to fetch mint ${mintUrl} (in health cooldown after a recent network failure)`);
    this.name = "MintInCooldownError";
  }
}

/**
 * Errors that mean a token can never be received, no matter how often we try.
 *
 * Once a mint has recorded proofs as spent, that is final — unlike a network
 * failure or an unreachable mint, retrying cannot change the outcome. The SDK
 * re-attempts the stored token on every 402, so without this distinction a
 * single dead token costs a mint round-trip on every subsequent request.
 */
const TERMINAL_RECEIVE_ERROR = /already spent|token not found|unknown proof/i;

export function isTerminalReceiveError(message: string): boolean {
  return TERMINAL_RECEIVE_ERROR.test(message);
}

function fingerprintToken(token: string): string {
  return createHash("sha256").update(token).digest("hex").slice(0, 12);
}

export interface WalletAdapterOptions {
  cocodPath?: string | null;
  walletClient?: CocodClient;
  /** NWC connection string for Lightning funding (uses applesauce-wallet-connect) */
  nwcConnectionString?: string;
  /** Auto-refill configuration (static, for startup only) */
  autoRefill?: AutoRefillConfig;
  /**
   * Config getter called on every check cycle to allow live updates.
   * Return undefined to disable auto-refill, or a config to use.
   * When provided, this replaces the static `autoRefill` option.
   */
  getAutoRefillConfig?: () => AutoRefillConfig | undefined;
}

export async function createWalletAdapter(
  options: WalletAdapterOptions = {},
) {
  const client =
    options.walletClient || createCocodClient({ cocodPath: options.cocodPath });
  let activeMintUrl: string | null = null;
  let mintUnits: Record<string, "sat" | "msat"> = {};

  // ── Mint health cache ──────────────────────────────────────────
  // Track mints that are temporarily unreachable (connection refused,
  // DNS failure, etc.). Unhealthy mints are skipped by getActiveMintUrl()
  // and sendToken() so we don't waste a round-trip on every request.
  const MINT_HEALTH_COOLDOWN_MS = 60_000; // 1 minute
  const unhealthyMints = new Map<string, number>(); // mintUrl → timestamp marked unhealthy

  function markMintUnhealthy(mintUrl: string): void {
    const now = Date.now();
    if (!unhealthyMints.has(mintUrl)) {
      logger.warn(`[wallet] Marking mint ${mintUrl} as unhealthy (will skip for ${MINT_HEALTH_COOLDOWN_MS / 1000}s)`);
    }
    unhealthyMints.set(mintUrl, now);
    // If the active mint just went unhealthy, switch to a healthy one
    if (activeMintUrl === mintUrl) {
      const healthy = getFirstHealthyMint();
      if (healthy) {
        activeMintUrl = healthy;
        logger.log(`[wallet] Active mint switched to ${healthy}`);
      }
    }
  }

  function isMintHealthy(mintUrl: string): boolean {
    const markedAt = unhealthyMints.get(mintUrl);
    if (!markedAt) return true;
    if (Date.now() - markedAt >= MINT_HEALTH_COOLDOWN_MS) {
      unhealthyMints.delete(mintUrl);
      logger.log(`[wallet] Mint ${mintUrl} health cooldown expired — will retry`);
      return true;
    }
    return false;
  }

  // ── Dead-token cache ───────────────────────────────────────────
  // Tokens the mint has confirmed as spent. Bounded and FIFO-evicted: this is
  // a latency optimisation, not a correctness store, so forgetting the oldest
  // entry only costs one wasted round-trip if that token resurfaces.
  const MAX_SPENT_TOKEN_CACHE = 512;
  const spentTokens = new Set<string>();

  function rememberSpentToken(tokenKey: string): void {
    if (spentTokens.size >= MAX_SPENT_TOKEN_CACHE) {
      const oldest = spentTokens.values().next().value;
      if (oldest !== undefined) spentTokens.delete(oldest);
    }
    spentTokens.add(tokenKey);
  }

  // Cache of known mints (updated by syncMintState)
  let knownMints: string[] = [];

  function getFirstHealthyMint(): string | null {
    // Try known mints in order, return first healthy one
    for (const mint of knownMints) {
      if (isMintHealthy(mint)) return mint;
    }
    // Fallback: any configured mint even if not in knownMints yet
    return activeMintUrl && isMintHealthy(activeMintUrl) ? activeMintUrl : null;
  }

  function isNetworkFetchError(error: unknown): boolean {
    const msg = error instanceof Error ? error.message : String(error);
    return /failed to fetch/i.test(msg) ||
      /networkerror when attempting to fetch resource/i.test(msg) ||
      /load failed/i.test(msg) ||
      /unable to connect/i.test(msg);
  }

  async function syncMintState(
    balances?: Record<string, number>,
  ): Promise<Record<string, number>> {
    const nextBalances = balances || (await client.getBalances());

    mintUnits = Object.fromEntries(
      Object.keys(nextBalances).map((mintUrl) => [mintUrl, "sat"]),
    );

    // Update known mints list
    knownMints = [...new Set([
      ...Object.keys(nextBalances),
      ...(activeMintUrl ? [activeMintUrl] : []),
    ])];

    try {
      const mints = await client.listMints();
      // Add configured mints to knownMints
      knownMints = [...new Set([...knownMints, ...mints])];
      // Pick first healthy mint — prefer the first configured one,
      // but skip mints currently in the unhealthy cooldown
      const healthyMint = mints.find(m => isMintHealthy(m));
      activeMintUrl = healthyMint || mints[0] || Object.keys(nextBalances)[0] || null;
    } catch (error) {
      logger.error("Failed to list cocod mints:", error);
      if (!activeMintUrl) {
        activeMintUrl = Object.keys(nextBalances)[0] || null;
      }
    }

    return nextBalances;
  }

  // ── NWC connection (applesauce approach) ──────────────────────

  let wallet: WalletConnect | undefined;
  let pool: RelayPool | undefined;

  // Getter for the current wallet instance (used by auto-refill loop)
  const getWallet = (): WalletConnect | undefined => wallet;

  if (options.nwcConnectionString) {
    pool = new RelayPool();
    wallet = WalletConnect.fromConnectURI(options.nwcConnectionString, { pool });

    // Connect in background (non-blocking)
    wallet.waitForService()
      .then(() => {
        logger.log(
          `[nwc] NWC wallet connected. Relay: ${wallet!.relays[0]}, Service: ${wallet!.service}`,
        );
      })
      .catch((err) => {
        logger.error(`[nwc] NWC connection failed: ${err.message}`);
      });
  }

  const walletAdapter = {
    async reconnect(connectionString?: string): Promise<void> {
      logger.log(
        `[nwc] Reconnecting NWC wallet... ${connectionString ? "new connection string provided" : "disconnecting"}`,
      );

      // 1. Close existing relay pool connections
      if (pool) {
        for (const [url] of pool.relays) {
          pool.remove(url, true);
        }
      }

      // 2. Update wallet reference
      wallet = undefined;
      pool = undefined;

      // 3. Create new wallet if connection string provided
      if (connectionString) {
        pool = new RelayPool();
        wallet = WalletConnect.fromConnectURI(connectionString, { pool });

        // Connect in background (non-blocking)
        wallet.waitForService()
          .then(() => {
            logger.log(
              `[nwc] NWC wallet reconnected. Relay: ${wallet!.relays[0]}, Service: ${wallet!.service}`,
            );
          })
          .catch((err) => {
            logger.error(`[nwc] NWC reconnection failed: ${err.message}`);
          });
      } else {
        logger.log("[nwc] NWC wallet disconnected.");
      }
    },

    async getBalances(): Promise<Record<string, number>> {
      return syncMintState();
    },
    getMintUnits(): Record<string, "sat" | "msat"> {
      return mintUnits;
    },
    getActiveMintUrl(): string | null {
      // Return the first healthy mint, falling back to activeMintUrl
      const healthy = getFirstHealthyMint();
      return healthy || activeMintUrl;
    },

    // ── NWC funding methods ────────────────────────────────────

    /** Fund the Cashu wallet from NWC by creating & paying a BOLT-11 invoice */
    async fundFromNWC(amount: number): Promise<{
      success: boolean;
      invoice: string;
      preimage?: string;
      error?: string;
    }> {
      logger.log("=".repeat(50));
      logger.log(`[nwc] Fund Cashu wallet from NWC — amount: ${amount} sats`);
      logger.log("=".repeat(50));

      if (!wallet || !wallet.service) {
        logger.error("[nwc] NWC not connected");
        return { success: false, invoice: "", error: "NWC not connected" };
      }

      // Ensure we have configured mints. If the active mint is unreachable,
      // invoice creation will fall back to later configured mints.
      await syncMintState();
      const configuredMints = await client.listMints();
      const mintCandidates = [activeMintUrl, ...configuredMints].filter(
        (mintUrl): mintUrl is string => typeof mintUrl === "string" && mintUrl.length > 0,
      );
      if (mintCandidates.length === 0) {
        logger.error("[nwc] No active mint configured");
        return { success: false, invoice: "", error: "No active mint configured" };
      }

      try {
        // Step 1: Create a BOLT-11 invoice via cocod
        logger.log(`[nwc] Creating ${amount}-sat Lightning invoice via cocod...`);
        const { invoice, mintUrl } = await receiveBolt11WithMintFallback(
          client,
          amount,
          mintCandidates,
          "[nwc]",
        );
        logger.log(`[nwc]   Invoice: ${invoice}`);
        if (mintUrl !== activeMintUrl) {
          logger.log(`[nwc]   Using fallback mint: ${mintUrl}`);
        }

        // Step 2: Check initial balance
        logger.log(`[nwc] Checking initial cocod balance on mint ${mintUrl}...`);
        let initialBalance: number | null = null;
        try {
          const balances = await client.getBalances();
          initialBalance = balances[mintUrl] ?? 0;
          logger.log(`[nwc]   Initial balance: ${initialBalance} sats`);
        } catch {
          logger.log("[nwc]   Could not retrieve initial balance");
        }

        // Step 3: Pay it via NWC
        logger.log("[nwc] Paying invoice via NWC...");
        const { preimage, fees_paid } = await wallet.payInvoice(invoice);
        logger.log(`[nwc]   ✅ Payment successful!`);
        logger.log(`[nwc]   Preimage: ${preimage}`);
        if (fees_paid !== undefined) {
          logger.log(`[nwc]   Fees paid: ${fees_paid} msats`);
        }

        // Step 4: Check final balance
        logger.log("[nwc] Checking final cocod balance...");
        try {
          const balances = await client.getBalances();
          const finalBalance = balances[mintUrl] ?? 0;
          logger.log(`[nwc]   Final balance: ${finalBalance} sats`);
          if (initialBalance !== null) {
            const diff = finalBalance - initialBalance;
            logger.log(`[nwc]   Balance change: ${diff > 0 ? "+" : ""}${diff} sats`);
          }
        } catch {
          logger.log("[nwc]   Could not retrieve final balance");
        }

        logger.log("=".repeat(50));
        return { success: true, invoice, preimage };
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        logger.error(`[nwc]   ❌ Fund from NWC failed: ${message}`);
        logger.log("=".repeat(50));
        return { success: false, invoice: "", error: message };
      }
    },

    /** Get NWC connection status and wallet info */
    async getNwcStatus(): Promise<{
      connected: boolean;
      alias?: string;
      pubkey?: string;
      network?: string;
      methods?: string[];
      balance?: number;
      error?: string;
    }> {
      if (!wallet) {
        return { connected: false, error: "NWC not configured" };
      }

      if (!wallet.service) {
        return { connected: false, error: "NWC not connected" };
      }

      try {
        const info = await wallet.getInfo();
        let balance: number | undefined;
        try {
          const bal = await wallet.getBalance();
          balance = Math.floor(bal.balance / 1000); // msats → sats
        } catch {
          // Balance might not be available
        }
        return {
          connected: true,
          alias: info.alias,
          pubkey: info.pubkey,
          network: info.network,
          methods: info.methods,
          balance,
        };
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        return { connected: false, error: message };
      }
    },

    /** Pay an externally-created BOLT-11 invoice via NWC. */
    async payBolt11(bolt11: string): Promise<{
      success: boolean;
      preimage?: string;
      error?: string;
    }> {
      if (!wallet || !wallet.service) {
        return { success: false, error: "NWC not connected" };
      }
      if (!bolt11 || typeof bolt11 !== "string" || !bolt11.startsWith("lnbc")) {
        return { success: false, error: "Invalid bolt11 invoice (must start with 'lnbc')" };
      }
      try {
        const { preimage } = await wallet.payInvoice(bolt11);
        return { success: true, preimage };
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        logger.error(`[nwc] payBolt11 failed: ${message}`);
        return { success: false, error: message };
      }
    },

    /** Get the current auto-refill config, re-reading from the getter if available */
    getAutoRefillConfig(): AutoRefillConfig | undefined {
      return options.getAutoRefillConfig?.() ?? options.autoRefill;
    },
    async sendToken(mintUrl: string, amount: number): Promise<string> {
      try {
        // The health cache may skip a mint in cooldown, but it must never
        // substitute a different one: callers label the returned token with
        // `mintUrl`, so swapping mints here makes that label a lie and
        // collapses the cross-mint rotation above us onto a single mint.
        // Reporting the mint as unreachable instead keeps the round-trip
        // savings while letting the caller advance to its next candidate.
        if (!isMintHealthy(mintUrl)) {
          const alternative = getFirstHealthyMint();
          if (alternative && alternative !== mintUrl) {
            logger.log(
              `[wallet] sendToken: mint ${mintUrl} is in health cooldown — reporting it unreachable so the caller rotates to the next mint (${alternative})`,
            );
            throw new MintInCooldownError(mintUrl);
          }
          // No healthy alternative to rotate to, so attempt the requested mint
          // anyway rather than failing a request we might still be able to serve.
        }

        const balances: Record<string, number> = await syncMintState().catch(
          () => ({}),
        );
        const sendAmounts = getSameMintSendAmounts(
          amount,
          balances[mintUrl] ?? amount,
        );
        return await sendCashuFromMint(client, mintUrl, sendAmounts[0]!, {
          fallbackAmounts: sendAmounts.slice(1),
        });
      } catch (error) {
        // Mark the mint as unhealthy so future requests skip it. A cooldown
        // skip is not a fresh failure — re-marking would keep pushing the
        // cooldown timestamp forward on every request and the mint would
        // never be retried.
        if (!(error instanceof MintInCooldownError) && isNetworkFetchError(error)) {
          markMintUnhealthy(mintUrl);
        }
        logger.error("Error in walletAdapter sendToken:", error);
        throw error;
      }
    },
    async receiveToken(token: string): Promise<{
      success: boolean;
      amount: number;
      unit: "sat" | "msat";
      message?: string;
    }> {
      // A token the mint has already burned will never come back. The SDK
      // retries the stored token on every 402, so short-circuit here rather
      // than paying a mint round-trip per request forever.
      const tokenKey = fingerprintToken(token);
      if (spentTokens.has(tokenKey)) {
        const message = "proofs already spent (known dead token, not retried)";
        logger.debug(`[wallet] receiveToken: skipping known-spent token ${tokenKey}`);
        return { success: false, amount: 0, unit: "sat", message };
      }

      try {
        const message = await client.receiveCashu(token);
        const { amount, unit } = decodeCashuTokenAmount(token);
        return { success: true, amount, unit, message };
      } catch (error) {
        const errorMessage =
          error instanceof Error ? error.message : String(error);
        // Remember terminally-dead tokens, but never transient ones: a mint
        // that is merely unreachable now may accept the same token later.
        if (isTerminalReceiveError(errorMessage)) {
          rememberSpentToken(tokenKey);
          logger.warn(
            `[wallet] receiveToken: token ${tokenKey} is permanently unspendable (${errorMessage}); it will not be retried`,
          );
        }
        // Mark the mint as unhealthy if it's a network error
        // (receiveCashu errors include the mint URL in the message)
        if (isNetworkFetchError(error)) {
          // Try to extract mint URL from error message or use activeMintUrl
          const mintMatch = errorMessage.match(/https?:\/\/[^\s/]+\/[^\s]*/);
          const failedMint = mintMatch?.[0] || activeMintUrl;
          if (failedMint) markMintUnhealthy(failedMint);
        }
        logger.error("Error in walletAdapter receiveToken:", errorMessage);
        return { success: false, amount: 0, unit: "sat", message: errorMessage };
      }
    },
  };

  // ── Auto-refill setup ────────────────────────────────────────

  let stopAutoRefill: (() => void) | undefined;

  const autoRefillConfig = options.getAutoRefillConfig
    ? options.getAutoRefillConfig()
    : options.autoRefill;

  if (autoRefillConfig && wallet) {
    const getConfig = options.getAutoRefillConfig ?? (() => options.autoRefill);
    stopAutoRefill = startAutoRefillLoop(client, getWallet, getConfig);
    logger.log(
      `[wallet] Auto-refill enabled: threshold=${autoRefillConfig.threshold} sats, amount=${autoRefillConfig.amount} sats, cooldown=${autoRefillConfig.cooldownMs / 60000} minutes`,
    );
  } else if (wallet && options.getAutoRefillConfig) {
    // Wallet exists but auto-refill is not currently enabled.
    // Start the loop anyway so it can pick up changes without a restart.
    stopAutoRefill = startAutoRefillLoop(client, getWallet, options.getAutoRefillConfig);
    logger.log("[wallet] Auto-refill loop started (currently disabled — enable via CLI to activate)");
  }

  try {
    const [balances, mints] = await Promise.all([
      client.getBalances(),
      client.listMints().catch(() => []),
    ]);
    mintUnits = Object.fromEntries(
      Object.keys(balances).map((mintUrl) => [mintUrl, "sat"]),
    );
    knownMints = [...new Set([...Object.keys(balances), ...mints])];
    const healthyMint = mints.find(m => isMintHealthy(m));
    activeMintUrl = healthyMint || mints[0] || Object.keys(balances)[0] || null;
  } catch (error) {
    logger.error("Failed to initialize wallet adapter state:", error);
  }

  return walletAdapter;
}