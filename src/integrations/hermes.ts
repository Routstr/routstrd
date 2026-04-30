import { existsSync, mkdirSync } from "fs";
import { readFile, writeFile } from "fs/promises";
import { dirname } from "path";
import type { RoutstrdConfig } from "../utils/config";
import { logger } from "../utils/logger";
import type { IntegrationConfig, RoutstrModel } from "./registry";
import { callDaemon, getDaemonBaseUrl } from "../utils/daemon-client";

export async function installHermesIntegration(
  config: RoutstrdConfig,
  apiKey: string,
  integrationConfig: IntegrationConfig,
): Promise<void> {
  const { name, configPath } = integrationConfig;

  logger.log(`\nInstalling routstr configuration in ${configPath}...`);
  logger.log(`Using API key for ${name}`);

  const baseUrl = getDaemonBaseUrl(config);
  const baseUrlV1 = `${baseUrl}/v1`;

  let defaultModel = "minimax-m2.7";

  try {
    const data = await callDaemon("/models");
    const models = (data.output as { models: RoutstrModel[] } | undefined)?.models || [];

    if (models.length >= 3) {
      defaultModel = models[2]!.id;
      logger.log(`Set default model to 3rd available model: ${defaultModel}`);
    } else if (models.length > 0) {
      defaultModel = models[0]!.id;
      logger.log(`Only ${models.length} models available, using ${defaultModel} as default.`);
    } else {
      logger.log("No models available from routstr daemon, using fallback default.");
    }
  } catch (error) {
    logger.error("Failed to fetch models for Hermes integration:", error);
    logger.log("Using fallback default model.");
  }

  let content = "";
  try {
    if (existsSync(configPath)) {
      content = await readFile(configPath, "utf-8");
    }
  } catch (error) {
    logger.error(`Error reading ${configPath}, creating new one.`);
  }

  // Remove existing model block
  content = content.replace(/^model:\n(?:  .*\n)*/gm, "");
  // Remove existing custom_providers block
  content = content.replace(/^custom_providers:\n(?:- .*\n(?:  .*\n)*)*/gm, "");
  // Clean up extra blank lines
  content = content.replace(/\n{3,}/g, "\n\n").trim();

  const urlDisplay = baseUrl.replace(/^https?:\/\//, "");

  const modelBlock = `model:
  default: ${defaultModel}
  provider: custom
  base_url: ${baseUrlV1}
  api_key: ${apiKey}`;

  const providerBlock = `custom_providers:
- name: Routstr (${urlDisplay})
  base_url: ${baseUrlV1}
  api_key: ${apiKey}
  model: ${defaultModel}`;

  const parts: string[] = [modelBlock];
  if (content) {
    parts.push(content);
  }
  parts.push(providerBlock);

  const newContent = parts.join("\n\n") + "\n";

  try {
    mkdirSync(dirname(configPath), { recursive: true });
    await writeFile(configPath, newContent);
    logger.log(`Successfully updated ${configPath} with routstr settings.`);
  } catch (error) {
    logger.error(`Failed to write to ${configPath}:`, error);
  }
}
