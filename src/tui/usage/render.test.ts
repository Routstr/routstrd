import { describe, expect, test } from "bun:test";
import { renderNpubs } from "./render.ts";
import { stripAnsi } from "./terminal.ts";
import type { NpubEntry } from "./data.ts";
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
    const npubs: NpubEntry[] = [{ npub: NPUB, name: "Alice", role: "admin" }];
    const out = stripAnsi(renderNpubs(statsFor(NPUB), npubs, 120));

    expect(out).toContain("Alice");
    expect(out).toContain("[admin]");
    // Full npub stays visible for copy-ability.
    expect(out).toContain(NPUB);
    // Name is used in the top-models section too.
    expect(out).toContain("Alice (3 reqs, 42.00 sats)");
  });

  test("falls back to a truncated npub when no name is configured", () => {
    const npubs: NpubEntry[] = [{ npub: NPUB, name: null, role: "user" }];
    const out = stripAnsi(renderNpubs(statsFor(NPUB), npubs, 120));

    expect(out).toContain(NPUB.slice(0, 10) + "…" + NPUB.slice(-6));
    expect(out).toContain("[user]");
  });

  test("renders when no npub metadata is available", () => {
    const out = stripAnsi(renderNpubs(statsFor(NPUB), [], 120));
    expect(out).toContain("Npub Breakdown");
  });
});
