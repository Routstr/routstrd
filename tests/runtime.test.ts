import { describe, expect, test } from "bun:test";
import {
  DAEMON_COMMAND,
  daemonSpawnCommand,
  isStandaloneExecutable,
  pm2DaemonArgs,
} from "../src/runtime";

describe("isStandaloneExecutable", () => {
  test("uses Bun's explicit standalone flag when available", () => {
    expect(
      isStandaloneExecutable({
        isStandaloneExecutable: true,
        main: "/workspace/index.ts",
      }),
    ).toBe(true);
  });

  test("recognizes the virtual bunfs entrypoint used by older Bun releases", () => {
    expect(isStandaloneExecutable({ main: "/$bunfs/root/routstrd" })).toBe(true);
  });

  test("does not classify a normal Bun entrypoint as standalone", () => {
    expect(isStandaloneExecutable({ main: "/workspace/src/index.ts" })).toBe(false);
  });
});

describe("daemonSpawnCommand", () => {
  test("relaunches a standalone executable directly", () => {
    expect(
      daemonSpawnCommand(["--port", "9000"], {
        standalone: true,
        execPath: "/usr/local/bin/routstrd",
        main: "/unused/index.ts",
      }),
    ).toEqual([
      "/usr/local/bin/routstrd",
      DAEMON_COMMAND,
      "--port",
      "9000",
    ]);
  });

  test("runs the entry script through Bun during development", () => {
    expect(
      daemonSpawnCommand(["--host", "127.0.0.1"], {
        standalone: false,
        execPath: "/opt/bun/bin/bun",
        main: "/workspace/src/index.ts",
      }),
    ).toEqual([
      "/opt/bun/bin/bun",
      "/workspace/src/index.ts",
      DAEMON_COMMAND,
      "--host",
      "127.0.0.1",
    ]);
  });
});

describe("pm2DaemonArgs", () => {
  test("runs a standalone executable without an interpreter", () => {
    expect(
      pm2DaemonArgs({
        standalone: true,
        execPath: "/usr/local/bin/routstrd",
        main: "/unused/index.ts",
      }),
    ).toEqual([
      "start",
      "/usr/local/bin/routstrd",
      "--name",
      "routstrd",
      "--interpreter",
      "none",
      "--",
      DAEMON_COMMAND,
    ]);
  });

  test("uses Bun as the interpreter for a script install", () => {
    expect(
      pm2DaemonArgs({
        standalone: false,
        execPath: "/opt/bun/bin/bun",
        main: "/workspace/dist/index.js",
      }),
    ).toEqual([
      "start",
      "/workspace/dist/index.js",
      "--name",
      "routstrd",
      "--interpreter",
      "/opt/bun/bin/bun",
      "--",
      DAEMON_COMMAND,
    ]);
  });
});
