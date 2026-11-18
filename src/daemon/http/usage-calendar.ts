const DAY_MS = 86_400_000;

/** A UTC range `[start, end)` over which a timezone keeps one UTC offset. */
export interface OffsetSegment {
  start: number;
  /** Exclusive end; `undefined` means open-ended. */
  end?: number;
  /** Minutes to subtract from UTC to get local wall time (`Date#getTimezoneOffset` sign). */
  offsetMinutes: number;
}

/** Calendar arithmetic uses UTC fields as a timezone-free wall clock. */
export function createUsageCalendar(timeZone: string) {
  const formatter = new Intl.DateTimeFormat("en-CA", {
    timeZone, year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", minute: "2-digit", second: "2-digit", hourCycle: "h23",
  });
  const wallTime = (timestamp: number): number => {
    const parts = Object.fromEntries(formatter.formatToParts(timestamp).map((p) => [p.type, p.value]));
    return Date.UTC(Number(parts.year), Number(parts.month) - 1, Number(parts.day),
      Number(parts.hour), Number(parts.minute), Number(parts.second));
  };
  const toUtc = (wall: number): number => {
    // Sample offsets on both sides of a transition. Choose the first occurrence
    // of an ambiguous time, or the first valid time after a skipped wall time.
    const offsets = new Set<number>();
    for (const delta of [-2, -1, 0, 1, 2]) {
      const probe = wall + delta * DAY_MS;
      offsets.add(wallTime(probe) - probe);
    }
    const candidates = [...offsets].map((offset) => wall - offset);
    const exact = candidates.filter((candidate) => wallTime(candidate) === wall);
    if (exact.length > 0) return Math.min(...exact);
    const later = candidates.filter((candidate) => wallTime(candidate) >= wall);
    return later.sort((a, b) => wallTime(a) - wallTime(b) || a - b)[0]!;
  };
  /** UTC offset in effect at `timestamp`, in `Date#getTimezoneOffset` minutes. */
  const offsetMinutes = (timestamp: number): number => {
    // wallTime drops milliseconds, so compare against the whole second.
    const second = Math.floor(timestamp / 1000) * 1000;
    return (second - wallTime(second)) / 60_000;
  };
  /**
   * Split `[start, scanEnd]` wherever the UTC offset changes. Transitions are
   * found by daily probes and then bisected to the exact millisecond, so a
   * year of history costs ~365 formatter calls, not one per usage row. The
   * last segment is open-ended. Two transitions within one day are not
   * supported (no IANA zone has them in the usage era).
   */
  const segments = (start: number, scanEnd: number): OffsetSegment[] => {
    const out: OffsetSegment[] = [];
    let segmentStart = start;
    let offset = offsetMinutes(start);
    let previous = start;
    while (previous < scanEnd) {
      const probe = Math.min(previous + DAY_MS, scanEnd);
      const probeOffset = offsetMinutes(probe);
      if (probeOffset !== offset) {
        let lo = previous;
        let hi = probe;
        while (hi - lo > 1) {
          const mid = Math.floor((lo + hi) / 2);
          if (offsetMinutes(mid) === offset) lo = mid;
          else hi = mid;
        }
        out.push({ start: segmentStart, end: hi, offsetMinutes: offset });
        segmentStart = hi;
        offset = probeOffset;
      }
      previous = probe;
    }
    out.push({ start: segmentStart, offsetMinutes: offset });
    return out;
  };
  return {
    wallTime,
    toUtc,
    offsetMinutes,
    segments,
    dayStart: (timestamp: number) => Math.floor(wallTime(timestamp) / DAY_MS) * DAY_MS,
  };
}
