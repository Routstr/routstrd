import { describe, expect, it } from "bun:test";
import { renderWalletHealth } from "./cli";
import type { WalletDoctorReport } from "./daemon/wallet/doctor";

const NOW = 1_800_000_000_000;

function report(overrides: Partial<WalletDoctorReport> = {}): WalletDoctorReport {
  return {
    generatedAt: NOW,
    mints: [],
    unpaidQuotes: [],
    paidUnissued: [],
    stuckMelts: [],
    uncheckedQuotes: 0,
    ...overrides,
  };
}

describe("renderWalletHealth", () => {
  it("renders an all-green report", () => {
    const output = renderWalletHealth(
      report({
        mints: [
          { mintUrl: "https://mint.example", reachable: true, latencyMs: 212 },
        ],
      }),
    );
    expect(output).toContain("Wallet health");
    expect(output).toContain("✓ https://mint.example — reachable (212 ms)");
    expect(output).toContain("none unpaid");
    expect(output).toContain("none stuck");
  });

  it("renders unreachable mints with their error", () => {
    const output = renderWalletHealth(
      report({
        mints: [
          { mintUrl: "https://mint.down", reachable: false, error: "fetch failed" },
        ],
      }),
    );
    expect(output).toContain("✗ https://mint.down — unreachable: fetch failed");
  });

  it("renders unpaid quotes with age and expiry", () => {
    const output = renderWalletHealth(
      report({
        unpaidQuotes: [
          {
            operationId: "op-1234567890abcdef",
            quoteId: "quote-abcdef1234567890",
            mintUrl: "https://mint.example",
            amount: 500,
            ageMs: 5 * 60_000,
            expiresInMs: 41 * 60_000,
          },
        ],
      }),
    );
    expect(output).toContain("⚠ quote-ab… at https://mint.example — 500 sat, UNPAID");
    expect(output).toContain("created 5m ago, expires in 41m");
  });

  it("renders paid-unissued findings with the recover remediation", () => {
    const output = renderWalletHealth(
      report({
        paidUnissued: [
          {
            operationId: "op-1234567890abcdef",
            quoteId: "quote-abcdef1234567890",
            mintUrl: "https://mint.example",
            amount: 1_000,
            localState: "failed",
            remoteState: "PAID",
            error: "keyset id inactive.",
            remediation: "routstrd wallet recover --op op-1234567890abcdef --include-failed",
          },
        ],
      }),
    );
    expect(output).toContain("✗ op-12345… (quote quote-ab…)");
    expect(output).toContain("1,000 sat PAID at mint, local state failed");
    expect(output).toContain("mint error: keyset id inactive.");
    expect(output).toContain(
      "→ routstrd wallet recover --op op-1234567890abcdef --include-failed",
    );
  });

  it("renders stuck melts with locked totals and remediation", () => {
    const output = renderWalletHealth(
      report({
        stuckMelts: [
          {
            operationId: "melt-1234567890",
            mintUrl: "https://mint.example",
            amount: 2_100,
            feeReserve: 12,
            ageMs: 3 * 86_400_000,
            kind: "prepared",
            lockedSecrets: 4,
            remediation: "routstrd wallet cleanup",
          },
          {
            operationId: "melt-abcdef",
            mintUrl: "https://mint.example",
            amount: 50,
            feeReserve: 2,
            ageMs: 90_000,
            kind: "failed-locked",
            lockedSecrets: 1,
            remediation: "restart the daemon",
          },
        ],
      }),
    );
    expect(output).toContain(
      "⚠ melt-123… at https://mint.example — 2,112 sat locked (4 proof(s)), prepared, payment never attempted, 3d old",
    );
    expect(output).toContain("✗ melt-abcdef at");
    expect(output).toContain("failed but proofs still locked");
  });

  it("notes quotes that could not be checked", () => {
    const output = renderWalletHealth(report({ uncheckedQuotes: 3 }));
    expect(output).toContain("3 quote(s) could not be checked with their mint");
  });
});
