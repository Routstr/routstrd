import { describe, expect, it } from "bun:test";
import { HISTORY_ENTRY_TYPES, historyStatus, isHistoryEntryType } from "./history";

describe("history entry types", () => {
  it("lists the four supported transaction types", () => {
    expect([...HISTORY_ENTRY_TYPES]).toEqual([
      "mint",
      "melt",
      "send",
      "receive",
    ]);
  });

  it("recognizes known types and rejects unknown ones", () => {
    expect(isHistoryEntryType("send")).toBe(true);
    expect(isHistoryEntryType("melt")).toBe(true);
    expect(isHistoryEntryType("SEND")).toBe(false);
    expect(isHistoryEntryType("refund")).toBe(false);
  });
});

describe("history status", () => {
  it("tells a stuck mint apart from a finished melt", () => {
    expect(historyStatus("mint", "PAID")).toBe("paid, not minted");
    expect(historyStatus("melt", "PAID")).toBe("");
  });
});

describe("history status with operation state", () => {
  it("shows a rolled-back melt as cancelled, not waiting", () => {
    expect(historyStatus("melt", "UNPAID", "rolled_back")).toBe("cancelled");
    expect(historyStatus("melt", "UNPAID", "rolling_back")).toBe("cancelled");
  });

  it("keeps a melt that is genuinely in flight as waiting", () => {
    expect(historyStatus("melt", "UNPAID", "prepared")).toBe("waiting");
    expect(historyStatus("melt", "PENDING", "pending")).toBe("waiting");
    expect(historyStatus("melt", "UNPAID", "executing")).toBe("waiting");
  });

  it("treats a finalized melt as finished regardless of the quote label", () => {
    expect(historyStatus("melt", "UNPAID", "finalized")).toBe("");
    expect(historyStatus("melt", "PAID", "finalized")).toBe("");
  });

  it("falls back to the stored state when no operation state is available", () => {
    expect(historyStatus("melt", "UNPAID")).toBe("waiting");
    expect(historyStatus("melt", "PAID")).toBe("");
  });
});
