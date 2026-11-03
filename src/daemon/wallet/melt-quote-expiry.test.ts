import { describe, expect, it } from "bun:test";
import { hashToCurve } from "@cashu/cashu-ts";
import { Manager, MemoryRepositories, MintOperationError, NetworkError, type CoreProof, type MeltOperation } from "@cashu/coco-core";
import {
  installMeltQuoteExpiryHandler,
  isMeltQuoteExpiredError,
} from "./melt-quote-expiry";
import { createMeltSweepState, settleMeltOperations } from "./melt-sweep";

function fakeManager(registry: Record<string, unknown>): Manager {
  return {
    meltOperationService: {
      handlerProvider: {
        getAll: () => registry,
      },
    },
  } as unknown as Manager;
}

const mintUrl = "https://mint.example";
const inputSecrets = ["input-a", "input-b"];
const yFor = (secret: string) => hashToCurve(new TextEncoder().encode(secret)).toHex(true);
const unspent = (secrets = inputSecrets) => secrets.map((secret) => ({ Y: yFor(secret), state: "UNSPENT" }));

function expiryContext(checkProofStates: () => Promise<unknown> = async () => unspent()) {
  return {
    operation: { id: "op", mintUrl, needsSwap: false, inputProofSecrets: inputSecrets },
    mintAdapter: { checkProofStates },
  };
}

function expiredHandler() {
  return {
    getMeltInputSecrets: (operation: { inputProofSecrets: string[] }) => operation.inputProofSecrets,
    checkPending: async (_ctx: unknown): Promise<unknown> => {
      throw new MintOperationError(20007, "quote expired");
    },
  };
}

describe("isMeltQuoteExpiredError", () => {
  it("recognizes coco's MintOperationError with code 20007", () => {
    expect(isMeltQuoteExpiredError(new MintOperationError(20007, "quote expired"))).toBe(true);
  });

  it("recognizes a structurally identical error across the package boundary", () => {
    const error = Object.assign(new Error("quote expired"), { code: 20007 });
    expect(isMeltQuoteExpiredError(error)).toBe(true);
  });

  it("ignores other melt error codes", () => {
    expect(isMeltQuoteExpiredError(new MintOperationError(20002, "quote not paid"))).toBe(false);
  });

  it("ignores unrelated errors and non-objects", () => {
    expect(isMeltQuoteExpiredError(new Error("boom"))).toBe(false);
    expect(isMeltQuoteExpiredError("20007")).toBe(false);
    expect(isMeltQuoteExpiredError(null)).toBe(false);
  });
});

