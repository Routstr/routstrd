import { afterEach, describe, expect, it, spyOn } from "bun:test";
import {
  createBlindSignature,
  createNewMintKeys,
  hashToCurve,
  OutputData,
  pointFromHex,
} from "@cashu/cashu-ts";
import { Manager, MemoryRepositories, MintOperationError, NetworkError, type CoreProof, type MeltOperation } from "@cashu/coco-core";
import { logger } from "../../utils/logger";
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

function expiryContext(
  remoteStates: (Ys: string[], call: number) => Promise<unknown> = async () => unspent(),
) {
  let calls = 0;
  return {
    operation: { id: "op", mintUrl, needsSwap: false, inputProofSecrets: inputSecrets },
    mintAdapter: {
      checkProofStates: async (_url: string, Ys: string[]) =>
        remoteStates(Ys, ++calls),
    },
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

  const allSpent = (Ys: string[]) => Ys.map((Y) => ({ Y, state: "SPENT" }));

  function finalizableHandler() {
    const handler = {
      getMeltInputSecrets: (operation: { inputProofSecrets: string[] }) =>
        operation.inputProofSecrets,
      getMeltInputAmount: (operation: { inputAmount?: number }) =>
        operation.inputAmount ?? 2,
      calculateSettlementAmounts: (
        meltInputAmount: number,
        meltAmount: number,
        change?: Array<{ amount: number }>,
      ) => {
        const changeAmount = change?.reduce((sum, proof) => sum + proof.amount, 0) ?? 0;
        return { changeAmount, effectiveFee: meltInputAmount - meltAmount - changeAmount };
      },
      finalizeOperation: async (_ctx: unknown, _change?: unknown[]) => {},
      checkPending: async (_ctx: unknown): Promise<unknown> => {
        throw new MintOperationError(20007, "quote expired");
      },
      finalize: async (_ctx: unknown): Promise<unknown> => {
        throw new MintOperationError(20007, "quote expired");
      },
    };
    return handler;
  }

  it("maps a 20007 from checkPending to a finalize decision when all inputs are SPENT", async () => {
    const handler = finalizableHandler();
    installMeltQuoteExpiryHandler(fakeManager({ bolt11: handler }));
    const ctx = expiryContext(async (Ys) => allSpent(Ys));
    (ctx.operation as { inputAmount?: number }).inputAmount = 2;
    expect(await handler.checkPending(ctx)).toBe("finalize");
  });

  it("finalizes through the wrapper when the underlying finalize also sees 20007", async () => {
    const handler = finalizableHandler();
    let finalized = 0;
    handler.finalizeOperation = async () => { finalized++; };
    installMeltQuoteExpiryHandler(fakeManager({ bolt11: handler }));
    const ctx = expiryContext(async (Ys) => allSpent(Ys));
    Object.assign(ctx.operation, { amount: 2, inputAmount: 2 });
    Object.assign(ctx, {
      proofService: { unblindAndSaveChangeProofs: async () => {} },
    });
    const result = await handler.finalize(ctx);
    expect(finalized).toBe(1);
    expect(result).toEqual({ changeAmount: 0, effectiveFee: 0, finalizedData: undefined });
  });

  it("refuses to finalize when inputs flip to PENDING under the lock", async () => {
    const handler = finalizableHandler();
    installMeltQuoteExpiryHandler(fakeManager({ bolt11: handler }));
    const ctx = expiryContext(async (Ys, call) =>
      Ys.map((Y) => ({ Y, state: call === 1 ? "SPENT" : "PENDING" })));
    Object.assign(ctx.operation, { amount: 2, inputAmount: 2 });
    expect(await handler.checkPending(ctx)).toBe("finalize");
    await expect(handler.finalize(ctx)).rejects.toThrow("expected all SPENT");
  });

  it("does not wrap finalize when coco's helpers are missing", async () => {
    const registry: Record<string, unknown> = {
      bolt11: {
        getMeltInputSecrets: (operation: { inputProofSecrets: string[] }) =>
          operation.inputProofSecrets,
        checkPending: async (_ctx: unknown): Promise<unknown> => {
          throw new MintOperationError(20007, "quote expired");
        },
        finalize: async (_ctx: unknown): Promise<unknown> => {
          throw new MintOperationError(20007, "quote expired");
        },
      },
    };
    installMeltQuoteExpiryHandler(fakeManager(registry));
    const handler = registry.bolt11 as {
      checkPending: (ctx: unknown) => Promise<unknown>;
      finalize: (ctx: unknown) => Promise<unknown>;
    };
    // Without finalize helpers, SPENT inputs must stay pending rather than
    // letting coco persist a finalized operation with no settlement data.
    expect(await handler.checkPending(expiryContext(async (Ys) => allSpent(Ys)))).toBe(
      "stay_pending",
    );
    await expect(handler.finalize(expiryContext())).rejects.toBeInstanceOf(MintOperationError);
  });

  it("passes non-20007 finalize errors through unchanged", async () => {
    const handler = finalizableHandler();
    const boom = new Error("mint exploded");
    handler.finalize = async () => { throw boom; };
    installMeltQuoteExpiryHandler(fakeManager({ bolt11: handler }));
    const ctx = expiryContext(async (Ys) => allSpent(Ys));
    Object.assign(ctx.operation, { amount: 2, inputAmount: 2 });
    await expect(handler.finalize(ctx)).rejects.toBe(boom);
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
/** Real mint keyset so restored change signatures can be unblinded. */
const mintKeys = (() => {
  const pair = createNewMintKeys(20, new Uint8Array(32).fill(9));
  const hex = (value: string | Uint8Array) =>
    typeof value === "string" ? value : Buffer.from(value).toString("hex");
  return {
    id: pair.keysetId,
    pubKeys: Object.fromEntries(
      Object.entries(pair.pubKeys).map(([amount, key]) => [
        amount,
        hex(key as string | Uint8Array),
      ]),
    ) as Record<string, string>,
    privKeys: Object.fromEntries(
      Object.entries(pair.privKeys).map(([amount, key]) => [
        amount,
        key as Uint8Array,
      ]),
    ) as Record<string, Uint8Array>,
  };
})();

interface ChangeEntry {
  serialized: {
    blindedMessage: { amount: number; id: string; B_: string };
    blindingFactor: string;
    secret: string;
  };
  signature: { amount: number; id: string; C_: string };
}

/** Deterministic blank outputs plus real mint signatures, as NUT-09 would return. */
function makeChangeEntries(amounts: number[]): ChangeEntry[] {
  const seed = new Uint8Array(32).fill(3);
  return amounts.map((amount, counter) => {
    const output = OutputData.createSingleDeterministicData(
      amount,
      seed,
      counter,
      mintKeys.id,
    );
    const B_ = output.blindedMessage.B_;
    const signature = createBlindSignature(
      pointFromHex(B_),
      mintKeys.privKeys[String(amount)]!,
      mintKeys.id,
    );
    return {
      serialized: {
        blindedMessage: { amount, id: mintKeys.id, B_ },
        blindingFactor: output.blindingFactor.toString(16),
        secret: Buffer.from(output.secret).toString("hex"),
      },
      signature: {
        amount,
        id: mintKeys.id,
        C_: Buffer.from(signature.C_.toBytes(false)).toString("hex"),
      },
    };
  });
}

interface MeltFixtureOptions {
  amount?: number;
  inputAmount?: number;
  change?: ChangeEntry[];
  /** Override NUT-09 restore. Defaults to returning every change signature. */
  restore?: (outputs: Array<{ amount: number; id: string; B_: string }>) => Promise<unknown>;
  /** Error `checkMeltQuote` throws inside the handler's finalize. Defaults to 20007. */
  quoteError?: Error;
}

async function pendingMeltFixture(
  needsSwap: boolean,
  remoteStates: (Ys: string[], call: number) => unknown,
  options: MeltFixtureOptions = {},
) {
  const repo = new MemoryRepositories();
  const coco = new Manager(repo, async () => new Uint8Array(64));
  const swapSecrets = ["swap-a", "swap-b"];
  const change = options.change ?? [];
  const operation = {
    id: "op", mintUrl, method: "bolt11", methodData: { invoice: "invoice" },
    state: "pending", createdAt: 0, updatedAt: 0, quoteId: "expired-quote", unit: "sat",
    needsSwap, amount: options.amount ?? 2, fee_reserve: 0, swap_fee: 0,
    inputAmount: options.inputAmount ?? 2,
    inputProofSecrets: inputSecrets,
    changeOutputData: { keep: change.map((entry) => entry.serialized), send: [] },
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
    walletService: {
      getWalletWithActiveKeysetId: (url: string) => Promise<unknown>;
    };
    mintService: { ensureUpdatedMint: (url: string) => Promise<unknown> };
    mintAdapter: {
      checkMeltQuote: () => Promise<unknown>;
      checkMeltQuoteState: () => Promise<unknown>;
      checkProofStates: (mintUrl: string, Ys: string[]) => Promise<unknown>;
    };
  };
  const restoreCalls: Array<{ outputs: Array<{ amount: number; id: string; B_: string }> }> = [];
  internal.walletService.getWalletWithActiveKeysetId = async () => ({
    wallet: {
      mint: {
        restore: async (payload: { outputs: Array<{ amount: number; id: string; B_: string }> }) => {
          restoreCalls.push(payload);
          if (options.restore) return options.restore(payload.outputs);
          return { outputs: payload.outputs, signatures: change.map((entry) => entry.signature) };
        },
      },
    },
  });
  internal.mintService.ensureUpdatedMint = async () => ({
    keysets: [{ id: mintKeys.id, unit: "sat", keypairs: mintKeys.pubKeys }],
  });
  internal.mintAdapter.checkMeltQuoteState = async () => { throw new MintOperationError(20007, "quote expired"); };
  internal.mintAdapter.checkMeltQuote = async () => {
    throw options.quoteError ?? new MintOperationError(20007, "quote expired");
  };
  const queries: string[][] = [];
  internal.mintAdapter.checkProofStates = async (url, Ys) => {
    expect(url).toBe(mintUrl);
    queries.push(Ys);
    return remoteStates(Ys, queries.length);
  };
  installMeltQuoteExpiryHandler(coco);
  return {
    coco,
    repo,
    queries,
    restoreCalls,
    change,
    actualSecrets: needsSwap ? swapSecrets : inputSecrets,
  };
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

  // SPENT is no longer a preserve case: it now finalizes (see the finalize suite).
  for (const remoteState of ["PENDING", "MISSING", "FAILED", "DUPLICATE"]) {
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

describe("expired quote finalization with Coco 1.0.1", () => {
  const allSpent = (Ys: string[]) => Ys.map((Y) => ({ Y, state: "SPENT" }));

  const finalizedState = (operation: MeltOperation) => {
    if (operation.state !== "finalized") {
      throw new Error(`expected finalized, got ${operation.state}`);
    }
    return operation;
  };

  for (const needsSwap of [false, true]) {
    it(`finalizes when every actual melt input is SPENT (needsSwap=${needsSwap})`, async () => {
      const { coco, repo, queries, actualSecrets, restoreCalls } = await pendingMeltFixture(
        needsSwap,
        allSpent,
      );
      try {
        const operation = finalizedState(await coco.ops.melt.refresh("op"));
        // Both NUT-07 checks run: checkPending, then re-verification under the
        // finalize lock, using the actual melt inputs (swap-send when swapped).
        expect(queries).toEqual([actualSecrets.map(yFor), actualSecrets.map(yFor)]);
        expect(operation.changeAmount).toBe(0);
        expect(operation.effectiveFee).toBe(0);
        // No change outputs were prepared, so NUT-09 restore is not called.
        expect(restoreCalls).toHaveLength(0);
        for (const secret of actualSecrets) {
          expect((await repo.proofRepository.getProofBySecret(mintUrl, secret))?.state).toBe(
            "spent",
          );
        }
        if (needsSwap) {
          for (const secret of inputSecrets) {
            expect((await repo.proofRepository.getProofBySecret(mintUrl, secret))?.state).toBe(
              "spent",
            );
          }
        }
        expect(await repo.proofRepository.getReadyProofs(mintUrl)).toHaveLength(0);
      } finally {
        await coco.dispose();
      }
    });
  }

  it("recovers change through NUT-09 and records the settlement amounts", async () => {
    const change = makeChangeEntries([1]);
    const { coco, repo } = await pendingMeltFixture(false, allSpent, {
      amount: 1,
      inputAmount: 2,
      change,
    });
    try {
      const operation = finalizedState(await coco.ops.melt.refresh("op"));
      expect(operation.changeAmount).toBe(1);
      expect(operation.effectiveFee).toBe(0);

      const ready = await repo.proofRepository.getReadyProofs(mintUrl);
      expect(ready).toHaveLength(1);
      expect(ready[0]!.secret).toBe(
        Buffer.from(change[0]!.serialized.secret, "hex").toString(),
      );
      expect(ready[0]!.amount).toBe(1);
      expect(ready[0]!.createdByOperationId).toBe("op");
      for (const secret of inputSecrets) {
        expect((await repo.proofRepository.getProofBySecret(mintUrl, secret))?.state).toBe(
          "spent",
        );
      }
    } finally {
      await coco.dispose();
    }
  });

  it("aligns reordered restore results to their own outputs", async () => {
    const change = makeChangeEntries([1, 2]);
    const { coco, repo } = await pendingMeltFixture(false, allSpent, {
      amount: 1,
      inputAmount: 4,
      change,
      restore: async (outputs) => ({
        outputs: [outputs[1], outputs[0]],
        signatures: [change[1]!.signature, change[0]!.signature],
      }),
    });
    try {
      const operation = finalizedState(await coco.ops.melt.refresh("op"));
      expect(operation.changeAmount).toBe(3);
      expect(operation.effectiveFee).toBe(0);

      const ready = await repo.proofRepository.getReadyProofs(mintUrl);
      expect(ready).toHaveLength(2);
      const bySecret = new Map(ready.map((proof) => [proof.secret, proof]));
      for (const entry of change) {
        const secret = Buffer.from(entry.serialized.secret, "hex").toString();
        expect(bySecret.get(secret)?.amount).toBe(entry.serialized.blindedMessage.amount);
      }
    } finally {
      await coco.dispose();
    }
  });

  it("saves only the change outputs the mint returned", async () => {
    const change = makeChangeEntries([1, 2]);
    const { coco, repo } = await pendingMeltFixture(false, allSpent, {
      amount: 1,
      inputAmount: 4,
      change,
      restore: async (outputs) => ({
        outputs: [outputs[0]],
        signatures: [change[0]!.signature],
      }),
    });
    try {
      const operation = finalizedState(await coco.ops.melt.refresh("op"));
      expect(operation.changeAmount).toBe(1);
      expect(operation.effectiveFee).toBe(2);
      const ready = await repo.proofRepository.getReadyProofs(mintUrl);
      expect(ready).toHaveLength(1);
      expect(ready[0]!.secret).toBe(
        Buffer.from(change[0]!.serialized.secret, "hex").toString(),
      );
    } finally {
      await coco.dispose();
    }
  });

  it("does not save change proofs twice when an earlier attempt already did", async () => {
    const change = makeChangeEntries([1, 2]);
    const { coco, repo } = await pendingMeltFixture(false, allSpent, {
      amount: 1,
      inputAmount: 4,
      change,
    });
    try {
      // Simulate a previous finalize that saved change before failing to
      // persist the operation.
      const existingSecret = Buffer.from(change[0]!.serialized.secret, "hex").toString();
      await repo.proofRepository.saveProofs(mintUrl, [
        {
          secret: existingSecret,
          state: "ready",
          mintUrl,
          id: change[0]!.serialized.blindedMessage.id,
          C: yFor(existingSecret),
          amount: 1,
          createdByOperationId: "op",
        } satisfies CoreProof,
      ]);

      const operation = finalizedState(await coco.ops.melt.refresh("op"));
      expect(operation.changeAmount).toBe(3);
      const ready = await repo.proofRepository.getReadyProofs(mintUrl);
      expect(ready).toHaveLength(2);
      expect(ready.filter((proof) => proof.secret === existingSecret)).toHaveLength(1);
    } finally {
      await coco.dispose();
    }
  });

  it("stays pending and propagates when NUT-09 restore fails in transport", async () => {
    const failure = new NetworkError("restore offline");
    const { coco, repo, restoreCalls } = await pendingMeltFixture(false, allSpent, {
      amount: 1,
      inputAmount: 2,
      change: makeChangeEntries([1]),
      restore: async () => {
        throw failure;
      },
    });
    try {
      await expect(coco.ops.melt.refresh("op")).rejects.toBe(failure);
      expect(restoreCalls).toHaveLength(1);
      expect((await coco.ops.melt.get("op"))?.state).toBe("pending");
      // Nothing was marked spent and no change was saved.
      for (const secret of inputSecrets) {
        const proof = await repo.proofRepository.getProofBySecret(mintUrl, secret);
        expect(proof?.state).toBe("inflight");
        expect(proof?.usedByOperationId).toBe("op");
      }
      expect(await repo.proofRepository.getReadyProofs(mintUrl)).toHaveLength(0);
    } finally {
      await coco.dispose();
    }
  });

  it("finalizes without change and warns when the mint restores nothing", async () => {
    const warn = spyOn(logger, "warn").mockImplementation(() => {});
    const { coco, repo } = await pendingMeltFixture(false, allSpent, {
      amount: 1,
      inputAmount: 2,
      change: makeChangeEntries([1]),
      restore: async () => ({ outputs: [], signatures: [] }),
    });
    try {
      const operation = finalizedState(await coco.ops.melt.refresh("op"));
      expect(operation.changeAmount).toBe(0);
      expect(operation.effectiveFee).toBe(1);
      expect(await repo.proofRepository.getReadyProofs(mintUrl)).toHaveLength(0);
      expect(
        warn.mock.calls.some((call) => String(call[0]).includes("no change signatures")),
      ).toBe(true);
    } finally {
      warn.mockRestore();
      await coco.dispose();
    }
  });

  for (const [name, states] of Object.entries({
    "mixed SPENT/UNSPENT": (Ys: string[]) =>
      Ys.map((Y, index) => ({ Y, state: index === 0 ? "SPENT" : "UNSPENT" })),
    "one PENDING": (Ys: string[]) =>
      Ys.map((Y, index) => ({ Y, state: index === 0 ? "PENDING" : "SPENT" })),
    incomplete: (Ys: string[]) => [{ Y: Ys[0], state: "SPENT" }],
    duplicate: (Ys: string[]) => Ys.map(() => ({ Y: Ys[0], state: "SPENT" })),
  })) {
    it(`keeps the operation pending on ${name} states`, async () => {
      const { coco, repo } = await pendingMeltFixture(true, states);
      try {
        expect((await coco.ops.melt.refresh("op")).state).toBe("pending");
        expect((await coco.ops.melt.get("op"))?.state).toBe("pending");
        const actualSecrets = ["swap-a", "swap-b"];
        for (const secret of actualSecrets) {
          const proof = await repo.proofRepository.getProofBySecret(mintUrl, secret);
          expect(proof?.state).toBe("inflight");
          expect(proof?.usedByOperationId).toBe("op");
        }
        expect(await repo.proofRepository.getReadyProofs(mintUrl)).toHaveLength(0);
      } finally {
        await coco.dispose();
      }
    });
  }

  it("refuses to finalize when inputs flip from SPENT to PENDING before the lock", async () => {
    const { coco, repo, queries } = await pendingMeltFixture(false, (Ys, call) =>
      Ys.map((Y) => ({ Y, state: call === 1 ? "SPENT" : "PENDING" })));
    try {
      await expect(coco.ops.melt.refresh("op")).rejects.toThrow("expected all SPENT");
      expect(queries).toHaveLength(2);
      expect((await coco.ops.melt.get("op"))?.state).toBe("pending");
      for (const secret of inputSecrets) {
        const proof = await repo.proofRepository.getProofBySecret(mintUrl, secret);
        expect(proof?.state).toBe("inflight");
        expect(proof?.usedByOperationId).toBe("op");
      }
    } finally {
      await coco.dispose();
    }
  });

  it("propagates non-20007 errors from the original finalize unchanged", async () => {
    const boom = new Error("mint exploded");
    const { coco, repo, queries, restoreCalls } = await pendingMeltFixture(false, allSpent, {
      quoteError: boom,
    });
    try {
      await expect(coco.ops.melt.refresh("op")).rejects.toThrow("mint exploded");
      // Only the checkPending verification ran; the finalize wrapper rethrew
      // before re-checking or restoring anything.
      expect(queries).toHaveLength(1);
      expect(restoreCalls).toHaveLength(0);
      expect((await coco.ops.melt.get("op"))?.state).toBe("pending");
      for (const secret of inputSecrets) {
        expect((await repo.proofRepository.getProofBySecret(mintUrl, secret))?.state).toBe(
          "inflight",
        );
      }
    } finally {
      await coco.dispose();
    }
  });
});
