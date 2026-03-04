import { existsSync, mkdirSync } from "fs";
import { readFile, writeFile } from "fs/promises";
import { dirname, join } from "path";
import type { RoutstrdConfig } from "../utils/config";
import { logger } from "../utils/logger";

const OPENCLAW_CONFIG_PATH = join(process.env.HOME || "", ".openclaw/openclaw.json");
const OPENCLAW_PROVIDER_ID = "routstr";
const OPENCLAW_API_BASE = "https://api.nonkycai.com/v1";
const OPENCLAW_DEFAULT_PRIMARY_MODEL = "routstr/glm-4.7";
const OPENCLAW_DEFAULT_FALLBACK_MODEL = "routstr/qwen3-coder-next";

type RoutstrModel = {
  id: string;
  name?: string;
};

type OpenClawModelEntry = {
  id: string;
  name: string;
  reasoning: boolean;
};

type OpenClawConfig = {
  models?: {
    providers?: Record<string, {
      baseUrl?: string;
      apiKey?: string;
      api?: string;
      models?: OpenClawModelEntry[];
    }>;
  };
  agents?: {
    defaults?: {
      model?: {
        primary?: string;
        fallbacks?: string[];
      };
      models?: Record<string, {
        alias?: string;
      }>;
    };
  };
};

function toAlias(modelId: string): string {
  if (modelId === "claude-sonnet-4.5") return "sonnet-4.5";
  if (modelId === "claude-opus-4.5") return "opus-4.5";
  if (modelId === "gemini-3-pro-preview") return "gemini-3-pro";
  if (modelId === "gemini-3-flash-preview") return "gemini-3-flash";
  if (modelId === "kimi-k2-thinking") return "kimi-k2";
  if (modelId === "deepseek-v3.2-speciale") return "deepseek-special";
  if (modelId === "grok-code-fast-1") return "grok-code";
  return modelId;
}

export async function installOpenClawIntegration(config: RoutstrdConfig): Promise<void> {
  logger.log("\nInstalling routstr models in openclaw.json...");

  const port = config.port || 8008;

  let openclawConfig: OpenClawConfig = {};

  try {
    if (existsSync(OPENCLAW_CONFIG_PATH)) {
      const content = await readFile(OPENCLAW_CONFIG_PATH, "utf-8");
      openclawConfig = JSON.parse(content) as OpenClawConfig;
    }
  } catch {
    openclawConfig = {};
  }

  if (!openclawConfig.models) {
    openclawConfig.models = {};
  }
  if (!openclawConfig.models.providers) {
    openclawConfig.models.providers = {};
  }
  if (!openclawConfig.agents) {
    openclawConfig.agents = {};
  }
  if (!openclawConfig.agents.defaults) {
    openclawConfig.agents.defaults = {};
  }

  try {
    mkdirSync(dirname(OPENCLAW_CONFIG_PATH), { recursive: true });

    const response = await fetch(`http://localhost:${port}/models`);
    const data = await response.json() as { output?: { models: RoutstrModel[] } };
    const models = data.output?.models || [];

    if (models.length === 0) {
      logger.log("No models found from routstr daemon.");
      return;
    }

    const providerModels: OpenClawModelEntry[] = models.map((model) => ({
      id: model.id,
      name: model.name || model.id,
      reasoning: true,
    }));

    openclawConfig.models.providers[OPENCLAW_PROVIDER_ID] = {
      baseUrl: OPENCLAW_API_BASE,
      apiKey: openclawConfig.models.providers[OPENCLAW_PROVIDER_ID]?.apiKey || "",
      api: "openai-completions",
      models: providerModels,
    };

    const availableModelIds = new Set(providerModels.map((model) => model.id));
    const primaryId = availableModelIds.has("glm-4.7") ? "glm-4.7" : providerModels[0]?.id;
    const fallbackId = availableModelIds.has("qwen3-coder-next")
      ? "qwen3-coder-next"
      : providerModels.find((model) => model.id !== primaryId)?.id;

    if (primaryId) {
      openclawConfig.agents.defaults.model = {
        primary: `${OPENCLAW_PROVIDER_ID}/${primaryId}`,
        fallbacks: fallbackId ? [`${OPENCLAW_PROVIDER_ID}/${fallbackId}`] : [],
      };
    } else {
      openclawConfig.agents.defaults.model = {
        primary: OPENCLAW_DEFAULT_PRIMARY_MODEL,
        fallbacks: [OPENCLAW_DEFAULT_FALLBACK_MODEL],
      };
    }

    const aliasMap: Record<string, { alias?: string }> = {};
    for (const model of providerModels) {
      aliasMap[`${OPENCLAW_PROVIDER_ID}/${model.id}`] = { alias: toAlias(model.id) };
    }
    openclawConfig.agents.defaults.models = aliasMap;

    await writeFile(OPENCLAW_CONFIG_PATH, JSON.stringify(openclawConfig, null, 2));
    logger.log(`Added "${OPENCLAW_PROVIDER_ID}" provider with ${models.length} models to openclaw.json`);
  } catch (error) {
    logger.error("Failed to install models in openclaw.json:", error);
  }
}
