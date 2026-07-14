import { describe, expect, test } from "bun:test";
import type { CocodClient } from "../src/daemon/wallet/cocod-client";
import {
  isMintUnreachableError,
  receiveBolt11WithMintFallback,
} from "../src/daemon/wallet/mint-fallback";

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
