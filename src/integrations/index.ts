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
import { installHermesIntegration } from "./hermes";
import type { IntegrationConfig } from "./registry";
import { CLIENT_CONFIGS, runIntegrationsForClients } from "./registry";
export { CLIENT_INTEGRATIONS, CLIENT_CONFIGS, runIntegrationsForClients } from "./registry";

/**
 * Refresh routstr21 models and then run integrations for all registered clients.
 * Used both on initial daemon startup and in the recurring scheduled job.
 */
export async function refreshModelsAndIntegrations(
  getRoutstr21Models: (force?: boolean) => Promise<any[]>,
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
  if (!Number.isNaN(parsed) && parsed >= 1 && parsed <= 6) {
    return parsed;
  }

  return 1;
}

/**
 * Either a client integration key (as used in CLIENT_CONFIGS) or "skip".
 */
export type IntegrationKey = keyof typeof CLIENT_CONFIGS | "skip";

/**
 * Create/find the API key for a client and run its install integration.
 * Shared by the interactive menu in setupIntegration and direct onboarding
 * via `routstrd onboard --<client>` flags.
 */
async function installIntegrationByKey(
  config: RoutstrdConfig,
  key: keyof typeof CLIENT_CONFIGS,
): Promise<void> {
  const integrationConfig = CLIENT_CONFIGS[key];
  if (!integrationConfig) {
    console.log(`Unknown integration: ${key}`);
    return;
  }

  const { client, created } = await addDaemonClient(
    integrationConfig.name,
  );

  if (created) {
    console.log(`Created new API key for ${integrationConfig.name}`);
  } else {
    console.log(`Using existing API key for ${integrationConfig.name}`);
  }

  switch (key) {
    case "opencode":
      await installOpencodeIntegration(config, client.apiKey, integrationConfig);
      return;
    case "openclaw":
      await installOpenClawIntegration(config, client.apiKey, integrationConfig);
      return;
    case "pi-agent":
      await installPiIntegration(config, client.apiKey, integrationConfig);
      return;
    case "claude-code":
      await installClaudeCodeIntegration(config, client.apiKey, integrationConfig);
      return;
    case "hermes":
      await installHermesIntegration(config, client.apiKey, integrationConfig);
      return;
    default:
      console.log(`Unknown integration: ${key}`);
  }
}

export async function setupIntegration(
  config: RoutstrdConfig,
  integrationKey?: IntegrationKey,
): Promise<void> {
  // Non-interactive selection (e.g. `routstrd onboard --pi-agent`).
  if (integrationKey === "skip") {
    console.log("Skipping integration setup.");
    return;
  }

  if (integrationKey !== undefined) {
    await installIntegrationByKey(config, integrationKey);
    return;
  }

  console.log("\nChoose an integration to set up:");
  console.log("1. OpenCode (default)");
  console.log("2. OpenClaw");
  console.log("3. Pi");
  console.log("4. Claude Code");
  console.log("5. Hermes");
  console.log("6. Skip for now");

  const answer = await ask("Select integration [1]: ");
  const choice = parseChoice(answer);

  const integrationByChoice: Record<number, keyof typeof CLIENT_CONFIGS> = {
    1: "opencode",
    2: "openclaw",
    3: "pi-agent",
    4: "claude-code",
    5: "hermes",
  };

  const key = integrationByChoice[choice];
  if (!key) {
    console.log("Skipping integration setup.");
    return;
  }

  await installIntegrationByKey(config, key);
}
