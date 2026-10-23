import { describe, expect, it } from "bun:test";
import type { MeltOperation } from "@cashu/coco-core";
import {
  createMeltSweepState,
  MELT_SWEEP_BACKOFF_BASE_MS,
  MELT_SWEEP_BACKOFF_MAX_MS,
  settleMeltOperations,
  startMeltSweep,
  type MeltSweepSource,
} from "./melt-sweep";

type FakeMelt = MeltOperation & { refreshDelayMs?: number; refreshError?: Error };

function melt(overrides: Partial<FakeMelt> & { id: string; mintUrl?: string; state?: string }): FakeMelt {
  return {
    mintUrl: "https://mint.example",
    state: "pending",
    ...overrides,
  } as FakeMelt;
}

interface FakeSource extends MeltSweepSource {
  inFlight: FakeMelt[];
  refreshCalls: string[];
  refreshDelayMs: number;
  refreshError?: Error;
  refreshState?: (id: string) => string | undefined;
}

function makeSource(options: {
  inFlight?: FakeMelt[];
  refreshDelayMs?: number;
  refreshError?: Error;
  refreshState?: (id: string) => string | undefined;
} = {}): FakeSource {
  const inFlight = options.inFlight ?? [];
  const refreshCalls: string[] = [];
  const refreshDelayMs = options.refreshDelayMs ?? 0;
  const refreshError = options.refreshError;
  const refreshState = options.refreshState;
  return {
    inFlight,
    refreshCalls,
    refreshDelayMs,
    refreshError,
    refreshState,
    ops: {
      melt: {
        listInFlight: async () => inFlight as never,
        refresh: async (id: string) => {
          refreshCalls.push(id);
          if (refreshDelayMs > 0) {
            await new Promise((r) => setTimeout(r, refreshDelayMs));
          }
          if (refreshError) throw refreshError;
          const op = inFlight.find((candidate) => candidate.id === id);
          if (!op) throw new Error(`unknown op ${id}`);
          const nextState = refreshState?.(id) ?? op.state;
          return { ...op, state: nextState } as never;
        },
        diagnostics: { isLocked: () => false },
      },
    },
  };
}

