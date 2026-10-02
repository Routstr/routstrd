import { getTokenMetadata } from "@cashu/cashu-ts";
import { InsufficientBalanceError } from "@routstr/sdk";
import { WalletConnect } from "applesauce-wallet-connect";
import { WalletBaseError } from "applesauce-wallet-connect/helpers/error";
import { RelayPool } from "applesauce-relay";
import { logger } from "../../utils/logger";
import { withTimeout } from "../../utils/with-timeout";
import type { WalletClient } from "./wallet-client";
import { startAutoRefillLoop, type AutoRefillConfig } from "./auto-refill";

/**
 * NWC reads (get_info/get_balance) should answer in a couple of seconds. If
 * they don't, the long-lived relay subscription is presumed stale and the
 * connection is rebuilt before one retry.
 */
const NWC_READ_TIMEOUT_MS = 15_000;
/** Overall bound including encryption negotiation; replies have a library 30s timeout. */
const NWC_PAY_TIMEOUT_MS = 45_000;

type NwcPayment = { preimage?: string; fees_paid?: number };

export function decodeCashuTokenAmount(token: string): {
  amount: number;
  unit: "sat" | "msat";
} {
  // TokenV4 may contain an 8-byte short keyset ID. Fully decoding its
  // proofs requires the mint's full keyset IDs, but amount and unit do not.
  // getTokenMetadata intentionally extracts those fields without trying to
  // map short IDs, unlike getDecodedToken(token, []).
  const metadata = getTokenMetadata(token);
  const amount = metadata.amount.toNumber();
  const unit = metadata.unit === "msat" ? "msat" : "sat";
  return { amount, unit };
}

export async function receiveCashuToken(
  client: Pick<WalletClient, "receiveCashu">,
  token: string,
): Promise<{ message: string; amount: number; unit: "sat" | "msat" }> {
  // Validate the token before handing it to a state-changing wallet call. This
  // prevents a successful receive from being reported as a failure if local
  // metadata parsing ever rejects a future token format.
  const { amount, unit } = decodeCashuTokenAmount(token);
  const message = await client.receiveCashu(token);
  return { message, amount, unit };
}

