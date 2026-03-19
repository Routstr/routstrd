import { existsSync, mkdirSync } from "fs";
import { readFile, writeFile } from "fs/promises";
import { dirname, join } from "path";
import type { RoutstrdConfig } from "../utils/config";
import { logger } from "../utils/logger";

const PI_CONFIG_PATH = join(process.env.HOME || "", ".pi/agent/models.json");

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

export async function installPiIntegration(config: RoutstrdConfig): Promise<void> {
  logger.log("\nInstalling routstr models in pi models.json...");

  const port = config.port || 8008;
  const baseUrl = `http://localhost:${port}/v1`;

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

    // Preserve existing apiKey if present
    const existingApiKey = piConfig.providers["routstr"]?.apiKey;

    piConfig.providers["routstr"] = {
      baseUrl,
      api: "openai-completions",
      apiKey: existingApiKey || "placeholder",
      models: providerModels,
    };

    await writeFile(PI_CONFIG_PATH, JSON.stringify(piConfig, null, 2));
    logger.log(`Added "routstr" provider with ${models.length} models to pi models.json`);
  } catch (error) {
    logger.error("Failed to install models in pi models.json:", error);
  }
}
