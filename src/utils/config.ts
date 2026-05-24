const HOME = process.env.HOME || process.env.USERPROFILE || "";

export const CONFIG_DIR = process.env.ROUTSTRD_DIR || `${HOME}/.routstrd`;
export const SOCKET_PATH = process.env.ROUTSTRD_SOCKET || `${CONFIG_DIR}/routstrd.sock`;
export const PID_FILE = process.env.ROUTSTRD_PID || `${CONFIG_DIR}/routstrd.pid`;
export const DB_PATH = `${CONFIG_DIR}/routstr.db`;
export const CONFIG_FILE = `${CONFIG_DIR}/config.json`;
export const LOGS_DIR = `${CONFIG_DIR}/logs`;

/** NWC auto-refill configuration */
export interface NwcAutoRefillConfig {
  /** Whether auto-refill is enabled */
  enabled: boolean;
  /** Refill when Cashu balance drops below this many sats */
  threshold: number;
  /** Refill this many sats at a time */
  amount: number;
  /** Minimum time between refills in milliseconds */
  cooldownMs: number;
}

/** NWC configuration section */
export interface NwcConfig {
  /** NWC mode: "funding_source" = NWC funds the cocod Cashu wallet */
  mode: "funding_source" | "standalone";
  /** NWC connection string (nostr+walletconnect://...) */
  connectionString?: string;
  /** Auto-refill settings */
  autoRefill?: NwcAutoRefillConfig;
}

export interface RoutstrdConfig {
  port: number;
  provider: string | null;
  cocodPath: string | null;
  mode?: "xcashu" | "apikeys";
  daemonUrl?: string;
  nsec?: string;
  /** Nostr hex pubkey for routstr review/model events (kind 38425/38423). */
  routstrPubkey?: string;
  /** NWC integration configuration */
  nwc?: NwcConfig;
}

export const DEFAULT_CONFIG: RoutstrdConfig = {
  port: 8008,
  provider: null,
  cocodPath: null,
  mode: "apikeys",
};
