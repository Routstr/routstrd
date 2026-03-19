import { ModelManager } from "@routstr/sdk";
import type { ExposedModel } from "./types";
import { logger } from "../utils/logger";

export function createModelService(modelManager: ModelManager) {
  let providerBootstrapPromise: Promise<void> | null = null;

  const ensureProvidersBootstrapped = (): Promise<void> => {
    if (!providerBootstrapPromise) {
      providerBootstrapPromise = (async () => {
        logger.log("Bootstrapping providers...");
        const providers = await modelManager.bootstrapProviders(false);
        logger.log(`Bootstrapped ${providers.length} providers`);
        await modelManager.fetchModels(providers);
        logger.log("Provider bootstrap complete.");
      })().catch((error) => {
        logger.error("Provider bootstrap failed:", error);
        throw error;
      });
    }
    return providerBootstrapPromise;
  };

  const getRoutstr21Models = async (): Promise<ExposedModel[]> => {
    await ensureProvidersBootstrapped();

    const routstr21ModelIds = Array.from(
      new Set(await modelManager.fetchRoutstr21Models()),
    ).slice(0, 21);
    const baseUrls = modelManager.getBaseUrls();
    const discoveredModels = await modelManager.fetchModels(baseUrls);
    const modelsById = new Map(discoveredModels.map((model) => [model.id, model]));

    return routstr21ModelIds.map((modelId) => {
      const model = modelsById.get(modelId);
      return model || { id: modelId, name: modelId };
    });
  };

  return {
    ensureProvidersBootstrapped,
    getRoutstr21Models,
  };
}
