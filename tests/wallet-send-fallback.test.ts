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

/**
 * Mirror of the SDK's internal `isNetworkErrorMessage`, which is not exported.
 * Source: node_modules/@routstr/sdk/dist/client/index.js — the predicate that
 * decides whether BalanceManager.createProviderToken() continues to its next
 * candidate mint or aborts the rotation.
 */
function isSdkNetworkErrorMessage(message: string): boolean {
  return (
    message.includes("NetworkError when attempting to fetch resource") ||
    message.includes("Failed to fetch") ||
    message.includes("Load failed") ||
    message.includes("ERR_TLS_CERT_ALTNAME_INVALID") ||
    message.includes("ERR_TLS_CERT_NOT_YET_VALID") ||
    message.includes("ERR_TLS_CERT_EXPIRED") ||
    message.includes("UNABLE_TO_VERIFY_LEAF_SIGNATURE") ||
    message.includes("SELF_SIGNED_CERT_IN_CHAIN") ||
    message.includes("Unable to connect") ||
    message.includes("ECONNREFUSED") ||
    message.includes("Connection refused")
  );
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

  test("never substitutes another mint for one in the health cooldown", async () => {
    const attempts: string[] = [];
    const client = createClient({
      getBalances: async () => ({
        "https://mint.minibits.cash/Bitcoin": 46981,
        "https://mint.cubabitcoin.org": 4929,
      }),
      listMints: async () => [
        "https://mint.minibits.cash/Bitcoin",
        "https://mint.cubabitcoin.org",
      ],
      sendCashu: async (_amount, mintUrl) => {
        attempts.push(mintUrl || "");
        if (mintUrl === "https://mint.minibits.cash/Bitcoin") {
          throw new Error(
            "Send failed: Failed to fetch mint https://mint.minibits.cash/Bitcoin",
          );
        }
        return "cashu-token-from-cuba";
      },
    });

    const walletAdapter = await createWalletAdapter({ walletClient: client });

    // First call fails at the network level and puts minibits in cooldown.
    await expect(
      walletAdapter.sendToken("https://mint.minibits.cash/Bitcoin", 18),
    ).rejects.toThrow("Failed to fetch mint");

    // The second call must NOT come back with a Cuba token labelled as minibits.
    // It reports the mint as unreachable so the SDK layer above can rotate.
    const cooldownError = await walletAdapter
      .sendToken("https://mint.minibits.cash/Bitcoin", 18)
      .then(() => null, (error: Error) => error);

    expect(cooldownError).toBeInstanceOf(Error);
    // The SDK's rotation loop only advances to its next candidate mint when the
    // error matches isNetworkErrorMessage(). If this stops holding, rotation
    // silently aborts after the first candidate — which is the exact bug this
    // covers — so assert against the SDK's real predicate rather than our text.
    expect(isSdkNetworkErrorMessage(cooldownError!.message)).toBe(true);

    // Cuba is only ever touched when it is the mint that was actually asked for.
    expect(attempts).toEqual(["https://mint.minibits.cash/Bitcoin"]);

    await expect(
      walletAdapter.sendToken("https://mint.cubabitcoin.org", 18),
    ).resolves.toBe("cashu-token-from-cuba");
    expect(attempts).toEqual([
      "https://mint.minibits.cash/Bitcoin",
      "https://mint.cubabitcoin.org",
    ]);
  });

  test("a cooldown skip does not extend the cooldown it is skipping for", async () => {
    const attempts: string[] = [];
    let minibitsReachable = false;
    const client = createClient({
      getBalances: async () => ({
        "https://mint.minibits.cash/Bitcoin": 46981,
        "https://mint.cubabitcoin.org": 4929,
      }),
      listMints: async () => [
        "https://mint.minibits.cash/Bitcoin",
        "https://mint.cubabitcoin.org",
      ],
      sendCashu: async (_amount, mintUrl) => {
        attempts.push(mintUrl || "");
        if (mintUrl === "https://mint.minibits.cash/Bitcoin" && !minibitsReachable) {
          throw new Error(
            "Send failed: Failed to fetch mint https://mint.minibits.cash/Bitcoin",
          );
        }
        return "cashu-token";
      },
    });

    const walletAdapter = await createWalletAdapter({ walletClient: client });
    const realNow = Date.now;
    let clock = realNow();
    Date.now = () => clock;

    try {
      // Put minibits into the 60s cooldown.
      await expect(
        walletAdapter.sendToken("https://mint.minibits.cash/Bitcoin", 18),
      ).rejects.toThrow("Failed to fetch mint");

      // Hammer it with skipped requests throughout the cooldown window. If a
      // skip re-marked the mint, each one would push the expiry 60s further out.
      for (let elapsed = 0; elapsed < 55_000; elapsed += 5_000) {
        clock += 5_000;
        await expect(
          walletAdapter.sendToken("https://mint.minibits.cash/Bitcoin", 18),
        ).rejects.toThrow("health cooldown");
      }

      // Past the original 60s mark the mint must be retried, not stranded.
      clock += 10_000;
      minibitsReachable = true;
      attempts.length = 0;
      await expect(
        walletAdapter.sendToken("https://mint.minibits.cash/Bitcoin", 18),
      ).resolves.toBe("cashu-token");
      expect(attempts).toEqual(["https://mint.minibits.cash/Bitcoin"]);
    } finally {
      Date.now = realNow;
    }
  });
});

