import type {
  UsageAggregateRow,
  UsageTrackingDriver,
  UsageTrackingEntry,
} from "@routstr/sdk/storage";
import type { ClientEntry } from "../../utils/clients";

// ─── Public shape ────────────────────────────────────────────────────────────

export interface StatRow {
  requests: number;
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
  cost: number;
  satsCost: number;
}

export interface ModelSummary extends StatRow {
  modelId: string;
}

export interface ProviderSummary extends StatRow {
  baseUrl: string;
}

export interface TopModel {
  modelId: string;
  requests: number;
  satsCost: number;
  totalTokens: number;
}

export interface ClientSummary extends StatRow {
  client: string;
  topModels: TopModel[];
}

export interface NpubSummary extends StatRow {
  npub: string;
  topModels: TopModel[];
}

export interface DaySummary extends StatRow {
  date: string; // "YYYY-MM-DD"
}

export interface HourSummary extends StatRow {
  hour: number; // 0..23
}

export interface SizeBucket {
  count: number;
  cost: number; // summed satsCost
}

export interface SizeBuckets {
  tiny: SizeBucket;
  small: SizeBucket;
  medium: SizeBucket;
  large: SizeBucket;
  huge: SizeBucket;
}

/**
 * Bucket size used to render the usage history chart. Chosen from the selected
 * {@link TimeWindow}: hours for the last 24h and 7d, days for 30d, and weeks
 * for the unbounded `all` view.
 */
export type TimelineBucket = "hour" | "day" | "week";

/** One bar in the history chart: one hour, day or week of usage. */
export interface TimelinePoint {
  /**
   * Bucket key: `HH` (24h hour), `MM-DD HH` (7d hour), `YYYY-MM-DD` (day or
   * week start).
   */
  key: string;
  /** Bucket start, UTC ms. Week points are anchored to their Monday midnight. */
  timestamp: number;
  requests: number;
  satsCost: number;
  totalTokens: number;
  promptTokens: number;
  completionTokens: number;
}

/**
 * Zero-filled usage series for the history chart. Every bucket between the
 * range start and `now` is present (even empty ones) so the chart's x-axis is
 * evenly spaced; gaps are only possible for a window with no data at all.
 */
export interface Timeline {
  bucket: TimelineBucket;
  points: TimelinePoint[];
}

/**
 * Selectable time range for the usage monitor. `today` is the last 24
 * hours (hour-aligned), `7d`/`30d` cover that many whole local days ending
 * today, `all` is unbounded. Windowed aggregates and the History timeline
 * share the same range, so tab totals match the sum of the chart bars.
 */
export type TimeWindow = "all" | "today" | "7d" | "30d";

export const TIME_WINDOWS: readonly TimeWindow[] = ["all", "today", "7d", "30d"];

/** Coerce a query parameter to a known window, defaulting to `all`. */
export function parseTimeWindow(raw: string | null | undefined): TimeWindow {
  const value = typeof raw === "string" ? raw.trim() : "";
  return (TIME_WINDOWS as readonly string[]).includes(value)
    ? (value as TimeWindow)
    : "all";
}

/**
 * Aggregates scoped to a single {@link TimeWindow}. The all-time equivalent
 * lives on the top level of {@link UsageSummary} so the Overview/Recent tabs
 * stay unaffected no matter which window is selected.
 */
export interface WindowedStats {
  window: TimeWindow;
  totals: StatRow;
  models: ModelSummary[];
  providers: ProviderSummary[];
  clients: ClientSummary[];
  npubs: NpubSummary[];
  sizeBuckets: SizeBuckets;
  /** Zero-filled series for the History tab chart. */
  timeline: Timeline;
}

