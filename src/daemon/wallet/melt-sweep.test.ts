import { describe, expect, it } from "bun:test";
import { HttpResponseError, MintFetchError, MintOperationError, NetworkError, OperationInProgressError, type MeltOperation } from "@cashu/coco-core";
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
          const op = inFlight.find((candidate) => candidate.id === id);
          if (!op) throw new Error(`unknown op ${id}`);
          const delayMs = op.refreshDelayMs ?? refreshDelayMs;
          if (delayMs > 0) {
            await new Promise((r) => setTimeout(r, delayMs));
          }
          const error = op.refreshError ?? refreshError;
          if (error) throw error;
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
    const result = await settleMeltOperations(source);
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
    const result = await settleMeltOperations(source);
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
    const result = await settleMeltOperations(source, {
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
    const result = await settleMeltOperations(source, { opTimeoutMs: 25 });
    expect(result.checked).toBe(1);
    expect(result.timedOut).toBe(1);
    expect(result.failed).toBe(0);
    expect(result.stillInFlight).toBe(0);
  });

  it("counts thrown errors as failures and backs the mint off", async () => {
    const source = makeSource({
      inFlight: [melt({ id: "broken", mintUrl: "https://bad.example" })],
      refreshError: new NetworkError("mint unreachable"),
    });
    const state = createMeltSweepState(new Map());
    const first = await settleMeltOperations(source, { state });
    expect(first.failed).toBe(1);

    const backoff = state.mintBackoff.get("https://bad.example");
    expect(backoff?.failures).toBe(1);
    expect(backoff?.nextAttemptAt).toBeGreaterThan(Date.now());

    // Second pass within the window skips the operation entirely.
    const second = await settleMeltOperations(source, { state });
    expect(second.skippedMints.has("https://bad.example")).toBe(true);
    expect(second.checked).toBe(0);
  });

  it("escalates backoff and caps it", async () => {
    const source = makeSource({
      inFlight: [melt({ id: "broken", mintUrl: "https://bad.example" })],
      refreshError: new NetworkError("mint unreachable"),
    });
    const state = createMeltSweepState(new Map());
    for (let i = 0; i < 20; i++) {
      state.mintBackoff.set("https://bad.example", { failures: i, nextAttemptAt: 0 });
      await settleMeltOperations(source, { state });
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
    const result = await settleMeltOperations(source, { state });
    expect(result.checked).toBe(1);
    expect(state.mintBackoff.has("https://flaky.example")).toBe(false);
  });

  it("spends only one timeout on a slow mint and reaches a healthy mint", async () => {
    const source = makeSource({
      inFlight: [
        ...Array.from({ length: 4 }, (_, i) => melt({
          id: `slow-${i}`, mintUrl: "https://slow.example/", refreshDelayMs: 100,
        })),
        melt({ id: "healthy", mintUrl: "https://healthy.example" }),
      ],
    });
    const state = createMeltSweepState(new Map());
    const result = await settleMeltOperations(source, { state, opTimeoutMs: 10, deadlineMs: 1000 });
    expect(source.refreshCalls).toEqual(["slow-0", "healthy"]);
    expect(result.timedOut).toBe(1);
    expect(result.stillInFlight).toBe(1);
    expect(result.skippedMints.has("https://slow.example")).toBe(true);
    expect(state.mintBackoff.get("https://slow.example")?.failures).toBe(1);
    await Promise.allSettled(state.outstanding.values());
  });

  for (const error of [
    new NetworkError("offline"),
    Object.assign(new Error("cross-package network failure"), { name: "NetworkError" }),
    new HttpResponseError("service unavailable", 503),
    new HttpResponseError("rate limited", 429),
    new MintFetchError("https://bad.example", "fetch failed", new NetworkError("offline")),
  ]) {
    it(`backs off transport failure ${error.name}: ${error.message} within the pass`, async () => {
      const source = makeSource({ inFlight: [
        melt({ id: "bad", refreshError: error }), melt({ id: "same-mint" }),
        melt({ id: "healthy", mintUrl: "https://healthy.example" }),
      ] });
      const state = createMeltSweepState(new Map());
      const result = await settleMeltOperations(source, { state });
      expect(source.refreshCalls).toEqual(["bad", "healthy"]);
      expect(result.failed).toBe(1);
      expect(state.mintBackoff.size).toBe(1);
    });
  }

  for (const error of [new OperationInProgressError("busy"),
    Object.assign(new Error("cross-package lock"), { name: "OperationInProgressError" })]) {
    it(`skips a lock race without backing off the mint (${error.message})`, async () => {
      const source = makeSource({ inFlight: [
        melt({ id: "busy", refreshError: error }), melt({ id: "other" }),
      ] });
      const state = createMeltSweepState(new Map());
      const result = await settleMeltOperations(source, { state });
      expect(source.refreshCalls).toEqual(["busy", "other"]);
      expect(result.skippedLocked).toBe(1);
      expect(result.failed).toBe(0);
      expect(result.timedOut).toBe(0);
      expect(state.mintBackoff.size).toBe(0);
    });
  }

  for (const error of [new Error("local failure"), new MintOperationError(20007, "expired"),
    new HttpResponseError("bad request", 400)]) {
    it(`does not back off an operation-specific error (${error.message})`, async () => {
      // A later success must not be necessary to prevent mint-wide backoff.
      const source = makeSource({ inFlight: [melt({ id: "bad", refreshError: error })] });
      const state = createMeltSweepState(new Map());
      const first = await settleMeltOperations(source, { state });
      expect(first.failed).toBe(1);
      expect(state.mintBackoff.size).toBe(0);
      source.inFlight.push(melt({ id: "other" }));
      const second = await settleMeltOperations(source, { state });
      expect(second.checked).toBe(2);
      expect(second.stillInFlight).toBe(1);
    });
  }

  it("uses the current clock when a backoff expires during the pass", async () => {
    let clock = 1_000;
    const source = makeSource({ inFlight: [
      melt({ id: "first", mintUrl: "https://first.example" }),
      melt({ id: "recovering", mintUrl: "https://recovering.example" }),
    ], refreshState: (id) => { if (id === "first") clock += 100; return "pending"; } });
    const state = createMeltSweepState(new Map());
    state.mintBackoff.set("https://recovering.example", { failures: 1, nextAttemptAt: 1_050 });
    await settleMeltOperations(source, { state, now: () => clock });
    expect(source.refreshCalls).toEqual(["first", "recovering"]);
    expect(state.mintBackoff.size).toBe(0);
  });

  it("starts backoff at failure time even after an earlier success at that mint", async () => {
    let clock = 1_000;
    const source = makeSource({ inFlight: [
      melt({ id: "first" }), melt({ id: "failed", refreshError: new NetworkError("offline") }),
      melt({ id: "skip" }),
    ], refreshState: () => { clock += 100; return "pending"; } });
    const state = createMeltSweepState(new Map());
    await settleMeltOperations(source, { state, now: () => clock });
    expect(source.refreshCalls).toEqual(["first", "failed"]);
    expect(state.mintBackoff.get("https://mint.example")?.nextAttemptAt)
      .toBe(1_100 + MELT_SWEEP_BACKOFF_BASE_MS);
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
    const result = await settleMeltOperations(source, { state });
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
    const result = await settleMeltOperations(lockedSource);
    expect(result.skippedLocked).toBe(1);
    expect(source.refreshCalls).toEqual([]);
  });

  it("stops at the pass deadline instead of running every operation", async () => {
    const source = makeSource({
      inFlight: Array.from({ length: 5 }, (_, i) => melt({ id: `op${i}`, mintUrl: `https://mint-${i}.example` })),
      refreshDelayMs: 30,
    });
    const result = await settleMeltOperations(source, {
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
