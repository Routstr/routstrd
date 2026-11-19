import { afterEach, describe, expect, it, spyOn } from "bun:test";
import { Database } from "bun:sqlite";
import { Manager, type CoreProof } from "@cashu/coco-core";
import { SqliteRepositories } from "@cashu/coco-sqlite-bun";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createCocoClient, DEFAULT_TRUSTED_MINT_URLS } from "./coco-client";
import { recoverMintProofs } from "./mint-proof-restore";
import { FakeMint } from "./testing/fake-mint";

const POINT = "0279be667ef9dcbbac55a06295ce870b07029bfcdb2dce28d959f2815b16f81798";
const cleanups: (() => void | Promise<void>)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

async function boot() {
  const mint = new FakeMint();
  mint.quoteExpiry = null;
  mint.start();
  const database = new Database(":memory:");
  const repo = new SqliteRepositories({ database });
  const manager = new Manager(repo, async () => new Uint8Array(64).fill(7));
  cleanups.push(async () => {
    await manager.dispose();
    manager.subscriptions.closeAll();
    database.close();
    mint.stop();
  });
  await repo.init();
  const mintUrl = mint.url;
  await manager.mint.addMint(mintUrl, { trusted: true });
  const prepare = (amount: number) => manager.ops.mint.prepare({ mintUrl, method: "bolt11", amount });
  async function issue(amount: number) {
    const op = await prepare(amount);
    mint.markPaid(op.quoteId);
    await manager.ops.mint.finalize(op.id);
    return (await repo.proofRepository.getProofsByOperationId(mintUrl, op.id))[0]!;
  }
  const restore = () => recoverMintProofs(manager, repo, mintUrl);
  const counter = async () => (await repo.counterRepository.getCounter(mintUrl, mint.keysetId))?.counter;
  const find = (secret: string) => repo.proofRepository.getProofBySecret(mintUrl, secret);
  const fakeProof = (secret: string, fields: Partial<CoreProof> = {}): CoreProof => ({
    mintUrl, id: mint.keysetId, amount: 1, C: POINT, secret, state: "ready", ...fields,
  });
  return { mint, mintUrl, database, repo, manager, prepare, issue, restore, counter, find, fakeProof };
}

