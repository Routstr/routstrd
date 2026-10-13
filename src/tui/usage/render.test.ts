import { describe, expect, test } from "bun:test";
import { renderBox, renderHistory, renderModels, renderNpubs, renderOverview, renderRecent, renderStackedBar, renderTimelineChart, renderWindowBar, renderWindowSelector, tokenSegments } from "./render.ts";
import { stripAnsi } from "./terminal.ts";
import { COLORS } from "./constants.ts";
import { buildClientNaming, resolveClientLabel, type ClientInfo, type NpubEntry } from "./data.ts";
import type { TimelinePoint, UsageStats } from "./types.ts";

const NPUB = "npub1abcdefghijklmnopqrstuvwxyz0123456789abcdefghijklmnopq";

function statsFor(npub: string): UsageStats {
  const npubSummary = {
    npub,
    requests: 3,
    promptTokens: 10,
    completionTokens: 20,
    totalTokens: 30,
    cost: 0,
    satsCost: 42,
    topModels: [
      {
        modelId: "gpt-5.4",
        requests: 3,
        satsCost: 42,
        totalTokens: 30,
      },
    ],
  };

  return {
    entries: [],
    totalEntries: 3,
    totalSatsCost: 100,
    recentSatsCost: 100,
    limit: 50,
    summary: {
      npubs: [npubSummary],
    } as never,
    window: {
      window: "all",
      totals: { requests: 3, promptTokens: 10, completionTokens: 20, totalTokens: 30, cost: 0, satsCost: 42 },
      models: [],
      providers: [],
      clients: [],
      npubs: [npubSummary],
      sizeBuckets: {
        tiny: { count: 0, cost: 0 },
        small: { count: 0, cost: 0 },
        medium: { count: 0, cost: 0 },
        large: { count: 0, cost: 0 },
        huge: { count: 0, cost: 0 },
      },
      timeline: { bucket: "day", points: [] },
    },
  };
}

describe("renderNpubs", () => {
  test("shows the configured display name and role", () => {
    const naming = buildClientNaming([], [{ npub: NPUB, name: "Alice", role: "admin" }]);
    const out = stripAnsi(renderNpubs(statsFor(NPUB), naming, 120));

    expect(out).toContain("Alice");
    expect(out).toContain("[admin]");
    // Full npub stays visible for copy-ability.
    expect(out).toContain(NPUB);
    // Name is used in the top-models section too.
    expect(out).toContain("Alice (3 reqs, 42.00 sats)");
  });

  test("falls back to a truncated npub when no name is configured", () => {
    const naming = buildClientNaming([], [{ npub: NPUB, name: null, role: "user" }]);
    const out = stripAnsi(renderNpubs(statsFor(NPUB), naming, 120));

    expect(out).toContain(NPUB.slice(0, 10) + "…" + NPUB.slice(-6));
    expect(out).toContain("[user]");
  });

  test("renders when no npub metadata is available", () => {
    const out = stripAnsi(renderNpubs(statsFor(NPUB), buildClientNaming([], []), 120));
    expect(out).toContain("Npub Breakdown");
  });
});

describe("resolveClientLabel", () => {
  const client: ClientInfo = { clientId: "claude-code", name: "Claude Code", ownerNpub: NPUB };
  const withName = buildClientNaming([client], [{ npub: NPUB, name: "Alice", role: "admin" }]);

  test("shows owner name and strips the npub suffix", () => {
    expect(resolveClientLabel(`claude-code-${NPUB.slice(-7)}`, withName)).toBe("Alice (claude-code)");
  });

  test("falls back to the bare client id when the owner has no name", () => {
    const unnamed = buildClientNaming([client], [{ npub: NPUB, name: null, role: "user" }]);
    expect(resolveClientLabel(`claude-code-${NPUB.slice(-7)}`, unnamed)).toBe("claude-code");
  });

  test("leaves unsuffixed ids and local mode untouched", () => {
    expect(resolveClientLabel("claude-code", withName)).toBe("Alice (claude-code)");
    expect(resolveClientLabel("pi-agent", buildClientNaming([], []))).toBe("pi-agent");
  });
});

