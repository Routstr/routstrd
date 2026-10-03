import { expect, it } from "bun:test";
import type { WalletConnect } from "applesauce-wallet-connect";
import { startAutoRefillLoop } from "./auto-refill";
import type { MintQuoteStatus, WalletClient } from "./wallet-client";

/** Invoices created in 500 ms when every payment fails with `paymentError`. */
async function invoicesCreated(
  paymentError: string,
  quoteState: MintQuoteStatus["state"] = "pending",
): Promise<number> {
  let invoices = 0;
  const walletClient = {
    getBalances: async () => ({ "https://mint.example": 0 }),
    getDefaultMint: async () => "https://mint.example",
    receiveBolt11: async () => {
      invoices++;
      return { invoice: `lnbc-${invoices}`, operationId: `op-${invoices}` };
    },
    getMintQuote: async () => ({ state: quoteState }) as MintQuoteStatus,
  } as unknown as WalletClient;
  const stop = startAutoRefillLoop(
    walletClient,
    () => ({ service: "ab" }) as unknown as WalletConnect,
    () => ({ threshold: 500, amount: 100, cooldownMs: 60 * 60 * 1000 }),
    20,
    () => Promise.reject(new Error(paymentError)),
  );
  await new Promise((resolve) => setTimeout(resolve, 500));
  stop();
  return invoices;
}

it("pays no fresh invoice while a timed-out one may still settle", async () => {
  expect(await invoicesCreated("NWC payment timed out", "pending")).toBe(1);
});

it("counts a timed-out payment that landed as the refill", async () => {
  expect(await invoicesCreated("NWC payment timed out", "finalized")).toBe(1);
});

it("refills again once the timed-out invoice expired unpaid", async () => {
  expect(await invoicesCreated("NWC payment timed out", "failed")).toBeGreaterThan(1);
});

it("still retries a payment that failed for another reason", async () => {
  expect(await invoicesCreated("relay closed")).toBeGreaterThan(1);
});
