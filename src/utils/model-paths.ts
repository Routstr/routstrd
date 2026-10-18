/**
 * Model-path inventory: types, selector decoding, ranking, and CLI rendering,
 * shared by the daemon (`GET /models/:id/paths`) and the
 * `routstrd models -m <id> --paths` command.
 *
 * A *model path* is the opaque selector a routstr node advertises for one
 * upstream route of a model on `GET /v1/models/paths/{model}` and a client
 * pins per request with the `x-routstr-model-path` header (see the SDK's
 * `utils/modelPaths.ts`). One node advertises many routes per model — a dozen
 * to thirty for `deepseek-v4.1-flash`, one per OpenRouter subprovider plus the
 * direct upstreams — and each route prices and fails independently. The
 * inventory is therefore per node *and* per route.
 *
 * Ranking mirrors the router (the SDK's `ProviderManager`):
 *
 *  - a node's rank is the completion price of the route routing would use
 *    first: the node's preferred *whitelisted* route when the model's routes
 *    are whitelisted (the SDK's model-path whitelist), otherwise its cheapest
 *    advertised route;
 *  - nodes are ordered by that price, cheapest first, nodes with no priced
 *    route last;
 *  - inside a node, routes are listed cheapest completion first.
 *
 * A route on cooldown is still listed (it is advertised, just skipped for now)
 * but never decides the node's rank.
 */

/** Per-route pricing as advertised on `GET /v1/models/paths` (sats per token). */
export interface ModelPathPricing {
  prompt: number;
  completion: number;
  request: number;
  max_cost: number;
}

/**
 * Where a route's effective pricing came from: the route's own metadata
 * (`path`), the node's model-level catalog entry (`model`), or nowhere
 * (`none`, route listed but unpriceable).
 */
export type ModelPathPricingSource = "path" | "model" | "none";

/** One advertised upstream route of a model on one node. */
export interface ModelPathRoute {
  /** Verbatim advertised selector — the `x-routstr-model-path` value. */
  path: string;
  /** Decoded `url` parameter: the upstream base URL. */
  upstream: string;
  /** Decoded `endpoint` parameter (OpenRouter subprovider tag), if any. */
  endpoint: string | null;
  /**
   * Decoded `model-id` parameter: the spelling this upstream expects, which a
   * pinned request must also carry in its body. Differs from the requested id
   * on routes reachable only through a variant spelling.
   */
  modelId: string | null;
  /** Effective pricing: the route's own, else the model-level one. */
  pricing: ModelPathPricing | null;
  pricingSource: ModelPathPricingSource;
  contextLength: number | null;
  maxCompletionTokens: number | null;
  /** Path-scoped cooldown: routing currently skips this route on this node. */
  onCooldown: boolean;
  /** The route the router would pin first on this node. */
  pinned: boolean;
}

/** One node's advertised routes for a model. */
export interface ModelPathNode {
  baseUrl: string;
  /** Advertised routes, cheapest completion first. */
  routes: ModelPathRoute[];
  /** Ranking metric: completion sats/token of the route routing would use. */
  rankCompletion: number | null;
  /** True when {@link rankCompletion} comes from the pinned route. */
  rankedOnPin: boolean;
}

/** A node the inventory could not cover, and why. */
export interface ModelPathSkipped {
  baseUrl: string;
  reason: string;
}

/** Payload of `GET /models/:id/paths` and input of {@link formatModelPaths}. */
export interface ModelPathsOutput {
  /** The requested model id. */
  id: string;
  name?: string;
  description?: string;
  contextLength?: number;
  nodes: ModelPathNode[];
  skipped: ModelPathSkipped[];
}

/** Decoded parts of one advertised selector. */
export interface DecodedModelPathSelector {
  upstream: string;
  modelId: string;
  endpoint: string | null;
}

/** Inverse of the node's `quote_plus` encoding: `+` decodes as a space. */
function decodeFormValue(value: string): string {
  return decodeURIComponent(value.replace(/\+/g, " "));
}

/**
 * Decode an advertised selector into its parts; null when malformed.
 *
 * Mirrors the SDK's selector parsing deliberately: `url` and `model-id` are
 * required, `endpoint` is optional, the legacy `provider-id` parameter is
 * tolerated and ignored, and the encoding is `quote_plus`. The display must
 * agree with what the SDK accepts, so the rules are duplicated rather than
 * guessed at.
 */
