import type { UsageData, UsageTrackingEntry } from "./types";
import { logger } from "../utils/logger";

export function extractUsageFromResponseBody(body: unknown): UsageData | null {
  if (!body || typeof body !== "object") return null;
  const usage = (body as { usage?: Record<string, unknown> }).usage;
  if (!usage || typeof usage !== "object") return null;

  const promptTokens = Number(usage.prompt_tokens ?? 0);
  const completionTokens = Number(usage.completion_tokens ?? 0);
  const totalTokens = Number(usage.total_tokens ?? 0);
  const costValue = usage.cost;

  let cost = 0;
  let satsCost = 0;

  if (typeof costValue === "number") {
    cost = costValue;
  } else if (costValue && typeof costValue === "object") {
    const costObj = costValue as Record<string, unknown>;
    const totalUsd = costObj.total_usd;
    const totalMsats = costObj.total_msats;

    cost = typeof totalUsd === "number" ? totalUsd : 0;
    satsCost = typeof totalMsats === "number" ? totalMsats / 1000 : 0;
  }

  if (
    promptTokens === 0 &&
    completionTokens === 0 &&
    totalTokens === 0 &&
    cost === 0 &&
    satsCost === 0
  ) {
    return null;
  }

  return {
    promptTokens,
    completionTokens,
    totalTokens,
    cost,
    satsCost,
  };
}

export function resolveUsageBaseUrl(response: Response, fallback?: string): string {
  const responseWithBaseUrl = response as Response & { baseUrl?: unknown };
  if (typeof responseWithBaseUrl.baseUrl === "string") {
    return responseWithBaseUrl.baseUrl;
  }

  try {
    if (response.url) {
      const parsed = new URL(response.url);
      return `${parsed.protocol}//${parsed.host}`;
    }
  } catch {
    // Ignore URL parsing failures.
  }

  return fallback || "unknown";
}

export function extractResponseId(body: unknown): string | undefined {
  if (!body || typeof body !== "object") return undefined;
  const id = (body as { id?: unknown }).id;
  if (typeof id !== "string") return undefined;
  const trimmed = id.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

export function createUsageTracker(store: { getState(): any }) {
  const append = (entry: UsageTrackingEntry): void => {
    const state = store.getState();
    const nextUsage = [...(state.usageTracking || []), entry];
    state.setUsageTracking(nextUsage);
    logger.log("Usage tracking saved:", JSON.stringify(entry));
  };

  const listRecent = (limit: number) => {
    const usageTracking =
      ((store.getState().usageTracking || []) as UsageTrackingEntry[]) || [];
    const recent = usageTracking.slice(-limit).reverse();
    const totalSatsCost = usageTracking.reduce(
      (sum, entry) => sum + (entry.satsCost || 0),
      0,
    );
    const recentSatsCost = recent.reduce(
      (sum, entry) => sum + (entry.satsCost || 0),
      0,
    );

    return {
      entries: recent,
      totalEntries: usageTracking.length,
      totalSatsCost,
      recentSatsCost,
      limit,
    };
  };

  const listForTimestamp = (timestamp: string, limit: number) => {
    const usageTracking =
      ((store.getState().usageTracking || []) as UsageTrackingEntry[]) || [];
    const requestIdPrefix = `gen-${timestamp}-`;
    const filteredUsage = usageTracking.filter((entry) =>
      entry.requestId.startsWith(requestIdPrefix),
    );
    const recent = filteredUsage.slice(-limit).reverse();
    const totalSatsCost = filteredUsage.reduce(
      (sum, entry) => sum + (entry.satsCost || 0),
      0,
    );
    const recentSatsCost = recent.reduce(
      (sum, entry) => sum + (entry.satsCost || 0),
      0,
    );

    return {
      entries: recent,
      totalEntries: filteredUsage.length,
      totalSatsCost,
      recentSatsCost,
      limit,
      timestamp,
    };
  };

  return {
    append,
    listRecent,
    listForTimestamp,
  };
}
