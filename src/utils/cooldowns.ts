/**
 * Cooldown reporting, shared by the daemon (`GET /cooldowns`) and the
 * `routstrd cooldowns` CLI command.
 *
 * Cooldown state is owned by the SDK: its `ProviderManager` writes
 * `providersOnCooldown` into the SdkStore, and every entry blocks routing
 * until it expires. An entry with a `modelPath` cools down only that upstream
 * route on the provider; one with only a `modelId` cools down that model; one
 * with neither cools down every model on the provider.
 *
 * Newer SDKs set an explicit `cooldownUntil` per entry (exponential backoff,
 * up to 10 minutes); entries without one still expire after the fixed
 * provider-wide window (`getCooldownDurationMs()`, 210s today). The SDK also
 * tracks consecutive per-scope failures in `modelFailureStreaks`, which
 * outlive their cooldowns — those are reported as recent failures.
 *
 * The SDK prunes expired entries lazily (on the next routing decision), so a
 * read of the persisted list can contain entries that already timed out.
 * Reporting therefore filters by age and never mutates the store.
 */

/** One persisted cooldown entry, as stored by the SDK. */
export interface StoredCooldownEntry {
  baseUrl: string;
  /** Present for model-scoped entries; absent for provider-wide ones. */
  modelId?: string;
  /** Present for path-scoped entries (an upstream route on the provider). */
  modelPath?: string;
  /** When the cooldown started (ms since epoch). */
  timestamp: number;
  /**
   * Explicit expiry set by SDKs with exponential cooldowns. Absent on
   * provider-wide/legacy entries, which expire after the fixed window.
   */
  cooldownUntil?: number;
}

/** One persisted failure streak, as stored by the SDK. */
export interface StoredFailureStreak {
  baseUrl: string;
  modelId?: string;
  modelPath?: string;
  /** Consecutive failures for this scope. */
  failureStreak: number;
  /** When the scope last failed (ms since epoch); absent on legacy entries. */
  failedAt?: number;
}

export interface CooldownSummary {
  baseUrl: string;
  /** Model id for model-scoped cooldowns, `null` for provider-wide ones. */
  modelId: string | null;
  /** Upstream route for path-scoped cooldowns, `null` otherwise. */
  modelPath: string | null;
  scope: "provider" | "model" | "path";
  startedAt: number;
  expiresAt: number;
  remainingMs: number;
}

export interface StreakSummary {
  baseUrl: string;
  modelId: string | null;
  modelPath: string | null;
  scope: "provider" | "model" | "path";
  failureStreak: number;
  /** When the scope last failed; `null` if the entry predates timestamps. */
  lastFailedAt: number | null;
  /** Age of the last failure; `null` when lastFailedAt is unknown. */
  ageMs: number | null;
}

export interface CooldownsOutput {
  /** Server time the payload was built at (ms since epoch). */
  now: number;
  cooldownDurationMs: number;
  /** Number of active cooldown entries (provider-, model-, and path-scoped). */
  count: number;
  /** Number of distinct providers with at least one active entry. */
  providerCount: number;
  cooldowns: CooldownSummary[];
  /**
   * Scopes with a failure streak that are not currently on cooldown.
   * Absent when the daemon (or its SDK) predates failure streaks.
   */
  streaks?: StreakSummary[];
}

/**
 * Failure streaks are retained by the SDK for this long after the last
 * failure. The SDK sweeps them lazily, so reporting drops anything older
 * rather than show scopes the router has already forgotten.
 */
const STREAK_RETENTION_MS = 6 * 60 * 60 * 1000;

function scopeOf(entry: {
  modelId?: string;
  modelPath?: string;
}): "provider" | "model" | "path" {
  if (entry.modelPath !== undefined) return "path";
  if (entry.modelId !== undefined) return "model";
  return "provider";
}

/** Scope identity used to match a streak against an active cooldown. */
function scopeKey(entry: {
  baseUrl: string;
  modelId?: string | null;
  modelPath?: string | null;
}): string {
  return `${entry.baseUrl}::${entry.modelId ?? ""}::${entry.modelPath ?? ""}`;
}

/**
 * Build the `/cooldowns` payload: drop expired entries, tag each entry's
 * scope, and compute when it lifts. Longest remaining cooldown comes first.
 * Entries with an explicit `cooldownUntil` expire then; others expire after
 * the fixed provider-wide window. `streaks` lists recently failing scopes
 * that are not on cooldown right now.
 */
