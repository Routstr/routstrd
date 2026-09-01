import { ModelManager, ProviderManager, type SdkStore } from "@routstr/sdk";
import type { ExposedModel } from "./types";
import { logger } from "../utils/logger";

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

export function createModelService(
  modelManager: ModelManager,
  providerManager: ProviderManager,
  store: SdkStore,
) {
  let providerBootstrapPromise: Promise<void> | null = null;

  const normalizeBaseUrl = (url: string): string =>
    url.endsWith("/") ? url : `${url}/`;

  const getProviderSelection = () => {
    const state = store.getState();
    const baseUrls: string[] = state.baseUrlsList || [];
    const manuallyEnabled = new Set(
      (state.manuallyEnabledProviders || []).map(normalizeBaseUrl),
    );
    const manuallyDisabled = new Set(
      (state.manuallyDisabledProviders || []).map(normalizeBaseUrl),
    );
    const disabled = new Set(
      [
        ...(state.disabledProviders || []),
        ...(state.manuallyDisabledProviders || []),
      ]
        .map(normalizeBaseUrl)
        .filter((url) => !manuallyEnabled.has(url)),
    );
    const enabled = new Set(
      baseUrls
        .map(normalizeBaseUrl)
        .filter((url) => !disabled.has(url)),
    );

    return {
      disabled,
      enabled,
      selectionIsExplicit:
        manuallyEnabled.size > 0 || manuallyDisabled.size > 0,
    };
  };

  const filterEnabledProviders = (providers: string[]): string[] => {
    const { disabled, enabled, selectionIsExplicit } = getProviderSelection();
    const filtered = providers.filter((url) => {
      const normalized = normalizeBaseUrl(url);
      return selectionIsExplicit
        ? enabled.has(normalized)
        : !disabled.has(normalized);
    });

    if (filtered.length !== providers.length) {
      logger.log(
        `Skipped ${providers.length - filtered.length} non-enabled provider(s) before model fetch`,
      );
    }
    return filtered;
  };

  /**
   * Keep discovery visible without silently enabling new providers after the
   * user has made an explicit provider selection.
   */
  const syncDiscoveredProviders = (
    providers: string[],
    replace = false,
  ): void => {
    const state = store.getState();
    const existing: string[] = state.baseUrlsList || [];
    const existingNormalized = new Set(existing.map(normalizeBaseUrl));
    const newlyDiscovered = providers.filter(
      (url) => !existingNormalized.has(normalizeBaseUrl(url)),
    );
    const selectionIsExplicit =
      (state.manuallyEnabledProviders || []).length > 0 ||
      (state.manuallyDisabledProviders || []).length > 0;

    state.setBaseUrlsList(
      replace ? providers : [...existing, ...newlyDiscovered],
    );

    if (selectionIsExplicit && newlyDiscovered.length > 0) {
      state.setManuallyDisabledProviders(
        Array.from(
          new Set([
            ...(state.manuallyDisabledProviders || []),
            ...newlyDiscovered,
          ]),
        ),
      );
      logger.log(
        `Added ${newlyDiscovered.length} newly discovered provider(s) as manually disabled`,
      );
    }
  };

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
        const existing = bestById.get(model.id);
        if (
          !existing ||
          (model.sats_pricing.completion ?? 0) <
            (existing.sats_pricing?.completion ?? 0)
        ) {
          bestById.set(model.id, model);
        }
      }
    }

    return [...bestById.values()];
  };

  const ensureProvidersBootstrapped = (): Promise<void> => {
    if (!providerBootstrapPromise) {
      providerBootstrapPromise = (async () => {
        logger.log("Bootstrapping providers...");
        const providers = await modelManager.bootstrapProviders(false);
        logger.log(`Bootstrapped ${providers.length} providers`);

        syncDiscoveredProviders(providers);

        // Mirror the review-disabled set (kind 38425) into the store. The SDK
        // applies review disables to the discovery adapter during bootstrap,
        // but `providers list` and the per-model provider views read the store,
        // so without this a fresh install reports "0 disabled" while routing
        // silently excludes the review-disabled providers.
        const reviewedDisabled = await modelManager.syncReviewedProvidersFromNostr(
          providers,
        );
        if (reviewedDisabled !== null) {
          store.getState().setDisabledProviders(reviewedDisabled);
        }

        logger.log("Provider bootstrap complete.");
      })().catch((error) => {
        providerBootstrapPromise = null;
        logger.error("Provider bootstrap failed:", error);
        throw error;
      });
    }
    return providerBootstrapPromise;
  };

  const getRoutstr21Models = async (
    forceRefresh = false,
  ): Promise<ExposedModel[]> => {
    const routstr21ModelIds = Array.from(
      new Set(await modelManager.fetchRoutstr21Models(forceRefresh)),
    );

    let discoveredModels: ExposedModel[];
    if (!forceRefresh) {
      discoveredModels = getCachedModels();
    } else {
      discoveredModels = [];
    }

    // Warm reads are cache-only. A cold start and explicit refresh still
    // populate models from the provider network.
    if (forceRefresh || discoveredModels.length === 0) {
      await ensureProvidersBootstrapped();
      discoveredModels = await modelManager.fetchModels(
        filterEnabledProviders(modelManager.getBaseUrls()),
        forceRefresh,
      );
    }

    const modelsById = new Map(discoveredModels.map((model) => [model.id, model]));

    return routstr21ModelIds.map((modelId) => {
      const model = modelsById.get(modelId);
      return model || { id: modelId, name: modelId };
    });
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

    // Get model metadata from first (cheapest) provider
    const cheapest = providers[0]!;
    const allModels = modelManager.getAllCachedModels();
    const firstProvider = allModels[cheapest.baseUrl];
    const modelInfo = firstProvider?.find((m: { id: string }) => m.id === modelId);

    if (!modelInfo) {
      return null;
    }

    return {
      id: modelInfo.id,
      name: modelInfo.name,
      description: modelInfo.description,
      context_length: modelInfo.context_length,
      providers,
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

    syncDiscoveredProviders(providers, true);

    // Sync review events before model HTTP requests so review-disabled
    // providers are never contacted during this refresh.
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

    // Mirror the review-disabled set into the store's auto-disabled list.
    // `null` means the review sync left the adapter unchanged (e.g. no lgtm
    // reviews found), so we must not clobber the store list with an empty array.
    if (reviewedDisabled !== null) {
      store.getState().setDisabledProviders(reviewedDisabled);
    }

    const enabledProviders = filterEnabledProviders(providers);
    const models = await modelManager.fetchModels(enabledProviders, true);
    console.log(
      `Fetched ${models.length} models from ${enabledProviders.length} enabled provider(s)`,
    );

    console.log(
      `Provider refresh complete: ${providers.length} total, ${reviewedDisabled?.length ?? store.getState().disabledProviders?.length ?? 0} review-disabled`,
    );
  };

  return {
    ensureProvidersBootstrapped,
    getRoutstr21Models,
    getModelProviders,
    refreshProvidersAndModels,
  };
}
