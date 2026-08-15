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

  onInit(ctx: { registerExtension: (key: string, api: unknown) => void }) {
    ctx.registerExtension("npc", this.api);
    return () => {};
  }
}

mock.module("coco-cashu-plugin-npc", () => ({
  NPCPlugin: MockNPCPlugin,
}));

const { createCocoClient } = await import("./coco-client");
const { createCocodClient, CocodHttpError } = await import("./cocod-client");

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
}

afterEach(() => {
  resetNpcState();
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

describe("in-process coco client NPC integration", () => {
  it("registers the plugin and exposes the wallet's NPC lightning address", async () => {
    const client = await createCocoClient(testClientOptions());
    try {
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

  it("triggers a manual quote sync", async () => {
    const client = await createCocoClient(testClientOptions());
    try {
      await client.syncNpc();
      expect(npcState.syncCalls).toBe(1);
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
    } finally {
      await client.dispose?.();
    }
  });
});

describe("legacy cocod client NPC passthroughs", () => {
  type FetchImpl = (
    input: string | URL | Request,
    init?: RequestInit & { unix: string },
  ) => Promise<Response>;

  function legacyClient(handler: (path: string, body?: unknown) => Response) {
    const requests: Array<{ path: string; body?: unknown }> = [];
    const fetchImpl: FetchImpl = async (input, init) => {
      const path = String(input).replace("http://localhost", "");
      const body =
        typeof init?.body === "string" ? JSON.parse(init.body) : undefined;
      if (path !== "/ping") requests.push({ path, body });
      if (path === "/ping") {
        return new Response(JSON.stringify({ output: "pong" }));
      }
      return handler(path, body);
    };
    const client = createCocodClient({
      socketPath: "/tmp/routstrd-test-legacy-npc/cocod.sock",
      fetchImpl,
    });
    return { client, requests };
  }

  it("fetches and parses a username NPC address", async () => {
    const { client, requests } = legacyClient(
      () => new Response(JSON.stringify({ output: "alice@npubx.cash" })),
    );
    const info = await client.getNpcAddress();
    expect(info).toEqual({ address: "alice@npubx.cash", name: "alice" });
    expect(requests[0]?.path).toBe("/npc/address");
  });

  it("omits the name for npub fallback addresses", async () => {
    const { client } = legacyClient(
      () =>
        new Response(JSON.stringify({ output: "npub1abc123@npubx.cash" })),
    );
    const info = await client.getNpcAddress();
    expect(info).toEqual({ address: "npub1abc123@npubx.cash" });
  });

  it("posts username claims with the confirm flag", async () => {
    const { client, requests } = legacyClient(
      () => new Response(JSON.stringify({ output: { success: true } })),
    );
    const result = await client.setNpcUsername("bob", true);
    expect(result).toEqual({ success: true });
    expect(requests[0]).toEqual({
      path: "/npc/username",
      body: { username: "bob", confirm: true },
    });
  });

  it("preserves the 402 payment-required error from cocod", async () => {
    const { client } = legacyClient(
      () =>
        new Response(
          JSON.stringify({ error: "Payment required to set username" }),
          { status: 402 },
        ),
    );
    try {
      await client.setNpcUsername("bob");
      expect.unreachable("should have thrown");
    } catch (error) {
      expect(error).toBeInstanceOf(CocodHttpError);
      expect((error as InstanceType<typeof CocodHttpError>).status).toBe(402);
      expect((error as Error).message).toContain("Payment required");
    }
  });

  it("reports manual sync as unsupported", async () => {
    const { client } = legacyClient(
      () => new Response(JSON.stringify({ output: {} })),
    );
    await expect(client.syncNpc()).rejects.toThrow("not supported");
  });
});
