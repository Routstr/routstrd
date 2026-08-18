import { describe, expect, it } from "bun:test";
import type { ReceiveOperation } from "@cashu/coco-core";
import { Database } from "bun:sqlite";
import {
  clearInterruptedReceiveReservations,
  deleteReceiveTokenReservation,
  groupExecutingReceives,
  hashReceiveToken,
  initReceiveDedupSchema,
  listProcessingReceiveTokens,
  reconcileExecutingReceives,
  reserveReceiveToken,
  updateReceiveToken,
  type ReceiveReconcileSource,
} from "./receive-dedup";

function operation(
  id: string,
  secret: string,
  outputB: string,
  createdAt = 1,
): Extract<ReceiveOperation, { state: "executing" }> {
  return {
    id,
    mintUrl: "https://mint.example",
    unit: "sat",
    amount: 1,
    state: "executing",
    createdAt,
    updatedAt: createdAt,
    fee: 0,
    inputProofs: [{ amount: 1, id: "keyset", secret, C: "02" }],
    outputData: {
      keep: [
        {
          blindedMessage: { amount: 1, id: "keyset", B_: outputB },
          blindingFactor: "1",
          secret: "00",
        },
      ],
      send: [],
    },
  };
}

function source(options: {
  operations: ReceiveOperation[];
  states?: string[];
  restored?: string[];
  saved?: string[];
}) {
  const rolledBack: Array<{ id: string; reason: string }> = [];
  let stateChecks = 0;
  let restoreChecks = 0;
  const reconcileSource: ReceiveReconcileSource = {
    listExecuting: async () => options.operations,
    checkProofStates: async (op) => {
      stateChecks++;
      return (options.states ?? op.inputProofs.map(() => "SPENT")).map((state) => ({ state }));
    },
    restoreOutputs: async (_mintUrl, outputs) => {
      restoreChecks++;
      const restored = new Set(options.restored ?? []);
      return outputs.filter((output) => restored.has(output.B_));
    },
    hasSavedOutputs: async (op) => (options.saved ?? []).includes(op.id),
    rollBack: async (op, reason) => {
      rolledBack.push({ id: op.id, reason });
    },
  };
  return {
    source: reconcileSource,
    rolledBack,
    stateChecks: () => stateChecks,
    restoreChecks: () => restoreChecks,
  };
}

describe("receive token hashing and reservation", () => {
  it("hashes the exact encoded token deterministically", () => {
    expect(hashReceiveToken("cashuA")).toBe(hashReceiveToken("cashuA"));
    expect(hashReceiveToken("cashuA")).not.toBe(hashReceiveToken("cashuB"));
  });

  it("atomically reserves an exact token once", () => {
    const database = new Database(":memory:");
    initReceiveDedupSchema(database);
    const first = reserveReceiveToken(database, "cashuA");
    const second = reserveReceiveToken(database, "cashuA");
    expect(first.acquired).toBe(true);
    expect(second).toMatchObject({
      acquired: false,
      existing: { state: "processing", operationId: null },
    });
    database.close();
  });

  it("persists successful status and releases retryable reservations", () => {
    const database = new Database(":memory:");
    initReceiveDedupSchema(database);
    const reservation = reserveReceiveToken(database, "cashuA");
    updateReceiveToken(database, reservation.tokenHash, {
      state: "succeeded",
      operationId: "receive-1",
    });
    expect(reserveReceiveToken(database, "cashuA").existing).toMatchObject({
      state: "succeeded",
      operationId: "receive-1",
    });
    deleteReceiveTokenReservation(database, reservation.tokenHash);
    expect(reserveReceiveToken(database, "cashuA").acquired).toBe(true);
    database.close();
  });

  it("clears only interrupted reservations without Coco operation ids", () => {
    const database = new Database(":memory:");
    initReceiveDedupSchema(database);
    const orphan = reserveReceiveToken(database, "orphan");
    const linked = reserveReceiveToken(database, "linked");
    updateReceiveToken(database, linked.tokenHash, {
      state: "processing",
      operationId: "receive-1",
    });
    expect(clearInterruptedReceiveReservations(database)).toBe(1);
    expect(listProcessingReceiveTokens(database)).toEqual([
      expect.objectContaining({ tokenHash: linked.tokenHash, operationId: "receive-1" }),
    ]);
    expect(reserveReceiveToken(database, "orphan").tokenHash).toBe(orphan.tokenHash);
    database.close();
  });
});