describe("installMeltQuoteExpiryHandler", () => {
  it("maps a 20007 from checkPending to a rollback decision", async () => {
    const calls: unknown[] = [];
    const registry: Record<string, unknown> = {
      bolt11: {
        getMeltInputSecrets: (operation: { inputProofSecrets: string[] }) => operation.inputProofSecrets,
        checkPending: async (ctx: unknown) => {
          calls.push(ctx);
          throw new MintOperationError(20007, "quote expired");
        },
      },
    };
    const ok = installMeltQuoteExpiryHandler(fakeManager(registry));
    expect(ok).toBe(true);

    const decision = await (
      registry.bolt11 as { checkPending: (ctx: unknown) => Promise<unknown> }
    ).checkPending(expiryContext());
    expect(decision).toBe("rollback");
    expect(calls).toHaveLength(1);
  });

  for (const state of ["PENDING", "SPENT"]) {
    it(`keeps an expired quote pending when an input is ${state}`, async () => {
      const handler = expiredHandler();
      installMeltQuoteExpiryHandler(fakeManager({ bolt11: handler }));
      expect(await handler.checkPending(expiryContext(async () => [unspent()[0], { Y: yFor(inputSecrets[1]!), state }]))).toBe("stay_pending");
    });
  }

  for (const [name, states] of Object.entries({
    empty: [],
    missing: unspent().slice(0, 1),
    duplicate: [unspent()[0], unspent()[0]],
    mismatched: unspent(["other-a", "other-b"]),
    extra: unspent([...inputSecrets, "extra"]),
    malformed: [{ state: "UNSPENT" }, null],
  })) {
    it(`keeps reservations on ${name} proof-state results`, async () => {
      const handler = expiredHandler();
      installMeltQuoteExpiryHandler(fakeManager({ bolt11: handler }));
      expect(await handler.checkPending(expiryContext(async () => states))).toBe("stay_pending");
    });
  }

  it("propagates proof lookup failures so the sweep can back off the mint", async () => {
    const handler = expiredHandler();
    installMeltQuoteExpiryHandler(fakeManager({ bolt11: handler }));
    const error = new NetworkError("offline");
    await expect(handler.checkPending(expiryContext(async () => { throw error; }))).rejects.toBe(error);
  });

  it("accepts complete matching results in any order", async () => {
    const handler = expiredHandler();
    installMeltQuoteExpiryHandler(fakeManager({ bolt11: handler }));
    expect(await handler.checkPending(expiryContext(async () => unspent().reverse()))).toBe("rollback");
  });

  for (const secrets of [[], ["duplicate", "duplicate"]]) {
    it(`does not query empty or duplicate input secrets (${secrets.length})`, async () => {
      const handler = expiredHandler();
      installMeltQuoteExpiryHandler(fakeManager({ bolt11: handler }));
      let queried = false;
      const ctx = expiryContext(async () => { queried = true; return unspent(secrets); });
      ctx.operation.inputProofSecrets = secrets;
      expect(await handler.checkPending(ctx)).toBe("stay_pending");
      expect(queried).toBe(false);
    });
  }

  it("keeps pending if coco's input-secret helper is unavailable", async () => {
    const handler = { checkPending: expiredHandler().checkPending };
    installMeltQuoteExpiryHandler(fakeManager({ bolt11: handler }));
    expect(await handler.checkPending(expiryContext())).toBe("stay_pending");
  });

  it("passes through normal decisions and unrelated errors", async () => {
    const registry: Record<string, unknown> = {
      bolt11: {
        checkPending: async (ctx: { state?: string }) => {
          if (ctx.state === "boom") throw new Error("different failure");
          return "stay_pending";
        },
      },
    };
    installMeltQuoteExpiryHandler(fakeManager(registry));
    const handler = registry.bolt11 as {
      checkPending: (ctx: unknown) => Promise<unknown>;
    };
    expect(await handler.checkPending({})).toBe("stay_pending");
    await expect(handler.checkPending({ state: "boom" })).rejects.toThrow(
      "different failure",
    );
  });

  it("wraps every registered melt method", async () => {
    const registry: Record<string, unknown> = {
      bolt11: { checkPending: async () => "stay_pending" },
      bolt12: { checkPending: async () => "finalize" },
    };
    expect(installMeltQuoteExpiryHandler(fakeManager(registry))).toBe(true);
    // Both methods keep their own original decision.
    expect(
      await (registry.bolt11 as { checkPending: () => Promise<unknown> }).checkPending(),
    ).toBe("stay_pending");
    expect(
      await (registry.bolt12 as { checkPending: () => Promise<unknown> }).checkPending(),
    ).toBe("finalize");
  });

  it("skips handlers without checkPending and reports partial install", () => {
    const registry: Record<string, unknown> = {
      bolt11: { execute: async () => ({}) },
      bolt12: { checkPending: async () => "stay_pending" },
    };
    expect(installMeltQuoteExpiryHandler(fakeManager(registry))).toBe(true);
  });

  it("returns false when the registry is unavailable", () => {
    expect(installMeltQuoteExpiryHandler({} as Manager)).toBe(false);
    expect(
      installMeltQuoteExpiryHandler({
        meltOperationService: { handlerProvider: {} },
      } as unknown as Manager),
    ).toBe(false);
  });

  it("returns false when no handler exposes checkPending", () => {
    expect(
      installMeltQuoteExpiryHandler(
        fakeManager({ bolt11: { execute: async () => ({}) } }),
      ),
    ).toBe(false);
  });
});

/** Exercise Coco's real checkPending -> rollback -> proof restoration path.
 * Only wallet acquisition and mint responses are stubbed; no network is used.
 */
