import { describe, expect, it } from "bun:test";
import type { HistoryEntry } from "@cashu/coco-core";
import { attachMeltOperationStates } from "./history-state";

function meltEntry(
  id: string,
  operationId: string | undefined,
  state: "UNPAID" | "PENDING" | "PAID" = "UNPAID",
): HistoryEntry {
  return {
    id,
    type: "melt",
    createdAt: 0,
    mintUrl: "https://mint.example/",
    unit: "sat",
    amount: 1_000,
    quoteId: `quote-${id}`,
    operationId,
    state,
  } as HistoryEntry;
}

function sendEntry(id: string): HistoryEntry {
  return {
    id,
    type: "send",
    createdAt: 0,
    mintUrl: "https://mint.example/",
    unit: "sat",
    amount: 5,
    operationId: "send-op",
    state: "finalized",
  } as HistoryEntry;
}

describe("attachMeltOperationStates", () => {
  it("leaves non-melt entries untouched and never asks for an operation", async () => {
    let calls = 0;
    const entries = [sendEntry("s1"), sendEntry("s2")];
    const result = await attachMeltOperationStates(
      { ops: { melt: { get: async () => { calls++; return null; } } } },
      entries,
    );
    expect(calls).toBe(0);
    expect(result).toEqual(entries);
  });

  it("exposes the operation state so a rolled-back melt can be told apart", async () => {
    const entries = [meltEntry("1", "op-rolled", "UNPAID"), meltEntry("2", "op-live", "UNPAID")];
    const result = await attachMeltOperationStates(
      {
        ops: {
          melt: {
            get: async (id) =>
              id === "op-rolled" ? { state: "rolled_back" } : { state: "executing" },
          },
        },
      },
      entries,
    );
    expect((result[0] as { operationState?: string }).operationState).toBe("rolled_back");
    expect((result[1] as { operationState?: string }).operationState).toBe("executing");
    // The stored quote state is not rewritten; the CLI decides how to render it.
    expect(result[0]?.state).toBe("UNPAID");
  });

  it("looks up each operation at most once", async () => {
    const seen: string[] = [];
    const entries = [meltEntry("1", "same-op"), meltEntry("2", "same-op")];
    await attachMeltOperationStates(
      {
        ops: {
          melt: {
            get: async (id) => {
              seen.push(id);
              return { state: "rolled_back" };
            },
          },
        },
      },
      entries,
    );
    expect(seen).toEqual(["same-op"]);
  });

  it("keeps the stored state when the operation is gone or the read fails", async () => {
    const entries = [meltEntry("1", "missing"), meltEntry("2", "broken")];
    const result = await attachMeltOperationStates(
      {
        ops: {
          melt: {
            get: async (id) => {
              if (id === "broken") throw new Error("closed database");
              return null;
            },
          },
        },
      },
      entries,
    );
    expect(result).toEqual(entries);
  });

  it("skips melt entries without an operation id", async () => {
    const entries = [meltEntry("1", undefined)];
    const result = await attachMeltOperationStates(
      { ops: { melt: { get: async () => ({ state: "rolled_back" }) } } },
      entries,
    );
    expect(result).toEqual(entries);
  });
});
