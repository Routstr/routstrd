import { existsSync, mkdirSync } from "fs";
import { readFile, writeFile } from "fs/promises";
import { dirname } from "path";
import type { RoutstrdConfig } from "../utils/config";
import { logger } from "../utils/logger";
import type { IntegrationConfig, RoutstrModel } from "./registry";
import { callDaemon, getDaemonBaseUrl } from "../utils/daemon-client";

export async function installClaudeCodeIntegration(
  config: RoutstrdConfig,
  apiKey: string,
  integrationConfig: IntegrationConfig,
): Promise<void> {
  const { name, configPath } = integrationConfig;

  logger.log(`\nInstalling routstr configuration in ${configPath}...`);
  logger.log(`Using API key for ${name}`);

  const baseUrl = getDaemonBaseUrl(config);

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
      const opus = models[0]!;
      const sonnet = models[1]!;
      const haiku = models[2]!;
      settings.env["ANTHROPIC_DEFAULT_OPUS_MODEL"] = opus.id;
      settings.env["ANTHROPIC_DEFAULT_SONNET_MODEL"] = sonnet.id;
      settings.env["ANTHROPIC_DEFAULT_HAIKU_MODEL"] = haiku.id;
      logger.log(`Set Claude models: Opus=${opus.id}, Sonnet=${sonnet.id}, Haiku=${haiku.id}`);
    } else if (models.length > 0) {
      const model = models[0]!;
      logger.log(`Only ${models.length} models available, falling back to defaults.`);
      settings.env["ANTHROPIC_DEFAULT_OPUS_MODEL"] = model.id;
      settings.env["ANTHROPIC_DEFAULT_SONNET_MODEL"] = model.id;
      settings.env["ANTHROPIC_DEFAULT_HAIKU_MODEL"] = model.id;
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
