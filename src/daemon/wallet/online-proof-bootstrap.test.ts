import { describe, expect, it, mock } from "bun:test";
import { Manager, ProofStateWatcherService } from "@cashu/coco-core";
import type { CoreProof } from "@cashu/coco-core";
import { Database } from "bun:sqlite";
import { SqliteRepositories } from "@cashu/coco-sqlite-bun";
import { createRecoveryDisposer, drainRecoveryWork } from "./recovery-work";
import { startOnlineProofBootstrap, watchOnlineInflightProofs } from "./online-proof-bootstrap";

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}
const proof = (secret: string, mintUrl = "mint-a", operationId?: string): CoreProof => ({
  secret, mintUrl, amount: 1, C: "C", id: "keyset", state: "inflight",
  usedByOperationId: operationId,
});
function setup(proofs: CoreProof[]) {
  let inflight = [...proofs];
  let running = true;
  let stopped = false;
  const check = mock(async (_mint: string, entries: CoreProof[]): Promise<Array<{ state: string }>> =>
    entries.map(() => ({ state: "UNSPENT" })));
  const get = mock(async (_id: string): Promise<{ method: string } | null> => null);
  const watchProof = mock(async (_mint: string, _secrets: string[]) => {});
  const setProofState = mock(async (mint: string, secrets: string[], _state: string) => {
    inflight = inflight.filter((p) => p.mintUrl !== mint || !secrets.includes(p.secret));
  });
  const wallet = mock(async (mint: string) => ({ wallet: {
    checkProofsStates: (entries: CoreProof[]) => check(mint, entries),
  } }));
  const coco = {
    proofStateWatcher: { isRunning: () => running, watchProof },
    walletService: { getWalletWithActiveKeysetId: wallet },
    proofService: { setProofState },
    ops: { send: { get } },
  };
  const repo = { proofRepository: { getInflightProofs: mock(async () => [...inflight]) } };
  const logger = { warn: mock((_message: string, _context: Record<string, unknown>) => {}) };
  const run = () => watchOnlineInflightProofs(coco as unknown as Manager, repo, logger, () => stopped);
  return { coco, repo, logger, check, get, watchProof, setProofState, wallet, run,
    stop: () => { stopped = true; running = false; } };
}

