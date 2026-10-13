import { describe, expect, test } from "bun:test";
import {
  createUpdateCheckJob,
  type UpdateCheckFn,
} from "./update-check-job.ts";
import type { UpdateState } from "../utils/update-state.ts";
import type { RoutstrdUpdateInfo } from "../utils/update-checker.ts";

const upToDate: RoutstrdUpdateInfo = {
  hasUpdate: false,
  current: "0.4.14",
  latest: "0.4.14",
};
const behind: RoutstrdUpdateInfo = {
  hasUpdate: true,
  current: "0.4.14",
  latest: "0.5.0",
};

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

async function waitFor(
  predicate: () => boolean,
  timeoutMs = 2_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error("waitFor timed out");
    await sleep(5);
  }
}

describe("createUpdateCheckJob", () => {
  test("runOnce stores the check result with a timestamp", async () => {
    const saved: UpdateState[] = [];
    const job = createUpdateCheckJob({
      check: async () => behind,
      save: (state) => saved.push(state),
      now: () => Date.parse("2026-01-02T03:04:05.000Z"),
    });

    await job.runOnce();

    expect(saved).toEqual([
      {
        current: "0.4.14",
        latest: "0.5.0",
        hasUpdate: true,
        checkedAt: "2026-01-02T03:04:05.000Z",
      },
    ]);
  });

  test("runOnce passes the timeout through and swallows check failures", async () => {
    const timeouts: number[] = [];
    const saved: UpdateState[] = [];
    const job = createUpdateCheckJob({
      timeoutMs: 1234,
      check: async ({ timeoutMs }) => {
        timeouts.push(timeoutMs);
        throw new Error("offline");
      },
      save: (state) => saved.push(state),
    });

    await expect(job.runOnce()).resolves.toBeUndefined();
    expect(timeouts).toEqual([1234]);
    expect(saved).toHaveLength(0);
  });

  test("does not overlap runs", async () => {
    let concurrent = 0;
    let maxConcurrent = 0;
    let release!: (value: RoutstrdUpdateInfo) => void;
    const check: UpdateCheckFn = () => {
      concurrent++;
      maxConcurrent = Math.max(maxConcurrent, concurrent);
      return new Promise<RoutstrdUpdateInfo>((resolve) => {
        release = (value) => {
          concurrent--;
          resolve(value);
        };
      });
    };
    const job = createUpdateCheckJob({ check, save: () => {} });

    const first = job.runOnce();
    const second = job.runOnce();
    expect(maxConcurrent).toBe(1);

    release(upToDate);
    await Promise.all([first, second]);
  });

  test("start runs after the initial delay, then stops on stop()", async () => {
    let calls = 0;
    const job = createUpdateCheckJob({
      initialDelayMs: 5,
      intervalMs: 100_000,
      check: async () => {
        calls++;
        return upToDate;
      },
      save: () => {},
    });

    job.start();
    await waitFor(() => calls === 1);
    job.stop();
    await sleep(30);
    expect(calls).toBe(1);
  });

  test("start does nothing when disabled", async () => {
    let calls = 0;
    const job = createUpdateCheckJob({
      enabled: false,
      initialDelayMs: 5,
      check: async () => {
        calls++;
        return upToDate;
      },
      save: () => {},
    });

    job.start();
    await sleep(30);
    expect(calls).toBe(0);
    job.stop();
  });
});