export function buildCooldownsOutput(
  entries: StoredCooldownEntry[],
  cooldownDurationMs: number,
  now: number = Date.now(),
  streaks?: StoredFailureStreak[],
): CooldownsOutput {
  const cooldowns = entries
    .map((entry): CooldownSummary => {
      const expiresAt = entry.cooldownUntil ?? entry.timestamp + cooldownDurationMs;
      return {
        baseUrl: entry.baseUrl,
        modelId: entry.modelId ?? null,
        modelPath: entry.modelPath ?? null,
        scope: scopeOf(entry),
        startedAt: entry.timestamp,
        expiresAt,
        remainingMs: Math.max(0, expiresAt - now),
      };
    })
    .filter((entry) => entry.expiresAt > now)
    .sort(
      (a, b) =>
        b.remainingMs - a.remainingMs ||
        a.baseUrl.localeCompare(b.baseUrl) ||
        (a.modelId ?? "").localeCompare(b.modelId ?? "") ||
        (a.modelPath ?? "").localeCompare(b.modelPath ?? ""),
    );

  const output: CooldownsOutput = {
    now,
    cooldownDurationMs,
    count: cooldowns.length,
    providerCount: new Set(cooldowns.map((entry) => entry.baseUrl)).size,
    cooldowns,
  };

  if (streaks !== undefined) {
    const cooledScopes = new Set(cooldowns.map(scopeKey));
    output.streaks = streaks
      .filter(
        (entry) =>
          entry.failureStreak > 0 &&
          !cooledScopes.has(scopeKey(entry)) &&
          (entry.failedAt === undefined || now - entry.failedAt < STREAK_RETENTION_MS),
      )
      .map((entry): StreakSummary => {
        const lastFailedAt = entry.failedAt ?? null;
        return {
          baseUrl: entry.baseUrl,
          modelId: entry.modelId ?? null,
          modelPath: entry.modelPath ?? null,
          scope: scopeOf(entry),
          failureStreak: entry.failureStreak,
          lastFailedAt,
          ageMs: lastFailedAt === null ? null : Math.max(0, now - lastFailedAt),
        };
      })
      .sort(
        (a, b) =>
          b.failureStreak - a.failureStreak ||
          (a.ageMs ?? Number.MAX_SAFE_INTEGER) - (b.ageMs ?? Number.MAX_SAFE_INTEGER) ||
          a.baseUrl.localeCompare(b.baseUrl),
      );
  }

  return output;
}

/** Format a remaining-time value for the terminal, e.g. `2m 05s` or `42s`. */
export function formatCooldownRemaining(ms: number): string {
  const totalSeconds = Math.max(0, Math.ceil(ms / 1000));
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return minutes > 0
    ? `${minutes}m ${String(seconds).padStart(2, "0")}s`
    : `${seconds}s`;
}

/** The model/path detail column for a row, e.g. `kimi-k3` or `/v1/messages`. */
function scopeDetail(entry: {
  scope: "provider" | "model" | "path";
  modelId: string | null;
  modelPath: string | null;
}): string | null {
  if (entry.scope === "path") {
    return entry.modelId
      ? `${entry.modelId} ${entry.modelPath ?? ""}`.trim()
      : entry.modelPath;
  }
  if (entry.scope === "model") return entry.modelId ?? "";
  return null;
}

/** Render a `/cooldowns` payload for `routstrd cooldowns`. */
export function formatCooldowns(output: CooldownsOutput): string {
  const windowSeconds = Math.round(output.cooldownDurationMs / 1000);
  const heading = `Cooldowns (${windowSeconds}s window)`;

  const lines: string[] = [heading, ""];

  if (output.cooldowns.length === 0) {
    lines.push("  Nothing is on cooldown right now.");
  } else {
    const scopeCell = (entry: CooldownSummary) =>
      entry.scope === "provider" ? "PROVIDER" : entry.scope.toUpperCase();
    const urlWidth = Math.max(
      ...output.cooldowns.map((entry) => entry.baseUrl.length),
    );
    const detailWidth = Math.max(
      0,
      ...output.cooldowns.map((entry) => (scopeDetail(entry) ?? "").length),
    );

    lines.push(
      `  ${output.count} active across ${output.providerCount} ${
        output.providerCount === 1 ? "provider" : "providers"
      }:`,
      "",
    );

    for (const entry of output.cooldowns) {
      const cells = [
        scopeCell(entry).padEnd("PROVIDER".length),
        entry.baseUrl.padEnd(urlWidth),
      ];
      const detail = scopeDetail(entry);
      if (detail !== null) {
        cells.push(detail.padEnd(detailWidth));
      }
      lines.push(
        `  ${cells.join("  ")}  expires in ${formatCooldownRemaining(entry.remainingMs)}`,
      );
    }
  }

  // `streaks` is absent when the daemon predates failure streaks.
  const streaks = output.streaks ?? [];
  if (streaks.length > 0) {
    const urlWidth = Math.max(...streaks.map((entry) => entry.baseUrl.length));
    lines.push("", `  Recent failures (streaks):`, "");
    for (const entry of streaks) {
      const cells = [
        (entry.scope === "provider" ? "PROVIDER" : entry.scope.toUpperCase()).padEnd(
          "PROVIDER".length,
        ),
        entry.baseUrl.padEnd(urlWidth),
      ];
      const detail = scopeDetail(entry);
      if (detail !== null) cells.push(detail);
      const age =
        entry.ageMs === null
          ? "last failed unknown"
          : `last failed ${formatCooldownRemaining(entry.ageMs)} ago`;
      lines.push(`  ${cells.join("  ")}  streak ${entry.failureStreak}, ${age}`);
    }
  }

  return lines.join("\n");
}
