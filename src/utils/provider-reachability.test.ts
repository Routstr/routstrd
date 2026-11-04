import { describe, expect, it } from "bun:test";
import {
  assessProviderReachability,
  formatLastSeen,
  formatProviderList,
  normalizeNodeBaseUrl,
  orderProvidersForDisplay,
  PROVIDER_REACHABILITY_TTL_MS,
} from "./provider-reachability";

const NOW = 1_900_000_000_000;
const HOUR = 60 * 60 * 1000;
const NODE = "https://node.example/";

describe("normalizeNodeBaseUrl", () => {
  it("adds the trailing slash the SDK keys its caches on", () => {
    expect(normalizeNodeBaseUrl("https://node.example")).toBe(NODE);
    expect(normalizeNodeBaseUrl("https://node.example/")).toBe(NODE);
  });

  it("defaults a bare host to https, like the daemon does elsewhere", () => {
    expect(normalizeNodeBaseUrl("node.example")).toBe(NODE);
  });
});

describe("assessProviderReachability", () => {
  it("reports a node fetched within the window as reachable", () => {
    const [verdict] = assessProviderReachability(
      [NODE],
      {
        lastModelsUpdate: { [NODE]: NOW - 5 * 60_000 },
        modelsFromAllProviders: { [NODE]: [{ id: "a" }, { id: "b" }] },
      },
      NOW,
    );
    expect(verdict!).toEqual({
      reachable: true,
      lastModelFetchAt: NOW - 5 * 60_000,
      modelCount: 2,
    });
  });

  it("calls a node that never answered unreachable", () => {
    const [verdict] = assessProviderReachability(
      [NODE],
      // Evidence exists (another node is fresh) but not for this one.
      { lastModelsUpdate: { "https://other.example/": NOW - 60_000 } },
      NOW,
    );
    expect(verdict!).toMatchObject({
      reachable: false,
      lastModelFetchAt: null,
      reason: "never-fetched",
    });
  });

  it("calls a node past the window stale, at the boundary", () => {
    // A fresh sibling is what tells the helper a fetch pass actually ran;
    // without it every verdict fails open (covered below).
    const evidence = { "https://fresh.example/": NOW - 60_000 };

    const inWindow: number[] = assessProviderReachability(
      [NODE],
      {
        lastModelsUpdate: {
          ...evidence,
          [NODE]: NOW - PROVIDER_REACHABILITY_TTL_MS,
        },
      },
      NOW,
    ).map((v) => (v.reachable ? 1 : 0));
    expect(inWindow).toEqual([1]);

    const [stale] = assessProviderReachability(
      [NODE],
      {
        lastModelsUpdate: {
          ...evidence,
          [NODE]: NOW - PROVIDER_REACHABILITY_TTL_MS - 1,
        },
      },
      NOW,
    );
    expect(stale!).toMatchObject({
      reachable: false,
      lastModelFetchAt: NOW - PROVIDER_REACHABILITY_TTL_MS - 1,
      reason: "stale",
    });
  });

  it("treats a zero timestamp as never fetched", () => {
    // The SDK zeroes a provider's stamp when it drops out of the provider set.
    const [verdict] = assessProviderReachability(
      [NODE],
      {
        lastModelsUpdate: { [NODE]: 0, "https://other.example/": NOW - 60_000 },
      },
      NOW,
    );
    expect(verdict!).toMatchObject({ reachable: false, reason: "never-fetched" });
  });

  it("does not call a future timestamp fresh (clock moved backwards)", () => {
    const [verdict] = assessProviderReachability(
      [NODE],
      {
        lastModelsUpdate: {
          [NODE]: NOW + HOUR,
          "https://fresh.example/": NOW - 60_000,
        },
      },
      NOW,
    );
    expect(verdict!.reachable).toBe(false);
  });

  it("fails open when nothing has been fetched yet", () => {
    const verdicts = assessProviderReachability(
      [NODE, "https://b.example/"],
      {},
      NOW,
    );
    expect(verdicts.every((v) => v.reachable)).toBe(true);
    expect(verdicts.every((v) => v.reason === undefined)).toBe(true);
  });

  it("fails open when every timestamp is stale (daemon just restarted)", () => {
    // Nothing has answered since boot, so "all down" cannot be told apart from
    // "the first pass has not run yet".
    const verdicts = assessProviderReachability(
      [NODE],
      { lastModelsUpdate: { [NODE]: NOW - 30 * 24 * HOUR } },
      NOW,
    );
    expect(verdicts[0]!.reachable).toBe(true);
    // The evidence is still reported, so the caller can show how old it is.
    expect(verdicts[0]!.lastModelFetchAt).toBe(NOW - 30 * 24 * HOUR);
  });

  it("keeps one verdict per input URL, in order", () => {
    const verdicts = assessProviderReachability(
      ["https://a.example/", "https://b.example/", "https://c.example/"],
      {
        lastModelsUpdate: {
          "https://a.example/": NOW - 60_000,
          "https://c.example/": NOW - 60_000,
        },
      },
      NOW,
    );
    expect(verdicts.map((v) => v.reachable)).toEqual([true, false, true]);
  });
});

describe("formatLastSeen", () => {
  const at = (ms: number) => formatLastSeen(NOW - ms, NOW);

  it("says so when the node never answered", () => {
    expect(formatLastSeen(null, NOW)).toBe("never fetched");
  });

  it("renders seconds, minutes, hours and days", () => {
    expect(at(5_000)).toBe("last seen 5s ago");
    expect(at(3 * 60_000)).toBe("last seen 3m ago");
    expect(at(3 * HOUR + 12 * 60_000)).toBe("last seen 3h 12m ago");
    expect(at(8 * 24 * HOUR)).toBe("last seen 8d ago");
  });
});

