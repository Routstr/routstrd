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

export function createModelService(modelManager: ModelManager, store: SdkStore) {
  let providerBootstrapPromise: Promise<void> | null = null;

  const ensureProvidersBootstrapped = (): Promise<void> => {
    if (!providerBootstrapPromise) {
      providerBootstrapPromise = (async () => {
        logger.log("Bootstrapping providers...");
        const providers = await modelManager.bootstrapProviders(false);
        logger.log(`Bootstrapped ${providers.length} providers`);
        await modelManager.fetchModels(providers);

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
      baseUrls,
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

  return {
    ensureProvidersBootstrapped,
    getRoutstr21Models,
    getModelProviders,
  };
}
