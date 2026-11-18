import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, statSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import {
  isUpdateStateFresh,
  isUpdateStateApplicable,
  readUpdateState,
  updateNotice,
  writeUpdateState,
  type UpdateState,
} from "./update-state.ts";

const tempDirs: string[] = [];

function makeTempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "routstrd-update-state-"));
  tempDirs.push(dir);
  return dir;
}

function statePath(): string {
  return join(makeTempDir(), "update-state.json");
}

const sample: UpdateState = {
  current: "0.4.14",
  latest: "0.5.0",
  hasUpdate: true,
  checkedAt: "2026-01-02T03:04:05.000Z",
};

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

describe("update state persistence", () => {
  test("round-trips a state object", () => {
    const path = statePath();
    writeUpdateState(sample, path);
    expect(readUpdateState(path)).toEqual(sample);
  });

  test("writes the file with 0600 permissions", () => {
    const path = statePath();
    writeUpdateState(sample, path);
    expect(statSync(path).mode & 0o777).toBe(0o600);
  });

  test("overwrites an existing file atomically", () => {
    const path = statePath();
    writeUpdateState(sample, path);
    writeUpdateState({ ...sample, hasUpdate: false, latest: null }, path);
    expect(readUpdateState(path)).toEqual({
      ...sample,
      hasUpdate: false,
      latest: null,
    });
  });

  test("returns null for missing, corrupt, or malformed files", () => {
    const missing = statePath();
    expect(readUpdateState(missing)).toBeNull();

    const corrupt = statePath();
    writeFileSync(corrupt, "{not json");
    expect(readUpdateState(corrupt)).toBeNull();

    const malformed = statePath();
    writeFileSync(malformed, JSON.stringify({ current: 1, hasUpdate: "no" }));
    expect(readUpdateState(malformed)).toBeNull();
  });
});

describe("isUpdateStateFresh", () => {
  const now = Date.parse("2026-01-02T12:00:00.000Z");
  const at = (iso: string): UpdateState => ({ ...sample, checkedAt: iso });

  test("accepts a recent check", () => {
    expect(isUpdateStateFresh(at("2026-01-02T06:00:00.000Z"), undefined, now)).toBe(true);
  });

  test("rejects a check older than the max age", () => {
    expect(isUpdateStateFresh(at("2026-01-01T06:00:00.000Z"), undefined, now)).toBe(false);
  });

  test("rejects an unparseable timestamp", () => {
    expect(isUpdateStateFresh(at("not-a-date"), undefined, now)).toBe(false);
  });
});

describe("updateNotice", () => {
  test("formats a notice when an update is available", () => {
    expect(updateNotice(sample)).toBe(
      "A new routstrd version is available (v0.4.14 \u2192 v0.5.0). Run 'routstrd update' to update.",
    );
  });

  test("stays silent when up to date or latest is unknown", () => {
    expect(updateNotice({ ...sample, hasUpdate: false })).toBeNull();
    expect(updateNotice({ ...sample, latest: null })).toBeNull();
  });
});


describe("isUpdateStateApplicable", () => {
  const now = Date.parse(sample.checkedAt) + 60_000;
  test("accepts a fresh newer version detected by the running version", () => {
    expect(isUpdateStateApplicable(sample, sample.current, now)).toBe(true);
  });
  test("rejects stale, future, mismatched, invalid and non-newer state", () => {
    for (const state of [
      { ...sample, checkedAt: "2020-01-01T00:00:00.000Z" },
      { ...sample, checkedAt: new Date(now + 1).toISOString() },
      { ...sample, current: "0.1.0" },
      { ...sample, latest: sample.current },
      { ...sample, latest: "0.1.0" },
      { ...sample, latest: "invalid" },
      { ...sample, latest: null },
      { ...sample, hasUpdate: false },
    ]) expect(isUpdateStateApplicable(state, sample.current, now)).toBe(false);
  });
});
