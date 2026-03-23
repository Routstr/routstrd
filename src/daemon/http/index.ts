import { type IncomingMessage, type ServerResponse } from "http";
import { Readable } from "stream";
import { ReadableStream as WebReadableStream } from "stream/web";
import { routeRequests, InsufficientBalanceError } from "@routstr/sdk";
import { createSSEParserTransform } from "../sse";
import {
  createUsageTracker,
  extractResponseId,
  extractUsageFromResponseBody,
  resolveUsageBaseUrl,
} from "../usage";
import type { UsageData } from "../types";
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

  const matchingClient = (clientIds as { clientId: string; apiKey: string }[]).find(
    (c) => c.apiKey === apiKey,
  );

  return matchingClient?.clientId;
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

async function readJsonBody(req: IncomingMessage): Promise<Record<string, unknown>> {
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
    ? Math.min(requested, 1000)
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

async function buildStatusOutput(deps: DaemonDeps): Promise<WalletStatusOutput> {
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

export function createDaemonRequestHandler(deps: DaemonDeps) {
  const usageTracker = createUsageTracker(deps.store);

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
      await respond(res, async () => ({ output: await buildWalletDetails(deps) }));
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
          "lazyrefund",
        );

        const spender = client.getCashuSpender();
        const results = await spender.refundProviders(
          refundBaseUrls,
          mintUrl,
          true,
        );

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
        respondWithError(res, error);
      }
      return;
    }

    if (req.method === "GET" && url.pathname === "/usage") {
      try {
        const output = usageTracker.listRecent(
          parseLimit(url.searchParams.get("limit")),
        );
        sendJson(res, 200, { output });
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

        const output = usageTracker.listForTimestamp(
          timestamp,
          parseLimit(url.searchParams.get("limit")),
        );
        sendJson(res, 200, { output });
      } catch (error) {
        sendJson(res, 500, { error: toErrorMessage(error) });
      }
      return;
    }

    if (req.method !== "POST") {
      sendJson(res, 405, { error: "Only POST is supported." });
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

    const forcedProvider =
      url.searchParams.get("provider") ||
      (req.headers["x-routstr-provider"] as string | undefined) ||
      deps.provider ||
      undefined;

    try {
      await deps.ensureProvidersBootstrapped();
      const response = await routeRequests({
        modelId,
        requestBody,
        forcedProvider,
        walletAdapter: deps.walletAdapter,
        storageAdapter: deps.storageAdapter,
        providerRegistry: deps.providerRegistry,
        discoveryAdapter: deps.discoveryAdapter,
        modelManager: deps.modelManager,
        debugLevel: "DEBUG",
        mode: deps.mode,
      });

      const isStream = bodyObj.stream === true;
      const requestId = response.headers.get("x-routstr-request-id") || undefined;
      logger.log("Request ID, ", requestId, " with path: ", url.pathname);
      const usageBaseUrl = resolveUsageBaseUrl(response, forcedProvider);

      if (isStream) {
        res.statusCode = response.status;
        response.headers.forEach((value, key) => {
          res.setHeader(key, value);
        });

        const body = response.body;
        if (body) {
          let capturedUsage: UsageData | null = null;
          let capturedResponseId: string | undefined;
          const nodeReadable = Readable.fromWeb(
            body as unknown as WebReadableStream,
          );
          const sseParser = createSSEParserTransform(
            (usage) => {
              capturedUsage = usage;
            },
            (responseId) => {
              capturedResponseId = responseId;
            },
          );
          nodeReadable.pipe(sseParser).pipe(res);

          res.on("finish", () => {
            if (capturedUsage) {
              const usageRequestId = capturedResponseId || requestId || "unknown";
              logger.log(req);
              usageTracker.append({
                id:
                  usageRequestId === "unknown"
                    ? `req-${Date.now()}-${modelId}`
                    : usageRequestId,
                timestamp: Date.now(),
                modelId,
                baseUrl: usageBaseUrl,
                requestId: usageRequestId,
                client: getClientIdFromRequest(req, deps.store),
                ...capturedUsage,
              });
              logger.log(
                "Streaming request usage:",
                JSON.stringify(capturedUsage),
              );
            }
          });
        } else {
          res.end();
        }
        return;
      }

      const responseBody = await response.json();
      const nonStreamUsage = extractUsageFromResponseBody(responseBody);
      if (nonStreamUsage) {
        const responseRequestId =
          extractResponseId(responseBody) || requestId || "unknown";
        usageTracker.append({
          id:
            responseRequestId === "unknown"
              ? `req-${Date.now()}-${modelId}`
              : responseRequestId,
          timestamp: Date.now(),
          modelId,
          baseUrl: usageBaseUrl,
          requestId: responseRequestId,
          client: getClientIdFromRequest(req, deps.store),
          ...nonStreamUsage,
        });
      }
      sendJson(res, response.status, responseBody as Record<string, unknown>);
    } catch (error) {
      const message = toErrorMessage(error);
      logger.error(`[daemon] Error: ${message}`);

      if (error instanceof InsufficientBalanceError) {
        const balanceError = error as {
          required?: number;
          available?: number;
          maxMintBalance?: number;
          maxMintUrl?: string;
        };
        sendJson(res, 402, {
          error: message,
          error_type: "insufficient_balance",
          required: balanceError.required,
          available: balanceError.available,
          maxMintBalance: balanceError.maxMintBalance,
          maxMintUrl: balanceError.maxMintUrl,
        });
        return;
      }

      respondWithError(res, error);
    }
  };
}
