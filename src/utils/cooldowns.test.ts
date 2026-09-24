import { describe, expect, test } from "bun:test";
import {
  buildCooldownsOutput,
  formatCooldownRemaining,
  formatCooldowns,
  type StoredCooldownEntry,
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
