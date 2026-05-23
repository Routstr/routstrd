import { getDecodedToken, Amount } from "@cashu/cashu-ts";
import { InsufficientBalanceError } from "@routstr/sdk";
import { WalletConnect } from "applesauce-wallet-connect";
import { RelayPool } from "applesauce-relay";
import { logger } from "../../utils/logger";
import { createCocodClient, type CocodClient } from "./cocod-client";
import { startAutoRefillLoop, type AutoRefillConfig } from "./auto-refill";

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

      // Ensure we have an active mint
      await syncMintState();
      const mintUrl = activeMintUrl;
      if (!mintUrl) {
        logger.error("[nwc] No active mint configured");
        return { success: false, invoice: "", error: "No active mint configured" };
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
        const invoice = await client.receiveBolt11(amount, mintUrl);
        logger.log(`[nwc]   Invoice: ${invoice}`);

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

    /** Get the auto-refill config */
    getAutoRefillConfig(): AutoRefillConfig | undefined {
      return options.autoRefill;
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
    stopAutoRefill = startAutoRefillLoop(client, wallet, getConfig);
    logger.log(
      `[wallet] Auto-refill enabled: threshold=${autoRefillConfig.threshold} sats, amount=${autoRefillConfig.amount} sats, cooldown=${autoRefillConfig.cooldownMs}ms`,
    );
  } else if (wallet && options.getAutoRefillConfig) {
    // Wallet exists but auto-refill is not currently enabled.
    // Start the loop anyway so it can pick up changes without a restart.
    stopAutoRefill = startAutoRefillLoop(client, wallet, options.getAutoRefillConfig);
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