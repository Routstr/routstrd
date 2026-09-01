const HOME = process.env.HOME || process.env.USERPROFILE || "";

export const CONFIG_DIR = process.env.ROUTSTRD_DIR || `${HOME}/.routstrd`;
export const SOCKET_PATH = process.env.ROUTSTRD_SOCKET || `${CONFIG_DIR}/routstrd.sock`;
export const PID_FILE = process.env.ROUTSTRD_PID || `${CONFIG_DIR}/routstrd.pid`;
export const DB_PATH = `${CONFIG_DIR}/routstr.db`;
export const CONFIG_FILE = `${CONFIG_DIR}/config.json`;
export const MANAGED_CONFIG_FILE = process.env.ROUTSTRD_CONFIG_FILE;
export const SECRET_CONFIG_FILE = process.env.ROUTSTRD_SECRET_CONFIG_FILE;
export const LOGS_DIR = `${CONFIG_DIR}/logs`;
export const REQUEST_RESPONSE_LOGS_DIR = `${CONFIG_DIR}/request-response-logs`;

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
  host: string;
  provider: string | null;
  cocodPath: string | null;
  mode?: "xcashu" | "apikeys";
  /** Raw upstream request/response logging. Disabled by default because logs can contain sensitive prompts, outputs, and auth/payment headers. */
  requestResponseLogging?: {
    /** Enable raw request/response file logging. */
    enabled?: boolean;
    /** Root log directory. SDK writes requests/*.json and responses/*.jsonl below this directory. Defaults to ~/.routstrd/request-response-logs. */
    dir?: string;
  };
  daemonUrl?: string;
  /** URL of the auth proxy (routstrd-auth) for management endpoints (npubs, clients, usage).
   * Defaults to daemonUrl or localhost:{port} if not set. */
  authUrl?: string;
  nsec?: string;
  /** Nostr hex pubkey for routstr review/audit events (kind 38425). */
  routstrPubkey?: string;
  /** Nostr hex pubkey for the routstr-21 model list only (kind 38423). Falls back to routstrPubkey. */
  routstrModelsPubkey?: string;
  /** Nostr relay URLs for provider/model discovery (kinds 38421/38423/38425).
   * When unset, each method uses its own built-in defaults. */
  relays?: string[];
  /** NWC integration configuration */
  nwc?: NwcConfig;
  /** Cashu wallet startup integrations. */
  wallet?: {
    /** Add the built-in default mint when a fresh wallet has no trusted mints. */
    initializeDefaultMint?: boolean;
    /** Register the npubx.cash NPC plugin. */
    enableNpc?: boolean;
  };
  /**
   * Default max_tokens (chat/completions) and max_output_tokens (responses)
   * injected into proxied requests when the client does not supply one.
   * Caps the completion budget the SDK prices against (completion × maxTokens)
   * instead of the provider's worst-case max_completion_cost. Set to 0 to
   * disable injection and always forward the client's value as-is.
   */
  maxTokens?: number;
}

export const DEFAULT_CONFIG: RoutstrdConfig = {
  port: 8008,
  host: "127.0.0.1",
  provider: null,
  cocodPath: null,
  mode: "apikeys",
  maxTokens: 64000,
};
