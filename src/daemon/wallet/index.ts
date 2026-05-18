import { getDecodedToken, Amount } from "@cashu/cashu-ts";
import { InsufficientBalanceError } from "@routstr/sdk";
import { logger } from "../../utils/logger";
import { createCocodClient, type CocodClient } from "./cocod-client";
import type { NwcClient } from "./nwc-client";
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
  /** Optional NWC client for Lightning funding */
  nwcClient?: NwcClient;
  /** Auto-refill configuration (requires nwcClient) */
  autoRefill?: AutoRefillConfig;
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
      const nwc = options.nwcClient;
      if (!nwc || !nwc.isConnected()) {
        return { success: false, invoice: "", error: "NWC not connected" };
      }

      // Ensure we have an active mint
      await syncMintState();
      const mintUrl = activeMintUrl;
      if (!mintUrl) {
        return { success: false, invoice: "", error: "No active mint configured" };
      }

      try {
        // Step 1: Create a BOLT-11 invoice via cocod
        const invoice = await client.receiveBolt11(amount, mintUrl);

        // Step 2: Pay it via NWC
        const { preimage } = await nwc.payInvoice(invoice, amount);

        return { success: true, invoice, preimage };
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
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
      const nwc = options.nwcClient;
      if (!nwc) {
        return { connected: false, error: "NWC not configured" };
      }

      if (!nwc.isConnected()) {
        return { connected: false, error: "NWC not connected" };
      }

      try {
        const info = await nwc.getInfo();
        let balance: number | undefined;
        try {
          balance = await nwc.getBalance();
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

  if (options.autoRefill && options.nwcClient) {
    // Start after initial state sync
    const startRefill = () => {
      stopAutoRefill = startAutoRefillLoop(
        client,
        options.nwcClient!,
        options.autoRefill!,
      );
      logger.log(
        `[wallet] Auto-refill enabled: threshold=${options.autoRefill!.threshold} sats, amount=${options.autoRefill!.amount} sats, cooldown=${options.autoRefill!.cooldownMs}ms`,
      );
    };

    // If NWC is already connected, start immediately; otherwise,
    // the daemon will start refill after NWC connects
    if (options.nwcClient.isConnected()) {
      startRefill();
    }

    // Store the start function so the daemon can call it after NWC connects
    (walletAdapter as any)._startAutoRefill = startRefill;
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
