import { describe, expect, it, mock } from "bun:test";
import { Manager } from "@cashu/coco-core";
import { SqliteRepositories } from "@cashu/coco-sqlite-bun";
import { Database } from "bun:sqlite";
import { OFFLINE_SWEEP_MIN_AGE_MS, sweepOfflineSends } from "./offline-sweep";
import { registerOfflineSendHandler } from "./offline-send";
import { createRecoveryDisposer, drainRecoveryWork, trackRecovery } from "./recovery-work";

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
  const local = new Map(ops.flatMap((op) => op.token.proofs.map((proof) => [proof.secret, { ...proof, state: "inflight", usedByOperationId: op.id } ] as [string, { secret: string; state: string; usedByOperationId: string }])));
  const getProofs = mock(async (_mint: string, secrets: string[]) => secrets.flatMap((secret) => local.has(secret) ? [local.get(secret)!] : []));
  const reclaim = mock(async (id: string) => {
    stored.get(id)!.state = "rolled_back";
    for (const secret of stored.get(id)!.inputProofSecrets) local.get(secret)!.state = "spent";
  });
  const coco = {
    walletService: { getWalletWithActiveKeysetId: getWallet },
    proofService: { setProofState: mark },
    proofRepository: { getProofsBySecrets: getProofs },
    ops: { send: { listInFlight: async () => ops, get: async (id: string) => stored.get(id), finalize, reclaim } },
  } as unknown as Manager;
  return { coco, check, getWallet, mark, finalize, reclaim, stored, local, getProofs };
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
    expect(mark.mock.invocationCallOrder[0]!).toBeLessThan(finalize.mock.invocationCallOrder[0]!);
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

  it("reports aged rolling_back offline sends without mint calls in preview and apply", async () => {
    for (const dryRun of [true, false]) {
      const t = setup([operation("stuck", { state: "rolling_back" }), operation("young", { state: "rolling_back", createdAt: NOW }), operation("online", { state: "rolling_back", method: "default" })]);
      const result = await sweepOfflineSends(t.coco, { dryRun, confirmed: true }, NOW);
      expect(result).toMatchObject({ stuck: 1, candidates: 0, skipped: 2, failed: 0 });
      expect(result.operations).toMatchObject([{ operationId: "stuck", outcome: "stuck", error: expect.stringContaining("seed restore") }]);
      expect(t.getWallet).not.toHaveBeenCalled();
      expect(t.reclaim).not.toHaveBeenCalled();
      expect(t.mark).not.toHaveBeenCalled();
    }
  });

  it("bounds metadata/checkstate waits, continues, and ignores late read results", async () => {
    for (const stage of ["metadata", "check"]) {
      const t = setup([operation("slow"), operation("good")]);
      let resolve!: (value: any) => void;
      const pending = new Promise<any>((done) => { resolve = done; });
      if (stage === "metadata") t.getWallet.mockImplementationOnce(() => pending);
      else t.check.mockImplementationOnce(() => pending);
      const result = await sweepOfflineSends(t.coco, { confirmed: true }, NOW, { readTimeoutMs: 5 });
      expect(result).toMatchObject({ failed: 1, reclaimed: 1 });
      expect(result.operations[0]?.error).toContain("timed out");
      resolve(stage === "metadata" ? { wallet: { checkProofsStates: t.check } } : [{ state: "SPENT" }]);
      await Bun.sleep(0);
      expect(t.reclaim.mock.calls).toEqual([["good"]]);
      expect(t.mark).not.toHaveBeenCalled();
    }
  });

  it("retains timed-out metadata work until shutdown can safely close storage", async () => {
    const t = setup();
    const outstanding = new Map<string, Promise<unknown>>();
    const events: string[] = [];
    let resolve!: (value: any) => void;
    t.getWallet.mockImplementationOnce(() => new Promise<any>((done) => { resolve = done; }).then((value) => {
      events.push("metadata persisted");
      return value;
    }));
    expect(await sweepOfflineSends(t.coco, { confirmed: true }, NOW, {
      readTimeoutMs: 5, trackRead: (work) => { trackRecovery(outstanding, "read", work); },
    })).toMatchObject({ failed: 1 });
    const dispose = createRecoveryDisposer(() => {}, () => drainRecoveryWork(outstanding), async () => { events.push("close"); }, 5);
    await expect(dispose()).rejects.toThrow("Timed out");
    expect(events).toEqual([]);
    resolve({ wallet: { checkProofsStates: t.check } });
    await dispose();
    expect(events).toEqual(["metadata persisted", "close"]);
    expect(t.check).not.toHaveBeenCalled();
    expect(t.reclaim).not.toHaveBeenCalled();
  });

  it("does not time out an ongoing swap or start another after shutdown", async () => {
    const t = setup([operation("old"), operation("next")]);
    let resolve!: () => void;
    const pending = new Promise<void>((done) => { resolve = done; });
    let stopped = false;
    t.reclaim.mockImplementationOnce(async () => {
      await pending;
      t.stored.get("old")!.state = "rolled_back";
      t.local.get("old")!.state = "spent";
    });
    const running = sweepOfflineSends(t.coco, { confirmed: true }, NOW, { readTimeoutMs: 5, shouldStop: () => stopped });
    await Bun.sleep(15);
    expect(t.reclaim).toHaveBeenCalledTimes(1);
    stopped = true;
    resolve();
    expect(await running).toMatchObject({ reclaimed: 1, failed: 1 });
    expect(t.reclaim.mock.calls).toEqual([["old"]]);
  });

  it("refuses false successful rollback when inputs were not spent", async () => {
    const t = setup();
    t.reclaim.mockImplementation(async (id) => { t.stored.get(id)!.state = "rolled_back"; });
    const result = await sweepOfflineSends(t.coco, { confirmed: true }, NOW);
    expect(result).toMatchObject({ failed: 1, reclaimed: 0 });
    expect(result.operations[0]?.error).toContain("inputs spent");
  });

  for (const scenario of ["success", "swap-failure", "ready", "wrong-owner", "missing", "fee-exhausted", "late-noop"] as const) {
    it(`real Manager reclaim: ${scenario}`, async () => {
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
        if (scenario === "swap-failure") receive.mockRejectedValueOnce(new Error("Mint 5xx during swap"));
        if (scenario === "ready") await repo.proofRepository.setProofState(MINT, ["shared"], "ready");
        if (scenario === "wrong-owner") await repo.proofRepository.releaseProofs(MINT, ["shared"]);
        if (scenario === "missing") await database.run("DELETE FROM coco_cashu_proofs WHERE secret = ?", ["shared"]);
        if (scenario === "late-noop") {
          const getWallet = internals.walletService.getWalletWithActiveKeysetId;
          let calls = 0;
          internals.walletService.getWalletWithActiveKeysetId = async (mintUrl) => {
            if (++calls === 2) await repo.proofRepository.setProofState(MINT, ["shared"], "ready");
            return getWallet(mintUrl);
          };
        }
        if (scenario === "fee-exhausted") internals.walletService.getWalletWithActiveKeysetId = async () => ({ wallet: {
          unit: "sat", checkProofsStates: async () => [{ state: "UNSPENT" }], getFeesForProofs: () => 8, receive,
        } });
        const result = await sweepOfflineSends(coco, { confirmed: true }, NOW);
        if (scenario !== "success") {
          expect(result).toMatchObject({ reclaimed: 0, failed: 1 });
          if (scenario === "swap-failure") {
            expect(receive).toHaveBeenCalledTimes(1);
            expect(result.operations[0]?.error).toContain("seed restore");
            expect((await coco.ops.send.get(pending.id))?.state).toBe("rolling_back");
            for (const dryRun of [true, false]) {
              const next = await sweepOfflineSends(coco, { confirmed: true, dryRun }, NOW);
              expect(next).toMatchObject({ stuck: 1, candidates: 0, skipped: 0 });
              expect(next.operations[0]?.outcome).toBe("stuck");
            }
            expect(receive).toHaveBeenCalledTimes(1);
          } else if (scenario === "late-noop") {
            expect(receive).not.toHaveBeenCalled();
            expect((await coco.ops.send.get(pending.id))?.state).toBe("rolled_back");
            expect(result.operations[0]?.error).toContain("inputs spent");
          } else {
            expect(receive).not.toHaveBeenCalled();
            expect((await coco.ops.send.get(pending.id))?.state).toBe("pending");
          }
          return;
        }
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
  }
});
