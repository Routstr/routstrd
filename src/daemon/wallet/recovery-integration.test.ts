import { expect, it, spyOn } from "bun:test";
import { Manager } from "@cashu/coco-core";
import { SqliteRepositories } from "@cashu/coco-sqlite-bun";
import { Database } from "bun:sqlite";
import { runTargetedRecovery, type SendRecoveryService } from "./recovery-probe";

import {
  cleanupLocalRecoveryState,
  createRecoveryGate,
  runWalletRecovery,
} from "./coco-client";

const MINT = "https://mint.example.com";
const OP = "op-live";

it("targeted recovery leaves a send that execute() holds alone", async () => {
  const repo = new SqliteRepositories({ database: new Database(":memory:") });
  await repo.init();
  const coco = new Manager(repo, async () => new Uint8Array(64));
  const internals = coco as unknown as {
    sendOperationService: SendRecoveryService;
    walletService: { getWalletWithActiveKeysetId: (m: string) => Promise<unknown> };
  };

  let swapStarted!: () => void;
  const started = new Promise<void>((r) => (swapStarted = r));
  let finishSwap!: (v: { send: unknown[]; keep: unknown[] }) => void;
  const swap = new Promise<{ send: unknown[]; keep: unknown[] }>((r) => (finishSwap = r));
  internals.walletService.getWalletWithActiveKeysetId = async () => ({
    wallet: {
      unit: "sat",
      send: async () => (swapStarted(), swap),
      checkProofsStates: async () => [{ state: "UNSPENT" }],
      getFeesForProofs: () => 0,
    },
  });

  await repo.proofRepository.saveProofs(MINT, [
    { id: "00aa", amount: 8, secret: "in-1", C: "02aa", mintUrl: MINT, state: "ready" } as never,
  ]);
  await repo.proofRepository.reserveProofs(MINT, ["in-1"], OP);
  await repo.sendOperationRepository.create({
    id: OP, mintUrl: MINT, amount: 8, state: "prepared", method: "default", methodData: {},
    createdAt: Date.now(), updatedAt: Date.now(), needsSwap: true, fee: 0, inputAmount: 8,
    inputProofSecrets: ["in-1"],
    outputData: {
      keep: [],
      send: [{
        blindedMessage: { amount: 8, id: "00aa", B_: "02" + "11".repeat(32) },
        blindingFactor: "01",
        secret: Buffer.from("out-1").toString("hex"),
      }],
    },
  } as never);

  const live = coco.ops.send.execute(OP);
  await started; // swap is at the mint
  const result = await runTargetedRecovery(coco.ops, internals.sendOperationService, {
    kinds: ["send"],
    fetchImpl: (async () => new Response("{}")) as unknown as unknown as typeof fetch,
  });
  // On 8005aeb this is "rolled_back" and "in-1" is no longer reserved.
  expect((await coco.ops.send.get(OP))?.state).toBe("executing");
  // The live execute holds coco's per-operation lock: busy, never driven.
  expect(result.attempted).toBe(0);
  expect(result.busy).toBe(1);

  finishSwap({ send: [{ id: "00aa", amount: 8, secret: "out-1", C: "02bb" }], keep: [] });
  await live;
  expect((await coco.ops.send.get(OP))?.state).toBe("pending");
});


