import { ModelManager, type SdkStore } from "@routstr/sdk";
import type { ExposedModel } from "./types";
import { logger } from "../utils/logger";

export type ModelProviderInfo = {
  baseUrl: string;
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
  store: SdkStore,
  forcedProvider?: string,
) {
  let providerBootstrapPromise: Promise<void> | null = null;

  /**
   * Returns the set of disabled provider base URLs (normalized with trailing
   * slash, matching the SDK's convention) so callers can skip them before
   * passing a provider list to `fetchModels`.
   */
  const getDisabledProviderSet = (): Set<string> => {
    const raw: string[] = store.getState().disabledProviders || [];
    return new Set(
      raw.map((url) => (url.endsWith("/") ? url : `${url}/`)),
    );
  };

  /**
   * Filter a list of provider base URLs, removing any that are currently
   * disabled in the store. This prevents wasteful HTTP requests to providers
   * the user has explicitly disabled.
   */
  const filterDisabled = (providers: string[]): string[] => {
    const disabled = getDisabledProviderSet();
    if (disabled.size === 0) return providers;
    const filtered = providers.filter(
      (url) => {
        const base = url.endsWith("/") ? url : `${url}/`;
        return !disabled.has(base);
      },
    );
    if (filtered.length < providers.length) {
      logger.log(
        `Skipped ${providers.length - filtered.length} disabled provider(s) before model fetch`,
      );
    }
    return filtered;
  };

  const ensureProvidersBootstrapped = (): Promise<void> => {
    if (!providerBootstrapPromise) {
      providerBootstrapPromise = (async () => {
        logger.log("Bootstrapping providers...");
        const providers = await modelManager.bootstrapProviders(false);
        logger.log(`Bootstrapped ${providers.length} providers`);

        // Ensure the forced provider is always included in the model fetch,
        // even if it wasn't discovered via Nostr (e.g. localhost:8011).
        // The forced provider is explicitly configured by the operator and
        // should NEVER be filtered out by filterDisabled() — the Nostr
        // review/disable system may mark localhost providers as disabled,
        // but the operator's --provider flag overrides that.
        let fetchList = providers;
        if (forcedProvider) {
          const normalized = forcedProvider.endsWith("/")
            ? forcedProvider
            : `${forcedProvider}/`;
          if (!providers.includes(normalized)) {
            fetchList = [normalized, ...providers];
            logger.log(
              `Adding forced provider ${normalized} to model fetch list`,
            );
          }
          // Remove forced provider from the disabled set so filterDisabled
          // doesn't strip it. Re-enable locally regardless of Nostr reviews.
          const disabled = store.getState().disabledProviders || [];
          if (disabled.includes(normalized)) {
            const updated = disabled.filter((u: string) => u !== normalized);
            store.getState().setDisabledProviders(updated);
            logger.log(
              `Re-enabling forced provider ${normalized} (was disabled by Nostr reviews)`,
            );
          }
        }

        await modelManager.fetchModels(filterDisabled(fetchList));

        // Sync discovered providers into the store so `providers list` reflects
        // the same set that the model manager knows about.
        const { baseUrlsList, setBaseUrlsList } = store.getState();
        const existing = new Set(baseUrlsList);
        const merged = [
          ...baseUrlsList,
          ...providers.filter((url) => !existing.has(url)),
        ];
        if (merged.length !== baseUrlsList.length) {
          setBaseUrlsList(merged);
          logger.log(
            `Synced ${merged.length - baseUrlsList.length} new provider(s) into store`,
          );
        }

        logger.log("Provider bootstrap complete.");
      })().catch((error) => {
        logger.error("Provider bootstrap failed:", error);
        throw error;
      });
    }
    return providerBootstrapPromise;
  };

  const getRoutstr21Models = async (
    forceRefresh = false,
  ): Promise<ExposedModel[]> => {
    await ensureProvidersBootstrapped();

    const routstr21ModelIds = Array.from(
      new Set(await modelManager.fetchRoutstr21Models(forceRefresh)),
    ).slice(0, 21);
    const baseUrls = modelManager.getBaseUrls();
    const discoveredModels = await modelManager.fetchModels(
      filterDisabled(baseUrls),
      forceRefresh,
    );
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

    const allModels = modelManager.getAllCachedModels();
    const providers: ModelProviderInfo[] = [];

    for (const [baseUrl, models] of Object.entries(allModels)) {
      const model = models.find((m) => m.id === modelId);
      if (model && model.sats_pricing) {
        providers.push({
          baseUrl,
          pricing: {
            prompt: model.sats_pricing.prompt,
            completion: model.sats_pricing.completion,
            request: model.sats_pricing.request,
            max_cost: model.sats_pricing.max_cost,
          },
        });
      }
    }

    // Sort by max_cost (cheapest first)
    providers.sort((a, b) => a.pricing.max_cost - b.pricing.max_cost);

    if (providers.length === 0) {
      return null;
    }

    // Get model metadata from first provider that has it
    const cheapest = providers[0]!;
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

    // Force-refresh models from all enabled providers.
    // Ensure the forced provider is always included even if not on Nostr.
    let refreshList = providers;
    if (forcedProvider) {
      const normalized = forcedProvider.endsWith("/")
        ? forcedProvider
        : `${forcedProvider}/`;
      if (!providers.includes(normalized)) {
        refreshList = [normalized, ...providers];
      }
    }
    const models = await modelManager.fetchModels(filterDisabled(refreshList), true);
    console.log(`Fetched ${models.length} models from ${providers.length} providers`);

    // Sync review events from Nostr (kind 38425) and apply disabled status
    const reviewedDisabled = await modelManager.syncReviewedProvidersFromNostr(
      providers,
      undefined,
      true,
    );
    if (reviewedDisabled.length > 0) {
      console.log(
        `Review sync disabled ${reviewedDisabled.length} provider(s): ${reviewedDisabled.join(", ")}`,
      );
    }

    // Sync discovered providers into the store
    const { baseUrlsList, setBaseUrlsList, disabledProviders, setDisabledProviders } =
      store.getState() as any;

    // Replace baseUrlsList with the fresh provider list
    setBaseUrlsList(providers);

    // Merge review-disabled providers into the store's disabled list
    const existingDisabled = new Set(disabledProviders || []);
    for (const url of reviewedDisabled) {
      existingDisabled.add(url);
    }
    setDisabledProviders([...existingDisabled]);

    console.log(
      `Provider refresh complete: ${providers.length} total, ${existingDisabled.size} disabled`,
    );
  };

  return {
    ensureProvidersBootstrapped,
    getRoutstr21Models,
    getModelProviders,
    refreshProvidersAndModels,
  };
}
