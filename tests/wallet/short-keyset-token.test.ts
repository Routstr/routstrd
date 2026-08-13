import { describe, expect, it, mock } from "bun:test";
import {
  Amount,
  getDecodedToken,
  getEncodedToken,
} from "@cashu/cashu-ts";
import {
  createWalletAdapter,
  decodeCashuTokenAmount,
} from "../../src/daemon/wallet";
import type { CocodClient } from "../../src/daemon/wallet/cocod-client";

// A full modern keyset ID with the same format as Minibits' post-migration
// active keyset. getEncodedToken stores only its first eight bytes in TokenV4.
const FULL_KEYSET_ID =
  "01fc0ec0e59cd6fa01b7a88f8cd77fce81fd1e64bca67d752e984992b7a3c3a821";
const LEGACY_KEYSET_ID = "00107937db0cc865";

function makeToken({
  amounts = [5],
  keysetId = FULL_KEYSET_ID,
  unit = "sat",
}: {
  amounts?: number[];
  keysetId?: string;
  unit?: string;
} = {}): string {
  return getEncodedToken({
    mint: "https://mint.minibits.cash/Bitcoin",
    unit,
    proofs: amounts.map((amount, index) => ({
      id: keysetId,
      amount: Amount.from(amount),
      secret: `short-keyset-regression-fixture-${index}`,
      C: `02${(index + 1).toString(16).padStart(2, "0").repeat(32)}`,
    })),
  });
}

function makeWalletClient(
  receiveCashu: CocodClient["receiveCashu"],
): CocodClient {
  // createWalletAdapter is intentionally lazy; this receive-path test only
  // needs the one capability exercised by receiveToken.
  return { receiveCashu } as CocodClient;
}

describe("short keyset TokenV4 compatibility", () => {
  it("reads amount metadata without resolving the shortened proof keyset ID", () => {
    const token = makeToken({ amounts: [1, 4] });

    // Guard the fixture itself: a full proof decode with no mint keysets must
    // exercise the same short-ID failure that triggered this regression.
    expect(() => getDecodedToken(token, [])).toThrow(/short keyset ID/i);
    expect(decodeCashuTokenAmount(token)).toEqual({
      amount: 5,
      unit: "sat",
    });
  });

  for (const tokenCase of [
    {
      name: "modern keyset with msat unit",
      input: { amounts: [500, 1000], unit: "msat" },
      expected: { amount: 1500, unit: "msat" as const },
    },
    {
      name: "legacy v0 keyset",
      input: { amounts: [2, 8], keysetId: LEGACY_KEYSET_ID },
      expected: { amount: 10, unit: "sat" as const },
    },
  ]) {
    it(`reads ${tokenCase.name} metadata`, () => {
      expect(decodeCashuTokenAmount(makeToken(tokenCase.input))).toEqual(
        tokenCase.expected,
      );
    });
  }

  it("reports success after cocod receives a short-keyset token", async () => {
    const receiveCashu = mock(async () => "Received 5");
    const walletClient = makeWalletClient(receiveCashu);
    const adapter = await createWalletAdapter({ walletClient });

    const result = await adapter.receiveToken(makeToken());

    expect(receiveCashu).toHaveBeenCalledTimes(1);
    expect(result).toEqual({
      success: true,
      amount: 5,
      unit: "sat",
      message: "Received 5",
    });
  });

  it("does not call the wallet when token metadata is invalid", async () => {
    const receiveCashu = mock(async () => "should not be called");
    const walletClient = makeWalletClient(receiveCashu);
    const adapter = await createWalletAdapter({ walletClient });

    const result = await adapter.receiveToken("cashuBnot-a-valid-token");

    expect(receiveCashu).not.toHaveBeenCalled();
    expect(result.success).toBe(false);
  });
});
