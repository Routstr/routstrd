import { describe, expect, test } from "bun:test";
import {
  buildCooldownsOutput,
  formatCooldownRemaining,
  formatCooldowns,
  type StoredCooldownEntry,
  type StoredFailureStreak,
} from "./cooldowns";

const WINDOW_MS = 210 * 1000;
const NOW = 1_700_000_000_000;

function entry(
  baseUrl: string,
  ageMs: number,
  modelId?: string,
): StoredCooldownEntry {
  return modelId === undefined
    ? { baseUrl, timestamp: NOW - ageMs }
    : { baseUrl, modelId, timestamp: NOW - ageMs };
}

describe("buildCooldownsOutput", () => {
  test("is empty when nothing is stored", () => {
    const output = buildCooldownsOutput([], WINDOW_MS, NOW);
    expect(output.count).toBe(0);
    expect(output.providerCount).toBe(0);
    expect(output.cooldowns).toEqual([]);
    expect(output.cooldownDurationMs).toBe(WINDOW_MS);
  });

  test("drops entries that already expired", () => {
    const output = buildCooldownsOutput(
      [
        entry("https://expired.example/", WINDOW_MS),
        entry("https://expired-long-ago.example/", 86_400_000),
        entry("https://live.example/", 1_000),
      ],
      WINDOW_MS,
      NOW,
    );
    expect(output.cooldowns.map((c) => c.baseUrl)).toEqual([
      "https://live.example/",
    ]);
  });

  test("tags provider-wide and model-scoped entries and computes expiry", () => {
    const output = buildCooldownsOutput(
      [
        entry("https://provider.example/", 30_000),
        entry("https://model.example/", 60_000, "kimi-k3"),
      ],
      WINDOW_MS,
      NOW,
    );

    expect(output.count).toBe(2);
    expect(output.providerCount).toBe(2);

    const [first, second] = output.cooldowns;
    // Longest remaining first: the provider-wide entry aged 30s of 210s.
    expect(first!).toEqual({
      baseUrl: "https://provider.example/",
      modelId: null,
      modelPath: null,
      scope: "provider",
      startedAt: NOW - 30_000,
      expiresAt: NOW - 30_000 + WINDOW_MS,
      remainingMs: WINDOW_MS - 30_000,
    });
    expect(second!.scope).toBe("model");
    expect(second!.modelId).toBe("kimi-k3");
    expect(second!.remainingMs).toBe(WINDOW_MS - 60_000);
  });

  test("counts distinct providers once, even with several cooled models", () => {
    const output = buildCooldownsOutput(
      [
        entry("https://a.example/", 1_000, "m1"),
        entry("https://a.example/", 2_000, "m2"),
        entry("https://a.example/", 3_000),
      ],
      WINDOW_MS,
      NOW,
    );
    expect(output.count).toBe(3);
    expect(output.providerCount).toBe(1);
  });

  test("keeps exponential entries past the fixed window via cooldownUntil", () => {
    // A streak-5 cooldown expires ~10 minutes out; the fixed 210s window
    // must not make it vanish from the listing.
    const output = buildCooldownsOutput(
      [
        {
          baseUrl: "https://long.example/",
          modelId: "kimi-k3",
          timestamp: NOW - 300_000, // 5 min ago, beyond the 210s window
          cooldownUntil: NOW + 300_000, // 5 min remaining
        },
      ],
      WINDOW_MS,
      NOW,
    );
    expect(output.count).toBe(1);
    expect(output.cooldowns[0]!.expiresAt).toBe(NOW + 300_000);
    expect(output.cooldowns[0]!.remainingMs).toBe(300_000);
  });

  test("drops exponential entries whose cooldownUntil already passed", () => {
    const output = buildCooldownsOutput(
      [
        {
          baseUrl: "https://done.example/",
          modelId: "kimi-k3",
          timestamp: NOW - 1_000,
          cooldownUntil: NOW - 1,
        },
      ],
      WINDOW_MS,
      NOW,
    );
    expect(output.count).toBe(0);
  });

  test("tags path-scoped entries and prefers cooldownUntil", () => {
    const output = buildCooldownsOutput(
      [
        {
          baseUrl: "https://path.example/",
          modelId: "kimi-k3",
          modelPath: "/v1/messages",
          timestamp: NOW - 20_000,
          cooldownUntil: NOW + 40_000,
        },
      ],
      WINDOW_MS,
      NOW,
    );
    expect(output.cooldowns[0]!.scope).toBe("path");
    expect(output.cooldowns[0]!.modelPath).toBe("/v1/messages");
    expect(output.cooldowns[0]!.remainingMs).toBe(40_000);
  });

  test("lists failure streaks that are not currently on cooldown", () => {
    const streaks: StoredFailureStreak[] = [
      // Cooled right now: excluded from the streaks section.
      { baseUrl: "https://cooled.example/", modelId: "m1", failureStreak: 4, failedAt: NOW - 5_000 },
      { baseUrl: "https://flaky.example/", modelId: "m2", failureStreak: 3, failedAt: NOW - 60_000 },
      { baseUrl: "https://flaky.example/", modelPath: "/v1/messages", failureStreak: 7, failedAt: NOW - 10_000 },
      // Older than the 6h retention: the SDK has already forgotten it.
      { baseUrl: "https://stale.example/", modelId: "m3", failureStreak: 9, failedAt: NOW - 7 * 3_600_000 },
      // Zero streak: nothing to report.
      { baseUrl: "https://fine.example/", modelId: "m4", failureStreak: 0, failedAt: NOW - 1_000 },
      // Legacy entry without failedAt: reported with unknown age.
      { baseUrl: "https://legacy.example/", modelId: "m5", failureStreak: 2 },
    ];
    const output = buildCooldownsOutput(
      [
        {
          baseUrl: "https://cooled.example/",
          modelId: "m1",
          timestamp: NOW - 1_000,
          cooldownUntil: NOW + 60_000,
        },
      ],
      WINDOW_MS,
      NOW,
      streaks,
    );

    expect(output.streaks!.map((s) => [s.baseUrl, s.failureStreak])).toEqual([
      ["https://flaky.example/", 7],
      ["https://flaky.example/", 3],
      ["https://legacy.example/", 2],
    ]);
    const pathStreak = output.streaks![0]!;
    expect(pathStreak.scope).toBe("path");
    expect(pathStreak.modelPath).toBe("/v1/messages");
    expect(pathStreak.ageMs).toBe(10_000);
    expect(output.streaks![2]!.ageMs).toBeNull();
    expect(output.streaks![2]!.lastFailedAt).toBeNull();
  });

  test("leaves streaks undefined when the store has none (older SDK)", () => {
    const output = buildCooldownsOutput([], WINDOW_MS, NOW);
    expect(output.streaks).toBeUndefined();
    const withEmpty = buildCooldownsOutput([], WINDOW_MS, NOW, []);
    expect(withEmpty.streaks).toEqual([]);
  });

  test("treats an empty-string modelId as model-scoped", () => {
    // The SDK keys `modelId: ""` as a model-scoped entry, so it must not be
    // reported as a provider-wide cooldown.
    const output = buildCooldownsOutput(
      [entry("https://empty.example/", 1_000, "")],
      WINDOW_MS,
      NOW,
    );
    expect(output.cooldowns[0]!.scope).toBe("model");
    expect(output.cooldowns[0]!.modelId).toBe("");
  });
});

