/**
 * Per-provider pricing of one model, and its table rendering for
 * `routstrd models -m <id>`.
 *
 * The daemon (`GET /models/:id/providers`) ranks nodes with the SDK's
 * `getProviderPriceRankingForModel` on `WARM_COST_BASKET` — what one warm
 * request would cost, the basket routing picks providers on — so the table
 * keeps that order: cheapest warm request first, disabled nodes interleaved
 * where they rank.
 *
 * Rates travel as sats per token, the unit nodes advertise; the table renders
 * sats per million tokens, the unit routing prices are compared in. A cache
 * rate is only shown when the node advertised it: the SDK fills a missing
 * cache rate with the prompt rate (a node bills unusable cache tokens there
 * too), so printing the filled value would claim a cache discount the node
 * never offered.
 *
 * `request` and `max_cost` stay in the payload because they size the deposit
 * a node asks for, but they are not shown: a request is not billed them.
 */

/** Pricing of one node for one model, as returned by the daemon. */
export interface ModelProviderPricing {
  /** Sats per prompt (input) token. */
  prompt: number;
  /** Sats per completion (output) token. */
  completion: number;
  /** Sats per request. Sizes the deposit ceiling; not billed per request. */
  request: number;
  /** Deposit ceiling for one request, in sats. */
  max_cost: number;
  /**
   * Cache rates. Absent from an older daemon's payload, in which case the
   * table shows the node as advertising none instead of crashing.
   */
  cache?: ModelProviderCachePricing;
}

/** Cache rates a node publishes, plus whether it published them at all. */
export interface ModelProviderCachePricing {
  /** Sats per token read from the upstream cache. */
  read: number;
  /** Sats per token written into the upstream cache. */
  write: number;
  /** False when the node announced no rate; `read` is then the prompt rate. */
  readAdvertised: boolean;
  /** False when the node announced no rate; `write` is then the prompt rate. */
  writeAdvertised: boolean;
}

/** One node serving the model. */
export interface ModelProviderInfo {
  baseUrl: string;
  disabled: boolean;
  pricing: ModelProviderPricing;
}

/** A model with the nodes that serve it, cheapest warm request first. */
export interface ModelWithProviders {
  id: string;
  name?: string;
  description?: string;
  context_length?: number;
  providers: ModelProviderInfo[];
}

/**
 * Widest a provider URL may render before it is elided. Real node URLs run to
 * ~57 characters (a `*.trycloudflare.com` tunnel), which would otherwise set
 * the width of the whole table; the longest ordinary ones (~30) stay intact.
 */
export const PROVIDER_COLUMN_MAX = 44;

/** Sats per million tokens: the unit routing prices are compared in. */
function satsPerMillion(perToken: number): string {
  return (perToken * 1_000_000).toFixed(2);
}

/**
 * Elide the middle of an over-long string, keeping both ends. A node URL's
 * head carries the provider name and its tail the tunnel/path that tells two
 * sibling deployments apart, so either end alone can be ambiguous.
 */
export function truncateMiddle(value: string, max = PROVIDER_COLUMN_MAX): string {
  if (value.length <= max) return value;
  const keep = max - 1; // the ellipsis takes the last column
  const head = Math.ceil(keep * 0.6);
  return `${value.slice(0, head)}…${value.slice(value.length - (keep - head))}`;
}

interface ProviderRow {
  provider: string;
  prompt: string;
  completion: string;
  cacheRead: string;
  cacheWrite: string;
  enabled: string;
}

const HEADERS: Record<keyof ProviderRow, string> = {
  provider: "Provider",
  prompt: "Prompt",
  completion: "Completion",
  cacheRead: "Cache read",
  cacheWrite: "Cache write",
  enabled: "On",
};

/** Columns holding right-aligned numbers, in render order. */
const NUMERIC: ReadonlySet<keyof ProviderRow> = new Set<keyof ProviderRow>([
  "prompt",
  "completion",
  "cacheRead",
  "cacheWrite",
]);

const COLUMNS = Object.keys(HEADERS) as Array<keyof ProviderRow>;

function toRow(provider: ModelProviderInfo): ProviderRow {
  const cache = provider.pricing.cache;
  return {
    provider: truncateMiddle(provider.baseUrl),
    prompt: satsPerMillion(provider.pricing.prompt),
    completion: satsPerMillion(provider.pricing.completion),
    // A rate the SDK filled in from the prompt rate is not a cache price the
    // node offered, so only an advertised one is shown.
    cacheRead: cache?.readAdvertised ? satsPerMillion(cache.read) : "-",
    cacheWrite: cache?.writeAdvertised ? satsPerMillion(cache.write) : "-",
    enabled: provider.disabled ? "✗" : "✓",
  };
}

/** Render a `/models/:id/providers` payload for `routstrd models -m <id>`. */
export function formatModelProviders(model: ModelWithProviders): string {
  const title =
    model.name && model.name !== model.id
      ? `${model.id} (${model.name})`
      : model.id;
  const lines: string[] = [title];
  if (model.description) lines.push(`  ${model.description}`);
  if (model.context_length) {
    lines.push(`  Context: ${model.context_length.toLocaleString()} tokens`);
  }

  const rows = model.providers.map(toRow);

  lines.push("");
  if (rows.length === 0) {
    lines.push("  No node serves this model.");
    return lines.join("\n");
  }

  const enabled = model.providers.filter((provider) => !provider.disabled).length;
  lines.push(
    `  ${rows.length} provider${rows.length === 1 ? "" : "s"}, ` +
      `${enabled} enabled, cheapest warm request first`,
    "  Rates in sats per million tokens",
    "",
  );

  const widths = {} as Record<keyof ProviderRow, number>;
  for (const column of COLUMNS) {
    widths[column] = Math.max(
      HEADERS[column].length,
      ...rows.map((row) => row[column].length),
    );
  }

  const cells = (row: Record<keyof ProviderRow, string>): string =>
    COLUMNS.map((column) =>
      NUMERIC.has(column)
        ? row[column].padStart(widths[column])
        : row[column].padEnd(widths[column]),
    )
      .join("  ")
      .trimEnd();

  lines.push(`  ${cells(HEADERS)}`);
  lines.push(
    `  ${COLUMNS.map((column) => "-".repeat(widths[column])).join("  ")}`,
  );
  for (const row of rows) lines.push(`  ${cells(row)}`);

  lines.push(
    "",
    "  ✓ enabled   ✗ disabled",
    "  - the node advertises no cache rate, so cache tokens are billed at the prompt rate",
  );

  return lines.join("\n");
}
