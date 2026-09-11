import type { UsageTrackingEntry } from "../../daemon/types.ts";
import {
  callAuth,
  callDaemon,
  getDaemonBaseUrl,
  isDaemonRunning,
  loadConfig,
} from "../../utils/daemon-client.ts";
import type { UsageStats, UsageSummary } from "./types.ts";

export { isDaemonRunning };

export interface BalanceKey {
  id: string;
  name: string;
  balance: number;
}

export interface BalanceInfo {
  keys: BalanceKey[];
  total: number;
  unit: "sat";
  apikeysCalled: number;
}

export interface StatusInfo {
  daemon: string;
  wallet: string;
  mode: "xcashu" | "apikeys";
  /** URL the TUI is connected through (local bind or remote daemonUrl). */
  url?: string;
  error?: string;
}

export async function fetchStatus(): Promise<StatusInfo | null> {
  try {
    const [result, config] = await Promise.all([
      callDaemon("/status"),
      loadConfig(),
    ]);
    if (result.error) return null;

    const output = result.output as {
      daemon?: string;
      wallet?: string;
      mode?: "xcashu" | "apikeys";
      error?: string;
    };

    return {
      daemon: output?.daemon || "unknown",
      wallet: output?.wallet || "unknown",
      mode: output?.mode || "apikeys",
      url: getDaemonBaseUrl(config),
      error: output?.error,
    };
  } catch {
    return null;
  }
}

export async function fetchBalance(): Promise<BalanceInfo | null> {
  try {
    const result = await callDaemon("/keys/balance");
    if (result.error) return null;

    const output = result.output as {
      keys?: BalanceKey[];
      total?: number;
      unit?: string;
      apikeysCalled?: number;
    };

    return {
      keys: output?.keys || [],
      total: output?.total || 0,
      unit: (output?.unit as "sat") || "sat",
      apikeysCalled: output?.apikeysCalled || 0,
    };
  } catch {
    return null;
  }
}

export async function fetchUsageSummary(): Promise<UsageStats | null> {
  try {
    const tz = new Date().getTimezoneOffset();
    const result = await callDaemon(`/usage/summary?tz=${tz}`);
    if (result.error) return null;

    const summary = result.output as UsageSummary | undefined;
    if (!summary || typeof summary.totals !== "object") return null;

    return {
      entries: summary.recent,
      totalEntries: summary.totals.requests,
      totalSatsCost: summary.totals.satsCost,
      recentSatsCost: summary.totals.satsCost,
      limit: 50,
      summary,
    };
  } catch {
    return null;
  }
}