export interface UsageSummary {
  generatedAt: number;
  totals: StatRow;
  models: ModelSummary[];
  providers: ProviderSummary[];
  clients: ClientSummary[];
  npubs: NpubSummary[];
  days: DaySummary[];
  hoursToday: HourSummary[];
  sizeBuckets: SizeBuckets;
  recent: UsageTrackingEntry[];
  /** Aggregates for the requested window. Always set by the server. */
  window?: WindowedStats;
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

function rowToStat(r: UsageAggregateRow): StatRow {
  return {
    requests: r.requests,
    promptTokens: r.promptTokens,
    completionTokens: r.completionTokens,
    totalTokens: r.totalTokens,
    cost: r.cost,
    satsCost: r.satsCost,
  };
}

function zeroStatRow(): StatRow {
  return {
    requests: 0,
    promptTokens: 0,
    completionTokens: 0,
    totalTokens: 0,
    cost: 0,
    satsCost: 0,
  };
}

function rowToTopModel(r: UsageAggregateRow): TopModel {
  return {
    modelId: r.group ?? "unknown",
    requests: r.requests,
    satsCost: r.satsCost,
    totalTokens: r.totalTokens,
  };
}

function emptyBucket(): SizeBucket {
  return { count: 0, cost: 0 };
}

function emptySizeBuckets(): SizeBuckets {
  return {
    tiny: emptyBucket(),
    small: emptyBucket(),
    medium: emptyBucket(),
    large: emptyBucket(),
    huge: emptyBucket(),
  };
}

/** [minInclusive, maxExclusive) token bounds for each size bucket. */
const SIZE_BUCKET_BOUNDS = {
  tiny: [0, 1000],
  small: [1000, 10000],
  medium: [10000, 50000],
  large: [50000, 100000],
  huge: [100000, Infinity],
} as const;

function computeSizeBuckets(
  entries: UsageTrackingEntry[],
): SizeBuckets {
  const buckets = emptySizeBuckets();
  for (const entry of entries) {
    for (const [name, [min, max]] of Object.entries(SIZE_BUCKET_BOUNDS)) {
      if (entry.totalTokens >= min && entry.totalTokens < max) {
        const bucket = buckets[name as keyof typeof buckets];
        bucket.count++;
        bucket.cost += entry.satsCost;
        break;
      }
    }
  }
  return buckets;
}

/** Returns the UTC ms for the start of the local day containing `now`. */
function startOfLocalDayUtc(now: number, tzOffsetMinutes: number): number {
  return (
    Math.floor((now - tzOffsetMinutes * 60000) / 86400000) * 86400000 +
    tzOffsetMinutes * 60000
  );
}

const HOUR_MS = 3_600_000;
const DAY_MS = 86_400_000;

/**
 * Start (UTC ms) of the oldest bucket the History chart draws for a window,
 * or `undefined` for the unbounded `all` window. The windowed aggregates use
 * the same boundary, so a tab's totals always match the sum of its bars:
 *
 * - `today` → the current local hour minus 23h (24 whole hour buckets).
 * - `7d` / `30d` → start of the local day 6 / 29 days ago (whole days).
 */
function windowRangeStartUtc(
  window: TimeWindow,
  now: number,
  tzOffsetMinutes: number,
): number | undefined {
  if (window === "all") return undefined;
  const bucketMs = window === "today" ? HOUR_MS : DAY_MS;
  const slotCount = window === "today" ? 24 : window === "7d" ? 7 : 30;
  const shiftedNow = now - tzOffsetMinutes * 60_000;
  const newestShifted = Math.floor(shiftedNow / bucketMs) * bucketMs;
  const oldestShifted = newestShifted - (slotCount - 1) * bucketMs;
  return oldestShifted + tzOffsetMinutes * 60_000;
}

/**
 * The `after` boundary (exclusive, as the driver defines it) for a window, or
 * `undefined` for the unbounded `all` window. Aligned with the History chart
 * via {@link windowRangeStartUtc}; the driver's strict `timestamp > after`
 * makes the 1ms nudge include entries exactly at the first bucket's start.
 */
function windowAfter(
  window: TimeWindow,
  now: number,
  tzOffsetMinutes: number,
): number | undefined {
  const start = windowRangeStartUtc(window, now, tzOffsetMinutes);
  return start === undefined ? undefined : start - 1;
}

/** Filter shared by every aggregate/list/count call. */
interface UsageFilter {
  clients?: string[];
  after?: number;
}

// ─── History timeline ────────────────────────────────────────────────────────

const pad2 = (n: number): string => String(n).padStart(2, "0");

/** Empty series used by the zero-data short-circuit. */
function emptyTimeline(window: TimeWindow): Timeline {
  return { bucket: bucketForWindow(window), points: [] };
}

/** Which bucket the chart uses for a window: hours, days or weeks. */
function bucketForWindow(window: TimeWindow): TimelineBucket {
  if (window === "today" || window === "7d") return "hour";
  if (window === "all") return "week";
  return "day";
}

/**
 * `YYYY-MM-DD` for a timestamp that is already shifted into local wall-clock
 * time (i.e. `timestamp - tzOffsetMinutes * 60000`), matching the SDK's
 * `groupBy: "day"` keys.
 */
function shiftedDayKey(shiftedMs: number): string {
  const d = new Date(shiftedMs);
  return `${d.getUTCFullYear()}-${pad2(d.getUTCMonth() + 1)}-${pad2(d.getUTCDate())}`;
}

interface TimelineAccumulator {
  requests: number;
  satsCost: number;
  totalTokens: number;
  promptTokens: number;
  completionTokens: number;
}

function zeroAccumulator(): TimelineAccumulator {
  return { requests: 0, satsCost: 0, totalTokens: 0, promptTokens: 0, completionTokens: 0 };
}

function accumulatorFromRow(row: {
  requests: number;
  satsCost: number;
  totalTokens: number;
  promptTokens: number;
  completionTokens: number;
}): TimelineAccumulator {
  return {
    requests: row.requests,
    satsCost: row.satsCost,
    totalTokens: row.totalTokens,
    promptTokens: row.promptTokens,
    completionTokens: row.completionTokens,
  };
}

/** Sum consecutive points into `groupSize`-wide buckets (e.g. 6 hours). */
function foldTimelinePoints(points: TimelinePoint[], groupSize: number): TimelinePoint[] {
  const folded: TimelinePoint[] = [];
  for (let i = 0; i < points.length; i += groupSize) {
    const chunk = points.slice(i, i + groupSize);
    const first = chunk[0]!;
    folded.push({
      key: first.key,
      timestamp: first.timestamp,
      requests: chunk.reduce((sum, p) => sum + p.requests, 0),
      satsCost: chunk.reduce((sum, p) => sum + p.satsCost, 0),
      totalTokens: chunk.reduce((sum, p) => sum + p.totalTokens, 0),
      promptTokens: chunk.reduce((sum, p) => sum + p.promptTokens, 0),
      completionTokens: chunk.reduce((sum, p) => sum + p.completionTokens, 0),
    });
  }
  return folded;
}

/**
 * Build the zero-filled history series for a window.
 *
 * - `today` (24h) → 24 hourly buckets, aligned to the local hour.
 * - `7d` → 6-hour buckets (7 × 4), built from hourly aggregates per local day
 *   and then folded. The SDK's `hour` key carries no date, so each day is
 *   aggregated over its own range.
 * - `30d` → 30 daily buckets.
 * - `all` → one bucket per ISO week (Monday start) since the first week with
 *   usage. The SDK has no `week` grouping, so all days are aggregated and
 *   folded here.
 */
async function buildTimeline(
  driver: UsageTrackingDriver,
  baseFilter: UsageFilter,
  window: TimeWindow,
  now: number,
  tzOffsetMinutes: number,
): Promise<Timeline> {
  if (window === "all") {
    return buildWeeklyTimeline(driver, baseFilter, now, tzOffsetMinutes);
  }
  if (window === "7d") {
    return buildHourlyWeekTimeline(driver, baseFilter, now, tzOffsetMinutes);
  }

  const isHourly = window === "today";
  const bucket = isHourly ? "hour" : "day";
  const bucketMs = isHourly ? HOUR_MS : DAY_MS;
  const slotCount = isHourly ? 24 : 30;

  // Same boundary the windowed aggregates use, so the chart bars sum to the
  // tab's totals. Aligning the newest slot to the current local hour/day also
  // keeps each hour-of-day unique (the SDK's `hour` keys carry no date).
  const oldestUtc = windowRangeStartUtc(window, now, tzOffsetMinutes)!;
  const oldestShifted = oldestUtc - tzOffsetMinutes * 60_000;

  const rows = await driver.aggregate({
    ...baseFilter,
    groupBy: bucket,
    tzOffsetMinutes,
    after: oldestUtc - 1, // strict `>`, so include entries at the bucket start
  });
  const byKey = new Map(rows.map((row) => [row.group ?? "", row]));

  const points: TimelinePoint[] = [];
  for (let i = 0; i < slotCount; i++) {
    const slotShifted = oldestShifted + i * bucketMs;
    const key = isHourly ? pad2(new Date(slotShifted).getUTCHours()) : shiftedDayKey(slotShifted);
    const row = byKey.get(key);
    points.push({
      key,
      timestamp: slotShifted + tzOffsetMinutes * 60_000,
      ...(row ? accumulatorFromRow(row) : zeroAccumulator()),
    });
  }

  return { bucket, points };
}

/**
 * 7 days of hourly aggregates (7 × 24), oldest first, folded into 6-hour
 * buckets (7 × 4). The SDK's `hour` grouping keys on hour-of-day only (no
 * date), so each local day is aggregated over its own `[start, end)` range.
 */
async function buildHourlyWeekTimeline(
  driver: UsageTrackingDriver,
  baseFilter: UsageFilter,
  now: number,
  tzOffsetMinutes: number,
): Promise<Timeline> {
  const DAYS = 7;
  const shiftedNow = now - tzOffsetMinutes * 60_000;
  const todayStartShifted = Math.floor(shiftedNow / DAY_MS) * DAY_MS;

  const points: TimelinePoint[] = [];
  for (let d = DAYS - 1; d >= 0; d--) {
    const dayStartShifted = todayStartShifted - d * DAY_MS;
    const dayStartUtc = dayStartShifted + tzOffsetMinutes * 60_000;
    const dayEndUtc = dayStartUtc + DAY_MS;

    const rows = await driver.aggregate({
      ...baseFilter,
      groupBy: "hour",
      tzOffsetMinutes,
      after: dayStartUtc - 1, // strict `>`, inclusive of the day's first ms
      before: dayEndUtc, // strict `<`, exclusive of the next day
    });
    const byHour = new Map(rows.map((row) => [row.group ?? "", row]));
    const dateLabel = shiftedDayKey(dayStartShifted).slice(5); // MM-DD

    for (let h = 0; h < 24; h++) {
      const slotShifted = dayStartShifted + h * HOUR_MS;
      const row = byHour.get(pad2(h));
      points.push({
        key: dateLabel + " " + pad2(h),
        timestamp: slotShifted + tzOffsetMinutes * 60_000,
        ...(row ? accumulatorFromRow(row) : zeroAccumulator()),
      });
    }
  }

  return { bucket: "hour", points: foldTimelinePoints(points, 6) };
}

/** Shifted-local Monday midnight of the week containing `shiftedMs`. */
function startOfWeekShifted(shiftedMs: number): number {
  const day = new Date(shiftedMs).getUTCDay(); // 0 = Sunday
  const daysSinceMonday = (day + 6) % 7;
  return Math.floor(shiftedMs / DAY_MS) * DAY_MS - daysSinceMonday * DAY_MS;
}

/** Shifted-local ms for a `YYYY-MM-DD` key (`Date.UTC` == shifted-local). */
function dayKeyToShifted(key: string): number {
  const [y, m, d] = key.split("-").map(Number) as [number, number, number];
  return Date.UTC(y, m - 1, d);
}

/** Fold all-time daily aggregates into ISO weeks (Monday), zero-filling gaps. */
async function buildWeeklyTimeline(
  driver: UsageTrackingDriver,
  baseFilter: UsageFilter,
  now: number,
  tzOffsetMinutes: number,
): Promise<Timeline> {
  const rows = await driver.aggregate({
    ...baseFilter,
    groupBy: "day",
    tzOffsetMinutes,
  });

  const byWeek = new Map<string, TimelineAccumulator>();
  for (const row of rows) {
    const dayKey = row.group ?? "";
    if (dayKey.length !== 10) continue;
    const weekKey = shiftedDayKey(startOfWeekShifted(dayKeyToShifted(dayKey)));
    const acc = byWeek.get(weekKey) ?? zeroAccumulator();
    const add = accumulatorFromRow(row);
    acc.requests += add.requests;
    acc.satsCost += add.satsCost;
    acc.totalTokens += add.totalTokens;
    acc.promptTokens += add.promptTokens;
    acc.completionTokens += add.completionTokens;
    byWeek.set(weekKey, acc);
  }

  const weeks = [...byWeek.keys()].sort();
  if (weeks.length === 0) return { bucket: "week", points: [] };

  const lastShifted = startOfWeekShifted(now - tzOffsetMinutes * 60_000);
  const points: TimelinePoint[] = [];
  for (let cur = dayKeyToShifted(weeks[0]!); cur <= lastShifted; cur += 7 * DAY_MS) {
    const key = shiftedDayKey(cur);
    points.push({
      key,
      timestamp: cur + tzOffsetMinutes * 60_000,
      ...(byWeek.get(key) ?? zeroAccumulator()),
    });
  }

  return { bucket: "week", points };
}

// ─── Module-level memo cache ─────────────────────────────────────────────────

interface CacheEntry {
  key: string;
  summary: UsageSummary;
}

let _cache: CacheEntry | null = null;
const CACHE_TTL_MS = 60_000;

/** Clears the module-level memo cache. Intended for use in unit tests only. */
export function __resetUsageSummaryCacheForTest(): void {
  _cache = null;
}

// ─── Aggregation ─────────────────────────────────────────────────────────────

function emptyAggregates(): Omit<WindowedStats, "window" | "timeline"> {
  return {
    totals: zeroStatRow(),
    models: [],
    providers: [],
    clients: [],
    npubs: [],
    sizeBuckets: emptySizeBuckets(),
  };
}

/**
 * Build one set of aggregates (totals, per-model/provider/client/npub, size
 * buckets). `after` scopes every query to a time window; omit it for all-time.
 * The same function produces both the all-time block and the windowed block so
 * they can never drift apart.
 */
async function buildAggregates(
  driver: UsageTrackingDriver,
  baseFilter: UsageFilter,
  clients: ClientEntry[],
  tzOffsetMinutes: number,
  after?: number,
): Promise<Omit<WindowedStats, "window" | "timeline">> {
  const filter: UsageFilter = after === undefined ? { ...baseFilter } : { ...baseFilter, after };

  // ── Totals ─────────────────────────────────────────────────────────────────
  const [totalsRow] = await driver.aggregate({ ...filter });
  const totals: StatRow = totalsRow ? rowToStat(totalsRow) : zeroStatRow();

  // ── Models ─────────────────────────────────────────────────────────────────
  const modelRows = await driver.aggregate({ ...filter, groupBy: "modelId" });
  const models: ModelSummary[] = modelRows.map((r) => ({
    modelId: r.group ?? "unknown",
    ...rowToStat(r),
  }));

  // ── Providers ──────────────────────────────────────────────────────────────
  const providerRows = await driver.aggregate({ ...filter, groupBy: "baseUrl" });
  const providers: ProviderSummary[] = providerRows.map((r) => ({
    baseUrl: r.group ?? "unknown",
    ...rowToStat(r),
  }));

  // ── Clients ────────────────────────────────────────────────────────────────
  const clientRows = await driver.aggregate({ ...filter, groupBy: "client" });
  const clientSummaries: ClientSummary[] = clientRows.map((r) => ({
    client: r.group ?? "unknown",
    ...rowToStat(r),
    topModels: [],
  }));

  // Fill topModels for the top 3 non-null client rows.
  const topClientRows = clientRows.filter((r) => r.group !== null).slice(0, 3);
  for (const row of topClientRows) {
    const clientId = row.group!;
    const topModelRows = await driver.aggregate({
      ...filter,
      groupBy: "modelId",
      client: clientId,
    });
    const summary = clientSummaries.find((c) => c.client === clientId);
    if (summary) {
      summary.topModels = topModelRows.slice(0, 5).map(rowToTopModel);
    }
  }

  // ── Npubs ──────────────────────────────────────────────────────────────────
  // Build clientId → ownerNpub lookup (only clients with ownerNpub).
  const clientToNpub = new Map<string, string>();
  for (const c of clients) {
    if (c.ownerNpub) {
      clientToNpub.set(c.clientId, c.ownerNpub);
    }
  }

  // Fold client rows into per-npub sums.
  const npubStats = new Map<string, StatRow>();
  const npubClientIds = new Map<string, string[]>();
  for (const r of clientRows) {
    if (r.group === null) continue;
    const npub = clientToNpub.get(r.group);
    if (!npub) continue;
    const existing = npubStats.get(npub);
    if (existing) {
      existing.requests += r.requests;
      existing.promptTokens += r.promptTokens;
      existing.completionTokens += r.completionTokens;
      existing.totalTokens += r.totalTokens;
      existing.cost += r.cost;
      existing.satsCost += r.satsCost;
    } else {
      npubStats.set(npub, { ...rowToStat(r) });
    }
    const ids = npubClientIds.get(npub) ?? [];
    ids.push(r.group);
    npubClientIds.set(npub, ids);
  }

  // Sort npubs desc by satsCost.
  const sortedNpubs = [...npubStats.entries()].sort(
    (a, b) => b[1].satsCost - a[1].satsCost,
  );

  const npubs: NpubSummary[] = sortedNpubs.map(([npub, stat]) => ({
    npub,
    ...stat,
    topModels: [],
  }));

  // Fill topModels for top 5 npubs.
  for (let i = 0; i < Math.min(5, npubs.length); i++) {
    const npubSummary = npubs[i]!;
    const ids = npubClientIds.get(npubSummary.npub) ?? [];
    if (ids.length > 0) {
      const topModelRows = await driver.aggregate({
        ...filter,
        groupBy: "modelId",
        clients: ids,
      });
      npubSummary.topModels = topModelRows.slice(0, 5).map(rowToTopModel);
    }
  }

  // ── Size buckets ───────────────────────────────────────────────────────────
  // The SDK's aggregate() no longer supports token-range filters
  // (minTotalTokens/maxTotalTokens were removed in SDK pr-8), so bucket in
  // JS from a single list() call instead of five aggregate() queries.
  const allEntries = await driver.list(filter);
  const sizeBuckets = computeSizeBuckets(allEntries);

  return { totals, models, providers, clients: clientSummaries, npubs, sizeBuckets };
}

// ─── Main builder ─────────────────────────────────────────────────────────────

export async function getUsageSummary(
  driver: UsageTrackingDriver,
  clients: ClientEntry[],
  tzOffsetMinutes: number,
  /** If set, only include usage for these client IDs (e.g. from `?npub=` filtering). */
  clientFilter?: string[],
  /** Time window for the `summary.window` block. Defaults to `all`. */
  window: TimeWindow = "all",
): Promise<UsageSummary> {
  // Cache key: total row count + per-client identity + filter + tz + window.
  const count = await driver.count(clientFilter ? { clients: clientFilter } : {});
  const clientIdentity = clients.map((c) => `${c.clientId}:${c.ownerNpub ?? ""}`).join(",");
  const filterKey = clientFilter ? `:f:${clientFilter.sort().join(",")}` : "";
  const cacheKey = `${count}:${clientIdentity}:${tzOffsetMinutes}${filterKey}:${window}`;
  const now = Date.now();

  if (
    _cache !== null &&
    _cache.key === cacheKey &&
    now - _cache.summary.generatedAt <= CACHE_TTL_MS
  ) {
    return _cache.summary;
  }

  // Base filter applied to every aggregate/list/count call.
  const baseFilter: UsageFilter = clientFilter ? { clients: clientFilter } : {};

  // Short-circuit: if the filter yields no rows, return a zeroed summary.
  if (count === 0) {
    const aggregates = emptyAggregates();
    const zeroSummary: UsageSummary = {
      generatedAt: now,
      ...aggregates,
      days: [],
      hoursToday: [],
      recent: [],
      window: { window, ...aggregates, timeline: emptyTimeline(window) },
    };
    _cache = { key: cacheKey, summary: zeroSummary };
    return zeroSummary;
  }

  // All-time aggregates — drive Overview and remain window-independent.
  const allTime = await buildAggregates(driver, baseFilter, clients, tzOffsetMinutes);

  // History chart series — bucketed per the selected window (hours/days/months).
  const timeline = await buildTimeline(driver, baseFilter, window, now, tzOffsetMinutes);

  // Windowed aggregates — drive Models/Providers/Tokens/Clients/Npubs.
  // For `all` we reuse the all-time block, so the default view pays no extra cost.
  const windowStats: WindowedStats = window === "all"
    ? { window, ...allTime, timeline }
    : {
        window,
        ...(await buildAggregates(
          driver,
          baseFilter,
          clients,
          tzOffsetMinutes,
          windowAfter(window, now, tzOffsetMinutes),
        )),
        timeline,
      };

  // ── Days (last 30, most-recent-first) ─────────────────────────────────────
  const dayRows = await driver.aggregate({
    ...baseFilter,
    groupBy: "day",
    tzOffsetMinutes,
    after: now - 30 * 86400000,
  });
  const days: DaySummary[] = dayRows
    .map((r) => ({ date: r.group!, ...rowToStat(r) }))
    .reverse(); // aggregate returns ascending; we want most-recent-first

  // ── Hours today ────────────────────────────────────────────────────────────
  const todayStartUtc = startOfLocalDayUtc(now, tzOffsetMinutes);
  const hourRows = await driver.aggregate({
    ...baseFilter,
    groupBy: "hour",
    tzOffsetMinutes,
    after: todayStartUtc - 1,
  });
  const hoursToday: HourSummary[] = hourRows.map((r) => ({
    hour: Number(r.group),
    ...rowToStat(r),
  }));

  // ── Recent entries ─────────────────────────────────────────────────────────
  const recent = await driver.list({ ...baseFilter, limit: 50 });

  const summary: UsageSummary = {
    generatedAt: now,
    ...allTime,
    days,
    hoursToday,
    recent,
    window: windowStats,
  };

  _cache = { key: cacheKey, summary };
  return summary;
}
