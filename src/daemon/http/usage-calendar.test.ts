import { describe, expect, it } from "bun:test";
import { createUsageCalendar } from "./usage-calendar";

describe("usage calendar offset segments", () => {
  it("splits a year at the exact DST transitions", () => {
    const calendar = createUsageCalendar("America/New_York");
    const segments = calendar.segments(Date.parse("2026-01-01T00:00:00Z"), Date.parse("2026-12-31T00:00:00Z"));
    expect(segments).toEqual([
      { start: Date.parse("2026-01-01T00:00:00Z"), end: Date.parse("2026-03-08T07:00:00Z"), offsetMinutes: 300 },
      { start: Date.parse("2026-03-08T07:00:00Z"), end: Date.parse("2026-11-01T06:00:00Z"), offsetMinutes: 240 },
      { start: Date.parse("2026-11-01T06:00:00Z"), offsetMinutes: 300 },
    ]);
  });

  it("returns one open segment for zones without DST", () => {
    const calendar = createUsageCalendar("Asia/Singapore");
    const start = Date.parse("2020-01-01T00:00:00Z");
    expect(calendar.segments(start, Date.parse("2026-10-13T00:00:00Z")))
      .toEqual([{ start, offsetMinutes: -480 }]);
  });
});
