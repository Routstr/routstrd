#!/usr/bin/env bun
/**
 * Entrypoint for the standalone Bun binary (`bun build --compile`).
 *
 * Identical to `src/index.ts` except that it statically imports the Bun SQLite
 * event database first. The shared code path reaches that module through a
 * computed dynamic import so Deno never tries to resolve `bun:sqlite`, but a
 * computed specifier is also invisible to Bun's bundler, so without this the
 * compiled binary boots with no persistent Nostr event store.
 *
 * Deno never loads this file: `deno check` and `deno compile` are pointed at
 * `src/index.ts`.
 */
import { BunSqliteEventDatabase } from "applesauce-sqlite/bun";
import { setPersistentEventDatabaseFactory } from "./daemon/sdk-storage.ts";

setPersistentEventDatabaseFactory((dbPath) => new BunSqliteEventDatabase(dbPath));

await import("./index.ts");
