import { describe, expect, it } from "bun:test";
import { createLogger, isLevelEnabled, resolveLogLevel } from "./logger";

type Written = { level: string; args: unknown[] };

/** Capture what the logger would append, instead of touching ~/.routstrd. */
function capture(minLevel: Parameters<typeof createLogger>[1]) {
  const written: Written[] = [];
  const logger = createLogger("/tmp/logger-test", minLevel, (_dir, level, ...args) => {
    written.push({ level, args });
  });
  return { logger, written, levels: () => written.map((w) => w.level) };
}

describe("resolveLogLevel", () => {
  it("defaults to info so per-pass debug detail stays off", () => {
    expect(resolveLogLevel(undefined)).toBe("info");
    expect(resolveLogLevel("")).toBe("info");
  });

  it("accepts any known level, case- and whitespace-insensitively", () => {
    expect(resolveLogLevel("debug")).toBe("debug");
    expect(resolveLogLevel("  DEBUG ")).toBe("debug");
    expect(resolveLogLevel("Warn")).toBe("warn");
    expect(resolveLogLevel("error")).toBe("error");
  });

  it("falls back to the caller's default rather than muting the log on a bad value", () => {
    expect(resolveLogLevel("verbose")).toBe("info");
    expect(resolveLogLevel("0")).toBe("info");
    // The wallet-engine sink defaults to debug, so a typo must not silence it.
    expect(resolveLogLevel("bogus", "debug")).toBe("debug");
    expect(resolveLogLevel(undefined, "debug")).toBe("debug");
  });

  it("rejects inherited object keys, which would otherwise mute the whole log", () => {
    // `"constructor" in LEVEL_RANK` is true, and ranking against `Object`
    // compares false for every level, so nothing would be written at all.
    for (const key of ["constructor", "__proto__", "toString", "valueOf", "hasOwnProperty"]) {
      expect(resolveLogLevel(key)).toBe("info");
      expect(resolveLogLevel(key, "debug")).toBe("debug");
    }
  });

  it("still writes errors when a prototype key is passed as the level", () => {
    const { logger, levels } = capture(resolveLogLevel("constructor"));
    logger.error("a real error");
    expect(levels()).toEqual(["ERROR"]);
  });
});

describe("logger level filter", () => {
  it("keeps info and above at the default level, dropping debug", () => {
    const { logger, levels } = capture("info");
    logger.debug("phase marker");
    logger.log("summary");
    logger.info("also info");
    logger.warn("unreachable");
    logger.error("failed");

    expect(levels()).toEqual(["INFO", "INFO", "WARN", "ERROR"]);
  });

  it("restores everything, including debug, at level debug", () => {
    const { logger, levels } = capture("debug");
    logger.debug("phase marker");
    logger.info("summary");
    logger.warn("unreachable");
    logger.error("failed");

    expect(levels()).toEqual(["DEBUG", "INFO", "WARN", "ERROR"]);
  });

  it("reduces to errors only at level error", () => {
    const { logger, levels } = capture("error");
    logger.debug("phase marker");
    logger.info("summary");
    logger.warn("unreachable");
    logger.error("failed");

    expect(levels()).toEqual(["ERROR"]);
  });

  it("passes arguments through unchanged, including errors and metadata", () => {
    const { logger, written } = capture("info");
    const failure = new Error("boom");
    logger.error("Scheduled refresh failed:", failure, { attempt: 2 });

    expect(written).toHaveLength(1);
    expect(written[0]?.args).toEqual([
      "Scheduled refresh failed:",
      failure,
      { attempt: 2 },
    ]);
  });

  it("orders levels so warn is enabled at info and info is not enabled at warn", () => {
    expect(isLevelEnabled("warn", "info")).toBe(true);
    expect(isLevelEnabled("error", "info")).toBe(true);
    expect(isLevelEnabled("info", "info")).toBe(true);
    expect(isLevelEnabled("debug", "info")).toBe(false);
    expect(isLevelEnabled("info", "warn")).toBe(false);
    expect(isLevelEnabled("warn", "warn")).toBe(true);
  });
});
