import { randomBytes } from "crypto";
import { existsSync, mkdirSync } from "fs";
import { readFile, writeFile } from "fs/promises";
import { dirname, join } from "path";
import type { RoutstrdConfig } from "../utils/config";
import { logger } from "../utils/logger";
import type { SdkStore } from "@routstr/sdk";

const PI_CONFIG_PATH = join(process.env.HOME || "", ".pi/agent/models.json");
const PI_CLIENT_ID = "pi-agent";
const PI_NAME = "Pi Agent";

type RoutstrModel = {
  id: string;
  name?: string;
};

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

function generateApiKey(): string {
  const bytes = randomBytes(24);
  return `sk-${bytes.toString("hex")}`;
}

export async function installPiIntegration(
  config: RoutstrdConfig,
  store: SdkStore,
): Promise<void> {
  logger.log("\nInstalling routstr models in pi models.json...");

  const port = config.port || 8008;
  const baseUrl = `http://localhost:${port}/v1`;

  // Get or create clientId entry for Pi Agent
  const state = store.getState();
  const existingClient = (state.clientIds || []).find(
    (c: { clientId: string }) => c.clientId === PI_CLIENT_ID,
  );

  let apiKey: string;
  if (existingClient) {
    apiKey = existingClient.apiKey;
    logger.log(`Using existing API key for ${PI_NAME}`);
  } else {
    apiKey = generateApiKey();
    // Add new clientId entry using proper store action
    store.getState().setClientIds((prev) => [
      ...(prev || []),
      {
        clientId: PI_CLIENT_ID,
        name: PI_NAME,
        apiKey,
        createdAt: Date.now(),
      },
    ]);
    logger.log(`Created new API key for ${PI_NAME}`);
  }

  let piConfig: PiConfig = {};

  try {
    if (existsSync(PI_CONFIG_PATH)) {
      const content = await readFile(PI_CONFIG_PATH, "utf-8");
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
    mkdirSync(dirname(PI_CONFIG_PATH), { recursive: true });

    const response = await fetch(`http://localhost:${port}/models`);
    const data = await response.json() as { output?: { models: RoutstrModel[] } };
    const models = data.output?.models || [];

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

    await writeFile(PI_CONFIG_PATH, JSON.stringify(piConfig, null, 2));
    logger.log(`Added "routstr" provider with ${models.length} models to pi models.json`);
  } catch (error) {
    logger.error("Failed to install models in pi models.json:", error);
  }
}
