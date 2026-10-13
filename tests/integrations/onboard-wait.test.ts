import { describe, expect, it } from "bun:test";
import { waitForModels } from "../../src/integrations";

function fakeClock() {
  let t = 0;
  return { now: () => t, sleep: async (ms: number) => { t += ms; } };
}

describe("waitForModels (onboarding)", () => {
  it("retries empty and failing /models responses until models load", async () => {
    const clock = fakeClock();
    const responses = [
      { output: { models: [] } },
      { error: "bootstrapping" },
      { output: { models: [{ id: "a" }, { id: "b" }] } },
    ];
    let calls = 0;
    const logs: string[] = [];
    const result = await waitForModels({
      ...clock,
      callDaemon: async () => responses[calls++]!,
      log: (m) => logs.push(m),
      retryDelayMs: 1_000,
    });
    expect(result).toEqual({ ok: true, count: 2 });
    expect(calls).toBe(3);
    expect(logs.at(-1)).toContain("Loaded 2 models");
  });

  it("gives up with the last reason after the timeout instead of throwing", async () => {
    const clock = fakeClock();
    let calls = 0;
    const result = await waitForModels({
      ...clock,
      callDaemon: async () => { calls++; throw new Error("Daemon request timed out"); },
      log: () => {},
      timeoutMs: 10_000,
      retryDelayMs: 3_000,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toContain("within 10s");
      expect(result.reason).toContain("Daemon request timed out");
    }
    expect(calls).toBe(4); // attempts at 0, 3, 6, 9s; a 12s retry would exceed 10s
  });
});