describe("online inflight proof bootstrap", () => {
  it("excludes offline sends, but checks/subscribes online and other inflight proofs", async () => {
    const s = setup([proof("offline", "mint-a", "offline-op"), proof("online", "mint-a", "online-op"),
      proof("receive", "mint-b", "receive-op"), proof("orphan", "mint-b")]);
    s.get.mockImplementation(async (id) => id === "receive-op" ? null :
      { method: id === "offline-op" ? "offline" : "default" });
    await s.run();
    expect(s.check.mock.calls.map(([mint, entries]) => [mint, entries.map((p) => p.secret)]))
      .toEqual([["mint-a", ["online"]], ["mint-b", ["receive", "orphan"]]]);
    expect(s.watchProof.mock.calls).toEqual([["mint-a", ["online"]], ["mint-b", ["receive", "orphan"]]]);
  });

  it("makes no wallet calls or subscriptions for an offline-only wallet", async () => {
    const s = setup([proof("offline", "mint-a", "offline-op")]);
    s.get.mockImplementation(async () => ({ method: "offline" }));
    await s.run();
    expect(s.wallet).not.toHaveBeenCalled();
    expect(s.check).not.toHaveBeenCalled();
    expect(s.watchProof).not.toHaveBeenCalled();
    expect(s.setProofState).not.toHaveBeenCalled();
  });

  it("marks only confirmed spent secrets through ProofService before subscribing survivors", async () => {
    const s = setup([proof("unspent"), proof("spent"), proof("pending")]);
    s.check.mockImplementation(async () => [{ state: "UNSPENT" }, { state: "SPENT" }, { state: "PENDING" }]);
    await s.run();
    expect(s.setProofState.mock.calls).toEqual([["mint-a", ["spent"], "spent"]]);
    expect(s.watchProof.mock.calls).toEqual([["mint-a", ["unspent", "pending"]]]);
  });

  it("logs and skips all proofs belonging to a failed send lookup", async () => {
    const s = setup([proof("bad-1", "mint-a", "bad"), proof("bad-2", "mint-a", "bad"), proof("good", "mint-a", "good")]);
    s.get.mockImplementation(async (id) => { if (id === "bad") throw new Error("db failure"); return { method: "default" }; });
    await s.run();
    expect(s.get).toHaveBeenCalledTimes(2);
    expect(s.watchProof.mock.calls).toEqual([["mint-a", ["good"]]]);
    expect(s.logger.warn).toHaveBeenCalledTimes(1);
  });

  it("still subscribes after a failed check and continues after a failed subscription", async () => {
    const s = setup([proof("a"), proof("b", "mint-b")]);
    s.wallet.mockImplementation(async (mint) => { if (mint === "mint-a") throw new Error("offline");
      return { wallet: { checkProofsStates: (entries) => s.check(mint, entries) } }; });
    s.watchProof.mockImplementation(async (mint) => { if (mint === "mint-a") throw new Error("no websocket"); });
    await s.run();
    expect(s.watchProof.mock.calls).toEqual([["mint-a", ["a"]], ["mint-b", ["b"]]]);
    expect(s.check).toHaveBeenCalledTimes(1);
    expect(s.logger.warn).toHaveBeenCalledTimes(2);
  });

  for (const phase of ["wallet", "check", "subscribe"] as const) {
    it(`continues to later mints when ${phase} stalls and retains the actual work`, async () => {
      const s = setup([proof("a"), proof("b", "mint-b")]);
      const late = deferred<any>();
      if (phase === "wallet") s.wallet.mockImplementationOnce(() => late.promise);
      if (phase === "check") s.check.mockImplementationOnce(() => late.promise);
      if (phase === "subscribe") s.watchProof.mockImplementationOnce(() => late.promise);
      const outstanding = new Map<string, Promise<unknown>>();
      await watchOnlineInflightProofs(s.coco as unknown as Manager, s.repo, s.logger, () => false,
        { timeoutMs: 5, outstanding });
      expect(s.check.mock.calls.some(([mint]) => mint === "mint-b")).toBe(true);
      expect(s.watchProof.mock.calls.some(([mint]) => mint === "mint-b")).toBe(true);
      expect(outstanding.size).toBe(1);
      expect(JSON.stringify(s.logger.warn.mock.calls)).toContain("Timed out bootstrapping mint proofs");
      late.resolve(phase === "wallet" ? { wallet: {} } : phase === "check" ? [{ state: "SPENT" }] : undefined);
      await drainRecoveryWork(outstanding);
      expect(s.setProofState).not.toHaveBeenCalled(); // late state results are not applied
    });
  }

  for (const states of [[], [{ state: "SPENT" }], [{ state: "SPENT" }, { state: "BOGUS" }], [null, { state: "SPENT" }]]) {
    it(`does not partially apply a malformed response ${JSON.stringify(states)}`, async () => {
      const s = setup([proof("a"), proof("b")]);
      s.check.mockImplementation(async () => states as Array<{ state: string }>);
      await s.run();
      expect(s.setProofState).not.toHaveBeenCalled();
      expect(s.watchProof.mock.calls).toEqual([["mint-a", ["a", "b"]]]);
      expect(s.logger.warn).toHaveBeenCalledTimes(1);
    });
  }

  it("does not gate startup on slow bootstrap and observes outer failures", async () => {
    const s = setup([proof("a")]);
    const pending = deferred<CoreProof[]>();
    s.repo.proofRepository.getInflightProofs.mockImplementation(() => pending.promise);
    expect(startOnlineProofBootstrap(s.coco as unknown as Manager, s.repo, s.logger, () => false)).toBeUndefined();
    expect(s.watchProof).not.toHaveBeenCalled();
    pending.reject(new Error("database read failed"));
    await Bun.sleep(0);
    expect(s.logger.warn).toHaveBeenCalledTimes(1);
    expect(s.logger.warn.mock.calls[0]![0]).toBe("Failed to bootstrap online inflight proofs");
    expect(s.logger.warn.mock.calls[0]![1]).toEqual({ error: "database read failed" });
  });

  it("observes incompatible Coco internals without rejecting startup", async () => {
    const s = setup([]);
    startOnlineProofBootstrap({} as Manager, s.repo, s.logger, () => false);
    await Bun.sleep(0);
    expect(s.logger.warn).toHaveBeenCalledTimes(1);
  });

  it("stops after disposal during a mint check", async () => {
    const s = setup([proof("a")]);
    const pending = deferred<Array<{ state: string }>>();
    s.check.mockImplementation(() => pending.promise);
    const running = s.run();
    await Bun.sleep(0);
    s.stop();
    pending.resolve([{ state: "SPENT" }]);
    await running;
    expect(s.setProofState).not.toHaveBeenCalled();
    expect(s.watchProof).not.toHaveBeenCalled();
  });

  it("does not subscribe after disposal during the post-check repository read", async () => {
    const s = setup([proof("a")]);
    const pending = deferred<CoreProof[]>();
    s.repo.proofRepository.getInflightProofs.mockImplementationOnce(async () => [proof("a")])
      .mockImplementationOnce(() => pending.promise);
    const running = s.run();
    await Bun.sleep(0);
    s.stop();
    pending.resolve([proof("a")]);
    await running;
    expect(s.watchProof).not.toHaveBeenCalled();
  });
});

