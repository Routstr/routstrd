import { describe, expect, it, mock } from "bun:test";
import { getDecodedToken, getEncodedToken, Manager } from "@cashu/coco-core";
import type { CoreProof, SendMethodHandler } from "@cashu/coco-core";
import { SqliteRepositories } from "@cashu/coco-sqlite-bun";
import { Database } from "bun:sqlite";
import {
  createOfflineSendHandler,
  markOfflineSendSpent,
  registerOfflineSendHandler,
  selectClosestProofs,
  watchOnlineInflightProofs,
} from "./offline-send";

const MINT = "https://mint.example";

function proof(amount: number, secret = `secret-${amount}`): CoreProof {
  return {
    mintUrl: MINT,
    id: "keyset",
    amount,
    secret,
    C: `C-${secret}`,
    state: "ready",
  };
}

function amounts(selected: readonly CoreProof[] | null): number[] | null {
  return selected?.map((entry) => entry.amount) ?? null;
}

describe("selectClosestProofs", () => {
  it("finds an exact subset that largest-first selection would miss", () => {
    const selected = selectClosestProofs(
      [proof(6, "six-a"), proof(6, "six-b"), proof(5, "five-a"), proof(5, "five-b")],
      10,
    );
    expect(amounts(selected)).toEqual([5, 5]);
  });

  it("minimizes overpayment and uses fewer proofs for an equal total", () => {
    const selected = selectClosestProofs(
      [proof(512, "a"), proof(512, "b"), proof(1024, "c"), proof(2048, "d")],
      1020,
    );
    expect(amounts(selected)).toEqual([1024]);
  });

  it("returns null instead of under-sending", () => {
    expect(selectClosestProofs([proof(4), proof(6)], 11)).toBeNull();
  });

  it("is deterministic regardless of repository order", () => {
    const candidates = [proof(2, "b"), proof(2, "a"), proof(3, "c")];
    const first = selectClosestProofs(candidates, 4);
    const second = selectClosestProofs([...candidates].reverse(), 4);
    expect(first?.map((entry) => entry.secret)).toEqual(["a", "b"]);
    expect(second?.map((entry) => entry.secret)).toEqual(["a", "b"]);
  });

  it("selects from 500 binary proofs without a target-sized search", () => {
    const candidates = Array.from({ length: 500 }, (_, i) =>
      proof(2 ** ((i * 5) % 14), `proof-${String(i).padStart(3, "0")}`),
    );
    const start = performance.now();
    const selected = selectClosestProofs(candidates, 100_000)!;
    expect(selected.reduce((sum, entry) => sum + entry.amount, 0)).toBe(100_000);
    expect(new Set(selected.map((entry) => entry.secret)).size).toBe(selected.length);
    expect(performance.now() - start).toBeLessThan(1000);
  });

  it("handles binary denominations above the 32-bit range", () => {
    expect(amounts(selectClosestProofs([proof(2 ** 40), proof(2 ** 41)], 2 ** 40 + 1)))
      .toEqual([2 ** 41]);
  });

  it("matches exhaustive selection for bounded binary wallets", () => {
    let seed = 170;
    const random = () => (seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0);
    for (let trial = 0; trial < 100; trial++) {
      const candidates = Array.from({ length: 10 }, (_, i) =>
        proof(2 ** (random() % 6), `p${i}`),
      );
      const target = 1 + random() % 150;
      let best: CoreProof[] | null = null;
      let bestSum = Infinity;
      for (let mask = 0; mask < 1 << candidates.length; mask++) {
        const subset = candidates.filter((_, i) => mask & (1 << i));
        const sum = subset.reduce((total, entry) => total + entry.amount, 0);
        if (sum < target) continue;
        if (sum < bestSum || (sum === bestSum && (
          !best || subset.length < best.length ||
          (subset.length === best.length &&
            subset.map((entry) => entry.secret).join("\0") < best.map((entry) => entry.secret).join("\0"))
        ))) {
          best = subset;
          bestSum = sum;
        }
      }
      expect(selectClosestProofs(candidates, target)).toEqual(best);
    }
  });

  it("fails clearly when non-binary selection exceeds its work budget", () => {
    const candidates = Array.from({ length: 500 }, (_, i) =>
      proof(3 * 2 ** ((i * 5) % 14), `proof-${i}`),
    );
    expect(() => selectClosestProofs(candidates, 100_000)).toThrow("work limit");
  });

  it("rejects invalid amounts and duplicate secrets", () => {
    expect(() => selectClosestProofs([proof(1)], 1.5)).toThrow(
      "positive integer",
    );
    expect(() =>
      selectClosestProofs([proof(1, "same"), proof(2, "same")], 2),
    ).toThrow("duplicate proof secret");
  });
});

