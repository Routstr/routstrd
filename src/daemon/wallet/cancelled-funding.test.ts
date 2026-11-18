import { describe, expect, it, mock, spyOn } from "bun:test";
import { Manager, SendOpsApi } from "@cashu/coco-core";
import { SqliteRepositories } from "@cashu/coco-sqlite-bun";
import { Database } from "bun:sqlite";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createCocoClient, DEFAULT_TRUSTED_MINT_URLS } from "./coco-client";
import { createWalletAdapter } from "./index";

function gate() {
  let release!: () => void;
  const promise = new Promise<void>((resolve) => { release = resolve; });
  return { promise, release };
}

describe("cancelled request funding", () => {
  it("forwards the signal through the adapter and does not start a pre-aborted send", async () => {
    const controller = new AbortController();
    const sendCashu = mock(async () => "cashu_test");
    const adapter = await createWalletAdapter({ walletClient: {
      sendCashu, getBalances: async () => [], listMints: async () => [],
      getDefaultMint: async () => null,
    } as any });
    expect(await adapter.sendToken("https://mint.invalid", 7, undefined, undefined, controller.signal)).toBe("cashu_test");
    expect(sendCashu).toHaveBeenCalledWith(7, "https://mint.invalid", controller.signal);
    controller.abort();
    await expect(adapter.sendToken("https://mint.invalid", 7, undefined, undefined, controller.signal)).rejects.toMatchObject({ name: "AbortError" });
    expect(sendCashu).toHaveBeenCalledTimes(1);
  });

  it("does not prepare a Coco send when cancelled while waiting for recovery", async () => {
    const dir = mkdtempSync(join(tmpdir(), "routstrd-cancel-funding-"));
    const db = new Database(join(dir, "coco.db"));
    const repos = new SqliteRepositories({ database: db });
    await repos.init();
    for (const mintUrl of DEFAULT_TRUSTED_MINT_URLS) {
      await repos.mintRepository.addNewMint({ mintUrl, name: "Test", mintInfo: {},
        trusted: true, createdAt: 1, updatedAt: 1 } as never);
    }
    writeFileSync(join(dir, "config.json"), JSON.stringify({ version: 1, encrypted: false,
      defaultMintUrl: DEFAULT_TRUSTED_MINT_URLS[0],
      mnemonic: "abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about" }));
    const entered = gate(); const release = gate();
    let manager!: Manager;
    const original = Manager.prototype.initPlugins;
    const capture = spyOn(Manager.prototype, "initPlugins").mockImplementation(function (this: Manager) {
      manager = this; return original.call(this);
    });
    const list = SendOpsApi.prototype.listInFlight;
    const recovery = spyOn(SendOpsApi.prototype, "listInFlight").mockImplementationOnce(async function (this: SendOpsApi) {
      entered.release(); await release.promise; return list.call(this);
    });
    let client: Awaited<ReturnType<typeof createCocoClient>> | undefined;
    try {
      client = await createCocoClient({ walletDir: dir, enableNpc: false,
        legacySocketPath: join(dir, "legacy.sock"), legacyPidPath: join(dir, "legacy.pid") });
      await entered.promise;
      const prepare = spyOn(manager.ops.send, "prepare");
      const controller = new AbortController();
      const pending = client.sendCashu(7, DEFAULT_TRUSTED_MINT_URLS[0], controller.signal);
      controller.abort(); release.release();
      await expect(pending).rejects.toMatchObject({ name: "AbortError" });
      expect(prepare).not.toHaveBeenCalled();
      prepare.mockRestore();
    } finally {
      release.release(); recovery.mockRestore(); capture.mockRestore(); await client?.dispose?.();
      db.close(); rmSync(dir, { recursive: true, force: true });
    }
  });
});
