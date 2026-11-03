/**
 * Reachability of the nodes discovered over Nostr, for the display layer.
 *
 * Kind-38421 discovery reports every node that *exists*, not every node that
 * *answers*: a provider can be dead for months and still be announced, so
 * `providers list` fills up with nodes no request could ever reach. The daemon
 * has one piece of evidence the other way — the SDK fetches
 * `GET {node}/v1/models` for every discovered node on each refresh pass
 * (21-minute cadence, the SDK's own provider cache TTL) and persists the time
 * of the last *successful* fetch per node in the discovery adapter. That
 * timestamp (`getProviderLastUpdate`), plus the catalog the fetch left behind
 * (`getCachedModels`), is what this module turns into a per-node verdict.
 * The daemon snapshots those live adapter values into the input shape below;
 * the legacy SdkStore cache is separate and is not updated by model refreshes.
 *
 * This is a read-side classification only: `baseUrlsList` keeps every
 * discovered node, because discovery, routing and the review policy all
 * operate on the full set. A node that comes back is therefore usable (and
 * listable) again on the next pass without waiting for a new discovery event.
 */

/**
 * How long a node's last successful model fetch keeps it "reachable".
 *
 * The daemon refreshes every 21 minutes, so this is two passes: one missed
 * pass is a blip (daemon restart, slow node, relay hiccup) and must not hide a
 * node, while a node that missed two in a row is down as far as the user is
 * concerned.
 */
export const PROVIDER_REACHABILITY_TTL_MS = 2 * 21 * 60 * 1000;

/** Why a node counts as unreachable. Stable strings: the CLI renders them. */
export type ProviderUnreachableReason = "never-fetched" | "stale";

/** Reachability verdict for one node. */
export interface ProviderReachability {
  /** False only when the node has a failed/stale record; see the module note. */
  reachable: boolean;
  /** Time of the last successful `/v1/models` fetch, null if never. */
  lastModelFetchAt: number | null;
  /** Models the node advertised on that fetch. */
  modelCount: number;
  /** Absent when the node is reachable. */
  reason?: ProviderUnreachableReason;
}

/**
 * The cache snapshot the verdict is computed from. Both are optional so a
 * partially-hydrated cache (or an older payload shape) reads as "no evidence"
 * instead of throwing.
 */
export interface ProviderReachabilityState {
  lastModelsUpdate?: Record<string, number> | null;
  modelsFromAllProviders?: Record<string, unknown[] | undefined> | null;
}

/** Normalize a node URL the way the SDK keys its caches: trailing slash. */
export function normalizeNodeBaseUrl(url: string): string {
  const withScheme = url.startsWith("http") ? url : `https://${url}`;
  return withScheme.endsWith("/") ? withScheme : `${withScheme}/`;
}

/**
 * Store keys a node URL may sit under, most likely first.
 *
 * The SDK keys `lastModelsUpdate`/`modelsFromAllProviders` by the URL exactly
 * as discovery handed it to it, plus a trailing slash — it does not add a
 * scheme. Some directory entries carry a bare host, which the daemon resolves
 * as https elsewhere, so both spellings are accepted rather than reporting a
 * working node as never fetched.
 */
function nodeKeyCandidates(url: string): string[] {
  const withSlash = url.endsWith("/") ? url : `${url}/`;
  if (/^[a-z][a-z0-9+.-]*:/i.test(url)) return [withSlash];
  return [withSlash, normalizeNodeBaseUrl(url)];
}

/** Read a per-node store slice under any of a node's key spellings. */
function lookupNode<T>(
  slice: Record<string, T | undefined>,
  baseUrl: string,
): T | undefined {
  for (const key of nodeKeyCandidates(baseUrl)) {
    if (slice[key] !== undefined) return slice[key];
  }
  return undefined;
}

function isFresh(timestamp: unknown, now: number): boolean {
  if (typeof timestamp !== "number" || !Number.isFinite(timestamp)) {
    return false;
  }
  // `timestamp <= now` guards a clock that moved backwards: a future
  // timestamp is not evidence of a fetch that just succeeded.
  return timestamp > 0 && timestamp <= now && now - timestamp <= PROVIDER_REACHABILITY_TTL_MS;
}

/**
 * Classify every node in `baseUrls`, in order.
 *
 * Fails open. Hiding the whole list is far worse than showing a dead node, so
 * "no node has answered recently" is read as "no evidence" rather than "every
 * node is down": that is the state of a fresh install, and of a daemon that
 * has just started and whose first fetch pass is still running. Once at least
 * one node has answered within {@link PROVIDER_REACHABILITY_TTL_MS}, a fetch
 * pass demonstrably ran on this store and the per-node verdicts are reported.
 */