export function formatTime(timestamp: number): string {
  const d = new Date(timestamp);
  const p = (n: number) => String(n).padStart(2, "0");
  return `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}

export function formatNumber(n: number): string {
  if (n >= 1_000_000) return (n / 1_000_000).toFixed(1) + "M";
  if (n >= 1_000) return (n / 1_000).toFixed(1) + "K";
  return n.toString();
}

// ─── Client / Npub helpers ────────────────────────────────────────────

export interface ClientInfo {
  clientId: string;
  name: string;
  ownerNpub?: string;
}

export async function fetchClients(): Promise<ClientInfo[]> {
  try {
    const result = await callDaemon("/clients");
    if (result.error) return [];

    const output = result.output as {
      clients?: Array<{ id: string; name: string; ownerNpub?: string }>;
    };

    return (output?.clients || []).map((c) => ({
      clientId: c.id,
      name: c.name,
      ownerNpub: c.ownerNpub,
    }));
  } catch {
    return [];
  }
}

export function hasAnyNpubs(clients: ClientInfo[]): boolean {
  return clients.some((c) => !!c.ownerNpub);
}

/** A configured npub as returned by the auth proxy (`/npubs`). */
export interface NpubEntry {
  npub: string;
  name: string | null;
  role: string;
}

/**
 * Fetch the configured npubs (with their display names and roles) from the
 * auth proxy. Returns an empty list when the endpoint is unavailable — e.g. a
 * local daemon that doesn't route `/npubs` — so the TUI degrades gracefully.
 */
export async function fetchNpubs(): Promise<NpubEntry[]> {
  try {
    const result = await callAuth("/npubs");
    if (result.error) return [];

    // Handle both wrapped { output: { npubs } } and direct { npubs } responses.
    const direct = (result as { npubs?: NpubEntry[] }).npubs;
    const wrapped = (result.output as { npubs?: NpubEntry[] } | undefined)?.npubs;
    return direct ?? wrapped ?? [];
  } catch {
    return [];
  }
}

/** Number of trailing npub characters the auth proxy folds into a client id. */
export const NPUB_SUFFIX_LENGTH = 7;

/**
 * Lookup tables for turning a raw usage `client` id (e.g.
 * `claude-code-a1b2c3d`) back into a human label (e.g. `Alice (claude-code)`).
 *
 * All maps are empty in local mode, so {@link resolveClientLabel} falls back to
 * the raw id with no behaviour change there.
 */
export interface ClientNaming {
  /** Configured npubs (names + roles) from the auth proxy. */
  npubs: NpubEntry[];
  /** bare clientId -> owner npub, from `GET /clients`. */
  ownersByClientId: Map<string, string>;
  /** npub -> display name (null when unset). */
  npubNames: Map<string, string | null>;
  /** trailing npub suffix -> npub. */
  npubsBySuffix: Map<string, string>;
}

export function buildClientNaming(clients: ClientInfo[], npubs: NpubEntry[]): ClientNaming {
  const ownersByClientId = new Map<string, string>();
  for (const c of clients) {
    if (c.ownerNpub) ownersByClientId.set(c.clientId, c.ownerNpub);
  }

  const npubNames = new Map<string, string | null>();
  const npubsBySuffix = new Map<string, string>();
  const remember = (npub: string) => npubsBySuffix.set(npub.slice(-NPUB_SUFFIX_LENGTH), npub);

  for (const n of npubs) {
    npubNames.set(n.npub, n.name ?? null);
    remember(n.npub);
  }
  // `GET /clients` also carries owner npubs, which covers entries whose owner
  // isn't present in the (possibly filtered) `/npubs` response.
  for (const owner of ownersByClientId.values()) remember(owner);

  return { npubs, ownersByClientId, npubNames, npubsBySuffix };
}

/** Configured display name for an npub, or null when unset/blank. */
function npubDisplayName(naming: ClientNaming, npub: string): string | null {
  const name = naming.npubNames.get(npub)?.trim();
  return name && name.length > 0 ? name : null;
}

/** `Alice (claude-code)` when the owner has a name, else the bare client id. */
function formatClientLabel(naming: ClientNaming, bareId: string, ownerNpub: string): string {
  const name = npubDisplayName(naming, ownerNpub);
  return name ? `${name} (${bareId})` : bareId;
}

/**
 * Render a usage entry's `client` value as `Name (client-id)`, where `Name` is
 * the owner npub's display name and the `-<npub tail>` suffix is stripped.
 * Falls back to the raw id when no owner/name can be resolved (local mode).
 */
export function resolveClientLabel(clientId: string | undefined, naming: ClientNaming): string {
  const raw = clientId && clientId.length > 0 ? clientId : "unknown";

  // Exact match: the raw id is a known bare clientId or its suffixed form.
  for (const [bareId, ownerNpub] of naming.ownersByClientId) {
    const suffixed = `${bareId}-${ownerNpub.slice(-NPUB_SUFFIX_LENGTH)}`;
    if (raw !== bareId && raw !== suffixed) continue;
    return formatClientLabel(naming, bareId, ownerNpub);
  }

  // Fallback: strip a trailing `-<npub tail>` that matches a known npub.
  for (const [suffix, npub] of naming.npubsBySuffix) {
    const marker = `-${suffix}`;
    if (raw.length <= marker.length || !raw.endsWith(marker)) continue;
    return formatClientLabel(naming, raw.slice(0, -marker.length), npub);
  }

  return raw;
}

export function emptyClientNaming(): ClientNaming {
  return buildClientNaming([], []);
}