describe("mint proof recovery against pinned Coco, SQLite and a real fake mint", () => {
  it("merges missing proofs and keeps both unmatched local proofs and a pending quote's higher counter", async () => {
    const w = await boot();
    const issued = await w.issue(8);
    const pending = await w.prepare(128);
    const floor = await w.counter();
    expect(floor).toBe(2);
    await w.repo.proofRepository.deleteProofs(w.mintUrl, [issued.secret]);
    await w.repo.proofRepository.saveProofs(w.mintUrl, [w.fakeProof("not derived from seed")]);

    expect(await w.restore()).toContain("8 sat newly spendable");
    expect(await w.find(issued.secret)).toMatchObject({ state: "ready", amount: 8 });
    expect(await w.find("not derived from seed")).toMatchObject({ state: "ready" });
    expect(await w.counter()).toBe(floor);
    expect((await w.manager.ops.mint.get(pending.id))?.state).toBe("pending");
    expect(await w.restore()).toContain("0 sat newly spendable");
    w.mint.markPaid(pending.quoteId);
    await w.manager.ops.mint.finalize(pending.id);
    expect((await w.repo.proofRepository.getAvailableProofs(w.mintUrl)).reduce((sum, p) => sum + p.amount, 0)).toBe(137);
  });

  it("advances a rebuilt counter when the only signature is at index zero", async () => {
    const w = await boot();
    const issued = await w.issue(8);
    await w.repo.proofRepository.deleteProofs(w.mintUrl, [issued.secret]);
    await w.repo.counterRepository.setCounter(w.mintUrl, w.mint.keysetId, 0);
    expect(await w.restore()).toContain("8 sat newly spendable");
    expect(await w.counter()).toBe(1);
  });

  it("does not import signed outputs that belong to an unresolved mint quote", async () => {
    const w = await boot();
    const op = await w.prepare(8);
    w.mint.signFor(op.quoteId, op.outputData.keep.map((output) => output.blindedMessage));
    expect(await w.restore()).toContain("0 sat newly spendable");
    expect(await w.repo.proofRepository.getReadyProofs(w.mintUrl)).toEqual([]);
    expect((await w.manager.ops.mint.get(op.id))?.state).toBe("pending");
  });

  it("does not return an exported, unredeemed outbound token to spendable balance", async () => {
    const w = await boot();
    const issued = await w.issue(8);
    const prepared = await w.manager.ops.send.prepare({ mintUrl: w.mintUrl, amount: 8 });
    const { operation } = await w.manager.ops.send.execute(prepared.id);
    expect(operation.state).toBe("pending");
    expect(await w.find(issued.secret)).toMatchObject({ state: "inflight", usedByOperationId: operation.id });
    await w.repo.proofRepository.deleteProofs(w.mintUrl, [issued.secret]);
    await w.repo.proofRepository.saveProofs(w.mintUrl, [{ ...issued, state: "inflight", createdByOperationId: operation.id }]);
    expect(await w.restore()).toContain("0 sat newly spendable");
    expect(await w.find(issued.secret)).toMatchObject({ state: "inflight", createdByOperationId: operation.id });
    // An operation can still own its outgoing proof even when that row is lost.
    await w.repo.proofRepository.deleteProofs(w.mintUrl, [issued.secret]);
    expect(await w.restore()).toContain("0 sat newly spendable");
    expect(await w.find(issued.secret)).toBeNull();
  }, 15_000);

  it("preserves a reserved ready proof and its owner", async () => {
    const w = await boot();
    const issued = await w.issue(8);
    const op = await w.manager.ops.send.prepare({ mintUrl: w.mintUrl, amount: 8 });
    w.mint.proofStates = ["SPENT"];
    expect(await w.restore()).toContain("0 sat newly spendable");
    expect(await w.find(issued.secret)).toMatchObject({ state: "ready", usedByOperationId: op.id });
  });

  it("does not credit PENDING proofs; releases an unowned inflight proof only after UNSPENT", async () => {
    const w = await boot();
    const issued = await w.issue(8);
    w.mint.proofStates = ["PENDING"];
    await w.repo.proofRepository.deleteProofs(w.mintUrl, [issued.secret]);
    expect(await w.restore()).toContain("0 sat newly spendable");
    expect(await w.find(issued.secret)).toBeNull();
    await w.repo.proofRepository.saveProofs(w.mintUrl, [{ ...issued, createdByOperationId: undefined }]);
    expect(await w.restore()).toContain("0 sat newly spendable");
    expect(await w.find(issued.secret)).toMatchObject({ state: "inflight" });
    w.mint.proofStates = ["UNSPENT"];
    expect(await w.restore()).toContain("8 sat newly spendable");
    expect(await w.find(issued.secret)).toMatchObject({ state: "ready" });
  });

  it("marks a confirmed spent proof without ever resurrecting its row", async () => {
    const w = await boot();
    const issued = await w.issue(8);
    w.mint.proofStates = ["SPENT"];
    expect(await w.restore()).toContain("0 sat newly spendable");
    expect(await w.find(issued.secret)).toMatchObject({ state: "spent" });
    w.mint.proofStates = ["UNSPENT"];
    expect(await w.restore()).toContain("0 sat newly spendable");
    expect(await w.find(issued.secret)).toMatchObject({ state: "spent" });
  }, 15_000);

  it("reports active-keyset transport errors on an empty wallet, instead of returning zero success", async () => {
    const w = await boot();
    w.mint.restoreErrorStatus = 429;
    await expect(w.restore()).rejects.toThrow("restore temporarily unavailable");
    expect(await w.counter()).toBeUndefined();
  });

  it("does not apply an incomplete or invalid proof-state response", async () => {
    const w = await boot();
    const issued = await w.issue(8);
    await w.repo.proofRepository.deleteProofs(w.mintUrl, [issued.secret]);
    await w.repo.counterRepository.setCounter(w.mintUrl, w.mint.keysetId, 0);
    w.mint.proofStates = ["UNRECOGNIZED"];
    await expect(w.restore()).rejects.toThrow("Unknown restored proof state");
    expect(await w.counter()).toBe(0);
    expect(await w.find(issued.secret)).toBeNull();
  });

  it("does not mutate an existing proof if the scan returns no signatures", async () => {
    const w = await boot();
    const issued = await w.issue(8);
    w.mint.signed.clear();
    expect(await w.restore()).toContain("0 sat newly spendable");
    expect(await w.find(issued.secret)).toEqual(issued);
    expect(await w.counter()).toBe(1);
  });

  it("rolls back the proof insert if SQLite rejects the counter write", async () => {
    const w = await boot();
    const issued = await w.issue(8);
    await w.repo.proofRepository.deleteProofs(w.mintUrl, [issued.secret]);
    await w.repo.counterRepository.setCounter(w.mintUrl, w.mint.keysetId, 0);
    w.database.exec(`CREATE TRIGGER fail_counter BEFORE UPDATE ON coco_cashu_counters
      BEGIN SELECT RAISE(ABORT, 'test counter failure'); END;`);
    await expect(w.restore()).rejects.toThrow("test counter failure");
    expect(await w.counter()).toBe(0);
    expect(await w.find(issued.secret)).toBeNull();
  });
});