export function decodeModelPathSelector(
  selector: string,
): DecodedModelPathSelector | null {
  const params = new Map<string, string>();
  for (const pair of selector.split("&")) {
    const eq = pair.indexOf("=");
    if (eq <= 0) return null;
    const key = pair.slice(0, eq);
    if (params.has(key)) return null;
    let value: string;
    try {
      value = decodeFormValue(pair.slice(eq + 1));
    } catch {
      return null; // malformed percent-encoding
    }
    if (!value.trim()) return null;
    params.set(key, value);
  }
  const upstream = params.get("url");
  const modelId = params.get("model-id");
  if (!upstream || !modelId) return null;
  return { upstream, modelId, endpoint: params.get("endpoint") ?? null };
}

/** A price that is missing or unusable sorts as "never cheapest". */
function priceOrInfinity(value: number | undefined): number {
  return typeof value === "number" && Number.isFinite(value)
    ? value
    : Number.POSITIVE_INFINITY;
}

/** Completion price of a route, or null when the route is unpriced. */
function completionOf(route: ModelPathRoute): number | null {
  const value = route.pricing?.completion;
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

/** Cheapest completion first; ties break deterministically (never by input order). */
function compareRoutes(a: ModelPathRoute, b: ModelPathRoute): number {
  return (
    priceOrInfinity(a.pricing?.completion) -
      priceOrInfinity(b.pricing?.completion) ||
    priceOrInfinity(a.pricing?.prompt) - priceOrInfinity(b.pricing?.prompt) ||
    a.upstream.localeCompare(b.upstream) ||
    (a.endpoint ?? "").localeCompare(b.endpoint ?? "") ||
    a.path.localeCompare(b.path)
  );
}

/**
 * Order the inventory the way the router does: routes cheapest-completion
 * first within each node, then nodes by their ranking metric, cheapest first,
 * and every node without a priced route last (ordered by URL).
 *
 * Callers must resolve pricing (including the model-level fallback) and
 * per-route cooldowns before calling: a route on cooldown is shown but never
 * becomes the price its node is ranked on.
 */
export function rankModelPathNodes(nodes: ModelPathNode[]): ModelPathNode[] {
  return nodes
    .map((node) => {
      const routes = [...node.routes].sort(compareRoutes);
      const pinned = routes.find(
        (route) => route.pinned && !route.onCooldown && completionOf(route) !== null,
      );
      const cheapest = routes.find(
        (route) => !route.onCooldown && completionOf(route) !== null,
      );
      const ranked = pinned ?? cheapest;
      return {
        ...node,
        routes,
        rankCompletion: ranked ? completionOf(ranked) : null,
        rankedOnPin: ranked !== undefined && ranked === pinned,
      };
    })
    .sort((a, b) => {
      const left = a.rankCompletion ?? Number.POSITIVE_INFINITY;
      const right = b.rankCompletion ?? Number.POSITIVE_INFINITY;
      return left - right || a.baseUrl.localeCompare(b.baseUrl);
    });
}

/** Sats per million tokens, the unit routing prices are compared in. */
function satsPerMillion(perToken: number): string {
  return (perToken * 1_000_000).toFixed(2);
}

/** `openrouter.ai/api/v1 [deepseek]`, or the raw URL when unparseable. */
function upstreamLabel(route: ModelPathRoute): string {
  let label = route.upstream;
  try {
    const url = new URL(route.upstream);
    label = `${url.host}${url.pathname}`.replace(/\/+$/, "");
  } catch {
    // Keep the advertised string; it is still the route's identity.
  }
  return route.endpoint ? `${label} [${route.endpoint}]` : label;
}

interface RouteRow {
  prompt: string;
  completion: string;
  ctx: string;
  upstream: string;
  tags: string[];
}

function toRow(route: ModelPathRoute, requestedId: string): RouteRow {
  const tags: string[] = [];
  if (route.pinned) tags.push("pin");
  if (route.onCooldown) tags.push("cooldown");
  if (route.pricingSource === "model") tags.push("model price");
  if (route.pricingSource === "none") tags.push("no price");
  if (route.modelId !== null && route.modelId !== requestedId) {
    tags.push(`id ${route.modelId}`);
  }
  return {
    prompt: route.pricing ? satsPerMillion(route.pricing.prompt) : "-",
    completion: route.pricing ? satsPerMillion(route.pricing.completion) : "-",
    ctx: route.contextLength === null ? "-" : route.contextLength.toLocaleString(),
    upstream: upstreamLabel(route),
    tags,
  };
}

/** One node block: a rank header plus its route table. */
function renderNode(node: ModelPathNode, rank: number, requestedId: string): string[] {
  const metric =
    node.rankCompletion === null
      ? node.routes.some((route) => route.onCooldown)
        ? "rank unavailable (no priced route off cooldown)"
        : "rank unavailable (no priced route)"
      : `rank ${satsPerMillion(node.rankCompletion)} sats/M completion ${
          node.rankedOnPin ? "(pinned route)" : "(cheapest route)"
        }`;
  const routes = node.routes.map((route) => toRow(route, requestedId));

  const width = (select: (row: RouteRow) => string, header: string) =>
    Math.max(header.length, ...routes.map((row) => select(row).length));
  const promptWidth = width((row) => row.prompt, "prompt");
  const completionWidth = width((row) => row.completion, "completion");
  const ctxWidth = width((row) => row.ctx, "ctx");
  const upstreamWidth = width((row) => row.upstream, "upstream");

  const lines = [
    `  ${String(rank).padStart(2)}. ${node.baseUrl}  ${node.routes.length} route${
      node.routes.length === 1 ? "" : "s"
    }  ${metric}`,
    "",
    `        ${"prompt".padEnd(promptWidth)}  ${"completion".padEnd(completionWidth)}  ${"ctx".padEnd(ctxWidth)}  upstream`,
  ];
  for (const row of routes) {
    const cells = [
      row.prompt.padEnd(promptWidth),
      row.completion.padEnd(completionWidth),
      row.ctx.padEnd(ctxWidth),
      row.upstream.padEnd(upstreamWidth),
    ];
    const suffix = row.tags.length > 0 ? `  [${row.tags.join(", ")}]` : "";
    lines.push(`        ${cells.join("  ").trimEnd()}${suffix}`);
  }
  return lines;
}

/** Render a `/models/:id/paths` payload for `routstrd models -m <id> --paths`. */
export function formatModelPaths(output: ModelPathsOutput): string {
  const title =
    output.name && output.name !== output.id
      ? `${output.id} (${output.name})`
      : output.id;
  const routeCount = output.nodes.reduce((sum, node) => sum + node.routes.length, 0);
  const lines: string[] = [`Model paths for ${title}`, ""];

  if (output.nodes.length === 0) {
    lines.push("  No node advertises model paths for this model.");
  } else {
    const hasPin = output.nodes.some((node) =>
      node.routes.some((route) => route.pinned),
    );
    lines.push(
      `  ${output.nodes.length} node${output.nodes.length === 1 ? "" : "s"}, ${routeCount} advertised route${
        routeCount === 1 ? "" : "s"
      }, ranked like the router:`,
      "  nodes by the completion price (sats/M tokens) of the route routing would use first",
      hasPin
        ? "  (the [pin] route when the node advertises one, else its cheapest route); nodes with"
        : "  (the node's cheapest advertised route); nodes with",
      "  no priced route come last, and routes are cheapest completion first inside a node.",
    );
    if (hasPin) {
      lines.push(
        "  [pin] marks the first route the router pins on that node (the SDK's model-path",
        "  whitelist order, which governs its auto-pinned model).",
      );
    }
    lines.push("");
    output.nodes.forEach((node, index) => {
      lines.push(...renderNode(node, index + 1, output.id), "");
    });
  }

  const skipped = output.skipped ?? [];
  if (skipped.length > 0) {
    lines.push("  Not shown:");
    for (const entry of skipped) {
      lines.push(`    ${entry.baseUrl}  ${entry.reason}`);
    }
  }

  // Drop the trailing blank line the node loop leaves behind.
  while (lines.length > 0 && lines[lines.length - 1] === "") lines.pop();
  return lines.join("\n");
}
