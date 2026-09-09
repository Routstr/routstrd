/**
 * Cross-runtime construction of the Routstr SDK's storage layer.
 *
 * The SDK ships `@routstr/sdk/bun` (bun:sqlite) and `@routstr/sdk/node`
 * (better-sqlite3). Neither works on Deno: better-sqlite3 is a legacy V8/nan
 * addon that Deno cannot load at all. So the daemon builds the three pieces it
 * needs on top of `src/utils/sqlite.ts` instead, which works on both runtimes.
 */

import type { SdkLogger } from "@routstr/sdk";
import { ModelManager } from "@routstr/sdk";
import type { DiscoveryAdapter, StorageDriver, UsageTrackingDriver } from "@routstr/sdk/storage";
import { createBunSqliteUsageTrackingDriverWithDatabase } from "@routstr/sdk/storage/bun";
import { Database } from "../utils/sqlite.ts";

const isDeno = typeof (globalThis as { Deno?: unknown }).Deno !== "undefined" &&
  typeof (globalThis as { Bun?: unknown }).Bun === "undefined";

/**
 * Key/value StorageDriver over SQLite.
 *
 * Deliberately mirrors the schema and JSON encoding of the SDK's
 * `createBunSqliteDriver` (which has no injection point for the database) so
 * existing `~/.routstrd/routstr.db` files keep working, in both directions.
 */
export function createSqliteStorageDriver(
  dbPath: string,
  options?: { logger?: SdkLogger },
): StorageDriver {
  const logger = options?.logger?.child?.("SqliteStorageDriver") ?? options?.logger;
  const db = new Database(dbPath);
  db.run("PRAGMA journal_mode = WAL");
  db.run("PRAGMA busy_timeout = 5000");
  db.run(`
    CREATE TABLE IF NOT EXISTS sdk_storage (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL
    )
  `);

  return {
    async getItem<T>(key: string, defaultValue: T): Promise<T> {
      try {
        const row = db.query("SELECT value FROM sdk_storage WHERE key = ?").get(key) as
          | { value?: unknown }
          | null;
        if (!row || typeof row.value !== "string") return defaultValue;
        try {
          return JSON.parse(row.value) as T;
        } catch (parseError) {
          // Tolerate pre-JSON string values written by older versions.
          if (typeof defaultValue === "string") return row.value as unknown as T;
          throw parseError;
        }
      } catch (error) {
        logger?.error(`getItem failed for key "${key}":`, error);
        return defaultValue;
      }
    },

    async setItem<T>(key: string, value: T): Promise<void> {
      try {
        db.query(
          "INSERT INTO sdk_storage (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
        ).run(key, JSON.stringify(value));
      } catch (error) {
        logger?.error(`setItem failed for key "${key}":`, error);
      }
    },

    async removeItem(key: string): Promise<void> {
      try {
        db.query("DELETE FROM sdk_storage WHERE key = ?").run(key);
      } catch (error) {
        logger?.error(`removeItem failed for key "${key}":`, error);
      }
    },
  };
}

/**
 * The SDK's SQLite usage-tracking driver, given our cross-runtime Database.
 * `@routstr/sdk/storage/bun` only imports `bun:sqlite` lazily, inside the
 * factory we deliberately bypass, so this module also loads cleanly on Deno.
 */
export function createSqliteUsageTrackingDriver(options: {
  dbPath: string;
  legacyStorageDriver?: StorageDriver;
}): UsageTrackingDriver {
  return createBunSqliteUsageTrackingDriverWithDatabase({
    dbPath: options.dbPath,
    ...(options.legacyStorageDriver ? { legacyStorageDriver: options.legacyStorageDriver } : {}),
    sqlite: { Database },
  });
}

/** Persistent Nostr event store, backed by whichever SQLite the runtime has. */
async function createPersistentEventDatabase(dbPath: string) {
  if (isDeno) {
    const specifier = "applesauce-sqlite/deno";
    const { NativeSqliteEventDatabase } = await import(specifier);
    return new NativeSqliteEventDatabase(dbPath);
  }
  const specifier = "applesauce-sqlite/bun";
  const { BunSqliteEventDatabase } = await import(specifier);
  return new BunSqliteEventDatabase(dbPath);
}

type ModelManagerConfig = ConstructorParameters<typeof ModelManager>[1];

/**
 * A ModelManager with a SQLite-backed event store. The plain `@routstr/sdk`
 * entrypoint is browser-safe and throws without this factory, so passing it is
 * load-bearing, not cosmetic.
 */
export function createDaemonModelManager(
  adapter: DiscoveryAdapter,
  config: ModelManagerConfig,
): ModelManager {
  return new ModelManager(adapter, {
    ...config,
    persistentEventDatabaseFactory: createPersistentEventDatabase,
  });
}
