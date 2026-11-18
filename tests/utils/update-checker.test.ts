import { describe, expect, test } from "bun:test";
import { compareVersions } from "../../src/utils/update-checker";

describe("compareVersions", () => {
  test("compares stable semantic versions", () => {
    expect(compareVersions("0.5.1", "0.5.0")).toBeGreaterThan(0);
    expect(compareVersions("v0.5.0", "0.5.0")).toBe(0);
    expect(compareVersions("0.4.9", "0.5.0")).toBeLessThan(0);
  });

  test("orders prereleases before the corresponding stable release", () => {
    expect(compareVersions("0.5.0-beta.1", "0.5.0")).toBeLessThan(0);
    expect(compareVersions("0.5.0", "0.5.0-rc.1")).toBeGreaterThan(0);
  });

  test("uses semantic-version precedence for prerelease identifiers", () => {
    expect(compareVersions("0.5.0-beta.2", "0.5.0-beta.11")).toBeLessThan(0);
    expect(compareVersions("0.5.0-beta.11", "0.5.0-rc.1")).toBeLessThan(0);
    expect(compareVersions("0.5.0-rc.1", "0.5.0-rc.1.1")).toBeLessThan(0);
  });

  test("ignores build metadata and rejects malformed versions", () => {
    expect(compareVersions("0.5.0+darwin", "0.5.0+linux")).toBe(0);
    expect(compareVersions("0.5.0garbage", "0.5.0")).toBeNull();
  });
});
