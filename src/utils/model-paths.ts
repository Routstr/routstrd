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
 * Ranking mirrors the router (the SDK's `ProviderManager`), which does not
 * compare a single token class but what one request would be *billed*:
 *
 *  - every route is priced with the SDK's `estimateCost` against
 *    `WARM_COST_BASKET` — the basket routing ranks on (100k prompt tokens at a
 *    90% cache hit, 2k completion) — so a route's cache rate carries the 90% of
 *    the prompt it mostly serves;
 *  - inside a node, routes are listed cheapest cost first;
 *  - a node's rank is that cost on the route routing would use first: the
 *    node's preferred *whitelisted* route when the model's routes are
 *    whitelisted (the SDK's model-path whitelist), otherwise its cheapest
 *    advertised route;
 *  - nodes are ordered by that cost, cheapest first, nodes with no priced
 *    route last (ties broken by URL, like `getProviderPriceRankingForModel`).
 *
 * A route on cooldown is still listed (it is advertised, just skipped for now)
 * but never decides the node's rank.
 */

import {
  estimateCost,
  hasUsableTokenRates,
  WARM_COST_BASKET,
  type ModelSatsPricing,
} from "@routstr/sdk";

/** Per-route pricing as advertised on `GET /v1/models/paths` (sats per token). */
export interface ModelPathPricing {
  prompt: number;
  completion: number;
  request: number;
  max_cost: number;
  /**
   * Sats per prompt token served from the upstream cache. `0` (or absent)
   * means the node announced no cache rate, which is not "free": an unusable
   * cache rate bills at the prompt rate, so the table renders `-` rather than
   * claiming a discount the node never offered.
   */
  input_cache_read?: number;
  /** Sats per prompt token written into the upstream cache; `0` = not announced. */
  input_cache_write?: number;
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
  /**
   * Sats one warm request would cost on this route (the SDK's
   * `WARM_COST_BASKET`, the basket routing ranks on), or null when the route
   * publishes no price it could be billed at. Set by
   * {@link rankModelPathNodes}; absent on routes built but not yet ranked.
   */
  cost?: number | null;
}

/** One node's advertised routes for a model. */
export interface ModelPathNode {
  baseUrl: string;
  /** Advertised routes, cheapest warm-request cost first. */
  routes: ModelPathRoute[];
  /**
   * Routing currently excludes this node (a disabled provider). Only set when
   * the inventory was asked for every node (`includeDisabled` / `--all`);
   * otherwise such a node is not listed at all. The node is priced and ranked
   * like the others, and the renderer flags it.
   */
  disabled?: boolean;
  /**
   * Ranking metric: sats one warm request would cost on the route routing
   * would use first, or null when the node has no priced route off cooldown.
   */
  rankCost: number | null;
  /** True when {@link rankCost} comes from the pinned route. */
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

/**
 * What one warm request would cost on a route, in sats — the SDK's
 * `estimateCost` against `WARM_COST_BASKET`, the same function and basket
 * `getProviderPriceRankingForModel` sorts routing on. Every price comparison
 * in routstrd goes through this, so the model list, the provider table and the
 * route inventory all rank on one key.
 *
 * Null when the route publishes rates that are not prices (NaN, ±inf,
 * negative) or no pricing at all: such a route cannot be billed, so it must
 * never win a comparison. The per-request fee is excluded from the total the
 * SDK returns, which is right — a node bills token classes, not the request.
 */
export function warmCost(
  pricing: Partial<ModelSatsPricing> | null | undefined,
): number | null {
  if (!hasUsableTokenRates(pricing)) return null;
  const total = estimateCost(pricing, WARM_COST_BASKET).total;
  return Number.isFinite(total) ? total : null;
}

/** Cost of a route, or +Infinity when it has none (sorts last). */
function costOrInfinity(route: ModelPathRoute): number {
  const { cost } = route;
  return typeof cost === "number" && Number.isFinite(cost)
    ? cost
    : Number.POSITIVE_INFINITY;
}

/**
 * Cheapest warm-request cost first, then cheap prompt, then upstream/endpoint/
 * path. The tiebreaks only order routes the basket prices identically, so they
 * never contradict the ranking; they keep the output independent of input and
 * cache order.
 */
function compareRoutes(a: ModelPathRoute, b: ModelPathRoute): number {
  return (
    costOrInfinity(a) - costOrInfinity(b) ||
    priceOrInfinity(a.pricing?.prompt) - priceOrInfinity(b.pricing?.prompt) ||
    a.upstream.localeCompare(b.upstream) ||
    (a.endpoint ?? "").localeCompare(b.endpoint ?? "") ||
    a.path.localeCompare(b.path)
  );
}

/**
 * Order the inventory the way the router does: every route priced against the
 * warm basket, routes cheapest cost first inside a node, then nodes by the
 * cost of the route routing would use first, cheapest first, and every node
 * without a priced route last (ordered by URL).
 *
 * Callers must resolve pricing (including the model-level fallback) and
 * per-route cooldowns before calling: a route on cooldown is shown but never
 * becomes the cost its node is ranked on.
 */
export function rankModelPathNodes(nodes: ModelPathNode[]): ModelPathNode[] {
  return nodes
    .map((node) => {
      const routes = node.routes
        .map((route) => ({ ...route, cost: warmCost(route.pricing) }))
        .sort(compareRoutes);
      const priced = (route: ModelPathRoute) =>
        costOrInfinity(route) !== Number.POSITIVE_INFINITY;
      const pinned = routes.find(
        (route) => route.pinned && !route.onCooldown && priced(route),
      );
      const cheapest = routes.find((route) => !route.onCooldown && priced(route));
      const ranked = pinned ?? cheapest;
      return {
        ...node,
        routes,
        rankCost: ranked ? ranked.cost ?? null : null,
        rankedOnPin: ranked !== undefined && ranked === pinned,
      };
    })
    .sort((a, b) => {
      const left = a.rankCost ?? Number.POSITIVE_INFINITY;
      const right = b.rankCost ?? Number.POSITIVE_INFINITY;
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
  cost: string;
  prompt: string;
  completion: string;
  cacheRead: string;
  cacheWrite: string;
  ctx: string;
  upstream: string;
  tags: string[];
}

/** A cache rate, or `-` when the node announced none (`0` means unpriced, not free). */
function cacheRate(perToken: number | undefined): string {
  return perToken ? satsPerMillion(perToken) : "-";
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
    // The sort key, in sats for one warm request: the rate columns below are
    // per million tokens, so the ordering is not readable off them alone.
    cost:
      typeof route.cost === "number" && Number.isFinite(route.cost)
        ? route.cost.toFixed(2)
        : "-",
    prompt: route.pricing ? satsPerMillion(route.pricing.prompt) : "-",
    completion: route.pricing ? satsPerMillion(route.pricing.completion) : "-",
    cacheRead: cacheRate(route.pricing?.input_cache_read),
    cacheWrite: cacheRate(route.pricing?.input_cache_write),
    ctx: route.contextLength === null ? "-" : route.contextLength.toLocaleString(),
    upstream: upstreamLabel(route),
    tags,
  };
}

/** One node block: a rank header plus its route table. */
function renderNode(node: ModelPathNode, rank: number, requestedId: string): string[] {
  const metric =
    node.rankCost === null
      ? node.routes.some((route) => route.onCooldown)
        ? "rank unavailable (no priced route off cooldown)"
        : "rank unavailable (no priced route)"
      : `rank ${node.rankCost.toFixed(2)} sats/request ${
          node.rankedOnPin ? "(pinned route)" : "(cheapest route)"
        }`;
  // A disabled node is priced and ranked like any other, so the tag is what
  // keeps its rows from reading as routes a request could take.
  const flags = node.disabled ? "  [disabled]" : "";
  const routes = node.routes.map((route) => toRow(route, requestedId));

  const width = (select: (row: RouteRow) => string, header: string) =>
    Math.max(header.length, ...routes.map((row) => select(row).length));
  const costWidth = width((row) => row.cost, "cost");
  const promptWidth = width((row) => row.prompt, "prompt");
  const completionWidth = width((row) => row.completion, "completion");
  const cacheReadWidth = width((row) => row.cacheRead, "cache read");
  const cacheWriteWidth = width((row) => row.cacheWrite, "cache write");
  const ctxWidth = width((row) => row.ctx, "ctx");
  const upstreamWidth = width((row) => row.upstream, "upstream");

  const lines = [
    `  ${String(rank).padStart(2)}. ${node.baseUrl}  ${node.routes.length} route${
      node.routes.length === 1 ? "" : "s"
    }  ${metric}${flags}`,
    "",
    `        ${"cost".padEnd(costWidth)}  ${"prompt".padEnd(promptWidth)}  ${"completion".padEnd(completionWidth)}  ${"cache read".padEnd(cacheReadWidth)}  ${"cache write".padEnd(cacheWriteWidth)}  ${"ctx".padEnd(ctxWidth)}  upstream`,
  ];
  for (const row of routes) {
    const cells = [
      row.cost.padEnd(costWidth),
      row.prompt.padEnd(promptWidth),
      row.completion.padEnd(completionWidth),
      row.cacheRead.padEnd(cacheReadWidth),
      row.cacheWrite.padEnd(cacheWriteWidth),
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
      "  nodes by what one warm request would cost on the route routing would use first",
      hasPin
        ? "  (the [pin] route when the node advertises one, else its cheapest route); nodes with"
        : "  (the node's cheapest advertised route); nodes with",
      "  no priced route come last, and routes are cheapest cost first inside a node.",
      "  cost = sats for the SDK's WARM_COST_BASKET (100k prompt tokens at a 90% cache hit,",
      "  2k completion) — the basket getProviderPriceRankingForModel ranks routing on. The",
      "  prompt/completion/cache columns are sats per million tokens.",
      "  A \"-\" cache cell means the node advertises no cache rate there, so those tokens",
      "  bill at the prompt rate.",
    );
    if (hasPin) {
      lines.push(
        "  [pin] marks the first route the router pins on that node (the SDK's model-path",
        "  whitelist order, which governs its auto-pinned model).",
      );
    }
    if (output.nodes.some((node) => node.disabled)) {
      lines.push(
        "  [disabled] marks a node routing currently excludes: it carries its price and",
        "  rank position like any other node, but no request is routed to it.",
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
