/**
 * Cross-runtime SQLite.
 *
 * Bun ships `bun:sqlite`; Deno ships `node:sqlite`. Neither runtime has the
 * other's module, so this picks one at load time and exposes the `bun:sqlite`
 * shape (which the rest of the codebase, `@cashu/coco-sqlite-bun`, and the
 * Routstr SDK's usage-tracking driver all expect).
 *
 * The specifier is computed rather than a literal so bundlers leave the import
 * alone instead of trying to resolve the branch that isn't taken.
 */

export interface SqliteRunResult {
  changes: number;
  lastInsertRowid: number;
}

export interface SqliteStatement {
  get(...params: unknown[]): unknown;
  all(...params: unknown[]): unknown[];
  run(...params: unknown[]): SqliteRunResult;
  values(...params: unknown[]): unknown[][];
}

export interface SqliteDatabase {
  query(sql: string): SqliteStatement;
  prepare(sql: string): SqliteStatement;
  exec(sql: string): void;
  run(sql: string, ...params: unknown[]): SqliteRunResult;
  close(): void;
}

export interface SqliteOpenOptions {
  readonly?: boolean;
}

export type SqliteDatabaseConstructor = new (
  path: string,
  options?: SqliteOpenOptions,
) => SqliteDatabase;

const isDeno = typeof (globalThis as { Deno?: unknown }).Deno !== "undefined" &&
  typeof (globalThis as { Bun?: unknown }).Bun === "undefined";

/** Wraps a `node:sqlite` StatementSync in the `bun:sqlite` Statement shape. */
class NodeSqliteStatement implements SqliteStatement {
  constructor(private readonly statement: {
    get(...params: unknown[]): unknown;
    all(...params: unknown[]): unknown[];
    run(...params: unknown[]): { changes: number | bigint; lastInsertRowid: number | bigint };
    setReturnArrays(value: boolean): void;
  }) {}

  get(...params: unknown[]): unknown {
    // bun:sqlite yields null for a miss, node:sqlite yields undefined.
    return this.statement.get(...params) ?? null;
  }

  all(...params: unknown[]): unknown[] {
    return this.statement.all(...params);
  }

  run(...params: unknown[]): SqliteRunResult {
    const result = this.statement.run(...params);
    return {
      changes: Number(result.changes),
      lastInsertRowid: Number(result.lastInsertRowid),
    };
  }

  values(...params: unknown[]): unknown[][] {
    this.statement.setReturnArrays(true);
    try {
      return this.statement.all(...params) as unknown[][];
    } finally {
      this.statement.setReturnArrays(false);
    }
  }
}

/** Wraps a `node:sqlite` DatabaseSync in the `bun:sqlite` Database shape. */
function makeNodeSqliteDatabase(DatabaseSync: new (path: string, options?: object) => {
  prepare(sql: string): never;
  exec(sql: string): void;
  close(): void;
}): SqliteDatabaseConstructor {
  class NodeSqliteDatabase implements SqliteDatabase {
    private readonly db;

    constructor(path: string, options?: SqliteOpenOptions) {
      this.db = new DatabaseSync(
        path,
        options?.readonly ? { readOnly: true } : undefined,
      );
    }

    query(sql: string): SqliteStatement {
      return this.prepare(sql);
    }

    prepare(sql: string): SqliteStatement {
      return new NodeSqliteStatement(this.db.prepare(sql));
    }

    exec(sql: string): void {
      this.db.exec(sql);
    }

    run(sql: string, ...params: unknown[]): SqliteRunResult {
      if (params.length === 0) {
        // node:sqlite's prepare() rejects multi-statement SQL, which bun:sqlite's
        // run() accepts. Fall back to exec() for those.
        try {
          return this.prepare(sql).run();
        } catch {
          this.db.exec(sql);
          return { changes: 0, lastInsertRowid: 0 };
        }
      }
      return this.prepare(sql).run(...params);
    }

    close(): void {
      this.db.close();
    }
  }
  return NodeSqliteDatabase as unknown as SqliteDatabaseConstructor;
}

async function loadDatabase(): Promise<SqliteDatabaseConstructor> {
  if (isDeno) {
    const specifier = "node:sqlite";
    const { DatabaseSync } = await import(specifier);
    return makeNodeSqliteDatabase(DatabaseSync);
  }
  const specifier = "bun:sqlite";
  const module = await import(specifier);
  return module.Database as SqliteDatabaseConstructor;
}

export const Database: SqliteDatabaseConstructor = await loadDatabase();
