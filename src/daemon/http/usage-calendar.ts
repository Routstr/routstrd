const DAY_MS = 86_400_000;

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
  return {
    wallTime,
    toUtc,
    dayStart: (timestamp: number) => Math.floor(wallTime(timestamp) / DAY_MS) * DAY_MS,
  };
}
