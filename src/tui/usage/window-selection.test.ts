import { describe, expect, it } from "bun:test";
import { fetchUsageSummary } from "./data.ts";
import { createWindowSelection, LEGACY_WINDOW_NOTICE } from "./window-selection.ts";
import type { TimeWindow, UsageSummary } from "./types.ts";

function summary(window?: TimeWindow): UsageSummary {
  const totals = { requests: 3, promptTokens: 10, completionTokens: 20,
    totalTokens: 30, cost: 0, satsCost: 4321 };
  const aggregates = { totals, models: [], providers: [], clients: [], npubs: [],
    sizeBuckets: { tiny: { count: 3, cost: 4321 }, small: { count: 0, cost: 0 },
      medium: { count: 0, cost: 0 }, large: { count: 0, cost: 0 }, huge: { count: 0, cost: 0 } } };
  return { ...aggregates, generatedAt: 0, days: [], hoursToday: [], recent: [],
    ...(window ? { window: { window, ...aggregates, timeline: { bucket: "day" as const, points: [] } } } : {}) };
}

async function fetched(window: TimeWindow, legacy = false) {
  return (await fetchUsageSummary(window, async () => ({ output: summary(legacy ? undefined : window) })))!;
}

describe("legacy daemon window selection", () => {
  it("detects legacy capability while preserving timezone transport", async () => {
    let path = "";
    const stats = await fetchUsageSummary("7d", async (requested) => {
      path = requested;
      return { output: summary() };
    });
    expect(path).toContain("window=7d");
    expect(path).toContain(`timezone=${encodeURIComponent(Intl.DateTimeFormat().resolvedOptions().timeZone)}`);
    expect(stats!.supportsWindows).toBe(false);
    expect(stats!.window.window).toBe("all");
    expect(stats!.window.totals.satsCost).toBe(4321);
  });

  it("reconciles filtered selection, clears stale caches and disables both cycle directions", async () => {
    const selection = createWindowSelection();
    selection.cycle(1);
    const today = await fetched("today");
    selection.accept("today", today);
    selection.cycle(1);
    expect(selection.currentWindow).toBe("7d");
    const legacy = await fetched("7d", true);
    expect(selection.accept("7d", legacy)).toBe(legacy);
    expect(selection.currentWindow).toBe("all");
    expect(selection.notice).toBe(LEGACY_WINDOW_NOTICE);
    expect(selection.cycle(1)).toBe(legacy);
    expect(selection.cycle(-1)).toBe(legacy);
    expect(selection.currentWindow).toBe("all");
    // A later upgrade restores switching, but not the old filtered cache.
    selection.accept("all", await fetched("all"));
    expect(selection.supportsWindows).toBe(true);
    expect(selection.notice).toBe("");
    expect(selection.cycle(1)).toBeNull();
  });

  it("accepts a legacy response even when selection changed in flight", async () => {
    const selection = createWindowSelection();
    selection.cycle(1);
    selection.cycle(1);
    const legacy = await fetched("today", true);
    expect(selection.accept("today", legacy)).toBe(legacy);
    expect(selection.currentWindow).toBe("all");
  });

  it("caches late modern responses without painting over a newer selection", async () => {
    const selection = createWindowSelection();
    selection.cycle(1);
    selection.cycle(1);
    const today = await fetched("today");
    expect(selection.accept("today", today)).toBeNull();
    expect(selection.currentWindow).toBe("7d");
    expect(selection.cycle(-1)).toBe(today);
    const week = await fetched("7d");
    selection.cycle(1);
    expect(selection.accept("7d", week)).toBe(week);
    expect(selection.currentWindow).toBe("7d");
  });

  it("reconciles a modern response with the actual returned window", async () => {
    const selection = createWindowSelection();
    selection.cycle(1);
    const all = await fetched("all");
    expect(selection.accept("today", all)).toBe(all);
    expect(selection.currentWindow).toBe("all");
    expect(selection.cycle(1)).toBeNull();
  });
});
