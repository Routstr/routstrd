import { describe, expect, it, mock } from "bun:test";
import { Manager } from "@cashu/coco-core";
import { SqliteRepositories } from "@cashu/coco-sqlite-bun";
import { Database } from "bun:sqlite";
import { OFFLINE_SWEEP_MIN_AGE_MS, sweepOfflineSends } from "./offline-sweep";
import { registerOfflineSendHandler } from "./offline-send";

const NOW = 2_000_000_000_000;
const MINT = "https://mint.example";
function operation(id: string, overrides = {}) {
  return {
    id, mintUrl: MINT, method: "offline", state: "pending",
    createdAt: NOW - OFFLINE_SWEEP_MIN_AGE_MS, updatedAt: NOW,
    inputAmount: 8, inputProofSecrets: [id],
    token: { mint: MINT, unit: "sat", proofs: [{ amount: 8, secret: id, id: "keyset", C: "C" }] },
    ...overrides,
  };
}
function setup(ops = [operation("old")], states = ["UNSPENT"]) {
  const stored = new Map(ops.map((op) => [op.id, op]));
  const check = mock(async () => states.map((state) => ({ state })));
  const getWallet = mock(async () => ({ wallet: { checkProofsStates: check, getFeesForProofs: (): number => 0 } }));
  const mark = mock(async () => {});
  const finalize = mock(async (id: string) => { stored.get(id)!.state = "finalized"; });
  const reclaim = mock(async (id: string) => { stored.get(id)!.state = "rolled_back"; });
  const coco = {
    walletService: { getWalletWithActiveKeysetId: getWallet },
    proofService: { setProofState: mark },
    ops: { send: { listInFlight: async () => ops, get: async (id: string) => stored.get(id), finalize, reclaim } },
  } as unknown as Manager;
  return { coco, check, getWallet, mark, finalize, reclaim, stored };
}

