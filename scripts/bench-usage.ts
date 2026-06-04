/**
 * bench-usage.ts — In-process, no-network benchmark (Option B).
 *
 * Compares the NEW server-aggregated summary path against the LEGACY
 * "fetch-everything-then-re-aggregate" path, in terms of TIME, highlighting
 * the daemon-side cache that lives in `getUsageSummary`.
 *
 * It deliberately SKIPS the HTTP layer. In production:
 *   - `fetchUsageSummary()` HTTP-calls the daemon, which runs `getUsageSummary()`.
 *   - `fetchUsage(N)`        HTTP-calls the daemon, which runs `driver.list({limit:N})`.
 * The real localhost socket round-trip (~1-3 ms) is roughly CONSTANT for both
 * paths, so excluding it isolates the actual computational difference — which is
 * the whole point. See the takeaway printed at the end.
 *
 * Run from the repo root:   bun scripts/bench-usage.ts   [--json]
 *
 */

// @ts-ignore — bun:sqlite is a Bun built-in module (matches storage/bun.ts).
import { Database } from "bun:sqlite";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { rmSync } from "node:fs";

import { createBunSqliteUsageTrackingDriver } from "@routstr/sdk/storage/bun";
import {
  getUsageSummary,
  __resetUsageSummaryCacheForTest,
} from "../src/daemon/http/usage-summary.ts";
import {
  getTotals,
  getModelStats,
  getProviderStats,
  getClientStats,
  getDayStats,
  getHourlyToday,
  getNpubStats,
} from "../src/tui/usage/data.ts";
import type { UsageTrackingEntry } from "../src/daemon/types.ts";

// ─── Config ──────────────────────────────────────────────────────────────────

const SIZES = [100, 1000, 2500, 5000, 10000, 20000];
const SAMPLES = 25; // median of 25, after a warmup
const STEADY_REFRESHES = 10; // the monitor's ~2s refresh loop
const TZ_OFFSET = 300; // synthetic UTC-5; fixed so results are reproducible
const DAY_SPREAD = 45; // spread timestamps over ~45 days

const jsonMode = process.argv.includes("--json");

// ─── Synthetic, sanitized templates (no real DB, no real identifiers) ─────────

interface Template {
  modelId: string;
  baseUrl: string;
  client: string;
  cost: number;
  satsCost: number;
  promptTokens: number;
  completionTokens: number;
}

const PROVIDER_A = "https://api.example-provider-a.com/";
const PROVIDER_B = "https://api.example-provider-b.com/";

const TEMPLATES: Template[] = [
  { modelId: "minimax-m3", baseUrl: PROVIDER_A, client: "client-a", cost: 0.0021, satsCost: 4, promptTokens: 320, completionTokens: 180 },
  { modelId: "kimi-k2.6", baseUrl: PROVIDER_A, client: "client-b", cost: 0.0140, satsCost: 27, promptTokens: 5200, completionTokens: 2400 },
  { modelId: "deepseek-v4-flash", baseUrl: PROVIDER_B, client: "client-c", cost: 0.0008, satsCost: 1, promptTokens: 90, completionTokens: 60 },
  { modelId: "deepseek-v4-flash", baseUrl: PROVIDER_B, client: "client-a", cost: 0.0420, satsCost: 81, promptTokens: 24000, completionTokens: 13000 },
  { modelId: "kimi-k2.6", baseUrl: PROVIDER_B, client: "client-b", cost: 0.0065, satsCost: 12, promptTokens: 1800, completionTokens: 950 },
];

// Clients array (shape works for both getUsageSummary's ClientEntry and
// data.ts's ClientInfo — both only read clientId / ownerNpub). ~half get a
// synthetic ownerNpub so the npub aggregation path is exercised.
const CLIENT_IDS = [...new Set(TEMPLATES.map((t) => t.client))];
const clients = CLIENT_IDS.map((id, i) => ({
  clientId: id,
  name: id,
  apiKey: `apikey-${id}`,
  createdAt: 0,
  ownerNpub: i % 2 === 0 ? `npub1bench${id.replace(/[^a-z]/g, "")}` : undefined,
}));

// ─── Row generation ────────────────────────────────────────────────────────────

function generateRows(n: number, now: number): UsageTrackingEntry[] {
  const rows: UsageTrackingEntry[] = new Array(n);
  const spreadMs = DAY_SPREAD * 86_400_000;
  for (let i = 0; i < n; i++) {
    const t = TEMPLATES[i % TEMPLATES.length]!;
    // Spread timestamps backwards from `now` over DAY_SPREAD days, with a
    // little jitter so multiple buckets/hours are populated.
    const jitter = (i * 97) % 86_400_000;
    const timestamp = now - Math.floor((i / n) * spreadMs) - jitter;
    const promptTokens = t.promptTokens + (i % 17);
    const completionTokens = t.completionTokens + (i % 13);
    rows[i] = {
      id: `bench-${i}`,
      timestamp,
      modelId: t.modelId,
      baseUrl: t.baseUrl,
      requestId: `req-${i}`,
      cost: t.cost,
      satsCost: t.satsCost,
      promptTokens,
      completionTokens,
      totalTokens: promptTokens + completionTokens,
      client: t.client,
      sessionId: `sess-${i % 50}`,
      tags: [],
    };
  }
  return rows;
}