describe("renderRecent", () => {
  test("renders Name (bare-id) with the owner suffix stripped", () => {
    const naming = buildClientNaming(
      [{ clientId: "claude-code", name: "Claude Code", ownerNpub: NPUB }],
      [{ npub: NPUB, name: "Alice", role: "admin" }],
    );
    const stats = {
      ...statsFor(NPUB),
      entries: [
        {
          id: "1",
          timestamp: Date.now(),
          modelId: "gpt-5.4",
          baseUrl: "https://api.example.com",
          provider: "openai",
          requestId: "r1",
          cost: 0,
          satsCost: 1,
          promptTokens: 10,
          completionTokens: 20,
          totalTokens: 30,
          client: `claude-code-${NPUB.slice(-7)}`,
        },
      ],
    } as unknown as UsageStats;

    const out = stripAnsi(renderRecent(stats, 120, naming));
    expect(out).toContain("Alice (claude-code)");
    expect(out).not.toContain(NPUB.slice(-7));
  });

  test("keeps the raw client id when there is no owner metadata", () => {
    const stats = {
      ...statsFor(NPUB),
      entries: [
        {
          id: "1",
          timestamp: Date.now(),
          modelId: "gpt-5.4",
          baseUrl: "https://api.example.com",
          requestId: "r1",
          cost: 0,
          satsCost: 1,
          promptTokens: 10,
          completionTokens: 20,
          totalTokens: 30,
          client: "pi-agent",
        },
      ],
    } as unknown as UsageStats;

    const out = stripAnsi(renderRecent(stats, 120, buildClientNaming([], [])));
    expect(out).toContain("pi-agent");
  });
});

describe("renderStackedBar", () => {
  test("splits the track in proportion to the segment values", () => {
    const bar = stripAnsi(renderStackedBar(
      [{ value: 9000, color: COLORS.green }, { value: 1000, color: COLORS.red }, { value: 2500, color: COLORS.blue }],
      20,
    ));
    expect(bar).toBe("█".repeat(20));
    expect(bar.length).toBe(20);
  });

  test("hands rounding leftovers to the largest remainders so the track is always full", () => {
    const bar = renderStackedBar(
      [{ value: 1, color: COLORS.green }, { value: 1, color: COLORS.red }, { value: 1, color: COLORS.blue }],
      10,
    );
    // 10/3 = 3.33 -> 3/3/3 plus one leftover cell, coloured with the reset only once.
    expect(bar.startsWith(COLORS.green + "█".repeat(4) + COLORS.red + "█".repeat(3) + COLORS.blue + "█".repeat(3))).toBe(true);
    expect(bar.endsWith(COLORS.reset)).toBe(true);
    expect(stripAnsi(bar).length).toBe(10);
  });

  test("renders an empty track when there are no tokens", () => {
    expect(renderStackedBar([{ value: 0, color: COLORS.green }], 6)).toBe(" ".repeat(6));
  });
});

describe("tokenSegments", () => {
  test("splits the prompt into cache read and everything that was not cached", () => {
    expect(tokenSegments({ promptTokens: 10_000, completionTokens: 2500, cacheReadInputTokens: 9000, cacheCreationInputTokens: 1000 }))
      .toEqual({ cacheRead: 9000, notCached: 1000, input: 10_000, output: 2500, total: 12_500 });
  });

  test("counts uncached input alongside cache writes when the cache counts are extra", () => {
    expect(tokenSegments({ promptTokens: 100, completionTokens: 20, cacheReadInputTokens: 5000, cacheCreationInputTokens: 300 }))
      .toEqual({ cacheRead: 5000, notCached: 400, input: 5400, output: 20, total: 5420 });
  });

  test("reports a fully cache-read prompt with no not-cached input", () => {
    expect(tokenSegments({ promptTokens: 128_000, completionTokens: 42, cacheReadInputTokens: 128_000 }))
      .toEqual({ cacheRead: 128_000, notCached: 0, input: 128_000, output: 42, total: 128_042 });
  });

  test("tolerates entries without cache or token fields", () => {
    expect(tokenSegments({})).toEqual({ cacheRead: 0, notCached: 0, input: 0, output: 0, total: 0 });
  });
});