it("keeps healthy-mint callers gated while happy-path global recovery runs", async () => {
  const db = new Database(":memory:");
  const repo = new SqliteRepositories({ database: db });
  await repo.init();
  const coco = new Manager(repo, async () => new Uint8Array(64));
  const gate = createRecoveryGate();
  let enter!: () => void;
  const entered = new Promise<void>((resolve) => { enter = resolve; });
  let release!: () => void;
  const barrier = new Promise<void>((resolve) => { release = resolve; });
  const spies = [
    spyOn(coco.ops.send.recovery, "run").mockImplementation(async () => { enter(); await barrier; }),
    spyOn(coco.ops.melt.recovery, "run").mockResolvedValue(undefined),
    spyOn(coco.ops.receive.recovery, "run").mockResolvedValue(undefined),
    spyOn(coco, "recoverPendingMintOperations").mockResolvedValue(undefined),
  ];
  try {
    const recovery = runWalletRecovery(coco, () => {}, undefined,
      (mints) => gate.publishStuckMints(mints),
      { fetchImpl: (async () => new Response("{}")) as unknown as typeof fetch },
    ).then(() => gate.complete());
    await entered;
    let released = false;
    const waiting = gate.waitForRecovery(MINT).then(() => { released = true; });
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(released).toBe(false);
    release();
    await recovery;
    await waiting;
    expect(released).toBe(true);
  } finally {
    release();
    for (const spy of spies) spy.mockRestore();
    db.close();
  }
});

it("degraded startup finishes local housekeeping before opening the per-mint gate", async () => {
  const db = new Database(":memory:");
  const repo = new SqliteRepositories({ database: db });
  await repo.init();
  const coco = new Manager(repo, async () => new Uint8Array(64));
  await repo.sendOperationRepository.create({
    id: "stuck", mintUrl: MINT, amount: 8, state: "rolling_back",
    method: "default", methodData: {}, createdAt: Date.now(), updatedAt: Date.now(),
  } as never);
  const gate = createRecoveryGate();
  const events: string[] = [];
  const sweep = spyOn(coco.ops.send.recovery, "run");
  try {
    const recovery = runWalletRecovery(coco, () => {}, [], (mints) => {
      events.push("gate");
      gate.publishStuckMints(mints);
    }, {
      fetchImpl: (async () => { throw new Error("offline"); }) as unknown as unknown as typeof fetch,
      cleanupLocalState: async () => { events.push("cleanup"); },
    }).then(() => gate.complete());
    await gate.waitForRecovery("https://healthy.example.com");
    expect(events).toEqual(["cleanup", "gate"]);
    await recovery;
    expect(sweep).not.toHaveBeenCalled();
    expect((await coco.ops.send.get("stuck"))?.state).toBe("rolling_back");
  } finally {
    sweep.mockRestore();
    db.close();
  }
});

it("degraded startup probes before settlement and never asks a dead mint", async () => {
  const db = new Database(":memory:");
  const repo = new SqliteRepositories({ database: db });
  await repo.init();
  const coco = new Manager(repo, async () => new Uint8Array(64));
  const expiredRow = (id: string, mintUrl: string) => ({
    id, mintUrl, quoteId: `q-${id}`, state: "pending",
    createdAt: 1_000, updatedAt: 2_000, method: "bolt11",
    methodData: { method: "bolt11", data: {} }, amount: 100, unit: "sat",
    request: "lnbc1example", expiry: 1_000_000, // epoch seconds, long past
  });
  await repo.mintOperationRepository.create(expiredRow("dead-quote", "https://dead.example.com") as never);
  await repo.mintOperationRepository.create(expiredRow("live-quote", "https://live.example.com") as never);
  const internals = coco as unknown as {
    mintOperationService: {
      observePendingOperation(id: string): Promise<{ category: "waiting" }>;
      failPendingOperation(op: unknown, failure: unknown): Promise<unknown>;
    };
  };
  const events: string[] = [];
  const observe = spyOn(internals.mintOperationService, "observePendingOperation")
    .mockImplementation(async (id: string) => {
      events.push(`observe:${id}`);
      return { category: "waiting" };
    });
  // Fail the row for real (as the production service would) so the targeted
  // mint pass sees state "failed" and refresh() returns without re-observing.
  const fail = spyOn(internals.mintOperationService, "failPendingOperation")
    .mockImplementation(async (op: unknown) => {
      const id = (op as { id: string }).id;
      const row = await repo.mintOperationRepository.getById(id);
      if (row) await repo.mintOperationRepository.update({ ...row, state: "failed" } as never);
      return {} as never;
    });
  const gate = createRecoveryGate();
  try {
    const recovery = runWalletRecovery(coco, () => {}, [], (mints) => {
      events.push("gate");
      gate.publishStuckMints(mints);
    }, {
      fetchImpl: (async (url: unknown) => {
        if (String(url).includes("dead.example.com")) throw new Error("offline");
        return new Response("{}");
      }) as unknown as typeof fetch,
      cleanupLocalState: async () => { events.push("cleanup"); },
    }).then(() => gate.complete());
    await recovery;
    // The dead mint was probed, never asked to observe its quote; the gate
    // opened before settlement spent anything on the live mint.
    expect(events).toEqual(["cleanup", "gate", "observe:live-quote"]);
    expect(observe).toHaveBeenCalledTimes(1);
    expect(fail).toHaveBeenCalledTimes(1);
  } finally {
    observe.mockRestore();
    fail.mockRestore();
    db.close();
  }
});

