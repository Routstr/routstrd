import { randomBytes } from "crypto";
import { type IncomingMessage, type ServerResponse } from "http";
import {
  routeRequestsToNodeResponse,
  InsufficientBalanceError,
} from "@routstr/sdk";
import type { UsageTrackingDriver } from "@routstr/sdk";
import { logger } from "../../utils/logger";
import {
  CocodHttpError,
  type CocodClient,
  type CocodState,
} from "../wallet/cocod-client";
import { decodeCashuTokenAmount } from "../wallet";

type ClientMode = "xcashu" | "lazyrefund" | "apikeys";

type WalletStatusOutput = {
  daemon: "running";
  wallet: "connected" | "error";
  walletState: CocodState;
  balances?: Record<string, number>;
  mode: ClientMode;
  error?: string;
};

type DaemonDeps = {
  provider: string | null;
  server: { close(cb?: () => void): void };
  store: any;
  walletClient: CocodClient;
  walletAdapter: any;
  storageAdapter: any;
  providerRegistry: any;
  discoveryAdapter: any;
  modelManager: any;
  ensureProvidersBootstrapped: () => Promise<void>;
  getRoutstr21Models: (forceRefresh?: boolean) => Promise<any[]>;
  mode?: ClientMode;
};

/**
 * Extracts the client ID from an incoming request by looking up the API key
 * in the store's clientIds list.
 */
function getClientIdFromRequest(
  req: IncomingMessage,
  store: { getState(): any },
): string | undefined {
  const authHeader = req.headers.authorization;

  if (!authHeader || !authHeader.startsWith("Bearer ")) {
    return undefined;
  }

  const apiKey = authHeader.slice(7); // Remove "Bearer " prefix

  if (!apiKey.startsWith("sk-")) {
    return undefined;
  }

  const state = store.getState();
  const clientIds = state.clientIds || [];

  const matchingClient = (
    clientIds as { clientId: string; apiKey: string }[]
  ).find((c) => c.apiKey === apiKey);

  return matchingClient?.clientId;
}
function generateApiKey(): string {
  const bytes = randomBytes(24);
  return `sk-${bytes.toString("hex")}`;
}

async function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    let data = "";
    req.on("data", (chunk) => {
      data += chunk.toString();
    });
    req.on("end", () => resolve(data));
    req.on("error", reject);
  });
}

async function readJsonBody(
  req: IncomingMessage,
): Promise<Record<string, unknown>> {
  const bodyText = await readBody(req);
  if (!bodyText) {
    return {};
  }

  try {
    return JSON.parse(bodyText) as Record<string, unknown>;
  } catch {
    throw new CocodHttpError(400, "Invalid JSON body.");
  }
}

function parseLimit(value: string | null, fallback = 10): number {
  const requested = Number.parseInt(value || String(fallback), 10);
  return Number.isFinite(requested) && requested > 0
    ? Math.min(requested, 100000) // Cap at 100k entries
    : fallback;
}

function sendJson(
  res: ServerResponse,
  status: number,
  payload: Record<string, unknown>,
): void {
  res.writeHead(status, { "Content-Type": "application/json" });
  res.end(JSON.stringify(payload));
}

function toErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function getWalletStateMessage(state: CocodState): string {
  switch (state) {
    case "LOCKED":
      return "Wallet is locked. Unlock it before performing wallet operations.";
    case "UNINITIALIZED":
      return "Wallet is not initialized. Run 'routstrd onboard' first.";
    case "ERROR":
      return "Wallet is in an error state.";
    default:
      return "Wallet is unavailable.";
  }
}

function respondWithError(
  res: ServerResponse,
  error: unknown,
  fallbackStatus = 500,
): void {
  if (error instanceof CocodHttpError) {
    sendJson(res, error.status, { error: error.message });
    return;
  }

  sendJson(res, fallbackStatus, { error: toErrorMessage(error) });
}

async function respond(
  res: ServerResponse,
  getPayload: () => Promise<Record<string, unknown>>,
): Promise<void> {
  try {
    sendJson(res, 200, await getPayload());
  } catch (error) {
    respondWithError(res, error);
  }
}