describe("renderRecent token bars", () => {
  const stats = {
    ...statsFor(NPUB),
    entries: [
      {
        id: "1",
        timestamp: Date.now(),
        modelId: "gpt-5.4",
        baseUrl: "https://api.example.com",
        provider: "openai",
        requestId: "r1",
        cost: 0,
        satsCost: 1,
        inputMsats: 1000,
        outputMsats: 2000,
        totalMsats: 3000,
        promptTokens: 10_000,
        completionTokens: 2500,
        totalTokens: 12_500,
        cacheReadInputTokens: 9000,
        cacheCreationInputTokens: 1000,
        client: "pi-agent",
      },
    ],
  } as unknown as UsageStats;

  test("draws a green/red bar per row with input/output tokens beside it", () => {
    const out = renderRecent(stats, 120, buildClientNaming([], []));

    // 9000 cache read / 1000 not cached out of 10K input on a 20-cell track.
    expect(out).toContain(COLORS.green + "█".repeat(18) + COLORS.red + "█".repeat(2) + COLORS.reset);
    // No blue (output) segment: output is reported as the second number.
    expect(out).not.toContain(COLORS.blue + "█");
    // IN and OUT are pinned to opposite ends of the column.
    expect(stripAnsi(out)).toContain("10.0K - 2.5K");
    expect(stripAnsi(out)).toContain("IN    -  OUT");
    // The bar is labelled `CACHE HIT` and no longer carries a legend line.
    expect(stripAnsi(out)).toContain("CACHE HIT");
    expect(stripAnsi(out)).not.toContain("bars:");
  });

  test("shows only the total cost in sats, not the input/output breakdown", () => {
    const out = stripAnsi(renderRecent(stats, 120, buildClientNaming([], [])));

    expect(out).toContain("COST");
    // 3000 total msats -> 3.00 sats; the 1.00/2.00 input/output split is gone.
    expect(out).toContain("3.00 sats");
    expect(out).not.toContain("1.00 sats");
    expect(out).not.toContain("2.00 sats");

    // The header is right-aligned: it ends at the same column as the values.
    const lines = out.split("\n");
    const headerEnd = lines[1]!.indexOf("COST") + "COST".length;
    const valueEnd = lines[3]!.indexOf("3.00 sats") + "3.00 sats".length;
    expect(headerEnd).toBe(valueEnd);
  });

  test("keeps every row the same visible width as the box", () => {
    for (const width of [200, 160, 140, 120, 110, 100, 90, 80, 70]) {
      const lines = stripAnsi(renderRecent(stats, width, buildClientNaming([], []))).split("\n");
      expect(lines.map((line) => line.length)).toEqual(lines.map(() => width));
    }
  });
});

/** Visible column count of a rendered line, ignoring ANSI colour codes. */
function visibleWidths(box: string): number[] {
  return box.split("\n").map((line) => stripAnsi(line).length);
}

