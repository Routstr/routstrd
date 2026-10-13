import { describe, expect, it } from "bun:test";
import { formatModelRefreshSummary, refreshModelsAndIntegrations } from "./index";

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

  it("reports the count even when it is zero, never 'no client integrations'", () => {
    expect(
      formatModelRefreshSummary(
        "Scheduled",
        { modelCount: 214, integrationCount: 0, failedCount: 0 },
        12_000,
      ),
    ).toBe("Scheduled refresh: 214 models, 0 client integration(s) in 12.0s");
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

describe("refreshModelsAndIntegrations startup policy", () => {
  const config = { port: 8008, host: "127.0.0.1", provider: "" };
  for (const label of ["Scheduled", "Manual"]) {
    it(`${label} refresh forces models by default`, async () => {
      const forces: (boolean | undefined)[] = [];
      const result = await refreshModelsAndIntegrations(
        async force => { forces.push(force); return [{ id: "m" }]; }, config, label, {},
        { getClientsList: async () => [], runIntegrationsForClients: async () => { throw new Error("no clients"); } },
      );
      expect(forces).toEqual([true]);
      expect(result.modelCount).toBe(1);
    });
  }
  it("startup reuses bootstrap evidence and still refreshes integrations", async () => {
    const forces: (boolean | undefined)[] = [];
    let runs = 0;
    const result = await refreshModelsAndIntegrations(
      async force => { forces.push(force); return [{ id: "m" }]; }, config, "Initial", { forceRefresh: false },
      {
        getClientsList: async () => [{ clientId: "pi-agent", name: "Pi Agent", apiKey: "key", createdAt: 0 }],
        runIntegrationsForClients: async () => { runs++; return { refreshed: 1, failed: 0 }; },
      },
    );
    expect(forces).toEqual([false]);
    expect(runs).toBe(1);
    expect(result).toEqual({ modelCount: 1, integrationCount: 1, failedCount: 0 });
  });
  it("disabled auto-refresh warms models without touching clients or integrations", async () => {
    const forces: (boolean | undefined)[] = [];
    const result = await refreshModelsAndIntegrations(
      async force => { forces.push(force); return [{ id: "m" }]; }, config, "Initial",
      { forceRefresh: false, refreshIntegrations: false },
      {
        getClientsList: async () => { throw new Error("unexpected clients query"); },
        runIntegrationsForClients: async () => { throw new Error("unexpected installer"); },
      },
    );
    expect(forces).toEqual([false]);
    expect(result).toEqual({ modelCount: 1, integrationCount: 0, failedCount: 0 });
  });
});
