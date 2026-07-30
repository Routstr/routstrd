import type { UsageTrackingEntry } from "../../daemon/types.ts";
import { callDaemon, isDaemonRunning } from "../../utils/daemon-client.ts";
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
  error?: string;
}

export async function fetchStatus(): Promise<StatusInfo | null> {
  try {
    const result = await callDaemon("/status");
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
