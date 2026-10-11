import { describe, expect, test } from "bun:test";
import {
  checkRoutstrdUpdate,
  type RoutstrdCheckDeps,
} from "./update-checker.ts";

const release = (version: string) =>
  ({ version, archive: {}, checksums: {} }) as never;

function deps(overrides: Partial<RoutstrdCheckDeps>): Partial<RoutstrdCheckDeps> {
  return {
    version: "0.4.14",
    getLatestStandalone: async () => release("0.4.14"),
    getGlobalVersion: async () => null,
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
          getGlobalVersion: async () => "0.4.14",
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
          getGlobalVersion: async () => "0.4.14",
          getLatestNpm: async () => "0.4.14",
        }),
      ),
    ).toEqual({ hasUpdate: false, current: "0.4.14", latest: "0.4.14" });
  });

  test("skips source checkouts that are not the global install", async () => {
    // Running checkout is 0.4.14 but the global install is a different (older)
    // version, so `bun install -g routstrd` would not update what is running.
    expect(
      await checkRoutstrdUpdate(
        deps({
          standalone: false,
          getGlobalVersion: async () => "0.3.10",
          getLatestNpm: async () => "0.5.0",
        }),
      ),
    ).toEqual({ hasUpdate: false, current: "0.4.14", latest: "0.5.0" });
  });

  test("skips when routstrd is not globally installed at all", async () => {
    expect(
      await checkRoutstrdUpdate(
        deps({
          standalone: false,
          getGlobalVersion: async () => null,
          getLatestNpm: async () => "0.5.0",
        }),
      ),
    ).toEqual({ hasUpdate: false, current: "0.4.14", latest: "0.5.0" });
  });
});
