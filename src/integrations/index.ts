import type { RoutstrdConfig } from "../utils/config";
import { logger } from "../utils/logger";
import {
  addDaemonClient,
  type DaemonClient,
} from "../utils/clients";
import { getClientsList } from "../utils/clients";
import { installOpencodeIntegration } from "./opencode";
import { installOpenClawIntegration } from "./openclaw";
import { installPiIntegration } from "./pi";
import { installClaudeCodeIntegration } from "./claudecode";
import type { IntegrationConfig } from "./registry";
import { CLIENT_CONFIGS, runIntegrationsForClients } from "./registry";
export { CLIENT_INTEGRATIONS, CLIENT_CONFIGS, runIntegrationsForClients } from "./registry";

/**
 * Refresh routstr21 models and then run integrations for all registered clients.
 * Used both on initial daemon startup and in the recurring scheduled job.
 */
export async function refreshModelsAndIntegrations(
  getRoutstr21Models: (force?: boolean) => Promise<void>,
  config: RoutstrdConfig,
  label: string = "Scheduled",
): Promise<void> {
  await getRoutstr21Models(true);
  logger.log(`${label} model refresh completed successfully.`);

  const clientIds = await getClientsList();
  if (clientIds.length > 0) {
    logger.log(`Refreshing ${clientIds.length} client integration(s)...`);
    await runIntegrationsForClients(clientIds, config);
    logger.log("Client integrations refreshed.");
  }
}

function ask(question: string): Promise<string> {
  process.stdout.write(question);

  if (!process.stdin.isTTY) {
    return Promise.resolve("1");
  }

  return new Promise((resolve) => {
    process.stdin.resume();
    process.stdin.setEncoding("utf8");
    process.stdin.once("data", (data) => {
      process.stdin.pause();
      resolve(data.toString().trim());
    });
  });
}

function parseChoice(input: string): number {
  if (input === "") {
    return 1;
  }

  const parsed = Number.parseInt(input, 10);
  if (!Number.isNaN(parsed) && parsed >= 1 && parsed <= 5) {
    return parsed;
  }

  return 1;
}

export async function setupIntegration(
  config: RoutstrdConfig,
): Promise<void> {
  logger.log("\nChoose an integration to set up:");
  logger.log("1. OpenCode (default)");
  logger.log("2. OpenClaw");
  logger.log("3. Pi");
  logger.log("4. Claude Code");
  logger.log("5. Skip for now");

  const answer = await ask("Select integration [1]: ");
  const choice = parseChoice(answer);

  const integrationByChoice: Record<number, keyof typeof CLIENT_CONFIGS> = {
    1: "opencode",
    2: "openclaw",
    3: "pi-agent",
    4: "claude-code",
  };

  const key = integrationByChoice[choice];
  if (!key) {
    logger.log("Skipping integration setup.");
    return;
  }

  const integrationConfig = CLIENT_CONFIGS[key]!;
  const { client, created } = await addDaemonClient(
    integrationConfig.name,
    integrationConfig.clientId,
  );

  if (created) {
    logger.log(`Created new API key for ${integrationConfig.name}`);
  } else {
    logger.log(`Using existing API key for ${integrationConfig.name}`);
  }

  if (key === "opencode") {
    await installOpencodeIntegration(config, client.apiKey, integrationConfig);
    return;
  }

  if (key === "openclaw") {
    await installOpenClawIntegration(config, client.apiKey, integrationConfig);
    return;
  }

  if (key === "pi-agent") {
    await installPiIntegration(config, client.apiKey, integrationConfig);
    return;
  }

  if (key === "claude-code") {
    await installClaudeCodeIntegration(config, client.apiKey, integrationConfig);
  }
}
