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
  stopLegacyCocod,
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

describe("assertLegacyCocodNotRunning", () => {
  it("does not probe when the legacy socket and PID file do not exist", async () => {
    const fetchImpl = mock<LegacyFetch>(async () => new Response("pong"));

    await assertLegacyCocodNotRunning({
      socketPath: SOCKET_PATH,
      pidFilePath: PID_FILE_PATH,
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
        pidFilePath: PID_FILE_PATH,
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
          pidFilePath: PID_FILE_PATH,
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
        pidFilePath: PID_FILE_PATH,
        pathExists: socketOnly,
        fetchImpl,
      }),
    ).resolves.toBeUndefined();
  });

  it("refuses to continue when the legacy PID is still running", async () => {
    const fetchImpl = mock<LegacyFetch>(async () =>
      Response.json({ output: "pong" }),
    );

    await expect(
      assertLegacyCocodNotRunning({
        socketPath: SOCKET_PATH,
        pidFilePath: PID_FILE_PATH,
        pathExists: (path) => path === PID_FILE_PATH,
        readFile: () => "4242\n",
        isProcessRunning: (pid) => pid === 4242,
        fetchImpl,
      }),
    ).rejects.toThrow("Legacy cocod daemon is still running with PID 4242");

    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("ignores a stale PID file when no socket exists", async () => {
    await expect(
      assertLegacyCocodNotRunning({
        socketPath: SOCKET_PATH,
        pidFilePath: PID_FILE_PATH,
        pathExists: (path) => path === PID_FILE_PATH,
        readFile: () => "4242\n",
        isProcessRunning: () => false,
      }),
    ).resolves.toBeUndefined();
  });

  it("ignores the caller's own migration lock PID", async () => {
    await expect(
      assertLegacyCocodNotRunning({
        socketPath: SOCKET_PATH,
        pidFilePath: PID_FILE_PATH,
        pathExists: (path) => path === PID_FILE_PATH,
        readFile: () => "4242\n",
        isProcessRunning: () => true,
        ignorePid: 4242,
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
        pidFilePath: PID_FILE_PATH,
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
    ).toThrow("Another cocod or routstrd process may be starting");
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
});
