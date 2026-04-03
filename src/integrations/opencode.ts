import { existsSync, mkdirSync } from "fs";
import { readFile, writeFile } from "fs/promises";
import { dirname } from "path";
import type { RoutstrdConfig } from "../utils/config";
import { logger } from "../utils/logger";
import type { SdkStore } from "@routstr/sdk";
import type { IntegrationConfig, RoutstrModel } from "./registry";
import { generateApiKey } from "./registry";

const OPENCODE_SMALL_MODEL = "routstr/minimax-m2.5";

export async function installOpencodeIntegration(
  config: RoutstrdConfig,
  store: SdkStore,
  integrationConfig: IntegrationConfig,
): Promise<void> {
  const { clientId, name, configPath } = integrationConfig;

  logger.log("\nInstalling routstr models in opencode.json...");

  const port = config.port || 8008;

  // Get or create clientId entry for OpenCode
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

  let opencodeConfig: {
    provider?: Record<string, {
      npm?: string;
      name?: string;
      options?: {
        baseURL?: string;
        apiKey?: string;
        includeUsage?: boolean;
      };
      models?: Record<string, { name: string }>;
    }>;
    small_model?: string;
  };

  try {
    if (existsSync(configPath)) {
      const content = await readFile(configPath, "utf-8");
      opencodeConfig = JSON.parse(content);
    } else {
      opencodeConfig = { provider: {} };
    }
  } catch {
    opencodeConfig = { provider: {} };
  }

  if (!opencodeConfig.provider) {
    opencodeConfig.provider = {};
  }

  try {
    mkdirSync(dirname(configPath), { recursive: true });

    const response = await fetch(`http://localhost:${port}/models`);
    const data = await response.json() as { output?: { models: RoutstrModel[] } };
    const models = data.output?.models || [];

    if (models.length === 0) {
      logger.log("No models found from routstr daemon.");
      return;
    }

    const modelsObj: Record<string, { name: string }> = {};
    for (const model of models) {
      modelsObj[model.id] = { name: model.name || model.id };
    }

    opencodeConfig.provider["routstr"] = {
      npm: "@ai-sdk/openai-compatible",
      name: "routstr",
      options: {
        baseURL: `http://localhost:${port}/`,
        apiKey,
        includeUsage: true,
      },
      models: modelsObj,
    };
    opencodeConfig.small_model = OPENCODE_SMALL_MODEL;

    await writeFile(configPath, JSON.stringify(opencodeConfig, null, 2));
    logger.log(`Added "routstr" provider with ${models.length} models to opencode.json`);
  } catch (error) {
    logger.error("Failed to install models in opencode.json:", error);
  }
}