it("holds wallet disposal for an in-flight restore and refuses another writer during the scan", async () => {
  const mint = new FakeMint();
  mint.start();
  const dir = mkdtempSync(join(tmpdir(), "routstrd-proof-restore-"));
  cleanups.push(() => { mint.stop(); rmSync(dir, { recursive: true, force: true }); });
  const preflight = new Database(join(dir, "coco.db"));
  try {
    const repo = new SqliteRepositories({ database: preflight });
    await repo.init();
    for (const mintUrl of DEFAULT_TRUSTED_MINT_URLS) {
      await repo.mintRepository.addNewMint({
        mintUrl, name: "test", mintInfo: {} as never, trusted: true, createdAt: 1, updatedAt: 1,
      });
    }
  } finally { preflight.close(); }
  writeFileSync(join(dir, "config.json"), JSON.stringify({
    version: 1, encrypted: false, defaultMintUrl: mint.url,
    mnemonic: "abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about",
  }));
  const original = Manager.prototype.enableProofStateWatcher;
  const watcher = spyOn(Manager.prototype, "enableProofStateWatcher").mockImplementation(function (this: Manager, ...args) {
    return original.apply(this, args);
  });
  cleanups.push(() => watcher.mockRestore());
  const client = await createCocoClient({ walletDir: dir, legacySocketPath: join(dir, "legacy.sock"),
    legacyPidPath: join(dir, "legacy.pid"), enableNpc: false });
  cleanups.push(() => client.dispose!());
  await client.recoverMint!(mint.url);
  expect(watcher.mock.calls).toEqual([[{ watchExistingInflightOnStart: false }], [{ watchExistingInflightOnStart: false }]]);
  let release!: () => void;
  mint.restoreGate = new Promise<void>((resolve) => { release = resolve; });
  const previous = mint.restoreRequests;
  const restore = client.recoverMint!(mint.url);
  const settled = restore.catch((error) => error);
  try {
    const deadline = Date.now() + 3000;
    while (mint.restoreRequests === previous && Date.now() < deadline) await Bun.sleep(5);
    expect(mint.restoreRequests).toBeGreaterThan(previous);
    await expect(client.cleanupStuckOperations!()).rejects.toThrow("restore is in progress");
    let disposed = false;
    const shutdown = client.dispose!().then(() => { disposed = true; });
    await Bun.sleep(20);
    expect(disposed).toBe(false);
    release();
    expect(await settled).toBeInstanceOf(Error);
    await shutdown;
    expect(watcher.mock.calls).toHaveLength(2);
  } finally {
    release();
    await settled;
  }
}, 15_000);
