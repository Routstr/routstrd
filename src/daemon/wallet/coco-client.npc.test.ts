import { afterEach, describe, expect, it, mock } from "bun:test";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";

// The real NPCPlugin opens a websocket to npubx.cash once the wallet is ready.
// Mock the module before importing coco-client so tests never touch the network.
const npcState = {
  info: { name: "alice" as string | null, pubkey: "ab".repeat(32) },
  usernameResult: { success: true } as
    | { success: true }
    | { success: false; pr: { amount: number; mints: string[] } },
  setUsernameCalls: [] as Array<{ username: string; attemptPayment?: boolean }>,
  syncCalls: 0,
  pluginOptions: [] as Array<{
    useWebsocket?: boolean;
    syncIntervalMs?: number;
  }>,
};

class MockNPCPlugin {
  readonly name = "npc";
  readonly required = [] as const;
  private readonly api = {
    getInfo: async () => npcState.info,
    setUsername: async (username: string, attemptPayment?: boolean) => {
      npcState.setUsernameCalls.push({ username, attemptPayment });
      return npcState.usernameResult;
    },
    sync: async () => {
      npcState.syncCalls += 1;
    },
  };

  constructor(
    _baseUrl: string,
    _signer: unknown,
    options?: { useWebsocket?: boolean; syncIntervalMs?: number },
  ) {
    npcState.pluginOptions.push({
      useWebsocket: options?.useWebsocket,
      syncIntervalMs: options?.syncIntervalMs,
    });
  }

  onInit(ctx: { registerExtension: (key: string, api: unknown) => void }) {
    ctx.registerExtension("npc", this.api);
    return () => {};
  }
}

mock.module("coco-cashu-plugin-npc", () => ({
  NPCPlugin: MockNPCPlugin,
}));

const { createCocoClient } = await import("./coco-client");

const TEST_MNEMONIC =
  "abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about";

const tempDirs: string[] = [];

function makeWalletDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "routstrd-coco-npc-test-"));
  tempDirs.push(dir);
  const walletDir = join(dir, "wallet");
  mkdirSync(walletDir, { recursive: true });
  writeFileSync(
    join(walletDir, "config.json"),
    JSON.stringify({ version: 1, mnemonic: TEST_MNEMONIC, encrypted: false }),
  );
  return walletDir;
}

function testClientOptions(walletDir = makeWalletDir()) {
  return {
    walletDir,
    legacySocketPath: join(walletDir, "legacy-cocod.sock"),
    legacyPidPath: join(walletDir, "legacy-cocod.pid"),
  };
}

function resetNpcState(): void {
  npcState.info = { name: "alice", pubkey: "ab".repeat(32) };
  npcState.usernameResult = { success: true };
  npcState.setUsernameCalls = [];
  npcState.syncCalls = 0;
  npcState.pluginOptions = [];
}

// The daemon fires a catch-up sync in the background once wallet recovery
// completes, so tests that assert on sync() calls must first wait for it.
async function waitForNpcSyncs(count: number, timeoutMs = 2_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (npcState.syncCalls < count) {
    if (Date.now() > deadline) {
      throw new Error(
        `timed out waiting for ${count} NPC sync calls (saw ${npcState.syncCalls})`,
      );
    }
    await Bun.sleep(5);
  }
}

afterEach(() => {
  resetNpcState();
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

describe("in-process coco client NPC integration", () => {
  it("registers the plugin with the interval fallback and exposes the NPC address", async () => {
    const client = await createCocoClient(testClientOptions());
    try {
      expect(npcState.pluginOptions).toEqual([
        { useWebsocket: true, syncIntervalMs: 5 * 60_000 },
      ]);
      const info = await client.getNpcAddress();
      expect(info).toEqual({
        address: "alice@npubx.cash",
        name: "alice",
        pubkey: "ab".repeat(32),
      });
    } finally {
      await client.dispose?.();
    }
  });

  it("falls back to the npub address when no username is set", async () => {
    npcState.info = { name: null, pubkey: "ab".repeat(32) };
    const client = await createCocoClient(testClientOptions());
    try {
      const info = await client.getNpcAddress();
      expect(info.address).toStartWith("npub1");
      expect(info.address).toEndWith("@npubx.cash");
      expect(info.name).toBeUndefined();
      expect(info.pubkey).toBe("ab".repeat(32));
    } finally {
      await client.dispose?.();
    }
  });

  it("maps payment-required username claims without paying", async () => {
    npcState.usernameResult = {
      success: false,
      pr: { amount: 21, mints: ["https://mint.example.com"] },
    };
    const client = await createCocoClient(testClientOptions());
    try {
      const result = await client.setNpcUsername("bob");
      expect(result).toEqual({
        success: false,
        paymentRequest: { amount: 21, mints: ["https://mint.example.com"] },
      });
      expect(npcState.setUsernameCalls).toEqual([
        { username: "bob", attemptPayment: false },
      ]);
    } finally {
      await client.dispose?.();
    }
  });

  it("confirms the claim fee payment when requested", async () => {
    const client = await createCocoClient(testClientOptions());
    try {
      const result = await client.setNpcUsername("bob", true);
      expect(result).toEqual({ success: true });
      expect(npcState.setUsernameCalls).toEqual([
        { username: "bob", attemptPayment: true },
      ]);
    } finally {
      await client.dispose?.();
    }
  });

  it("does not fire the catch-up sync when disposal starts during recovery", async () => {
    // createCocoClient returns while background recovery is still running, so
    // this disposes on a wallet whose recovery has not settled yet.
    const client = await createCocoClient(testClientOptions());
    try {
      // dispose() quiesces the wallet synchronously, so recovery settles on a
      // wallet that is already shutting down. Its catch-up must never run:
      // plugin shutdown waits for in-flight syncs and an NPC request has no
      // timeout, so that work would delay closing the database and releasing
      // the wallet lock.
      await (client.dispose?.() ?? Promise.resolve());
      await Bun.sleep(50);
      expect(npcState.syncCalls).toBe(0);
    } finally {
      await client.dispose?.().catch(() => {});
    }
  });

  it("triggers a manual quote sync", async () => {
    const client = await createCocoClient(testClientOptions());
    try {
      // Recovery fires exactly one automatic catch-up, so this test only
      // measures the explicit syncNpc() call on top of it.
      await waitForNpcSyncs(1);
      expect(npcState.syncCalls).toBe(1);
      const baseline = npcState.syncCalls;
      await client.syncNpc();
      expect(npcState.syncCalls).toBe(baseline + 1);
    } finally {
      await client.dispose?.();
    }
  });

  it("rejects NPC calls with a clear error when the plugin is disabled", async () => {
    const client = await createCocoClient({
      ...testClientOptions(),
      enableNpc: false,
    });
    try {
      await expect(client.getNpcAddress()).rejects.toThrow(
        "NPC plugin is not enabled",
      );
      await expect(client.syncNpc()).rejects.toThrow(
        "NPC plugin is not enabled",
      );
      // No plugin means no interval fallback and no automatic catch-up sync.
      expect(npcState.pluginOptions).toEqual([]);
      expect(npcState.syncCalls).toBe(0);
    } finally {
      await client.dispose?.();
    }
  });
});
