import { describe, expect, it } from "bun:test";
import {
  classifyPaidUnissued,
  classifyStuckMelt,
  doctorReportSeverity,
  mintQuoteStateToCategory,
  selectPaidUnissuedCandidates,
  selectRecentMintQuotes,
  toUnpaidQuote,
  type DoctorMeltOperation,
  type DoctorMintOperation,
  type WalletDoctorReport,
} from "./doctor";

const NOW_MS = 1_800_000_000_000;
const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;

function mintOp(
  overrides: Partial<DoctorMintOperation> = {},
): DoctorMintOperation {
  return {
    id: "op-1",
    mintUrl: "https://mint.example",
    quoteId: "quote-1",
    state: "pending",
    amount: 100,
    expiry: NOW_MS / 1000 + 600,
    createdAt: NOW_MS - 10 * 60 * 1000,
    updatedAt: NOW_MS - 5 * 60 * 1000,
    ...overrides,
  };
}

function meltOp(
  overrides: Partial<DoctorMeltOperation> = {},
): DoctorMeltOperation {
  return {
    id: "melt-1",
    mintUrl: "https://mint.example",
    quoteId: "melt-quote-1",
    state: "prepared",
    amount: 2_100,
    feeReserve: 12,
    inputProofSecrets: ["secret-a", "secret-b"],
    createdAt: NOW_MS - 3 * DAY_MS,
    updatedAt: NOW_MS - 3 * DAY_MS,
    ...overrides,
  };
}

function report(
  overrides: Partial<WalletDoctorReport> = {},
): WalletDoctorReport {
  return {
    generatedAt: NOW_MS,
    mints: [],
    unpaidQuotes: [],
    paidUnissued: [],
    stuckMelts: [],
    uncheckedQuotes: 0,
    ...overrides,
  };
}

describe("mintQuoteStateToCategory", () => {
  it("maps NUT-04 states onto coco's pending-check categories", () => {
    expect(mintQuoteStateToCategory("UNPAID")).toBe("waiting");
    expect(mintQuoteStateToCategory("PAID")).toBe("ready");
    expect(mintQuoteStateToCategory("ISSUED")).toBe("completed");
  });

  it("is case-insensitive and tolerant of whitespace", () => {
    expect(mintQuoteStateToCategory(" paid ")).toBe("ready");
  });

  it("returns null for unknown states", () => {
    expect(mintQuoteStateToCategory("EXPIRED")).toBeNull();
    expect(mintQuoteStateToCategory("")).toBeNull();
  });
});

describe("selectRecentMintQuotes", () => {
  it("selects pending quotes created inside the window", () => {
    const recent = mintOp();
    const old = mintOp({ id: "op-2", createdAt: NOW_MS - 2 * HOUR_MS });
    expect(selectRecentMintQuotes([recent, old], NOW_MS)).toEqual([recent]);
  });

  it("includes executing operations (crash mid-mint)", () => {
    const executing = mintOp({ state: "executing" });
    expect(selectRecentMintQuotes([executing], NOW_MS)).toEqual([executing]);
  });

  it("ignores finalized/failed operations and quotes without a quote id", () => {
    const finalized = mintOp({ id: "op-2", state: "finalized" });
    const failed = mintOp({ id: "op-3", state: "failed" });
    const noQuote = mintOp({ id: "op-4", quoteId: undefined });
    expect(
      selectRecentMintQuotes([finalized, failed, noQuote], NOW_MS),
    ).toEqual([]);
  });

  it("keeps a quote created exactly at the window edge out", () => {
    const edge = mintOp({ createdAt: NOW_MS - HOUR_MS });
    expect(selectRecentMintQuotes([edge], NOW_MS)).toEqual([]);
  });
});

describe("selectPaidUnissuedCandidates", () => {
  it("selects every pending/executing operation with a quote id", () => {
    const pending = mintOp();
    const executing = mintOp({ id: "op-2", state: "executing" });
    expect(selectPaidUnissuedCandidates([pending, executing])).toEqual([
      pending,
      executing,
    ]);
  });

  it("selects failed operations last seen PAID or ISSUED", () => {
    const paid = mintOp({ state: "failed", lastObservedRemoteState: "PAID" });
    const issued = mintOp({
      id: "op-2",
      state: "failed",
      lastObservedRemoteState: "ISSUED",
    });
    expect(selectPaidUnissuedCandidates([paid, issued])).toEqual([
      paid,
      issued,
    ]);
  });

  it("selects failed operations that errored before any remote observation", () => {
    const unobserved = mintOp({ state: "failed", error: "mint unreachable" });
    expect(selectPaidUnissuedCandidates([unobserved])).toEqual([unobserved]);
  });

  it("ignores failed quotes last seen UNPAID - they outnumber recoverable ones", () => {
    const unpaid = mintOp({
      state: "failed",
      lastObservedRemoteState: "UNPAID",
    });
    expect(selectPaidUnissuedCandidates([unpaid])).toEqual([]);
  });

  it("ignores finalized operations and operations without a quote id", () => {
    const finalized = mintOp({ state: "finalized" });
    const noQuote = mintOp({ id: "op-2", quoteId: undefined });
    expect(selectPaidUnissuedCandidates([finalized, noQuote])).toEqual([]);
  });
});

