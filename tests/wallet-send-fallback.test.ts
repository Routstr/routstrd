import { describe, expect, test } from "bun:test";
import { createWalletAdapter } from "../src/daemon/wallet";
import type { CocodClient } from "../src/daemon/wallet/cocod-client";

function createClient(overrides: Partial<CocodClient>): CocodClient {
  return {
    ping: async () => true,
    getStatus: async () => "UNLOCKED",
    unlock: async () => "ok",
    getBalances: async () => ({}),
    receiveCashu: async () => "ok",
    receiveBolt11: async () => "invoice",
    sendCashu: async () => "token",
    sendBolt11: async () => "ok",
    listMints: async () => [],
    addMint: async () => "ok",
    getMintInfo: async () => ({}),
    ...overrides,
  };
}

describe("wallet sendToken mint identity", () => {
  test("uses a larger denomination from the same mint when the exact amount cannot be composed", async () => {
    const attempts: Array<{ amount: number; mintUrl: string }> = [];
    const client = createClient({
      getBalances: async () => ({
        "https://mint.cubabitcoin.org": 4104,
        "https://mint.minibits.cash/Bitcoin": 61409,
      }),
      listMints: async () => [
        "https://mint.minibits.cash/Bitcoin",
        "https://mint.cubabitcoin.org",
      ],
      sendCashu: async (amount, mintUrl) => {
        attempts.push({ amount, mintUrl: mintUrl || "" });
        if (amount === 1024) return "cashu-larger-same-mint-token";
        throw new Error("Not enough proofs");
      },
    });

    const walletAdapter = await createWalletAdapter({ walletClient: client });

    await expect(
      walletAdapter.sendToken("https://mint.cubabitcoin.org", 612),
    ).resolves.toBe("cashu-larger-same-mint-token");
    expect(attempts).toEqual([
      { amount: 612, mintUrl: "https://mint.cubabitcoin.org" },
      { amount: 1024, mintUrl: "https://mint.cubabitcoin.org" },
    ]);
  });
});
