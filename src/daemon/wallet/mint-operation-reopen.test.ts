/**
 * Re-opening a failed mint operation is the one genuinely destructive step of
 * PAID-quote recovery, because coco's private `transitionToPending` spreads
 * whatever it is handed and `SqliteMintOperationRepository.update` rewrites
 * every column. A partial object such as `{ id }` is therefore rejected by the
 * NOT NULL schema, and on a more permissive adapter would overwrite `quoteId`,
 * `amount`, `request`, `lastObservedRemoteState` and `outputDataJson` with NULL,
 * destroying the material needed to claim the paid sats.
 *
 * These tests drive the production `reopenFailedMintOperation` helper against a
 * real coco sqlite repository through adapter-backed getOperation and
 * transitionToPending implementations, so a regression at the helper/service
 * boundary is caught rather than a mock standing in for it.
 */
import { afterEach, describe, expect, it } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SqliteRepositories } from "@cashu/coco-sqlite-bun";
import { reopenFailedMintOperation } from "./coco-client";

const OUTPUT_DATA = [
  {
    blindedMessage: { amount: "210000", id: "00deadbeef", B_: "02deadbeef" },
    blindingFactor: "1234567890",
    secret: "aabbccdd",
  },
];

function failedRow(state = "failed") {
  return {
    id: "op-1",
    mintUrl: "https://mint.example.com",
    quoteId: "quote-1",
    state,
    createdAt: 1_000,
    updatedAt: 2_000,
    error: state === "failed" ? "expired" : undefined,
    method: "bolt11",
    methodData: { method: "bolt11", data: {} },
    amount: 210_000,
    unit: "sat",
    request: "lnbc1example",
    expiry: 1_800_000_000,
    pubkey: undefined,
    lastObservedRemoteState: "PAID",
    lastObservedRemoteStateAt: 3_000,
    terminalFailure:
      state === "failed" ? { reason: "expired", observedAt: 3_000 } : undefined,
    outputData: OUTPUT_DATA,
  };
}

describe("reopenFailedMintOperation against real coco sqlite", () => {
  let dir: string | undefined;
  let database: Database | undefined;

  afterEach(() => {
    database?.close();
    database = undefined;
    if (dir) rmSync(dir, { recursive: true, force: true });
    dir = undefined;
  });

  async function repos() {
    dir = mkdtempSync(join(tmpdir(), "routstrd-reopen-"));
    database = new Database(join(dir, "coco.db"));
    const repositories = new SqliteRepositories({ database });
    await repositories.init();
    return repositories;
  }

  function readRow(repositories: SqliteRepositories, id: string) {
    return repositories.mintOperationRepository.getById(id) as unknown as Promise<
      Record<string, unknown> | null
    >;
  }

  /**
   * Adapter-backed stand-in for the private coco service methods the helper
   * uses: getOperation reads and transitionToPending mirrors coco's
   * spread-and-update implementation.
   */
  function serviceOver(repositories: SqliteRepositories) {
    return {
      acquireOperationLock: async (_id: string) => () => {},
      getOperation: (id: string) => readRow(repositories, id),
      transitionToPending: async (
        op: Record<string, unknown>,
        error?: string,
      ) => {
        await repositories.mintOperationRepository.update({
          ...op,
          state: "pending",
          error,
        } as never);
      },
    };
  }

  it("re-opens a failed row without losing quote metadata or stored outputs", async () => {
    const repositories = await repos();
    await repositories.mintOperationRepository.create(
      failedRow() as never,
    );

    const reopened = await reopenFailedMintOperation(
      serviceOver(repositories),
      "op-1",
    );

    expect(reopened).toBe(true);
    const row = await readRow(repositories, "op-1");
    expect(row?.state).toBe("pending");
    expect(row?.quoteId).toBe("quote-1");
    expect(row?.amount).toBe(210_000);
    expect(row?.unit).toBe("sat");
    expect(row?.request).toBe("lnbc1example");
    expect(row?.lastObservedRemoteState).toBe("PAID");
    expect(row?.outputData).toEqual(OUTPUT_DATA);
    expect(row?.terminalFailure ?? undefined).toBeUndefined();
  });

  it("is a no-op when the operation is no longer failed", async () => {
    const repositories = await repos();
    await repositories.mintOperationRepository.create(
      failedRow("finalized") as never,
    );

    const reopened = await reopenFailedMintOperation(
      serviceOver(repositories),
      "op-1",
    );

    expect(reopened).toBe(false);
    const row = await readRow(repositories, "op-1");
    expect(row?.state).toBe("finalized");
    expect(row?.outputData).toEqual(OUTPUT_DATA);
  });

  it("rejects a partial row, which is why the helper reloads in full", async () => {
    // Locks in the reason for reloading. If a future coco version accepts
    // partial updates this fails, and the helper can be simplified rather than
    // silently losing paid sats.
    const repositories = await repos();
    await repositories.mintOperationRepository.create(
      failedRow() as never,
    );

    await expect(
      repositories.mintOperationRepository.update({
        id: "op-1",
        state: "pending",
        updatedAt: Date.now(),
      } as never),
    ).rejects.toThrow();

    const unchanged = await readRow(repositories, "op-1");
    expect(unchanged?.state).toBe("failed");
    expect(unchanged?.outputData).toEqual(OUTPUT_DATA);
  });
});
