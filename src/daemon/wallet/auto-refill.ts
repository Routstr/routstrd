// Auto-refill loop for routstrd
// Monitors Cocod Cashu balance and triggers NWC funding when below threshold.
// This runs server-side, so refills happen regardless of whether a frontend is open.
//
// Uses applesauce-wallet-connect (same approach as nwc_integration/pay_invoice.mts).

import type { CocodClient } from "./cocod-client";
import type { WalletConnect } from "applesauce-wallet-connect";
import { logger } from "../../utils/logger";

export interface AutoRefillConfig {
  /** Minimum sats balance before triggering a refill */
  threshold: number;
  /** Amount of sats to refill each time */
  amount: number;
  /** Minimum time between refills (milliseconds) */
  cooldownMs: number;
  /** Maximum consecutive failures before stopping (0 = never stop on failures) */
  maxConsecutiveFailures?: number;
}

// Errors that cannot be resolved by retrying — the user must intervene.
const FATAL_ERROR_PATTERNS = [
  /insufficient (?:balance|funds)/i,
  /invalid (?:credentials|auth)/i,
  /forbidden/i,
  /unauthorized/i,
  /invoice.*expired/i,
];

function isFatalError(message: string): boolean {
  return FATAL_ERROR_PATTERNS.some((pattern) => pattern.test(message));
}

export function startAutoRefillLoop(
  cocod: CocodClient,
  wallet: WalletConnect,
  getConfig: () => AutoRefillConfig | undefined,
  intervalMs: number = 5000,
): () => void {
  let lastRefillAt = 0;
  let running = true;
  let timeout: ReturnType<typeof setInterval> | null = null;
  let checkInProgress = false;
  let consecutiveFailures = 0;

  async function checkAndRefill(): Promise<void> {
    if (!running) return;
    if (checkInProgress) return;
    if (!wallet.service) {
      // NWC not connected — nothing to do
      return;
    }

    // Read config fresh each cycle so changes apply without restart
    const config = getConfig();
    if (!config) {
      // Auto-refill disabled
      return;
    }

    const now = Date.now();
    if (now - lastRefillAt < config.cooldownMs) {
      return;
    }

    checkInProgress = true;

    // If we've been failing too much, back off rather than retrying at full speed.
    // This prevents tight loops on transient errors.
    const backoffInterval = Math.min(
      intervalMs * Math.pow(2, consecutiveFailures),
      5 * 60 * 1000, // cap at 5 minutes
    );
    if (now - lastRefillAt < backoffInterval) {
      return;
    }

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

      // Step 2: Pay the invoice via NWC (applesauce)
      logger.log(`[auto-refill] Paying invoice via NWC...`);
      const { preimage, fees_paid } = await wallet.payInvoice(invoice);

      // Step 3: The Cashu mint should automatically detect the paid invoice
      // and issue tokens. We don't need to explicitly mint here; cocod
      // handles this on its end when the mint sees the payment.
      logger.log(
        `[auto-refill] Successfully refilled ${config.amount} sats. Preimage: ${preimage.slice(0, 16)}...`,
      );
      if (fees_paid !== undefined) {
        logger.log(`[auto-refill] Fees paid: ${fees_paid} msats`);
      }
      lastRefillAt = now;
      consecutiveFailures = 0; // reset on success
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      consecutiveFailures++;

      if (isFatalError(message)) {
        // Cooldown for 10 minutes — the user likely needs to fund their NWC wallet.
        // We don't stop permanently so it auto-recovers without a restart.
        const FATAL_COOLDOWN_MS = 10 * 60 * 1000;
        logger.error(
          `[auto-refill] FATAL: ${message}. The funding wallet (NWC) cannot pay. ` +
            `Cooling down for ${FATAL_COOLDOWN_MS / 60000} minutes. ` +
            `Fund your NWC wallet and auto-refill will retry automatically.`,
        );
        lastRefillAt = now; // skip the cooldownMs check, backoff handles the wait
        checkInProgress = false;
        return;
      }

      const maxFailures = config.maxConsecutiveFailures ?? 0;
      if (maxFailures > 0 && consecutiveFailures >= maxFailures) {
        logger.error(
          `[auto-refill] Stopping after ${consecutiveFailures} consecutive failures (maxConsecutiveFailures=${maxFailures}). ` +
            `Last error: ${message}`,
        );
        running = false;
        return;
      }

      logger.error(
        `[auto-refill] Error (attempt ${consecutiveFailures}, next in ${Math.round(backoffInterval / 1000)}s): ${message}`,
      );
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