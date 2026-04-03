import type { RoutstrdConfig } from "../utils/config";
import type { SdkStore } from "@routstr/sdk";
import { installOpencodeIntegration } from "./opencode";
import { installPiIntegration } from "./pi";
import { installOpenClawIntegration } from "./openclaw";

export type IntegrationFn = (
  config: RoutstrdConfig,
  store: SdkStore,
) => Promise<void>;

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
    if (integrationFn) {
      try {
        await integrationFn(config, store);
      } catch (error) {
        console.error(`Integration failed for ${client.clientId}:`, error);
      }
    }
  }
}
