import { describe, expect, test } from "bun:test";
import { renderNpubs, renderRecent } from "./render.ts";
import { stripAnsi } from "./terminal.ts";
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
