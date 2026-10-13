import type { RoutstrdConfig } from "../utils/config";
import { logger } from "../utils/logger";
import {
  addDaemonClient,
  type DaemonClient,
} from "../utils/clients";
import { callDaemon } from "../utils/daemon-client";
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

  if (MODEL_INTEGRATIONS.has(key)) {
    const ready = await waitForModels();
    if (!ready.ok) {
      warnIntegrationSkipped(integrationConfig.name, ready.reason);
      return;
    }
  }

  // The installers throw so scheduled/bulk refreshes count failures. During
  // onboarding the daemon and API key already exist and `routstrd refresh`
  // completes the setup later, so a failure here must not abort onboarding.
  try {
    const install = INSTALLERS[key];
    if (!install) {
      console.log(`Unknown integration: ${key}`);
      return;
    }
    await install(config, client.apiKey, integrationConfig);
  } catch (error) {
    warnIntegrationSkipped(
      integrationConfig.name,
      error instanceof Error ? error.message : String(error),
    );
  }
}

const INSTALLERS: Record<string, IntegrationInstaller> = {
  opencode: installOpencodeIntegration,
  openclaw: installOpenClawIntegration,
  "pi-agent": installPiIntegration,
  "claude-code": installClaudeCodeIntegration,
  hermes: installHermesIntegration,
};

type IntegrationInstaller = (
  config: RoutstrdConfig,
  apiKey: string,
  integrationConfig: IntegrationConfig,
) => Promise<void>;

/** Integrations whose config embeds the daemon's model list. */
const MODEL_INTEGRATIONS = new Set<string>(["opencode", "openclaw", "pi-agent"]);

function warnIntegrationSkipped(name: string, reason: string): void {
  console.warn(`\nWarning: ${name} integration was not configured: ${reason}`);
  console.warn(
    "The daemon and API key are ready. Run 'routstrd refresh' once models are available to finish the setup.",
  );
}

/** Upper bound for onboarding to wait on the daemon's first model load. */
export const ONBOARD_MODELS_TIMEOUT_MS = 5 * 60 * 1000;

export interface WaitForModelsDeps {
  callDaemon: typeof callDaemon;
  sleep: (ms: number) => Promise<void>;
  now: () => number;
  log: (message: string) => void;
  timeoutMs: number;
  retryDelayMs: number;
  heartbeatMs: number;
}

/**
 * Wait until the daemon serves a non-empty `/models` list. `startDaemon` only
 * waits for `/health`; on a fresh install the first `/models` call blocks
 * while providers bootstrap and the Nostr model list loads, and may still come
 * back empty if relays are slow. Retries until `timeoutMs`, printing progress.
 */
export async function waitForModels(
  overrides: Partial<WaitForModelsDeps> = {},
): Promise<{ ok: true; count: number } | { ok: false; reason: string }> {
  const deps: WaitForModelsDeps = {
    callDaemon,
    sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
    now: Date.now,
    log: (message) => console.log(message),
    timeoutMs: ONBOARD_MODELS_TIMEOUT_MS,
    retryDelayMs: 3_000,
    heartbeatMs: 10_000,
    ...overrides,
  };
  const startedAt = deps.now();
  const elapsed = () => Math.round((deps.now() - startedAt) / 1000);
  deps.log("Waiting for models to load...");
  // A single /models request can block for a while, so heartbeat on a timer
  // rather than between attempts.
  const heartbeat = setInterval(
    () => deps.log(`  Still waiting for models (${elapsed()}s elapsed)...`),
    deps.heartbeatMs,
  );
  let reason = "no models were returned";
  try {
    while (true) {
      try {
        const data = await deps.callDaemon("/models");
        if (data.error) {
          reason = data.error;
        } else {
          const models = (data.output as { models?: unknown[] } | undefined)?.models ?? [];
          if (models.length > 0) {
            deps.log(`Loaded ${models.length} models (${elapsed()}s).`);
            return { ok: true, count: models.length };
          }
          reason = "no models were returned";
        }
      } catch (error) {
        reason = error instanceof Error ? error.message : String(error);
      }
      if (deps.now() - startedAt + deps.retryDelayMs >= deps.timeoutMs) {
        return {
          ok: false,
          reason: `models did not load within ${Math.round(deps.timeoutMs / 1000)}s (${reason})`,
        };
      }
      await deps.sleep(deps.retryDelayMs);
    }
  } finally {
    clearInterval(heartbeat);
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
