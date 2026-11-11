const HOME = process.env.HOME || process.env.USERPROFILE || "";

export const CONFIG_DIR = process.env.ROUTSTRD_DIR || `${HOME}/.routstrd`;
export const SOCKET_PATH = process.env.ROUTSTRD_SOCKET || `${CONFIG_DIR}/routstrd.sock`;
export const PID_FILE = process.env.ROUTSTRD_PID || `${CONFIG_DIR}/routstrd.pid`;
export const DB_PATH = `${CONFIG_DIR}/routstr.db`;
export const CONFIG_FILE = `${CONFIG_DIR}/config.json`;
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

/**
 * Scheduled background refresh job (Nostr events, routstr21 models, and client
 * integrations). Missing values mean "enabled" with the default interval, so
 * older config files keep working unchanged.
 */
export interface AutoRefreshConfig {
  /** Run the recurring refresh job. Defaults to true. */
  enabled?: boolean;
  /** Milliseconds between refreshes. Defaults to 21 minutes. */
  intervalMs?: number;
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
  mode?: "xcashu" | "apikeys";
  /**
   * Opt into SDK automatic model-path selection for DeepSeek V4.1 Flash.
   * Disabled by default. Change it through `routstrd models auto-model-path`
   * (`POST /settings/auto-model-path`): the daemon applies it to the next
   * routed request. A hand-edited file needs a daemon restart.
   */
  autoModelPath?: boolean;
  /**
   * Confidential upstream: requests sent with `x-routstr-verify: confidential`
   * run with the daemon as the TLS client of the node's provider, so the node
   * never sees the prompt or the response. Off unless `enabled`.
   */
  confidentialUpstream?: {
    enabled?: boolean;
    /** Upstream TLS hostnames trusted for the other end (exact, `*.x`, `**.x`). */
    trusted_hosts?: string[];
    /**
     * Node signing keys (hex or npub) whose offers are accepted. When unset,
     * the keys that announced the node's URL on Nostr (kind 38421) are used,
     * for https and onion nodes only.
     */
    node_pubkeys?: string[];
    /** Set false to require `node_pubkeys` (no pin from the Nostr announcement). */
    pin_from_announcement?: boolean;
    /** `cu-prover` binary (else CU_PROVER_BIN / CU_PROVER / PATH). */
    prover_path?: string;
    /**
     * Development only: allow plain-http nodes that are neither loopback nor
     * onion services. The node credential then travels unencrypted.
     */
    allow_insecure_transport?: boolean;
    /**
     * Traffic-driven pre-warming of protocol v2 sessions (the 2PC
     * preprocessing runs before a request arrives). Only keys with recent
     * traffic keep armed sessions; an idle daemon keeps none.
     */
    prewarm?: {
      /** Default true. */
      enabled?: boolean;
      /** A key idle this long keeps no armed sessions (default 10). */
      activityWindowMinutes?: number;
      /** Armed sessions per (node, model, max_tokens) (default 6). */
      maxPerKey?: number;
      /** Armed sessions in total (default 6). */
      maxTotal?: number;
      /** Retire an armed session this old (default 480; the node ends it at 600). */
      maxAgeSeconds?: number;
      /**
       * Arm only for nodes whose abandon fee (what a session that is never
       * used costs, `abandon_fee_msat` in the signed offer) is at most this
       * many msats (default 5000; 0 never pre-warms a node that charges one).
       * For such a node at most `maxArmedWithFee` sessions are armed.
       */
      maxSessionFeeMsat?: number;
      /**
       * Armed sessions in total for nodes that charge an abandon fee
       * (default 6, for parallel agents): each one that ends unused costs the fee.
       */
      maxArmedWithFee?: number;
      /**
       * Arm only while the credential's available balance on the node is at
       * least this many times one session's reservation (default 2: the new
       * arm plus one cold request). The automatic top-up keeps the key at
       * this multiple + 1.4 while pre-warming is on (the request in flight
       * plus the next arm).
       */
      fundsHeadroom?: number;
    };
    /**
     * `http: 2` sessions (protocol v3, option A): with a node whose signed
     * offer lists them, chat requests run on HTTP/2 connections to the
     * provider that are kept open and reused, one two-party handshake per
     * connection instead of one per request. On by default; other nodes,
     * image requests and `xcashu` mode use the v2 flow (and `prewarm`).
     */
    http2?: {
      /** Default true. `false` keeps every request on the v2 flow. */
      enabled?: boolean;
      /**
       * Which requests may share a connection, and so be linked to each
       * other by the provider and the node: `credential` (default: all
       * requests to one node with one credential), `model` (only requests
       * for the same model), `none` (a connection per request).
       */
      reuse?: "credential" | "model" | "none";
      /** Open connections per node and credential (default 4): overlapping requests served without waiting. */
      maxConnections?: number;
      /** Open connections in total (default 8). */
      maxTotal?: number;
      /** Close a connection idle this long (default: 20 s before the node's own limit, 300 s). */
      maxIdleSeconds?: number;
      /** Close a connection after this many requests (default: the node's limit, 100). */
      maxRequestsPerConnection?: number;
    };
  };
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
  /** Scheduled refresh job settings (see AutoRefreshConfig). */
  autoRefresh?: AutoRefreshConfig;
  /**
   * Default max_completion_tokens (chat/completions) and max_output_tokens
   * (responses) injected into proxied requests when the client does not
   * supply one. Caps the completion budget the SDK prices against
   * (completion × maxTokens) instead of the provider's worst-case
   * max_completion_cost. Set to 0 to disable injection and always forward the
   * client's value as-is.
   */
  maxTokens?: number;
  /** Automatic update checks, startup prompts and notices. Defaults to true. */
  updateCheck?: boolean;
}

export const DEFAULT_CONFIG: RoutstrdConfig = {
  port: 8008,
  host: "127.0.0.1",
  provider: null,
  mode: "apikeys",
  autoModelPath: false,
  updateCheck: true,
  maxTokens: 64000,
};
