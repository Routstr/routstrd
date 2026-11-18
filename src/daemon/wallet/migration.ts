import {
  chmodSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  renameSync,
  rmSync,
  statSync,
} from "fs";
import { Database } from "bun:sqlite";
import { basename, dirname, join } from "path";
import { legacyCocodDir, walletDir } from "./paths";
import {
  summarizeWalletDirectory,
  verifyDatabase,
  WalletMigrationConflictError,
  type WalletSummary,
} from "./diagnostics";
import { classifyWalletMigration } from "./wallet-state";

export type WalletMigrationResult =
  | { status: "fresh" }
  | { status: "already-current" }
  | { status: "migrated"; from: string; to: string; cleanupWarnings: string[] };

export interface WalletMigrationOptions {
  walletDir?: string;
  legacyDir?: string;
  /** Called after state validation and before legacy files are copied. */
  assertLegacyStopped?: () => void | Promise<void>;
  /** Claims the legacy cocod exclusion lock for the duration of the copy. */
  acquireLegacyLock?: () => (() => void) | Promise<() => void>;
}

function sqlString(value: string): string {
  return `'${value.replaceAll("'", "''")}'`;
}

/** Write a standalone SQLite snapshot containing committed WAL frames. */
function snapshotDatabase(sourcePath: string, destinationPath: string): void {
  const source = new Database(sourcePath);
  let sourceSummary: WalletSummary;
  try {
    sourceSummary = verifyDatabase(source, "Legacy wallet database");
    source.exec(`VACUUM INTO ${sqlString(destinationPath)}`);
  } finally {
    source.close();
  }

  const destination = new Database(destinationPath, { readonly: true });
  try {
    const destinationSummary = verifyDatabase(destination, "Staged wallet database");
    if (JSON.stringify(sourceSummary) !== JSON.stringify(destinationSummary)) {
      throw new Error(
        "Staged wallet database does not contain the same proofs, counters, operations, and mints as the legacy database.",
      );
    }
  } finally {
    destination.close();
  }
}

/**
 * Copy a legacy cocod wallet into the canonical routstrd wallet directory.
 * The staging directory is renamed atomically, so the canonical path is never
 * exposed with only one of its two required files.
 */
export async function migrateLegacyWallet(
  options: WalletMigrationOptions = {},
): Promise<WalletMigrationResult> {
  const targetDir = options.walletDir || walletDir();
  const sourceDir = options.legacyDir || legacyCocodDir();
  const sourceConfig = join(sourceDir, "config.json");
  const sourceDb = join(sourceDir, "coco.db");
  const sourceWal = `${sourceDb}-wal`;
  const sourceShm = `${sourceDb}-shm`;
  const classification = classifyWalletMigration(targetDir, sourceDir);
  switch (classification.kind) {
    case "fresh":
      return { status: "fresh" };
    case "already-current":
      return { status: "already-current" };
    case "migrate":
      break;
    case "conflict":
      throw new WalletMigrationConflictError(
        summarizeWalletDirectory(targetDir, "canonical"),
        summarizeWalletDirectory(sourceDir, "legacy"),
      );
    case "orphaned-sidecars":
      throw new Error(
        `Cannot migrate wallet: ${sourceDir} contains SQLite sidecar files without coco.db. ` +
          "Restore the matching main database before migration.",
      );
    case "database-only":
      throw new Error(
        `Cannot migrate wallet: ${targetDir} is ${classification.targetState} and ${sourceDir} is ${classification.sourceState}. ` +
          "A coco.db without config.json cannot be opened; restore the matching config first.",
      );
  }

  await options.assertLegacyStopped?.();
  const releaseLegacyLock = await options.acquireLegacyLock?.();
  const stagingDir = join(
    dirname(targetDir),
    `.${targetDir.split(/[\\/]/).at(-1) || "wallet"}.staging-${process.pid}-${Date.now()}`,
  );

  try {
    // Recheck after claiming the exclusion lock to close the probe/claim race.
    await options.assertLegacyStopped?.();
    mkdirSync(dirname(targetDir), { recursive: true, mode: 0o700 });
    mkdirSync(stagingDir, { mode: 0o700 });
    const stagedConfig = join(stagingDir, "config.json");
    const stagedDb = join(stagingDir, "coco.db");
    copyFileSync(sourceConfig, stagedConfig);
    chmodSync(stagedConfig, 0o600);
    const hasSourceDb = existsSync(sourceDb);
    if (hasSourceDb) {
      // A SQLite WAL is part of the logical database. Raw-copying coco.db can
      // silently omit proofs and counters that have not yet been checkpointed.
      snapshotDatabase(sourceDb, stagedDb);
      chmodSync(stagedDb, 0o600);
    }

    if (statSync(stagedConfig).size !== statSync(sourceConfig).size) {
      throw new Error("Cannot migrate wallet: staged config failed size validation.");
    }

    renameSync(stagingDir, targetDir);
  } catch (error) {
    rmSync(stagingDir, { recursive: true, force: true });
    throw error;
  } finally {
    releaseLegacyLock?.();
  }

  // Preserve the complete legacy SQLite file set for manual recovery instead
  // of deleting the only rollback copy immediately after migration.
  const cleanupWarnings: string[] = [];
  const sourceFiles = [sourceConfig, sourceDb, sourceWal, sourceShm].filter(existsSync);
  if (sourceFiles.length > 0) {
    const archiveDir = join(sourceDir, `wallet-migrated-${Date.now()}`);
    try {
      mkdirSync(archiveDir, { mode: 0o700 });
      for (const path of sourceFiles) renameSync(path, join(archiveDir, basename(path)));
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      cleanupWarnings.push(`Could not archive legacy wallet files: ${message}`);
    }
  }

  return { status: "migrated", from: sourceDir, to: targetDir, cleanupWarnings };
}