describe("formatCooldownRemaining", () => {
  test("formats sub-minute, minute, and clamped negative values", () => {
    expect(formatCooldownRemaining(0)).toBe("0s");
    expect(formatCooldownRemaining(42_000)).toBe("42s");
    expect(formatCooldownRemaining(65_000)).toBe("1m 05s");
    expect(formatCooldownRemaining(WINDOW_MS)).toBe("3m 30s");
    expect(formatCooldownRemaining(-5_000)).toBe("0s");
  });
});

describe("formatCooldowns", () => {
  test("reports an empty cooldown list", () => {
    expect(
      formatCooldowns(buildCooldownsOutput([], WINDOW_MS, NOW)),
    ).toBe("Cooldowns (210s window)\n\n  Nothing is on cooldown right now.");
  });

  test("lists provider-wide and model-scoped cooldowns with remaining time", () => {
    const text = formatCooldowns(
      buildCooldownsOutput(
        [
          {
            baseUrl: "https://provider.example/",
            timestamp: NOW - (WINDOW_MS - 120_000),
          },
          {
            baseUrl: "https://model.example/",
            modelId: "kimi-k3",
            timestamp: NOW - (WINDOW_MS - 60_000),
          },
        ],
        WINDOW_MS,
        NOW,
      ),
    );

    expect(text.split("\n")).toEqual([
      "Cooldowns (210s window)",
      "",
      "  2 active across 2 providers:",
      "",
      "  PROVIDER  https://provider.example/  expires in 2m 00s",
      "  MODEL     https://model.example/     kimi-k3  expires in 1m 00s",
    ]);
  });

  test("renders path-scoped rows with their path", () => {
    const text = formatCooldowns(
      buildCooldownsOutput(
        [
          {
            baseUrl: "https://path.example/",
            modelId: "kimi-k3",
            modelPath: "/v1/messages",
            timestamp: NOW - 20_000,
            cooldownUntil: NOW + 40_000,
          },
        ],
        WINDOW_MS,
        NOW,
      ),
    );
    expect(text).toContain(
      "  PATH      https://path.example/  kimi-k3 /v1/messages  expires in 40s",
    );
  });

  test("renders a streaks section after the active cooldowns", () => {
    const text = formatCooldowns(
      buildCooldownsOutput(
        [],
        WINDOW_MS,
        NOW,
        [
          { baseUrl: "https://flaky.example/", modelId: "kimi-k3", failureStreak: 3, failedAt: NOW - 90_000 },
          { baseUrl: "https://legacy.example/", failureStreak: 1 },
        ],
      ),
    );
    expect(text.split("\n")).toEqual([
      "Cooldowns (210s window)",
      "",
      "  Nothing is on cooldown right now.",
      "",
      "  Recent failures (streaks):",
      "",
      "  MODEL     https://flaky.example/   kimi-k3  streak 3, last failed 1m 30s ago",
      "  PROVIDER  https://legacy.example/  streak 1, last failed unknown",
    ]);
  });

  test("omits the streaks section when the daemon predates streaks", () => {
    const output = buildCooldownsOutput([], WINDOW_MS, NOW);
    expect(formatCooldowns(output)).toBe(
      "Cooldowns (210s window)\n\n  Nothing is on cooldown right now.",
    );
    // An empty streaks array (new SDK, no failures) renders the same way.
    expect(formatCooldowns(buildCooldownsOutput([], WINDOW_MS, NOW, []))).toBe(
      "Cooldowns (210s window)\n\n  Nothing is on cooldown right now.",
    );
  });

  test("uses the singular provider label for a single provider", () => {
    const text = formatCooldowns(
      buildCooldownsOutput(
        [{ baseUrl: "https://one.example/", timestamp: NOW - 1_000 }],
        WINDOW_MS,
        NOW,
      ),
    );
    expect(text).toContain("1 active across 1 provider:");
  });
});