describe("offline send handler", () => {
  function setup() {
    const available = [proof(512, "a"), proof(512, "b"), proof(1024, "c")];
    const proofRepository = {
      getAvailableProofs: mock(async () => available),
      setProofState: mock(async () => {}),
    };
    const proofService = {
      reserveProofs: mock(async () => ({ amount: 1024 })),
      releaseProofs: mock(async () => {}),
      restoreProofsToReady: mock(async () => {}),
      setProofState: mock(async () => {}),
    };
    const defaultHandler: SendMethodHandler<"default"> = {
      prepare: mock(async () => { throw new Error("unused"); }),
      execute: mock(async () => { throw new Error("unused"); }),
      rollback: mock(async () => {}),
      recoverExecuting: mock(async () => { throw new Error("unused"); }),
    };
    const handler = createOfflineSendHandler(defaultHandler);
    return { available, proofRepository, proofService, defaultHandler, handler };
  }

  it("reserves the closest set and returns a no-swap preparation", async () => {
    const { proofRepository, proofService, handler } = setup();
    const prepared = await handler.prepare({
      operation: {
        id: "op-offline",
        mintUrl: MINT,
        amount: 1020,
        method: "offline",
        methodData: {},
        state: "init",
        createdAt: 1,
        updatedAt: 1,
      },
      proofRepository,
      proofService,
    } as never);

    expect(proofService.reserveProofs).toHaveBeenCalledWith(
      MINT,
      ["c"],
      "op-offline",
    );
    expect(prepared).toMatchObject({
      amount: 1020,
      inputAmount: 1024,
      inputProofSecrets: ["c"],
      needsSwap: false,
      fee: 0,
      methodData: { requestedAmount: 1020 },
    });
  });

  it("marks proofs inflight without emitting the watcher event or swapping", async () => {
    const { available, proofRepository, proofService, handler } = setup();
    const reserved = available.map((entry) => ({
      ...entry,
      usedByOperationId: "op-offline",
    }));
    const wallet = { unit: "sat", send: mock(async () => { throw new Error("swap"); }) };
    const result = await handler.execute({
      operation: {
        id: "op-offline",
        mintUrl: MINT,
        amount: 1020,
        method: "offline",
        methodData: { requestedAmount: 1020 },
        state: "executing",
        createdAt: 1,
        updatedAt: 1,
        needsSwap: false,
        fee: 0,
        inputAmount: 1024,
        inputProofSecrets: ["c"],
      },
      wallet,
      reservedProofs: reserved,
      proofRepository,
      proofService,
    } as never);

    expect(proofRepository.setProofState).toHaveBeenCalledWith(
      MINT,
      ["c"],
      "inflight",
    );
    expect(proofService.setProofState).not.toHaveBeenCalled();
    expect(wallet.send).not.toHaveBeenCalled();
    if (result.status !== "PENDING") throw new Error("expected pending result");
    expect(result.token?.proofs.map((entry) => entry.amount)).toEqual([1024]);
    expect(result.pending.state).toBe("pending");
  });

  it("keeps pending recovery local and restores interrupted executions", async () => {
    const { proofService, handler } = setup();
    expect(await handler.checkPending?.({} as never)).toBe("stay_pending");

    const result = await handler.recoverExecuting({
      operation: {
        id: "op-offline",
        mintUrl: MINT,
        amount: 1020,
        method: "offline",
        methodData: {},
        state: "executing",
        createdAt: 1,
        updatedAt: 1,
        needsSwap: false,
        fee: 0,
        inputAmount: 1024,
        inputProofSecrets: ["c"],
      },
      proofService,
    } as never);

    expect(proofService.restoreProofsToReady).toHaveBeenCalledWith(MINT, ["c"]);
    expect(result.status).toBe("FAILED");
  });

  it("releases prepared cancellations but delegates pending reclaim to Coco", async () => {
    const { proofService, defaultHandler, handler } = setup();
    const base = {
      id: "op-offline",
      mintUrl: MINT,
      amount: 1020,
      method: "offline",
      methodData: {},
      createdAt: 1,
      updatedAt: 1,
      needsSwap: false,
      fee: 0,
      inputAmount: 1024,
      inputProofSecrets: ["c"],
    };
    await handler.rollback?.({
      operation: { ...base, state: "prepared" },
      proofService,
    } as never);
    expect(proofService.releaseProofs).toHaveBeenCalledWith(MINT, ["c"]);
    expect(defaultHandler.rollback).not.toHaveBeenCalled();

    await handler.rollback?.({
      operation: { ...base, state: "pending" },
      proofService,
    } as never);
    expect(defaultHandler.rollback).toHaveBeenCalledTimes(1);
  });
});

