import { afterAll, beforeEach, describe, expect, it, mock } from "bun:test";
import type { CocodClient } from "./cocod-client";

/**
 * Regression tests for the NWC hang fixed in this change.
 *
 * `applesauce-wallet-connect` applies its request timeout only after it has
 * negotiated encryption from the wallet's `kind:13194` info event. On a stale
 * relay subscription that negotiation never completes, so `getInfo()` /
 * `getBalance()` wait forever. The adapter must bound the wait, rebuild the
 * relay connection, and retry once instead of hanging `routstrd nwc status`.
 */

type Behavior = "resolve" | "hang";

const state = {
  infoQueue: [] as Behavior[],
  balanceQueue: [] as Behavior[],
  payQueue: [] as Behavior[],
  createdInstances: 0,
};

function next(queue: Behavior[]): Behavior {
  return queue.shift() ?? "resolve";
}

class MockRelayPool {
  relays = new Map<string, unknown>([["wss://relay.example", {}]]);
  remove(url: string, _close?: boolean): void {
    this.relays.delete(url);
  }
}

class MockWalletConnect {
  service = "ab".repeat(32);
  relays = ["wss://relay.example"];

  constructor() {
    state.createdInstances += 1;
  }

  static fromConnectURI(_uri: string): MockWalletConnect {
    return new MockWalletConnect();
  }

  waitForService(): Promise<string> {
    return Promise.resolve(this.service);
  }

  getInfo(): Promise<{
    alias: string;
    pubkey: string;
    network: string;
    methods: string[];
  }> {
    if (next(state.infoQueue) === "hang") return new Promise<never>(() => {});
    return Promise.resolve({
      alias: "Test Wallet",
      pubkey: "cd".repeat(32),
      network: "mainnet",
      methods: ["get_balance", "get_info"],
    });
  }

  getBalance(): Promise<{ balance: number }> {
    if (next(state.balanceQueue) === "hang") return new Promise<never>(() => {});
    return Promise.resolve({ balance: 123_000 });
  }

  payInvoice(
    _invoice: string,
  ): Promise<{ preimage: string; fees_paid: number }> {
    if (next(state.payQueue) === "hang") return new Promise<never>(() => {});
    return Promise.resolve({ preimage: "00".repeat(32), fees_paid: 1000 });
  }
}

mock.module("applesauce-wallet-connect", () => ({
  WalletConnect: MockWalletConnect,
}));
mock.module("applesauce-relay", () => ({ RelayPool: MockRelayPool }));

const { createWalletAdapter } = await import("./index");

function makeClient(): CocodClient {
  return {
    getBalances: async () => ({ "https://mint.example": 0 }),
    getDefaultMint: async () => "https://mint.example",
    receiveBolt11: async () => ({ invoice: "lnbc-test-invoice" }),
    receiveCashu: async () => "ok",
  } as unknown as CocodClient;
}

function makeAdapter(timeoutMs = 25) {
  return createWalletAdapter({
    walletClient: makeClient(),
    nwcConnectionString:
      "nostr+walletconnect://" +
      "ab".repeat(32) +
      "?relay=wss%3A%2F%2Frelay.example&secret=" +
      "11".repeat(32),
    nwcReadTimeoutMs: timeoutMs,
    nwcPayTimeoutMs: timeoutMs,
  });
}

beforeEach(() => {
  state.infoQueue = [];
  state.balanceQueue = [];
  state.payQueue = [];
  state.createdInstances = 0;
});

afterAll(() => {
  mock.restore();
});

describe("NWC status resilience", () => {
  it("rebuilds a stale relay connection and still reports status", async () => {
    state.infoQueue = ["hang"]; // first attempt stalls, retry succeeds

    const adapter = await makeAdapter();
    const status = await adapter.getNwcStatus();

    expect(status.connected).toBe(true);
    expect(status.alias).toBe("Test Wallet");
    expect(status.balance).toBe(123);
    // initial connection + one rebuild
    expect(state.createdInstances).toBe(2);
  });

  it("returns a bounded error instead of hanging forever", async () => {
    state.infoQueue = ["hang", "hang"]; // every attempt stalls

    const adapter = await makeAdapter();
    const startedAt = Date.now();
    const status = await adapter.getNwcStatus();

    expect(status.connected).toBe(false);
    expect(status.error).toContain("timed out");
    expect(Date.now() - startedAt).toBeLessThan(2_000);
  });

  it("bounds a hung invoice payment and surfaces the error", async () => {
    state.payQueue = ["hang"];

    const adapter = await makeAdapter();
    const startedAt = Date.now();
    const result = await adapter.fundFromNWC(2100);

    expect(result.success).toBe(false);
    expect(result.error).toContain("timed out");
    expect(Date.now() - startedAt).toBeLessThan(2_000);
  });
});
