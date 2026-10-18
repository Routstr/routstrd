import {
  canonicalIdForModel,
  canonicalizeModelId,
  canonicalModelPath,
  clearModelPathsCache,
  DEEPSEEK_AUTO_MODEL_ID,
  findModelForId,
  getNodeModelPathsForModel,
  ModelManager,
  MODEL_PATH_RANKING_BUDGET_MS,
  ProviderManager,
  resolveDeepSeekModelPathSelectors,
  type MintDiscovery,
  type Model,
  type NodeModelPaths,
  type SdkStore,
} from "@routstr/sdk";
import type { ExposedModel } from "./types";
import { logger } from "../utils/logger";
import {
  decodeModelPathSelector,
  rankModelPathNodes,
  type ModelPathNode,
  type ModelPathPricingSource,
  type ModelPathRoute,
  type ModelPathSkipped,
  type ModelPathsOutput,
} from "../utils/model-paths";

export type ModelProviderInfo = {
  baseUrl: string;
  disabled: boolean;
  pricing: {
    prompt: number;
    completion: number;
    request: number;
    max_cost: number;
  };
};

export type ModelWithProviders = ExposedModel & {
  providers: ModelProviderInfo[];
};

/** Per-model path lookup, injectable so tests never touch the network. */
export type NodeModelPathsFetcher = typeof getNodeModelPathsForModel;

/**
 * Sentinel for a node whose model-path lookup outlived the ranking budget.
 * The SDK bounds its own routing ranking the same way: one slow node must not
 * hold up the whole inventory. The lookup itself keeps running and fills the
 * SDK's cache for the next caller.
 */
const PATHS_BUDGET_EXCEEDED = Symbol("model-paths-budget-exceeded");

function withBudget<T>(
  work: Promise<T>,
  budgetMs: number,
): Promise<T | typeof PATHS_BUDGET_EXCEEDED> {
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve(PATHS_BUDGET_EXCEEDED), budgetMs);
    work.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      () => {
        clearTimeout(timer);
        resolve(PATHS_BUDGET_EXCEEDED);
      },
    );
  });
}

/**
 * Why a node that serves the model is missing from the path inventory. Kept
 * as stable strings: they are rendered verbatim by the CLI.
 */
const SKIP_ON_COOLDOWN = "on cooldown";
const SKIP_NO_PATHS = "no model paths advertised";
const SKIP_LOOKUP_TIMEOUT = "model-path lookup timed out";
const SKIP_LOOKUP_FAILED = "model-path lookup failed";