// Exercise the actual patched watcher, not a stub: stop() must also win the
// race once watchProof has already entered an awaited subscribe call.
describe("Coco watcher shutdown race", () => {
  it("does not subscribe when stopped during the trust lookup", async () => {
    const trusted = deferred<boolean>();
    const subscribe = mock(async () => ({ subId: "unexpected", unsubscribe: async () => {} }));
    const watcher = new ProofStateWatcherService(
      { subscribe } as never, { isTrustedMint: () => trusted.promise } as never,
      {} as never, {} as never, { on: () => () => {} } as never,
      undefined, { watchExistingInflightOnStart: false },
    );
    await watcher.start();
    const watching = watcher.watchProof("mint-a", ["secret"]);
    await watcher.stop();
    trusted.resolve(true);
    await watching;
    expect(subscribe).not.toHaveBeenCalled();
  });

  it("unsubscribes a late transport handle and retains no stopped subscriptions", async () => {
    const subscribed = deferred<{ subId: string; unsubscribe: () => Promise<void> }>();
    const subscribe = mock(() => subscribed.promise);
    const unsubscribe = mock(async () => {});
    const watcher = new ProofStateWatcherService(
      { subscribe } as never,
      { isTrustedMint: async () => true } as never,
      {} as never, {} as never,
      { on: () => () => {} } as never,
      undefined, { watchExistingInflightOnStart: false },
    );
    await watcher.start();
    const watching = watcher.watchProof("mint-a", ["secret"]);
    await Bun.sleep(0);
    expect(subscribe).toHaveBeenCalledTimes(1);
    await watcher.stop();
    subscribed.resolve({ subId: "late", unsubscribe });
    await watching;
    expect(unsubscribe).toHaveBeenCalledTimes(1);
    expect(watcher.isRunning()).toBe(false);
    await watcher.stop();
    expect(unsubscribe).toHaveBeenCalledTimes(1);
  });
});

