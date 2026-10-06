import { afterEach, beforeEach, describe, expect, it, mock, spyOn } from "bun:test";
import { gunzipSync } from "bun";
import {
  existsSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "fs";
import { tmpdir } from "os";
import { join } from "path";
import {
  assertLegacyCocodNotRunning,
  claimLegacyCocodPidFile,
  createCocoClient,
  createRecoveryGate,
  createRunQueue,
  DEFAULT_TRUSTED_MINT_URLS,
  failExpiredMintQuoteIfUnpaid,
  isZombieProcess,
  reopenFailedMintOperation,
  runMintQuoteRecovery,
  runWalletDoctor,
  settleExpiredMintQuotes,
  settlePendingMintQuotes,
  stopLegacyCocod,
  type ExpiredMintQuoteSource,
  type MintQuoteRecoverySource,
  type PendingMintQuoteSource,
  type PendingMintSweepState,
  type WalletDoctorSource,
} from "./coco-client";
import { OperationInProgressError } from "@cashu/coco-core";
import { logger } from "../../utils/logger";

type GuardOptions = NonNullable<
  Parameters<typeof assertLegacyCocodNotRunning>[0]
>;
type LegacyFetch = NonNullable<GuardOptions["fetchImpl"]>;

const SOCKET_PATH = "/tmp/routstrd-test/cocod.sock";
const PID_FILE_PATH = "/tmp/routstrd-test/cocod.pid";
const tempDirs: string[] = [];

function makeTempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "routstrd-coco-migration-test-"));
  tempDirs.push(dir);
  return dir;
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

function socketOnly(path: string): boolean {
  return path === SOCKET_PATH;
}

async function waitForWalletUnlocked(
  client: Awaited<ReturnType<typeof createCocoClient>>,
): Promise<void> {
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    const status = await client.getStatus();
    if (status === "UNLOCKED") return;
    if (status === "ERROR") throw new Error("Wallet recovery failed");
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error("Timed out waiting for wallet recovery to complete");
}

describe("default mint functionality", () => {
  it("automatically adds the shipped trusted mints when no mints exist", async () => {
    const walletDir = join(makeTempDir(), "wallet");
    mkdirSync(walletDir, { recursive: true });
    writeFileSync(
      join(walletDir, "config.json"),
      JSON.stringify({
        version: 1,
        mnemonic:
          "abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about",
        encrypted: false,
      }),
    );

    const client = await createCocoClient({
      walletDir,
      legacySocketPath: join(walletDir, "legacy-cocod.sock"),
      legacyPidPath: join(walletDir, "legacy-cocod.pid"),
    });
    try {
      expect(readFileSync(join(walletDir, "wallet.pid"), "utf8")).toBe(
        String(process.pid),
      );
      expect(readFileSync(join(walletDir, "legacy-cocod.pid"), "utf8")).toBe(
        String(process.pid),
      );

      // Every shipped mint is trusted, so each one is usable without an
      // explicit `wallet mints add`.
      const mints = await client.listMints();
      expect(mints).toEqual(expect.arrayContaining([...DEFAULT_TRUSTED_MINT_URLS]));

      // Minibits owns the default slot even though Cuba is trusted too.
      const defaultMint = await client.getDefaultMint();
      expect(defaultMint).toBe("https://mint.minibits.cash/Bitcoin");
    } finally {
      await client.dispose?.();
    }
    expect(existsSync(join(walletDir, "wallet.pid"))).toBe(false);
    expect(existsSync(join(walletDir, "legacy-cocod.pid"))).toBe(false);
  });

  it("respects existing default mint in config", async () => {
    const walletDir = join(makeTempDir(), "wallet");
    const configuredDefault = "https://mint.cubabitcoin.org";
    mkdirSync(walletDir, { recursive: true });

    // Create config with an explicit defaultMint
    writeFileSync(
      join(walletDir, "config.json"),
      JSON.stringify({
        version: 1,
        mnemonic:
          "abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about",
        encrypted: false,
        defaultMintUrl: configuredDefault,
      }),
    );

    const client = await createCocoClient({
      walletDir,
      legacySocketPath: join(walletDir, "legacy-cocod.sock"),
      legacyPidPath: join(walletDir, "legacy-cocod.pid"),
    });
    try {
      // Should respect the configured default mint
      const defaultMint = await client.getDefaultMint();
      expect(defaultMint).toBe(configuredDefault);

      // The mint should have been auto-added as trusted
      const mints = await client.listMints();
      expect(mints).toContain(configuredDefault);
    } finally {
      await client.dispose?.();
    }
  });

  it("allows setting default mint to an already trusted mint", async () => {
    const walletDir = join(makeTempDir(), "wallet");
    mkdirSync(walletDir, { recursive: true });
    writeFileSync(
      join(walletDir, "config.json"),
      JSON.stringify({
        version: 1,
        mnemonic:
          "abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about",
        encrypted: false,
      }),
    );

    const client = await createCocoClient({
      walletDir,
      legacySocketPath: join(walletDir, "legacy-cocod.sock"),
      legacyPidPath: join(walletDir, "legacy-cocod.pid"),
    });
    try {
      // The initial default should be the auto-added Minibits mint
      const initialDefault = await client.getDefaultMint();
      expect(initialDefault).toBe("https://mint.minibits.cash/Bitcoin");

      // Setting the same mint should work
      const message = await client.setDefaultMint(
        "https://mint.minibits.cash/Bitcoin",
      );
      expect(message).toContain("https://mint.minibits.cash/Bitcoin");

      const defaultMint = await client.getDefaultMint();
      expect(defaultMint).toBe("https://mint.minibits.cash/Bitcoin");
    } finally {
      await client.dispose?.();
    }
  });
});

describe("legacy cocod wallet migration", () => {
  it("opens an existing unencrypted config and preserves database balances", async () => {
    const walletDir = join(makeTempDir(), "wallet");
    const mintUrl = "https://mint.example.com";
    mkdirSync(walletDir, { recursive: true });

    // Note: Setting defaultMint to Cuba mint because the fixture database
    // apparently doesn't preserve trusted mints correctly across coco-core versions,
    // and we can't contact the example.com mint. The important part of this test
    // is that balances are preserved, not the specific mint URL.
    writeFileSync(
      join(walletDir, "config.json"),
      JSON.stringify({
        version: 1,
        mnemonic:
          "abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about",
        encrypted: false,
        defaultMintUrl: "https://mint.cubabitcoin.org",
      }),
    );

    // This fixture was generated with @routstr/cocod 0.0.24 using its
    // coco-cashu-sqlite-bun 1.1.2-rc.50 adapter. Keeping it frozen prevents
    // this test from accidentally creating its "legacy" database with the
    // same current adapter that createCocoClient uses to read it.
    const fixture = readFileSync(
      join(import.meta.dir, "fixtures", "cocod-0.0.24-wallet.db.gz"),
    );
    writeFileSync(join(walletDir, "coco.db"), gunzipSync(fixture));

    // NPC is disabled here: this test verifies database migration, and the
    // real plugin would otherwise open a websocket to npubx.cash.
    const client = await createCocoClient({
      walletDir,
      legacySocketPath: join(walletDir, "legacy-cocod.sock"),
      legacyPidPath: join(walletDir, "legacy-cocod.pid"),
      enableNpc: false,
    });
    try {
      await waitForWalletUnlocked(client);
      expect(await client.getBalances()).toEqual({ [mintUrl]: 10 });
    } finally {
      await client.dispose?.();
    }

    // Prove the migrated schema remains reopenable and the pre-existing
    // proofs survive a complete in-process wallet restart.
    const reopenedClient = await createCocoClient({
      walletDir,
      legacySocketPath: join(walletDir, "legacy-cocod.sock"),
      legacyPidPath: join(walletDir, "legacy-cocod.pid"),
      enableNpc: false,
    });
    try {
      expect(await reopenedClient.getBalances()).toEqual({ [mintUrl]: 10 });
    } finally {
      await reopenedClient.dispose?.();
    }
  });
});

