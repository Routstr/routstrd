import { describe, expect, test } from "bun:test";
import type { CocodClient } from "../src/daemon/wallet/cocod-client";
import { installMintFallbackTopUp } from "../src/daemon/wallet/sdk-mint-fallback";

function createCocodClient(mints: string[]): CocodClient {
  return {
    ping: async () => true,
    getStatus: async () => "UNLOCKED",
    unlock: async () => "ok",
    getBalances: async () => ({}),
    receiveCashu: async () => "ok",
    receiveBolt11: async () => "invoice",
    sendCashu: async () => "token",
    sendBolt11: async () => "ok",
    listMints: async () => mints,
    addMint: async () => "ok",
    getMintInfo: async () => ({}),
  };
}

describe("SDK top-up mint fallback", () => {
  test("retries provider top-up on mint_unreachable result", async () => {
    const attempts: string[] = [];
    const balanceManager = {
      topUp: async (options: { mintUrl: string }) => {
        attempts.push(options.mintUrl);
        if (options.mintUrl === "https://mint-a.example") {
          return {
            success: false,
            message: { detail: { error: { type: "mint_unreachable" } } },
          };
        }
        return { success: true, toppedUpAmount: 21 };
      },
    };
    const client = { getBalanceManager: () => balanceManager };
    const walletAdapter = {
      getBalances: async () => ({ "https://mint-c.example": 100 }),
    };

    installMintFallbackTopUp(
      client,
      createCocodClient(["https://mint-a.example", "https://mint-b.example"]),
      walletAdapter,
      { log: () => undefined, warn: () => undefined },
    );

    const result = await balanceManager.topUp({
      mintUrl: "https://mint-a.example",
      baseUrl: "https://provider.example",
      amount: 21,
      token: "sk-test",
    });

    expect(result.success).toBe(true);
    expect(attempts).toEqual(["https://mint-a.example", "https://mint-b.example"]);
  });

  test("does not retry provider top-up on unrelated failure", async () => {
    const attempts: string[] = [];
    const balanceManager = {
      topUp: async (options: { mintUrl: string }) => {
        attempts.push(options.mintUrl);
        return { success: false, message: "insufficient balance" };
      },
    };
    const client = { getBalanceManager: () => balanceManager };
    const walletAdapter = { getBalances: async () => ({}) };

    installMintFallbackTopUp(
      client,
      createCocodClient(["https://mint-a.example", "https://mint-b.example"]),
      walletAdapter,
      { log: () => undefined, warn: () => undefined },
    );

    const result = await balanceManager.topUp({
      mintUrl: "https://mint-a.example",
      baseUrl: "https://provider.example",
      amount: 21,
    });

    expect(result).toEqual({ success: false, message: "insufficient balance" });
    expect(attempts).toEqual(["https://mint-a.example"]);
  });
});
