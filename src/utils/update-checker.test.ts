import { describe, expect, test } from "bun:test";
import {
  checkRoutstrdUpdate,
  INTERACTIVE_CHECK_TIMEOUT_MS,
  isRunningGlobalInstall,
  type RoutstrdCheckDeps,
} from "./update-checker.ts";

const GLOBAL_DIR = "/home/user/.bun/install/global/node_modules";
const GLOBAL_MAIN = `${GLOBAL_DIR}/routstrd/dist/index.js`;
const CHECKOUT_MAIN = "/home/user/projects/routstrd/src/index.ts";

const release = (version: string) =>
  ({ version, archive: {}, checksums: {} }) as never;

function deps(overrides: Partial<RoutstrdCheckDeps>): Partial<RoutstrdCheckDeps> {
  return {
    version: "0.4.14",
    mainPath: GLOBAL_MAIN,
    globalDir: GLOBAL_DIR,
    getLatestStandalone: async () => release("0.4.14"),
    getLatestNpm: async () => null,
    ...overrides,
  };
}

describe("checkRoutstrdUpdate - standalone binary", () => {
  test("flags an update when the GitHub release is newer", async () => {
    expect(
      await checkRoutstrdUpdate(
        deps({ standalone: true, getLatestStandalone: async () => release("0.5.0") }),
      ),
    ).toEqual({ hasUpdate: true, current: "0.4.14", latest: "0.5.0" });
  });

  test("does not flag when already current", async () => {
    expect(await checkRoutstrdUpdate(deps({ standalone: true }))).toEqual({
      hasUpdate: false,
      current: "0.4.14",
      latest: "0.4.14",
    });
  });

  test("stays quiet when the release cannot be fetched", async () => {
    expect(
      await checkRoutstrdUpdate(
        deps({
          standalone: true,
          getLatestStandalone: async () => {
            throw new Error("offline");
          },
        }),
      ),
    ).toEqual({ hasUpdate: false, current: "0.4.14", latest: null });
  });
});

describe("checkRoutstrdUpdate - npm/bun install", () => {
  test("flags an update when the running global install is behind npm", async () => {
    expect(
      await checkRoutstrdUpdate(
        deps({
          standalone: false,
          getLatestNpm: async () => "0.5.0",
        }),
      ),
    ).toEqual({ hasUpdate: true, current: "0.4.14", latest: "0.5.0" });
  });

  test("does not flag when already current", async () => {
    expect(
      await checkRoutstrdUpdate(
        deps({
          standalone: false,
          getLatestNpm: async () => "0.4.14",
        }),
      ),
    ).toEqual({ hasUpdate: false, current: "0.4.14", latest: "0.4.14" });
  });

  test("skips a source checkout running the same version as the global install", async () => {
    // The bug: checkout and global install are both 0.4.14, so a version
    // comparison cannot tell them apart, but `bun install -g routstrd` would
    // not update the code that is running. The entry path distinguishes them.
    expect(
      await checkRoutstrdUpdate(
        deps({
          standalone: false,
          mainPath: CHECKOUT_MAIN,
          getLatestNpm: async () => "0.5.0",
        }),
      ),
    ).toEqual({ hasUpdate: false, current: "0.4.14", latest: "0.5.0" });
  });

  test("skips any run outside the global install directory", async () => {
    expect(
      await checkRoutstrdUpdate(
        deps({
          standalone: false,
          mainPath: "/usr/lib/node_modules/routstrd/dist/index.js",
          getLatestNpm: async () => "0.5.0",
        }),
      ),
    ).toEqual({ hasUpdate: false, current: "0.4.14", latest: "0.5.0" });
  });
});

describe("checkRoutstrdUpdate - startup timeout", () => {
  test("bounds the network lookup with the short interactive timeout", async () => {
    const seen: number[] = [];
    await checkRoutstrdUpdate(
      deps({
        standalone: false,
        getLatestNpm: async (_name, ms) => {
          seen.push(ms);
          return null;
        },
      }),
    );
    expect(seen).toEqual([INTERACTIVE_CHECK_TIMEOUT_MS]);
  });

  test("bounds the standalone release fetch with the same timeout", async () => {
    const seen: number[] = [];
    await checkRoutstrdUpdate(
      deps({
        standalone: true,
        getLatestStandalone: async (ms) => {
          seen.push(ms);
          return release("0.4.14");
        },
      }),
    );
    expect(seen).toEqual([INTERACTIVE_CHECK_TIMEOUT_MS]);
  });
});

describe("isRunningGlobalInstall", () => {
  test("accepts entries under the package's global directory", () => {
    expect(isRunningGlobalInstall("routstrd", GLOBAL_MAIN, GLOBAL_DIR)).toBe(true);
  });

  test("rejects entries outside the global directory", () => {
    expect(isRunningGlobalInstall("routstrd", CHECKOUT_MAIN, GLOBAL_DIR)).toBe(false);
  });

  test("rejects a sibling package with a matching prefix", () => {
    expect(
      isRunningGlobalInstall(
        "routstrd",
        `${GLOBAL_DIR}/routstrd-extra/dist/index.js`,
        GLOBAL_DIR,
      ),
    ).toBe(false);
  });
});
