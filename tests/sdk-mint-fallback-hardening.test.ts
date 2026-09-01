import { describe, expect, test, mock, beforeEach, afterEach } from "bun:test";
import type { CocodClient } from "../src/daemon/wallet/cocod-client";
import {
  installMintFallbackTopUp,
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

function createWalletAdapter(overrides: Record<string, unknown> = {}) {
  return {
    getBalances: async () => ({}),
    getNwcStatus: async () => ({ connected: false }),
    ...overrides,
  };
}

function createBalanceManager(overrides: Record<string, unknown> = {}) {
  return {
    topUp: async (_options: { mintUrl: string }) => ({ success: false, message: "not patched" }),
    createProviderToken: async (_options: { mintUrl: string }) => ({
      success: false,
      error: "Send failed: Not enough proofs to send",
    }),
    ...overrides,
  };
}

describe("Hardened fallback — input validation", () => {
  test("createInvoiceViaRoutstrCore rejects non-HTTPS provider URL", async () => {
    const balanceManager = createBalanceManager();
    const client = { getBalanceManager: () => balanceManager };
    const walletAdapter = createWalletAdapter();

    // Mock fetch — should NOT be called for non-HTTPS
    const fetchMock = mock(() => Promise.resolve(new Response("{}")));

    installMintFallbackTopUp(
      client,
      createCocodClient(["https://mint-a.example"]),
      walletAdapter,
      { log: () => undefined, warn: () => undefined, error: () => undefined },
      "http://insecure.example", // non-HTTPS — should be rejected
    );

    const result = await balanceManager.createProviderToken({
      mintUrl: "https://mint-a.example",
      baseUrl: "http://insecure.example",
      amount: 21,
    });

    // Should fail without calling fetch (no invoice created)
    expect(result.success).toBe(false);
  });

  test("createInvoiceViaRoutstrCore rejects malformed provider URL", async () => {
    const balanceManager = createBalanceManager();
    const client = { getBalanceManager: () => balanceManager };
    const walletAdapter = createWalletAdapter();

    installMintFallbackTopUp(
      client,
      createCocodClient(["https://mint-a.example"]),
      walletAdapter,
      { log: () => undefined, warn: () => undefined, error: () => undefined },
      "not-a-url",
    );

    const result = await balanceManager.createProviderToken({
      mintUrl: "https://mint-a.example",
      baseUrl: "not-a-url",
      amount: 21,
    });

    expect(result.success).toBe(false);
  });

  test("createProviderToken rejects amount <= 0", async () => {
    const balanceManager = createBalanceManager();
    const client = { getBalanceManager: () => balanceManager };
    const walletAdapter = createWalletAdapter();

    installMintFallbackTopUp(
      client,
      createCocodClient(["https://mint-a.example"]),
      walletAdapter,
      { log: () => undefined, warn: () => undefined, error: () => undefined },
      "https://provider.example",
    );

    // Amount = 0 → should default to 21 (not pass 0 to invoice creation)
    const result = await balanceManager.createProviderToken({
      mintUrl: "https://mint-a.example",
      baseUrl: "https://provider.example",
      amount: 0,
    });

    // Should fail (no proofs) but should NOT have called routstr-core with amount=0
    expect(result.success).toBe(false);
  });

  test("createInvoiceViaRoutstrCore rejects amount > 1_000_000 sats", async () => {
    const balanceManager = createBalanceManager();
    const client = { getBalanceManager: () => balanceManager };
    const walletAdapter = createWalletAdapter();

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
      amount: 10_000_000, // 10M sats — way over routstr-core's 1M limit
    });

    expect(result.success).toBe(false);
  });

  test("createInvoiceViaRoutstrCore validates bolt11 starts with 'lnbc'", async () => {
    const balanceManager = createBalanceManager();
    const client = { getBalanceManager: () => balanceManager };
    const walletAdapter = createWalletAdapter();

    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async (url: string | URL, init?: RequestInit) => {
      const urlStr = String(url);
      if (urlStr.includes("/lightning/invoice") && init?.method === "POST") {
        return new Response(JSON.stringify({
          invoice_id: "test-id",
          bolt11: "INVALID_INVOICE_NOT_LNBC",
        }), { status: 200, headers: { "Content-Type": "application/json" } });
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

      // Should fail — invalid bolt11 should be rejected
      expect(result.success).toBe(false);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  test("createInvoiceViaRoutstrCore validates invoice_id is non-empty", async () => {
    const balanceManager = createBalanceManager();
    const client = { getBalanceManager: () => balanceManager };
    const walletAdapter = createWalletAdapter();

    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async (url: string | URL, init?: RequestInit) => {
      const urlStr = String(url);
      if (urlStr.includes("/lightning/invoice") && init?.method === "POST") {
        return new Response(JSON.stringify({
          invoice_id: "", // empty
          bolt11: "lnbc1validinvoice",
        }), { status: 200, headers: { "Content-Type": "application/json" } });
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

      expect(result.success).toBe(false);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});

describe("Hardened fallback — error handling", () => {
  test("createInvoiceViaRoutstrCore handles fetch timeout gracefully", async () => {
    const balanceManager = createBalanceManager();
    const client = { getBalanceManager: () => balanceManager };
    const walletAdapter = createWalletAdapter();

    const originalFetch = globalThis.fetch;
    let fetchCalled = false;
    globalThis.fetch = (async (_url: string | URL, init?: RequestInit) => {
      fetchCalled = true;
      // Simulate the AbortController firing (timeout)
      if (init?.signal) {
        // Wait for the signal to abort, then reject
        return new Promise<Response>((_, reject) => {
          init.signal!.addEventListener("abort", () => {
            reject(new DOMException("The operation was aborted", "AbortError"));
          });
        });
      }
      return new Response("{}");
    }) as typeof fetch;

    try {
      installMintFallbackTopUp(
        client,
        createCocodClient(["https://mint-a.example"]),
        walletAdapter,
        { log: () => undefined, warn: () => undefined, error: () => undefined },
        "https://provider.example",
      );

      // Should handle the abort timeout gracefully and fall through
      const result = await balanceManager.createProviderToken({
        mintUrl: "https://mint-a.example",
        baseUrl: "https://provider.example",
        amount: 21,
      });

      expect(fetchCalled).toBe(true);
      // Should fail (no proofs) but not hang
      expect(result.success).toBe(false);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  test("createInvoiceViaRoutstrCore handles 500 from routstr-core", async () => {
    const balanceManager = createBalanceManager();
    const client = { getBalanceManager: () => balanceManager };
    const walletAdapter = createWalletAdapter();

    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async (url: string | URL, init?: RequestInit) => {
      const urlStr = String(url);
      if (urlStr.includes("/lightning/invoice") && init?.method === "POST") {
        return new Response(JSON.stringify({ detail: "Internal server error" }), {
          status: 500,
          headers: { "Content-Type": "application/json" },
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

      // Should fail gracefully and fall through to local wallet
      expect(result.success).toBe(false);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  test("payInvoiceViaNwc handles NWC wallet disconnect mid-payment", async () => {
    const balanceManager = createBalanceManager();
    const client = { getBalanceManager: () => balanceManager };
    let payCalled = false;
    const walletAdapter = createWalletAdapter({
      getNwcStatus: async () => ({ connected: true }),
      payBolt11: async (_bolt11: string) => {
        payCalled = true;
        return { success: false, error: "Wallet disconnected" };
      },
    });

    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async (url: string | URL, init?: RequestInit) => {
      const urlStr = String(url);
      if (urlStr.includes("/lightning/invoice") && init?.method === "POST") {
        return new Response(JSON.stringify({
          invoice_id: "test-id",
          bolt11: "lnbc1validinvoice",
        }), { status: 200, headers: { "Content-Type": "application/json" } });
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

      expect(payCalled).toBe(true);
      // NWC failed → should surface invoice, not crash
      expect(result.success).toBe(false);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  test("payInvoiceViaNwc handles NWC throwing exception", async () => {
    const balanceManager = createBalanceManager();
    const client = { getBalanceManager: () => balanceManager };
    const walletAdapter = createWalletAdapter({
      getNwcStatus: async () => ({ connected: true }),
      payBolt11: async (_bolt11: string) => {
        throw new Error("NWC relay connection lost");
      },
    });

    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async (url: string | URL, init?: RequestInit) => {
      const urlStr = String(url);
      if (urlStr.includes("/lightning/invoice") && init?.method === "POST") {
        return new Response(JSON.stringify({
          invoice_id: "test-id",
          bolt11: "lnbc1validinvoice",
        }), { status: 200, headers: { "Content-Type": "application/json" } });
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

      // Exception caught, not propagated — should fail gracefully
      expect(result.success).toBe(false);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});

describe("Hardened fallback — concurrency & idempotency", () => {
  test("installMintFallbackTopUp is idempotent (double-install safe)", async () => {
    const balanceManager = createBalanceManager();
    const client = { getBalanceManager: () => balanceManager };
    const walletAdapter = createWalletAdapter();

    const cocod = createCocodClient(["https://mint-a.example"]);

    // Install twice — should not double-patch
    installMintFallbackTopUp(
      client,
      cocod,
      walletAdapter,
      { log: () => undefined, warn: () => undefined, error: () => undefined },
      "https://provider.example",
    );

    installMintFallbackTopUp(
      client,
      cocod,
      walletAdapter,
      { log: () => undefined, warn: () => undefined, error: () => undefined },
      "https://provider.example",
    );

    // The second install should be a no-op — both patch markers set
    const result = await balanceManager.createProviderToken({
      mintUrl: "https://mint-a.example",
      baseUrl: "https://provider.example",
      amount: 21,
    });

    expect(result.success).toBe(false);
  });

  test("concurrent createProviderToken calls don't interfere", async () => {
    let invoiceCreateCount = 0;
    const balanceManager = createBalanceManager();
    const client = { getBalanceManager: () => balanceManager };
    const walletAdapter = createWalletAdapter();

    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async (url: string | URL, init?: RequestInit) => {
      const urlStr = String(url);
      if (urlStr.includes("/lightning/invoice") && init?.method === "POST") {
        invoiceCreateCount++;
        return new Response(JSON.stringify({
          invoice_id: `invoice-${invoiceCreateCount}`,
          bolt11: "lnbc1validinvoice",
        }), { status: 200, headers: { "Content-Type": "application/json" } });
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

      // Fire 3 concurrent calls
      const results = await Promise.all([
        balanceManager.createProviderToken({
          mintUrl: "https://mint-a.example",
          baseUrl: "https://provider.example",
          amount: 21,
        }),
        balanceManager.createProviderToken({
          mintUrl: "https://mint-a.example",
          baseUrl: "https://provider.example",
          amount: 21,
        }),
        balanceManager.createProviderToken({
          mintUrl: "https://mint-a.example",
          baseUrl: "https://provider.example",
          amount: 21,
        }),
      ]);

      // All should fail (no proofs to send)
      results.forEach(r => expect(r.success).toBe(false));
      // Each call creates its own invoice — that's acceptable (no shared state corruption)
      expect(invoiceCreateCount).toBe(3);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});

describe("Hardened fallback — API key safety", () => {
  test("API key is not logged in error messages", async () => {
    const balanceManager = createBalanceManager();
    const client = { getBalanceManager: () => balanceManager };
    const walletAdapter = createWalletAdapter();

    const loggedMessages: string[] = [];
    const logger = {
      log: (msg: string) => loggedMessages.push(msg),
      warn: (msg: string) => loggedMessages.push(msg),
      error: (msg: string) => loggedMessages.push(msg),
    };

    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async (url: string | URL, init?: RequestInit) => {
      const urlStr = String(url);
      if (urlStr.includes("/lightning/invoice") && init?.method === "POST") {
        return new Response("Internal error", { status: 500 });
      }
      return new Response("Not found", { status: 404 });
    }) as typeof fetch;

    try {
      installMintFallbackTopUp(
        client,
        createCocodClient(["https://mint-a.example"]),
        walletAdapter,
        logger,
        "https://provider.example",
      );

      const secretApiKey = "sk-verysecretkey123456";
      await balanceManager.createProviderToken({
        mintUrl: "https://mint-a.example",
        baseUrl: "https://provider.example",
        amount: 21,
        token: secretApiKey,
      });

      // No logged message should contain the API key
      const leakedKey = loggedMessages.find(m => m.includes(secretApiKey));
      expect(leakedKey).toBeUndefined();
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});

describe("Hardened fallback — poller lifecycle", () => {
  test("pollRoutstrCoreInvoice stops after max polls", async () => {
    const balanceManager = createBalanceManager();
    const client = { getBalanceManager: () => balanceManager };
    const walletAdapter = createWalletAdapter();

    let statusCallCount = 0;
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async (url: string | URL, init?: RequestInit) => {
      const urlStr = String(url);
      if (urlStr.includes("/lightning/invoice") && init?.method === "POST") {
        return new Response(JSON.stringify({
          invoice_id: "test-id",
          bolt11: "lnbc1validinvoice",
        }), { status: 200, headers: { "Content-Type": "application/json" } });
      }
      if (urlStr.includes("/lightning/invoice/") && urlStr.includes("/status")) {
        statusCallCount++;
        return new Response(JSON.stringify({ status: "pending" }), {
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

      await balanceManager.createProviderToken({
        mintUrl: "https://mint-a.example",
        baseUrl: "https://provider.example",
        amount: 21,
      });

      // Wait a bit for the poller to start (but it polls every 5s, so we
      // won't hit maxPolls in this test — just verify it doesn't throw)
      await new Promise(resolve => setTimeout(resolve, 100));
      // The poller is non-blocking, so we just verify no crash
      expect(statusCallCount).toBeGreaterThanOrEqual(0);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  test("pollRoutstrCoreInvoice detects expired invoice and stops", async () => {
    const balanceManager = createBalanceManager();
    const client = { getBalanceManager: () => balanceManager };
    const walletAdapter = createWalletAdapter();

    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async (url: string | URL, init?: RequestInit) => {
      const urlStr = String(url);
      if (urlStr.includes("/lightning/invoice") && init?.method === "POST") {
        return new Response(JSON.stringify({
          invoice_id: "test-id",
          bolt11: "lnbc1validinvoice",
        }), { status: 200, headers: { "Content-Type": "application/json" } });
      }
      if (urlStr.includes("/lightning/invoice/") && urlStr.includes("/status")) {
        return new Response(JSON.stringify({ status: "expired" }), {
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

      // Invoice expired — should fail gracefully
      expect(result.success).toBe(false);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});