describe("wallet receiveToken dead-token cache", () => {
  const SPENT_TOKEN = "cashuBspent-token-abc";
  const LIVE_TOKEN = "cashuBlive-token-xyz";

  test("stops retrying a token the mint has confirmed spent", async () => {
    let receiveCalls = 0;
    const client = createClient({
      receiveCashu: async () => {
        receiveCalls++;
        throw new Error("proofs already spent");
      },
    });
    const walletAdapter = await createWalletAdapter({ walletClient: client });

    const first = await walletAdapter.receiveToken(SPENT_TOKEN);
    expect(first.success).toBe(false);
    expect(receiveCalls).toBe(1);

    // The SDK re-attempts the stored token on every 402. Further attempts must
    // not reach the mint at all.
    for (let i = 0; i < 5; i++) {
      const repeat = await walletAdapter.receiveToken(SPENT_TOKEN);
      expect(repeat.success).toBe(false);
      expect(repeat.message).toContain("already spent");
    }
    expect(receiveCalls).toBe(1);
  });

  test("keeps retrying transient failures", async () => {
    let receiveCalls = 0;
    const client = createClient({
      receiveCashu: async () => {
        receiveCalls++;
        // A mint that is merely unreachable may accept the same token later,
        // so this must never be cached as dead.
        throw new Error("Failed to fetch mint https://mint-a.example");
      },
    });
    const walletAdapter = await createWalletAdapter({ walletClient: client });

    await walletAdapter.receiveToken(LIVE_TOKEN);
    await walletAdapter.receiveToken(LIVE_TOKEN);
    await walletAdapter.receiveToken(LIVE_TOKEN);
    expect(receiveCalls).toBe(3);
  });

  test("a dead token does not poison a different token", async () => {
    const seen: string[] = [];
    const client = createClient({
      receiveCashu: async (token: string) => {
        seen.push(token);
        if (token === SPENT_TOKEN) throw new Error("proofs already spent");
        return "ok";
      },
    });
    const walletAdapter = await createWalletAdapter({ walletClient: client });

    await walletAdapter.receiveToken(SPENT_TOKEN);
    await walletAdapter.receiveToken(SPENT_TOKEN);
    await walletAdapter.receiveToken(LIVE_TOKEN);

    // The spent token reached the mint once and was cached thereafter; the live
    // token was never short-circuited. (Both return success:false here only
    // because these fixtures are not decodable Cashu tokens — the mint-level
    // call pattern is what this test is about.)
    expect(seen).toEqual([SPENT_TOKEN, LIVE_TOKEN]);
  });
});
