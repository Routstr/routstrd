import { describe, expect, it } from "bun:test";
import { selectCleanupOperations } from "./cleanup";

const NOW_MS = 1_800_000_000_000;
const DAY_MS = 24 * 60 * 60 * 1000;

function mint(overrides: Record<string, unknown>) {
  return {
    id: "mint-1",
    state: "pending",
    expiry: NOW_MS / 1000 - 1000, // expired
    updatedAt: NOW_MS - 2 * DAY_MS,
    ...overrides,
  };
}

function send(overrides: Record<string, unknown>) {
  return {
    id: "send-1",
    state: "pending",
    updatedAt: NOW_MS - 2 * DAY_MS,
    ...overrides,
  };
}

function melt(overrides: Record<string, unknown>) {
  return {
    id: "melt-1",
    state: "prepared",
    updatedAt: NOW_MS - 2 * DAY_MS,
    ...overrides,
  };
}

describe("selectCleanupOperations", () => {
  it("selects expired pending mint quotes that are old enough", () => {
    const result = selectCleanupOperations({
      mints: [mint({ id: "a" })],
      sends: [],
      melts: [],
      nowMs: NOW_MS,
      minAgeMs: DAY_MS,
    });

    expect(result.mintsToFail.map((op) => op.id)).toEqual(["a"]);
  });

  it("ignores mint quotes that have not expired", () => {
    const result = selectCleanupOperations({
      mints: [mint({ id: "a", expiry: NOW_MS / 1000 + 1000 })],
      sends: [],
      melts: [],
      nowMs: NOW_MS,
      minAgeMs: DAY_MS,
    });

    expect(result.mintsToFail).toEqual([]);
  });

  it("ignores mint quotes without an expiry", () => {
    const result = selectCleanupOperations({
      mints: [mint({ id: "a", expiry: 0 })],
      sends: [],
      melts: [],
      nowMs: NOW_MS,
      minAgeMs: DAY_MS,
    });

    expect(result.mintsToFail).toEqual([]);
  });

  it("selects expired mint quotes even when the watcher recently touched them", () => {
    const result = selectCleanupOperations({
      mints: [mint({ id: "a", updatedAt: NOW_MS - 60_000 })],
      sends: [],
      melts: [],
      nowMs: NOW_MS,
      minAgeMs: DAY_MS,
    });

    expect(result.mintsToFail.map((op) => op.id)).toEqual(["a"]);
  });

  it("selects stale pending sends for reclaim", () => {
    const result = selectCleanupOperations({
      mints: [],
      sends: [send({ id: "s" })],
      melts: [],
      nowMs: NOW_MS,
      minAgeMs: DAY_MS,
    });

    expect(result.sendsToReclaim.map((op) => op.id)).toEqual(["s"]);
  });

  it("ignores recent pending sends", () => {
    const result = selectCleanupOperations({
      mints: [],
      sends: [send({ id: "s", updatedAt: NOW_MS - 60_000 })],
      melts: [],
      nowMs: NOW_MS,
      minAgeMs: DAY_MS,
    });

    expect(result.sendsToReclaim).toEqual([]);
  });

  it("ignores non-pending sends even when old", () => {
    const result = selectCleanupOperations({
      mints: [],
      sends: [send({ id: "s", state: "executing" })],
      melts: [],
      nowMs: NOW_MS,
      minAgeMs: DAY_MS,
    });

    expect(result.sendsToReclaim).toEqual([]);
  });

  it("selects stale prepared melts for cancellation", () => {
    const result = selectCleanupOperations({
      mints: [],
      sends: [],
      melts: [melt({ id: "m" })],
      nowMs: NOW_MS,
      minAgeMs: DAY_MS,
    });

    expect(result.meltsToCancel.map((op) => op.id)).toEqual(["m"]);
  });

  it("ignores non-prepared melts", () => {
    const result = selectCleanupOperations({
      mints: [],
      sends: [],
      melts: [melt({ id: "m", state: "pending" })],
      nowMs: NOW_MS,
      minAgeMs: DAY_MS,
    });

    expect(result.meltsToCancel).toEqual([]);
  });
});
