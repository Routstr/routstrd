import {
  callDaemon,
  loadConfig,
  getDaemonBaseUrl,
  getNpubSuffix,
  ensureDaemonRunning,
} from "./daemon-client";
import { logger } from "./logger";
import { CLIENT_INTEGRATIONS, CLIENT_CONFIGS } from "../integrations/registry";

export interface ClientEntry {
  clientId: string;
  name: string;
  apiKey: string;
  createdAt: number;
  lastUsed?: number | null;
}

export interface DaemonClient {
  id: string;
  name: string;
  apiKey: string;
  createdAt: number;
  lastUsed?: number | null;
}

/**
 * Read the clients list directly from the SDK store.
 * Use this when running inside the daemon (local mode).
 */
export function getClientsFromStore(store: { getState(): any }): ClientEntry[] {
  const state = store.getState();
  const clientIds = state.clientIds || [];
  return clientIds.map(
    (c: {
      clientId: string;
      name: string;
      apiKey: string;
      createdAt: number;
      lastUsed?: number | null;
    }) => ({
      clientId: c.clientId,
      name: c.name,
      apiKey: c.apiKey,
      createdAt: c.createdAt,
      lastUsed: c.lastUsed,
    }),
  );
}

/**
 * Fetch the clients list from the daemon API.
 * Use this when running remotely (CLI in remote mode).
 */
export async function getClientsList(): Promise<ClientEntry[]> {
  const result = await callDaemon("/clients");
  const clients = (
    result.output as
      | {
          clients?: Array<{
            id: string;
            name: string;
            apiKey: string;
            createdAt: number;
            lastUsed?: number | null;
          }>;
        }
      | undefined
  )?.clients;

  if (!clients) {
    return [];
  }

  return clients.map((c) => ({
    clientId: c.id,
    name: c.name,
    apiKey: c.apiKey,
    createdAt: c.createdAt,
    lastUsed: c.lastUsed,
  }));
}

export async function addDaemonClient(
  name: string,
): Promise<{ message?: string; client: DaemonClient }> {
  const result = await callDaemon("/clients/add", {
    method: "POST",
    body: { name },
  });

  const output = result.output as
    | { message?: string; client?: DaemonClient }
    | undefined;

  if (!output?.client?.apiKey) {
    throw new Error(`Daemon did not return an API key for ${name}.`);
  }

  return { message: output.message, client: output.client };
}

export async function ensureDaemonClient(
  name: string,
  clientId: string,
): Promise<{ client: DaemonClient; created: boolean }> {
  try {
    const { client } = await addDaemonClient(name);
    return { client, created: true };
  } catch (error) {
    const message = (error as Error).message || "";
    if (!message.includes("already exists")) {
      throw error;
    }

    const clients = await getClientsList();
    const entry = clients.find((c) => c.clientId === clientId);

    if (!entry?.apiKey) {
      throw new Error(
        `Client '${clientId}' already exists but could not be fetched from the daemon.`,
      );
    }

    const client: DaemonClient = {
      id: entry.clientId,
      name: entry.name,
      apiKey: entry.apiKey,
      createdAt: entry.createdAt,
      lastUsed: entry.lastUsed,
    };

    return { client, created: false };
  }
}

