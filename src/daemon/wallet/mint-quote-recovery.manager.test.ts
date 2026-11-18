/**
 * Real-Manager integration for re-opening a failed mint operation.
 *
 * The unit tests exercise `reopenFailedMintOperation` against a hand-written
 * service double, which cannot catch a change in coco's own
 * `MintOperationService.transitionToPending` semantics or in its per-operation
 * lock. This drives the production helper against an actual coco `Manager`
 * backed by sqlite, so the private-service boundary that the helper depends on
 * is exercised for real: full-row preservation, the shared operation lock, and
 * the `mint-op:pending` event.
 *
 * No mint or network access is involved; nothing here enables the mint watcher
 * or processor, which the fake-mint integration covers.
 */
import { afterEach, describe, expect, it } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Manager } from "@cashu/coco-core";
import { SqliteRepositories } from "@cashu/coco-sqlite-bun";
import { reopenFailedMintOperation } from "./coco-client";

const OUTPUT_DATA = [
  {
    blindedMessage: { amount: "210000", id: "00deadbeef", B_: "02deadbeef" },
    blindingFactor: "1234567890",
    secret: "aabbccdd",
  },
];

function failedRow() {
  return {
    id: "op-1",
    mintUrl: "https://mint.invalid",
    quoteId: "quote-1",
    state: "failed",
    createdAt: 1_000,
    updatedAt: 2_000,
    error: "expired",
    method: "bolt11",
    methodData: { method: "bolt11", data: {} },
    amount: 210_000,
    unit: "sat",
    request: "lnbc1example",
    expiry: 1_800_000_000,
    pubkey: undefined,
    lastObservedRemoteState: "PAID",
    lastObservedRemoteStateAt: 3_000,
    terminalFailure: { reason: "expired", observedAt: 3_000 },
    outputData: OUTPUT_DATA,
  };
}

describe("reopenFailedMintOperation with a real coco Manager", () => {
  let dir: string | undefined;
  let database: Database | undefined;
  let manager: Manager | undefined;
  let repositories: SqliteRepositories | undefined;

  afterEach(async () => {
    await manager?.dispose().catch(() => undefined);
    manager = undefined;
    database?.close();
    database = undefined;
    repositories = undefined;
    if (dir) rmSync(dir, { recursive: true, force: true });
    dir = undefined;
  });

  async function boot() {
    dir = mkdtempSync(join(tmpdir(), "routstrd-manager-"));
    database = new Database(join(dir, "coco.db"));
    repositories = new SqliteRepositories({ database });
    await repositories.init();
    manager = new Manager(repositories, async () => new Uint8Array(64).fill(7));
    await repositories.mintOperationRepository.create(failedRow() as never);
    const service = (
      manager as unknown as {
        mintOperationService: {
          acquireOperationLock(id: string): Promise<() => void>;
          getOperation(id: string): Promise<Record<string, unknown> | null>;
          transitionToPending(
            op: Record<string, unknown>,
            error?: string,
          ): Promise<unknown>;
        };
      }
    ).mintOperationService;
    const eventBus = (
      manager as unknown as {
        eventBus: { on(event: string, handler: () => void): () => void };
      }
    ).eventBus;
    return { service, eventBus };
  }

  function readRow(id: string) {
    return repositories!.mintOperationRepository.getById(id) as unknown as Promise<
      Record<string, unknown> | null
    >;
  }

  it("re-opens through the real service and emits mint-op:pending", async () => {
    const { service, eventBus } = await boot();
    const events: string[] = [];
    const off = eventBus.on("mint-op:pending", () => events.push("pending"));

    const reopened = await reopenFailedMintOperation(service, "op-1");
    off();

    expect(reopened).toBe(true);
    const row = await readRow("op-1");
    expect(row?.state).toBe("pending");
    expect(row?.quoteId).toBe("quote-1");
    expect(row?.amount).toBe(210_000);
    expect(row?.lastObservedRemoteState).toBe("PAID");
    expect(row?.outputData).toEqual(OUTPUT_DATA);
    expect(row?.terminalFailure ?? undefined).toBeUndefined();
    expect(events).toEqual(["pending"]);
  });

  it("refuses to re-open while coco's operation lock is held", async () => {
    const { service } = await boot();
    // coco's OperationIdLock is fail-fast: a holder blocks the re-open by
    // making it throw, and nothing is written.
    const release = await service.acquireOperationLock("op-1");

    await expect(reopenFailedMintOperation(service, "op-1")).rejects.toThrow(
      /already in progress/,
    );
    const blocked = await readRow("op-1");
    expect(blocked?.state).toBe("failed");
    expect(blocked?.outputData).toEqual(OUTPUT_DATA);

    release();
    expect(await reopenFailedMintOperation(service, "op-1")).toBe(true);
    const reopened = await readRow("op-1");
    expect(reopened?.state).toBe("pending");
    expect(reopened?.outputData).toEqual(OUTPUT_DATA);
  });

  it("leaves an operation a processor finalized alone", async () => {
    const { service } = await boot();
    // Emulate a processor winning the race while holding the same lock.
    const release = await service.acquireOperationLock("op-1");
    const row = await readRow("op-1");
    await repositories!.mintOperationRepository.update({
      ...row,
      state: "finalized",
    } as never);
    release();

    expect(await reopenFailedMintOperation(service, "op-1")).toBe(false);
    const after = await readRow("op-1");
    expect(after?.state).toBe("finalized");
    expect(after?.outputData).toEqual(OUTPUT_DATA);
  });
});
