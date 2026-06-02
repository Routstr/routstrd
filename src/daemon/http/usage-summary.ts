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

export interface UsageSummary {
  generatedAt: number;
  totals: StatRow;
  models: ModelSummary[];
  providers: ProviderSummary[];
  clients: ClientSummary[];
  npubs: NpubSummary[];
  days: DaySummary[];
  hoursToday: HourSummary[];
  sizeBuckets: {
    tiny: SizeBucket;
    small: SizeBucket;
    medium: SizeBucket;
    large: SizeBucket;
    huge: SizeBucket;
  };
  recent: UsageTrackingEntry[];
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

function bucketFromRow(r: UsageAggregateRow | undefined): SizeBucket {
  if (!r) return emptyBucket();
  return { count: r.requests, cost: r.satsCost };
}

/** Returns the UTC ms for the start of the local day containing `now`. */
function startOfLocalDayUtc(now: number, tzOffsetMinutes: number): number {
  return (
    Math.floor((now - tzOffsetMinutes * 60000) / 86400000) * 86400000 +
    tzOffsetMinutes * 60000
  );
}

// ─── Module-level memo cache ─────────────────────────────────────────────────

interface CacheEntry {
  key: string;
  summary: UsageSummary;
}

let _cache: CacheEntry | null = null;
const CACHE_TTL_MS = 60_000;

// ─── Main builder ─────────────────────────────────────────────────────────────

export async function getUsageSummary(
  driver: UsageTrackingDriver,
  clients: ClientEntry[],
  tzOffsetMinutes: number,
): Promise<UsageSummary> {
  // Cheap cache key: total row count + clients length + tz
  const count = await driver.count();
  const cacheKey = `${count}:${clients.length}:${tzOffsetMinutes}`;
  const now = Date.now();

  if (
    _cache !== null &&
    _cache.key === cacheKey &&
    now - _cache.summary.generatedAt <= CACHE_TTL_MS
  ) {
    return _cache.summary;
  }

  // ── Totals ─────────────────────────────────────────────────────────────────
  const [totalsRow] = await driver.aggregate({});
  const totals: StatRow = totalsRow ? rowToStat(totalsRow) : {
    requests: 0, promptTokens: 0, completionTokens: 0,
    totalTokens: 0, cost: 0, satsCost: 0,
  };

  // ── Models ─────────────────────────────────────────────────────────────────
  const modelRows = await driver.aggregate({ groupBy: "modelId" });
  const models: ModelSummary[] = modelRows.map((r) => ({
    modelId: r.group ?? "unknown",
    ...rowToStat(r),
  }));

  // ── Providers ──────────────────────────────────────────────────────────────
  const providerRows = await driver.aggregate({ groupBy: "baseUrl" });
  const providers: ProviderSummary[] = providerRows.map((r) => ({
    baseUrl: r.group ?? "unknown",
    ...rowToStat(r),
  }));

  // ── Clients ────────────────────────────────────────────────────────────────
  const clientRows = await driver.aggregate({ groupBy: "client" });
  const clientSummaries: ClientSummary[] = clientRows.map((r) => ({
    client: r.group ?? "unknown",
    ...rowToStat(r),
    topModels: [],
  }));

  // Fill topModels for the top 3 non-null client rows
  const topClientRows = clientRows
    .filter((r) => r.group !== null)
    .slice(0, 3);
  for (let i = 0; i < topClientRows.length; i++) {
    const clientId = topClientRows[i]!.group!;
    const topModelRows = await driver.aggregate({
      groupBy: "modelId",
      client: clientId,
    });
    // Find matching ClientSummary and set topModels
    const summary = clientSummaries.find((c) => c.client === clientId);
    if (summary) {
      summary.topModels = topModelRows.slice(0, 5).map(rowToTopModel);
    }
  }

  // ── Npubs ──────────────────────────────────────────────────────────────────
  // Build clientId → ownerNpub lookup (only clients with ownerNpub)
  const clientToNpub = new Map<string, string>();
  for (const c of clients) {
    if (c.ownerNpub) {
      clientToNpub.set(c.clientId, c.ownerNpub);
    }
  }

  // Fold client rows into per-npub sums
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

  // Sort npubs desc by satsCost
  const sortedNpubs = [...npubStats.entries()].sort(
    (a, b) => b[1].satsCost - a[1].satsCost,
  );

  const npubs: NpubSummary[] = sortedNpubs.map(([npub, stat]) => ({
    npub,
    ...stat,
    topModels: [],
  }));

  // Fill topModels for top 5 npubs
  for (let i = 0; i < Math.min(5, npubs.length); i++) {
    const npubSummary = npubs[i]!;
    const ids = npubClientIds.get(npubSummary.npub) ?? [];
    if (ids.length > 0) {
      const topModelRows = await driver.aggregate({
        groupBy: "modelId",
        clients: ids,
      });
      npubSummary.topModels = topModelRows.slice(0, 5).map(rowToTopModel);
    }
  }

  // ── Days (last 30, most-recent-first) ─────────────────────────────────────
  const dayRows = await driver.aggregate({
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
    groupBy: "hour",
    tzOffsetMinutes,
    after: todayStartUtc - 1,
  });
  const hoursToday: HourSummary[] = hourRows.map((r) => ({
    hour: Number(r.group),
    ...rowToStat(r),
  }));

  // ── Size buckets ───────────────────────────────────────────────────────────
  const [tinyRow] = await driver.aggregate({ minTotalTokens: 0, maxTotalTokens: 1000 });
  const [smallRow] = await driver.aggregate({ minTotalTokens: 1000, maxTotalTokens: 10000 });
  const [mediumRow] = await driver.aggregate({ minTotalTokens: 10000, maxTotalTokens: 50000 });
  const [largeRow] = await driver.aggregate({ minTotalTokens: 50000, maxTotalTokens: 100000 });
  const [hugeRow] = await driver.aggregate({ minTotalTokens: 100000 });

  const sizeBuckets = {
    tiny: bucketFromRow(tinyRow),
    small: bucketFromRow(smallRow),
    medium: bucketFromRow(mediumRow),
    large: bucketFromRow(largeRow),
    huge: bucketFromRow(hugeRow),
  };

  // ── Recent entries ─────────────────────────────────────────────────────────
  const recent = await driver.list({ limit: 50 });

  const summary: UsageSummary = {
    generatedAt: now,
    totals,
    models,
    providers,
    clients: clientSummaries,
    npubs,
    days,
    hoursToday,
    sizeBuckets,
    recent,
  };

  _cache = { key: cacheKey, summary };
  return summary;
}
