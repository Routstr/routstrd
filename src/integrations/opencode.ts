import { randomBytes } from "crypto";
import { existsSync, mkdirSync } from "fs";
import { readFile, writeFile } from "fs/promises";
import { dirname, join } from "path";
import type { RoutstrdConfig } from "../utils/config";
import { logger } from "../utils/logger";
import type { SdkStore } from "@routstr/sdk";

const OPENCODE_CONFIG_PATH = join(process.env.HOME || "", ".config/opencode/opencode.json");
const OPENCODE_SMALL_MODEL = "routstr/minimax-m2.5";
const OPENCODE_CLIENT_ID = "opencode";
const OPENCODE_NAME = "OpenCode";

type RoutstrModel = {
  id: string;
  name?: string;
};

function generateApiKey(): string {
  const bytes = randomBytes(24);
  return `sk-${bytes.toString("hex")}`;
}

export async function installOpencodeIntegration(
  config: RoutstrdConfig,
  store: SdkStore,
): Promise<void> {
  logger.log("\nInstalling routstr models in opencode.json...");

  const port = config.port || 8008;

  // Get or create clientId entry for OpenCode
  const state = store.getState();
  const existingClient = (state.clientIds || []).find(
    (c: { clientId: string }) => c.clientId === OPENCODE_CLIENT_ID,
  );

  let apiKey: string;
  if (existingClient) {
    apiKey = existingClient.apiKey;
    logger.log(`Using existing API key for ${OPENCODE_NAME}`);
  } else {
    apiKey = generateApiKey();
    // Add new clientId entry
    store.setState((prev: { clientIds: any[] }) => ({
      clientIds: [
        ...(prev.clientIds || []),
        {
          clientId: OPENCODE_CLIENT_ID,
          name: OPENCODE_NAME,
          apiKey,
          createdAt: Date.now(),
        },
      ],
    }));
    logger.log(`Created new API key for ${OPENCODE_NAME}`);
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

    await writeFile(OPENCODE_CONFIG_PATH, JSON.stringify(opencodeConfig, null, 2));
    logger.log(`Added "routstr" provider with ${models.length} models to opencode.json`);
  } catch (error) {
    logger.error("Failed to install models in opencode.json:", error);
  }
}