describe("renderWindowBar", () => {
  test("lists every window and marks the active one", () => {
    const out = stripAnsi(renderWindowBar("7d", "models"));
    expect(out).toContain("window:");
    expect(out).toContain("All");
    expect(out).toContain("24h");
    expect(out).toContain("7d");
    expect(out).toContain("30d");
    // The active window is highlighted (not rendered dim).
    expect(renderWindowBar("7d", "models")).toContain(`${COLORS.bgGreen}${COLORS.bold} 7d ${COLORS.reset}`);
  });

  test("is hidden on tabs that ignore the window", () => {
    for (const tab of ["overview", "recent"] as const) {
      expect(renderWindowBar("7d", tab)).toBe("");
    }
    expect(stripAnsi(renderWindowBar("7d", "tokens"))).toContain("window:");
    // History is driven by the window (its chart re-buckets per range).
    expect(stripAnsi(renderWindowBar("7d", "history"))).toContain("window:");
  });

  test("leaves the chrome to the tabs that render it inline", () => {
    // Overview still honours the window; only the chrome bar is dropped.
    expect(renderWindowBar("7d", "overview")).toBe("");
    expect(stripAnsi(renderWindowSelector("7d"))).toContain("7d");
    expect(stripAnsi(renderWindowSelector("7d"))).toContain("[W] cycle");
  });
});

describe("renderOverview", () => {
  const balance = { keys: [{ id: "wallet", name: "Wallet", balance: 1000 }], total: 1000, unit: "sat" as const, apikeysCalled: 0 };

  /** All-time figures differ from the windowed ones so each is identifiable. */
  const windowedStats = {
    ...statsFor(NPUB),
    totalEntries: 888,
    totalSatsCost: 7777,
    summary: {
      totals: { requests: 888, promptTokens: 0, completionTokens: 0, totalTokens: 0, cost: 0, satsCost: 7777 },
      models: [],
      clients: [],
    },
    window: {
      window: "7d",
      totals: { requests: 5, promptTokens: 100, completionTokens: 50, totalTokens: 150, cost: 0, satsCost: 12.34 },
      models: [{ modelId: "windowed-model", requests: 5, promptTokens: 100, completionTokens: 50, totalTokens: 150, cost: 0, satsCost: 12.34 }],
      providers: [],
      clients: [{ client: "pi-agent", requests: 5, promptTokens: 100, completionTokens: 50, totalTokens: 150, cost: 0, satsCost: 12.34, topModels: [] }],
      npubs: [],
      sizeBuckets: {
        tiny: { count: 0, cost: 0 },
        small: { count: 0, cost: 0 },
        medium: { count: 0, cost: 0 },
        large: { count: 0, cost: 0 },
        huge: { count: 0, cost: 0 },
      },
    },
  } as unknown as UsageStats;

  test("scopes every total to the active window", () => {
    const out = stripAnsi(renderOverview(windowedStats, balance, null, 120, "7d"));

    expect(out).toContain("12.34 sats");
    expect(out).toContain("Total Requests: 5");
    expect(out).toContain("windowed-model");
    expect(out).toContain("pi-agent");
    // The all-time figures are not shown on the Overview tab.
    expect(out).not.toContain("7.78k");
    expect(out).not.toContain("888");
  });

  test("renders the window selector directly under the Balance box", () => {
    const out = renderOverview(windowedStats, balance, null, 120, "7d");
    const lines = stripAnsi(out).split("\n");

    const balanceIdx = lines.findIndex((line) => line.includes("Balance"));
    const windowIdx = lines.findIndex((line) => line.includes("Time Window"));
    const statsIdx = lines.findIndex((line) => line.includes("Stats of Sats"));

    expect(balanceIdx).toBeGreaterThanOrEqual(0);
    expect(windowIdx).toBeGreaterThan(balanceIdx);
    expect(statsIdx).toBeGreaterThan(windowIdx);
    // The selected window is the highlighted one.
    expect(out).toContain(`${COLORS.bgGreen}${COLORS.bold} 7d ${COLORS.reset}`);
  });

  test("renders the selector even without balance data", () => {
    const out = stripAnsi(renderOverview(windowedStats, null, null, 120, "all"));

    expect(out).toContain("Time Window");
    expect(out).toContain("Status unavailable");
  });
});

