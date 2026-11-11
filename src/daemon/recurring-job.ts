/**
 * A recurring background job whose lifecycle is one explicit value.
 *
 * The daemon runs several repeating jobs (model/clients refresh, refunds,
 * update checks). Each used to be hand-rolled from a `setTimeout` handle plus
 * one or two booleans, and those fields could disagree:
 *
 *  - `active = true` with `timer = null` meant "between runs";
 *  - calling `start()` twice armed a second timer and leaked the first, so two
 *    independent loops ran and the effective interval halved;
 *  - `stop()` during a run cleared the timer that run had already consumed, so
 *    "re-arm unless stopped" had to consult the same boolean the stopper had
 *    just cleared — correct only if the two were ordered exactly right.
 *
 * Here the job is `idle`, `waiting` (a timer is armed), or `running` (the body
 * is executing), and one `keepRunning` flag records *intent*. A pass re-arms
 * only if `keepRunning` is still true when it settles, so `stop()` mid-pass is
 * honoured without any ordering subtlety, and a manual `runNow()` on an idle
 * job cannot start a cadence nobody asked for.
 *
 * The delay is recomputed per pass by the caller's `delayMs`, so a job can read
 * live config on every tick — change cadence, or drop to a slow "poll for
 * re-enable" mode — without a daemon restart.
 */

/** Every state a scheduled job can be in. */
export type RecurringJobStatus = "idle" | "waiting" | "running";

export interface RecurringJobOptions {
  /**
   * How long to wait before the next pass. Called once per pass, after the
   * previous one settles, so it may read live config. Returning `null` means
   * "nothing to wait for": the job goes idle instead of arming a timer.
   */
  delayMs: () => number | null;
  /**
   * One pass of work. A rejection is reported to `onError` and the job keeps
   * its cadence — a failing pass must not silently end a recurring job.
   */
  run: () => Promise<void>;
  /** Report a failed pass. Defaults to swallowing (the caller usually logs). */
  onError?: (error: unknown) => void;
  /** Injectable timer hooks so tests need no real clock. */
  setTimeout?: (callback: () => void, ms: number) => unknown;
  clearTimeout?: (handle: unknown) => void;
}

export interface RecurringJob {
  /** Arm the job. Idempotent: a waiting or running job is left alone. */
  start(): void;
  /** Stop the job and cancel any armed timer. Safe mid-run; no re-arm follows. */
  stop(): void;
  /** Current state, for diagnostics and tests. */
  status(): RecurringJobStatus;
  /** Run one pass immediately, honouring the no-overlap rule. */
  runNow(): Promise<void>;
}

export function createRecurringJob(options: RecurringJobOptions): RecurringJob {
  const setTimer =
    options.setTimeout ?? ((cb: () => void, ms: number) => setTimeout(cb, ms));
  const clearTimer =
    options.clearTimeout ?? ((handle) => clearTimeout(handle as never));
  const reportError = options.onError ?? (() => {});

  let status: RecurringJobStatus = "idle";
  /** The single armed timer, or null. `schedule` is the only writer. */
  let handle: unknown = null;
  /** Intent: should another pass be armed once the current one settles? */
  let keepRunning = false;

  const clearArmedTimer = (): void => {
    if (handle !== null) {
      clearTimer(handle);
      handle = null;
    }
  };

  const goIdle = (): void => {
    clearArmedTimer();
    status = "idle";
    keepRunning = false;
  };

  const schedule = (): void => {
    clearArmedTimer();
    if (!keepRunning) {
      status = "idle";
      return;
    }
    const delay = options.delayMs();
    if (delay === null) {
      // The job has nothing to wait for right now. Staying inert is the
      // deliberate outcome; the caller must `start()` it again.
      goIdle();
      return;
    }
    status = "waiting";
    handle = setTimer(() => {
      // The runtime consumed the timer, so it is no longer armed. Clearing the
      // handle here keeps `stop()` from clearing an already-fired handle.
      handle = null;
      void pass();
    }, delay);
  };

  const pass = async (): Promise<void> => {
    status = "running";
    try {
      await options.run();
    } catch (error) {
      reportError(error);
    } finally {
      status = "idle";
      // Re-arm only on intent. `stop()` clears `keepRunning`, so a stop that
      // arrived while this pass was running wins regardless of timing.
      if (keepRunning) schedule();
    }
  };

  return {
    start(): void {
      // Starting an already-live job must not arm a second timer.
      if (status !== "idle") return;
      keepRunning = true;
      schedule();
    },
    stop(): void {
      goIdle();
    },
    status(): RecurringJobStatus {
      return status;
    },
    async runNow(): Promise<void> {
      // Never overlap: a scheduled pass already owns the body.
      if (status === "running") return;
      clearArmedTimer();
      status = "idle";
      // `pass` reads `keepRunning`, so a manual run of an idle job settles with
      // no timer armed, while a manual run of a waiting job resumes the cadence.
      await pass();
    },
  };
}
