import { randomBytes } from "crypto";
import { join } from "path";
import type { RoutstrdConfig } from "../utils/config";
import type { SdkStore } from "@routstr/sdk";
import { installOpencodeIntegration } from "./opencode";
import { installPiIntegration } from "./pi";
import { installOpenClawIntegration } from "./openclaw";

export interface IntegrationConfig {
  clientId: string;
  name: string;
  configPath: string;
}

export type RoutstrModel = {
  id: string;
  name?: string;
};

export function generateApiKey(): string {
  const bytes = randomBytes(24);
  return `sk-${bytes.toString("hex")}`;
}

export type IntegrationFn = (
  config: RoutstrdConfig,
  store: SdkStore,
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
};

export const CLIENT_INTEGRATIONS: Record<string, IntegrationFn> = {
  opencode: installOpencodeIntegration,
  "pi-agent": installPiIntegration,
  openclaw: installOpenClawIntegration,
};

export async function runIntegrationsForClients(
  clientIds: Array<{ clientId: string }>,
  config: RoutstrdConfig,
  store: SdkStore,
): Promise<void> {
  for (const client of clientIds) {
    const integrationFn = CLIENT_INTEGRATIONS[client.clientId];
    const integrationConfig = CLIENT_CONFIGS[client.clientId];
    if (integrationFn && integrationConfig) {
      try {
        await integrationFn(config, store, integrationConfig);
      } catch (error) {
        console.error(`Integration failed for ${client.clientId}:`, error);
      }
    }
  }
}
