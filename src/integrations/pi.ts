import { existsSync, mkdirSync } from "fs";
import { readFile, writeFile } from "fs/promises";
import { dirname } from "path";
import type { RoutstrdConfig } from "../utils/config";
import { logger } from "../utils/logger";
import type { SdkStore } from "@routstr/sdk";
import type { IntegrationConfig, RoutstrModel } from "./registry";
import { generateApiKey } from "./registry";
import { callDaemon, getDaemonBaseUrl } from "../utils/daemon-client";

type PiModelEntry = {
  id: string;
};

type PiProviderConfig = {
  baseUrl?: string;
  api?: string;
  apiKey?: string;
  models?: PiModelEntry[];
};

type PiConfig = {
  providers?: Record<string, PiProviderConfig>;
};

export async function installPiIntegration(
  config: RoutstrdConfig,
  store: SdkStore,
  integrationConfig: IntegrationConfig,
): Promise<void> {
  const { clientId, name, configPath } = integrationConfig;

  logger.log("\nInstalling routstr models in pi models.json...");

  const baseUrl = `${getDaemonBaseUrl(config)}/v1`;

  // Get or create clientId entry for Pi Agent
  const state = store.getState();
  const existingClient = (state.clientIds || []).find(
    (c: { clientId: string }) => c.clientId === clientId,
  );

  let apiKey: string;
  if (existingClient) {
    apiKey = existingClient.apiKey;
    logger.log(`Using existing API key for ${name}`);
  } else {
    apiKey = generateApiKey();
    // Add new clientId entry using proper store action
    store.getState().setClientIds((prev) => [
      ...(prev || []),
      {
        clientId,
        name,
        apiKey,
        createdAt: Date.now(),
      },
    ]);
    logger.log(`Created new API key for ${name}`);
  }

  let piConfig: PiConfig = {};

  try {
    if (existsSync(configPath)) {
      const content = await readFile(configPath, "utf-8");
      piConfig = JSON.parse(content) as PiConfig;
    }
  } catch {
    piConfig = {};
  }

  if (!piConfig.providers) {
    piConfig.providers = {};
  }

  try {
    // Ensure directory exists
    mkdirSync(dirname(configPath), { recursive: true });

    const data = await callDaemon("/models");
    const models = (data.output as { models: RoutstrModel[] } | undefined)?.models || [];

    if (models.length === 0) {
      logger.log("No models found from routstr daemon.");
      return;
    }

    const providerModels: PiModelEntry[] = models.map((model) => ({
      id: model.id,
    }));

    piConfig.providers["routstr"] = {
      baseUrl,
      api: "openai-completions",
      apiKey,
      models: providerModels,
    };

    await writeFile(configPath, JSON.stringify(piConfig, null, 2));
    logger.log(`Added "routstr" provider with ${models.length} models to pi models.json`);
  } catch (error) {
    logger.error("Failed to install models in pi models.json:", error);
  }
}
