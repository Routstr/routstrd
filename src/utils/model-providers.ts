/**
 * Per-provider pricing of one model, and its table rendering for
 * `routstrd models -m <id>`.
 *
 * The daemon (`GET /models/:id/providers`) ranks nodes with the SDK's
 * `getProviderPriceRankingForModel` on `WARM_COST_BASKET` — what one warm
 * request would cost, the basket routing picks providers on — so the table
 * keeps that order: cheapest warm request first. Disabled nodes are dropped
 * unless the caller asked for them (`includeDisabled`, the CLI's `--all`),
 * because a node routing excludes is not a price a request can get; when they
 * are shown they keep their rank position and are marked `✗`.
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
  /**
   * Disabled nodes left out of {@link providers}. Absent from an older
   * daemon's payload, which always reported every node; zero when the caller
   * asked for them. Non-zero with an empty `providers` means only disabled
   * nodes serve the model — the table says so instead of claiming the model
   * does not exist.
   */
  hiddenProviders?: number;
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
 *
 * `headRatio` is the share of the kept columns given to the front of the
 * string. It defaults to a head-heavy 0.6 (the provider name is the wider
 * identifier); callers that care more about the tail — a node's `fips:PORT`
 * host suffix, say — pass something smaller.
 */
export function truncateMiddle(value: string, max = PROVIDER_COLUMN_MAX, headRatio = 0.6): string {
  if (value.length <= max) return value;
  const keep = max - 1; // the ellipsis takes the last column
  const head = Math.ceil(keep * headRatio);
  return `${value.slice(0, head)}…${value.slice(value.length - (keep - head))}`;
}

/**
 * Columns kept at each end of the opaque label of a node URL — the `npub1…`
 * body or a tunnel host's first label — and so the widest it ever renders:
 * 9 + the ellipsis + 5 = 15.
 *
 * The recent-requests table prints `BASE:PROVIDER` in one column. Only the
 * label is elided: everything from the URL's first dot on (`.fips:28080/`, a
 * `*.trycloudflare.com` host) and the `:provider` after it stay whole, because
 * those are the halves that tell two nodes — and two requests — apart. A
 * character-count window over the whole URL instead mangled short, readable
 * hosts (`routstr.cypherpunk.today/` → `routstr…oday/`) while cutting the
 * useful tail off the long ones (`….fips:28080/` → `…8080/`).
 */
export const NODE_LABEL_HEAD = 9;
export const NODE_LABEL_TAIL = 5;

/** Widest the label renders: 9 + ellipsis + 5. */
export const NODE_LABEL_MAX = NODE_LABEL_HEAD + 1 + NODE_LABEL_TAIL;

/** Narrowest label window still worth rendering beside the tail. */
const MIN_LABEL_BUDGET = 4;

const URL_SCHEME = /^https?:\/\//;

/**
 * Split a node URL at its first dot into the opaque label routing never reads
 * and the tail that identifies the deployment. `localhost:8080` has no dot to
 * split on, so all of it is the label.
 */
export function splitNodeUrl(url: string): { label: string; tail: string } {
  const dot = url.indexOf(".");
  if (dot <= 0) return { label: url, tail: "" };
  return { label: url.slice(0, dot), tail: url.slice(dot) };
}

/**
 * Elide the middle of an opaque label to at most `max` columns, head-heavy so
 * the `npub1…` prefix survives. A label that already fits is left untouched —
 * a short host name is not worth eliding just because the window is wider.
 */
export function elideNodeLabel(label: string, max = NODE_LABEL_MAX): string {
  if (label.length <= max) return label;
  if (max <= 1) return "…";
  const keep = max - 1; // the ellipsis takes the last column
  const head = Math.min(NODE_LABEL_HEAD, Math.ceil((keep * NODE_LABEL_HEAD) / (NODE_LABEL_HEAD + NODE_LABEL_TAIL)));
  return `${label.slice(0, head)}…${label.slice(label.length - (keep - head))}`;
}

function providerSuffix(provider: string | undefined): string {
  return `:${provider || "unknown"}`;
}

/**
 * Render `BASE:PROVIDER` for the recent-requests table into `budget` columns.
 *
 * The label is capped at its window even when the column could afford more —
 * `npub1pxd3…mya5a` is all of an npub anyone reads — while the tail and the
 * `:provider` are kept whole for as long as the column allows. Only a column
 * too narrow for both is elided as a whole.
 */
export function formatNodeProviderCell(
  baseUrl: string,
  provider: string | undefined,
  budget = Number.POSITIVE_INFINITY,
): string {
  const url = baseUrl.replace(URL_SCHEME, "");
  const suffix = providerSuffix(provider);
  const { label, tail } = splitNodeUrl(url);
  const labelBudget = Math.min(NODE_LABEL_MAX, budget - tail.length - suffix.length);
  if (labelBudget >= MIN_LABEL_BUDGET) {
    return `${elideNodeLabel(label, labelBudget)}${tail}${suffix}`;
  }
  // Too narrow to hold a label beside the tail: elide the combined string
  // rather than chop the `:provider` off.
  return truncateMiddle(`${url}${suffix}`, budget, 0.5);
}

/**
 * Widest a `BASE:PROVIDER` cell renders once its label is capped — what the
 * recent-requests table sizes its provider column from.
 */
export function nodeProviderCellWidth(baseUrl: string, provider?: string): number {
  return formatNodeProviderCell(baseUrl, provider).length;
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
  const hidden = model.hiddenProviders ?? 0;

  lines.push("");
  if (rows.length === 0) {
    // Two very different situations: no node serves the model at all, or the
    // only nodes that do are disabled and therefore filtered out. Saying
    // "not served" for the second would tell the user the model does not
    // exist when `--all` would show it.
    lines.push(
      hidden > 0
        ? `  No enabled node serves this model (${hidden} disabled; pass --all to show ${
            hidden === 1 ? "it" : "them"
          }).`
        : "  No node serves this model.",
    );
    return lines.join("\n");
  }

  lines.push(
    `  ${rows.length} provider${rows.length === 1 ? "" : "s"}, cheapest warm request first`,
  );
  if (hidden > 0) {
    lines.push(
      `  ${hidden} disabled node${hidden === 1 ? "" : "s"} hidden — pass --all to show ${
        hidden === 1 ? "it" : "them"
      }`,
    );
  }
  lines.push("  Rates in sats per million tokens", "");

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
    // The On column only carries information once disabled nodes are shown.
    model.providers.some((provider) => provider.disabled)
      ? "  ✓ enabled   ✗ disabled"
      : "  ✓ enabled",
    "  - the node advertises no cache rate, so cache tokens are billed at the prompt rate",
  );

  return lines.join("\n");
}
