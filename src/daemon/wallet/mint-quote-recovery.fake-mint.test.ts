/**
 * End-to-end PAID mint-quote recovery against a real coco Manager, real sqlite
 * and a real in-process mint that produces genuine blind signatures.
 *
 * Nothing here mocks the wallet: a quote is created through coco, the mint is
 * told what to report, and the production `runMintQuoteRecovery` drives the
 * outcome. These are the release-gating scenarios for the feature, and they are
 * the only tests that exercise issuance and NUT-09 restore over HTTP.
 */
import { afterEach, describe, expect, it } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Manager } from "@cashu/coco-core";
import { SqliteRepositories } from "@cashu/coco-sqlite-bun";
import { QUOTE_EXPIRED, FakeMint } from "./testing/fake-mint";
import { reopenFailedMintOperation, runMintQuoteRecovery } from "./coco-client";

type AnyRecord = Record<string, unknown>;

interface Booted {
  manager: Manager;
  repositories: SqliteRepositories;
  mint: FakeMint;
  /** Build the recovery source the production function expects. */
  source: () => AnyRecord;
  spendable: () => Promise<number>;
  close: () => Promise<void>;
}

async function boot(options: { quoteExpiry?: number | null } = {}) {
  const mint = new FakeMint();
  mint.quoteExpiry = options.quoteExpiry ?? null;
  mint.start();
  const dir = mkdtempSync(join(tmpdir(), "routstrd-fakemint-"));
  const database = new Database(join(dir, "coco.db"));
  const repositories = new SqliteRepositories({ database });
  await repositories.init();
  const manager = new Manager(repositories, async () => new Uint8Array(64).fill(7));
  await manager.mint.addMint(mint.url, { trusted: true });

  const service = (manager as unknown as { mintOperationService: AnyRecord })
    .mintOperationService;

  const booted: Booted = {
    manager,
    repositories,
    mint,
    spendable: async () => {
      const balances = (await manager.wallet.balances.byMint()) as Record<
        string,
        { spendable: number }
      >;
      return balances[mint.url]?.spendable ?? 0;
    },
    source: () => ({
      ops: {
        mint: {
          listPending: () => manager.ops.mint.listPending(),
          get: (id: string) => manager.ops.mint.get(id),
          finalize: (id: string) => manager.ops.mint.finalize(id),
        },
      },
      mintOperationService: service,
      reopenFailedOperation: (id: string) =>
        reopenFailedMintOperation(service as never, id),
    }),
    close: async () => {
      await manager.dispose().catch(() => undefined);
      database.close();
      mint.stop();
      rmSync(dir, { recursive: true, force: true });
    },
  };

  return booted;
}

async function prepareQuote(booted: Booted, amount: number) {
  const op = (await booted.manager.ops.mint.prepare({
    mintUrl: booted.mint.url,
    amount,
    method: "bolt11",
  } as never)) as unknown as AnyRecord;
  return op;
}

function outputsOf(op: AnyRecord) {
  // coco stores mint outputs as { keep, send }, like the on-disk output JSON.
  const outputData = (op.outputData as AnyRecord).keep as Array<{
    blindedMessage: { amount: unknown; id: string; B_: string };
  }>;
  return outputData.map((output) => ({
    amount: Number(String(output.blindedMessage.amount)),
    id: output.blindedMessage.id,
    B_: output.blindedMessage.B_,
  }));
}

let booted: Booted | undefined;
afterEach(async () => {
  await booted?.close();
  booted = undefined;
});

