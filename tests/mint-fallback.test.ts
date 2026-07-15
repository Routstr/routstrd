import { describe, expect, test } from "bun:test";
import type { CocodClient } from "../src/daemon/wallet/cocod-client";
import {
  isMintUnreachableError,
  receiveBolt11WithMintFallback,
} from "../src/daemon/wallet/mint-fallback";
import {
  getSameMintSendAmounts,
  sendCashuFromMint,
} from "../src/daemon/wallet";

function createClient(receiveBolt11: CocodClient["receiveBolt11"]): CocodClient {
  return {
    ping: async () => true,
    getStatus: async () => "UNLOCKED",
    unlock: async () => "ok",
    getBalances: async () => ({}),
    receiveCashu: async () => "ok",
    receiveBolt11,
    sendCashu: async () => "token",
    sendBolt11: async () => "ok",
    listMints: async () => [],
    addMint: async () => "ok",
    getMintInfo: async () => ({}),
  };
}

describe("wallet token mint identity", () => {
  test("builds bounded same-mint denomination fallbacks", () => {
    expect(getSameMintSendAmounts(17, 4103)).toEqual([
      17,
      32,
      64,
      128,
      256,
      512,
      1024,
      2048,
      4096,
      4103,
    ]);
    expect(getSameMintSendAmounts(1, 1)).toEqual([2]);
  });

  test("creates at least two sats so proof fees cannot consume the whole token", async () => {
    const amounts: number[] = [];
    const client = {
      sendCashu: async (amount: number) => {
        amounts.push(amount);
        return "two-sat-token";
      },
    };

    await expect(
      sendCashuFromMint(client, "https://mint-a.example", 1, {
        maxRetries: 0,
        retryDelayMs: 0,
      }),
    ).resolves.toBe("two-sat-token");

    expect(amounts).toEqual([2]);
  });

  test("never silently creates a token from a different mint", async () => {
    const attempts: string[] = [];
    const client = {
      sendCashu: async (_amount: number, mintUrl?: string) => {
        attempts.push(mintUrl || "");
        throw new Error("Not enough proofs to send");
      },
    };

    await expect(
      sendCashuFromMint(client, "https://mint-a.example", 21, {
        maxRetries: 0,
        retryDelayMs: 0,
      }),
    ).rejects.toThrow("Not enough proofs");

    expect(attempts).toEqual(["https://mint-a.example"]);
  });

  test("retries only the same mint for temporarily reserved proofs", async () => {
    const attempts: string[] = [];
    const client = {
      sendCashu: async (_amount: number, mintUrl?: string) => {
        attempts.push(mintUrl || "");
        if (attempts.length === 1) {
          throw new Error("Proof already reserved by operation");
        }
        return "token-from-mint-a";
      },
    };

    const token = await sendCashuFromMint(
      client,
      "https://mint-a.example",
      21,
      { maxRetries: 1, retryDelayMs: 0 },
    );

    expect(token).toBe("token-from-mint-a");
    expect(attempts).toEqual([
      "https://mint-a.example",
      "https://mint-a.example",
    ]);
  });
});

describe("mint fallback", () => {
  test("detects mint_unreachable in nested error payloads", () => {
    expect(isMintUnreachableError(new Error("mint_unreachable"))).toBe(true);
    expect(
      isMintUnreachableError(
        new Error(
          "The mint that issued this Cashu token is unreachable; the token cannot be redeemed at another mint",
        ),
      ),
    ).toBe(true);
    expect(
      isMintUnreachableError(
        JSON.stringify({ detail: { error: { type: "mint_unreachable" } } }),
      ),
    ).toBe(true);
    expect(isMintUnreachableError(new Error("invoice expired"))).toBe(false);
  });

  test("tries the next configured mint only for mint_unreachable", async () => {
    const attempts: string[] = [];
    const client = createClient(async (_amount, mintUrl) => {
      attempts.push(mintUrl || "");
      if (mintUrl === "https://mint-a.example") {
        throw new Error(
          JSON.stringify({ detail: { error: { type: "mint_unreachable" } } }),
        );
      }
      return "lnbc1fallback";
    });

    const result = await receiveBolt11WithMintFallback(
      client,
      21,
      ["https://mint-a.example", "https://mint-b.example"],
      "[test]",
    );

    expect(result).toEqual({
      invoice: "lnbc1fallback",
      mintUrl: "https://mint-b.example",
    });
    expect(attempts).toEqual(["https://mint-a.example", "https://mint-b.example"]);
  });

  test("does not fallback for non-mint-unreachable errors", async () => {
    const attempts: string[] = [];
    const client = createClient(async (_amount, mintUrl) => {
      attempts.push(mintUrl || "");
      throw new Error("insufficient balance");
    });

    await expect(
      receiveBolt11WithMintFallback(
        client,
        21,
        ["https://mint-a.example", "https://mint-b.example"],
        "[test]",
      ),
    ).rejects.toThrow("insufficient balance");
    expect(attempts).toEqual(["https://mint-a.example"]);
  });
});
