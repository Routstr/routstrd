import {
  chmodSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  unlinkSync,
} from "fs";
import { dirname, join } from "path";
import { legacyCocodDir, walletDir } from "./paths";

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

type WalletState = "absent" | "database-only" | "initialized";

function state(configPath: string, dbPath: string): WalletState {
  const hasConfig = existsSync(configPath);
  const hasDb = existsSync(dbPath);
  if (hasConfig) return "initialized";
  if (hasDb) return "database-only";
  return "absent";
}

function filesEqual(left: string, right: string): boolean {
  if (!existsSync(left) || !existsSync(right)) return false;
  if (statSync(left).size !== statSync(right).size) return false;
  return readFileSync(left).equals(readFileSync(right));
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
  const targetConfig = join(targetDir, "config.json");
  const targetDb = join(targetDir, "coco.db");
  const sourceConfig = join(sourceDir, "config.json");
  const sourceDb = join(sourceDir, "coco.db");
  const targetState = state(targetConfig, targetDb);
  const sourceState = state(sourceConfig, sourceDb);

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
    if (configsMatch && databasesMatch) return { status: "already-current" };
    throw new Error(
      `Cannot migrate wallet: both ${targetDir} and ${sourceDir} contain different wallet data. ` +
        "Refusing to choose a mnemonic or merge wallet databases automatically.",
    );
  }
  if (targetState === "initialized") return { status: "already-current" };
  if (targetState === "database-only" || sourceState === "database-only") {
    throw new Error(
      `Cannot migrate wallet: ${targetDir} is ${targetState} and ${sourceDir} is ${sourceState}. ` +
        "A coco.db without config.json cannot be opened; restore the matching config first.",
    );
  }
  if (sourceState === "absent") return { status: "fresh" };

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
      copyFileSync(sourceDb, stagedDb);
      chmodSync(stagedDb, 0o600);
    }

    if (
      statSync(stagedConfig).size !== statSync(sourceConfig).size ||
      (hasSourceDb && statSync(stagedDb).size !== statSync(sourceDb).size)
    ) {
      throw new Error("Cannot migrate wallet: staged files failed size validation.");
    }

    renameSync(stagingDir, targetDir);
  } catch (error) {
    rmSync(stagingDir, { recursive: true, force: true });
    throw error;
  } finally {
    releaseLegacyLock?.();
  }

  const cleanupWarnings: string[] = [];
  for (const path of [sourceConfig, sourceDb]) {
    if (!existsSync(path)) continue;
    try {
      unlinkSync(path);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      cleanupWarnings.push(`Could not remove legacy wallet file ${path}: ${message}`);
    }
  }

  return { status: "migrated", from: sourceDir, to: targetDir, cleanupWarnings };
}