async function pendingMeltFixture(needsSwap: boolean, remoteStates: (Ys: string[], call: number) => unknown) {
  const repo = new MemoryRepositories();
  const coco = new Manager(repo, async () => new Uint8Array(64));
  const swapSecrets = ["swap-a", "swap-b"];
  const operation = {
    id: "op", mintUrl, method: "bolt11", methodData: { invoice: "invoice" },
    state: "pending", createdAt: 0, updatedAt: 0, quoteId: "expired-quote", unit: "sat",
    needsSwap, amount: 2, fee_reserve: 0, swap_fee: 0, inputAmount: 2,
    inputProofSecrets: inputSecrets,
    changeOutputData: { keep: [], send: [] },
    swapOutputData: needsSwap ? {
      keep: [],
      send: swapSecrets.map((secret) => ({
        secret: Buffer.from(secret).toString("hex"), blindingFactor: "01",
        blindedMessage: { amount: 1, id: "00", B_: yFor(secret) },
      })),
    } : undefined,
  } satisfies MeltOperation;
  await repo.meltOperationRepository.create(operation);
  const proof = (secret: string, state: CoreProof["state"]): CoreProof => ({
    secret, state, mintUrl, id: "00", C: yFor(secret), amount: 1, usedByOperationId: operation.id,
  });
  await repo.proofRepository.saveProofs(mintUrl, [
    ...inputSecrets.map((secret) => proof(secret, needsSwap ? "spent" : "inflight")),
    ...(needsSwap ? swapSecrets.map((secret) => proof(secret, "inflight")) : []),
  ]);
  const internal = coco as unknown as {
    walletService: { getWalletWithActiveKeysetId: () => Promise<unknown> };
    mintAdapter: {
      checkMeltQuoteState: () => Promise<unknown>;
      checkProofStates: (mintUrl: string, Ys: string[]) => Promise<unknown>;
    };
  };
  internal.walletService.getWalletWithActiveKeysetId = async () => ({ wallet: {} });
  internal.mintAdapter.checkMeltQuoteState = async () => { throw new MintOperationError(20007, "quote expired"); };
  const queries: string[][] = [];
  internal.mintAdapter.checkProofStates = async (url, Ys) => {
    expect(url).toBe(mintUrl);
    queries.push(Ys);
    return remoteStates(Ys, queries.length);
  };
  installMeltQuoteExpiryHandler(coco);
  return { coco, repo, queries, actualSecrets: needsSwap ? swapSecrets : inputSecrets };
}

