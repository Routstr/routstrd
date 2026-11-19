import { describe, expect, it } from "bun:test";
import { createRecurringJob, type RecurringJobStatus } from "./recurring-job.ts";

/**
 * Deterministic timer harness: no real clock, so cadence assertions are exact.
 * `pending` is the single armed timer, mirroring what the job itself tracks.
 */
function harness(options: {
  delays?: Array<number | null>;
  run?: () => Promise<void>;
  onError?: (error: unknown) => void;
}) {
  const delays = options.delays ? [...options.delays] : [1_000];
  let nextDelay = 0;
  const timers = new Map<number, () => void>();
  let nextHandle = 1;
  let passes = 0;
  const errors: unknown[] = [];

  const job = createRecurringJob({
    delayMs: () => {
      // Index explicitly: `??` would swallow a deliberate `null` ("go idle").
      const value = delays[Math.min(nextDelay, delays.length - 1)];
      nextDelay++;
      return value === undefined ? 1_000 : value;
    },
    run: async () => {
      passes++;
      await options.run?.();
    },
    onError: (error) => {
      errors.push(error);
      options.onError?.(error);
    },
    setTimeout: (callback) => {
      const handle = nextHandle++;
      timers.set(handle, callback);
      return handle;
    },
    clearTimeout: (handle) => {
      timers.delete(handle as number);
    },
  });

  return {
    job,
    errors,
    passes: () => passes,
    /** Number of armed timers; must never exceed 1. */
    armed: () => timers.size,
    /** Fire every armed timer, as the event loop eventually would. */
    async fire(): Promise<void> {
      const callbacks = [...timers.entries()];
      timers.clear();
      for (const [, callback] of callbacks) callback();
      // Let the pass's await chain settle.
      await new Promise((resolve) => setTimeout(resolve, 0));
    },
  };
}

describe("recurring job lifecycle", () => {
  it("starts idle and arms exactly one timer", () => {
    const h = harness({ delays: [1_000] });
    expect(h.job.status()).toBe("idle");
    expect(h.armed()).toBe(0);

    h.job.start();
    expect(h.job.status()).toBe("waiting");
    expect(h.armed()).toBe(1);
  });

  it("arms no second timer when started twice", () => {
    // The old hand-rolled job overwrote its `setTimeout` handle on a second
    // start, leaking the first timer so two independent loops ran.
    const h = harness({ delays: [1_000, 1_000] });
    h.job.start();
    h.job.start();
    h.job.start();
    expect(h.armed()).toBe(1);
  });

  it("reschedules after a pass settles", async () => {
    const h = harness({ delays: [1_000, 2_000] });
    h.job.start();
    await h.fire();
    expect(h.passes()).toBe(1);
    expect(h.job.status()).toBe("waiting");
    expect(h.armed()).toBe(1);
  });

  it("does not re-arm when stopped during a pass", async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const h = harness({ delays: [1_000], run: () => gate });

    h.job.start();
    // Fire without awaiting: the pass is now running and blocked on the gate.
    const firing = h.fire();
    expect(h.job.status()).toBe("running");

    h.job.stop();
    release();
    await firing;

    expect(h.job.status()).toBe("idle");
    // A stop that arrived mid-pass wins: nothing is armed. (Main's refresh loop
    // already honoured this through its `refreshJobActive` check, and the refund
    // loop was a `setInterval`; this pins the behaviour for the shared primitive
    // so a future caller cannot lose it.)
    expect(h.armed()).toBe(0);
  });

  it("keeps one loop when restarted during a pass", async () => {
    // Regression: `stop()` used to report `idle` while the pass was still
    // awaiting `run()`, so a `start()` before that pass settled armed a second
    // timer; the surviving pass then re-armed its own chain on settle and the
    // two loops ran forever out of step. The daemon never restarts a job today
    // (stop is shutdown-only), but the primitive promises this.
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const h = harness({ delays: [1_000, 1_000], run: () => gate });

    h.job.start();
    const firing = h.fire();
    expect(h.job.status()).toBe("running");

    h.job.stop();
    // The pass is still live, so this must not arm a competing timer.
    h.job.start();
    expect(h.armed()).toBe(0);

    release();
    await firing;

    // Exactly one chain resumes: the surviving pass re-armed once.
    expect(h.job.status()).toBe("waiting");
    expect(h.armed()).toBe(1);
    expect(h.passes()).toBe(1);
  });

  it("keeps its cadence when a pass throws", async () => {
    const h = harness({
      delays: [1_000],
      run: () => Promise.reject(new Error("boom")),
    });
    h.job.start();
    await h.fire();

    expect(h.passes()).toBe(1);
    expect(h.errors).toHaveLength(1);
    // A failing pass must not end a recurring job.
    expect(h.job.status()).toBe("waiting");
    expect(h.armed()).toBe(1);
  });

  it("goes idle when the caller reports nothing to wait for", async () => {
    const h = harness({ delays: [null] });
    h.job.start();
    expect(h.job.status()).toBe("idle");
    expect(h.armed()).toBe(0);
  });

  it("reports only the three defined statuses", () => {
    const h = harness({ delays: [1_000] });
    const seen = new Set<RecurringJobStatus>([h.job.status()]);
    h.job.start();
    seen.add(h.job.status());
    h.job.stop();
    seen.add(h.job.status());
    expect([...seen].sort()).toEqual(["idle", "waiting"]);
  });
});
