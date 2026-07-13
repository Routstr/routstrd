import { describe, expect, it, mock } from "bun:test";
import {
  assertLegacyCocodNotRunning,
  claimLegacyCocodPidFile,
} from "./coco-client";

type GuardOptions = NonNullable<
  Parameters<typeof assertLegacyCocodNotRunning>[0]
>;
type LegacyFetch = NonNullable<GuardOptions["fetchImpl"]>;

const SOCKET_PATH = "/tmp/routstrd-test/cocod.sock";
const PID_FILE_PATH = "/tmp/routstrd-test/cocod.pid";

function socketOnly(path: string): boolean {
  return path === SOCKET_PATH;
}

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