export async function listClientsAction(): Promise<void> {
  await ensureDaemonRunning();

  const config = await loadConfig();
  const suffix = getNpubSuffix(config);

  const entries = await getClientsList();

  let clients = entries.map((c) => ({
    id: c.clientId,
    name: c.name,
    apiKey: c.apiKey,
    createdAt: c.createdAt,
    lastUsed: c.lastUsed,
  }));

  if (suffix) {
    const suffixStr = `_${suffix}`;
    clients = clients.filter(
      (c) => c.name.endsWith(suffixStr) || c.id.endsWith(suffixStr),
    );
    clients = clients.map((c) => ({
      ...c,
      name: c.name.endsWith(suffixStr)
        ? c.name.slice(0, -suffixStr.length)
        : c.name,
      id: c.id.endsWith(suffixStr) ? c.id.slice(0, -suffixStr.length) : c.id,
    }));
  }

  if (clients.length === 0) {
    console.log("No clients found.");
    return;
  }

  console.log(`Clients (${clients.length} total):\n`);
  for (const client of clients) {
    const createdAt = new Date(client.createdAt).toISOString();
    const lastUsed = client.lastUsed
      ? new Date(client.lastUsed).toISOString()
      : "never";
    console.log(`  ${client.id}`);
    console.log(`    Name:     ${client.name}`);
    console.log(`    API Key:  ${client.apiKey}`);
    console.log(`    Created:  ${createdAt}`);
    console.log("");
  }
}

export async function deleteClientAction(id: string): Promise<void> {
  await ensureDaemonRunning();

  const config = await loadConfig();
  const suffix = getNpubSuffix(config);
  let resolvedId = id;
  if (suffix) {
    const suffixStr = `_${suffix}`;
    if (!id.endsWith(suffixStr)) {
      resolvedId = `${id}${suffixStr}`;
    }
  }

  const result = await callDaemon("/clients/delete", {
    method: "POST",
    body: { id: resolvedId },
  });

  if (result.error) {
    console.log(result.error);
    process.exit(1);
  }

  const output = result.output as
    | {
        message: string;
        id: string;
      }
    | undefined;

  if (output) {
    console.log(output.message);
  }
}

export interface AddClientOptions {
  name?: string;
  opencode?: boolean;
  openclaw?: boolean;
  piAgent?: boolean;
  claudeCode?: boolean;
}

export async function addClientAction(options: AddClientOptions): Promise<void> {
  await ensureDaemonRunning();
  const config = await loadConfig();

  const integrationKeys: string[] = [];
  if (options.opencode) integrationKeys.push("opencode");
  if (options.openclaw) integrationKeys.push("openclaw");
  if (options.piAgent) integrationKeys.push("pi-agent");
  if (options.claudeCode) integrationKeys.push("claude-code");

  if (integrationKeys.length > 0) {
    for (const key of integrationKeys) {
      const integrationFn = CLIENT_INTEGRATIONS[key];
      const integrationConfig = CLIENT_CONFIGS[key];
      if (!integrationFn || !integrationConfig) continue;

      try {
        const { client, created } = await ensureDaemonClient(
          integrationConfig.name,
          integrationConfig.clientId,
        );
        if (created) {
          logger.log(`Created new API key for ${integrationConfig.name}`);
        } else {
          logger.log(`Using existing API key for ${integrationConfig.name}`);
        }
        await integrationFn(config, client.apiKey, integrationConfig);

        console.log(`\n  ${integrationConfig.name}:`);
        console.log(`    Client ID: ${client.id}`);
        console.log(`    API Key:   ${client.apiKey}`);
      } catch (error) {
        logger.error(
          `Failed to set up ${integrationConfig.name} integration:`,
          error,
        );
        continue;
      }
    }

    console.log(`\n  Access Routstr at: ${getDaemonBaseUrl(config)}/v1`);
    return;
  }

  if (!options.name) {
    console.error(
      "error: required option '-n, --name <name>' not specified",
    );
    process.exit(1);
  }

  const suffix = getNpubSuffix(config);
  const resolvedName = suffix ? `${options.name} ${suffix}` : options.name;

  try {
    const { message, client } = await addDaemonClient(resolvedName);

    if (message) {
      console.log(message);
    }
    console.log(`\n  ID:     ${client.id}`);
    console.log(`  Name:   ${client.name}`);
    console.log(`  API Key: ${client.apiKey}`);
    console.log(`\n  Access Routstr at: ${getDaemonBaseUrl(config)}/v1`);
  } catch (error) {
    console.log((error as Error).message);
    process.exit(1);
  }
}