it("local housekeeping cleans init sends and orphaned reservations without network", async () => {
  const db = new Database(":memory:");
  const repo = new SqliteRepositories({ database: db });
  await repo.init();
  const coco = new Manager(repo, async () => new Uint8Array(64));
  try {
    await repo.sendOperationRepository.create({
      id: "init-send", mintUrl: MINT, amount: 8, state: "init", method: "default",
      methodData: {}, createdAt: Date.now(), updatedAt: Date.now(),
    } as never);
    for (const [id, repository] of [
      ["init-melt", repo.meltOperationRepository],
      ["init-receive", repo.receiveOperationRepository],
      ["init-mint", repo.mintOperationRepository],
    ] as const) {
      await repository.create({
        id, mintUrl: MINT, amount: 8, state: "init", method: "bolt11",
        methodData: {}, inputProofs: [], createdAt: Date.now(), updatedAt: Date.now(),
      } as never);
    }
    await repo.proofRepository.saveProofs(MINT, [
      { id: "00aa", amount: 8, secret: "init-input", C: "02aa", mintUrl: MINT, state: "ready" },
      { id: "00aa", amount: 8, secret: "orphan-input", C: "02aa", mintUrl: MINT, state: "ready" },
    ] as never);
    await repo.proofRepository.reserveProofs(MINT, ["init-input"], "init-send");
    await repo.proofRepository.reserveProofs(MINT, ["orphan-input"], "missing-send");
    await cleanupLocalRecoveryState(coco, repo);
    expect(await coco.ops.send.get("init-send")).toBeNull();
    expect(await repo.proofRepository.getReservedProofs()).toEqual([]);
    expect(await repo.meltOperationRepository.getById("init-melt")).toBeNull();
    expect(await repo.receiveOperationRepository.getById("init-receive")).toBeNull();
    expect(await repo.mintOperationRepository.getById("init-mint")).toBeNull();
  } finally {
    db.close();
  }
});

it("cleanup checks all private methods before making any local writes", async () => {
  const db = new Database(":memory:");
  const repo = new SqliteRepositories({ database: db });
  await repo.init();
  const coco = new Manager(repo, async () => new Uint8Array(64));
  const internals = coco as unknown as { mintOperationService: { recoverInitOperation: unknown } };
  const original = internals.mintOperationService.recoverInitOperation;
  try {
    await repo.sendOperationRepository.create({
      id: "untouched-init", mintUrl: MINT, amount: 8, state: "init", method: "default",
      methodData: {}, createdAt: Date.now(), updatedAt: Date.now(),
    } as never);
    internals.mintOperationService.recoverInitOperation = undefined;
    await expect(cleanupLocalRecoveryState(coco, repo)).rejects.toThrow("mintOperationService.recoverInitOperation is unavailable");
    expect((await repo.sendOperationRepository.getById("untouched-init"))?.state).toBe("init");
  } finally {
    internals.mintOperationService.recoverInitOperation = original;
    db.close();
  }
});
