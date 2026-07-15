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

  async function syncMintState(
    balances?: Record<string, number>,
  ): Promise<Record<string, number>> {
    const nextBalances = balances || (await client.getBalances());

    mintUnits = Object.fromEntries(
      Object.keys(nextBalances).map((mintUrl) => [mintUrl, "sat"]),
    );

    try {
      const mints = await client.listMints();
      activeMintUrl = mints[0] || Object.keys(nextBalances)[0] || null;
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
      return activeMintUrl;
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

    /** Get the current auto-refill config, re-reading from the getter if available */
    getAutoRefillConfig(): AutoRefillConfig | undefined {
      return options.getAutoRefillConfig?.() ?? options.autoRefill;
    },
    async sendToken(mintUrl: string, amount: number): Promise<string> {
      try {
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
      try {
        const message = await client.receiveCashu(token);
        const { amount, unit } = decodeCashuTokenAmount(token);
        return { success: true, amount, unit, message };
      } catch (error) {
        const errorMessage =
          error instanceof Error ? error.message : String(error);
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
    activeMintUrl = mints[0] || Object.keys(balances)[0] || null;
  } catch (error) {
    logger.error("Failed to initialize wallet adapter state:", error);
  }

  return walletAdapter;
}