export function assessProviderReachability(
  baseUrls: string[],
  state: ProviderReachabilityState,
  now = Date.now(),
): ProviderReachability[] {
  const timestamps = state.lastModelsUpdate ?? {};
  const models = state.modelsFromAllProviders ?? {};
  const hasEvidence = Object.values(timestamps).some((value) =>
    isFresh(value, now),
  );

  return baseUrls.map((baseUrl) => {
    const stored = lookupNode(timestamps, baseUrl);
    const lastModelFetchAt =
      typeof stored === "number" && stored > 0 ? stored : null;
    const modelCount = (lookupNode(models, baseUrl) ?? []).length;

    if (!hasEvidence) {
      return { reachable: true, lastModelFetchAt, modelCount };
    }
    if (lastModelFetchAt === null) {
      return {
        reachable: false,
        lastModelFetchAt: null,
        modelCount,
        reason: "never-fetched" as const,
      };
    }
    if (!isFresh(lastModelFetchAt, now)) {
      return {
        reachable: false,
        lastModelFetchAt,
        modelCount,
        reason: "stale" as const,
      };
    }
    return { reachable: true, lastModelFetchAt, modelCount };
  });
}

/**
 * When the node was last seen, for `providers list --all`: `never fetched`,
 * `last seen 42m ago`, `last seen 8d ago`. Coarse on purpose — the exact
 * second a node was last fetched is not something a user acts on.
 */
export function formatLastSeen(
  lastModelFetchAt: number | null,
  now = Date.now(),
): string {
  if (lastModelFetchAt === null) return "never fetched";
  const elapsed = Math.max(0, now - lastModelFetchAt);
  const minutes = Math.floor(elapsed / 60_000);
  const age =
    minutes < 1
      ? `${Math.max(0, Math.floor(elapsed / 1000))}s ago`
      : minutes < 60
        ? `${minutes}m ago`
        : Math.floor(minutes / 60) < 24
          ? `${Math.floor(minutes / 60)}h ${minutes % 60}m ago`
          : `${Math.floor(minutes / 60 / 24)}d ago`;
  return `last seen ${age}`;
}

/** One row of the daemon's `/providers` payload, as far as rendering needs. */
export interface ProviderListEntry {
  index: number;
  baseUrl: string;
  disabled: boolean;
  manuallyDisabled?: boolean;
  manuallyEnabled?: boolean;
  reachable?: boolean;
  lastModelFetchAt?: number | null;
}

/** Payload of `GET /providers`, as far as rendering needs. */
export interface ProviderListOutput {
  providers: ProviderListEntry[];
  disabledCount: number;
  totalCount: number;
  reachableCount?: number;
  unreachableCount?: number;
  hiddenCount?: number;
  includeUnreachable?: boolean;
}

/**
 * Render a `/providers` payload for `routstrd providers list`.
 *
 * An older daemon reports every node and no reachability fields; it renders as
 * it always did rather than claiming everything is reachable.
 */
export function formatProviderList(
  output: ProviderListOutput,
  now = Date.now(),
): string {
  const totalCount = output.totalCount ?? output.providers.length;
  const reachableCount = output.reachableCount;
  const unreachableCount = output.unreachableCount ?? 0;
  const hiddenCount = output.hiddenCount ?? 0;

  const rows = output.providers.map((provider) => ({
    index: provider.index,
    baseUrl: provider.baseUrl,
    // Reachability outranks enable/disable: a node that cannot be reached
    // cannot be routed to, whatever the review policy says about it.
    status:
      provider.reachable === false
        ? `UNREACHABLE (${formatLastSeen(provider.lastModelFetchAt ?? null, now)})`
        : provider.manuallyDisabled
          ? "DISABLED (manual)"
          : provider.disabled
            ? "DISABLED (nostr review)"
            : provider.manuallyEnabled
              ? "enabled (manual override)"
              : "enabled",
  }));
  // Indices address the full discovered list, so they reach three digits; pad
  // them or a 60-node list steps its URL column at index 10.
  const indexWidth = Math.max(
    ...rows.map((row) => String(row.index).length),
    1,
  );
  const statusWidth = Math.max(...rows.map((row) => row.status.length), 0);

  const lines = [
    reachableCount === undefined
      ? `Providers (${totalCount} total, ${output.disabledCount} disabled):`
      : `Providers (${reachableCount} reachable of ${totalCount} discovered, ${output.disabledCount} disabled):`,
    "",
  ];
  for (const row of rows) {
    const index = String(row.index).padStart(indexWidth);
    lines.push(`  [${index}] ${row.status.padEnd(statusWidth)}  ${row.baseUrl}`);
  }

  if (hiddenCount > 0) {
    lines.push(
      "",
      `  ${hiddenCount} unreachable node${hiddenCount === 1 ? "" : "s"} hidden — pass --all to list ${
        hiddenCount === 1 ? "it" : "them"
      }.`,
    );
  } else if (unreachableCount > 0 && output.includeUnreachable) {
    lines.push(
      "",
      `  ${unreachableCount} of the ${totalCount} discovered nodes are unreachable.`,
    );
  }

  return lines.join("\n");
}