describe("windowed rendering", () => {
  test("renderModels reads the window block, not the all-time aggregates", () => {
    const stats = {
      ...statsFor(NPUB),
      summary: {
        models: [{ modelId: "all-time-model", requests: 9, promptTokens: 0, completionTokens: 0, totalTokens: 0, cost: 0, satsCost: 99 }],
      } as never,
      window: {
        window: "7d",
        totals: { requests: 1, promptTokens: 0, completionTokens: 0, totalTokens: 0, cost: 0, satsCost: 5 },
        models: [{ modelId: "windowed-model", requests: 1, promptTokens: 0, completionTokens: 10, totalTokens: 10, cost: 0, satsCost: 5 }],
        providers: [],
        clients: [],
        npubs: [],
        sizeBuckets: {
          tiny: { count: 0, cost: 0 },
          small: { count: 0, cost: 0 },
          medium: { count: 0, cost: 0 },
          large: { count: 0, cost: 0 },
          huge: { count: 0, cost: 0 },
        },
      },
    } as unknown as UsageStats;

    const out = stripAnsi(renderModels(stats, 100));
    expect(out).toContain("windowed-model");
    expect(out).not.toContain("all-time-model");
  });
});

const TIMELINE_POINTS: TimelinePoint[] = [
  { key: "00", timestamp: 0, requests: 1, satsCost: 10, totalTokens: 100, promptTokens: 60, completionTokens: 40 },
  { key: "01", timestamp: 1, requests: 2, satsCost: 30, totalTokens: 400, promptTokens: 300, completionTokens: 100 },
  { key: "02", timestamp: 2, requests: 0, satsCost: 0, totalTokens: 0, promptTokens: 0, completionTokens: 0 },
  { key: "03", timestamp: 3, requests: 3, satsCost: 20, totalTokens: 50, promptTokens: 30, completionTokens: 20 },
];

describe("renderTimelineChart", () => {
  test("draws grouped spend/token bars with dual axes and a legend", () => {
    const lines = stripAnsi(renderTimelineChart(TIMELINE_POINTS, "hour", 60).join("\n")).split("\n");
    const text = lines.join("\n");

    // Default height 10 + headroom + bottom axis + x labels + legend.
    expect(lines).toHaveLength(14);
    expect(lines[0]).toContain("30"); // peak sats (left axis)
    expect(lines[0]).toContain("400"); // peak tokens (right axis)
    expect(lines[0]).not.toContain("█"); // headroom row carries ticks only
    expect(text).toContain("00");
    expect(text).toContain("03");
    expect(text).toContain("spend");
    expect(text).toContain("left: sats · right: tokens");
    // The all-zero bucket has no bars while its neighbours do.
    expect(text).toContain("█");
  });

  test("labels day/week buckets as MM-DD", () => {
    const weeks: TimelinePoint[] = [
      { key: "2026-01-05", timestamp: 0, requests: 1, satsCost: 5, totalTokens: 10, promptTokens: 5, completionTokens: 5 },
      { key: "2026-01-12", timestamp: 1, requests: 1, satsCost: 5, totalTokens: 10, promptTokens: 5, completionTokens: 5 },
    ];
    const text = stripAnsi(renderTimelineChart(weeks, "week", 60).join("\n"));
    expect(text).toContain("01-05");
    expect(text).toContain("01-12");
  });

  test("reports an empty window instead of drawing", () => {
    expect(renderTimelineChart([], "day", 60)).toEqual(["No activity in this window"]);
    const zeroed: TimelinePoint[] = [
      { key: "00", timestamp: 0, requests: 0, satsCost: 0, totalTokens: 0, promptTokens: 0, completionTokens: 0 },
    ];
    expect(renderTimelineChart(zeroed, "hour", 60)).toEqual(["No activity in this window"]);
  });
});

