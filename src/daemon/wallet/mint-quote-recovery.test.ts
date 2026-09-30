import { describe, expect, it } from "bun:test";
import {
  classifyMintQuoteObservation,
  selectMintQuotesForRecovery,
  type MintQuoteRecoveryCandidate,
} from "./mint-quote-recovery";

function mint(
  overrides: Partial<MintQuoteRecoveryCandidate> = {},
): MintQuoteRecoveryCandidate {
  return {
    id: "mint-1",
    mintUrl: "https://mint.example",
    quoteId: "quote-1",
    state: "pending",
    amount: 1000,
    expiry: 0,
    ...overrides,
  };
}

describe("classifyMintQuoteObservation", () => {
  it("finalizes a paid-but-unissued quote by minting its stored outputs", () => {
    expect(classifyMintQuoteObservation("ready")).toEqual({
      action: "finalize",
      observedRemoteState: "PAID",
    });
  });

  it("finalizes an already-issued quote by restoring its proofs", () => {
    expect(classifyMintQuoteObservation("completed")).toEqual({
      action: "finalize",
      observedRemoteState: "ISSUED",
    });
  });

  it("leaves an unpaid quote alone", () => {
    expect(classifyMintQuoteObservation("waiting")).toEqual({
      action: "waiting",
    });
  });

  it("reports a quote the mint can no longer issue", () => {
    expect(classifyMintQuoteObservation("terminal")).toEqual({
      action: "terminal",
    });
  });
});

describe("selectMintQuotesForRecovery", () => {
  it("selects every pending quote because only the mint knows if it was paid", () => {
    const result = selectMintQuotesForRecovery({
      mints: [
        mint({ id: "expired", expiry: 1 }),
        mint({ id: "fresh" }),
        mint({ id: "observed-unpaid", lastObservedRemoteState: "UNPAID" }),
        mint({ id: "observed-paid", lastObservedRemoteState: "PAID" }),
      ],
    });
    expect(result.pending.map((op) => op.id)).toEqual([
      "expired",
      "fresh",
      "observed-unpaid",
      "observed-paid",
    ]);
  });

  it("recovers executing operations left behind by a crash mid-mint", () => {
    const result = selectMintQuotesForRecovery({
      mints: [mint({ id: "executing", state: "executing" })],
    });
    expect(result.pending.map((op) => op.id)).toEqual(["executing"]);
  });

  it("ignores finalized operations", () => {
    const result = selectMintQuotesForRecovery({
      mints: [mint({ id: "done", state: "finalized" })],
    });
    expect(result.pending).toEqual([]);
    expect(result.failed).toEqual([]);
  });

  it("does not re-open failed operations by default", () => {
    const result = selectMintQuotesForRecovery({
      mints: [mint({ id: "given-up", state: "failed" })],
    });
    expect(result.failed).toEqual([]);
  });

  it("returns failed operations when the caller opts in", () => {
    const result = selectMintQuotesForRecovery({
      mints: [mint({ id: "given-up", state: "failed" })],
      includeFailed: true,
    });
    expect(result.failed.map((op) => op.id)).toEqual(["given-up"]);
  });
});