describe("markOfflineSendSpent", () => {
  function operation(state: string, method = "offline") {
    return {
      id: "op-offline",
      mintUrl: MINT,
      amount: 1020,
      method,
      methodData: {},
      state,
      createdAt: 1,
      updatedAt: 1,
      needsSwap: false,
      fee: 0,
      inputAmount: 1024,
      inputProofSecrets: ["a", "b"],
    };
  }

  it("marks the operation's proofs spent and finalizes without a wallet call", async () => {
    const setProofState = mock(async () => {});
    const finalize = mock(async () => {});
    const coco = {
      proofService: { setProofState },
      ops: { send: { get: async () => operation("pending"), finalize } },
    } as unknown as Manager;

    await expect(markOfflineSendSpent(coco, "op-offline")).resolves.toEqual({
      operationId: "op-offline",
      state: "finalized",
      markedSpent: 2,
      actualAmount: 1024,
    });
    expect(setProofState).toHaveBeenCalledWith(MINT, ["a", "b"], "spent");
    expect(finalize).toHaveBeenCalledWith("op-offline");
  });

  it("is idempotent for finalized operations", async () => {
    const setProofState = mock(async () => {});
    const finalize = mock(async () => {});
    const coco = {
      proofService: { setProofState },
      ops: { send: { get: async () => operation("finalized"), finalize } },
    } as unknown as Manager;

    await expect(markOfflineSendSpent(coco, "op-offline")).resolves.toMatchObject({
      markedSpent: 0,
      state: "finalized",
    });
    expect(setProofState).not.toHaveBeenCalled();
    expect(finalize).not.toHaveBeenCalled();
  });

  it("refuses online operations and non-pending offline states", async () => {
    for (const candidate of [operation("pending", "default"), operation("prepared")]) {
      const coco = {
        ops: { send: { get: async () => candidate } },
      } as unknown as Manager;
      await expect(markOfflineSendSpent(coco, "op-offline")).rejects.toThrow();
    }
  });
});