describe("legacy receive grouping", () => {
  it("groups identical input proofs independent of operation id", () => {
    const groups = groupExecutingReceives([
      operation("one", "same", "B1"),
      operation("two", "same", "B2"),
      operation("three", "different", "B3"),
    ]);
    expect(groups.map((group) => group.map((op) => op.id))).toEqual([
      ["one", "two"],
      ["three"],
    ]);
  });

  it("checks an unspent duplicate group once and retains one operation", async () => {
    const mock = source({
      operations: [operation("one", "same", "B1", 1), operation("two", "same", "B2", 2)],
      states: ["UNSPENT"],
    });
    const result = await reconcileExecutingReceives(mock.source);
    expect(mock.stateChecks()).toBe(1);
    expect(mock.restoreChecks()).toBe(0);
    expect(mock.rolledBack.map((entry) => entry.id)).toEqual(["two"]);
    expect(result).toMatchObject({ rolledBack: 1, retained: 1, unresolved: 0 });
  });

  it("rolls back all spent duplicates when restore finds no outputs", async () => {
    const mock = source({
      operations: [operation("one", "same", "B1"), operation("two", "same", "B2")],
      states: ["SPENT"],
      restored: [],
    });
    const result = await reconcileExecutingReceives(mock.source);
    expect(mock.stateChecks()).toBe(1);
    expect(mock.restoreChecks()).toBe(1);
    expect(mock.rolledBack.map((entry) => entry.id)).toEqual(["one", "two"]);
    expect(result.rolledBack).toBe(2);
  });

  it("retains the operation whose output the mint can restore", async () => {
    const mock = source({
      operations: [operation("one", "same", "B1"), operation("two", "same", "B2")],
      states: ["SPENT"],
      restored: ["B2"],
    });
    const result = await reconcileExecutingReceives(mock.source);
    expect(mock.rolledBack.map((entry) => entry.id)).toEqual(["one"]);
    expect(result).toMatchObject({ rolledBack: 1, retained: 1 });
  });

  it("leaves a group untouched when the mint returns incomplete states", async () => {
    const first = operation("one", "same", "B1");
    first.inputProofs.push({ amount: 1, id: "keyset", secret: "other", C: "03" });
    const second = operation("two", "same", "B2");
    second.inputProofs.push({ amount: 1, id: "keyset", secret: "other", C: "03" });
    const mock = source({
      operations: [first, second],
      states: ["SPENT"],
    });
    const result = await reconcileExecutingReceives(mock.source);
    expect(mock.rolledBack).toEqual([]);
    expect(mock.restoreChecks()).toBe(0);
    expect(result.unresolved).toBe(2);
  });

  it("leaves a group untouched when proof states are mixed", async () => {
    const first = operation("one", "same", "B1");
    first.inputProofs.push({ amount: 1, id: "keyset", secret: "other", C: "03" });
    const second = operation("two", "same", "B2");
    second.inputProofs.push({ amount: 1, id: "keyset", secret: "other", C: "03" });
    const mock = source({
      operations: [first, second],
      states: ["SPENT", "UNSPENT"],
    });
    const result = await reconcileExecutingReceives(mock.source);
    expect(mock.rolledBack).toEqual([]);
    expect(result.unresolved).toBe(2);
  });

  it("scales mint checks with unique input groups rather than row count", async () => {
    const operations: ReceiveOperation[] = [];
    for (let group = 0; group < 47; group++) {
      const repeats = group < 44 ? 41 : 40; // 1,924 rows total
      for (let index = 0; index < repeats; index++) {
        operations.push(
          operation(
            `operation-${group}-${index}`,
            `secret-${group}`,
            `B-${group}-${index}`,
            index,
          ),
        );
      }
    }
    expect(operations).toHaveLength(1924);
    const mock = source({ operations, states: ["SPENT"], restored: [] });
    const result = await reconcileExecutingReceives(mock.source);
    expect(mock.stateChecks()).toBe(47);
    expect(mock.restoreChecks()).toBe(47);
    expect(result).toMatchObject({
      executing: 1924,
      uniqueGroups: 47,
      rolledBack: 1924,
      unresolved: 0,
    });
  });
});
