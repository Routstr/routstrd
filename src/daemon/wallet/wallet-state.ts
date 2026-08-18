import { existsSync, readFileSync, statSync } from "fs";
import { join } from "path";

/**
 * Pure wallet-migration state detection, shared by the actual migration and by
 * the doctor diagnostics so the two cannot disagree about startup behavior.
 */

export type WalletState = "absent" | "database-only" | "initialized";

export function walletState(configPath: string, dbPath: string): WalletState {
  const hasConfig = existsSync(configPath);
  const hasDb = existsSync(dbPath);
  if (hasConfig) return "initialized";
  if (hasDb) return "database-only";
  return "absent";
}

export function filesEqual(left: string, right: string): boolean {
  if (!existsSync(left) || !existsSync(right)) return false;
  if (statSync(left).size !== statSync(right).size) return false;
  return readFileSync(left).equals(readFileSync(right));
}

export type WalletMigrationClass =
  | { kind: "fresh" }
  | { kind: "already-current" }
  | { kind: "migrate" }
  | { kind: "conflict" }
  | { kind: "database-only"; targetState: WalletState; sourceState: WalletState }
  | { kind: "orphaned-sidecars" };

/**
 * Classify the two wallet locations exactly the way `migrateLegacyWallet`
 * decides what to do. This is the single source of truth for startup behavior;
 * `migrateLegacyWallet` maps it onto actions/errors and the doctor maps it onto
 * verdict text.
 */
export function classifyWalletMigration(
  targetDir: string,
  sourceDir: string,
): WalletMigrationClass {
  const targetConfig = join(targetDir, "config.json");
  const targetDb = join(targetDir, "coco.db");
  const sourceConfig = join(sourceDir, "config.json");
  const sourceDb = join(sourceDir, "coco.db");
  const sourceWal = `${sourceDb}-wal`;
  const sourceShm = `${sourceDb}-shm`;

  const targetState = walletState(targetConfig, targetDb);
  const sourceState = walletState(sourceConfig, sourceDb);

  // config.json is sufficient for a newly initialized wallet; coco.db is
  // created on first open. A database without its mnemonic is never usable.
  if (targetState === "initialized" && sourceState === "initialized") {
    // A prior migration may have committed successfully but failed to remove
    // its source files. Identical leftovers are safe; divergent wallets are not.
    const configsMatch = filesEqual(targetConfig, sourceConfig);
    const databasesMatch =
      !existsSync(targetDb) && !existsSync(sourceDb)
        ? true
        : filesEqual(targetDb, sourceDb);
    if (configsMatch && databasesMatch) return { kind: "already-current" };
    return { kind: "conflict" };
  }
  if (targetState === "initialized") return { kind: "already-current" };
  if (!existsSync(sourceDb) && (existsSync(sourceWal) || existsSync(sourceShm))) {
    return { kind: "orphaned-sidecars" };
  }
  if (targetState === "database-only" || sourceState === "database-only") {
    return { kind: "database-only", targetState, sourceState };
  }
  if (sourceState === "absent") return { kind: "fresh" };
  return { kind: "migrate" };
}