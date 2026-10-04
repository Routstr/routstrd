import { expect, it } from "bun:test";
import type { WalletConnect } from "applesauce-wallet-connect";
import { startAutoRefillLoop } from "./auto-refill";
import type { MintQuoteStatus, WalletClient } from "./wallet-client";

type Quote = (lookup: number) => Promise<MintQuoteStatus | null>;
const state = (s: MintQuoteStatus["state"]): Quote => async () => ({ state: s }) as MintQuoteStatus;

/** Invoices created in 500 ms when every payment fails with `paymentError`. */
async function invoicesCreated(paymentError: string, quote: Quote = state("pending")): Promise<number> {
  let invoices = 0;
  let lookups = 0;
  const walletClient = {
    getBalances: async () => ({ "https://mint.example": 0 }),
    getDefaultMint: async () => "https://mint.example",
    receiveBolt11: async () => {
      invoices++;
      return { invoice: `lnbc-${invoices}`, operationId: `op-${invoices}` };
    },
    getMintQuote: () => quote(++lookups),
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

const TIMEOUT = "NWC payment timed out";

it("pays no fresh invoice while a timed-out one may still settle", async () => {
  expect(await invoicesCreated(TIMEOUT, state("pending"))).toBe(1);
});

it("fails closed when the timed-out invoice's status is missing or unreadable", async () => {
  expect(await invoicesCreated(TIMEOUT, async () => null)).toBe(1);
  expect(await invoicesCreated(TIMEOUT, async () => Promise.reject(new Error("db busy")))).toBe(1);
});

it("counts a timed-out payment that landed later as the refill", async () => {
  const landsLater: Quote = (n) => state(n < 3 ? "pending" : "finalized")(n);
  expect(await invoicesCreated(TIMEOUT, landsLater)).toBe(1);
});

it("refills again once the timed-out invoice expired unpaid", async () => {
  const expiresLater: Quote = (n) => state(n < 3 ? "pending" : "failed")(n);
  expect(await invoicesCreated(TIMEOUT, expiresLater)).toBeGreaterThan(1);
});

it("still retries a payment that failed for another reason", async () => {
  expect(await invoicesCreated("relay closed")).toBeGreaterThan(1);
});
