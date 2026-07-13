import { describe, expect, it, mock } from "bun:test";
import { assertLegacyCocodNotRunning } from "./coco-client";

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