export function createModelService(
  modelManager: ModelManager,
  providerManager: ProviderManager,
  store: SdkStore,
  mintDiscovery?: MintDiscovery,
  deps: { fetchNodeModelPaths?: NodeModelPathsFetcher } = {},
) {
  const fetchNodeModelPaths =
    deps.fetchNodeModelPaths ?? getNodeModelPathsForModel;
  let providerBootstrapPromise: Promise<void> | null = null;
  let mintDiscoveryPromise: Promise<void> | null = null;
  let modelPopulationPromise: Promise<ExposedModel[]> | null = null;
  let modelPopulationStartedCold = false;

  const scheduleMintDiscovery = (providers: string[]): void => {
    if (!mintDiscovery || mintDiscoveryPromise) return;
    const discovery = mintDiscovery;
    mintDiscoveryPromise = Promise.resolve()
      .then(async () => {
        await discovery.discoverMints(providers);
        logger.log(`Discovered mints for ${providers.length} provider(s)`);
      })
      .catch((error) => logger.error("Mint discovery failed:", error))
      .finally(() => { mintDiscoveryPromise = null; });
  };

  const normalizeBaseUrl = (url: string): string =>
    url.endsWith("/") ? url : `${url}/`;

  /**
   * Build the same cheapest-per-model view as ModelManager.fetchModels, but
   * exclusively from the persisted cache. Model-list reads must not wait for
   * unavailable providers; explicit and scheduled refreshes own network I/O.
   */
  const getCachedModels = (): ExposedModel[] => {
    type PricedModel = ExposedModel & {
      sats_pricing?: { completion?: number };
    };

    const cachedByProvider = modelManager.getAllCachedModels();
    const currentProviders = new Set(
      modelManager.getBaseUrls().map(normalizeBaseUrl),
    );
    const s = store.getState();
    const manuallyEnabled = new Set(
      (s.manuallyEnabledProviders || []).map(normalizeBaseUrl),
    );
    const disabledProviders = new Set(
      [
        ...(s.disabledProviders || []),
        ...(s.manuallyDisabledProviders || []),
      ]
        .map(normalizeBaseUrl)
        .filter((url) => !manuallyEnabled.has(url)),
    );
    const bestById = new Map<string, PricedModel>();

    for (const [baseUrl, models] of Object.entries(cachedByProvider)) {
      const normalized = normalizeBaseUrl(baseUrl);
      if (
        disabledProviders.has(normalized) ||
        (currentProviders.size > 0 && !currentProviders.has(normalized))
      ) {
        continue;
      }

      for (const model of models as PricedModel[]) {
        if (!model.sats_pricing) continue;
        // Group by canonical id so providers serving the same model under a
        // mapped variant id or alias fold into one aggregate entry.
        const canonicalId = canonicalIdForModel(model as Model);
        const existing = bestById.get(canonicalId);
        if (
          !existing ||
          (model.sats_pricing.completion ?? 0) <
            (existing.sats_pricing?.completion ?? 0)
        ) {
          bestById.set(canonicalId, model);
        }
      }
    }

    return [...bestById.values()];
  };

  const ensureProvidersBootstrapped = (): Promise<void> => {
    if (!providerBootstrapPromise) {
      providerBootstrapPromise = (async () => {
        const startedAt = Date.now();
        logger.log("Bootstrapping providers...");
        const providers = await modelManager.bootstrapProviders(false);
        logger.log(`Bootstrapped ${providers.length} providers`);

        // Mirror discovery into the store so `providers list` reports the same
        // set that the model manager polls and routes to. The list is
        // *replaced*, not merged: an add-only merge keeps URLs discovery no
        // longer reports (e.g. after a bootstrap regression or a provider
        // unpublishing) visible to the CLI and to per-model views while
        // routing silently ignores them.
        const {
          baseUrlsList,
          setBaseUrlsList,
          setDisabledProviders,
        } = store.getState();
        const known = new Set(baseUrlsList);
        const inSync =
          known.size === providers.length &&
          providers.every((url) => known.has(url));
        if (!inSync) {
          setBaseUrlsList(providers);
          logger.log(
            `Synced ${providers.length} discovered provider(s) into store (was ${baseUrlsList.length})`,
          );
        }

        // Mirror the review-disabled set (kind 38425) into the store. The SDK
        // applies review disables to the discovery adapter during bootstrap,
        // but `providers list` and the per-model provider views read the store,
        // so without this a fresh install reports "0 disabled" while routing
        // silently excludes the review-disabled providers.
        const reviewedDisabled = await modelManager.syncReviewedProvidersFromNostr(
          providers,
        );
        if (reviewedDisabled !== null) {
          setDisabledProviders(reviewedDisabled);
        }

        logger.log(
          `Provider bootstrap complete in ${((Date.now() - startedAt) / 1000).toFixed(1)}s.`,
        );

        // Populate the mint cache for every enabled provider. The SDK refuses
        // to spend a mint a provider does not advertise, so without this the
        // routing layer spends the wallet's largest mint and gets rejected
        // (finding #4). MintDiscovery owns its own 21-minute TTL, so repeated
        // calls within that window are cache hits and never refetch.
        scheduleMintDiscovery(providers);
      })().catch((error) => {
        providerBootstrapPromise = null;
        logger.error("Provider bootstrap failed:", error);
        throw error;
      });
    }
    return providerBootstrapPromise;
  };

  const exposeModels = (
    routstr21ModelIds: string[],
    discoveredModels: ExposedModel[],
  ): ExposedModel[] => {
    // Resolve each routstr21 id against the aggregated provider models. The
    // aggregation folds providers' mapped variant ids/aliases into one entry
    // per canonical id, but the surviving entry is the provider's raw model,
    // whose `.id` may be the variant (e.g. z-ai-glm-5-3-flash) — while still
    // carrying the full metadata (context_length, architecture, reasoning).
    // A plain id map would miss and degrade the entry to a bare stub, so
    // resolve through the SDK's model mappings (exact native id wins, same as
    // getModelProviders) and always expose the requested canonical id.
    return [...new Set(routstr21ModelIds)].map((modelId) => {
      const model = findModelForId(discoveredModels as Model[], modelId);
      return model
        ? { ...model, id: modelId }
        : { id: modelId, name: modelId };
    });
  };

  const getRoutstr21Models = async (
    forceRefresh = false,
    refreshExpired = false,
  ): Promise<ExposedModel[]> => {
    // Incremental SDK writes are not a complete warm cache. A pass which
    // started genuinely cold must finish before any reader exposes its models.
    if (modelPopulationPromise && modelPopulationStartedCold) {
      return modelPopulationPromise;
    }
    const cachedModels = getCachedModels();
    // Regular warm reads stay independent of forced/startup refreshes. Startup
    // opts into SDK TTL checks without forcing every cached provider to refetch.
    if (!forceRefresh && !refreshExpired && cachedModels.length > 0) {
      return exposeModels(
        await modelManager.fetchRoutstr21Models(false),
        cachedModels,
      );
    }

    // Cold readers and startup/explicit refreshes share one population pass.
    // A force request joins an existing pass rather than launching another.
    if (!modelPopulationPromise) {
      modelPopulationStartedCold = cachedModels.length === 0;
      modelPopulationPromise = (async () => {
        const startedAt = Date.now();
        // Bootstrap establishes mappings and review policy before aggregation.
        // Its curated-list prefetch also avoids a duplicate cold relay query.
        await ensureProvidersBootstrapped();
        const ids = await modelManager.fetchRoutstr21Models(forceRefresh);
        const models = await modelManager.fetchModels(
          modelManager.getBaseUrls(),
          forceRefresh,
        );
        logger.debug(
          `Model population complete in ${((Date.now() - startedAt) / 1000).toFixed(1)}s.`,
        );
        return exposeModels(ids, models);
      })().finally(() => {
        modelPopulationPromise = null;
        modelPopulationStartedCold = false;
      });
    }
    return modelPopulationPromise;
  };

  const getModelProviders = async (
    modelId: string,
  ): Promise<ModelWithProviders | null> => {
    await ensureProvidersBootstrapped();

    const s = store.getState();
    const manuallyEnabled = new Set<string>(
      (s.manuallyEnabledProviders || []).map(normalizeBaseUrl),
    );
    const disabledSet = new Set<string>(
      [
        ...(s.disabledProviders || []),
        ...(s.manuallyDisabledProviders || []),
      ].filter((url) => !manuallyEnabled.has(normalizeBaseUrl(url))),
    );

    // Use the SDK ranking (sorted by prompt+completion per million tokens)
    // so the display order matches real routing. includeDisabled keeps
    // disabled providers visible so we can annotate them.
    const ranking = providerManager.getProviderPriceRankingForModel(modelId, {
      includeDisabled: true,
    });

    const providers: ModelProviderInfo[] = ranking.map((entry: any) => ({
      baseUrl: entry.baseUrl,
      disabled: disabledSet.has(entry.baseUrl),
      pricing: {
        prompt: entry.promptPerMillion / 1_000_000,
        completion: entry.completionPerMillion / 1_000_000,
        request: entry.model.sats_pricing?.request ?? 0,
        max_cost: entry.model.sats_pricing?.max_cost ?? 0,
      },
    }));

    if (providers.length === 0) {
      return null;
    }

    // Get model metadata. Prefer a provider that serves the requested
    // canonical id natively (nicest name/description); fall back to the
    // cheapest provider matched through the SDK's model mappings, since it
    // may only know the model under a mapped variant id or alias.
    const cheapest = providers[0]!;
    const allModels = modelManager.getAllCachedModels();
    let modelInfo: Model | undefined;
    for (const p of providers) {
      const exact = (allModels[p.baseUrl] as Model[] | undefined)?.find(
        (m) => m.id === modelId,
      );
      if (exact) {
        modelInfo = exact;
        break;
      }
    }
    if (!modelInfo) {
      const firstProvider = allModels[cheapest.baseUrl];
      modelInfo = firstProvider
        ? findModelForId(firstProvider as Model[], modelId)
        : undefined;
    }

    if (!modelInfo) {
      return null;
    }

    return {
      id: modelId,
      name: modelInfo.name,
      description: modelInfo.description,
      context_length: modelInfo.context_length,
      providers,
    };
  };

  /**
   * One node's advertised model paths for a model, decoded and priced.
   *
   * Routes are gathered across every spelling the node files the model under
   * (the fetcher probes the canonical id, its mapping variants, and the
   * node's own id/alias_ids), then deduplicated by the selector's canonical
   * identity — two selectors naming the same upstream route must not be
   * listed twice, while a route with a different upstream model-id spelling
   * stays distinct, because pinning it also changes the request body.
   *
   * Pricing is the route's own `sats_pricing`; a node that advertises no
   * per-route metadata falls back to its model-level catalog price, which is
   * what routing ranks such a node on too. When `pinWhitelistedRoutes` is
   * set, the pinned route is the first whitelisted route the node advertises
   * (`resolveDeepSeekModelPathSelectors` order, skipping routes on cooldown)
   * — the same route routing would use.
   */
  const buildModelPathRoutes = (
    baseUrl: string,
    nodePaths: NodeModelPaths,
    model: Model,
    requestedId: string,
    mappings: ReturnType<ModelManager["getModelIdMappings"]>,
    pinWhitelistedRoutes: boolean,
  ): ModelPathRoute[] => {
    type StagedRoute = ModelPathRoute & { identity: string };

    const preferredOrder: string[] = [];
    if (pinWhitelistedRoutes) {
      const resolved = resolveDeepSeekModelPathSelectors(
        nodePaths,
        requestedId,
        mappings,
      );
      for (const selector of resolved?.selectors ?? []) {
        if (!selector) continue;
        const identity = canonicalModelPath(selector) ?? selector;
        if (!preferredOrder.includes(identity)) preferredOrder.push(identity);
      }
    }

    const byIdentity = new Map<string, StagedRoute>();
    const modelPricing = model.sats_pricing;
    for (const entry of nodePaths.data) {
      for (const { path, model: pathMeta } of entry.paths) {
        if (!path) continue;
        const identity = canonicalModelPath(path) ?? path;
        if (byIdentity.has(identity)) continue;
        const decoded = decodeModelPathSelector(path);
        const pathPricing = pathMeta?.sats_pricing ?? null;
        const pricing = pathPricing ?? modelPricing ?? null;
        const pricingSource: ModelPathPricingSource = pathPricing
          ? "path"
          : modelPricing
            ? "model"
            : "none";
        byIdentity.set(identity, {
          identity,
          path,
          upstream: decoded?.upstream ?? path,
          endpoint: decoded?.endpoint ?? null,
          modelId: decoded?.modelId ?? null,
          pricing: pricing
            ? {
                prompt: pricing.prompt ?? 0,
                completion: pricing.completion ?? 0,
                request: pricing.request ?? 0,
                max_cost: pricing.max_cost ?? 0,
              }
            : null,
          pricingSource,
          contextLength:
            pathMeta?.context_length ?? model.context_length ?? null,
          maxCompletionTokens: pathMeta?.max_completion_tokens ?? null,
          onCooldown: providerManager.isOnCooldown(
            baseUrl,
            requestedId,
            identity,
          ),
          pinned: false,
        });
      }
    }

    const routes = [...byIdentity.values()];
    const pin = preferredOrder
      .map((identity) => routes.find((route) => route.identity === identity))
      .find((route) => route !== undefined && !route.onCooldown);
    if (pin) pin.pinned = true;

    return routes.map(({ identity: _identity, ...route }) => route);
  };

  /**
   * The advertised model-path inventory of one model, across every enabled
   * node that serves it.
   *
   * Ranking matches the router (`rankModelPathNodes`): a node's metric is the
   * completion price of the route routing would use first — its preferred
   * whitelisted route when it advertises one, else its cheapest route — so the
   * display order is the order a request would actually pick from.
   *
   * Nodes on model/provider cooldown, nodes that advertise no paths for the
   * model (an older node without the model-paths endpoint, or one filing the
   * model elsewhere), and lookups that fail or outlive the SDK's ranking
   * budget are reported in `skipped` instead of being silently dropped.
   * Returns null only when no node serves the model at all.
   *
   * `refresh` drops the SDK's cached model-path payloads first, so
   * `models -m <id> --paths --refresh` shows live data; routing refetches on
   * its next request as a result.
   */
  const getModelPaths = async (
    modelId: string,
    refresh = false,
  ): Promise<ModelPathsOutput | null> => {
    await ensureProvidersBootstrapped();
    if (refresh) clearModelPathsCache();

    const s = store.getState();
    const manuallyEnabled = new Set<string>(
      (s.manuallyEnabledProviders || []).map(normalizeBaseUrl),
    );
    const disabledSet = new Set<string>(
      [
        ...(s.disabledProviders || []),
        ...(s.manuallyDisabledProviders || []),
      ]
        .map(normalizeBaseUrl)
        .filter((url) => !manuallyEnabled.has(url)),
    );

    const mappings = modelManager.getModelIdMappings();
    const allModels = modelManager.getAllCachedModels();
    // The whitelist governs one model only: the SDK auto-pins DeepSeek V4.1
    // Flash, and every other model is routed by price. Marking a "pinned"
    // route elsewhere would describe failover routing that never happens.
    const pinWhitelistedRoutes =
      canonicalizeModelId(modelId.trim().toLowerCase(), mappings) ===
      DEEPSEEK_AUTO_MODEL_ID;
    const nodes: ModelPathNode[] = [];
    const skipped: ModelPathSkipped[] = [];

    // Deterministic input order: the inventory must not depend on the cached
    // model map's insertion order (nor may the model metadata it reports).
    const baseUrls = Object.keys(allModels).sort();
    const providersInOrder = baseUrls.map(
      (baseUrl) => (allModels[baseUrl] ?? []) as Model[],
    );

    await Promise.all(
      baseUrls.map(async (baseUrl) => {
        if (disabledSet.has(normalizeBaseUrl(baseUrl))) return;
        const models = (allModels[baseUrl] ?? []) as Model[];
        const model = findModelForId(models, modelId, mappings);
        if (!model) return;

        if (providerManager.isOnCooldown(baseUrl, modelId)) {
          skipped.push({ baseUrl, reason: SKIP_ON_COOLDOWN });
          return;
        }

        const nodePaths = await withBudget(
          fetchNodeModelPaths(baseUrl, modelId, {
            mappings,
            extraSpellings: [model.id, ...(model.alias_ids ?? [])],
          }),
          MODEL_PATH_RANKING_BUDGET_MS,
        );
        if (nodePaths === PATHS_BUDGET_EXCEEDED) {
          skipped.push({ baseUrl, reason: SKIP_LOOKUP_TIMEOUT });
          return;
        }
        if (!nodePaths) {
          skipped.push({ baseUrl, reason: SKIP_LOOKUP_FAILED });
          return;
        }

        const routes = buildModelPathRoutes(
          baseUrl,
          nodePaths,
          model,
          modelId,
          mappings,
          pinWhitelistedRoutes,
        );
        if (routes.length === 0) {
          skipped.push({ baseUrl, reason: SKIP_NO_PATHS });
          return;
        }

        nodes.push({ baseUrl, routes, rankCompletion: null, rankedOnPin: false });
      }),
    );

    // Model metadata: prefer a node that serves the requested id natively
    // (nicest name/description), then any node matched through the SDK's
    // mappings, which may only know a variant spelling.
    let modelInfo: Model | undefined;
    for (const models of providersInOrder) {
      const exact = models.find((m) => m.id === modelId);
      if (exact) {
        modelInfo = exact;
        break;
      }
    }
    if (!modelInfo) {
      for (const models of providersInOrder) {
        modelInfo = findModelForId(models, modelId, mappings);
        if (modelInfo) break;
      }
    }
    if (!modelInfo) return null;

    return {
      id: modelId,
      name: modelInfo.name,
      description: modelInfo.description,
      contextLength: modelInfo.context_length,
      nodes: rankModelPathNodes(nodes),
      skipped: skipped.sort((a, b) => a.baseUrl.localeCompare(b.baseUrl)),
    };
  };

  /**
   * Force-refresh everything: re-fetch Nostr provider discovery events,
   * routstr21 model list, Nostr review events, and models from all enabled
   * providers. Syncs the discovered provider list into the store.
   */
  const refreshProvidersAndModels = async (): Promise<void> => {
    // Reset the bootstrap promise so we don't reuse cached results
    providerBootstrapPromise = null;

    console.log("Force-refreshing providers from Nostr...");

    // Force-refresh provider discovery from Nostr (kind 38421)
    const providers = await modelManager.bootstrapProviders(false, true);
    console.log(`Discovered ${providers.length} providers from Nostr`);

    // Force-refresh routstr21 models from Nostr (kind 38423)
    const routstr21ModelIds = await modelManager.fetchRoutstr21Models(true);
    console.log(`Fetched ${routstr21ModelIds.length} routstr21 model IDs from Nostr`);

    // Force-refresh models from all providers
    const models = await modelManager.fetchModels(providers, true);
    console.log(`Fetched ${models.length} models from ${providers.length} providers`);

    // Refresh each provider's advertised mint list alongside its models so
    // routing always has current mint data (TTL-gated by MintDiscovery).
    scheduleMintDiscovery(providers);

    // Sync review events from Nostr (kind 38425) and apply disabled status
    const reviewedDisabled = await modelManager.syncReviewedProvidersFromNostr(
      providers,
      undefined,
      true,
    );
    if (reviewedDisabled && reviewedDisabled.length > 0) {
      console.log(
        `Review sync disabled ${reviewedDisabled.length} provider(s): ${reviewedDisabled.join(", ")}`,
      );
    }

    // Sync discovered providers into the store
    const { setBaseUrlsList, setDisabledProviders } = store.getState() as any;

    // Replace baseUrlsList with the fresh provider list
    setBaseUrlsList(providers);

    // Mirror the review-disabled set into the store's auto-disabled list.
    // `null` means the review sync left the adapter unchanged (e.g. no lgtm
    // reviews found), so we must not clobber the store list with an empty array.
    if (reviewedDisabled !== null) {
      setDisabledProviders(reviewedDisabled);
    }

    console.log(
      `Provider refresh complete: ${providers.length} total, ${reviewedDisabled?.length ?? store.getState().disabledProviders?.length ?? 0} review-disabled`,
    );
  };

  return {
    ensureProvidersBootstrapped,
    getRoutstr21Models,
    getModelProviders,
    getModelPaths,
    refreshProvidersAndModels,
  };
}