describe("classifyPaidUnissued", () => {
  it("flags a pending quote the mint reports PAID", () => {
    const finding = classifyPaidUnissued(mintOp(), "PAID");
    expect(finding).toMatchObject({
      operationId: "op-1",
      remoteState: "PAID",
      localState: "pending",
      remediation: "routstrd wallet recover --op op-1",
    });
  });

  it("flags an issued-but-unfinalized quote", () => {
    const finding = classifyPaidUnissued(mintOp(), "ISSUED");
    expect(finding?.remoteState).toBe("ISSUED");
  });

  it("adds --include-failed for failed operations so recovery re-opens them", () => {
    const finding = classifyPaidUnissued(
      mintOp({ state: "failed", lastObservedRemoteState: "PAID" }),
      "PAID",
    );
    expect(finding?.remediation).toBe(
      "routstrd wallet recover --op op-1 --include-failed",
    );
  });

  it("surfaces coco's persisted mint rejection when present", () => {
    const finding = classifyPaidUnissued(
      mintOp({ error: "keyset id inactive." }),
      "PAID",
    );
    expect(finding?.error).toBe("keyset id inactive.");
  });

  it("returns null for UNPAID and unknown remote states", () => {
    expect(classifyPaidUnissued(mintOp(), "UNPAID")).toBeNull();
    expect(classifyPaidUnissued(mintOp(), "GARBAGE")).toBeNull();
  });
});

describe("toUnpaidQuote", () => {
  it("reports age and time-to-expiry", () => {
    const entry = toUnpaidQuote(mintOp(), NOW_MS);
    expect(entry).toEqual({
      operationId: "op-1",
      quoteId: "quote-1",
      mintUrl: "https://mint.example",
      amount: 100,
      ageMs: 10 * 60 * 1000,
      expiresInMs: 600_000,
    });
  });

  it("omits expiry when unknown and reports a negative drift when expired", () => {
    expect(toUnpaidQuote(mintOp({ expiry: 0 }), NOW_MS).expiresInMs).toBeUndefined();
    const expired = toUnpaidQuote(
      mintOp({ expiry: NOW_MS / 1000 - 60 }),
      NOW_MS,
    );
    expect(expired.expiresInMs).toBe(-60_000);
  });
});

describe("classifyStuckMelt", () => {
  const ctx = { nowMs: NOW_MS };

  it("flags old prepared melts with locked input proofs", () => {
    const finding = classifyStuckMelt(meltOp(), ctx);
    expect(finding).toMatchObject({
      kind: "prepared",
      lockedSecrets: 2,
      remediation: "routstrd wallet cleanup",
    });
  });

  it("ignores freshly prepared melts", () => {
    const fresh = meltOp({ createdAt: NOW_MS - 1000, updatedAt: NOW_MS - 1000 });
    expect(classifyStuckMelt(fresh, ctx)).toBeNull();
  });

  it("flags in-flight melts at any age", () => {
    const pending = meltOp({ state: "pending", updatedAt: NOW_MS - 1000 });
    const finding = classifyStuckMelt(pending, ctx);
    expect(finding?.kind).toBe("in-flight");
    const executing = meltOp({ state: "executing" });
    expect(classifyStuckMelt(executing, ctx)?.kind).toBe("in-flight");
  });

  it("flags failed melts whose proofs are still locked", () => {
    const failed = meltOp({ state: "failed" });
    const inflight = new Set(["secret-a", "unrelated"]);
    const finding = classifyStuckMelt(failed, { ...ctx, inflightSecrets: inflight });
    expect(finding).toMatchObject({ kind: "failed-locked", lockedSecrets: 1 });
  });

  it("ignores failed melts whose proofs were released", () => {
    const failed = meltOp({ state: "failed" });
    expect(
      classifyStuckMelt(failed, { ...ctx, inflightSecrets: new Set(["other"]) }),
    ).toBeNull();
    expect(classifyStuckMelt(failed, ctx)).toBeNull();
  });

  it("ignores finalized, rolled-back and init melts", () => {
    for (const state of ["finalized", "rolled_back", "init"] as const) {
      expect(classifyStuckMelt(meltOp({ state }), ctx)).toBeNull();
    }
  });
});

describe("doctorReportSeverity", () => {
  it("is ok for an empty healthy report", () => {
    expect(doctorReportSeverity(report())).toBe("ok");
  });

  it("is critical when a mint is unreachable", () => {
    expect(
      doctorReportSeverity(
        report({
          mints: [{ mintUrl: "https://mint.example", reachable: false }],
        }),
      ),
    ).toBe("critical");
  });

  it("is critical when paid sats were never issued", () => {
    const finding = classifyPaidUnissued(mintOp(), "PAID")!;
    expect(
      doctorReportSeverity(report({ paidUnissued: [finding] })),
    ).toBe("critical");
  });

  it("is critical when a failed melt still locks proofs", () => {
    const stuck = classifyStuckMelt(meltOp({ state: "failed" }), {
      nowMs: NOW_MS,
      inflightSecrets: new Set(["secret-a"]),
    })!;
    expect(doctorReportSeverity(report({ stuckMelts: [stuck] }))).toBe(
      "critical",
    );
  });

  it("is warning for unpaid quotes, non-critical melts or unchecked quotes", () => {
    expect(
      doctorReportSeverity(
        report({ unpaidQuotes: [toUnpaidQuote(mintOp(), NOW_MS)] }),
      ),
    ).toBe("warning");
    const prepared = classifyStuckMelt(meltOp(), { nowMs: NOW_MS })!;
    expect(
      doctorReportSeverity(report({ stuckMelts: [prepared] })),
    ).toBe("warning");
    expect(doctorReportSeverity(report({ uncheckedQuotes: 2 }))).toBe(
      "warning",
    );
  });
});