describe("SDK proof-state ordering", () => {
  it("maps reversed mint Y responses to the right secret through Coco's installed cashu-ts", async () => {
    // Resolve from coco-core, not the application's different cashu-ts major.
    const { createRequire } = await import("node:module");
    const require = createRequire(import.meta.url);
    const sdkPath = createRequire(require.resolve("@cashu/coco-core")).resolve("@cashu/cashu-ts");
    const { Wallet, hashToCurve } = await import(sdkPath);
    const s = setup([proof("unspent"), proof("spent")]);
    const responses = ["unspent", "spent"].map((secret) => ({
      Y: hashToCurve(new TextEncoder().encode(secret)).toHex(true),
      state: secret === "spent" ? "SPENT" : "UNSPENT",
    })).reverse();
    const sdkWallet = new Wallet({ mintUrl: "mint-a", check: async () => ({ states: responses }) });
    s.wallet.mockImplementation(async () => ({ wallet: sdkWallet }));
    await s.run();
    expect(s.setProofState.mock.calls).toEqual([["mint-a", ["spent"], "spent"]]);
    expect(s.watchProof.mock.calls).toEqual([["mint-a", ["unspent"]]]);
  });
});


describe("real Manager bootstrap shutdown", () => {
  it("stops the actual watcher and retains DB until timed-out metadata work finishes", async () => {
    const database = new Database(":memory:");
    const repo = new SqliteRepositories({ database });
    await repo.init();
    const coco = new Manager(repo, async () => new Uint8Array(64));
    await coco.enableProofStateWatcher({ watchExistingInflightOnStart: false });
    const internals = coco as any;
    internals.mintService.isTrustedMint = async () => false;
    const entered = deferred<void>();
    const release = deferred<void>();
    internals.walletService.getWalletWithActiveKeysetId = async () => {
      entered.resolve();
      await release.promise;
      database.exec("CREATE TABLE late_metadata_write (id INTEGER)");
      return { wallet: { checkProofsStates: async () => [] } };
    };
    const outstanding = new Map<string, Promise<unknown>>();
    let stopped = false;
    let closed = false;
    const logger = { warn: mock((_message: string, _context: Record<string, unknown>) => {}) };
    startOnlineProofBootstrap(coco, { proofRepository: { getInflightProofs: async () => [proof("a")] } },
      logger, () => stopped, { timeoutMs: 5, outstanding });
    await entered.promise;
    await Bun.sleep(15);
    const watcher = internals.proofStateWatcher;
    const dispose = createRecoveryDisposer(() => { stopped = true; }, async () => {
      await coco.pauseSubscriptions();
      await drainRecoveryWork(outstanding);
    }, async () => { await coco.dispose(); database.close(); closed = true; }, 5);
    await expect(dispose()).rejects.toThrow("Timed out waiting for recovery");
    expect(watcher.isRunning()).toBe(false);
    expect(closed).toBe(false);
    release.resolve();
    await dispose();
    expect(closed).toBe(true);
  });

  it("waits for a notification already writing and ignores callbacks after stop", async () => {
    const database = new Database(":memory:");
    const repo = new SqliteRepositories({ database });
    await repo.init();
    const coco = new Manager(repo, async () => new Uint8Array(64));
    const internals = coco as any;
    let notify!: (payload: unknown) => Promise<void>;
    let y!: string;
    internals.mintService.isTrustedMint = async () => true;
    internals.subscriptions.subscribe = async (_mint: string, _kind: string, filters: string[], cb: typeof notify) => {
      notify = cb; y = filters[0]!;
      return { subId: "test", unsubscribe: async () => {} };
    };
    const entered = deferred<void>();
    const release = deferred<void>();
    let writes = 0;
    internals.proofService.setProofState = async () => {
      entered.resolve(); await release.promise;
      database.exec("CREATE TABLE notification_write (id INTEGER)"); writes++;
    };
    await coco.enableProofStateWatcher({ watchExistingInflightOnStart: false });
    // No persisted proof is needed: the real finalization lookup returns none.
    await internals.proofStateWatcher.watchProof("mint-a", ["secret"]);
    const notification = notify({ state: "SPENT", Y: y });
    await entered.promise;
    let paused = false;
    const pause = coco.pauseSubscriptions().then(() => { paused = true; });
    await Bun.sleep(0);
    expect(paused).toBe(false);
    release.resolve();
    await notification;
    await pause;
    await coco.dispose(); database.close();
    await notify({ state: "SPENT", Y: y });
    expect(writes).toBe(1);
  });
});
