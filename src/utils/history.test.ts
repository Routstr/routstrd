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
