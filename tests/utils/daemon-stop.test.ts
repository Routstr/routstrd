import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { waitForDaemonToExit, type WaitForDaemonToExitOptions } from "../../src/utils/daemon-stop.ts";

const PID_FILE = "/tmp/routstrd-test/wallet.pid";
const tempDirs: string[] = [];

function makeTempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "routstrd-daemon-stop-test-"));
  tempDirs.push(dir);
  return dir;
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

/** Consume scripted values from the front; repeat the fallback afterwards. */
function scripted<T>(values: T[], fallback: T): () => T {
  return () => (values.length > 0 ? values.shift()! : fallback);
}

function runWith(
  overrides: {
    health?: boolean[];
    lockPids?: Array<number | null>;
    runningPids?: number[];
  } = {},
  options: WaitForDaemonToExitOptions = {},
) {
  const logs: string[] = [];
  const runningPids = new Set(overrides.runningPids ?? []);
  const nextHealth = scripted(overrides.health ?? [], false);
  const nextLockPid = scripted(overrides.lockPids ?? [], null);
  const promise = waitForDaemonToExit({
    pidFilePath: PID_FILE,
    isHealthy: () => Promise.resolve(nextHealth()),
    readLockPid: () => nextLockPid(),
    isProcessRunning: (pid: number) => runningPids.has(pid),
    sleep: () => Promise.resolve(),
    log: (message: string) => logs.push(message),
    pollIntervalMs: 1,
    // Keep the grace window tiny so draining is reported on the first poll.
    drainGraceMs: 0,
    ...options,
  });
  return { logs, promise };
}

describe("waitForDaemonToExit", () => {
  test("resolves once the health check is down and the lock is released", async () => {
    const { logs, promise } = runWith({
      health: [true, true],
      lockPids: [null],
    });
    await promise;
    expect(logs).toEqual([]);
  });

  test("waits for the old daemon to finish ongoing requests", async () => {
    const { logs, promise } = runWith({
      health: [],
      // The old daemon holds the lock for a few polls, then releases it.
      lockPids: [5923, 5923, 5923, null],
      runningPids: [5923],
    });
    await promise;
    expect(logs).toEqual([
      "  Finishing all ongoing requests... (run 'kill -9 5923' to force stop)",
    ]);
  });

  test("re-reports how to force stop while ongoing requests are still finishing", async () => {
    const { logs, promise } = runWith(
      { health: [], lockPids: [5923, 5923, null], runningPids: [5923] },
      // Report on every drain poll, so the heartbeat follows the announce.
      { drainHeartbeatMs: 0 },
    );
    await promise;
    expect(logs).toEqual([
      "  Finishing all ongoing requests... (run 'kill -9 5923' to force stop)",
      expect.stringMatching(
        /^  Still finishing ongoing requests \(\d+s elapsed\)\.\.\. \(run 'kill -9 5923' to force stop\)$/,
      ),
    ]);
  });

  test("stays silent when the lock is released within the grace window", async () => {
    const { logs, promise } = runWith(
      { health: [], lockPids: [5923, null], runningPids: [5923] },
      { drainGraceMs: 1_000 },
    );
    await promise;
    expect(logs).toEqual([]);
  });

  test("treats a stale lock (dead PID) as released", async () => {
    // 5923 is not in runningPids, so the recorded owner is dead.
    const { logs, promise } = runWith({
      health: [],
      lockPids: [5923],
    });
    await promise;
    expect(logs).toEqual([]);
  });

  test("fails when the daemon keeps answering health checks", async () => {
    const { logs, promise } = runWith(
      { health: [true], lockPids: [null] },
      { healthTimeoutMs: 0 },
    );
    await expect(promise).rejects.toThrow(/did not stop within \d+ seconds/);
    expect(logs).toEqual([]);
  });

  test("fails with the holding PID when draining never finishes", async () => {
    const { promise } = runWith(
      { health: [], lockPids: [5923], runningPids: [5923] },
      { drainTimeoutMs: 0 },
    );
    await expect(promise).rejects.toThrow(
      /PID 5923.*did not finish its ongoing requests.*kill -9 5923/s,
    );
  });

  test("reads the wallet lock file from disk by default", async () => {
    const dir = makeTempDir();
    const pidFile = join(dir, "wallet.pid");
    writeFileSync(pidFile, "1234\n");

    const logs: string[] = [];
    let polls = 0;
    await waitForDaemonToExit({
      pidFilePath: pidFile,
      isHealthy: () => Promise.resolve(false),
      isProcessRunning: (pid: number) => pid === 1234,
      sleep: async () => {
        // The old daemon exits (and unlinks its lock) after two polls.
        if (++polls >= 2) rmSync(pidFile);
      },
      log: (message: string) => logs.push(message),
      drainGraceMs: 0,
      pollIntervalMs: 1,
    });
    expect(logs).toEqual([
      "  Finishing all ongoing requests... (run 'kill -9 1234' to force stop)",
    ]);
  });

  test("treats an unparseable lock file as released", async () => {
    const dir = makeTempDir();
    const pidFile = join(dir, "wallet.pid");
    writeFileSync(pidFile, "starting...");

    const logs: string[] = [];
    await waitForDaemonToExit({
      pidFilePath: pidFile,
      isHealthy: () => Promise.resolve(false),
      isProcessRunning: () => true,
      sleep: () => Promise.resolve(),
      log: (message: string) => logs.push(message),
      drainTimeoutMs: 5_000,
      pollIntervalMs: 1,
    });
    expect(logs).toEqual([]);
  });
});