describe("expired quote recovery with Coco 1.0.1", () => {
  for (const needsSwap of [false, true]) {
    it(`restores only verified melt inputs (needsSwap=${needsSwap})`, async () => {
      const { coco, repo, queries, actualSecrets } = await pendingMeltFixture(needsSwap, (Ys) =>
        Ys.map((Y) => ({ Y, state: "UNSPENT" })).reverse());
      try {
        expect((await coco.ops.melt.refresh("op")).state).toBe("rolled_back");
        expect(queries).toEqual([actualSecrets.map(yFor), actualSecrets.map(yFor)]);
        for (const secret of actualSecrets) {
          const restored = await repo.proofRepository.getProofBySecret(mintUrl, secret);
          expect(restored?.state).toBe("ready");
          expect(restored?.usedByOperationId).toBeUndefined();
        }
        if (needsSwap) {
          for (const secret of inputSecrets) {
            expect((await repo.proofRepository.getProofBySecret(mintUrl, secret))?.state).toBe("spent");
          }
        }
      } finally { await coco.dispose(); }
    });
  }

  for (const remoteState of ["PENDING", "SPENT", "MISSING", "FAILED", "DUPLICATE"]) {
    it(`does not release reservations for ${remoteState} input states`, async () => {
      const { coco, repo, actualSecrets } = await pendingMeltFixture(true, (Ys) => {
        if (remoteState === "FAILED") throw new Error("mint offline");
        if (remoteState === "MISSING") return [];
        if (remoteState === "DUPLICATE") return Ys.map(() => ({ Y: Ys[0], state: "UNSPENT" }));
        return Ys.map((Y) => ({ Y, state: remoteState }));
      });
      try {
        if (remoteState === "FAILED") {
          await expect(coco.ops.melt.refresh("op")).rejects.toThrow("mint offline");
          await expect(coco.ops.melt.reclaim("op")).rejects.toThrow("mint offline");
        } else {
          expect((await coco.ops.melt.refresh("op")).state).toBe("pending");
          // reclaim repeats the check and must not bypass the safety gate.
          await expect(coco.ops.melt.reclaim("op")).rejects.toThrow("not UNPAID");
        }
        expect((await coco.ops.melt.get("op"))?.state).toBe("pending");
        for (const secret of actualSecrets) {
          const reserved = await repo.proofRepository.getProofBySecret(mintUrl, secret);
          expect(reserved?.state).toBe("inflight");
          expect(reserved?.usedByOperationId).toBe("op");
        }
      } finally { await coco.dispose(); }
    });
  }

  it("backs off NUT-07 network failures and still checks a healthy mint", async () => {
    const { coco, repo, queries, actualSecrets } = await pendingMeltFixture(false, async () => {
      await new Promise((resolve) => setTimeout(resolve, 5));
      throw new NetworkError("NUT-07 offline");
    });
    try {
      const operation = await coco.ops.melt.get("op");
      if (!operation || operation.state !== "pending") throw new Error("Missing fixture operation");
      await repo.meltOperationRepository.create({ ...operation, id: "same-mint" });
      await repo.meltOperationRepository.create({ ...operation, id: "healthy", mintUrl: "https://healthy.example" });
      const refreshed: string[] = [];
      const state = createMeltSweepState(new Map());
      const source = { ops: { melt: {
        listInFlight: () => coco.ops.melt.listInFlight(),
        diagnostics: coco.ops.melt.diagnostics,
        refresh: async (id: string) => {
          refreshed.push(id);
          if (id === "healthy") return { ...operation, id, mintUrl: "https://healthy.example" };
          return coco.ops.melt.refresh(id);
        },
      } } };
      const result = await settleMeltOperations(source, { state, opTimeoutMs: 500, deadlineMs: 2_000 });
      expect(refreshed).toEqual(["op", "healthy"]);
      expect(result.failed).toBe(1);
      expect(result.stillInFlight).toBe(1);
      expect(result.skippedMints.has(mintUrl)).toBe(true);
      expect(state.mintBackoff.get(mintUrl)?.failures).toBe(1);
      expect(queries).toHaveLength(1);
      await settleMeltOperations(source, { state });
      expect(queries).toHaveLength(1);
      expect(refreshed).toEqual(["op", "healthy", "healthy"]);
      expect((await coco.ops.melt.get("op"))?.state).toBe("pending");
      for (const secret of actualSecrets) {
        const proof = await repo.proofRepository.getProofBySecret(mintUrl, secret);
        expect(proof?.state).toBe("inflight");
        expect(proof?.usedByOperationId).toBe("op");
      }
    } finally { await coco.dispose(); }
  });

  it("keeps swap inputs reserved if swap output data is missing", async () => {
    const { coco, repo, queries } = await pendingMeltFixture(true, (Ys) =>
      Ys.map((Y) => ({ Y, state: "UNSPENT" })));
    try {
      const operation = await coco.ops.melt.get("op");
      if (!operation || operation.state !== "pending") throw new Error("Missing fixture operation");
      await repo.meltOperationRepository.update({ ...operation, swapOutputData: undefined });
      expect((await coco.ops.melt.refresh("op")).state).toBe("pending");
      expect(queries).toHaveLength(0);
      expect(await repo.proofRepository.getReadyProofs(mintUrl)).toHaveLength(0);
    } finally { await coco.dispose(); }
  });

  it("applies the same safety check during startup recovery", async () => {
    const { coco, repo } = await pendingMeltFixture(false, (Ys) =>
      Ys.map((Y) => ({ Y, state: "PENDING" })));
    try {
      await coco.ops.melt.recovery.run();
      expect((await coco.ops.melt.get("op"))?.state).toBe("pending");
      expect(await repo.proofRepository.getReadyProofs(mintUrl)).toHaveLength(0);
      for (const secret of inputSecrets) {
        const proof = await repo.proofRepository.getProofBySecret(mintUrl, secret);
        expect(proof?.state).toBe("inflight");
        expect(proof?.usedByOperationId).toBe("op");
      }
    } finally { await coco.dispose(); }
  });

  it("rechecks proof states under the rollback lock before restoring anything", async () => {
    const { coco, repo, queries, actualSecrets } = await pendingMeltFixture(false, (Ys, call) =>
      Ys.map((Y) => ({ Y, state: call === 1 ? "UNSPENT" : "PENDING" })));
    try {
      await expect(coco.ops.melt.refresh("op")).rejects.toThrow("not UNPAID");
      expect(queries).toHaveLength(2);
      expect((await coco.ops.melt.get("op"))?.state).toBe("pending");
      for (const secret of actualSecrets) {
        expect((await repo.proofRepository.getProofBySecret(mintUrl, secret))?.state).toBe("inflight");
      }
    } finally { await coco.dispose(); }
  });
});
