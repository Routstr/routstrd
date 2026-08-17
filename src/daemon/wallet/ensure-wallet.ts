import { mkdirSync } from "fs";
import { dirname } from "path";
import {
  assertLegacyCocodNotRunning,
  claimLegacyCocodPidFile,
  stopLegacyCocod,
} from "./coco-client";
import { migrateLegacyWallet } from "./migration";
import { legacyCocodPidPath, legacyCocodSocketPath } from "./paths";
import { initializeWallet } from "./wallet-config";

export interface EnsureLocalWalletResult {
  /** True when a legacy cocod wallet was migrated into the canonical directory. */
  migrated: boolean;
  /** True when this call created a fresh wallet with a new mnemonic. */
  created: boolean;
}

export interface EnsureLocalWalletOptions {
  log?: (message: string) => void;
  warn?: (message: string) => void;
}

/**
 * Guarantee that the canonical routstrd wallet exists, preferring an existing
 * mnemonic over generating a new one:
 *
 * 1. Stop/confine any legacy external cocod process.
 * 2. Migrate a legacy cocod wallet when present — its mnemonic always wins
 *    over a freshly generated one, and a divergent pre-existing canonical
 *    wallet aborts the migration loudly instead of shadowing funds.
 * 3. Otherwise create a fresh wallet with a new BIP-39 mnemonic.
 *
 * Both `init` and `remote` run this before deriving the operator Nostr
 * identity, so the nsec is recoverable from the wallet backup regardless of
 * which command ran first.
 */
export async function ensureLocalWallet(
  options: EnsureLocalWalletOptions = {},
): Promise<EnsureLocalWalletResult> {
  const log = options.log ?? console.log;
  const warn = options.warn ?? console.warn;

  await stopLegacyCocod();

  let migrationLockOwner: number | undefined;
  const migration = await migrateLegacyWallet({
    assertLegacyStopped: () =>
      assertLegacyCocodNotRunning({
        socketPath: legacyCocodSocketPath(),
        pidFilePath: legacyCocodPidPath(),
        ignorePid: migrationLockOwner,
      }),
    acquireLegacyLock: () => {
      mkdirSync(dirname(legacyCocodPidPath()), {
        recursive: true,
        mode: 0o700,
      });
      const release = claimLegacyCocodPidFile({
        pidFilePath: legacyCocodPidPath(),
      });
      migrationLockOwner = process.pid;
      return () => {
        migrationLockOwner = undefined;
        release();
      };
    },
  });
  if (migration.status === "migrated") {
    log(`Migrated wallet from ${migration.from} to ${migration.to}.`);
    for (const warning of migration.cleanupWarnings) warn(warning);
  }

  const created = initializeWallet(undefined, log);
  return { migrated: migration.status === "migrated", created };
}
