import { describe, expect, test } from "bun:test";
import { createUpdatePoller, DIRECT_CHECK_INTERVAL_MS, VERSION_READ_INTERVAL_MS } from "./update-poller.ts";
import type { VersionInfo } from "./data.ts";
import type { UpdateInfo } from "./types.ts";

const start = Date.parse("2026-01-02T12:00:00Z");
const available: VersionInfo = {
  version: "0.4.14", current: "0.4.14", latest: "0.5.0", hasUpdate: true,
  checkedAt: new Date(start).toISOString(),
};

function harness(options: {
  enabled?: boolean;
  info?: VersionInfo | null;
  failDirect?: boolean;
  failRead?: boolean;
} = {}) {
  let time = start;
  let reads = 0;
  let checks = 0;
  const banners: UpdateInfo[] = [];
  const poll = createUpdatePoller({
    now: () => time,
    loadConfig: async () => ({ updateCheck: options.enabled }),
    fetchVersionInfo: async () => {
      reads++;
      if (options.failRead) throw new Error("connection failed");
      return options.info === undefined ? available : options.info;
    },
    checkForUpdates: async () => {
      checks++;
      if (options.failDirect) throw new Error("offline");
      return { hasUpdate: false, packages: [] };
    },
    publish: (info) => banners.push(info),
  });
  return { poll, banners, advance: (ms: number) => { time += ms; }, counts: () => ({ reads, checks }) };
}

describe("TUI update polling", () => {
  test("disabled config makes no endpoint or direct calls and clears the banner", async () => {
    const h = harness({ enabled: false });
    await h.poll();
    h.advance(DIRECT_CHECK_INTERVAL_MS);
    await h.poll();
    expect(h.counts()).toEqual({ reads: 0, checks: 0 });
    expect(h.banners).toEqual([{ hasUpdate: false, text: "" }, { hasUpdate: false, text: "" }]);
  });

  test("missing config setting enables checks and a valid cache shows a banner", async () => {
    const h = harness();
    await h.poll();
    expect(h.banners).toEqual([{ hasUpdate: true, text: "Update available: routstrd 0.5.0" }]);
  });

  for (const [name, info] of [
    ["expired", { ...available, checkedAt: "2020-01-01T00:00:00Z" }],
    ["version mismatched", { ...available, current: "0.4.13" }],
    ["already installed", { ...available, latest: available.version }],
    ["missing timestamp", { ...available, checkedAt: null }],
    ["disabled daemon", { ...available, hasUpdate: false }],
  ] as const) {
    test(`${name} cache shows no banner and does not fall back`, async () => {
      const h = harness({ info });
      await h.poll();
      expect(h.banners).toEqual([{ hasUpdate: false, text: "" }]);
      expect(h.counts()).toEqual({ reads: 1, checks: 0 });
    });
  }

  for (const failDirect of [false, true]) {
    test(`legacy daemon uses separate read/direct attempt cadences (failure=${failDirect})`, async () => {
      const h = harness({ info: null, failDirect });
      await h.poll();
      h.advance(2000);
      await h.poll();
      expect(h.counts()).toEqual({ reads: 1, checks: 1 });
      h.advance(VERSION_READ_INTERVAL_MS - 2000);
      await h.poll();
      expect(h.counts()).toEqual({ reads: 2, checks: 1 });
      h.advance(DIRECT_CHECK_INTERVAL_MS - VERSION_READ_INTERVAL_MS);
      await h.poll();
      expect(h.counts()).toEqual({ reads: 3, checks: 2 });
    });
  }

  test("failed endpoint attempts are throttled too", async () => {
    const h = harness({ failRead: true });
    await h.poll();
    h.advance(2000);
    await h.poll();
    expect(h.counts()).toEqual({ reads: 1, checks: 0 });
    h.advance(VERSION_READ_INTERVAL_MS);
    await h.poll();
    expect(h.counts()).toEqual({ reads: 2, checks: 0 });
  });
});