describe("formatProviderList", () => {
  const NOW = 1_900_000_000_000;
  const base = {
    totalCount: 3,
    disabledCount: 1,
    reachableCount: 1,
    unreachableCount: 2,
    hiddenCount: 2,
  };

  it("renders the reachable list plus how many are hidden", () => {
    const out = formatProviderList(
      {
        ...base,
        includeUnreachable: false,
        providers: [
          { index: 0, baseUrl: "https://a.example/", disabled: false, reachable: true },
        ],
      },
      NOW,
    );
    expect(out).toContain("Providers (1 reachable of 3 discovered, 1 disabled):");
    expect(out).toContain("  [0] enabled  https://a.example/");
    expect(out).toContain(
      "  2 unreachable nodes hidden — pass --all to list them.",
    );
    expect(out).not.toContain("a.example/  https");
  });

  it("marks unreachable nodes with when they were last seen under --all", () => {
    const out = formatProviderList(
      {
        ...base,
        includeUnreachable: true,
        hiddenCount: 0,
        providers: [
          { index: 0, baseUrl: "https://a.example/", disabled: false, reachable: true },
          {
            index: 1,
            baseUrl: "https://b.example/",
            disabled: false,
            reachable: false,
            lastModelFetchAt: NOW - 8 * 24 * 60 * 60 * 1000,
          },
          {
            index: 2,
            baseUrl: "https://c.example/",
            disabled: true,
            reachable: false,
            lastModelFetchAt: null,
          },
        ],
      },
      NOW,
    );
    expect(out).toContain("UNREACHABLE (last seen 8d ago)  https://b.example/");
    expect(out).toContain("UNREACHABLE (never fetched)     https://c.example/");
    expect(out).toContain(
      "  2 of the 3 discovered nodes are unreachable.",
    );
    expect(out).not.toContain("hidden");
  });

  it("keeps the enable/disable statuses when the node is reachable", () => {
    const out = formatProviderList(
      {
        totalCount: 3,
        disabledCount: 2,
        reachableCount: 3,
        providers: [
          { index: 0, baseUrl: "https://a.example/", disabled: true, manuallyDisabled: true, reachable: true },
          { index: 1, baseUrl: "https://b.example/", disabled: true, reachable: true },
          { index: 2, baseUrl: "https://c.example/", disabled: false, manuallyEnabled: true, reachable: true },
        ],
      },
      NOW,
    );
    expect(out).toContain("DISABLED (manual)          https://a.example/");
    expect(out).toContain("DISABLED (nostr review)    https://b.example/");
    expect(out).toContain("enabled (manual override)  https://c.example/");
  });

  it("renders an older daemon's payload without claiming reachability", () => {
    const out = formatProviderList(
      {
        totalCount: 2,
        disabledCount: 0,
        providers: [
          { index: 0, baseUrl: "https://a.example/", disabled: false },
          { index: 1, baseUrl: "https://b.example/", disabled: false },
        ],
      },
      NOW,
    );
    expect(out).toContain("Providers (2 total, 0 disabled):");
    expect(out).not.toContain("reachable");
    expect(out).toContain("  [0] enabled  https://a.example/");
    expect(out).not.toContain("UNREACHABLE");
    expect(out).not.toContain("hidden");
  });
});

describe("assessProviderReachability store key spellings", () => {
  it("finds a node whose discovery entry carries no scheme", () => {
    const [verdict] = assessProviderReachability(
      ["node.example"],
      {
        lastModelsUpdate: { "node.example/": NOW - 60_000 },
        modelsFromAllProviders: { "node.example/": [{ id: "m" }] },
      },
      NOW,
    );
    expect(verdict).toMatchObject({
      reachable: true,
      lastModelFetchAt: NOW - 60_000,
      modelCount: 1,
    });
  });

  it("does not double-prefix a scheme-ful key", () => {
    const [verdict] = assessProviderReachability(
      ["https://node.example"],
      { lastModelsUpdate: { "https://node.example/": NOW - 60_000 } },
      NOW,
    );
    expect(verdict).toMatchObject({ reachable: true, lastModelFetchAt: NOW - 60_000 });
  });
});

describe("orderProvidersForDisplay", () => {
  it("moves unreachable nodes to the bottom and keeps discovery order inside a group", () => {
    const rows = [
      { baseUrl: "https://a.example/", reachable: false },
      { baseUrl: "https://b.example/", reachable: true },
      { baseUrl: "https://c.example/", reachable: false },
      { baseUrl: "https://d.example/", reachable: true },
    ];
    expect(orderProvidersForDisplay(rows).map((row) => row.baseUrl)).toEqual([
      "https://b.example/",
      "https://d.example/",
      "https://a.example/",
      "https://c.example/",
    ]);
  });

  it("treats a row with no verdict (an older payload) as reachable", () => {
    const rows = [
      { baseUrl: "https://a.example/" },
      { baseUrl: "https://b.example/", reachable: false },
    ];
    expect(orderProvidersForDisplay(rows).map((row) => row.baseUrl)).toEqual([
      "https://a.example/",
      "https://b.example/",
    ]);
  });

  it("does not mutate the caller's array", () => {
    const rows = [
      { baseUrl: "https://a.example/", reachable: false },
      { baseUrl: "https://b.example/", reachable: true },
    ];
    orderProvidersForDisplay(rows);
    expect(rows.map((row) => row.baseUrl)).toEqual([
      "https://a.example/",
      "https://b.example/",
    ]);
  });
});
