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
 * {@link TimeWindow}: hours for the last 24h, days for 7d/30d, and months for
 * the unbounded `all` view.
 */
export type TimelineBucket = "hour" | "day" | "month";

/** One bar in the history chart: one hour, day or month of usage. */
export interface TimelinePoint {
  /** Bucket key: `HH` (hour), `YYYY-MM-DD` (day) or `YYYY-MM` (month). */
  key: string;
  /** Bucket start, UTC ms. Month points are anchored to the 1st of the month. */
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
 * Selectable time range for the usage monitor. `today` is the current local
 * day, `7d`/`30d` are rolling windows, `all` is unbounded.
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

/**
 * The `after` boundary (exclusive, as the driver defines it) for a window, or
 * `undefined` for the unbounded `all` window.
 */
function windowAfter(
  window: TimeWindow,
  now: number,
  tzOffsetMinutes: number,
): number | undefined {
  switch (window) {
    case "today":
      // Strict `timestamp > after`, so a 1ms nudge makes local midnight inclusive.
      return startOfLocalDayUtc(now, tzOffsetMinutes) - 1;
    case "7d":
      return now - 7 * 86400000;
    case "30d":
      return now - 30 * 86400000;
    case "all":
      return undefined;
  }
}

/** Filter shared by every aggregate/list/count call. */
interface UsageFilter {
  clients?: string[];
  after?: number;
}

// ─── History timeline ────────────────────────────────────────────────────────

const HOUR_MS = 3_600_000;
const DAY_MS = 86_400_000;

const pad2 = (n: number): string => String(n).padStart(2, "0");

/** Empty series used by the zero-data short-circuit. */
function emptyTimeline(window: TimeWindow): Timeline {
  return { bucket: bucketForWindow(window), points: [] };
}

/** Which bucket the chart uses for a window: hours, days or months. */
function bucketForWindow(window: TimeWindow): TimelineBucket {
  if (window === "today") return "hour";
  if (window === "all") return "month";
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

/**
 * Build the zero-filled history series for a window.
 *
 * - `today` (24h) → 24 hourly buckets, aligned to the local hour, newest last.
 * - `7d` / `30d` → that many daily buckets, newest last.
 * - `all` → one bucket per calendar month, from the first month with usage to
 *   the current month. The SDK has no `month` grouping, so all days are
 *   aggregated and folded here.
 */
async function buildTimeline(
  driver: UsageTrackingDriver,
  baseFilter: UsageFilter,
  window: TimeWindow,
  now: number,
  tzOffsetMinutes: number,
): Promise<Timeline> {
  if (window === "all") {
    return buildMonthlyTimeline(driver, baseFilter, now, tzOffsetMinutes);
  }

  const isHourly = window === "today";
  const bucket = isHourly ? "hour" : "day";
  const bucketMs = isHourly ? HOUR_MS : DAY_MS;
  const slotCount = isHourly ? 24 : window === "7d" ? 7 : 30;

  // Align the newest slot to the current local hour/day so the window covers
  // whole buckets (each hour-of-day appears at most once, which matters
  // because the SDK's `hour` keys carry no date).
  const shiftedNow = now - tzOffsetMinutes * 60_000;
  const newestShifted = Math.floor(shiftedNow / bucketMs) * bucketMs;
  const oldestShifted = newestShifted - (slotCount - 1) * bucketMs;
  const oldestUtc = oldestShifted + tzOffsetMinutes * 60_000;

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

/** Fold all-time daily aggregates into calendar months, zero-filling gaps. */
async function buildMonthlyTimeline(
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

  const byMonth = new Map<string, TimelineAccumulator>();
  for (const row of rows) {
    const key = (row.group ?? "").slice(0, 7); // YYYY-MM
    if (key.length !== 7) continue;
    const acc = byMonth.get(key) ?? zeroAccumulator();
    const add = accumulatorFromRow(row);
    acc.requests += add.requests;
    acc.satsCost += add.satsCost;
    acc.totalTokens += add.totalTokens;
    acc.promptTokens += add.promptTokens;
    acc.completionTokens += add.completionTokens;
    byMonth.set(key, acc);
  }

  const months = [...byMonth.keys()].sort();
  if (months.length === 0) return { bucket: "month", points: [] };

  const [firstYear, firstMonth] = months[0]!.split("-").map(Number) as [number, number];
  const nowShifted = new Date(now - tzOffsetMinutes * 60_000);
  const lastYear = nowShifted.getUTCFullYear();
  const lastMonth = nowShifted.getUTCMonth() + 1;

  const points: TimelinePoint[] = [];
  let year = firstYear;
  let month = firstMonth;
  while (year < lastYear || (year === lastYear && month <= lastMonth)) {
    const key = `${year}-${pad2(month)}`;
    // `Date.UTC` gives the shifted-local first-of-month; add the offset back.
    const shiftedStart = Date.UTC(year, month - 1, 1);
    points.push({
      key,
      timestamp: shiftedStart + tzOffsetMinutes * 60_000,
      ...(byMonth.get(key) ?? zeroAccumulator()),
    });
    month += 1;
    if (month > 12) {
      month = 1;
      year += 1;
    }
  }

  return { bucket: "month", points };
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
