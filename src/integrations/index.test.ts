import { describe, expect, it } from "bun:test";
import { formatModelRefreshSummary } from "./index";

describe("formatModelRefreshSummary", () => {
  it("collapses a whole pass into one line", () => {
    expect(
      formatModelRefreshSummary(
        "Scheduled",
        { modelCount: 214, integrationCount: 3, failedCount: 0 },
        33_400,
      ),
    ).toBe("Scheduled refresh: 214 models, 3 client integration(s) in 33.4s");
  });

  it("says so when no client is registered", () => {
    expect(
      formatModelRefreshSummary(
        "Scheduled",
        { modelCount: 214, integrationCount: 0, failedCount: 0 },
        12_000,
      ),
    ).toBe("Scheduled refresh: 214 models, no client integrations in 12.0s");
  });

  it("surfaces integration failures that used to be counted nowhere", () => {
    expect(
      formatModelRefreshSummary(
        "Initial",
        { modelCount: 7, integrationCount: 2, failedCount: 1 },
        1_050,
      ),
    ).toBe("Initial refresh: 7 models, 2 client integration(s), 1 failed in 1.1s");
  });

  it("labels the pass so startup and scheduled refreshes are distinguishable", () => {
    expect(
      formatModelRefreshSummary(
        "Initial",
        { modelCount: 1, integrationCount: 0, failedCount: 0 },
        500,
      ).startsWith("Initial refresh:"),
    ).toBe(true);
  });
});
