import { existsSync, mkdirSync } from "fs";
import { readFile, writeFile } from "fs/promises";
import { dirname } from "path";
import type { RoutstrdConfig } from "../utils/config";
import { logger } from "../utils/logger";
import type { SdkStore } from "@routstr/sdk";
import type { IntegrationConfig } from "./registry";
import { generateApiKey } from "./registry";

export async function installClaudeCodeIntegration(
  config: RoutstrdConfig,
  store: SdkStore,
  integrationConfig: IntegrationConfig,
): Promise<void> {
  const { clientId, name, configPath } = integrationConfig;

  logger.log(`\nInstalling routstr configuration in ${configPath}...`);

  const port = config.port || 8008;

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
  settings.env["ANTHROPIC_BASE_URL"] = `http://localhost:${port}`;
  
  // Default models as requested
  settings.env["ANTHROPIC_DEFAULT_SONNET_MODEL"] = "gpt-5.4";
  settings.env["ANTHROPIC_DEFAULT_OPUS_MODEL"] = "claude-opus-4.7";
  settings.env["ANTHROPIC_DEFAULT_HAIKU_MODEL"] = "minimax-m2.7";

  try {
    mkdirSync(dirname(configPath), { recursive: true });
    await writeFile(configPath, JSON.stringify(settings, null, 2));
    logger.log(`Successfully updated ${configPath} with routstr settings.`);
  } catch (error) {
    logger.error(`Failed to write to ${configPath}:`, error);
  }
}
