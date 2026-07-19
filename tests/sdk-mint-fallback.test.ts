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
      { log: () => undefined, warn: () => undefined, error: () => undefined },
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
      { log: () => undefined, warn: () => undefined, error: () => undefined },
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
      { log: () => undefined, warn: () => undefined, error: () => undefined },
    );

    const result = await balanceManager.topUp({
      mintUrl: "https://mint-a.example",
      baseUrl: "https://provider.example",
      amount: 21,
    });

    expect(result).toEqual({ success: false, message: "insufficient balance" });
    expect(attempts).toEqual(["https://mint-a.example"]);
  });

  test("retries on 'Not enough proofs' as wallet-empty fallback", async () => {
    const attempts: string[] = [];
    const balanceManager = {
      topUp: async (options: { mintUrl: string }) => {
        attempts.push(options.mintUrl);
        if (options.mintUrl === "https://mint-a.example") {
          return {
            success: false,
            message: "Send failed: Not enough proofs to send",
          };
        }
        return { success: true, toppedUpAmount: 21 };
      },
    };
    const client = { getBalanceManager: () => balanceManager };
    const walletAdapter = {
      getBalances: async () => ({ "https://mint-b.example": 100 }),
    };

    installMintFallbackTopUp(
      client,
      createCocodClient(["https://mint-a.example", "https://mint-b.example"]),
      walletAdapter,
      { log: () => undefined, warn: () => undefined, error: () => undefined },
    );

    const result = await balanceManager.topUp({
      mintUrl: "https://mint-a.example",
      baseUrl: "https://provider.example",
      amount: 21,
    });

    expect(result.success).toBe(true);
    expect(attempts).toEqual(["https://mint-a.example", "https://mint-b.example"]);
  });

  test("falls back to lightning invoice when all mints are empty", async () => {
    const attempts: string[] = [];
    const balanceManager = {
      topUp: async (options: { mintUrl: string }) => {
        attempts.push(options.mintUrl);
        return {
          success: false,
          message: "Send failed: Not enough proofs to send",
        };
      },
    };
    const client = { getBalanceManager: () => balanceManager };
    const walletAdapter = {
      getBalances: async () => ({}),
      getNwcStatus: async () => ({ connected: false }),
    };
    const cocodClient = createCocodClient([
      "https://mint-a.example",
      "https://mint-b.example",
    ]);

    installMintFallbackTopUp(
      client,
      cocodClient,
      walletAdapter,
      { log: () => undefined, warn: () => undefined, error: () => undefined },
    );

    const result = await balanceManager.topUp({
      mintUrl: "https://mint-a.example",
      baseUrl: "https://provider.example",
      amount: 21,
    });

    // Should have tried both mints, then attempted lightning invoice fallback
    expect(attempts).toEqual(["https://mint-a.example", "https://mint-b.example"]);
    // Final result is still the last failure (invoice was created but not paid)
    expect(result.success).toBe(false);
  });

  test("createProviderToken retries on 'Not enough proofs' across mints", async () => {
    const attempts: string[] = [];
    const balanceManager = {
      topUp: async (_options: { mintUrl: string }) => ({ success: false, message: "not patched" }),
      createProviderToken: async (options: { mintUrl: string }) => {
        attempts.push(options.mintUrl);
        if (options.mintUrl === "https://mint-a.example") {
          return { success: false, error: "Send failed: Not enough proofs to send" };
        }
        return { success: true, token: "cashu-token", selectedMintUrl: options.mintUrl, amountSpent: 21 };
      },
    };
    const client = { getBalanceManager: () => balanceManager };
    const walletAdapter = {
      getBalances: async () => ({ "https://mint-b.example": 100 }),
    };

    installMintFallbackTopUp(
      client,
      createCocodClient(["https://mint-a.example", "https://mint-b.example"]),
      walletAdapter,
      { log: () => undefined, warn: () => undefined, error: () => undefined },
    );

    const result = await balanceManager.createProviderToken({
      mintUrl: "https://mint-a.example",
      baseUrl: "https://provider.example",
      amount: 21,
    });

    expect(result.success).toBe(true);
    expect(attempts).toEqual(["https://mint-a.example", "https://mint-b.example"]);
  });

  test("createProviderToken falls back to routstr-core invoice + NWC payment", async () => {
    const createAttempts: string[] = [];
    const balanceManager = {
      topUp: async (_options: { mintUrl: string }) => ({ success: false, message: "not patched" }),
      createProviderToken: async (options: { mintUrl: string }) => {
        createAttempts.push(options.mintUrl);
        return { success: false, error: "Send failed: Not enough proofs to send" };
      },
    };
    const client = { getBalanceManager: () => balanceManager };
    let nwcPaid = false;
    const walletAdapter = {
      getBalances: async () => ({}),
      getNwcStatus: async () => ({ connected: true }),
      payBolt11: async (_bolt11: string) => {
        nwcPaid = true;
        return { success: true, preimage: "abc123" };
      },
    };

    // Mock fetch for routstr-core invoice creation
    const originalFetch = globalThis.fetch;
    let invoiceCreated = false;
    globalThis.fetch = (async (url: string | URL, init?: RequestInit) => {
      const urlStr = String(url);
      if (urlStr.includes("/lightning/invoice") && init?.method === "POST") {
        invoiceCreated = true;
        return new Response(JSON.stringify({
          invoice_id: "test-invoice-id",
          bolt11: "lnbc1testinvoice",
        }), { status: 200, headers: { "Content-Type": "application/json" } });
      }
      if (urlStr.includes("/lightning/invoice/") && urlStr.includes("/status")) {
        return new Response(JSON.stringify({ status: "paid" }), {
          status: 200, headers: { "Content-Type": "application/json" },
        });
      }
      return new Response("Not found", { status: 404 });
    }) as typeof fetch;

    try {
      installMintFallbackTopUp(
        client,
        createCocodClient(["https://mint-a.example"]),
        walletAdapter,
        { log: () => undefined, warn: () => undefined, error: () => undefined },
        "https://provider.example",
      );

      const result = await balanceManager.createProviderToken({
        mintUrl: "https://mint-a.example",
        baseUrl: "https://provider.example",
        amount: 21,
      });

      // Should have tried mint-a, then created a routstr-core invoice
      // After NWC payment, it retries createProviderToken (mint-a again)
      expect(createAttempts).toEqual(["https://mint-a.example", "https://mint-a.example"]);
      expect(invoiceCreated).toBe(true);
      // NWC should have been used to pay the routstr-core invoice
      expect(nwcPaid).toBe(true);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  test("falls back to local NWC invoice when routstr-core returns HTTP error", async () => {
    const createAttempts: string[] = [];
    const balanceManager = {
      topUp: async (_o: { mintUrl: string }) => ({ success: false, message: "not patched" }),
      createProviderToken: async (options: { mintUrl: string }) => {
        createAttempts.push(options.mintUrl);
        return { success: false, error: "Send failed: Not enough proofs to send" };
      },
    };
    const client = { getBalanceManager: () => balanceManager };
    let nwcPaidBolt11: string | null = null;
    const walletAdapter = {
      getBalances: async () => ({}),
      getNwcStatus: async () => ({ connected: true }),
      payBolt11: async (bolt11: string) => {
        nwcPaidBolt11 = bolt11;
        return { success: true, preimage: "def456" };
      },
    };

    // Mock fetch: routstr-core returns 500
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async (url: string | URL, init?: RequestInit) => {
      const urlStr = String(url);
      if (urlStr.includes("/lightning/invoice") && init?.method === "POST") {
        return new Response("Internal server error", { status: 500 });
      }
      return new Response("Not found", { status: 404 });
    }) as typeof fetch;

    try {
      installMintFallbackTopUp(
        client,
        createCocodClient(["https://mint-a.example"]),
        walletAdapter,
        { log: () => undefined, warn: () => undefined, error: () => undefined },
        "https://provider.example",
      );

      const result = await balanceManager.createProviderToken({
        mintUrl: "https://mint-a.example",
        baseUrl: "https://provider.example",
        amount: 21,
      });

      // routstr-core failed → fell back to local NWC invoice
      expect(nwcPaidBolt11).not.toBeNull();
      // local wallet invoice is a static test string from createCocodClient
      expect(nwcPaidBolt11).toBe("invoice");
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  test("shows manual top-up when both routstr-core and NWC are unavailable", async () => {
    const logs: string[] = [];
    const logger = {
      log: (...args: unknown[]) => logs.push(args.join(" ")),
      warn: () => {},
      error: () => {},
    };
    const balanceManager = {
      topUp: async (_o: { mintUrl: string }) => ({ success: false, message: "not patched" }),
      createProviderToken: async (_options: { mintUrl: string }) => ({
        success: false, error: "Send failed: Not enough proofs to send",
      }),
    };
    const client = { getBalanceManager: () => balanceManager };
    const walletAdapter = {
      getBalances: async () => ({}),
      getNwcStatus: async () => ({ connected: false, error: "not configured" }),
    };

    // Mock fetch: routstr-core unreachable (network error)
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async () => {
      throw new Error("Network error: connection refused");
    }) as typeof fetch;

    try {
      installMintFallbackTopUp(
        client,
        createCocodClient(["https://mint-a.example"]),
        walletAdapter,
        logger,
        "https://provider.example",
      );

      await balanceManager.createProviderToken({
        mintUrl: "https://mint-a.example",
        amount: 21,
      });

      // Should have logged the manual top-up message
      const manualLog = logs.find((l) => l.includes("Manual top-up"));
      expect(manualLog).toBeDefined();
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  test("skips routstr-core when upstreamProviderUrl is undefined, uses NWC only", async () => {
    const createAttempts: string[] = [];
    const balanceManager = {
      topUp: async (_o: { mintUrl: string }) => ({ success: false, message: "not patched" }),
      createProviderToken: async (options: { mintUrl: string }) => {
        createAttempts.push(options.mintUrl);
        return { success: false, error: "Send failed: Not enough proofs to send" };
      },
    };
    const client = { getBalanceManager: () => balanceManager };
    let nwcCalled = false;
    const walletAdapter = {
      getBalances: async () => ({}),
      getNwcStatus: async () => ({ connected: true }),
      payBolt11: async (_bolt11: string) => {
        nwcCalled = true;
        return { success: true, preimage: "ghi789" };
      },
    };

    // No upstreamProviderUrl passed → should not call fetch at all
    installMintFallbackTopUp(
      client,
      createCocodClient(["https://mint-a.example"]),
      walletAdapter,
      { log: () => undefined, warn: () => undefined, error: () => undefined },
    );

    await balanceManager.createProviderToken({
      mintUrl: "https://mint-a.example",
      amount: 21,
    });

    // NWC should have been used (routstr-core was skipped)
    expect(nwcCalled).toBe(true);
  });
});