describe("settleMeltOperations", () => {
  it("returns empty result when nothing is in flight", async () => {
    const source = makeSource();
    const result = await settleMeltOperations(source, Date.now());
    expect(result).toEqual({
      checked: 0,
      rolledBack: 0,
      finalized: 0,
      stillInFlight: 0,
      timedOut: 0,
      failed: 0,
      skippedLocked: 0,
      skippedMints: new Set(),
    });
    expect(source.refreshCalls).toEqual([]);
  });

  it("refreshes every in-flight operation and classifies each outcome", async () => {
    const source = makeSource({
      inFlight: [
        melt({ id: "paid", state: "pending" }),
        melt({ id: "expired", state: "pending" }),
        melt({ id: "alive", state: "pending" }),
      ],
      refreshState: (id) =>
        id === "paid" ? "finalized" : id === "expired" ? "rolled_back" : "pending",
    });
    const result = await settleMeltOperations(source, Date.now());
    expect(source.refreshCalls.sort()).toEqual(["alive", "expired", "paid"]);
    expect(result.finalized).toBe(1);
    expect(result.rolledBack).toBe(1);
    expect(result.stillInFlight).toBe(1);
    expect(result.checked).toBe(3);
    expect(result.failed).toBe(0);
    expect(result.timedOut).toBe(0);
  });

  it("respects shouldStop between operations", async () => {
    const source = makeSource({
      inFlight: [melt({ id: "a" }), melt({ id: "b" })],
    });
    let calls = 0;
    const result = await settleMeltOperations(source, Date.now(), {
      shouldStop: () => {
        calls++;
        return calls > 1;
      },
    });
    expect(source.refreshCalls).toHaveLength(1);
    expect(result.checked).toBe(1);
  });

  it("times out a hanging operation and counts it as unreachable", async () => {
    const source = makeSource({
      inFlight: [melt({ id: "slow" })],
      refreshDelayMs: 10_000,
    });
    const result = await settleMeltOperations(source, Date.now(), { opTimeoutMs: 25 });
    expect(result.checked).toBe(1);
    expect(result.timedOut).toBe(1);
    expect(result.failed).toBe(0);
    expect(result.stillInFlight).toBe(0);
  });

  it("counts thrown errors as failures and backs the mint off", async () => {
    const source = makeSource({
      inFlight: [melt({ id: "broken", mintUrl: "https://bad.example" })],
      refreshError: new Error("mint unreachable"),
    });
    const state = createMeltSweepState(new Map());
    const first = await settleMeltOperations(source, Date.now(), { state });
    expect(first.failed).toBe(1);

    const backoff = state.mintBackoff.get("https://bad.example");
    expect(backoff?.failures).toBe(1);
    expect(backoff?.nextAttemptAt).toBeGreaterThan(Date.now());

    // Second pass within the window skips the operation entirely.
    const second = await settleMeltOperations(source, Date.now(), { state });
    expect(second.skippedMints.has("https://bad.example")).toBe(true);
    expect(second.checked).toBe(0);
  });

  it("escalates backoff and caps it", async () => {
    const source = makeSource({
      inFlight: [melt({ id: "broken", mintUrl: "https://bad.example" })],
      refreshError: new Error("mint unreachable"),
    });
    const state = createMeltSweepState(new Map());
    for (let i = 0; i < 20; i++) {
      state.mintBackoff.set("https://bad.example", { failures: i, nextAttemptAt: 0 });
      await settleMeltOperations(source, Date.now(), { state });
    }
    const backoff = state.mintBackoff.get("https://bad.example");
    expect(backoff?.failures).toBeGreaterThan(1);
    // The delay must never exceed the cap.
    const delay = (backoff?.nextAttemptAt ?? 0) - Date.now();
    expect(delay).toBeLessThanOrEqual(MELT_SWEEP_BACKOFF_MAX_MS + 1_000);
    expect(MELT_SWEEP_BACKOFF_BASE_MS).toBeLessThanOrEqual(MELT_SWEEP_BACKOFF_MAX_MS);
  });

  it("clears backoff when the mint answers again", async () => {
    const inFlight = [melt({ id: "op", mintUrl: "https://flaky.example" })];
    const source = makeSource({ inFlight });
    const state = createMeltSweepState(new Map());
    state.mintBackoff.set("https://flaky.example", { failures: 3, nextAttemptAt: 0 });
    const result = await settleMeltOperations(source, Date.now(), { state });
    expect(result.checked).toBe(1);
    expect(state.mintBackoff.has("https://flaky.example")).toBe(false);
  });

  it("skips operations already being refreshed by an earlier pass", async () => {
    const source = makeSource({ inFlight: [melt({ id: "busy" })] });
    const state = createMeltSweepState(new Map());
    // Simulate an outstanding refresh from a previous timed-out pass.
    let release!: () => void;
    state.outstanding.set(
      "melt:busy",
      new Promise<void>((r) => {
        release = r;
      }),
    );
    const result = await settleMeltOperations(source, Date.now(), { state });
    expect(result.skippedLocked).toBe(1);
    expect(result.checked).toBe(0);
    release();
  });

  it("skips operations locked by coco's fail-fast operation lock", async () => {
    const inFlight = [melt({ id: "locked" })];
    const source = makeSource({ inFlight });
    const lockedSource: MeltSweepSource = {
      ops: {
        melt: {
          ...source.ops.melt,
          diagnostics: { isLocked: (id: string) => id === "locked" },
        },
      },
    };
    const result = await settleMeltOperations(lockedSource, Date.now());
    expect(result.skippedLocked).toBe(1);
    expect(source.refreshCalls).toEqual([]);
  });

  it("stops at the pass deadline instead of running every operation", async () => {
    const source = makeSource({
      inFlight: Array.from({ length: 5 }, (_, i) => melt({ id: `op${i}` })),
      refreshDelayMs: 30,
    });
    const result = await settleMeltOperations(source, Date.now(), {
      deadlineMs: 10,
      opTimeoutMs: 5,
    });
    expect(result.checked).toBeLessThan(5);
    expect(result.timedOut).toBeGreaterThan(0);
  });
});

describe("startMeltSweep", () => {
  it("runs a pass on the interval and stops cleanly", async () => {
    const source = makeSource({
      inFlight: [melt({ id: "op", state: "pending" })],
      refreshState: () => "rolled_back",
    });
    const stop = startMeltSweep(source, new Map(), {
      intervalMs: 10,
      opTimeoutMs: 100,
      deadlineMs: 1000,
    });
    await new Promise((r) => setTimeout(r, 60));
    await stop();
    expect(source.refreshCalls.length).toBeGreaterThanOrEqual(2);
  });

  it("is a no-op when the interval is disabled", async () => {
    const source = makeSource({ inFlight: [melt({ id: "op" })] });
    const stop = startMeltSweep(source, new Map(), { intervalMs: 0 });
    await new Promise((r) => setTimeout(r, 30));
    await stop();
    expect(source.refreshCalls).toEqual([]);
  });

  it("does not stack passes when one runs long", async () => {
    const source = makeSource({
      inFlight: [melt({ id: "op" })],
      refreshDelayMs: 40,
    });
    const stop = startMeltSweep(source, new Map(), {
      intervalMs: 5,
      opTimeoutMs: 200,
      deadlineMs: 500,
    });
    await new Promise((r) => setTimeout(r, 130));
    await stop();
    // With stacking we would see many calls; chained timers keep it low.
    expect(source.refreshCalls.length).toBeLessThanOrEqual(4);
  });

  it("stop waits for the running pass and drains outstanding work", async () => {
    const outstanding = new Map<string, Promise<unknown>>();
    let settled = false;
    outstanding.set(
      "melt:op",
      new Promise<void>((r) =>
        setTimeout(() => {
          settled = true;
          r();
        }, 20),
      ),
    );
    const source = makeSource();
    const stop = startMeltSweep(source, outstanding, {
      intervalMs: 10,
      opTimeoutMs: 100,
      deadlineMs: 1000,
    });
    await stop();
    expect(settled).toBe(true);
  });
});
