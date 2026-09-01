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
  MANAGED_CONFIG_FILE,
  SECRET_CONFIG_FILE,
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

type JsonObject = Record<string, unknown>;

function isJsonObject(value: unknown): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function mergeConfig(...values: JsonObject[]): RoutstrdConfig {
  const merged: JsonObject = {};
  for (const value of values) {
    for (const [key, next] of Object.entries(value)) {
      if (key === "__proto__" || key === "constructor" || key === "prototype") continue;
      const current = merged[key];
      merged[key] = isJsonObject(current) && isJsonObject(next)
        ? mergeConfig(current, next)
        : next;
    }
  }
  return merged as unknown as RoutstrdConfig;
}

function readConfigFileSync(path?: string): JsonObject {
  if (!path || !existsSync(path)) return {};
  const parsed = JSON.parse(readFileSync(path, "utf-8")) as unknown;
  if (!isJsonObject(parsed)) throw new Error(`Configuration at ${path} must be a JSON object`);
  return parsed;
}

function removeManagedValues(value: JsonObject, managed: JsonObject): JsonObject {
  const result: JsonObject = {};
  for (const [key, current] of Object.entries(value)) {
    if (!(key in managed)) {
      result[key] = current;
      continue;
    }
    const managedValue = managed[key];
    if (isJsonObject(current) && isJsonObject(managedValue)) {
      const nested = removeManagedValues(current, managedValue);
      if (Object.keys(nested).length > 0) result[key] = nested;
    }
  }
  return result;
}

function configLayers(): {
  runtime: JsonObject;
  managed: JsonObject;
  secret: JsonObject;
  environment: JsonObject;
} {
  return {
    runtime: readConfigFileSync(CONFIG_FILE),
    managed: readConfigFileSync(MANAGED_CONFIG_FILE),
    secret: readConfigFileSync(SECRET_CONFIG_FILE),
    environment: envConfigOverrides() as JsonObject,
  };
}

export async function loadDaemonConfig(): Promise<RoutstrdConfig> {
  try {
    repairConfigPermissions();
    const { runtime, managed, secret, environment } = configLayers();
    return mergeConfig(DEFAULT_CONFIG as unknown as JsonObject, runtime, managed, secret, environment);
  } catch (error) {
    logger.error("Failed to load config:", error);
  }
  return mergeConfig(DEFAULT_CONFIG as unknown as JsonObject, envConfigOverrides() as JsonObject);
}

export function loadDaemonConfigSync(): RoutstrdConfig {
  try {
    repairConfigPermissions();
    const { runtime, managed, secret, environment } = configLayers();
    return mergeConfig(DEFAULT_CONFIG as unknown as JsonObject, runtime, managed, secret, environment);
  } catch (error) {
    logger.error("Failed to load config:", error);
  }
  return mergeConfig(DEFAULT_CONFIG as unknown as JsonObject, envConfigOverrides() as JsonObject);
}

/**
 * Persist the daemon config atomically with owner-only permissions, mirroring
 * the wallet config writer (saveConfig in wallet/coco-client.ts): write a
 * 0600 temp file, then rename over the target. Synchronous so callers get
 * error propagation instead of silently dropping credential updates.
 */
export function saveDaemonConfig(config: RoutstrdConfig): void {
  ensureDirsSync();
  const managed = mergeConfig(
    readConfigFileSync(MANAGED_CONFIG_FILE),
    readConfigFileSync(SECRET_CONFIG_FILE),
    envConfigOverrides() as JsonObject,
  ) as unknown as JsonObject;
  const runtimeConfig = removeManagedValues(config as unknown as JsonObject, managed);
  const temporaryFile = `${CONFIG_FILE}.${process.pid}.tmp`;
  try {
    writeFileSync(temporaryFile, JSON.stringify(runtimeConfig, null, 2), {
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
