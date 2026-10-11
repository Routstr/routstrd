import { describe, it, expect, beforeEach } from "bun:test";
import { createMemoryUsageTrackingDriver } from "@routstr/sdk/storage";
import type { UsageTrackingEntry } from "@routstr/sdk/storage";
import type { ClientEntry } from "../../utils/clients";
import { getUsageSummary, parseTimeWindow, __resetUsageSummaryCacheForTest } from "./usage-summary";

// ─── Test fixtures ────────────────────────────────────────────────────────────
//
// All timestamps are computed relative to "now" so the fixtures never age
// out of getUsageSummary's 30-day rolling window. We anchor to a recent UTC
// midnight ~10 days ago and keep the same hour-of-day structure the
// tz-bucketing assertions depend on.
//
// tz = 300 (UTC-5 / EST). After shifting by -300min, UTC dates become:
//   d1: <anchor> 10:00Z → local <anchor> 05:00 → local day "<anchor>"
//   d2: <anchor+1d> 03:00Z → local <anchor> 22:00 → local day "<anchor>"
//   d3: <anchor+1d> 06:00Z → local <anchor+1d> 01:00 → local day "<anchor+1d>"

const _BASE_UTC_MIDNIGHT = Math.floor(Date.now() / 86_400_000) * 86_400_000;
const _ANCHOR_MS = _BASE_UTC_MIDNIGHT - 10 * 86_400_000; // 10 days ago UTC
const D1 = _ANCHOR_MS + 10 * 3_600_000; // 10:00Z → local day <anchor>
const D2 = _ANCHOR_MS + 1 * 86_400_000 + 3 * 3_600_000; // 03:00Z next day → local day <anchor>
const D3 = _ANCHOR_MS + 1 * 86_400_000 + 6 * 3_600_000; // 06:00Z next day → local day <anchor+1d>

