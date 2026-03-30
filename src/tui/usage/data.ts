import type { UsageTrackingEntry } from "../../daemon/types.ts";
import { callDaemon, isDaemonRunning } from "../../cli-shared.ts";
import type { ClientStats, DayStats, ModelStats, ProviderStats, UsageStats } from "./types.ts";

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
    const running = await isDaemonRunning();
    if (!running) return null;

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
    const running = await isDaemonRunning();
    if (!running) return null;

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

export async function fetchUsage(limit = 10000): Promise<UsageStats | null> {
  try {
    const running = await isDaemonRunning();
    if (!running) return null;

    const result = await callDaemon(`/usage?limit=${limit}`);
    if (result.error) return null;

    const output = result.output as {
      entries?: UsageTrackingEntry[];
      totalEntries?: number;
      totalSatsCost?: number;
      recentSatsCost?: number;
      limit?: number;
    };

    return {
      entries: output?.entries || [],
      totalEntries: output?.totalEntries || 0,
      totalSatsCost: output?.totalSatsCost || 0,
      recentSatsCost: output?.recentSatsCost || 0,
      limit: output?.limit || limit,
    };
  } catch {
    return null;
  }
}

export function getTodayStart(): number {
  const now = new Date();
  return new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
}

export function formatDate(timestamp: number): string {
  return new Date(timestamp).toISOString().split("T")[0] ?? "";
}

export function formatTime(timestamp: number): string {
  return new Date(timestamp).toISOString().split("T")[1]?.slice(0, 8) ?? "";
}

export function formatNumber(n: number): string {
  if (n >= 1_000_000) return (n / 1_000_000).toFixed(1) + "M";
  if (n >= 1_000) return (n / 1_000).toFixed(1) + "K";
  return n.toString();
}

export function getDayStats(entries: UsageTrackingEntry[]): Map<string, DayStats> {
  const days = new Map<string, DayStats>();
  for (const entry of entries) {
    const date = formatDate(entry.timestamp);
    const existing = days.get(date) || { date, requests: 0, satsCost: 0, promptTokens: 0, completionTokens: 0, totalTokens: 0 };
    days.set(date, {
      ...existing,
      requests: existing.requests + 1,
      satsCost: existing.satsCost + entry.satsCost,
      promptTokens: existing.promptTokens + entry.promptTokens,
      completionTokens: existing.completionTokens + entry.completionTokens,
      totalTokens: existing.totalTokens + entry.totalTokens,
    });
  }
  return days;
}

export function getHourlyToday(entries: UsageTrackingEntry[]): Map<number, DayStats> {
  const todayStart = getTodayStart();
  const hours = new Map<number, DayStats>();
  for (const entry of entries) {
    if (entry.timestamp < todayStart) continue;
    const hour = new Date(entry.timestamp).getHours();
    const existing = hours.get(hour) || {
      date: formatDate(entry.timestamp), requests: 0, satsCost: 0, promptTokens: 0, completionTokens: 0, totalTokens: 0,
    };
    hours.set(hour, {
      ...existing,
      requests: existing.requests + 1,
      satsCost: existing.satsCost + entry.satsCost,
      promptTokens: existing.promptTokens + entry.promptTokens,
      completionTokens: existing.completionTokens + entry.completionTokens,
      totalTokens: existing.totalTokens + entry.totalTokens,
    });
  }
  return hours;
}

export function getModelStats(entries: UsageTrackingEntry[]): ModelStats[] {
  const models = new Map<string, ModelStats>();
  for (const entry of entries) {
    const existing = models.get(entry.modelId) || {
      modelId: entry.modelId, requests: 0, satsCost: 0, promptTokens: 0, completionTokens: 0, totalTokens: 0,
    };
    models.set(entry.modelId, {
      ...existing,
      requests: existing.requests + 1,
      satsCost: existing.satsCost + entry.satsCost,
      promptTokens: existing.promptTokens + entry.promptTokens,
      completionTokens: existing.completionTokens + entry.completionTokens,
      totalTokens: existing.totalTokens + entry.totalTokens,
    });
  }
  return Array.from(models.values()).sort((a, b) => b.satsCost - a.satsCost);
}

export function getProviderStats(entries: UsageTrackingEntry[]): ProviderStats[] {
  const providers = new Map<string, ProviderStats>();
  for (const entry of entries) {
    const url = entry.baseUrl || "unknown";
    const existing = providers.get(url) || {
      baseUrl: url, requests: 0, satsCost: 0, promptTokens: 0, completionTokens: 0, totalTokens: 0,
    };
    providers.set(url, {
      ...existing,
      requests: existing.requests + 1,
      satsCost: existing.satsCost + entry.satsCost,
      promptTokens: existing.promptTokens + entry.promptTokens,
      completionTokens: existing.completionTokens + entry.completionTokens,
      totalTokens: existing.totalTokens + entry.totalTokens,
    });
  }
  return Array.from(providers.values()).sort((a, b) => b.satsCost - a.satsCost);
}

export function getClientStats(entries: UsageTrackingEntry[]): ClientStats[] {
  const clients = new Map<string, ClientStats>();
  for (const entry of entries) {
    const client = entry.client || "unknown";
    const existing = clients.get(client) || {
      client, requests: 0, satsCost: 0, promptTokens: 0, completionTokens: 0, totalTokens: 0,
    };
    clients.set(client, {
      ...existing,
      requests: existing.requests + 1,
      satsCost: existing.satsCost + entry.satsCost,
      promptTokens: existing.promptTokens + entry.promptTokens,
      completionTokens: existing.completionTokens + entry.completionTokens,
      totalTokens: existing.totalTokens + entry.totalTokens,
    });
  }
  return Array.from(clients.values()).sort((a, b) => b.satsCost - a.satsCost);
}

export function getTotals(entries: UsageTrackingEntry[]) {
  return entries.reduce(
    (acc, entry) => ({
      promptTokens: acc.promptTokens + entry.promptTokens,
      completionTokens: acc.completionTokens + entry.completionTokens,
      totalTokens: acc.totalTokens + entry.totalTokens,
      satsCost: acc.satsCost + entry.satsCost,
    }),
    { promptTokens: 0, completionTokens: 0, totalTokens: 0, satsCost: 0 }
  );
}
