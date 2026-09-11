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