describe("isZombieProcess", () => {
  it("recognizes Linux proc stat zombie state", () => {
    expect(
      isZombieProcess(4242, () => "4242 (routstrd worker) Z 1 4242 4242"),
    ).toBe(true);
  });

  it("does not mistake a running process or unreadable proc entry for a zombie", () => {
    expect(isZombieProcess(4242, () => "4242 (bun) S 1 4242 4242")).toBe(false);
    expect(
      isZombieProcess(4242, () => {
        throw Object.assign(new Error("missing"), { code: "ENOENT" });
      }),
    ).toBe(false);
  });
});

describe("assertLegacyCocodNotRunning", () => {
  it("does not probe when the legacy socket does not exist", async () => {
    const fetchImpl = mock<LegacyFetch>(async () => new Response("pong"));

    await assertLegacyCocodNotRunning({
      socketPath: SOCKET_PATH,
      pathExists: () => false,
      fetchImpl,
    });

    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("refuses to continue when cocod responds on the legacy socket", async () => {
    const fetchImpl = mock<LegacyFetch>(async () =>
      Response.json({ output: "pong" }),
    );

    await expect(
      assertLegacyCocodNotRunning({
        socketPath: SOCKET_PATH,
        pathExists: socketOnly,
        fetchImpl,
      }),
    ).rejects.toThrow("Legacy cocod daemon is still running");

    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(fetchImpl.mock.calls[0]?.[0]).toBe("http://localhost/ping");
    expect(fetchImpl.mock.calls[0]?.[1]).toMatchObject({ unix: SOCKET_PATH });
  });

  it.each(["ENOENT", "ECONNREFUSED", "FailedToOpenSocket"])(
    "allows startup for a stale socket that fails with %s",
    async (code) => {
      const fetchImpl = mock<LegacyFetch>(async () => {
        throw Object.assign(new Error("socket unavailable"), { code });
      });

      await expect(
        assertLegacyCocodNotRunning({
          socketPath: SOCKET_PATH,
          pathExists: socketOnly,
          fetchImpl,
        }),
      ).resolves.toBeUndefined();
    },
  );

  it("recognizes stale socket errors nested under cause", async () => {
    const fetchImpl = mock<LegacyFetch>(async () => {
      throw new TypeError("fetch failed", {
        cause: Object.assign(new Error("connection refused"), {
          code: "ECONNREFUSED",
        }),
      });
    });

    await expect(
      assertLegacyCocodNotRunning({
        socketPath: SOCKET_PATH,
        pathExists: socketOnly,
        fetchImpl,
      }),
    ).resolves.toBeUndefined();
  });

  it("allows a live shared PID owner when no cocod socket exists", async () => {
    const fetchImpl = mock<LegacyFetch>(async () =>
      Response.json({ output: "pong" }),
    );

    await expect(
      assertLegacyCocodNotRunning({
        socketPath: SOCKET_PATH,
        pathExists: (path) => path === PID_FILE_PATH,
        fetchImpl,
      }),
    ).resolves.toBeUndefined();

    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("allows a live shared PID owner when the cocod socket is stale", async () => {
    const fetchImpl = mock<LegacyFetch>(async () => {
      throw Object.assign(new Error("socket unavailable"), {
        code: "ECONNREFUSED",
      });
    });

    await expect(
      assertLegacyCocodNotRunning({
        socketPath: SOCKET_PATH,
        pathExists: () => true,
        fetchImpl,
      }),
    ).resolves.toBeUndefined();
  });

  it("fails closed when the socket cannot be probed safely", async () => {
    const fetchImpl = mock<LegacyFetch>(async () => {
      throw Object.assign(new Error("permission denied"), { code: "EACCES" });
    });

    await expect(
      assertLegacyCocodNotRunning({
        socketPath: SOCKET_PATH,
        pathExists: socketOnly,
        fetchImpl,
      }),
    ).rejects.toThrow("Cannot verify whether the legacy cocod daemon has stopped");
  });
});

describe("stopLegacyCocod", () => {
  it("stops a live PID only when legacy cocod responds on its socket", async () => {
    let running = true;
    const killProcess = mock((_pid: number, _signal: NodeJS.Signals) => {
      running = false;
    });
    const fetchImpl = mock<LegacyFetch>(async () =>
      Response.json({ output: "pong" }),
    );

    await stopLegacyCocod({
      socketPath: SOCKET_PATH,
      pidFilePath: PID_FILE_PATH,
      pathExists: () => true,
      readFile: () => "4242\n",
      isProcessRunning: () => running,
      fetchImpl,
      killProcess,
      pollIntervalMs: 1,
      timeoutMs: 50,
    });

    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(killProcess).toHaveBeenCalledWith(4242, "SIGTERM");
  });

  it("does not kill a routstrd PID that owns the shared pidfile with a stale socket", async () => {
    const killProcess = mock((_pid: number, _signal: NodeJS.Signals) => {});
    const fetchImpl = mock<LegacyFetch>(async () => {
      throw Object.assign(new Error("socket unavailable"), {
        code: "ECONNREFUSED",
      });
    });

    await stopLegacyCocod({
      socketPath: SOCKET_PATH,
      pidFilePath: PID_FILE_PATH,
      pathExists: () => true,
      readFile: () => "4242\n",
      isProcessRunning: () => true,
      fetchImpl,
      killProcess,
    });

    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(killProcess).not.toHaveBeenCalled();
  });

  it("does not kill a live pidfile owner when no legacy socket exists", async () => {
    const killProcess = mock((_pid: number, _signal: NodeJS.Signals) => {});
    const fetchImpl = mock<LegacyFetch>(async () =>
      Response.json({ output: "pong" }),
    );

    await stopLegacyCocod({
      socketPath: SOCKET_PATH,
      pidFilePath: PID_FILE_PATH,
      pathExists: (path) => path === PID_FILE_PATH,
      readFile: () => "4242\n",
      isProcessRunning: () => true,
      fetchImpl,
      killProcess,
    });

    expect(fetchImpl).not.toHaveBeenCalled();
    expect(killProcess).not.toHaveBeenCalled();
  });
});

describe("claimLegacyCocodPidFile", () => {
  it("claims the PID file exclusively and releases its own claim", () => {
    let storedPid: string | undefined;
    let removed = false;
    const opened: Array<{ path: string; fd: number }> = [];

    const release = claimLegacyCocodPidFile({
      pidFilePath: PID_FILE_PATH,
      pid: 4242,
      openExclusive: (path) => {
        opened.push({ path, fd: 7 });
        return 7;
      },
      writePid: (fd, pid) => {
        expect(fd).toBe(7);
        storedPid = String(pid);
      },
      closeFile: (fd) => expect(fd).toBe(7),
      readFile: () => storedPid || "",
      removeFile: () => {
        removed = true;
      },
    });

    expect(opened).toEqual([{ path: PID_FILE_PATH, fd: 7 }]);
    expect(storedPid).toBe("4242");
    release();
    expect(removed).toBe(true);
  });

  it("refuses startup when another process wins the atomic claim", () => {
    expect(() =>
      claimLegacyCocodPidFile({
        pidFilePath: PID_FILE_PATH,
        openExclusive: () => {
          throw Object.assign(new Error("exists"), { code: "EEXIST" });
        },
        readFile: () => "4242",
        isProcessRunning: () => true,
      }),
    ).toThrow("PID 4242 is still running and holds it");
  });

  it("replaces a confirmed stale PID file before claiming it", () => {
    let openAttempts = 0;
    let removed = false;
    let storedPid = "4242";

    const release = claimLegacyCocodPidFile({
      pidFilePath: PID_FILE_PATH,
      pid: 9001,
      openExclusive: () => {
        openAttempts++;
        if (openAttempts === 1) {
          throw Object.assign(new Error("exists"), { code: "EEXIST" });
        }
        return 7;
      },
      readFile: () => storedPid,
      isProcessRunning: () => false,
      removeFile: () => {
        removed = true;
      },
      writePid: (_fd, pid) => {
        storedPid = String(pid);
      },
      closeFile: () => {},
    });

    expect(openAttempts).toBe(2);
    expect(removed).toBe(true);
    expect(storedPid).toBe("9001");
    release();
  });

  it("does not remove a PID file that no longer belongs to this process", () => {
    let removed = false;
    const release = claimLegacyCocodPidFile({
      pidFilePath: PID_FILE_PATH,
      pid: 4242,
      openExclusive: () => 7,
      writePid: () => {},
      closeFile: () => {},
      readFile: () => "9001",
      removeFile: () => {
        removed = true;
      },
    });

    release();
    expect(removed).toBe(false);
  });

  it("registers and removes synchronous process-exit cleanup", () => {
    const before = process.listenerCount("exit");
    const release = claimLegacyCocodPidFile({
      pidFilePath: PID_FILE_PATH,
      pid: 4242,
      openExclusive: () => 7,
      writePid: () => {},
      closeFile: () => {},
      readFile: () => "4242",
      removeFile: () => {},
    });

    expect(process.listenerCount("exit")).toBe(before + 1);
    release();
    expect(process.listenerCount("exit")).toBe(before);
  });
});

describe("settleExpiredMintQuotes", () => {
  const EXPIRED_S = 1_000_000; // epoch seconds, long past
  const NOW_MS = 2_000_000_000_000;

  function pendingMintOp(overrides: Record<string, unknown> = {}) {
    return {
      id: "op-1",
      mintUrl: "https://mint.example.com",
      quoteId: "quote-1",
      state: "pending",
      expiry: EXPIRED_S,
      updatedAt: NOW_MS - 60_000,
      lastObservedRemoteState: undefined,
      ...overrides,
    };
  }

  function fakeSource(
    ops: Array<Record<string, unknown>>,
    behavior: {
      observe?: (id: string) => Promise<{ category: "waiting" | "ready" | "completed" | "terminal" }>;
    } = {},
  ) {
    const failPendingOperation = mock(
      async (
        _op: { id: string },
        _failure: { reason: string; retryable?: boolean; observedAt: number },
      ) => ({}),
    );
    const observePendingOperation = mock(
      behavior.observe ??
        (async (
          _id: string,
        ): Promise<{ category: "waiting" | "ready" | "completed" | "terminal" }> => ({
          category: "waiting",
        })),
    );
    const source = {
      ops: { mint: { listPending: async () => ops } },
      mintOperationService: { observePendingOperation, failPendingOperation },
    } as unknown as ExpiredMintQuoteSource;
    return { source, observePendingOperation, failPendingOperation };
  }

  it("fails an expired quote locally when its mint confirms it is unpaid", async () => {
    const op = pendingMintOp();
    const { source, failPendingOperation } = fakeSource([op]);

    const result = await settleExpiredMintQuotes(source, NOW_MS);

    expect(result).toEqual({ failed: 1, leftForRecovery: 0, unobserved: 0 });
    expect(failPendingOperation).toHaveBeenCalledTimes(1);
    expect(failPendingOperation.mock.calls[0]?.[0]).toEqual({ id: "op-1" });
  });

  it("leaves an expired quote observed as PAID for mint recovery", async () => {
    const op = pendingMintOp();
    const { source, failPendingOperation } = fakeSource([op], {
      observe: async () => ({ category: "ready" }),
    });

    const result = await settleExpiredMintQuotes(source, NOW_MS);

    expect(result).toEqual({ failed: 0, leftForRecovery: 1, unobserved: 0 });
    expect(failPendingOperation).not.toHaveBeenCalled();
  });

  it("leaves an expired quote observed as ISSUED for mint recovery", async () => {
    const op = pendingMintOp();
    const { source, failPendingOperation } = fakeSource([op], {
      observe: async () => ({ category: "completed" }),
    });

    const result = await settleExpiredMintQuotes(source, NOW_MS);

    expect(result).toEqual({ failed: 0, leftForRecovery: 1, unobserved: 0 });
    expect(failPendingOperation).not.toHaveBeenCalled();
  });

  it("leaves quotes pending when their mint cannot be checked", async () => {
    const op = pendingMintOp();
    const { source, failPendingOperation } = fakeSource([op], {
      observe: async () => {
        throw new Error("Network request failed");
      },
    });

    const result = await settleExpiredMintQuotes(source, NOW_MS);

    expect(result).toEqual({ failed: 0, leftForRecovery: 0, unobserved: 1 });
    expect(failPendingOperation).not.toHaveBeenCalled();
  });

  it("stops observing once the shared deadline is exhausted", async () => {
    const ops = [
      pendingMintOp({ id: "op-1", quoteId: "q-1" }),
      pendingMintOp({ id: "op-2", quoteId: "q-2" }),
    ];
    const { source, failPendingOperation } = fakeSource(ops, {
      // A hung mint: the observation never settles.
      observe: () => new Promise(() => {}),
    });

    const started = Date.now();
    const result = await settleExpiredMintQuotes(source, NOW_MS, 50);

    expect(Date.now() - started).toBeLessThan(5_000);
    expect(result).toEqual({ failed: 0, leftForRecovery: 0, unobserved: 2 });
    expect(failPendingOperation).not.toHaveBeenCalled();
  });

  it("does not touch unexpired or already-observed quotes", async () => {
    const ops = [
      pendingMintOp({ id: "unexpired", expiry: NOW_MS / 1000 + 600 }),
      pendingMintOp({ id: "seen-paid", lastObservedRemoteState: "PAID" }),
      pendingMintOp({ id: "seen-issued", lastObservedRemoteState: "ISSUED" }),
    ];
    const { source, observePendingOperation, failPendingOperation } =
      fakeSource(ops);

    const result = await settleExpiredMintQuotes(source, NOW_MS);

    expect(result).toEqual({ failed: 0, leftForRecovery: 0, unobserved: 0 });
    expect(observePendingOperation).not.toHaveBeenCalled();
    expect(failPendingOperation).not.toHaveBeenCalled();
  });

  it("skips quotes at probe-unreachable mints without spending the budget", async () => {
    const ops = [
      pendingMintOp({ id: "dead-1", mintUrl: "https://dead.example.com" }),
      pendingMintOp({ id: "dead-2", mintUrl: "https://dead.example.com/" }),
      pendingMintOp({ id: "live-1", mintUrl: "https://live.example.com" }),
    ];
    const { source, observePendingOperation, failPendingOperation } =
      fakeSource(ops);

    const result = await settleExpiredMintQuotes(
      source,
      NOW_MS,
      undefined,
      { unreachableMints: new Set(["https://dead.example.com"]) },
    );

    expect(result).toEqual({ failed: 1, leftForRecovery: 0, unobserved: 2 });
    // Only the reachable mint was asked anything.
    expect(observePendingOperation).toHaveBeenCalledTimes(1);
    expect(observePendingOperation.mock.calls[0]?.[0]).toBe("live-1");
    expect(failPendingOperation).toHaveBeenCalledTimes(1);
  });
});

describe("settlePendingMintQuotes", () => {
  const NOW_MS = 2_000_000_000_000;
  const UNEXPIRED_S = NOW_MS / 1000 + 600;
  const EXPIRED_S = NOW_MS / 1000 - 1;
  const UNPAID = { state: "pending", lastObservedRemoteState: "UNPAID" };
  const MINTED = { state: "finalized", lastObservedRemoteState: "ISSUED" };
  let logged: ReturnType<typeof spyOn>;
  let warned: ReturnType<typeof spyOn>;

  beforeEach(() => {
    logged = spyOn(logger, "log").mockImplementation(() => {});
    warned = spyOn(logger, "warn").mockImplementation(() => {});
  });

  afterEach(() => {
    logged.mockRestore();
    warned.mockRestore();
  });

  function pendingMintOp(overrides: Record<string, unknown> = {}) {
    return {
      id: "op-1",
      mintUrl: "https://mint.example.com",
      quoteId: "quote-1",
      amount: 21,
      state: "pending",
      expiry: UNEXPIRED_S,
      lastObservedRemoteState: "UNPAID",
      ...overrides,
    };
  }

  function fakeSource(
    ops: Array<Record<string, unknown>>,
    behavior: {
      refresh?: (id: string) => Promise<Record<string, unknown>>;
      get?: (id: string) => Promise<Record<string, unknown> | null>;
    } = {},
  ) {
    const refresh = mock(behavior.refresh ?? (async () => UNPAID));
    const get = mock(behavior.get ?? (async (id: string) => ops.find((op) => op.id === id) ?? null));
    const failPendingOperation = mock(
      async (
        _op: { id: string },
        _failure: { reason: string; retryable?: boolean; observedAt: number },
      ) => ({}),
    );
    const source = {
      ops: { mint: { listPending: async () => ops, refresh, get } },
      wallet: {
        balances: {
          byMint: async () => ({ "https://mint.example.com": { spendable: 121 } }),
        },
      },
      mintOperationService: { failPendingOperation },
    } as unknown as PendingMintQuoteSource;
    return { source, refresh, get, failPendingOperation };
  }

  const attempted = (refresh: { mock: { calls: unknown[][] } }) =>
    refresh.mock.calls.map((call) => call[0]);

  it("refreshes every pending quote and logs the credit for the minted one", async () => {
    const ops = [pendingMintOp({ id: "op-1" }), pendingMintOp({ id: "op-2" })];
    const { source, refresh } = fakeSource(ops, {
      refresh: async (id) => (id === "op-1" ? MINTED : UNPAID),
    });

    const result = await settlePendingMintQuotes(source, NOW_MS);

    expect(result).toEqual({ unreachable: 0 });
    expect(attempted(refresh)).toEqual(["op-1", "op-2"]);
    expect(logged).toHaveBeenCalledTimes(1);
    expect(logged.mock.calls[0]?.[0]).toBe(
      "Mint quote quote-1 at https://mint.example.com: paid, 21 sat minted, balance now 121 sat",
    );
  });

  it("mints an expired quote that was paid before it expired", async () => {
    const { source, failPendingOperation } = fakeSource(
      [pendingMintOp({ expiry: EXPIRED_S })],
      { refresh: async () => MINTED },
    );

    await settlePendingMintQuotes(source, NOW_MS);

    expect(logged.mock.calls[0]?.[0]).toContain("21 sat minted");
    expect(failPendingOperation).not.toHaveBeenCalled();
  });

  it("fails an expired quote locally once its mint confirms it is unpaid", async () => {
    const { source, failPendingOperation } = fakeSource([
      pendingMintOp({ id: "expired", expiry: EXPIRED_S }),
      pendingMintOp({ id: "open" }),
    ]);

    await settlePendingMintQuotes(source, NOW_MS);

    expect(failPendingOperation).toHaveBeenCalledTimes(1);
    expect(failPendingOperation.mock.calls[0]?.[0]).toEqual({ id: "expired" });
  });

  it("reports an issued quote whose proofs could not be restored as a warning, not a credit", async () => {
    const { source } = fakeSource([pendingMintOp()], {
      refresh: async () => ({ ...MINTED, error: "no proofs could be restored" }),
    });

    await settlePendingMintQuotes(source, NOW_MS);

    expect(logged).not.toHaveBeenCalled();
    expect(warned.mock.calls[0]?.[0]).toContain("no proofs could be restored");
  });

  it("keeps going when a mint is unreachable and counts the failure", async () => {
    const ops = [pendingMintOp({ id: "op-1" }), pendingMintOp({ id: "op-2" })];
    const { source, refresh } = fakeSource(ops, {
      refresh: async (id) => {
        if (id === "op-1") throw new Error("Network request failed");
        return MINTED;
      },
    });

    const result = await settlePendingMintQuotes(source, NOW_MS);

    expect(result).toEqual({ unreachable: 1 });
    expect(refresh).toHaveBeenCalledTimes(2);
  });

  it("warns once for a paid quote whose mint attempt failed and keeps retrying", async () => {
    const failed = pendingMintOp({ lastObservedRemoteState: "PAID", error: "Mint request failed" });
    const { source } = fakeSource([pendingMintOp()], {
      refresh: async () => {
        throw new Error("Mint request failed");
      },
      get: async () => failed,
    });

    const first = await settlePendingMintQuotes(source, NOW_MS);
    // Next sweep sees the same persisted error: no second warning.
    const { source: again } = fakeSource([failed], {
      refresh: async () => {
        throw new Error("Mint request failed");
      },
      get: async () => failed,
    });
    const second = await settlePendingMintQuotes(again, NOW_MS);

    expect(first).toEqual({ unreachable: 0 });
    expect(second).toEqual({ unreachable: 0 });
    expect(warned).toHaveBeenCalledTimes(1);
    expect(warned.mock.calls[0]?.[0]).toContain("paid (21 sat) but proofs not minted yet");
  });

  it("leaves a quote coco's own watcher is already minting alone", async () => {
    const { source, get } = fakeSource([pendingMintOp()], {
      refresh: async () => {
        throw new OperationInProgressError("op-1");
      },
    });

    const result = await settlePendingMintQuotes(source, NOW_MS);

    expect(result).toEqual({ unreachable: 0 });
    expect(get).not.toHaveBeenCalled();
    expect(warned).not.toHaveBeenCalled();
  });

  it("survives a reporting failure without an unhandled rejection", async () => {
    const { source } = fakeSource([pendingMintOp()], {
      refresh: async () => {
        throw new Error("Network request failed");
      },
      get: async () => {
        throw new Error("Cannot use a closed database");
      },
    });

    const result = await settlePendingMintQuotes(source, NOW_MS);

    expect(result).toEqual({ unreachable: 1 });
  });

  it("gives a stalled quote one bounded wait and still serves the others", async () => {
    const ops = [pendingMintOp({ id: "slow" }), pendingMintOp({ id: "paid" })];
    const { source, refresh } = fakeSource(ops, {
      refresh: (id) => (id === "slow" ? new Promise(() => {}) : Promise.resolve(MINTED)),
    });
    const state: PendingMintSweepState = { outstanding: new Map() };
    const options = { deadlineMs: 1_000, checkTimeoutMs: 50, state };

    const first = await settlePendingMintQuotes(source, NOW_MS, options);
    const second = await settlePendingMintQuotes(source, NOW_MS, options);

    expect(first).toEqual({ unreachable: 1 });
    // Still outstanding, so it is skipped rather than re-sent.
    expect(second).toEqual({ unreachable: 1 });
    expect(attempted(refresh)).toEqual(["slow", "paid", "paid"]);
  });

  it("resumes after the last attempted quote so slow ones cannot starve the rest", async () => {
    const ops = [
      pendingMintOp({ id: "s1" }),
      pendingMintOp({ id: "s2" }),
      pendingMintOp({ id: "paid" }),
    ];
    // Slow refreshes settle between sweeps, so nothing is outstanding next time.
    const { source, refresh } = fakeSource(ops, {
      refresh: (id) =>
        id === "paid"
          ? Promise.resolve(MINTED)
          : new Promise((resolve) => setTimeout(() => resolve(UNPAID), 160)),
    });
    const state: PendingMintSweepState = { outstanding: new Map() };
    const options = { deadlineMs: 200, checkTimeoutMs: 120, state };

    await settlePendingMintQuotes(source, NOW_MS, options);
    expect(attempted(refresh)).toEqual(["s1", "s2"]);
    await new Promise((resolve) => setTimeout(resolve, 200));
    await settlePendingMintQuotes(source, NOW_MS, options);

    expect(attempted(refresh)[2]).toBe("paid");
    expect(logged.mock.calls[0]?.[0]).toContain("21 sat minted");
  });
});

describe("createRunQueue", () => {
  it("runs tasks strictly one after another", async () => {
    const enqueue = createRunQueue();
    const order: string[] = [];
    let active = 0;
    let maxActive = 0;
    const task = (name: string, delay: number) => async () => {
      active++;
      maxActive = Math.max(maxActive, active);
      order.push(`${name}:start`);
      await new Promise((resolve) => setTimeout(resolve, delay));
      order.push(`${name}:end`);
      active--;
      return name;
    };

    const results = await Promise.all([
      enqueue(task("a", 20)),
      enqueue(task("b", 1)),
      enqueue(task("c", 1)),
    ]);

    expect(results).toEqual(["a", "b", "c"]);
    expect(maxActive).toBe(1);
    expect(order).toEqual([
      "a:start",
      "a:end",
      "b:start",
      "b:end",
      "c:start",
      "c:end",
    ]);
  });

  it("keeps the chain alive after a rejected task", async () => {
    const enqueue = createRunQueue();

    const failed = enqueue(async () => {
      throw new Error("boom");
    });
    const next = enqueue(async () => "ok");

    await expect(failed).rejects.toThrow("boom");
    expect(await next).toBe("ok");
  });
});

describe("failExpiredMintQuoteIfUnpaid", () => {
  function fakeMintService(observe: (id: string) => Promise<{ category: "waiting" | "ready" | "completed" | "terminal" }>) {
    const failPendingOperation = mock(
      async (
        _op: { id: string },
        _failure: { reason: string; retryable?: boolean; observedAt: number },
      ) => ({}),
    );
    return {
      mintService: {
        observePendingOperation: mock(observe),
        failPendingOperation,
      },
      failPendingOperation,
    };
  }

  it("fails a quote its mint confirms unpaid", async () => {
    const { mintService, failPendingOperation } = fakeMintService(async () => ({
      category: "waiting",
    }));

    const result = await failExpiredMintQuoteIfUnpaid(mintService, "op-1", 1000);

    expect(result.outcome).toBe("failed");
    expect(failPendingOperation).toHaveBeenCalledTimes(1);
    expect(failPendingOperation.mock.calls[0]?.[1]?.reason).toContain(
      "confirmed unpaid by mint",
    );
  });

  it.each(["ready", "completed", "terminal"] as const)(
    "leaves a quote observed as %s for recovery",
    async (category) => {
      const { mintService, failPendingOperation } = fakeMintService(
        async () => ({ category }),
      );

      const result = await failExpiredMintQuoteIfUnpaid(mintService, "op-1", 1000);

      expect(result).toEqual({ outcome: "leftForRecovery", category });
      expect(failPendingOperation).not.toHaveBeenCalled();
    },
  );

  it("leaves a quote pending when the mint cannot be reached", async () => {
    const { mintService, failPendingOperation } = fakeMintService(async () => {
      throw new Error("Network request failed");
    });

    const result = await failExpiredMintQuoteIfUnpaid(mintService, "op-1", 1000);

    expect(result.outcome).toBe("unobserved");
    expect(failPendingOperation).not.toHaveBeenCalled();
  });

  it("gives up waiting on a hung mint without failing the quote", async () => {
    const { mintService, failPendingOperation } = fakeMintService(
      () => new Promise(() => {}),
    );

    const result = await failExpiredMintQuoteIfUnpaid(mintService, "op-1", 20);

    expect(result.outcome).toBe("unobserved");
    expect(failPendingOperation).not.toHaveBeenCalled();
  });
});


describe("reopenFailedMintOperation", () => {
  /**
   * Mirrors coco's OperationIdLock, which is fail-fast: acquiring an id that is
   * already locked throws OperationInProgressError instead of waiting.
   */
  function makeLock() {
    let held = false;
    return {
      get held() {
        return held;
      },
      async acquire() {
        if (held) {
          const error = new Error("Operation op-1 is already in progress");
          error.name = "OperationInProgressError";
          throw error;
        }
        held = true;
        return () => {
          held = false;
        };
      },
    };
  }

  function fakeService(
    current: Record<string, unknown> | null,
    hooks: {
      lock?: ReturnType<typeof makeLock>;
      onWrite?: (lock: ReturnType<typeof makeLock>) => void;
    } = {},
  ) {
    const lock = hooks.lock ?? makeLock();
    const transitionToPending = mock(
      async (_op: Record<string, unknown>, _error?: string) => {
        hooks.onWrite?.(lock);
        return {};
      },
    );
    return {
      service: {
        acquireOperationLock: mock(async (_id: string) => lock.acquire()),
        getOperation: mock(async (_id: string) => current),
        transitionToPending,
      },
      transitionToPending,
      lock,
    };
  }

  it("re-opens a failed operation with the full persisted row", async () => {
    // coco spreads whatever it is handed and the sqlite repository rewrites
    // every column, so a partial object would erase the stored outputs.
    const row = {
      id: "op-1",
      state: "failed",
      mintUrl: "https://mint.example.com",
      quoteId: "quote-1",
      method: "bolt11",
      amount: 210_000,
      unit: "sat",
      request: "lnbc...",
      expiry: 1_800_000_000,
      outputDataJson: "[{\"secret\":\"abc\"}]",
      terminalFailure: { reason: "expired" },
    };
    const { service, transitionToPending } = fakeService(row);

    const reopened = await reopenFailedMintOperation(service, "op-1");

    expect(reopened).toBe(true);
    expect(transitionToPending).toHaveBeenCalledTimes(1);
    const passed = transitionToPending.mock.calls[0]?.[0];
    expect(passed).toMatchObject({
      id: "op-1",
      quoteId: "quote-1",
      amount: 210_000,
      unit: "sat",
      outputDataJson: "[{\"secret\":\"abc\"}]",
    });
    // The stale terminal marker must not survive the re-open.
    expect(passed?.terminalFailure).toBeUndefined();
  });

  it("does nothing when the operation is no longer failed", async () => {
    const { service, transitionToPending, lock } = fakeService({
      id: "op-1",
      state: "finalized",
    });

    expect(await reopenFailedMintOperation(service, "op-1")).toBe(false);
    expect(transitionToPending).not.toHaveBeenCalled();
    // The lock must be released even on the no-op path.
    expect(lock.held).toBe(false);
  });

  it("throws when the operation is missing", async () => {
    const { service, lock } = fakeService(null);

    await expect(reopenFailedMintOperation(service, "op-1")).rejects.toThrow(
      "not found",
    );
    expect(lock.held).toBe(false);
  });

  it("fails closed when coco no longer exposes the operation lock", async () => {
    const transitionToPending = mock(
      async (_op: Record<string, unknown>, _error?: string) => ({}),
    );
    const service = {
      getOperation: mock(async () => ({ id: "op-1", state: "failed" })),
      transitionToPending,
    } as unknown as Parameters<typeof reopenFailedMintOperation>[0];

    await expect(
      reopenFailedMintOperation(service, "op-1"),
    ).rejects.toThrow("acquireOperationLock");
    expect(transitionToPending).not.toHaveBeenCalled();
  });

  it("holds the operation lock across read-check-write", async () => {
    const lock = makeLock();
    const order: string[] = [];
    const service = {
      acquireOperationLock: mock(async (_id: string) => {
        order.push("lock");
        const release = await lock.acquire();
        return () => {
          order.push("unlock");
          release();
        };
      }),
      getOperation: mock(async (_id: string) => {
        expect(lock.held).toBe(true);
        order.push("read");
        return { id: "op-1", state: "failed", quoteId: "quote-1" };
      }),
      transitionToPending: mock(async () => {
        expect(lock.held).toBe(true);
        order.push("write");
        return {};
      }),
    };

    const reopened = await reopenFailedMintOperation(service, "op-1");

    expect(reopened).toBe(true);
    expect(order).toEqual(["lock", "read", "write", "unlock"]);
    expect(lock.held).toBe(false);
  });

  it("refuses to re-open while the operation lock is held elsewhere", async () => {
    const lock = makeLock();
    const release = await lock.acquire();
    const { service, transitionToPending } = fakeService(
      { id: "op-1", state: "failed" },
      { lock },
    );

    await expect(reopenFailedMintOperation(service, "op-1")).rejects.toThrow(
      /in progress/,
    );
    expect(transitionToPending).not.toHaveBeenCalled();
    release();
  });
});

describe("runMintQuoteRecovery", () => {
  function mintOp(overrides: Record<string, unknown> = {}) {
    return {
      id: "op-1",
      mintUrl: "https://mint.example.com",
      quoteId: "quote-1",
      state: "pending",
      amount: 210_000,
      expiry: 0,
      ...overrides,
    };
  }

  function fakeSource(
    ops: Array<Record<string, unknown>>,
    behavior: {
      observe?: (id: string) => Promise<{
        category: "waiting" | "ready" | "completed" | "terminal";
      }>;
      finalize?: (id: string) => Promise<unknown>;
      reopen?: (id: string) => Promise<boolean>;
    } = {},
  ) {
    const finalize = mock(
      behavior.finalize ??
        (async (_id: string) => ({ state: "finalized" })),
    );
    const observePendingOperation = mock(
      behavior.observe ?? (async () => ({ category: "waiting" as const })),
    );
    const reopenFailedOperation = mock(
      behavior.reopen ?? (async (_id: string) => true),
    );
    const byId = new Map(ops.map((op) => [op.id as string, op]));
    const source = {
      ops: {
        mint: {
          listPending: async () =>
            ops.filter(
              (op) => op.state === "pending" || op.state === "executing",
            ),
          get: async (id: string) => byId.get(id) ?? null,
          finalize,
        },
      },
      mintOperationService: { observePendingOperation },
      reopenFailedOperation,
    } as unknown as MintQuoteRecoverySource;
    return { source, finalize, observePendingOperation, reopenFailedOperation };
  }

  it("mints the stored outputs for a quote the mint reports PAID", async () => {
    const { source, finalize } = fakeSource([mintOp()], {
      observe: async () => ({ category: "ready" }),
    });

    const result = await runMintQuoteRecovery(source);

    expect(result).toMatchObject({ checked: 1, recovered: 1, waiting: 0 });
    expect(finalize).toHaveBeenCalledTimes(1);
    expect(finalize.mock.calls[0]?.[0]).toBe("op-1");
  });

  it("restores proofs for a quote already issued at the mint", async () => {
    const { source, finalize } = fakeSource([mintOp()], {
      observe: async () => ({ category: "completed" }),
    });

    const result = await runMintQuoteRecovery(source);

    expect(result).toMatchObject({ recovered: 1 });
    expect(finalize).toHaveBeenCalledTimes(1);
  });

  it("leaves an unpaid quote pending", async () => {
    const { source, finalize } = fakeSource([mintOp()], {
      observe: async () => ({ category: "waiting" }),
    });

    const result = await runMintQuoteRecovery(source);

    expect(result).toMatchObject({ checked: 1, recovered: 0, waiting: 1 });
    expect(finalize).not.toHaveBeenCalled();
  });

  it("reports a quote the mint can no longer issue", async () => {
    const { source, finalize } = fakeSource([mintOp()], {
      observe: async () => ({ category: "terminal" }),
    });

    const result = await runMintQuoteRecovery(source);

    expect(result).toMatchObject({ terminal: 1, recovered: 0 });
    expect(finalize).not.toHaveBeenCalled();
  });

  it("retries later when the mint is unreachable", async () => {
    const { source, finalize } = fakeSource([mintOp()], {
      observe: async () => {
        throw new Error("fetch failed");
      },
    });

    const result = await runMintQuoteRecovery(source);

    expect(result).toMatchObject({ retryable: 1, recovered: 0 });
    expect(result.errors).toHaveLength(1);
    expect(finalize).not.toHaveBeenCalled();
  });

  it("does not count a failed finalize as a recovery", async () => {
    // coco returns a terminal operation instead of throwing when the mint
    // refuses, so a fulfilled finalize is not evidence that sats were claimed.
    const { source, finalize } = fakeSource([mintOp()], {
      observe: async () => ({ category: "ready" }),
      finalize: async () => ({
        state: "failed",
        error: "Recovered: quote quote-1 expired while executing mint",
      }),
    });

    const result = await runMintQuoteRecovery(source);

    expect(result).toMatchObject({ recovered: 0, terminal: 1 });
    expect(result.errors[0]?.error).toContain("expired");
    expect(finalize).toHaveBeenCalledTimes(1);
  });

  it("does not count a finalized-with-error operation as a recovery", async () => {
    const { source } = fakeSource([mintOp()], {
      observe: async () => ({ category: "completed" }),
      finalize: async () => ({
        state: "finalized",
        error: "Recovered issued quote quote-1 but no proofs could be restored",
      }),
    });

    const result = await runMintQuoteRecovery(source);

    expect(result).toMatchObject({ recovered: 0, terminal: 1 });
    expect(result.errors).toHaveLength(1);
  });

  it("falls back to the original failure when diagnostic lookup fails", async () => {
    const { source } = fakeSource([mintOp()], {
      observe: async () => ({ category: "ready" }),
      finalize: async () => { throw new Error("original failure"); },
    });
    source.ops.mint.get = async () => { throw new Error("lookup failed"); };
    const result = await runMintQuoteRecovery(source);
    expect(result).toMatchObject({ retryable: 1, recovered: 0 });
    expect(result.errors).toEqual([{ operationId: "op-1", error: "original failure" }]);
  });

  it("bounds a hung diagnostic lookup after finalize fails", async () => {
    const { source } = fakeSource([mintOp()], {
      observe: async () => ({ category: "ready" }),
      finalize: async () => { throw new Error("original failure"); },
    });
    source.ops.mint.get = () => new Promise(() => {});
    const result = await runMintQuoteRecovery(source, { timeoutMs: 20 });
    expect(result).toMatchObject({ retryable: 1, recovered: 0 });
    expect(result.errors).toEqual([{ operationId: "op-1", error: "original failure" }]);
  });

  it("surfaces the persisted mint error even when the mint budget is nearly spent", async () => {
    const { source } = fakeSource([mintOp()], {
      observe: async () => ({ category: "ready" }),
      finalize: async () => {
        // Consume almost the whole per-op mint budget before throwing: exactly
        // the slow-mint case where a diagnostic bound to remaining() would
        // starve and silently fall back to the generic message.
        await new Promise((resolve) => setTimeout(resolve, 25));
        throw new Error("remains pending");
      },
    });
    source.ops.mint.get = async () => {
      await new Promise((resolve) => setTimeout(resolve, 50));
      return {
        ...mintOp(),
        state: "pending",
        error: "keyset id inactive.",
      };
    };
    const result = await runMintQuoteRecovery(source, { timeoutMs: 30 });
    expect(result).toMatchObject({ retryable: 1, recovered: 0 });
    expect(result.errors).toEqual([
      { operationId: "op-1", error: "keyset id inactive." },
    ]);
  });

  it("bounds finalize so one hung mint cannot block recovery", async () => {
    const { source } = fakeSource([mintOp()], {
      observe: async () => ({ category: "ready" }),
      finalize: () => new Promise(() => {}),
    });

    const started = Date.now();
    const result = await runMintQuoteRecovery(source, { timeoutMs: 20 });

    expect(Date.now() - started).toBeLessThan(5_000);
    expect(result).toMatchObject({ retryable: 1, recovered: 0 });
  });

  it("recovers an interrupted mint without re-checking the quote", async () => {
    const { source, finalize, observePendingOperation } = fakeSource([
      mintOp({ state: "executing" }),
    ]);

    const result = await runMintQuoteRecovery(source);

    expect(result).toMatchObject({ recovered: 1 });
    expect(finalize).toHaveBeenCalledTimes(1);
    expect(observePendingOperation).not.toHaveBeenCalled();
  });

  it("skips failed operations unless the caller opts in", async () => {
    const { source, reopenFailedOperation } = fakeSource([
      mintOp({ state: "failed", lastObservedRemoteState: "PAID" }),
    ]);

    const result = await runMintQuoteRecovery(source);

    expect(result).toMatchObject({ checked: 0, recovered: 0, reopened: 0 });
    expect(reopenFailedOperation).not.toHaveBeenCalled();
  });

  it("requires explicit IDs when including failed operations", async () => {
    const { source, reopenFailedOperation, observePendingOperation } = fakeSource([]);
    await expect(runMintQuoteRecovery(source, { includeFailed: true })).rejects.toThrow(
      "includeFailed requires explicit operationIds",
    );
    await expect(runMintQuoteRecovery(source, { includeFailed: true, operationIds: [] })).rejects.toThrow(
      "includeFailed requires explicit operationIds",
    );
    expect(reopenFailedOperation).not.toHaveBeenCalled();
    expect(observePendingOperation).not.toHaveBeenCalled();
  });

  it.each([0, -1, NaN, Infinity])("rejects invalid recovery timeout %s", async (timeoutMs) => {
    const { source, observePendingOperation } = fakeSource([]);
    await expect(runMintQuoteRecovery(source, { timeoutMs })).rejects.toThrow(
      "timeoutMs must be a positive finite number",
    );
    expect(observePendingOperation).not.toHaveBeenCalled();
  });

  it("re-opens a named failed operation, then mints it", async () => {
    const { source, reopenFailedOperation, finalize } = fakeSource(
      [mintOp({ state: "failed", lastObservedRemoteState: "PAID" })],
      { observe: async () => ({ category: "ready" }) },
    );

    const result = await runMintQuoteRecovery(source, {
      operationIds: ["op-1"],
      includeFailed: true,
    });

    expect(result).toMatchObject({ reopened: 1, recovered: 1 });
    expect(reopenFailedOperation).toHaveBeenCalledWith("op-1");
    expect(finalize).toHaveBeenCalledTimes(1);
  });

  it("re-opens a named failed operation even without a PAID observation", async () => {
    // The old local-fail bug left quotes with a stale or missing observation,
    // which is exactly when an operator needs to retry them.
    const { source, reopenFailedOperation } = fakeSource(
      [mintOp({ state: "failed" })],
      { observe: async () => ({ category: "ready" }) },
    );

    const result = await runMintQuoteRecovery(source, {
      operationIds: ["op-1"],
      includeFailed: true,
    });

    expect(result).toMatchObject({ reopened: 1, recovered: 1 });
    expect(reopenFailedOperation).toHaveBeenCalledTimes(1);
  });

  it("skips an operation that is no longer failed when re-opened", async () => {
    const { source, finalize } = fakeSource(
      [mintOp({ state: "failed" })],
      { reopen: async () => false },
    );

    const result = await runMintQuoteRecovery(source, {
      operationIds: ["op-1"],
      includeFailed: true,
    });

    expect(result).toMatchObject({ reopened: 0, checked: 0, recovered: 0 });
    expect(finalize).not.toHaveBeenCalled();
  });

  it("reports an unknown operation id instead of throwing", async () => {
    const { source } = fakeSource([]);

    const result = await runMintQuoteRecovery(source, {
      operationIds: ["missing"],
    });

    expect(result.checked).toBe(0);
    expect(result.errors).toEqual([
      { operationId: "missing", error: "operation not found" },
    ]);
  });

  it("deduplicates repeated operation ids", async () => {
    const { source, finalize } = fakeSource([mintOp()], {
      observe: async () => ({ category: "ready" }),
    });

    const result = await runMintQuoteRecovery(source, {
      operationIds: ["op-1", "op-1"],
    });

    expect(result.checked).toBe(1);
    expect(finalize).toHaveBeenCalledTimes(1);
  });

  it("ignores finalized operations even when targeted", async () => {
    const { source, finalize } = fakeSource([mintOp({ state: "finalized" })]);

    const result = await runMintQuoteRecovery(source, {
      operationIds: ["op-1"],
    });

    expect(result.checked).toBe(0);
    expect(finalize).not.toHaveBeenCalled();
  });

  it("leaves a non-terminal finalize result for a later run, not terminal", async () => {
    const { source } = fakeSource([mintOp()], {
      observe: async () => ({ category: "ready" }),
      finalize: async () => ({ state: "pending" }),
    });

    const result = await runMintQuoteRecovery(source);

    expect(result).toMatchObject({ recovered: 0, terminal: 0, retryable: 1 });
    expect(result.errors[0]?.error).toContain("will retry");
  });

  it("skips operations whose earlier recovery is still in flight", async () => {
    const outstanding = new Map<string, Promise<unknown>>([
      ["mint:op-1", new Promise(() => {})],
    ]);
    const { source, finalize, observePendingOperation } = fakeSource(
      [mintOp()],
      { observe: async () => ({ category: "ready" }) },
    );

    const result = await runMintQuoteRecovery(source, { outstanding });

    expect(result).toMatchObject({ busy: 1, checked: 0, recovered: 0 });
    expect(observePendingOperation).not.toHaveBeenCalled();
    expect(finalize).not.toHaveBeenCalled();
  });

  it("keeps a timed-out finalize registered so a retry waits", async () => {
    const outstanding = new Map<string, Promise<unknown>>();
    const { source } = fakeSource([mintOp()], {
      observe: async () => ({ category: "ready" }),
      finalize: () => new Promise(() => {}),
    });

    const first = await runMintQuoteRecovery(source, {
      timeoutMs: 20,
      outstanding,
    });
    const second = await runMintQuoteRecovery(source, {
      timeoutMs: 20,
      outstanding,
    });

    expect(first).toMatchObject({ retryable: 1, recovered: 0 });
    expect(outstanding.has("mint:op-1")).toBe(true);
    // The abandoned mint request must not be retried underneath.
    expect(second).toMatchObject({ busy: 1, checked: 0 });
  });

  it("does not re-open a failed operation whose recovery is in flight", async () => {
    const outstanding = new Map<string, Promise<unknown>>([
      ["mint:op-1", new Promise(() => {})],
    ]);
    const { source, reopenFailedOperation } = fakeSource(
      [mintOp({ state: "failed" })],
      {},
    );

    const result = await runMintQuoteRecovery(source, {
      operationIds: ["op-1"],
      includeFailed: true,
      outstanding,
    });

    expect(result).toMatchObject({ busy: 1, reopened: 0 });
    expect(reopenFailedOperation).not.toHaveBeenCalled();
  });

  it("counts an in-progress operation as busy rather than retryable", async () => {
    const { source } = fakeSource(
      [mintOp({ state: "failed" })],
      {
        reopen: async () => {
          const error = new Error("Operation op-1 is already in progress");
          error.name = "OperationInProgressError";
          throw error;
        },
      },
    );

    const result = await runMintQuoteRecovery(source, {
      operationIds: ["op-1"],
      includeFailed: true,
    });

    expect(result).toMatchObject({ busy: 1, retryable: 0, reopened: 0 });
  });

  it("keeps a timed-out quote check registered so a retry waits", async () => {
    // observePendingOperation is not read-only, so a hung check must not be
    // retried underneath: it could persist a stale observation later.
    const outstanding = new Map<string, Promise<unknown>>();
    const { source, finalize } = fakeSource([mintOp()], {
      observe: () => new Promise(() => {}),
    });

    const first = await runMintQuoteRecovery(source, {
      timeoutMs: 20,
      outstanding,
    });
    const second = await runMintQuoteRecovery(source, {
      timeoutMs: 20,
      outstanding,
    });

    expect(first).toMatchObject({ retryable: 1, checked: 1 });
    expect(outstanding.has("mint:op-1")).toBe(true);
    expect(second).toMatchObject({ busy: 1, checked: 0 });
    expect(finalize).not.toHaveBeenCalled();
  });
});

describe("createRecoveryGate", () => {
  const HEALTHY = "https://healthy.example.com";
  const STUCK = "https://stuck.example.com";

  function settled(promise: Promise<unknown>): Promise<boolean> {
    return Promise.race([
      promise.then(() => true, () => true),
      new Promise<boolean>((resolve) => setTimeout(() => resolve(false), 25)),
    ]);
  }

  it("lets a mint without stuck operations proceed while another mint recovers", async () => {
    const gate = createRecoveryGate();
    gate.publishStuckMints(new Set([STUCK]));
    // Recovery is still running (complete() never called), yet the healthy
    // mint must not be blocked by the stuck one.
    await gate.waitForRecovery(HEALTHY);
  });

  it("holds a mint with stuck operations until recovery completes", async () => {
    const gate = createRecoveryGate();
    gate.publishStuckMints(new Set([STUCK]));
    const waiting = gate.waitForRecovery(STUCK);
    expect(await settled(waiting)).toBe(false);
    gate.complete();
    await waiting;
  });

  it("waits for the stuck-mint enumeration before deciding", async () => {
    const gate = createRecoveryGate();
    const waiting = gate.waitForRecovery(HEALTHY);
    expect(await settled(waiting)).toBe(false);
    gate.publishStuckMints(new Set([STUCK]));
    await waiting;
  });

  it("holds callers without a target mint until recovery completes", async () => {
    const gate = createRecoveryGate();
    gate.publishStuckMints(new Set([STUCK]));
    const waiting = gate.waitForRecovery();
    expect(await settled(waiting)).toBe(false);
    gate.complete();
    await waiting;
  });

  it("poisons every caller after a recovery failure", async () => {
    const gate = createRecoveryGate();
    gate.publishStuckMints(new Set([STUCK]));
    gate.fail("disk exploded");
    await expect(gate.waitForRecovery(HEALTHY)).rejects.toThrow(
      "Wallet is not ready: disk exploded",
    );
    await expect(gate.waitForRecovery(STUCK)).rejects.toThrow(
      "Wallet is not ready: disk exploded",
    );
    await expect(gate.waitForRecovery()).rejects.toThrow(
      "Wallet is not ready: disk exploded",
    );
  });

  it("falls back to the global gate for unparseable mint URLs", async () => {
    const gate = createRecoveryGate();
    gate.publishStuckMints(new Set([STUCK]));
    const waiting = gate.waitForRecovery("not a url");
    expect(await settled(waiting)).toBe(false);
    gate.complete();
    await waiting;
  });
});

describe("runWalletDoctor", () => {
  const NOW = Date.now();

  function doctorMintOp(overrides: Record<string, unknown> = {}) {
    return {
      id: "op-1",
      mintUrl: "https://mint.example",
      quoteId: "quote-1",
      state: "pending",
      amount: 500,
      expiry: Math.floor(NOW / 1000) + 600,
      createdAt: NOW - 5 * 60_000,
      updatedAt: NOW - 60_000,
      ...overrides,
    };
  }

  function doctorMeltOp(overrides: Record<string, unknown> = {}) {
    return {
      id: "melt-1",
      mintUrl: "https://mint.example",
      quoteId: "melt-quote-1",
      state: "prepared",
      amount: 2_100,
      fee_reserve: 12,
      inputProofSecrets: ["secret-a"],
      createdAt: NOW - 3 * 24 * 3_600_000,
      updatedAt: NOW - 3 * 24 * 3_600_000,
      ...overrides,
    };
  }

  function fakeDoctorSource(overrides: Partial<WalletDoctorSource> = {}) {
    const fetchQuoteState = mock(async (_mintUrl: string, _quoteId: string) => "UNPAID");
    const source: WalletDoctorSource = {
      listTrustedMintUrls: async () => ["https://mint.example"],
      listPendingMintOps: async () => [],
      listFailedMintOps: async () => [],
      listPreparedMelts: async () => [],
      listInFlightMelts: async () => [],
      listFailedMelts: async () => [],
      getInflightProofSecrets: async () => [],
      probeMint: async (mintUrl: string) => ({
        mintUrl,
        reachable: true,
        latencyMs: 5,
      }),
      fetchQuoteState,
      ...overrides,
    };
    return { source, fetchQuoteState };
  }

  it("reports a healthy wallet as all-green", async () => {
    const { source } = fakeDoctorSource();
    const report = await runWalletDoctor(source);
    expect(report.mints).toEqual([
      { mintUrl: "https://mint.example", reachable: true, latencyMs: 5 },
    ]);
    expect(report.unpaidQuotes).toEqual([]);
    expect(report.paidUnissued).toEqual([]);
    expect(report.stuckMelts).toEqual([]);
    expect(report.uncheckedQuotes).toBe(0);
  });

  it("lists a recent quote the mint still reports UNPAID", async () => {
    const { source } = fakeDoctorSource({
      listPendingMintOps: async () => [doctorMintOp() as never],
    });
    const report = await runWalletDoctor(source);
    expect(report.unpaidQuotes).toHaveLength(1);
    expect(report.unpaidQuotes[0]).toMatchObject({
      operationId: "op-1",
      amount: 500,
    });
    expect(report.paidUnissued).toEqual([]);
  });

  it("flags a pending quote the mint reports PAID with the recover command", async () => {
    const { source } = fakeDoctorSource({
      listPendingMintOps: async () => [doctorMintOp() as never],
      fetchQuoteState: async () => "PAID",
    });
    const report = await runWalletDoctor(source);
    expect(report.unpaidQuotes).toEqual([]);
    expect(report.paidUnissued).toHaveLength(1);
    expect(report.paidUnissued[0]).toMatchObject({
      operationId: "op-1",
      remoteState: "PAID",
      remediation: "routstrd wallet recover --op op-1",
    });
  });

  it("flags a failed quote last seen PAID with --include-failed", async () => {
    const { source } = fakeDoctorSource({
      listFailedMintOps: async () => [
        doctorMintOp({
          id: "op-9",
          state: "failed",
          lastObservedRemoteState: "PAID",
        }) as never,
      ],
      fetchQuoteState: async () => "PAID",
    });
    const report = await runWalletDoctor(source);
    expect(report.paidUnissued).toHaveLength(1);
    expect(report.paidUnissued[0]?.remediation).toBe(
      "routstrd wallet recover --op op-9 --include-failed",
    );
  });

  it("does not probe failed quotes last seen UNPAID", async () => {
    const { source, fetchQuoteState } = fakeDoctorSource({
      listFailedMintOps: async () => [
        doctorMintOp({
          state: "failed",
          lastObservedRemoteState: "UNPAID",
        }) as never,
      ],
    });
    const report = await runWalletDoctor(source);
    expect(fetchQuoteState).not.toHaveBeenCalled();
    expect(report.paidUnissued).toEqual([]);
    expect(report.uncheckedQuotes).toBe(0);
  });

  it("probes each target quote only once", async () => {
    const { source, fetchQuoteState } = fakeDoctorSource({
      listPendingMintOps: async () => [doctorMintOp() as never],
    });
    fetchQuoteState.mockImplementation(async () => "PAID");
    await runWalletDoctor(source);
    expect(fetchQuoteState).toHaveBeenCalledTimes(1);
    expect(fetchQuoteState).toHaveBeenCalledWith(
      "https://mint.example",
      "quote-1",
    );
  });

  it("counts probe failures as unchecked instead of dropping them", async () => {
    const { source } = fakeDoctorSource({
      listPendingMintOps: async () => [doctorMintOp() as never],
      fetchQuoteState: async () => {
        throw new Error("mint unreachable");
      },
    });
    const report = await runWalletDoctor(source);
    expect(report.uncheckedQuotes).toBe(1);
    expect(report.unpaidQuotes).toEqual([]);
    expect(report.paidUnissued).toEqual([]);
  });

  it("counts quotes the probe budget never reached as unchecked", async () => {
    const { source, fetchQuoteState } = fakeDoctorSource({
      listPendingMintOps: async () => [
        doctorMintOp() as never,
        doctorMintOp({ id: "op-2", quoteId: "quote-2" }) as never,
      ],
      quoteProbeBudgetMs: 0,
    });
    const report = await runWalletDoctor(source);
    expect(fetchQuoteState).not.toHaveBeenCalled();
    expect(report.uncheckedQuotes).toBe(2);
  });

  it("passes unreachable mint probes through", async () => {
    const { source } = fakeDoctorSource({
      probeMint: async (mintUrl: string) => ({
        mintUrl,
        reachable: false,
        error: "fetch failed",
      }),
    });
    const report = await runWalletDoctor(source);
    expect(report.mints).toEqual([
      { mintUrl: "https://mint.example", reachable: false, error: "fetch failed" },
    ]);
  });

  it("flags old prepared melts and failed melts with locked proofs", async () => {
    const { source } = fakeDoctorSource({
      listPreparedMelts: async () => [doctorMeltOp()],
      listFailedMelts: async () => [
        doctorMeltOp({ id: "melt-2", state: "failed" }),
      ],
      getInflightProofSecrets: async () => ["secret-a"],
    });
    const report = await runWalletDoctor(source);
    expect(report.stuckMelts).toHaveLength(2);
    const byKind = new Map(report.stuckMelts.map((melt) => [melt.kind, melt]));
    expect(byKind.get("prepared")).toMatchObject({
      operationId: "melt-1",
      feeReserve: 12,
    });
    expect(byKind.get("failed-locked")).toMatchObject({
      operationId: "melt-2",
      lockedSecrets: 1,
    });
  });

  it("ignores failed melts whose proofs were released", async () => {
    const { source } = fakeDoctorSource({
      listFailedMelts: async () => [
        doctorMeltOp({ id: "melt-2", state: "failed" }),
      ],
      getInflightProofSecrets: async () => [],
    });
    const report = await runWalletDoctor(source);
    expect(report.stuckMelts).toEqual([]);
  });
});
