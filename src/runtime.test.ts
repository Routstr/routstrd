import { describe, expect, test } from "bun:test";
import {
  daemonSpawnCommand,
  globalInstallCommand,
  isStandaloneExecutable,
  pm2DaemonArgs,
} from "./runtime.ts";

describe("isStandaloneExecutable", () => {
  test("detects a bun --compile binary by its flag", () => {
    expect(isStandaloneExecutable({ isStandaloneExecutable: true, main: "/anything" })).toBe(true);
  });

  test("detects a bun --compile binary by its bunfs main", () => {
    expect(isStandaloneExecutable({ main: "/$bunfs/root/routstrd" })).toBe(true);
  });

  // `deno compile` binaries report Deno.build.standalone, which runtime.ts
  // normalises into the same flag.
  test("detects a deno compile binary", () => {
    expect(
      isStandaloneExecutable({ isStandaloneExecutable: true, main: "file:///main.ts" }),
    ).toBe(true);
  });

  test("is false when running from source under either runtime", () => {
    expect(isStandaloneExecutable({ main: "/home/me/routstrd/src/index.ts" })).toBe(false);
    expect(
      isStandaloneExecutable({ isStandaloneExecutable: false, main: "file:///src/index.ts" }),
    ).toBe(false);
    expect(isStandaloneExecutable(undefined)).toBe(false);
  });
});

describe("daemonSpawnCommand", () => {
  test("a standalone binary re-executes itself, whichever runtime built it", () => {
    for (const runtime of ["bun", "deno"] as const) {
      expect(
        daemonSpawnCommand(["--port", "8008"], {
          standalone: true,
          execPath: "/usr/local/bin/routstrd",
          main: "/$bunfs/root/routstrd",
          runtime,
        }),
      ).toEqual(["/usr/local/bin/routstrd", "daemon", "--port", "8008"]);
    }
  });

  test("deno from source needs its subcommand and permissions", () => {
    expect(
      daemonSpawnCommand([], {
        standalone: false,
        execPath: "/home/me/.deno/bin/deno",
        main: "/home/me/routstrd/src/index.ts",
        runtime: "deno",
      }),
    ).toEqual([
      "/home/me/.deno/bin/deno",
      "run",
      "-A",
      "/home/me/routstrd/src/index.ts",
      "daemon",
    ]);
  });
});

describe("pm2DaemonArgs", () => {
  test("a standalone binary runs without an interpreter", () => {
    expect(
      pm2DaemonArgs({
        standalone: true,
        execPath: "/usr/local/bin/routstrd",
        main: "/$bunfs/root/routstrd",
        runtime: "deno",
      }),
    ).toEqual([
      "start",
      "/usr/local/bin/routstrd",
      "--name",
      "routstrd",
      "--interpreter",
      "none",
      "--",
      "daemon",
    ]);
  });
});

describe("globalInstallCommand", () => {
  test("uses each runtime's own global install", () => {
    expect(globalInstallCommand("routstrd", "bun")).toEqual(["bun", "install", "-g", "routstrd"]);
    expect(globalInstallCommand("routstrd", "deno")).toEqual([
      "deno",
      "install",
      "-gAf",
      "npm:routstrd",
    ]);
  });
});
