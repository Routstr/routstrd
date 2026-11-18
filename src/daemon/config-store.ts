import { mkdir } from "fs/promises";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from "fs";
import {
  CONFIG_DIR,
  CONFIG_FILE,
  DEFAULT_CONFIG,
  type RoutstrdConfig,
} from "../utils/config";
import { logger } from "../utils/logger";

export const REQUESTS_DIR = `${CONFIG_DIR}/requests`;

// The daemon config holds spend-capable credentials (the operator `nsec` and
// the NWC connection string), so the directory and file permissions must match
// the wallet seed handling (0700/0600), not the umask default (0755/0644).

function chmodIgnoreErrors(path: string, mode: number): void {
  try {
    chmodSync(path, mode);
  } catch {
    // Best effort on filesystems that do not support POSIX modes.
  }
}

/** Create the config directories (0700), correcting existing installs too. */
export function ensureDirsSync(): void {
  try {
    mkdirSync(CONFIG_DIR, { recursive: true, mode: 0o700 });
  } catch {
    // Directory may already exist
  }
  chmodSync(CONFIG_DIR, 0o700);

  try {
    mkdirSync(REQUESTS_DIR, { recursive: true, mode: 0o700 });
  } catch {
    // Directory may already exist
  }
  chmodSync(REQUESTS_DIR, 0o700);
}

export async function ensureDirs(): Promise<void> {
  try {
    await mkdir(CONFIG_DIR, { recursive: true, mode: 0o700 });
  } catch {
    // Directory may already exist
  }
  chmodSync(CONFIG_DIR, 0o700);

  try {
    await mkdir(REQUESTS_DIR, { recursive: true, mode: 0o700 });
  } catch {
    // Directory may already exist
  }
  chmodSync(REQUESTS_DIR, 0o700);
}

function repairConfigPermissions(): void {
  if (existsSync(CONFIG_FILE)) {
    chmodIgnoreErrors(CONFIG_FILE, 0o600);
  }
}

/**
 * Environment-variable overrides take precedence over config.json so operators
 * can set values via Cloudron/docker env (e.g. ROUTSTRD_MODELS_PUBKEY) without
 * hand-editing the config file.
 */
function envConfigOverrides(): Partial<RoutstrdConfig> {
  const overrides: Partial<RoutstrdConfig> = {};
  if (process.env.ROUTSTRD_MODELS_PUBKEY) {
    overrides.routstrModelsPubkey = process.env.ROUTSTRD_MODELS_PUBKEY;
  }
  return overrides;
}

export async function loadDaemonConfig(): Promise<RoutstrdConfig> {
  try {
    if (existsSync(CONFIG_FILE)) {
      repairConfigPermissions();
      const content = await Bun.file(CONFIG_FILE).text();
      return { ...DEFAULT_CONFIG, ...JSON.parse(content), ...envConfigOverrides() };
    }
  } catch (error) {
    logger.error("Failed to load config:", error);
  }
  return { ...DEFAULT_CONFIG, ...envConfigOverrides() };
}

export function loadDaemonConfigSync(): RoutstrdConfig {
  try {
    if (existsSync(CONFIG_FILE)) {
      repairConfigPermissions();
      const content = readFileSync(CONFIG_FILE, "utf-8");
      return { ...DEFAULT_CONFIG, ...JSON.parse(content), ...envConfigOverrides() };
    }
  } catch (error) {
    logger.error("Failed to load config:", error);
  }
  return { ...DEFAULT_CONFIG, ...envConfigOverrides() };
}

/**
 * Persist the daemon config atomically with owner-only permissions, mirroring
 * the wallet config writer (saveConfig in wallet/coco-client.ts): write a
 * 0600 temp file, then rename over the target. Synchronous so callers get
 * error propagation instead of silently dropping credential updates.
 */
export function saveDaemonConfig(config: RoutstrdConfig): void {
  ensureDirsSync();
  const temporaryFile = `${CONFIG_FILE}.${process.pid}.tmp`;
  try {
    writeFileSync(temporaryFile, JSON.stringify(config, null, 2), {
      mode: 0o600,
    });
    renameSync(temporaryFile, CONFIG_FILE);
  } catch (error) {
    try {
      unlinkSync(temporaryFile);
    } catch {
      // The temporary file may not have been created.
    }
    throw error;
  }
  // renameSync preserves the temp file's mode, but chmod anyway so an
  // existing over-permissive file is corrected even on exotic filesystems.
  chmodIgnoreErrors(CONFIG_FILE, 0o600);
}