/** Compute the local-day date string the same way the SDK's day grouping does. */
function localDayDateStr(ts: number, tzOffsetMinutes: number): string {
  const d = new Date(ts - tzOffsetMinutes * 60_000);
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}-${String(d.getUTCDate()).padStart(2, "0")}`;
}

const BASE_ENTRY: Omit<UsageTrackingEntry, "id" | "timestamp" | "modelId" | "client" | "totalTokens"> = {
  baseUrl: "https://api.openai.com/",
  requestId: "req-1",
  cost: 0.01,
  satsCost: 10,
  promptTokens: 100,
  completionTokens: 50,
};

function makeEntry(
  id: string,
  overrides: Partial<UsageTrackingEntry> & Pick<UsageTrackingEntry, "id" | "timestamp" | "modelId" | "totalTokens">,
): UsageTrackingEntry {
  return {
    ...BASE_ENTRY,
    ...overrides,
    id,
  };
}

// Seed entries:
// - 2 entries for model-a, client-1 (owned by npub1)
// - 1 entry for model-b, client-2 (no npub)
// - 1 entry for model-a, no client (null client)
// - totalTokens spread across tiny (< 1000) and small (1000-10000) buckets

const ENTRIES: UsageTrackingEntry[] = [
  // model-a, client-1, day 2026-05-20 (D1), totalTokens=500 (tiny)
  makeEntry("e1", {
    id: "e1",
    timestamp: D1,
    modelId: "model-a",
    client: "client-1",
    totalTokens: 500,
    promptTokens: 350,
    completionTokens: 150,
    satsCost: 10,
    cost: 0.01,
  }),
  // model-a, client-1, day 2026-05-20 (D2), totalTokens=2000 (small)
  makeEntry("e2", {
    id: "e2",
    timestamp: D2,
    modelId: "model-a",
    client: "client-1",
    totalTokens: 2000,
    promptTokens: 1400,
    completionTokens: 600,
    satsCost: 20,
    cost: 0.02,
  }),
  // model-b, client-2, day 2026-05-21 (D3), totalTokens=800 (tiny)
  makeEntry("e3", {
    id: "e3",
    timestamp: D3,
    modelId: "model-b",
    client: "client-2",
    totalTokens: 800,
    promptTokens: 600,
    completionTokens: 200,
    satsCost: 8,
    cost: 0.008,
  }),
  // model-a, no client, day 2026-05-21 (D3), totalTokens=5000 (small)
  makeEntry("e4", {
    id: "e4",
    timestamp: D3 + 1000,
    modelId: "model-a",
    client: undefined,
    totalTokens: 5000,
    promptTokens: 3500,
    completionTokens: 1500,
    satsCost: 50,
    cost: 0.05,
  }),
];

const CLIENTS: ClientEntry[] = [
  {
    clientId: "client-1",
    name: "Client One",
    apiKey: "sk-client1",
    createdAt: D1 - 86400000,
    ownerNpub: "npub1abc",
  },
  {
    clientId: "client-2",
    name: "Client Two",
    apiKey: "sk-client2",
    createdAt: D1 - 86400000,
    // no ownerNpub
  },
];

const TZ = 300; // UTC-5 / EST

describe("getUsageSummary", () => {
  let driver: ReturnType<typeof createMemoryUsageTrackingDriver>;

  beforeEach(async () => {
    // Reset the module-level memo cache explicitly so each test starts cold.
    // Without this, tests 2-10 would share the cached object from test 1
    // (all use the same fixtures → identical cache key → same TTL window).
    __resetUsageSummaryCacheForTest();
    driver = createMemoryUsageTrackingDriver(ENTRIES);
  });

  it("returns correct totals", async () => {
    const summary = await getUsageSummary(driver, CLIENTS, TZ);

    expect(summary.totals.requests).toBe(4);
    expect(summary.totals.totalTokens).toBe(500 + 2000 + 800 + 5000);
    expect(summary.totals.promptTokens).toBe(350 + 1400 + 600 + 3500);
    expect(summary.totals.completionTokens).toBe(150 + 600 + 200 + 1500);
    expect(summary.totals.satsCost).toBe(10 + 20 + 8 + 50);
    expect(summary.totals.cost).toBeCloseTo(0.01 + 0.02 + 0.008 + 0.05, 5);
  });

  it("returns models sorted desc by satsCost", async () => {
    const summary = await getUsageSummary(driver, CLIENTS, TZ);
    const { models } = summary;

    // model-a: 3 entries (e1, e2, e4) total satsCost = 10+20+50 = 80
    // model-b: 1 entry (e3) satsCost = 8
    expect(models).toHaveLength(2);
    expect(models[0]!.modelId).toBe("model-a");
    expect(models[0]!.satsCost).toBe(80);
    expect(models[0]!.requests).toBe(3);
    expect(models[1]!.modelId).toBe("model-b");
    expect(models[1]!.satsCost).toBe(8);
  });

  it("returns days most-recent-first with correct tz-bucketing", async () => {
    const summary = await getUsageSummary(driver, CLIENTS, TZ);
    const { days } = summary;

    // D1 (10:00Z) and D2 (next day 03:00Z) both bucket to local day <anchor>;
    // D3 (next day 06:00Z) buckets to local day <anchor+1d>.
    // So: day <anchor> has e1+e2, day <anchor+1d> has e3+e4
    expect(days.length).toBeGreaterThanOrEqual(2);

    // Most-recent-first: <anchor+1d> first
    expect(days[0]!.date).toBe(localDayDateStr(D3, TZ));
    expect(days[0]!.requests).toBe(2); // e3, e4
    expect(days[0]!.satsCost).toBe(8 + 50);

    expect(days[1]!.date).toBe(localDayDateStr(D1, TZ));
    expect(days[1]!.requests).toBe(2); // e1, e2
    expect(days[1]!.satsCost).toBe(10 + 20);
  });

  it("returns empty hoursToday (test entries are not today)", async () => {
    const summary = await getUsageSummary(driver, CLIENTS, TZ);
    // Test entries are ~10 days ago, not today
    expect(summary.hoursToday).toHaveLength(0);
  });

  it("returns correct sizeBuckets", async () => {
    const summary = await getUsageSummary(driver, CLIENTS, TZ);
    const { sizeBuckets } = summary;

    // tiny [0, 1000): e1 (500) + e3 (800) = 2 entries
    expect(sizeBuckets.tiny.count).toBe(2);
    expect(sizeBuckets.tiny.cost).toBe(10 + 8);

    // small [1000, 10000): e2 (2000) + e4 (5000) = 2 entries
    expect(sizeBuckets.small.count).toBe(2);
    expect(sizeBuckets.small.cost).toBe(20 + 50);

    // medium, large, huge should be 0
    expect(sizeBuckets.medium.count).toBe(0);
    expect(sizeBuckets.large.count).toBe(0);
    expect(sizeBuckets.huge.count).toBe(0);
  });

  it("returns per-client topModels for top non-null clients", async () => {
    const summary = await getUsageSummary(driver, CLIENTS, TZ);
    const { clients } = summary;

    // client-1: e1 + e2 (model-a), satsCost = 30
    // client-2: e3 (model-b), satsCost = 8
    // unknown (null client): e4 (model-a), satsCost = 50
    // Sorted desc by satsCost: unknown (50), client-1 (30), client-2 (8)

    const c1 = clients.find((c) => c.client === "client-1");
    expect(c1).toBeDefined();
    expect(c1!.requests).toBe(2);
    expect(c1!.satsCost).toBe(30);
    // client-1 is in top 3 non-null clients, should have topModels
    expect(c1!.topModels.length).toBeGreaterThan(0);
    expect(c1!.topModels[0]!.modelId).toBe("model-a");

    const c2 = clients.find((c) => c.client === "client-2");
    expect(c2).toBeDefined();
    expect(c2!.requests).toBe(1);
    expect(c2!.satsCost).toBe(8);

    // unknown client (null group) should have empty topModels
    const unknown = clients.find((c) => c.client === "unknown");
    expect(unknown).toBeDefined();
    expect(unknown!.topModels).toHaveLength(0);
  });

  it("folds client rows into npubs correctly", async () => {
    const summary = await getUsageSummary(driver, CLIENTS, TZ);
    const { npubs } = summary;

    // Only client-1 has ownerNpub = "npub1abc"
    // npub1abc: e1 + e2 = requests 2, satsCost 30
    expect(npubs).toHaveLength(1);
    expect(npubs[0]!.npub).toBe("npub1abc");
    expect(npubs[0]!.requests).toBe(2);
    expect(npubs[0]!.satsCost).toBe(30);
    // Top models for npub1abc (clients: ["client-1"]): only model-a
    expect(npubs[0]!.topModels.length).toBeGreaterThan(0);
    expect(npubs[0]!.topModels[0]!.modelId).toBe("model-a");
  });

  it("returns recent entries (up to 50)", async () => {
    const summary = await getUsageSummary(driver, CLIENTS, TZ);
    expect(summary.recent).toHaveLength(4); // only 4 entries in driver
    // Should be sorted desc by timestamp
    expect(summary.recent[0]!.timestamp).toBeGreaterThanOrEqual(summary.recent[1]!.timestamp);
  });

  it("returns providers correctly", async () => {
    const summary = await getUsageSummary(driver, CLIENTS, TZ);
    const { providers } = summary;

    // All entries use the same baseUrl
    expect(providers).toHaveLength(1);
    expect(providers[0]!.baseUrl).toBe("https://api.openai.com/");
    expect(providers[0]!.requests).toBe(4);
  });

  it("caches results for same key within TTL", async () => {
    const summary1 = await getUsageSummary(driver, CLIENTS, TZ);
    const summary2 = await getUsageSummary(driver, CLIENTS, TZ);
    // Same object reference means it was served from cache
    expect(summary1).toBe(summary2);
  });
});

describe("parseTimeWindow", () => {
  it("accepts every known window", () => {
    expect(parseTimeWindow("all")).toBe("all");
    expect(parseTimeWindow("today")).toBe("today");
    expect(parseTimeWindow("7d")).toBe("7d");
    expect(parseTimeWindow("30d")).toBe("30d");
    expect(parseTimeWindow(" 7d ")).toBe("7d");
  });

  it("falls back to all for unknown/missing values", () => {
    expect(parseTimeWindow("bogus")).toBe("all");
    expect(parseTimeWindow("")).toBe("all");
    expect(parseTimeWindow(null)).toBe("all");
    expect(parseTimeWindow(undefined)).toBe("all");
  });
});

describe("getUsageSummary time windows", () => {
  let driver: ReturnType<typeof createMemoryUsageTrackingDriver>;

  // tz = 0 (UTC) keeps the assertions independent of the host timezone.
  const TZ0 = 0;
  const NOW = Date.now();
  const RECENT = NOW; // today
  const THREE_DAYS_AGO = NOW - 3 * 86_400_000;
  const TEN_DAYS_AGO = NOW - 10 * 86_400_000;

  const windowEntry = (
    id: string,
    timestamp: number,
    modelId: string,
    totalTokens: number,
    satsCost: number,
  ): UsageTrackingEntry => ({
    id,
    timestamp,
    modelId,
    baseUrl: "https://api.openai.com/",
    requestId: `req-${id}`,
    cost: satsCost / 1000,
    satsCost,
    promptTokens: Math.floor(totalTokens / 2),
    completionTokens: Math.floor(totalTokens / 2),
    totalTokens,
  });

  beforeEach(() => {
    __resetUsageSummaryCacheForTest();
    driver = createMemoryUsageTrackingDriver([
      windowEntry("w-recent", RECENT, "model-recent", 500, 5), // today, tiny
      windowEntry("w-mid", THREE_DAYS_AGO, "model-mid", 2000, 7), // 3d ago, small
      windowEntry("w-old", TEN_DAYS_AGO, "model-old", 50_000, 11), // 10d ago, large
    ]);
  });

  it("defaults to the all window when omitted", async () => {
    const summary = await getUsageSummary(driver, [], TZ0);
    expect(summary.window!.window).toBe("all");
    expect(summary.window!.totals.requests).toBe(3);
  });

  it("scopes the window block without touching the all-time fields", async () => {
    const summary = await getUsageSummary(driver, [], TZ0, undefined, "7d");

    // Window block: only the recent + 3-day-old entries.
    expect(summary.window!.window).toBe("7d");
    expect(summary.window!.totals.requests).toBe(2);
    expect(summary.window!.totals.satsCost).toBe(5 + 7);
    expect(summary.window!.models.map((m) => m.modelId).sort()).toEqual(["model-mid", "model-recent"]);

    // All-time fields are unaffected by the requested window.
    expect(summary.totals.requests).toBe(3);
    expect(summary.models).toHaveLength(3);
  });

  it("30d includes everything observed within 30 days", async () => {
    const summary = await getUsageSummary(driver, [], TZ0, undefined, "30d");
    expect(summary.window!.totals.requests).toBe(3);
    expect(summary.window!.totals.satsCost).toBe(5 + 7 + 11);
  });

  it("today only includes entries from the current day", async () => {
    const summary = await getUsageSummary(driver, [], TZ0, undefined, "today");
    expect(summary.window!.totals.requests).toBe(1);
    expect(summary.window!.models).toHaveLength(1);
    expect(summary.window!.models[0]!.modelId).toBe("model-recent");
  });

  it("scopes the windowed size buckets", async () => {
    const summary = await getUsageSummary(driver, [], TZ0, undefined, "7d");
    // w-recent (500) → tiny, w-mid (2000) → small, w-old excluded.
    expect(summary.window!.sizeBuckets.tiny.count).toBe(1);
    expect(summary.window!.sizeBuckets.small.count).toBe(1);
    expect(summary.window!.sizeBuckets.large.count).toBe(0);

    // All-time buckets still include the large entry.
    expect(summary.sizeBuckets.large.count).toBe(1);
  });

  it("mirrors the all-time aggregates for the all window", async () => {
    const summary = await getUsageSummary(driver, [], TZ0, undefined, "all");
    expect(summary.window!.totals).toEqual(summary.totals);
    expect(summary.window!.models).toEqual(summary.models);
    expect(summary.window!.sizeBuckets).toEqual(summary.sizeBuckets);
  });

  it("caches per window rather than sharing one entry", async () => {
    const all = await getUsageSummary(driver, [], TZ0, undefined, "all");
    const week = await getUsageSummary(driver, [], TZ0, undefined, "7d");
    // Different windows must not be served the same cached summary.
    expect(week).not.toBe(all);
    expect(week.window!.window).toBe("7d");
  });
});