describe("PAID mint quote recovery with a real Manager and mint", () => {
  it("issues an expired-but-PAID quote with the operation's own outputs, once", async () => {
    // The motivating case: the invoice expired, but the mint says PAID and has
    // issued nothing.
    booted = await boot({ quoteExpiry: -60 });
    const op = await prepareQuote(booted, 210_000);
    const expectedOutputs = outputsOf(op).map((o) => o.B_);
    booted.mint.markPaid(op.quoteId as string);

    const result = (await runMintQuoteRecovery(
      booted.source() as never,
    )) as unknown as Record<string, number>;

    expect(result).toMatchObject({ checked: 1, recovered: 1, terminal: 0 });
    expect(await booted.spendable()).toBe(210_000);
    // Issuance used exactly the blinded outputs stored on the operation.
    expect(booted.mint.requests).toHaveLength(1);
    expect(booted.mint.requests[0]?.outputs.map((o) => o.B_).sort()).toEqual(
      [...expectedOutputs].sort(),
    );

    // A second run must not mint again or double-credit.
    const again = (await runMintQuoteRecovery(
      booted.source() as never,
    )) as unknown as Record<string, number>;
    expect(again).toMatchObject({ checked: 0, recovered: 0 });
    expect(booted.mint.requests).toHaveLength(1);
    expect(await booted.spendable()).toBe(210_000);
  });

  it("existing coco recovery already issues expired paid pending quotes", async () => {
    booted = await boot({ quoteExpiry: -60 });
    const op = await prepareQuote(booted, 100);
    booted.mint.markPaid(op.quoteId as string);
    await booted.manager.recoverPendingMintOperations();
    expect(await booted.spendable()).toBe(100);
    expect(booted.mint.getQuote(op.quoteId as string)?.state).toBe("ISSUED");
  });

  it("keeps rejected stored outputs and reports the actionable mint error", async () => {
    booted = await boot({ quoteExpiry: -60 });
    const op = await prepareQuote(booted, 100);
    const outputs = outputsOf(op);
    booted.mint.markPaid(op.quoteId as string);
    // Model the mint refusing the stored outputs, not invoice expiry. This is
    // not evidence that the production quotes used an inactive keyset.
    booted.mint.mintError = { code: 12001, detail: "keyset id inactive." };
    await booted.manager.recoverPendingMintOperations();
    expect(await booted.spendable()).toBe(0);
    const result = await runMintQuoteRecovery(booted.source() as never, {
      operationIds: [op.id as string],
    });
    expect(result).toMatchObject({ recovered: 0, retryable: 1 });
    expect(result.errors.some((entry) => entry.error.includes("keyset id inactive"))).toBe(true);
    expect(await booted.spendable()).toBe(0);
    expect(booted.mint.getQuote(op.quoteId as string)?.state).toBe("PAID");
    expect(outputsOf(await booted.manager.ops.mint.get(op.id as string) as unknown as AnyRecord)).toEqual(outputs);
    for (const request of booted.mint.requests) expect(request.outputs).toEqual(outputs);
  });

  it("restores proofs for a quote already issued at the mint", async () => {
    booted = await boot({ quoteExpiry: null });
    const op = await prepareQuote(booted, 210_000);
    // Another wallet issued it: the signatures exist at the mint for the very
    // outputs this operation stored.
    booted.mint.signFor(op.quoteId as string, outputsOf(op));

    const result = (await runMintQuoteRecovery(
      booted.source() as never,
    )) as unknown as Record<string, number>;

    expect(result).toMatchObject({ recovered: 1, terminal: 0, retryable: 0 });
    expect(await booted.spendable()).toBe(210_000);
  });

  it("reports terminal without credit when the mint refuses issuance", async () => {
    booted = await boot({ quoteExpiry: -60 });
    const op = await prepareQuote(booted, 21_000);
    booted.mint.markPaid(op.quoteId as string);
    booted.mint.mintError = { code: QUOTE_EXPIRED, detail: "quote expired" };

    const result = (await runMintQuoteRecovery(
      booted.source() as never,
    )) as unknown as Record<string, unknown>;

    expect(result).toMatchObject({ recovered: 0, terminal: 1 });
    expect((result.errors as unknown[]).length).toBeGreaterThan(0);
    expect(await booted.spendable()).toBe(0);
  });

  it("reports terminal without credit when an issued quote cannot be restored", async () => {
    booted = await boot({ quoteExpiry: null });
    const op = await prepareQuote(booted, 21_000);
    // Issued at the mint, but the signatures for our outputs are gone.
    booted.mint.markIssued(op.quoteId as string);

    const result = (await runMintQuoteRecovery(
      booted.source() as never,
    )) as unknown as Record<string, number>;

    expect(result).toMatchObject({ recovered: 0, terminal: 1 });
    expect(await booted.spendable()).toBe(0);
  });

  it("does not credit a quote when the mint returns null NUT-09 signatures", async () => {
    // KNOWN INTEROP GAP, not a supported path. NUT-09 permits `null` in the
    // positional `signatures` array for outputs the mint never signed, but
    // cashu-ts 3.7.1 - which coco depends on - dereferences every entry while
    // normalising amounts, so the wallet throws instead of skipping the null.
    // Recovery therefore surfaces an error and credits nothing, leaving the
    // operation for a later run.
    //
    // This test pins the current behaviour so the gap cannot quietly disappear.
    // Revisit (and change this expectation) once coco's cashu-ts parses
    // positional nulls, and file/track it upstream in the meantime.
    booted = await boot({ quoteExpiry: null });
    const op = await prepareQuote(booted, 21_000);
    // Issued at the mint with nothing signed for this operation's outputs.
    booted.mint.markIssued(op.quoteId as string);
    booted.mint.restoreIncludesNulls = true;

    const result = (await runMintQuoteRecovery(
      booted.source() as never,
    )) as unknown as Record<string, number>;

    expect(result).toMatchObject({ recovered: 0, terminal: 0, retryable: 1 });
    expect(await booted.spendable()).toBe(0);
  });

  it("recovers a failed operation whose stale history says UNPAID", async () => {
    // The composed path the feature exists for: a real prepared operation,
    // failed locally, with a stale UNPAID observation from the old local-fail
    // behaviour, recovered by explicit id and issued with its own outputs.
    booted = await boot({ quoteExpiry: -60 });
    const op = await prepareQuote(booted, 21_000);
    const storedOutputs = outputsOf(op).map((o) => o.B_);
    booted.mint.markPaid(op.quoteId as string);

    const row = (await booted.repositories.mintOperationRepository.getById(
      op.id as string,
    )) as unknown as AnyRecord;
    expect(row.outputData).toBeDefined();
    await booted.repositories.mintOperationRepository.update({
      ...row,
      state: "failed",
      lastObservedRemoteState: "UNPAID",
      error: "Expired unpaid mint quote cleaned up by routstrd",
      terminalFailure: { reason: "expired", observedAt: Date.now() },
    } as never);

    // A purely local decision would skip this row; the mint has the last word.
    const result = (await runMintQuoteRecovery(booted.source() as never, {
      operationIds: [op.id as string],
      includeFailed: true,
    })) as unknown as Record<string, number>;

    expect(result).toMatchObject({ reopened: 1, recovered: 1, terminal: 0 });
    expect(await booted.spendable()).toBe(21_000);
    expect(booted.mint.requests).toHaveLength(1);
    expect(booted.mint.requests[0]?.outputs.map((o) => o.B_).sort()).toEqual(
      [...storedOutputs].sort(),
    );
  });

  it("counts a locked operation as busy instead of minting underneath it", async () => {
    booted = await boot({ quoteExpiry: -60 });
    const op = await prepareQuote(booted, 21_000);
    booted.mint.markPaid(op.quoteId as string);
    const service = (
      booted.manager as unknown as {
        mintOperationService: { acquireOperationLock(id: string): Promise<() => void> };
      }
    ).mintOperationService;

    // Hold the operation, as a processor or another recovery would.
    const release = await service.acquireOperationLock(op.id as string);
    const blocked = (await runMintQuoteRecovery(
      booted.source() as never,
    )) as unknown as Record<string, number>;

    expect(blocked).toMatchObject({ recovered: 0 });
    expect((blocked.busy ?? 0) + (blocked.retryable ?? 0)).toBeGreaterThan(0);
    expect(booted.mint.requests).toHaveLength(0);
    expect(await booted.spendable()).toBe(0);

    release();
    const after = (await runMintQuoteRecovery(
      booted.source() as never,
    )) as unknown as Record<string, number>;
    expect(after).toMatchObject({ recovered: 1 });
    expect(await booted.spendable()).toBe(21_000);
    expect(booted.mint.requests).toHaveLength(1);
  });

  it("does not mint a second time while issuance is in flight", async () => {
    booted = await boot({ quoteExpiry: -60 });
    const op = await prepareQuote(booted, 21_000);
    booted.mint.markPaid(op.quoteId as string);

    // Hold the mint's response so the first recovery is visibly in flight.
    let releaseGate!: () => void;
    booted.mint.gate = new Promise<void>((resolve) => {
      releaseGate = resolve;
    });
    const first = runMintQuoteRecovery(
      booted.source() as never,
    ) as unknown as Promise<Record<string, number>>;

    for (let i = 0; i < 400 && booted.mint.requests.length === 0; i++) {
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    expect(booted.mint.requests).toHaveLength(1);

    // A concurrent run must not issue again while that request is outstanding.
    await runMintQuoteRecovery(booted.source() as never);
    expect(booted.mint.requests).toHaveLength(1);

    releaseGate();
    expect(await first).toMatchObject({ recovered: 1 });
    expect(await booted.spendable()).toBe(21_000);
    expect(booted.mint.requests).toHaveLength(1);
  });

  it("coexists with coco's own mint operation watcher and processor", async () => {
    booted = await boot({ quoteExpiry: -60 });
    // The real background machinery coco uses to settle pending mint quotes.
    await booted.manager.enableMintOperationWatcher();
    await booted.manager.enableMintOperationProcessor();
    const op = await prepareQuote(booted, 21_000);
    booted.mint.markPaid(op.quoteId as string);

    // Either our recovery or coco's processor may win; both are safe.
    await runMintQuoteRecovery(booted.source() as never);

    expect(await booted.spendable()).toBe(21_000);
    expect(booted.mint.requests.length).toBeLessThanOrEqual(1);

    // Give the processor time to act and confirm nothing is credited twice.
    await new Promise((resolve) => setTimeout(resolve, 250));
    expect(await booted.spendable()).toBe(21_000);
    expect(booted.mint.requests.length).toBeLessThanOrEqual(1);
  });

  it("tracks a hung quote check so a later run waits instead of re-reading", async () => {
    booted = await boot({ quoteExpiry: -60 });
    const op = await prepareQuote(booted, 21_000);
    booted.mint.markPaid(op.quoteId as string);

    let releaseObserve!: () => void;
    booted.mint.observeGate = new Promise<void>((resolve) => {
      releaseObserve = resolve;
    });
    const outstanding = new Map<string, Promise<unknown>>();

    const first = (await runMintQuoteRecovery(booted.source() as never, {
      timeoutMs: 30,
      outstanding,
    })) as unknown as Record<string, number>;
    expect(first).toMatchObject({ retryable: 1, recovered: 0 });
    expect(outstanding.has(op.id as string)).toBe(true);

    const second = (await runMintQuoteRecovery(booted.source() as never, {
      outstanding,
    })) as unknown as Record<string, number>;
    expect(second).toMatchObject({ checked: 0, busy: 1 });

    // Once the held check settles the tracking drains, and recovery proceeds.
    releaseObserve();
    for (let i = 0; i < 400 && outstanding.size > 0; i++) {
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    expect(outstanding.size).toBe(0);

    const third = (await runMintQuoteRecovery(
      booted.source() as never,
    )) as unknown as Record<string, number>;
    expect(third).toMatchObject({ recovered: 1 });
    expect(await booted.spendable()).toBe(21_000);
  });
});