describe("offline send with a real Coco Manager", () => {
  it("sends, refreshes and recovers locally with stale metadata and an unavailable mint", async () => {
    const database = new Database(":memory:");
    const repo = new SqliteRepositories({ database });
    await repo.init();
    const coco = new Manager(repo, async () => new Uint8Array(64));
    registerOfflineSendHandler(coco);
    let mintRequests = 0;
    const mint = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      fetch() {
        mintRequests++;
        return new Response("mint unavailable", { status: 503 });
      },
    });
    const mintUrl = `http://127.0.0.1:${mint.port}`;

    try {
      await repo.mintRepository.addNewMint({
        mintUrl,
        name: "Offline test mint",
        mintInfo: {},
        trusted: true,
        createdAt: 1,
        updatedAt: Math.floor(Date.now() / 1000) - 3600,
      } as never);
      await repo.proofRepository.saveProofs(mintUrl, [
        { ...proof(512, "a"), mintUrl },
        { ...proof(512, "b"), mintUrl },
        { ...proof(1024, "c"), mintUrl },
      ]);

      const prepared = await coco.ops.send.prepare({
        mintUrl,
        amount: 1020,
        target: { type: "offline" },
      });
      const { operation, token } = await coco.ops.send.execute(prepared.id);
      expect(getDecodedToken(getEncodedToken(token))).toMatchObject({
        mint: mintUrl, unit: "sat", proofs: [{ amount: 1024, secret: "c" }],
      });
      expect(operation).toMatchObject({
        method: "offline",
        state: "pending",
        inputAmount: 1024,
        inputProofSecrets: ["c"],
      });
      expect(mintRequests).toBe(0);
      expect((await repo.proofRepository.getProofBySecret(mintUrl, "c"))?.state).toBe(
        "inflight",
      );

      await coco.ops.send.refresh(operation.id);
      expect(mintRequests).toBe(0);
      expect((await coco.ops.send.get(operation.id))?.state).toBe("pending");

      await coco.ops.send.recovery.run();
      expect((await coco.ops.send.get(operation.id))?.state).toBe("pending");
      expect(mintRequests).toBe(0);

      // Prepared cancellation also requires no wallet or mint keys.
      const cancelled = await coco.ops.send.prepare({
        mintUrl, amount: 512, target: { type: "offline" },
      });
      await coco.ops.send.cancel(cancelled.id);
      expect((await repo.proofRepository.getProofBySecret(mintUrl, "a"))?.state).toBe("ready");
      expect(mintRequests).toBe(0);

      // Simulate a crash after persisting executing, before returning a token.
      const interrupted = await coco.ops.send.prepare({
        mintUrl, amount: 512, target: { type: "offline" },
      });
      await repo.sendOperationRepository.update({ ...interrupted, state: "executing" });
      await coco.ops.send.recovery.run();
      expect((await coco.ops.send.get(interrupted.id))?.state).toBe("rolled_back");
      expect((await repo.proofRepository.getProofBySecret(mintUrl, "a"))?.state).toBe("ready");
      expect(mintRequests).toBe(0);

      await markOfflineSendSpent(coco, operation.id);
      expect((await repo.proofRepository.getProofBySecret(mintUrl, "c"))?.state).toBe(
        "spent",
      );
      expect((await coco.ops.send.get(operation.id))?.state).toBe("finalized");
      expect(mintRequests).toBe(0);

      // Control: ordinary sends must still load a wallet and fail at this mint.
      await expect(coco.ops.send.prepare({ mintUrl, amount: 512 })).rejects.toThrow();
      expect(mintRequests).toBeGreaterThan(0);
    } finally {
      await coco.dispose();
      mint.stop(true);
      database.close();
    }
  });
});

describe("watchOnlineInflightProofs", () => {
  it("does not subscribe offline proofs after a restart", async () => {
    const offline = { ...proof(1024, "offline"), state: "inflight" as const, usedByOperationId: "offline-op" };
    const online = { ...proof(64, "online"), state: "inflight" as const, usedByOperationId: "default-op" };
    const watchProof = mock(async () => {});
    const coco = {
      proofStateWatcher: { watchProof },
      ops: {
        send: {
          get: async (id: string) => ({ id, method: id === "offline-op" ? "offline" : "default" }),
        },
      },
    } as unknown as Manager;

    await watchOnlineInflightProofs(coco, {
      proofRepository: { getInflightProofs: async () => [offline, online] },
    });

    expect(watchProof).toHaveBeenCalledTimes(1);
    expect(watchProof).toHaveBeenCalledWith(MINT, ["online"]);
  });
});
