/**
 * Cooldown reporting, shared by the daemon (`GET /cooldowns`) and the
 * `routstrd cooldowns` CLI command.
 *
 * Cooldown state is owned by the SDK: its `ProviderManager` writes
 * `providersOnCooldown` into the SdkStore, and every entry blocks routing for
 * the length of the cooldown window (`getCooldownDurationMs()`, 210s today).
 * An entry with a `modelId` cools down only that model on the provider; an
 * entry without one cools down every model on the provider.
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
  /** When the cooldown started (ms since epoch). */
  timestamp: number;
}

export interface CooldownSummary {
  baseUrl: string;
  /** Model id for model-scoped cooldowns, `null` for provider-wide ones. */
  modelId: string | null;
  scope: "provider" | "model";
  startedAt: number;
  expiresAt: number;
  remainingMs: number;
}

export interface CooldownsOutput {
  /** Server time the payload was built at (ms since epoch). */
  now: number;
  cooldownDurationMs: number;
  /** Number of active cooldown entries (provider- and model-scoped). */
  count: number;
  /** Number of distinct providers with at least one active entry. */
  providerCount: number;
  cooldowns: CooldownSummary[];
}

/**
 * Build the `/cooldowns` payload: drop expired entries, tag each entry's
 * scope, and compute when it lifts. Longest remaining cooldown comes first.
 */
export function buildCooldownsOutput(
  entries: StoredCooldownEntry[],
  cooldownDurationMs: number,
  now: number = Date.now(),
): CooldownsOutput {
  const cooldowns = entries
    .filter((entry) => now - entry.timestamp < cooldownDurationMs)
    .map((entry): CooldownSummary => {
      const modelId = entry.modelId ?? null;
      const expiresAt = entry.timestamp + cooldownDurationMs;
      return {
        baseUrl: entry.baseUrl,
        modelId,
        scope: modelId === null ? "provider" : "model",
        startedAt: entry.timestamp,
        expiresAt,
        remainingMs: Math.max(0, expiresAt - now),
      };
    })
    .sort(
      (a, b) =>
        b.remainingMs - a.remainingMs ||
        a.baseUrl.localeCompare(b.baseUrl) ||
        (a.modelId ?? "").localeCompare(b.modelId ?? ""),
    );

  return {
    now,
    cooldownDurationMs,
    count: cooldowns.length,
    providerCount: new Set(cooldowns.map((entry) => entry.baseUrl)).size,
    cooldowns,
  };
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

/** Render a `/cooldowns` payload for `routstrd cooldowns`. */
export function formatCooldowns(output: CooldownsOutput): string {
  const windowSeconds = Math.round(output.cooldownDurationMs / 1000);
  const heading = `Cooldowns (${windowSeconds}s window)`;

  if (output.cooldowns.length === 0) {
    return `${heading}\n\n  Nothing is on cooldown right now.`;
  }

  const scopeCell = (entry: CooldownSummary) =>
    entry.scope === "provider" ? "PROVIDER" : "MODEL";
  const urlWidth = Math.max(
    ...output.cooldowns.map((entry) => entry.baseUrl.length),
  );
  const modelWidth = Math.max(
    0,
    ...output.cooldowns.map((entry) => (entry.modelId ?? "").length),
  );

  const lines = [
    heading,
    "",
    `  ${output.count} active across ${output.providerCount} ${
      output.providerCount === 1 ? "provider" : "providers"
    }:`,
    "",
  ];

  for (const entry of output.cooldowns) {
    const cells = [scopeCell(entry).padEnd("PROVIDER".length), entry.baseUrl.padEnd(urlWidth)];
    if (entry.scope === "model") {
      cells.push((entry.modelId ?? "").padEnd(modelWidth));
    }
    lines.push(
      `  ${cells.join("  ")}  expires in ${formatCooldownRemaining(entry.remainingMs)}`,
    );
  }

  return lines.join("\n");
}
