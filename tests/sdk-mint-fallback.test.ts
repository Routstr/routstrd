import { describe, expect, test } from "bun:test";
import type { CocodClient } from "../src/daemon/wallet/cocod-client";
import {
  installMintFallbackTopUp,
  installMintUnreachableErrorRetry,
} from "../src/daemon/wallet/sdk-mint-fallback";

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

  test("replaces an API key from a fallback mint before provider failover on mint_unreachable", async () => {
    const removedApiKeys: string[] = [];
    const spendAttempts: string[] = [];
    const retryRequests: Array<{ baseUrl: string; mintUrl: string; token: string; mintFallbackAttempted?: boolean }> = [];
    const client = {
      mode: "apikeys",
      getBalanceManager: () => ({ topUp: async () => ({ success: true }) }),
      storageAdapter: {
        removeApiKey: (baseUrl: string) => removedApiKeys.push(baseUrl),
      },
      _spendToken: async (options: { mintUrl: string; baseUrl: string }) => {
        spendAttempts.push(options.mintUrl);
        return {
          token: `token-from-${options.mintUrl}`,
          tokenBalance: 42,
          tokenBalanceUnit: "sat",
          tokenBalanceUnknown: false,
        };
      },
      _withAuthAndTinfoilHeaders: (_headers: unknown, token: string) => ({ authorization: token }),
      _makeRequest: async (options: { baseUrl: string; mintUrl: string; token: string }) => {
        retryRequests.push(options);
        return { ok: true };
      },
      _handleErrorResponse: async () => {
        throw new Error("provider failover should not run");
      },
    };
    const walletAdapter = {
      getBalances: async () => ({ "https://mint-b.example": 100 }),
    };

    installMintUnreachableErrorRetry(
      client,
      createCocodClient(["https://mint-a.example", "https://mint-b.example"]),
      walletAdapter,
      { log: () => undefined, warn: () => undefined },
    );

    const result = await client._handleErrorResponse(
      {
        baseUrl: "https://provider.example",
        mintUrl: "https://mint-a.example",
        requiredSats: 21,
        baseHeaders: {},
        tinfoilEnabled: false,
        selectedModel: { id: "glm-5.2" },
      },
      "old-token",
      503,
      "request-id",
      undefined,
      JSON.stringify({ detail: { error: { type: "mint_unreachable" } } }),
    );

    expect(result).toMatchObject({
      ok: true,
      initialTokenBalanceInSats: 42,
      initialTokenBalanceUnknown: false,
    });
    expect(removedApiKeys).toEqual(["https://provider.example"]);
    expect(spendAttempts).toEqual(["https://mint-b.example"]);
    expect(retryRequests).toMatchObject([
      {
        baseUrl: "https://provider.example",
        mintUrl: "https://mint-b.example",
        token: "token-from-https://mint-b.example",
        mintFallbackAttempted: true,
      },
    ]);
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