describe("renderHistory", () => {
  const stats = {
    ...statsFor(NPUB),
    window: {
      window: "today",
      totals: { requests: 128, promptTokens: 57_300_000, completionTokens: 24_600_000, totalTokens: 81_900_000, cost: 0, satsCost: 11_700 },
      models: [],
      providers: [],
      clients: [],
      npubs: [],
      sizeBuckets: {
        tiny: { count: 0, cost: 0 },
        small: { count: 0, cost: 0 },
        medium: { count: 0, cost: 0 },
        large: { count: 0, cost: 0 },
        huge: { count: 0, cost: 0 },
      },
      timeline: { bucket: "hour", points: TIMELINE_POINTS },
    },
  } as unknown as UsageStats;

  test("shows the window totals above the spend/token chart", () => {
    const out = stripAnsi(renderHistory(stats, 100));
    expect(out).toContain("History — last 24 hours");
    expect(out).toContain("spent");
    expect(out).toContain("11.70k sats");
    expect(out).toContain("Spend per hour");
    expect(out).toContain("left: sats · right: tokens");
  });

  test("grows the chart to fill the requested height", () => {
    expect(stripAnsi(renderHistory(stats, 100, 20)).split("\n")).toHaveLength(20);
    expect(stripAnsi(renderHistory(stats, 100, 40)).split("\n")).toHaveLength(40);
  });

  test("keeps every rendered line at the requested width", () => {
    for (const width of [120, 100, 80, 60, 40]) {
      const lines = stripAnsi(renderHistory(stats, width)).split("\n");
      expect(lines.map((line) => line.length)).toEqual(lines.map(() => width));
    }
  });
});

describe("renderBox", () => {
  test("renders every line at the requested width when given a title", () => {
    const box = renderBox(["Hello World", "Line 2"], 40, "Title");

    expect(box.split("\n")).toHaveLength(4); // top, 2 content rows, bottom
    for (const width of visibleWidths(box)) {
      expect(width).toBe(40);
    }
  });

  test("renders every line at the requested width without a title", () => {
    const box = renderBox(["Hello World", "Line 2"], 40);

    for (const width of visibleWidths(box)) {
      expect(width).toBe(40);
    }
  });

  test("puts the title in the top border", () => {
    const [topBorder] = renderBox(["body"], 40, "Stats of Sats").split("\n");

    expect(topBorder).toContain("Stats of Sats");
  });

  test("pads content rows so ANSI-coloured lines still align", () => {
    const colored = "\x1b[32mgreen\x1b[0m";
    const box = renderBox([colored, "plain"], 30);

    for (const width of visibleWidths(box)) {
      expect(width).toBe(30);
    }
  });

  test("truncates overlong content lines instead of breaking the border", () => {
    const long = "x".repeat(100);
    const box = renderBox([long, "short"], 30);

    for (const width of visibleWidths(box)) {
      expect(width).toBe(30);
    }
    expect(stripAnsi(box)).toContain("x".repeat(26));
  });

  test("composes two half-width boxes into rows of the full width", () => {
    const width = 80;
    const halfWidth1 = Math.floor(width / 2);
    const halfWidth2 = width - halfWidth1;

    const left = renderBox(
      ["Total Spent: 12.78k sats", "Total Requests: 1.0k"],
      halfWidth1,
      "Stats of Sats",
    ).split("\n");
    const right = renderBox(
      ["Total Tokens: 25.8M", "Avg Tokens/Req: 25.8K"],
      halfWidth2,
      "Token Stats",
    ).split("\n");

    expect(left).toHaveLength(right.length);
    for (let i = 0; i < left.length; i++) {
      expect(stripAnsi(left[i]! + right[i]!).length).toBe(width);
    }
  });

  test("pads the shorter side when the two boxes have unequal heights", () => {
    const width = 80;
    const halfWidth1 = Math.floor(width / 2);
    const halfWidth2 = width - halfWidth1;

    const left = renderBox(["a", "b", "c"], halfWidth1, "Left").split("\n");
    const right = renderBox(["x"], halfWidth2, "Right").split("\n");

    const rows = Math.max(left.length, right.length);
    for (let i = 0; i < rows; i++) {
      const l = left[i] ?? " ".repeat(halfWidth1);
      const r = right[i] ?? " ".repeat(halfWidth2);
      expect(stripAnsi(l + r).length).toBe(width);
    }
  });
});
