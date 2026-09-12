import { describe, expect, test } from "bun:test";
import { renderNpubs, renderRecent, renderStackedBar, tokenSegments } from "./render.ts";
import { stripAnsi } from "./terminal.ts";
import { COLORS } from "./constants.ts";
import { buildClientNaming, resolveClientLabel, type ClientInfo, type NpubEntry } from "./data.ts";
import type { UsageStats } from "./types.ts";

const NPUB = "npub1abcdefghijklmnopqrstuvwxyz0123456789abcdefghijklmnopq";

function statsFor(npub: string): UsageStats {
  return {
    entries: [],
    totalEntries: 3,
    totalSatsCost: 100,
    recentSatsCost: 100,
    limit: 50,
    summary: {
      npubs: [
        {
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
              promptTokens: 10,
              completionTokens: 20,
              cost: 0,
            } as never,
          ],
        },
      ],
    } as never,
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
  test("splits prompt tokens into cache read, cache write and fresh input", () => {
    expect(tokenSegments({ promptTokens: 10_000, completionTokens: 2500, cacheReadInputTokens: 9000, cacheCreationInputTokens: 1000 }))
      .toEqual({ fresh: 0, cacheRead: 9000, cacheWrite: 1000, output: 2500, total: 12_500 });
  });

  test("treats the whole prompt as fresh input when the cached counts cannot be part of it", () => {
    expect(tokenSegments({ promptTokens: 100, completionTokens: 20, cacheReadInputTokens: 5000 }))
      .toEqual({ fresh: 100, cacheRead: 5000, cacheWrite: 0, output: 20, total: 5120 });
  });

  test("tolerates entries without cache or token fields", () => {
    expect(tokenSegments({})).toEqual({ fresh: 0, cacheRead: 0, cacheWrite: 0, output: 0, total: 0 });
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
        promptTokens: 10_000,
        completionTokens: 2500,
        totalTokens: 12_500,
        cacheReadInputTokens: 9000,
        cacheCreationInputTokens: 1000,
        client: "pi-agent",
      },
    ],
  } as unknown as UsageStats;

  test("draws a coloured bar per row with the token total beside it", () => {
    const out = renderRecent(stats, 120, buildClientNaming([], []));

    // 9000 / 1000 / 2500 out of 12.5K on a 20-cell track -> 14/2/4 cells.
    expect(out).toContain(COLORS.green + "█".repeat(14) + COLORS.red + "█".repeat(2) + COLORS.blue + "█".repeat(4) + COLORS.reset);
    // Total tokens to the right of the bar, plus the colour legend.
    expect(stripAnsi(out)).toContain("12.5K");
    expect(stripAnsi(out)).toContain("bars: █ uncached input  █ cache read  █ cache write  █ output");
  });

  test("keeps every row the same visible width as the box", () => {
    for (const width of [200, 160, 140, 120, 110, 100, 90, 80, 70]) {
      const lines = stripAnsi(renderRecent(stats, width, buildClientNaming([], []))).split("\n");
      expect(lines.map((line) => line.length)).toEqual(lines.map(() => width));
    }
  });
});
