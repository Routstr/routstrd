import { describe, expect, it, test } from "bun:test";
import type { WalletConnect } from "applesauce-wallet-connect";
import { startAutoRefillLoop, type AutoRefillConfig } from "./auto-refill";
import type { MintQuoteStatus, WalletClient } from "./wallet-client";

/**
 * Regression tests for the auto-refill loop.
 *
 * Two independent guards live here:
 *
 * 1. Balance pre-flight: the loop used to create a BOLT-11 invoice (and
 *    therefore a pending mint quote) without checking whether the NWC funding
 *    wallet could pay it. When it was underfunded, every backoff attempt
 *    leaked another quote.
 * 2. Timeout reconciliation: an NWC payment that exceeded the 45 s timeout is
 *    an unknown outcome, not a failure, so no fresh invoice may be created
 *    until the wallet settles the one that timed out.
 */

const MINT = "https://mint.example";

interface Harness {
  stop: () => void;
  receiveCalls: () => number;
  payCalls: () => number;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** A minimal NWC wallet stub: the loop only checks `.service` truthiness. */
const connectedWallet = { service: "ab".repeat(32) } as unknown as WalletConnect;

function startLoop(options: {
  balance: Record<string, number>;
  config?: AutoRefillConfig;
  nwcBalance?: number | (() => Promise<number | undefined>) | undefined;
  pay?: (invoice: string) => Promise<{ preimage?: string; fees_paid?: number }>;
}): Harness {
  let receiveCalls = 0;
  let payCalls = 0;

  const client = {
    getBalances: async () => options.balance,
    getDefaultMint: async () => MINT,
    receiveBolt11: async (amount: number) => {
      receiveCalls++;
      return { invoice: `lnbc${amount}` };
    },
  } as unknown as WalletClient;

  const pay =
    options.pay ??
    (async () => {
      payCalls++;
      return { preimage: "00".repeat(32) };
    });

  const nwcBalance = options.nwcBalance;
  const getNwcBalance =
    typeof nwcBalance === "function"
      ? nwcBalance
      : nwcBalance === undefined
        ? undefined
        : async () => nwcBalance;

  const stop = startAutoRefillLoop(
    client,
    () => connectedWallet,
    () => options.config ?? { threshold: 40_000, amount: 50_000, cooldownMs: 60_000 },
    5,
    pay,
    getNwcBalance,
  );

  return { stop, receiveCalls: () => receiveCalls, payCalls: () => payCalls };
}

describe("auto-refill NWC balance pre-flight", () => {
  test("skips refill (no invoice) when the NWC wallet is underfunded", async () => {
    // 8,982 sats can never pay a 50,000-sat invoice.
    const h = startLoop({ balance: { [MINT]: 1_000 }, nwcBalance: 8_982 });
    await sleep(60);
    h.stop();
    expect(h.receiveCalls()).toBe(0);
    expect(h.payCalls()).toBe(0);
  });

  test("skips when the NWC balance covers the amount but not the fee buffer", async () => {
    const h = startLoop({ balance: { [MINT]: 1_000 }, nwcBalance: 50_000 });
    await sleep(60);
    h.stop();
    expect(h.receiveCalls()).toBe(0);
  });

  test("creates and pays the invoice when the NWC wallet can cover amount + fee", async () => {
    const h = startLoop({ balance: { [MINT]: 1_000 }, nwcBalance: 60_000 });
    await sleep(40);
    h.stop();
    expect(h.receiveCalls()).toBe(1);
    expect(h.payCalls()).toBe(1);
  });

  test("proceeds when getNwcBalance throws", async () => {
    const h = startLoop({
      balance: { [MINT]: 1_000 },
      nwcBalance: async () => {
        throw new Error("get_balance unsupported");
      },
    });
    await sleep(40);
    h.stop();
    expect(h.receiveCalls()).toBe(1);
  });

  test("proceeds when no getNwcBalance reader is supplied (back-compat)", async () => {
    const h = startLoop({ balance: { [MINT]: 1_000 } });
    await sleep(40);
    h.stop();
    expect(h.receiveCalls()).toBe(1);
  });

  test("does not touch the NWC wallet when the Cashu balance is sufficient", async () => {
    let balanceReads = 0;
    const h = startLoop({
      balance: { [MINT]: 100_000 },
      nwcBalance: async () => {
        balanceReads++;
        return 0;
      },
    });
    await sleep(40);
    h.stop();
    expect(h.receiveCalls()).toBe(0);
    expect(balanceReads).toBe(0);
  });
});

describe("auto-refill fatal payment errors", () => {
  test("treats an NWC error reply as fatal and does not re-create invoices", async () => {
    let receiveCalls = 0;
    let payCalls = 0;
    const client = {
      getBalances: async () => ({ [MINT]: 1_000 }),
      getDefaultMint: async () => MINT,
      receiveBolt11: async (amount: number) => {
        receiveCalls++;
        return { invoice: `lnbc${amount}` };
      },
    } as unknown as WalletClient;

    const stop = startAutoRefillLoop(
      client,
      () => connectedWallet,
      () => ({ threshold: 40_000, amount: 50_000, cooldownMs: 60_000 }),
      5,
      async () => {
        payCalls++;
        // What applesauce throws when the wallet answers a pay_invoice with a
        // NIP-47 error response instead of a result.
        throw new Error("Unexpected response type: error");
      },
      async () => 60_000,
    );

    await sleep(80); // many 5 ms cycles would run without the cooldown
    stop();
    expect(payCalls).toBe(1);
    expect(receiveCalls).toBe(1);
  });
});

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
