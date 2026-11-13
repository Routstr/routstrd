import { describe, expect, test } from "bun:test";
import { confidentialPrewarmOptions } from "./index";

describe("confidentialUpstream.prewarm → SDK pre-warm options", () => {
  test("is on by default, with the SDK's defaults", () => {
    const o = confidentialPrewarmOptions(undefined);
    expect(o?.enabled).toBe(true);
    expect(o?.activityWindowMs).toBeUndefined();
    expect(o?.maxTotal).toBeUndefined();
    expect(o?.maxAgeMs).toBeUndefined();
    expect(o?.maxDepositMsat).toBeUndefined();
  });

  test("enabled: false switches it off", () => {
    expect(confidentialPrewarmOptions({ enabled: false })).toBeUndefined();
  });

  test("maps minutes and seconds to milliseconds, and passes the deposit bound", () => {
    const o = confidentialPrewarmOptions({ activityWindowMinutes: 5, maxTotal: 2, maxAgeSeconds: 300, maxDepositMsat: 0 });
    expect(o?.activityWindowMs).toBe(300_000);
    expect(o?.maxTotal).toBe(2);
    expect(o?.maxAgeMs).toBe(300_000);
    // 0 is a value: never arm for a node that takes a deposit.
    expect(o?.maxDepositMsat).toBe(0);
  });

  test("keeps an armed connection's age within what the node allows", () => {
    expect(confidentialPrewarmOptions({ maxAgeSeconds: 1 })?.maxAgeMs).toBe(60_000);
    expect(confidentialPrewarmOptions({ maxAgeSeconds: 9999 })?.maxAgeMs).toBe(570_000);
  });
});
