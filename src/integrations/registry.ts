import { join } from "path";
import type { RoutstrdConfig } from "../utils/config";
import { installOpencodeIntegration } from "./opencode";
import { installPiIntegration } from "./pi";
import { installOpenClawIntegration } from "./openclaw";
import { installClaudeCodeIntegration } from "./claudecode";
import { installHermesIntegration } from "./hermes";

export interface IntegrationConfig {
  clientId: string;
  name: string;
  configPath: string;
}

export type RoutstrModel = {
  id: string;
  name?: string;
};

export type IntegrationFn = (
  config: RoutstrdConfig,
  apiKey: string,
  integrationConfig: IntegrationConfig,
) => Promise<void>;

export const CLIENT_CONFIGS: Record<string, IntegrationConfig> = {
  opencode: {
    clientId: "opencode",
    name: "OpenCode",
    configPath: join(process.env.HOME || "", ".config/opencode/opencode.json"),
  },
  "pi-agent": {
    clientId: "pi-agent",
    name: "Pi Agent",
    configPath: join(process.env.HOME || "", ".pi/agent/models.json"),
  },
  openclaw: {
    clientId: "openclaw",
    name: "OpenClaw",
    configPath: join(process.env.HOME || "", ".openclaw/openclaw.json"),
  },
  "claude-code": {
    clientId: "claude-code",
    name: "Claude Code",
    configPath: join(process.env.HOME || "", ".claude/settings.json"),
  },
  hermes: {
    clientId: "hermes",
    name: "Hermes",
    configPath: join(process.env.HOME || "", ".hermes/config.yaml"),
  },
};

export const CLIENT_INTEGRATIONS: Record<string, IntegrationFn> = {
  opencode: installOpencodeIntegration,
  "pi-agent": installPiIntegration,
  openclaw: installOpenClawIntegration,
  "claude-code": installClaudeCodeIntegration,
  hermes: installHermesIntegration,
};

export async function runIntegrationsForClients(
  clientIds: Array<{ clientId: string; apiKey?: string }>,
  config: RoutstrdConfig,
): Promise<void> {
  for (const client of clientIds) {
    const integrationFn = CLIENT_INTEGRATIONS[client.clientId];
    const integrationConfig = CLIENT_CONFIGS[client.clientId];
    if (integrationFn && integrationConfig && client.apiKey) {
      try {
        await integrationFn(config, client.apiKey, integrationConfig);
      } catch (error) {
        console.error(`Integration failed for ${client.clientId}:`, error);
      }
    }
  }
}