// ─── Seeding (raw transactional insert — fast) ────────────────────────────────

const TABLE = "usage_tracking";

function seedRawDb(dbPath: string, rows: UsageTrackingEntry[]): void {
  const db = new Database(dbPath);
  // Match the SDK schema exactly (copied from storage/bun.ts).
  db.run(`
    CREATE TABLE IF NOT EXISTS ${TABLE} (
      id TEXT PRIMARY KEY,
      timestamp INTEGER NOT NULL,
      model_id TEXT NOT NULL,
      base_url TEXT NOT NULL,
      request_id TEXT NOT NULL,
      cost REAL NOT NULL,
      sats_cost REAL NOT NULL,
      prompt_tokens INTEGER NOT NULL,
      completion_tokens INTEGER NOT NULL,
      total_tokens INTEGER NOT NULL,
      client TEXT,
      session_id TEXT,
      tags TEXT
    )
  `);
  db.run(`CREATE INDEX IF NOT EXISTS idx_${TABLE}_timestamp ON ${TABLE}(timestamp)`);
  db.run(`CREATE INDEX IF NOT EXISTS idx_${TABLE}_model_id ON ${TABLE}(model_id)`);
  db.run(`CREATE INDEX IF NOT EXISTS idx_${TABLE}_base_url ON ${TABLE}(base_url)`);

  const insert = db.query(`
    INSERT OR REPLACE INTO ${TABLE} (
      id, timestamp, model_id, base_url, request_id,
      cost, sats_cost, prompt_tokens, completion_tokens, total_tokens,
      client, session_id, tags
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  const seed = db.transaction((batch: UsageTrackingEntry[]) => {
    for (const r of batch) {
      insert.run(
        r.id, r.timestamp, r.modelId, r.baseUrl, r.requestId,
        r.cost, r.satsCost, r.promptTokens, r.completionTokens, r.totalTokens,
        r.client ?? null, r.sessionId ?? null, JSON.stringify(r.tags ?? []),
      );
    }
  });
  seed(rows);
  db.close();
}

// ─── Timing helpers ────────────────────────────────────────────────────────────

async function timeMedian(fn: () => Promise<unknown>, samples = SAMPLES): Promise<number> {
  await fn(); // warmup (discarded)
  const times: number[] = [];
  for (let i = 0; i < samples; i++) {
    const start = performance.now();
    await fn();
    times.push(performance.now() - start);
  }
  times.sort((a, b) => a - b);
  return times[Math.floor(times.length / 2)]!;
}

function runLegacyAggregation(rows: UsageTrackingEntry[]): void {
  // Mirror exactly what the monitor's render path does on raw entries.
  getTotals(rows);
  getModelStats(rows);
  getProviderStats(rows);
  getClientStats(rows);
  getDayStats(rows);
  getHourlyToday(rows);
  getNpubStats(rows, clients);
}

// ─── Bench per size ──────────────────────────────────────────────────────────

interface SizeResult {
  size: number;
  summaryColdMs: number;
  summaryWarmMs: number;
  legacyMs: number;
  summaryKB: number;
  legacyKB: number;
  reductionX: number;
  steadySummaryMs: number;
  steadyLegacyMs: number;
  speedupX: number;
}

async function benchSize(size: number): Promise<SizeResult> {
  const now = Date.now();
  const dbPath = join(tmpdir(), `routstrd-bench-${size}-${process.pid}-${Date.now()}.db`);
  const rows = generateRows(size, now);
  seedRawDb(dbPath, rows);

  const driver = await createBunSqliteUsageTrackingDriver({ dbPath });

  try {
    // ── summary cold: reset cache before every timed call ──────────────────
    const summaryColdMs = await timeMedian(async () => {
      __resetUsageSummaryCacheForTest();
      await getUsageSummary(driver, clients, TZ_OFFSET);
    });

    // ── summary warm: cache already populated (warmup call is itself a hit) ─
    __resetUsageSummaryCacheForTest();
    await getUsageSummary(driver, clients, TZ_OFFSET); // populate once
    const summaryWarmMs = await timeMedian(async () => {
      await getUsageSummary(driver, clients, TZ_OFFSET);
    });

    // ── legacy: list(limit:N) + full client-side re-aggregation, no cache ──
    const legacyMs = await timeMedian(async () => {
      const listed = await driver.list({ limit: size });
      runLegacyAggregation(listed);
    });

    // ── payload bytes ──────────────────────────────────────────────────────
    __resetUsageSummaryCacheForTest();
    const summaryResult = await getUsageSummary(driver, clients, TZ_OFFSET);
    const listedRows = await driver.list({ limit: size });
    const summaryBytes = JSON.stringify(summaryResult).length;
    const legacyBytes = JSON.stringify(listedRows).length;

    // ── steady state (the 2s refresh loop, STEADY_REFRESHES iterations) ────
    // summary: 1 cold + (N-1) warm; legacy: N × full cost (no cache).
    const steadySummaryMs =
      summaryColdMs + (STEADY_REFRESHES - 1) * summaryWarmMs;
    const steadyLegacyMs = STEADY_REFRESHES * legacyMs;

    return {
      size,
      summaryColdMs,
      summaryWarmMs,
      legacyMs,
      summaryKB: summaryBytes / 1024,
      legacyKB: legacyBytes / 1024,
      reductionX: legacyBytes / summaryBytes,
      steadySummaryMs,
      steadyLegacyMs,
      speedupX: steadyLegacyMs / steadySummaryMs,
    };
  } finally {
    // driver holds the only open handle now; closing the file by removing it.
    try {
      rmSync(dbPath, { force: true });
      rmSync(`${dbPath}-shm`, { force: true });
      rmSync(`${dbPath}-wal`, { force: true });
    } catch { /* ignore */ }
  }
}

// ─── Output ──────────────────────────────────────────────────────────────────

function fmt(n: number, dp = 2): string {
  return n.toFixed(dp);
}

function pad(s: string, width: number): string {
  return s.padStart(width);
}

function printTable(results: SizeResult[]): void {
  console.log("");
  console.log("Routstr usage path benchmark — TIME (in-process, no network)");
  console.log("Daemon-side summary cache vs. legacy fetch-all-and-re-aggregate.\n");

  // ── Payload table (per request) ──────────────────────────────
  console.log("Payload per request:");
  const payHeader = [
    pad("size", 7),
    pad("summary", 11),
    pad("legacy", 11),
    pad("reduction", 11),
  ].join("  ");
  console.log(payHeader);
  console.log("-".repeat(payHeader.length));
  for (const r of results) {
    console.log([
      pad(String(r.size), 7),
      pad(fmt(r.summaryKB, 1) + " KB", 11),
      pad(fmt(r.legacyKB, 1) + " KB", 11),
      pad(fmt(r.reductionX, 1) + "x", 11),
    ].join("  "));
  }

  // ── Time table (ms) ──────────────────────────────────────────
  console.log("");
  console.log("Time (ms):");
  const timeHeader = [
    pad("size", 7),
    pad("sum cold", 10),
    pad("sum warm", 10),
    pad("legacy", 10),
    pad("steady sum", 12),
    pad("steady leg", 12),
    pad("speedup", 9),
  ].join("  ");
  console.log(timeHeader);
  console.log("-".repeat(timeHeader.length));
  for (const r of results) {
    console.log([
      pad(String(r.size), 7),
      pad(fmt(r.summaryColdMs) + "ms", 10),
      pad(fmt(r.summaryWarmMs) + "ms", 10),
      pad(fmt(r.legacyMs) + "ms", 10),
      pad(fmt(r.steadySummaryMs) + "ms", 12),
      pad(fmt(r.steadyLegacyMs) + "ms", 12),
      pad(fmt(r.speedupX, 1) + "x", 9),
    ].join("  "));
  }

  console.log("");
  console.log("Legend (in-process; times = medians of " + SAMPLES + " samples, warmup discarded;");
  console.log("excludes the ~constant localhost HTTP round-trip both paths would add):");
  console.log("  size          seeded usage rows in the DB");
  console.log("");
  console.log("  Payload table:");
  console.log("    summary     JSON bytes of the /usage/summary response (aggregates + 50 recent rows)");
  console.log("    legacy      JSON bytes of the /usage response (all rows)");
  console.log("    reduction   legacy / summary");
  console.log("");
  console.log("  Time table:");
  console.log("    sum cold    summary build, COLD cache (cache miss: ~15-query rebuild + assemble)");
  console.log("    sum warm    summary from WARM cache (count() + return the memoized result)");
  console.log("    legacy      list all rows + the client-side re-aggregation the monitor does (no cache)");
  console.log("    steady sum  total ms the SUMMARY path spends over " + STEADY_REFRESHES + " refreshes of the monitor's ~2s loop,");
  console.log("                assuming data is unchanged across the window (cache stays valid):");
  console.log("                1 cold build + " + (STEADY_REFRESHES - 1) + " warm cache hits = cold + " + (STEADY_REFRESHES - 1) + "xwarm. Since warm is ~0.01ms,");
  console.log("                this is in practice ~one cold build.");
  console.log("    steady leg  same " + STEADY_REFRESHES + " refreshes for LEGACY = legacy x" + STEADY_REFRESHES + " (no cache, full cost each time)");
  console.log("    speedup     steady leg / steady sum");
}

// ─── Main ────────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  const results: SizeResult[] = [];
  for (const size of SIZES) {
    results.push(await benchSize(size));
  }

  if (jsonMode) {
    console.log(JSON.stringify(
      {
        config: { sizes: SIZES, samples: SAMPLES, steadyRefreshes: STEADY_REFRESHES, tzOffset: TZ_OFFSET },
        note: "In-process; HTTP round-trip (~1-3ms localhost, ~constant for both) excluded.",
        results,
      },
      null,
      2,
    ));
  } else {
    printTable(results);
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
