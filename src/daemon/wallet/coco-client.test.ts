import { afterEach, describe, expect, it, mock } from "bun:test";
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
  isZombieProcess,
  settleExpiredMintQuotes,
  stopLegacyCocod,
  type ExpiredMintQuoteSource,
} from "./coco-client";

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
  it("can initialize offline without adding a default mint", async () => {
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
      initializeDefaultMint: false,
      enableNpc: false,
    });
    try {
      expect(await client.listMints()).toEqual([]);
      expect(await client.getDefaultMint()).toBeNull();
    } finally {
      await client.dispose?.();
    }
  });

  it("automatically adds default mint when no mints exist", async () => {
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

      const mints = await client.listMints();
      expect(mints).toContain("https://mint.cubabitcoin.org");

      const defaultMint = await client.getDefaultMint();
      expect(defaultMint).toBe("https://mint.cubabitcoin.org");
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
      // The initial default should be the auto-added Cuba mint
      const initialDefault = await client.getDefaultMint();
      expect(initialDefault).toBe("https://mint.cubabitcoin.org");

      // Setting the same mint should work
      const message = await client.setDefaultMint(
        "https://mint.cubabitcoin.org",
      );
      expect(message).toContain("https://mint.cubabitcoin.org");

      const defaultMint = await client.getDefaultMint();
      expect(defaultMint).toBe("https://mint.cubabitcoin.org");
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
});