export interface WalletAdapterOptions {
  /** The in-process wallet engine. Required — construct it with `createCocoClient()`. */
  walletClient: WalletClient;
  /** NWC connection string for Lightning funding (uses applesauce-wallet-connect) */
  nwcConnectionString?: string;
  /** Override the NWC read timeout in milliseconds (test hook). */
  nwcReadTimeoutMs?: number;
  /** Override the NWC payment timeout in milliseconds (test hook). */
  nwcPayTimeoutMs?: number;
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
  options: WalletAdapterOptions,
) {
  const client = options.walletClient;
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
      // Use default mint as active mint, fall back to first mint in list
      const defaultMint = await client.getDefaultMint();
      activeMintUrl = defaultMint || Object.keys(nextBalances)[0] || null;
    } catch (error) {
      logger.error("Failed to get default mint:", error);
      if (!activeMintUrl) {
        activeMintUrl = Object.keys(nextBalances)[0] || null;
      }
    }

    return nextBalances;
  }

  // ── NWC connection (applesauce approach) ──────────────────────

  let wallet: WalletConnect | undefined;
  let pool: RelayPool | undefined;
  let nwcConnectionString = options.nwcConnectionString;
  const nwcReadTimeoutMs = options.nwcReadTimeoutMs ?? NWC_READ_TIMEOUT_MS;
  const nwcPayTimeoutMs = options.nwcPayTimeoutMs ?? NWC_PAY_TIMEOUT_MS;

  // Getter for the current wallet instance (used by auto-refill loop)
  const getWallet = (): WalletConnect | undefined => wallet;

  /** Close the active relay pool, if any. */
  function closeNwcPool(): void {
    if (pool) {
      for (const [url] of pool.relays) {
        pool.remove(url, true);
      }
    }
    pool = undefined;
  }

  /**
   * (Re)create the relay pool + WalletConnect client for a connection string.
   * Shared by interactive connects and self-healing recovery so both paths use
   * identical setup.
   */
  function connectNwc(connectionString: string, reason: string): void {
    const nextPool = new RelayPool();
    const nextWallet = WalletConnect.fromConnectURI(connectionString, {
      pool: nextPool,
    });

    pool = nextPool;
    wallet = nextWallet;
    nwcConnectionString = connectionString;

    // Connect in background (non-blocking)
    nextWallet
      .waitForService()
      .then(() => {
        logger.log(
          `[nwc] NWC wallet ${reason}. Relay: ${nextWallet.relays[0]}, Service: ${nextWallet.service}`,
        );
      })
      .catch((err) => {
        logger.error(`[nwc] NWC connection failed: ${err.message}`);
      });
  }

  /**
   * Rebuild the NWC connection in place after a request stalled. applesauce's
   * request timeout only covers the response stream, so a stale relay
   * subscription can leave `getInfo`/`getBalance` pending forever while it
   * negotiates encryption. Recreating the pool gives the next call a fresh
   * subscription.
   */
  function rebuildNwcConnection(reason: string): void {
    if (!nwcConnectionString) return;
    closeNwcPool();
    wallet = undefined;
    connectNwc(nwcConnectionString, reason);
  }

  /**
   * Run an idempotent NWC read, bounding the wait and rebuilding the connection
   * once if it stalls.
   */
  async function nwcRead<T>(
    label: string,
    operation: (w: WalletConnect) => Promise<T>,
  ): Promise<T> {
    const first = wallet;
    if (!first?.service) {
      throw new Error("NWC not connected");
    }
    try {
      return await withTimeout(
        operation(first),
        nwcReadTimeoutMs,
        `${label} timed out`,
      );
    } catch (error) {
      // A normal NIP-47 error proves the wallet answered. Keep other calls alive.
      if (error instanceof WalletBaseError || !nwcConnectionString) throw error;
      logger.warn(
        `[nwc] ${label} failed (${(error as Error).message}); rebuilding NWC connection and retrying`,
      );
      rebuildNwcConnection("reconnected after stall");
      const retry = wallet;
      if (!retry?.service) throw error;
      return await withTimeout(
        operation(retry),
        nwcReadTimeoutMs,
        `${label} timed out after reconnect`,
      );
    }
  }

  /**
   * Pay a BOLT-11 invoice over NWC with a bounded wait. A timeout rebuilds the
   * relay connection so later calls recover without a daemon restart. The
   * payment is not retried here. A timeout is an unknown payment outcome,
   * not proof of failure; callers must reconcile before trying a fresh invoice.
   */
  async function payNwcInvoice(invoice: string): Promise<NwcPayment> {
    const payer = wallet;
    if (!payer?.service) throw new Error("NWC not connected");
    try {
      return await withTimeout(
        payer.payInvoice(invoice),
        nwcPayTimeoutMs,
        "NWC payment timed out",
      );
    } catch (error) {
      // Include the library's own timeout, but not normal wallet error replies.
      if (!(error instanceof WalletBaseError)) {
        rebuildNwcConnection("reconnected after payment stall");
      }
      throw error;
    }
  }

  if (options.nwcConnectionString) {
    connectNwc(options.nwcConnectionString, "connected");
  }

  const walletAdapter = {
    async reconnect(connectionString?: string): Promise<void> {
      logger.log(
        `[nwc] Reconnecting NWC wallet... ${connectionString ? "new connection string provided" : "disconnecting"}`,
      );

      // Close existing relay pool connections and update the wallet reference
      closeNwcPool();
      wallet = undefined;

      if (connectionString) {
        connectNwc(connectionString, "reconnected");
      } else {
        nwcConnectionString = undefined;
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

      // Use default mint for NWC funding
      const defaultMint = await client.getDefaultMint();
      const mintUrl = defaultMint;
      if (!mintUrl) {
        logger.error("[nwc] No default mint configured");
        return { success: false, invoice: "", error: "No default mint configured" };
      }

      try {
        // Step 1: Check initial balance
        logger.log(`[nwc] Checking initial cocod balance on mint ${mintUrl}...`);
        let initialBalance: number | null = null;
        try {
          const balances = await client.getBalances();
          initialBalance = balances[mintUrl] ?? 0;
          logger.log(`[nwc]   Initial balance: ${initialBalance} sats`);
        } catch {
          logger.log("[nwc]   Could not retrieve initial balance");
        }

        // Step 2: Create a BOLT-11 invoice via cocod
        logger.log(`[nwc] Creating ${amount}-sat Lightning invoice via cocod...`);
        const { invoice } = await client.receiveBolt11(amount, mintUrl);
        logger.log(`[nwc]   Invoice: ${invoice}`);

        // Step 3: Pay it via NWC (bounded — a stale relay must not hang the CLI)
        logger.log("[nwc] Paying invoice via NWC...");
        const { preimage, fees_paid } = await payNwcInvoice(invoice);
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
        const info = await nwcRead("get_info", (w) => w.getInfo());
        let balance: number | undefined;
        try {
          const bal = await nwcRead("get_balance", (w) => w.getBalance());
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
      const maxRetries = 3;
      const retryDelayMs = 5000;
      const retryErrorPattern = "Proof already reserved by operation";

      for (let attempt = 0; attempt <= maxRetries; attempt++) {
        try {
          return await client.sendCashu(amount, mintUrl);
        } catch (error) {
          const errorMessage =
            error instanceof Error ? error.message : String(error);

          const shouldRetry =
            attempt < maxRetries && errorMessage.includes(retryErrorPattern);

          if (shouldRetry) {
            logger.log(
              `sendToken attempt ${attempt + 1} failed with reserved proof error, retrying in ${retryDelayMs / 1000}s...`,
            );
            await new Promise((resolve) => setTimeout(resolve, retryDelayMs));
            continue;
          }

          if (errorMessage.includes("Not enough proofs")) {
            throw new InsufficientBalanceError(amount, 0);
          }

          logger.error("Error in walletAdapter sendToken:", error);
          throw error;
        }
      }

      throw new Error("sendToken failed after max retries");
    },
    async receiveToken(token: string): Promise<{
      success: boolean;
      amount: number;
      unit: "sat" | "msat";
      message?: string;
    }> {
      try {
        const { amount, unit, message } = await receiveCashuToken(client, token);
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

  /**
   * Start the auto-refill loop if it is not already running. Safe to call more
   * than once; it becomes a no-op after the first call.
   */
  function ensureAutoRefillLoop(): void {
    if (stopAutoRefill) return;
    const getConfig = options.getAutoRefillConfig ?? (() => options.autoRefill);
    stopAutoRefill = startAutoRefillLoop(
      client,
      getWallet,
      getConfig,
      5000,
      payNwcInvoice,
    );
  }

  const autoRefillConfig = options.getAutoRefillConfig
    ? options.getAutoRefillConfig()
    : options.autoRefill;

  if (options.getAutoRefillConfig || options.autoRefill) {
    // Start the loop even when no wallet is connected yet: it reads the wallet
    // and config fresh each cycle, so a later `nwc connect` activates refills
    // without a daemon restart.
    ensureAutoRefillLoop();
    if (autoRefillConfig) {
      logger.log(
        `[wallet] Auto-refill enabled: threshold=${autoRefillConfig.threshold} sats, amount=${autoRefillConfig.amount} sats, cooldown=${autoRefillConfig.cooldownMs / 60000} minutes`,
      );
    } else {
      logger.log(
        "[wallet] Auto-refill loop started (currently disabled — enable via CLI to activate)",
      );
    }
  }

  try {
    const [balances, defaultMint] = await Promise.all([
      client.getBalances(),
      client.getDefaultMint().catch(() => null),
    ]);
    mintUnits = Object.fromEntries(
      Object.keys(balances).map((mintUrl) => [mintUrl, "sat"]),
    );
    activeMintUrl = defaultMint || Object.keys(balances)[0] || null;
  } catch (error) {
    logger.error("Failed to initialize wallet adapter state:", error);
  }

  return walletAdapter;
}