describe("offline token sweep", () => {
  it("requires explicit consent and validates age before reading operations", async () => {
    const { coco, getWallet } = setup();
    await expect(sweepOfflineSends(coco, {}, NOW)).rejects.toThrow("confirmation");
    for (const minAgeMs of [-1, NaN, Infinity, 0.1]) {
      await expect(sweepOfflineSends(coco, { dryRun: true, minAgeMs }, NOW)).rejects.toThrow("minimum age");
    }
    expect(getWallet).not.toHaveBeenCalled();
  });

  it("dry-runs only pending offline tokens aged at least seven days, without mint access", async () => {
    const { coco, getWallet, reclaim, mark } = setup([
      operation("old"), operation("recent", { createdAt: NOW - 1 }),
      operation("online", { method: "default" }), operation("executing", { state: "executing" }),
      operation("other", { mintUrl: "https://other.example" }),
    ]);
    const result = await sweepOfflineSends(coco, { dryRun: true, mintUrl: MINT }, NOW);
    expect(result).toMatchObject({ candidates: 1, skipped: 4, claimed: 0, reclaimed: 0 });
    expect(result.operations[0]).toMatchObject({ operationId: "old", outcome: "candidate" });
    expect(getWallet).not.toHaveBeenCalled();
    expect(reclaim).not.toHaveBeenCalled();
    expect(mark).not.toHaveBeenCalled();
  });

  it("reclaims unclaimed tokens through Coco rather than restoring shared proofs", async () => {
    const { coco, reclaim, mark } = setup();
    expect(await sweepOfflineSends(coco, { confirmed: true }, NOW)).toMatchObject({ reclaimed: 1, claimed: 0, failed: 0 });
    expect(reclaim).toHaveBeenCalledWith("old");
    expect(mark).not.toHaveBeenCalled();
  });

  it("finalizes mint-verified claimed tokens without attempting reclaim", async () => {
    const { coco, reclaim, mark, finalize } = setup(undefined, ["SPENT"]);
    expect(await sweepOfflineSends(coco, { confirmed: true }, NOW)).toMatchObject({ claimed: 1, reclaimed: 0 });
    expect(mark).toHaveBeenCalledWith(MINT, ["old"], "spent");
    expect(finalize).toHaveBeenCalledWith("old");
    expect(reclaim).not.toHaveBeenCalled();
  });

  it("leaves mixed, pending and unknown state tokens untouched", async () => {
    for (const state of ["PENDING", "UNKNOWN"]) {
      const { coco, reclaim, mark } = setup(undefined, [state]);
      expect(await sweepOfflineSends(coco, { confirmed: true }, NOW)).toMatchObject({ unresolved: 1, reclaimed: 0 });
      expect(reclaim).not.toHaveBeenCalled();
      expect(mark).not.toHaveBeenCalled();
    }
    const op = operation("mixed");
    op.inputProofSecrets.push("second");
    op.token.proofs.push({ ...op.token.proofs[0]!, secret: "second" });
    const { coco, reclaim, mark } = setup([op], ["SPENT", "UNSPENT"]);
    expect(await sweepOfflineSends(coco, { confirmed: true }, NOW)).toMatchObject({ unresolved: 1 });
    expect(reclaim).not.toHaveBeenCalled();
    expect(mark).not.toHaveBeenCalled();
  });

  it("reports malformed responses and continues after unreachable mints or reclaim races", async () => {
    const { coco, getWallet, reclaim } = setup([operation("bad"), operation("race"), operation("good")]);
    getWallet.mockRejectedValueOnce(new Error("mint unavailable"));
    reclaim.mockRejectedValueOnce(new Error("recipient already spent token"));
    const result = await sweepOfflineSends(coco, { confirmed: true }, NOW);
    expect(result).toMatchObject({ candidates: 3, failed: 2, reclaimed: 1, claimed: 0 });
    expect(result.operations.map((op) => op.outcome)).toEqual(["failed", "failed", "reclaimed"]);
    const malformed = setup(undefined, []);
    expect(await sweepOfflineSends(malformed.coco, { confirmed: true }, NOW)).toMatchObject({ failed: 1 });
    expect(malformed.reclaim).not.toHaveBeenCalled();
  });

  it("does not report fee-exhausted tokens or unsuccessful transitions as reclaimed", async () => {
    const test = setup();
    test.getWallet.mockResolvedValue({ wallet: { checkProofsStates: test.check, getFeesForProofs: () => 8 } });
    expect(await sweepOfflineSends(test.coco, { confirmed: true }, NOW)).toMatchObject({ failed: 1, reclaimed: 0 });
    expect(test.reclaim).not.toHaveBeenCalled();
    const noTransition = setup();
    noTransition.reclaim.mockImplementation(async () => {});
    expect(await sweepOfflineSends(noTransition.coco, { confirmed: true }, NOW)).toMatchObject({ failed: 1, reclaimed: 0 });
  });

  it("reclaims through a real Manager mint swap and saves fresh ready proofs", async () => {
    const database = new Database(":memory:");
    const repo = new SqliteRepositories({ database });
    await repo.init();
    const coco = new Manager(repo, async () => new Uint8Array(64));
    registerOfflineSendHandler(coco);
    const receive = mock(async (_token: unknown, ..._options: unknown[]) => [{ amount: 8, id: "keyset", secret: "fresh", C: "fresh-C" }]);
    const internals = coco as unknown as {
      walletService: { getWalletWithActiveKeysetId: (mintUrl: string) => Promise<unknown> };
      proofService: { createOutputsAndIncrementCounters: (mintUrl: string, amounts: unknown) => Promise<unknown> };
    };
    // Swap transport/output generation are controlled; operation/proof persistence,
    // reclaim handler, locks and state transitions are real Coco services.
    internals.walletService.getWalletWithActiveKeysetId = async () => ({ wallet: {
      unit: "sat", checkProofsStates: async () => [{ state: "UNSPENT" }],
      getFeesForProofs: (): number => 0, receive,
    } });
    internals.proofService.createOutputsAndIncrementCounters = async () => ({ keep: [], send: [] });
    try {
      await repo.mintRepository.addNewMint({ mintUrl: MINT, name: "mint", mintInfo: {}, trusted: true, createdAt: 1, updatedAt: 1 } as never);
      await repo.proofRepository.saveProofs(MINT, [{ mintUrl: MINT, amount: 8, id: "keyset", secret: "shared", C: "C", state: "ready" }]);
      const prepared = await coco.ops.send.prepare({ mintUrl: MINT, amount: 8, target: { type: "offline" } });
      const { operation: pending } = await coco.ops.send.execute(prepared.id);
      await repo.sendOperationRepository.update({ ...pending, createdAt: NOW - OFFLINE_SWEEP_MIN_AGE_MS });
      const result = await sweepOfflineSends(coco, { confirmed: true }, NOW);
      expect(result).toMatchObject({ reclaimed: 1, failed: 0 });
      expect(receive).toHaveBeenCalledTimes(1);
      expect(receive.mock.calls[0]?.[0]).toMatchObject({ proofs: [{ secret: "shared" }] });
      expect((await repo.proofRepository.getProofBySecret(MINT, "shared"))?.state).toBe("spent");
      expect((await repo.proofRepository.getProofBySecret(MINT, "fresh"))?.state).toBe("ready");
      expect((await coco.ops.send.get(pending.id))?.state).toBe("rolled_back");
    } finally {
      await coco.dispose();
      database.close();
    }
  });
});
