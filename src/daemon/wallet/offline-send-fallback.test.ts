import { describe, expect, it, mock, spyOn } from "bun:test";
import { Database } from "bun:sqlite";
import { Manager, getDecodedToken, type CoreProof } from "@cashu/coco-core";
import { SqliteRepositories } from "@cashu/coco-sqlite-bun";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createCocoClient, DEFAULT_TRUSTED_MINT_URLS } from "./coco-client";

const MINT = DEFAULT_TRUSTED_MINT_URLS[0]!;
const OTHER_MINT = DEFAULT_TRUSTED_MINT_URLS[1]!;
const POINT = "0279be667ef9dcbbac55a06295ce870b07029bfcdb2dce28d959f2815b16f81798";
const KEYSET = "0011223344556677";
const proof = (amount: number, secret: string): CoreProof => ({
  mintUrl: MINT, amount, secret, id: KEYSET, C: POINT, state: "ready",
});

describe("offline send online fallback", () => {
  for (const changedAfterPreview of [false, true]) {
    it(`keeps the original mint and automatically settles (${changedAfterPreview ? "prepare race" : "preview cap"})`, async () => {
      const dir = mkdtempSync(join(tmpdir(), "routstrd-fallback-"));
      const database = new Database(join(dir, "coco.db"));
      const repo = new SqliteRepositories({ database });
      await repo.init();
      for (const mintUrl of DEFAULT_TRUSTED_MINT_URLS) {
        await repo.mintRepository.addNewMint({
          mintUrl, name: "Test mint", mintInfo: {}, trusted: true, createdAt: 1, updatedAt: 1,
        } as never);
      }
      writeFileSync(join(dir, "config.json"), JSON.stringify({
        version: 1, encrypted: false, defaultMintUrl: MINT,
        mnemonic: "abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about",
      }));

      // Capture the real Manager without adding production-only test hooks.
      let manager!: Manager;
      const initPlugins = Manager.prototype.initPlugins;
      const capture = spyOn(Manager.prototype, "initPlugins").mockImplementation(function (this: Manager) {
        manager = this;
        return initPlugins.call(this);
      });
      let client: Awaited<ReturnType<typeof createCocoClient>> | undefined;
      try {
        client = await createCocoClient({
          walletDir: dir, legacySocketPath: join(dir, "legacy.sock"),
          legacyPidPath: join(dir, "legacy.pid"), enableNpc: false,
        });
        capture.mockRestore();
        const deadline = Date.now() + 5000;
        while (await client.getStatus() !== "UNLOCKED") {
          if (Date.now() > deadline) throw new Error("Recovery did not finish");
          await Bun.sleep(5);
        }
        const internals = manager as unknown as {
          proofRepository: SqliteRepositories["proofRepository"];
          walletService: { getWalletWithActiveKeysetId: (...args: unknown[]) => Promise<unknown> };
          proofService: {
            selectProofsToSend: (...args: unknown[]) => Promise<CoreProof[]>;
            createOutputsAndIncrementCounters: (...args: unknown[]) => Promise<unknown>;
            setProofState: (mint: string, secrets: string[], state: string) => Promise<void>;
          };
          proofStateWatcher: { watchProof: (mint: string, secrets: string[]) => Promise<void> };
        };
        await repo.proofRepository.saveProofs(MINT, [proof(1024, "large")]);
        const outgoing = proof(100, "outgoing");
        const change = proof(924, "change");
        const swap = mock(async () => ({ send: [outgoing], keep: [change] }));
        internals.walletService.getWalletWithActiveKeysetId = async () => ({
          wallet: { unit: "sat", getFeesForProofs: () => 0, send: swap },
        });
        internals.proofService.selectProofsToSend = async () =>
          repo.proofRepository.getAvailableProofs(MINT);
        const output = (p: CoreProof) => ({
          blindedMessage: { amount: p.amount, id: KEYSET, B_: POINT },
          blindingFactor: 1n, secret: new TextEncoder().encode(p.secret),
        });
        internals.proofService.createOutputsAndIncrementCounters = async () => ({
          send: [output(outgoing)], keep: [output(change)],
        });
        // Keep network transport fake, but retain real send handlers, repositories,
        // proof events and the watcher's automatic finalization listener.
        const watchProof = mock(async (_mint: string, _secrets: string[]) => {});
        internals.proofStateWatcher.watchProof = watchProof;
        const available = internals.proofRepository.getAvailableProofs.bind(internals.proofRepository);
        let reads = 0;
        internals.proofRepository.getAvailableProofs = async (mintUrl) => {
          reads++;
          if (reads === 1) {
            await client!.setDefaultMint(OTHER_MINT);
            // Model another send removing the exact-value proof after preview.
            if (changedAfterPreview) return [proof(100, "preview-only")];
          }
          return available(mintUrl);
        };

        const result = await client.sendCashuOffline(100, undefined, { overpayCap: 3 });
        expect(await client.getDefaultMint()).toBe(OTHER_MINT);
        expect(result).toMatchObject({ mintUrl: MINT, mode: "online", actualAmount: 100, overpayment: 0 });
        expect(getDecodedToken(result.token).proofs.reduce((sum, p) => sum + p.amount, 0)).toBe(100);
        expect(swap).toHaveBeenCalledTimes(1);
        expect(watchProof).toHaveBeenCalledWith(MINT, ["outgoing"]);
        expect((await manager.ops.send.get(result.operationId))?.method).toBe("default");
        await expect(client.markSendSpent(result.operationId)).rejects.toThrow("Only offline");
        await internals.proofService.setProofState(MINT, ["outgoing"], "spent");
        expect((await manager.ops.send.get(result.operationId))?.state).toBe("finalized");
        expect(await manager.ops.send.listPrepared()).toHaveLength(0);
      } finally {
        capture.mockRestore();
        await client?.dispose?.();
        database.close();
        rmSync(dir, { recursive: true, force: true });
      }
    });
  }
});