function requireStringField(
  body: Record<string, unknown>,
  field: string,
): string | null {
  const value = body[field];
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function getRequiredStringField(
  body: Record<string, unknown>,
  field: string,
): string {
  const value = requireStringField(body, field);
  if (!value) {
    throw new CocodHttpError(400, `Missing required '${field}' field.`);
  }
  return value;
}

function getRequiredPositiveNumberField(
  body: Record<string, unknown>,
  field: string,
): number {
  const value = body[field];
  if (typeof value === "number" && Number.isFinite(value) && value > 0) {
    return value;
  }
  if (typeof value === "string" && value.trim()) {
    const parsed = Number.parseInt(value.trim(), 10);
    if (Number.isFinite(parsed) && parsed > 0) {
      return parsed;
    }
  }
  throw new CocodHttpError(400, `Missing required '${field}' field.`);
}

function optionalStringField(
  body: Record<string, unknown>,
  field: string,
): string | undefined {
  const value = body[field];
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function getCurrentMode(deps: DaemonDeps): ClientMode {
  const stateMode = deps.store.getState()?.mode;
  return stateMode || deps.mode || "apikeys";
}

async function buildStatusOutput(
  deps: DaemonDeps,
): Promise<WalletStatusOutput> {
  const mode = getCurrentMode(deps);

  try {
    const walletState = await deps.walletClient.getStatus();
    if (walletState !== "UNLOCKED") {
      return {
        daemon: "running",
        wallet: "error",
        walletState,
        mode,
        error: getWalletStateMessage(walletState),
      };
    }

    const balances = await deps.walletAdapter.getBalances();
    return {
      daemon: "running",
      wallet: "connected",
      walletState,
      balances,
      mode,
    };
  } catch (error) {
    return {
      daemon: "running",
      wallet: "error",
      walletState: "ERROR",
      mode,
      error: toErrorMessage(error),
    };
  }
}

async function buildWalletDetails(deps: DaemonDeps): Promise<{
  state: CocodState;
  ready: boolean;
  balances?: Record<string, number>;
  unit?: "sat";
  activeMint?: string | null;
}> {
  const state = await deps.walletClient.getStatus();
  if (state !== "UNLOCKED") {
    return { state, ready: false };
  }

  const balances = await deps.walletAdapter.getBalances();
  return {
    state,
    ready: true,
    balances,
    unit: "sat",
    activeMint: deps.walletAdapter.getActiveMintUrl(),
  };
}

export function createDaemonRequestHandler(deps: {
  provider: string | null;
  server: { close(cb?: () => void): void };
  store: any;
  walletClient: CocodClient;
  walletAdapter: any;
  storageAdapter: any;
  providerRegistry: any;
  discoveryAdapter: any;
  modelManager: any;
  ensureProvidersBootstrapped: () => Promise<void>;
  getRoutstr21Models: (forceRefresh?: boolean) => Promise<any[]>;
  mode?: "xcashu" | "apikeys";
  usageTrackingDriver: UsageTrackingDriver;
}) {
  return async function handler(req: IncomingMessage, res: ServerResponse) {
    const host = req.headers.host || "localhost";
    const url = new URL(req.url || "/", `http://${host}`);

    if (req.method === "GET" && url.pathname === "/health") {
      sendJson(res, 200, { ok: true });
      return;
    }

    if (req.method === "GET" && url.pathname === "/ping") {
      sendJson(res, 200, { output: "pong" });
      return;
    }

    if (req.method === "GET" && url.pathname === "/status") {
      const output = await buildStatusOutput(deps);
      sendJson(res, 200, { output });
      return;
    }

    if (req.method === "GET" && url.pathname === "/wallet/status") {
      await respond(res, async () => ({
        output: await buildWalletDetails(deps),
      }));
      return;
    }

    if (req.method === "POST" && url.pathname === "/wallet/unlock") {
      await respond(res, async () => {
        const body = await readJsonBody(req);
        const passphrase = getRequiredStringField(body, "passphrase");
        const message = await deps.walletClient.unlock(passphrase);
        const state = await deps.walletClient.getStatus();
        return { output: { message, state } };
      });
      return;
    }

    if (req.method === "GET" && url.pathname === "/wallet/balance") {
      await respond(res, async () => {
        const balances = await deps.walletAdapter.getBalances();
        return {
          output: {
            balances,
            unit: "sat",
            activeMint: deps.walletAdapter.getActiveMintUrl(),
            walletState: "UNLOCKED",
          },
        };
      });
      return;
    }

    if (req.method === "POST" && url.pathname === "/wallet/receive/cashu") {
      await respond(res, async () => {
        const body = await readJsonBody(req);
        const token = getRequiredStringField(body, "token");
        const message = await deps.walletClient.receiveCashu(token);
        const { amount, unit } = decodeCashuTokenAmount(token);
        return { output: { message, amount, unit } };
      });
      return;
    }

    if (req.method === "POST" && url.pathname === "/wallet/receive/bolt11") {
      await respond(res, async () => {
        const body = await readJsonBody(req);
        const amount = getRequiredPositiveNumberField(body, "amount");
        const mintUrl = optionalStringField(body, "mintUrl");
        const invoice = await deps.walletClient.receiveBolt11(amount, mintUrl);
        return { output: { invoice, amount, mintUrl } };
      });
      return;
    }

    if (req.method === "POST" && url.pathname === "/wallet/send/cashu") {
      await respond(res, async () => {
        const body = await readJsonBody(req);
        const amount = getRequiredPositiveNumberField(body, "amount");
        const mintUrl = optionalStringField(body, "mintUrl");
        const token = await deps.walletClient.sendCashu(amount, mintUrl);
        return { output: { token, amount, mintUrl } };
      });
      return;
    }

    if (req.method === "POST" && url.pathname === "/wallet/send/bolt11") {
      await respond(res, async () => {
        const body = await readJsonBody(req);
        const invoice = getRequiredStringField(body, "invoice");
        const mintUrl = optionalStringField(body, "mintUrl");
        const message = await deps.walletClient.sendBolt11(invoice, mintUrl);
        return { output: { message, invoice, mintUrl } };
      });
      return;
    }

    if (req.method === "GET" && url.pathname === "/wallet/mints") {
      await respond(res, async () => {
        const mints = await deps.walletClient.listMints();
        return {
          output: {
            mints,
            activeMint: mints[0] || null,
          },
        };
      });
      return;
    }

    if (req.method === "POST" && url.pathname === "/wallet/mints") {
      await respond(res, async () => {
        const body = await readJsonBody(req);
        const mintUrl = getRequiredStringField(body, "url");
        const message = await deps.walletClient.addMint(mintUrl);
        return { output: { message, url: mintUrl } };
      });
      return;
    }

    if (req.method === "POST" && url.pathname === "/wallet/mints/info") {
      await respond(res, async () => {
        const body = await readJsonBody(req);
        const mintUrl = getRequiredStringField(body, "url");
        const info = await deps.walletClient.getMintInfo(mintUrl);
        return { output: { url: mintUrl, info } };
      });
      return;
    }

    if (req.method === "GET" && url.pathname === "/models") {
      try {
        const forceRefresh =
          url.searchParams.get("refresh")?.toLowerCase() === "true";
        const models = await deps.getRoutstr21Models(forceRefresh);
        sendJson(res, 200, { output: { models } });
      } catch (error) {
        sendJson(res, 500, { error: toErrorMessage(error) });
      }
      return;
    }

    if (req.method === "GET" && url.pathname === "/v1/models") {
      try {
        const forceRefresh =
          url.searchParams.get("refresh")?.toLowerCase() === "true";
        const models = await deps.getRoutstr21Models(forceRefresh);
        sendJson(res, 200, {
          object: "list",
          data: models.map((model) => ({ ...model, object: "model" })),
        });
      } catch (error) {
        sendJson(res, 500, { error: toErrorMessage(error) });
      }
      return;
    }

    if (req.method === "POST" && url.pathname === "/stop") {
      sendJson(res, 200, { output: "stopping" });
      setTimeout(() => {
        deps.server.close(() => {
          process.exit(0);
        });
      }, 50);
      return;
    }

    if (req.method === "POST" && url.pathname === "/refund") {
      try {
        const body = await readJsonBody(req);
        const mintUrl = getRequiredStringField(body, "mintUrl");

        const state = deps.store.getState();
        const pendingDistribution = (state.cachedTokens || []).map(
          (t: { baseUrl: string; balance?: number }) => ({
            baseUrl: t.baseUrl,
            amount: t.balance || 0,
          }),
        );
        const apiKeysStored = (state.apiKeys || []).map(
          (k: { baseUrl: string; balance?: number }) => ({
            baseUrl: k.baseUrl,
            amount: k.balance || 0,
          }),
        );

        if (pendingDistribution.length === 0 && apiKeysStored.length === 0) {
          sendJson(res, 200, {
            output: { message: "No pending tokens to refund", results: [] },
          });
          return;
        }

        const refundBaseUrls = pendingDistribution
          .map((p: { baseUrl: string }) => p.baseUrl)
          .concat(apiKeysStored.map((p: { baseUrl: string }) => p.baseUrl));

        const { RoutstrClient } = await import("@routstr/sdk");
        const client = new RoutstrClient(
          deps.walletAdapter,
          deps.storageAdapter,
          deps.providerRegistry,
          "min",
          "apikeys",
        );

        const spender = client.getCashuSpender();
        const results = await spender.refundProviders(mintUrl, true);

        sendJson(res, 200, {
          output: {
            message: `Refunded to ${mintUrl}`,
            pendingTokens: pendingDistribution.length,
            apiKeys: apiKeysStored.length,
            results: results.map(
              (r: { baseUrl: string; success: boolean }) => ({
                baseUrl: r.baseUrl,
                success: r.success,
              }),
            ),
          },
        });
      } catch (error) {
        logger.error(`Refund error: ${toErrorMessage(error)}`);
        respondWithError(res, error);
      }
      return;
    }

    if (req.method === "GET" && url.pathname === "/balance") {
      try {
        const balances = await deps.walletAdapter.getBalances();
        sendJson(res, 200, {
          output: {
            balances,
            unit: "sat",
            activeMint: deps.walletAdapter.getActiveMintUrl(),
          },
        });
      } catch (error) {
        respondWithError(res, error);
      }
      return;
    }

    if (req.method === "GET" && url.pathname === "/keys/balance") {
      try {
        const walletBalances = await deps.walletAdapter.getBalances();
        const totalWallet = Object.values(walletBalances).reduce<number>(
          (sum, balance) => sum + Number(balance),
          0,
        );

        const state = deps.store.getState();
        const cachedTokens = state.cachedTokens || [];
        const totalCached = cachedTokens.reduce(
          (sum: number, t: { balance?: number }) => sum + (t.balance || 0),
          0,
        );

        const apiKeys = state.apiKeys || [];
        const totalApiKeys = apiKeys.reduce(
          (sum: number, k: { balance?: number }) => sum + (k.balance || 0),
          0,
        );

        const keys: Array<{ id: string; name: string; balance: number }> = [
          { id: "wallet", name: "Wallet", balance: totalWallet },
          ...cachedTokens.map((t: { baseUrl: string; balance?: number }) => ({
            id: `cached:${t.baseUrl}`,
            name: `Cached: ${t.baseUrl}`,
            balance: t.balance || 0,
          })),
          ...apiKeys.map((k: { baseUrl: string; balance?: number }) => ({
            id: `apikey:${k.baseUrl}`,
            name: `API Key: ${k.baseUrl}`,
            balance: k.balance || 0,
          })),
        ];

        sendJson(res, 200, {
          output: {
            keys,
            total: totalWallet + totalCached + totalApiKeys,
            unit: "sat",
            apikeysCalled: apiKeys.length,
          },
        });
      } catch (error) {
        res.writeHead(500, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: String(error) }));
      }
      return;
    }

    if (req.method === "POST" && url.pathname === "/providers/disable") {
      try {
        const bodyText = await readBody(req);
        const body = bodyText ? JSON.parse(bodyText) : {};
        const indices = body.indices as number[] | undefined;

        if (!Array.isArray(indices)) {
          res.writeHead(400, { "Content-Type": "application/json" });
          res.end(
            JSON.stringify({
              error: "Missing or invalid 'indices' field (expected number[]).",
            }),
          );
          return;
        }

        const state = deps.store.getState();
        const baseUrlsList: string[] = state.baseUrlsList || [];
        const disabledProviders: string[] = [
          ...(state.disabledProviders || []),
        ];

        const toDisable: string[] = [];
        for (const idx of indices) {
          if (
            typeof idx === "number" &&
            idx >= 0 &&
            idx < baseUrlsList.length
          ) {
            const baseUrl = baseUrlsList[idx]!;
            if (!disabledProviders.includes(baseUrl)) {
              disabledProviders.push(baseUrl);
              toDisable.push(baseUrl);
            }
          }
        }

        deps.store.getState().setDisabledProviders(disabledProviders);

        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(
          JSON.stringify({
            output: {
              message: `Disabled ${toDisable.length} provider(s)`,
              disabled: toDisable,
            },
          }),
        );
      } catch (error) {
        res.writeHead(500, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: String(error) }));
      }
      return;
    }

    if (req.method === "POST" && url.pathname === "/providers/enable") {
      try {
        const bodyText = await readBody(req);
        const body = bodyText ? JSON.parse(bodyText) : {};
        const indices = body.indices as number[] | undefined;

        if (!Array.isArray(indices)) {
          res.writeHead(400, { "Content-Type": "application/json" });
          res.end(
            JSON.stringify({
              error: "Missing or invalid 'indices' field (expected number[]).",
            }),
          );
          return;
        }

        const state = deps.store.getState();
        const baseUrlsList: string[] = state.baseUrlsList || [];
        const disabledProviders: string[] = [
          ...(state.disabledProviders || []),
        ];

        const toEnable: string[] = [];
        for (const idx of indices) {
          if (
            typeof idx === "number" &&
            idx >= 0 &&
            idx < baseUrlsList.length
          ) {
            const baseUrl = baseUrlsList[idx]!;
            const pos = disabledProviders.indexOf(baseUrl);
            if (pos !== -1) {
              disabledProviders.splice(pos, 1);
              toEnable.push(baseUrl);
            }
          }
        }

        deps.store.getState().setDisabledProviders(disabledProviders);

        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(
          JSON.stringify({
            output: {
              message: `Enabled ${toEnable.length} provider(s)`,
              enabled: toEnable,
            },
          }),
        );
      } catch (error) {
        res.writeHead(500, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: String(error) }));
      }
      return;
    }

    // Client management endpoints
    if (req.method === "GET" && url.pathname === "/clients") {
      try {
        const state = deps.store.getState();
        const clientIds = state.clientIds || [];

        const clients = clientIds.map(
          (c: {
            clientId: string;
            name: string;
            apiKey: string;
            createdAt: number;
            lastUsed?: number | null;
          }) => ({
            id: c.clientId,
            name: c.name,
            apiKey: c.apiKey,
            createdAt: c.createdAt,
            lastUsed: c.lastUsed,
          }),
        );

        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(
          JSON.stringify({
            output: {
              clients,
              totalCount: clients.length,
            },
          }),
        );
      } catch (error) {
        res.writeHead(500, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: String(error) }));
      }
      return;
    }

    if (req.method === "POST" && url.pathname === "/clients/add") {
      try {
        const bodyText = await readBody(req);
        const body = bodyText ? JSON.parse(bodyText) : {};
        const name = body.name as string | undefined;

        if (!name || typeof name !== "string" || name.trim() === "") {
          res.writeHead(400, { "Content-Type": "application/json" });
          res.end(
            JSON.stringify({
              error:
                "Missing required 'name' field (must be a non-empty string).",
            }),
          );
          return;
        }

        const clientId = name
          .toLowerCase()
          .replace(/\s+/g, "-")
          .replace(/[^a-z0-9-]/g, "");

        if (!clientId) {
          res.writeHead(400, { "Content-Type": "application/json" });
          res.end(
            JSON.stringify({
              error:
                "Invalid client name. Must contain alphanumeric characters.",
            }),
          );
          return;
        }

        const state = deps.store.getState();
        const existingClients = state.clientIds || [];
        const existingClient = existingClients.find(
          (c: { clientId: string }) => c.clientId === clientId,
        );

        if (existingClient) {
          res.writeHead(409, { "Content-Type": "application/json" });
          res.end(
            JSON.stringify({
              error: `Client with id '${clientId}' already exists.`,
            }),
          );
          return;
        }

        const apiKey = generateApiKey();
        const newClient = {
          clientId,
          name: name.trim(),
          apiKey,
          createdAt: Date.now(),
        };

        deps.store
          .getState()
          .setClientIds((prev: typeof existingClients) => [
            ...(prev || []),
            newClient,
          ]);

        logger.log(`Added client '${name}' with id '${clientId}'`);

        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(
          JSON.stringify({
            output: {
              message: `Client '${name}' added successfully`,
              client: {
                id: clientId,
                name: name.trim(),
                apiKey,
                createdAt: newClient.createdAt,
              },
            },
          }),
        );
      } catch (error) {
        respondWithError(res, error);
      }
      return;
    }

    if (req.method === "GET" && url.pathname === "/providers") {
      try {
        const state = deps.store.getState();
        const baseUrlsList: string[] = state.baseUrlsList || [];
        const disabledProviders: string[] = state.disabledProviders || [];

        const providers = baseUrlsList.map((baseUrl, index) => ({
          index,
          baseUrl,
          disabled: disabledProviders.includes(baseUrl),
        }));

        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(
          JSON.stringify({
            output: {
              providers,
              disabledCount: disabledProviders.length,
              totalCount: baseUrlsList.length,
            },
          }),
        );
      } catch (error) {
        res.writeHead(500, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: String(error) }));
      }
      return;
    }

    if (req.method === "POST" && url.pathname === "/providers/disable") {
      try {
        const bodyText = await readBody(req);
        const body = bodyText ? JSON.parse(bodyText) : {};
        const indices = body.indices as number[] | undefined;

        if (!Array.isArray(indices)) {
          res.writeHead(400, { "Content-Type": "application/json" });
          res.end(
            JSON.stringify({
              error: "Missing or invalid 'indices' field (expected number[]).",
            }),
          );
          return;
        }

        const state = deps.store.getState();
        const baseUrlsList: string[] = state.baseUrlsList || [];
        const disabledProviders: string[] = [
          ...(state.disabledProviders || []),
        ];

        const toDisable: string[] = [];
        for (const idx of indices) {
          if (
            typeof idx === "number" &&
            idx >= 0 &&
            idx < baseUrlsList.length
          ) {
            const baseUrl = baseUrlsList[idx]!;
            if (!disabledProviders.includes(baseUrl)) {
              disabledProviders.push(baseUrl);
              toDisable.push(baseUrl);
            }
          }
        }

        deps.store.getState().setDisabledProviders(disabledProviders);

        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(
          JSON.stringify({
            output: {
              message: `Disabled ${toDisable.length} provider(s)`,
              disabled: toDisable,
            },
          }),
        );
      } catch (error) {
        res.writeHead(500, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: String(error) }));
      }
      return;
    }

    if (req.method === "POST" && url.pathname === "/providers/enable") {
      try {
        const bodyText = await readBody(req);
        const body = bodyText ? JSON.parse(bodyText) : {};
        const indices = body.indices as number[] | undefined;

        if (!Array.isArray(indices)) {
          res.writeHead(400, { "Content-Type": "application/json" });
          res.end(
            JSON.stringify({
              error: "Missing or invalid 'indices' field (expected number[]).",
            }),
          );
          return;
        }

        const state = deps.store.getState();
        const baseUrlsList: string[] = state.baseUrlsList || [];
        const disabledProviders: string[] = [
          ...(state.disabledProviders || []),
        ];

        const toEnable: string[] = [];
        for (const idx of indices) {
          if (
            typeof idx === "number" &&
            idx >= 0 &&
            idx < baseUrlsList.length
          ) {
            const baseUrl = baseUrlsList[idx]!;
            const pos = disabledProviders.indexOf(baseUrl);
            if (pos !== -1) {
              disabledProviders.splice(pos, 1);
              toEnable.push(baseUrl);
            }
          }
        }

        deps.store.getState().setDisabledProviders(disabledProviders);

        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(
          JSON.stringify({
            output: {
              message: `Enabled ${toEnable.length} provider(s)`,
              enabled: toEnable,
            },
          }),
        );
      } catch (error) {
        res.writeHead(500, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: String(error) }));
      }
      return;
    }

    // Client management endpoints
    if (req.method === "GET" && url.pathname === "/clients") {
      try {
        const state = deps.store.getState();
        const clientIds = state.clientIds || [];

        const clients = clientIds.map(
          (c: {
            clientId: string;
            name: string;
            apiKey: string;
            createdAt: number;
            lastUsed?: number | null;
          }) => ({
            id: c.clientId,
            name: c.name,
            apiKey: c.apiKey,
            createdAt: c.createdAt,
            lastUsed: c.lastUsed,
          }),
        );

        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(
          JSON.stringify({
            output: {
              clients,
              totalCount: clients.length,
            },
          }),
        );
      } catch (error) {
        res.writeHead(500, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: String(error) }));
      }
      return;
    }

    if (req.method === "POST" && url.pathname === "/clients/add") {
      try {
        const bodyText = await readBody(req);
        const body = bodyText ? JSON.parse(bodyText) : {};
        const name = body.name as string | undefined;

        if (!name || typeof name !== "string" || name.trim() === "") {
          res.writeHead(400, { "Content-Type": "application/json" });
          res.end(
            JSON.stringify({
              error:
                "Missing required 'name' field (must be a non-empty string).",
            }),
          );
          return;
        }

        const clientId = name
          .toLowerCase()
          .replace(/\s+/g, "-")
          .replace(/[^a-z0-9-]/g, "");

        if (!clientId) {
          res.writeHead(400, { "Content-Type": "application/json" });
          res.end(
            JSON.stringify({
              error:
                "Invalid client name. Must contain alphanumeric characters.",
            }),
          );
          return;
        }

        const state = deps.store.getState();
        const existingClients = state.clientIds || [];
        const existingClient = existingClients.find(
          (c: { clientId: string }) => c.clientId === clientId,
        );

        if (existingClient) {
          res.writeHead(409, { "Content-Type": "application/json" });
          res.end(
            JSON.stringify({
              error: `Client with id '${clientId}' already exists.`,
            }),
          );
          return;
        }

        const apiKey = generateApiKey();
        const newClient = {
          clientId,
          name: name.trim(),
          apiKey,
          createdAt: Date.now(),
        };

        deps.store
          .getState()
          .setClientIds((prev: typeof existingClients) => [
            ...(prev || []),
            newClient,
          ]);

        logger.log(`Added client '${name}' with id '${clientId}'`);

        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(
          JSON.stringify({
            output: {
              message: `Client '${name}' added successfully`,
              client: {
                id: clientId,
                name: name.trim(),
                apiKey,
                createdAt: newClient.createdAt,
              },
            },
          }),
        );
      } catch (error) {
        res.writeHead(500, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: String(error) }));
      }
      return;
    }

    if (req.method === "GET" && url.pathname === "/usage") {
      try {
        const output = await deps.usageTrackingDriver.list({
          limit: parseLimit(url.searchParams.get("limit")),
        });
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ output }));
      } catch (error) {
        sendJson(res, 500, { error: toErrorMessage(error) });
      }
      return;
    }

    if (req.method === "GET" && url.pathname === "/usagePi") {
      try {
        const timestamp = (url.searchParams.get("timestamp") || "").trim();
        if (!timestamp) {
          sendJson(res, 400, {
            error: "Missing required 'timestamp' query parameter.",
          });
          return;
        }

        const usageDriver = deps.usageTrackingDriver;
        const limit = parseLimit(url.searchParams.get("limit"));
        const allMatching = await usageDriver.list();
        const requestIdPrefix = `gen-${timestamp}-`;
        const filtered = allMatching.filter((entry) =>
          entry.requestId.startsWith(requestIdPrefix),
        );
        const entries = filtered.slice(0, limit);
        const totalEntries = filtered.length;
        const totalSatsCost = filtered.reduce(
          (sum, entry) => sum + (entry.satsCost || 0),
          0,
        );
        const recentSatsCost = entries.reduce(
          (sum, entry) => sum + (entry.satsCost || 0),
          0,
        );

        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(
          JSON.stringify({
            output: {
              entries,
              totalEntries,
              totalSatsCost,
              recentSatsCost,
              limit,
              timestamp,
            },
          }),
        );
      } catch (error) {
        sendJson(res, 500, { error: toErrorMessage(error) });
      }
      return;
    }

    // Allow client management endpoints through
    if (req.method !== "POST" && !url.pathname.startsWith("/clients")) {
      res.writeHead(405, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "Only POST is supported." }));
      return;
    }

    let requestBody: unknown = {};
    try {
      requestBody = await readJsonBody(req);
    } catch (error) {
      sendJson(res, 400, {
        error: "Invalid JSON body.",
        details: toErrorMessage(error),
      });
      return;
    }

    const bodyObj = requestBody as Record<string, unknown>;
    const modelId = typeof bodyObj.model === "string" ? bodyObj.model : "";

    if (!modelId) {
      sendJson(res, 400, { error: "Missing required 'model' field." });
      return;
    }

    const forcedProvider: string | undefined =
      url.searchParams.get("provider") ||
      (req.headers["x-routstr-provider"] as string | undefined) ||
      deps.provider ||
      undefined;

    // Convert req.headers to Record<string, string>
    const incomingHeaders: Record<string, string> = {};
    for (const [key, value] of Object.entries(req.headers)) {
      if (typeof value === "string") {
        incomingHeaders[key] = value;
      } else if (Array.isArray(value) && value.length > 0) {
        incomingHeaders[key] = value[0]!;
      }
    }

    try {
      await deps.ensureProvidersBootstrapped();
      logger.log("Routing request with path: ", url.pathname);
      await routeRequestsToNodeResponse({
        modelId,
        requestBody,
        path: url.pathname,
        forcedProvider,
        headers: incomingHeaders,
        walletAdapter: deps.walletAdapter,
        storageAdapter: deps.storageAdapter,
        providerRegistry: deps.providerRegistry,
        discoveryAdapter: deps.discoveryAdapter,
        modelManager: deps.modelManager,
        debugLevel: "DEBUG",
        mode: deps.mode,
        usageTrackingDriver: deps.usageTrackingDriver,
        sdkStore: deps.store,
        res,
      });
      return;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      logger.error(`[daemon] Error: ${message}`);

      if (error instanceof InsufficientBalanceError) {
        const balanceError = error as {
          required?: number;
          available?: number;
          maxMintBalance?: number;
          maxMintUrl?: string;
        };
        res.writeHead(402, { "Content-Type": "application/json" });
        res.end(
          JSON.stringify({
            error: message,
            error_type: "insufficient_balance",
            required: balanceError.required,
            available: balanceError.available,
            maxMintBalance: balanceError.maxMintBalance,
            maxMintUrl: balanceError.maxMintUrl,
          }),
        );
        return;
      }

      res.writeHead(500, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: message }));
    }
  };
}
