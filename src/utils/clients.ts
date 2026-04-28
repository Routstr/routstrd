import { callDaemon } from "./daemon-client";

export interface ClientEntry {
  clientId: string;
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
