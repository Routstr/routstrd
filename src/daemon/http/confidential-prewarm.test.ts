import { describe, expect, test } from "bun:test";
import { confidentialPrewarmOptions } from "./index";

describe("confidentialUpstream.prewarm → SDK options", () => {
  test("on by default with the SDK defaults", () => {
    const o = confidentialPrewarmOptions(undefined);
    expect(o?.enabled).toBe(true);
    expect(o?.activityWindowMs).toBeUndefined();
    expect(o?.maxAgeMs).toBeUndefined();
    expect(typeof o?.log).toBe("function");
  });

  test("enabled: false turns it off", () => {
    expect(confidentialPrewarmOptions({ enabled: false })).toBeUndefined();
  });

  test("converts units and caps the age below the node's 600 s limit", () => {
    const o = confidentialPrewarmOptions({
      activityWindowMinutes: 2,
      maxPerKey: 2,
      maxTotal: 3,
      maxAgeSeconds: 900,
    });
    expect(o?.activityWindowMs).toBe(120_000);
    expect(o?.maxPerKey).toBe(2);
    expect(o?.maxTotal).toBe(3);
    expect(o?.maxAgeMs).toBe(570_000);
    expect(confidentialPrewarmOptions({ maxAgeSeconds: 300 })?.maxAgeMs).toBe(300_000);
  });
});
