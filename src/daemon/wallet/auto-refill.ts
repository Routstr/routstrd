// Auto-refill loop for routstrd
// Monitors Cocod Cashu balance and triggers NWC funding when below threshold.
// This runs server-side, so refills happen regardless of whether a frontend is open.

import type { CocodClient } from "./cocod-client";
import type { NwcClient } from "./nwc-client";
import { logger } from "../../utils/logger";

export interface AutoRefillConfig {
  /** Minimum sats balance before triggering a refill */
  threshold: number;
  /** Amount of sats to refill each time */
  amount: number;
  /** Minimum time between refills (milliseconds) */
  cooldownMs: number;
}

export function startAutoRefillLoop(
  cocod: CocodClient,
  nwc: NwcClient,
  config: AutoRefillConfig,
  intervalMs: number = 5000,
): () => void {
  let lastRefillAt = 0;
  let running = true;
  let timeout: ReturnType<typeof setInterval> | null = null;
  let checkInProgress = false;

  async function checkAndRefill(): Promise<void> {
    if (!running) return;
    if (checkInProgress) return;
    if (!nwc.isConnected()) {
      // NWC not connected — nothing to do
      return;
    }

    const now = Date.now();
    if (now - lastRefillAt < config.cooldownMs) {
      return;
    }

    checkInProgress = true;

    try {
      const balances = await cocod.getBalances();
      const totalBalance = Object.values(balances).reduce<number>(
        (sum, b) => sum + (typeof b === "number" ? b : 0),
        0,
      );

      if (totalBalance >= config.threshold) {
        // Balance is sufficient
        return;
      }

      logger.log(
        `[auto-refill] Balance ${totalBalance} sats < threshold ${config.threshold}. Refilling ${config.amount} sats...`,
      );

      // Get active mint
      const mints = await cocod.listMints();
      const mintUrl = mints[0];
      if (!mintUrl) {
        logger.error("[auto-refill] No active mint configured");
        return;
      }

      // Step 1: Create a BOLT-11 invoice via cocod to fund the Cashu wallet
      logger.log(
        `[auto-refill] Creating BOLT-11 invoice for ${config.amount} sats via ${mintUrl}...`,
      );
      const invoice = await cocod.receiveBolt11(config.amount, mintUrl);

      // Step 2: Pay the invoice via NWC
      logger.log(`[auto-refill] Paying invoice via NWC...`);
      const { preimage } = await nwc.payInvoice(invoice, config.amount);

      // Step 3: The Cashu mint should automatically detect the paid invoice
      // and issue tokens. We don't need to explicitly mint here; cocod
      // handles this on its end when the mint sees the payment.
      logger.log(
        `[auto-refill] Successfully refilled ${config.amount} sats. Preimage: ${preimage.slice(0, 16)}...`,
      );
      lastRefillAt = now;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      logger.error(`[auto-refill] Error: ${message}`);
    } finally {
      checkInProgress = false;
    }
  }

  // Check immediately on start
  checkAndRefill();

  // Then poll on interval
  timeout = setInterval(checkAndRefill, intervalMs);

  return () => {
    running = false;
    if (timeout) {
      clearInterval(timeout);
      timeout = null;
    }
    logger.log("[auto-refill] Stopped");
  };
}
