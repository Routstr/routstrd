import { existsSync, mkdirSync } from "fs";
import { readFile, writeFile } from "fs/promises";
import { dirname } from "path";
import type { RoutstrdConfig } from "../utils/config";
import { logger } from "../utils/logger";
import type { IntegrationConfig, RoutstrModel } from "./registry";
import { callDaemon, getDaemonBaseUrl } from "../utils/daemon-client";

const GOOSE_DEFAULT_MODEL = "glm-5.1";

// Keys managed by this integration
const MANAGED_KEYS = [
  "GOOSE_TELEMETRY_ENABLED",
  "OPENAI_BASE_URL",
  "OPENAI_BASE_PATH",
  "OPENAI_TIMEOUT",
  "GOOSE_PROVIDER",
  "GOOSE_MODEL",
];

export async function installGooseIntegration(
  config: RoutstrdConfig,
  apiKey: string,
  integrationConfig: IntegrationConfig,
): Promise<void> {
  const { name, configPath } = integrationConfig;

  logger.log(`\nInstalling routstr configuration in ${configPath}...`);
  logger.log(`Using API key for ${name}`);

  const baseUrl = getDaemonBaseUrl(config);

  let gooseModel = GOOSE_DEFAULT_MODEL;

  try {
    const data = await callDaemon("/models");
    const models = (data.output as { models: RoutstrModel[] } | undefined)?.models || [];

    if (models.length >= 2) {
      gooseModel = models[1]!.id;
      logger.log(`Set Goose model to 2nd available model: ${gooseModel}`);
    } else if (models.length === 1) {
      gooseModel = models[0]!.id;
      logger.log(`Only 1 model available, using ${gooseModel} as Goose model.`);
    } else {
      logger.log("No models available from routstr daemon, using fallback default model.");
    }
  } catch (error) {
    logger.error("Failed to fetch models for Goose integration:", error);
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

  // Remove existing managed key lines so we can rewrite them
  for (const key of MANAGED_KEYS) {
    content = content.replace(new RegExp(`^${key}:.*\\n?`, "gm"), "");
  }

  // Remove OPENAI_HOST if it was left from a previous manual config
  content = content.replace(/^OPENAI_HOST:.*\n?/gm, "");

  // Clean up trailing blank lines
  content = content.replace(/\n{3,}/g, "\n\n").trimEnd();

  const envBlock = [
    "GOOSE_TELEMETRY_ENABLED: false",
    `OPENAI_BASE_URL: ${baseUrl}`,
    "OPENAI_BASE_PATH: v1/chat/completions",
    "OPENAI_TIMEOUT: '600'",
    "GOOSE_PROVIDER: openai",
    `GOOSE_MODEL: ${gooseModel}`,
  ].join("\n");

  const newContent = (content ? content + "\n\n" : "") + envBlock + "\n";

  try {
    mkdirSync(dirname(configPath), { recursive: true });
    await writeFile(configPath, newContent);
    logger.log(`Successfully updated ${configPath} with routstr settings.`);
  } catch (error) {
    logger.error(`Failed to write to ${configPath}:`, error);
  }
}
