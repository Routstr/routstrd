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
 * What a refresh pass produced. Durations are measured by the caller so one
 * summary can cover the whole pass (Nostr events + models + integrations).
 */
export interface ModelRefreshResult {
  /** Models exposed for routstr21 after the refresh. */
  modelCount: number;
  /** Client integrations rewritten (0 when no clients are registered). */
  integrationCount: number;
  /** Integrations that failed; each failure is logged as it happens. */
  failedCount: number;
}

/**
 * One line for a whole refresh pass. The daemon repeats this on a timer, so the
 * per-phase lines ("refreshing ...", "... completed successfully") are `debug`:
 * at `info` a pass costs exactly one line, whether or not anything changed.
 */
export function formatModelRefreshSummary(
  label: string,
  result: ModelRefreshResult,
  totalDurationMs: number,
): string {
  const parts = [`${result.modelCount} models`];
  // Always the count, never "no client integrations": clients can be
  // registered but skipped when they have no API key, and claiming there are
  // none contradicts what `routstrd clients` shows.
  parts.push(`${result.integrationCount} client integration(s)`);
  if (result.failedCount > 0) parts.push(`${result.failedCount} failed`);
  return `${label} refresh: ${parts.join(", ")} in ${(totalDurationMs / 1000).toFixed(1)}s`;
}

/**
 * Refresh routstr21 models and then run integrations for all registered clients.
 * Used both on initial daemon startup and in the recurring scheduled job.
 *
 * Returns the pass result instead of logging it: the caller owns the single
 * summary line (see formatModelRefreshSummary).
 */
export async function refreshModelsAndIntegrations(
  getRoutstr21Models: (force?: boolean) => Promise<any[]>,
  config: RoutstrdConfig,
  label: string = "Scheduled",
): Promise<ModelRefreshResult> {
  logger.debug(`${label} refresh: fetching routstr21 models...`);
  const models = await getRoutstr21Models(true);

  const clientIds = await getClientsList();
  let integrationCount = 0;
  let failedCount = 0;
  if (clientIds.length > 0) {
    logger.debug(
      `${label} refresh: rewriting ${clientIds.length} client integration(s)...`,
    );
    const run = await runIntegrationsForClients(clientIds, config);
    integrationCount = run.refreshed;
    failedCount = run.failed;
  }

  return { modelCount: models.length, integrationCount, failedCount };
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
