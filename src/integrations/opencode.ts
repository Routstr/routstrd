import { existsSync, mkdirSync } from "fs";
import { readFile, writeFile } from "fs/promises";
import { dirname, join } from "path";
import type { RoutstrdConfig } from "../utils/config";
import { logger } from "../utils/logger";

const OPENCODE_CONFIG_PATH = join(process.env.HOME || "", ".config/opencode/opencode.json");
const OPENCODE_SMALL_MODEL = "routstr/minimax-m2.5";

export async function installOpencodeIntegration(config: RoutstrdConfig): Promise<void> {
  logger.log("\nInstalling routstr models in opencode.json...");

  const port = config.port || 8008;

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
    if (existsSync(OPENCODE_CONFIG_PATH)) {
      const content = await readFile(OPENCODE_CONFIG_PATH, "utf-8");
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
    mkdirSync(dirname(OPENCODE_CONFIG_PATH), { recursive: true });

    const response = await fetch(`http://localhost:${port}/models`);
    const data = await response.json() as { output?: { models: string[] } };
    const models = data.output?.models || [];

    if (models.length === 0) {
      logger.log("No models found from routstr daemon.");
      return;
    }

    const modelsObj: Record<string, { name: string }> = {};
    for (const model of models) {
      modelsObj[model] = { name: model };
    }

    opencodeConfig.provider["routstr"] = {
      npm: "@ai-sdk/openai-compatible",
      name: "routstr",
      options: {
        baseURL: `http://localhost:${port}/`,
        apiKey: "",
        includeUsage: true,
      },
      models: modelsObj,
    };
    opencodeConfig.small_model = OPENCODE_SMALL_MODEL;

    await writeFile(OPENCODE_CONFIG_PATH, JSON.stringify(opencodeConfig, null, 2));
    logger.log(`Added "routstr" provider with ${models.length} models to opencode.json`);
  } catch (error) {
    logger.error("Failed to install models in opencode.json:", error);
  }
}
