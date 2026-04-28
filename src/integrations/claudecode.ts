import { existsSync, mkdirSync } from "fs";
import { readFile, writeFile } from "fs/promises";
import { dirname } from "path";
import type { RoutstrdConfig } from "../utils/config";
import { logger } from "../utils/logger";
import type { SdkStore } from "@routstr/sdk";
import type { IntegrationConfig, RoutstrModel } from "./registry";
import { generateApiKey } from "./registry";
import { callDaemon, getDaemonBaseUrl } from "../utils/daemon-client";

export async function installClaudeCodeIntegration(
  config: RoutstrdConfig,
  store: SdkStore,
  integrationConfig: IntegrationConfig,
): Promise<void> {
  const { clientId, name, configPath } = integrationConfig;

  logger.log(`\nInstalling routstr configuration in ${configPath}...`);

  const baseUrl = getDaemonBaseUrl(config);

  // Get or create clientId entry
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

  let settings: {
    env?: Record<string, string>;
  } = {};

  try {
    if (existsSync(configPath)) {
      const content = await readFile(configPath, "utf-8");
      settings = JSON.parse(content);
    }
  } catch (error) {
    logger.error(`Error reading ${configPath}, creating new one.`);
  }

  if (!settings.env) {
    settings.env = {};
  }

  settings.env["ANTHROPIC_AUTH_TOKEN"] = apiKey;
  settings.env["ANTHROPIC_BASE_URL"] = baseUrl;

  try {
    const data = await callDaemon("/models");
    const models = (data.output as { models: RoutstrModel[] } | undefined)?.models || [];

    if (models.length >= 3) {
      settings.env["ANTHROPIC_DEFAULT_OPUS_MODEL"] = models[0].id;
      settings.env["ANTHROPIC_DEFAULT_SONNET_MODEL"] = models[1].id;
      settings.env["ANTHROPIC_DEFAULT_HAIKU_MODEL"] = models[2].id;
      logger.log(`Set Claude models: Opus=${models[0].id}, Sonnet=${models[1].id}, Haiku=${models[2].id}`);
    } else if (models.length > 0) {
      logger.log(`Only ${models.length} models available, falling back to defaults.`);
      settings.env["ANTHROPIC_DEFAULT_OPUS_MODEL"] = models[0].id;
      settings.env["ANTHROPIC_DEFAULT_SONNET_MODEL"] = models[0].id;
      settings.env["ANTHROPIC_DEFAULT_HAIKU_MODEL"] = models[0].id;
    } else {
      logger.log("No models available from routstr daemon.");
    }
  } catch (error) {
    logger.error("Failed to fetch models for Claude Code integration:", error);
  }

  try {
    mkdirSync(dirname(configPath), { recursive: true });
    await writeFile(configPath, JSON.stringify(settings, null, 2));
    logger.log(`Successfully updated ${configPath} with routstr settings.`);
  } catch (error) {
    logger.error(`Failed to write to ${configPath}:`, error);
  }
}
