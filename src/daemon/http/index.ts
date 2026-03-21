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

/**
 * Extracts the client ID from an incoming request by looking up the API key
 * in the store's clientIds list.
 */
function getClientIdFromRequest(
  req: IncomingMessage,
  store: { getState(): any },
): string | undefined {
  const authHeader = req.headers.authorization;
  logger.log("[getClientIdFromRequest] authHeader:", authHeader);
  
  if (!authHeader || !authHeader.startsWith("Bearer ")) {
    logger.log("[getClientIdFromRequest] No valid Bearer auth header found");
    return undefined;
  }

  const apiKey = authHeader.slice(7); // Remove "Bearer " prefix
  logger.log("[getClientIdFromRequest] apiKey:", apiKey);
  
  if (!apiKey.startsWith("sk-")) {
    logger.log("[getClientIdFromRequest] API key does not start with 'sk-'");
    return undefined;
  }

  const state = store.getState();
  const clientIds = state.clientIds || [];
  logger.log("[getClientIdFromRequest] clientIds in store:", JSON.stringify(clientIds));
  
  const matchingClient = (clientIds as { clientId: string; apiKey: string }[]).find(
    (c) => c.apiKey === apiKey,
  );

  if (matchingClient) {
    logger.log("[getClientIdFromRequest] Found matching clientId:", matchingClient.clientId);
  } else {
    logger.log("[getClientIdFromRequest] No matching client found for apiKey:", apiKey);
  }
  
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

function parseLimit(value: string | null, fallback = 10): number {
  const requested = Number.parseInt(value || String(fallback), 10);
  return Number.isFinite(requested) && requested > 0
    ? Math.min(requested, 1000)
    : fallback;
}

export function createDaemonRequestHandler(deps: {
  provider: string | null;
  server: { close(cb?: () => void): void };
  store: any;
  walletAdapter: any;
  storageAdapter: any;
  providerRegistry: any;
  discoveryAdapter: any;
  modelManager: any;
  ensureProvidersBootstrapped: () => Promise<void>;
  getRoutstr21Models: (forceRefresh?: boolean) => Promise<any[]>;
  runWalletCommand: (args: string[]) => Promise<string>;
  parseBalances: (output: string) => Record<string, number>;
}) {
  const usageTracker = createUsageTracker(deps.store);

  return async function handler(req: IncomingMessage, res: ServerResponse) {
    const host = req.headers.host || "localhost";
    const url = new URL(req.url || "/", `http://${host}`);

    if (req.method === "GET" && url.pathname === "/health") {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ ok: true }));
      return;
    }

    if (req.method === "GET" && url.pathname === "/ping") {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ output: "pong" }));
      return;
    }

    if (req.method === "GET" && url.pathname === "/status") {
      try {
        const balancesOutput = await deps.runWalletCommand(["balance"]);
        const balances = deps.parseBalances(balancesOutput);
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(
          JSON.stringify({
            output: {
              daemon: "running",
              wallet: "connected",
              balances,
            },
          }),
        );
      } catch (error) {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(
          JSON.stringify({
            output: {
              daemon: "running",
              wallet: "error",
              error: String(error),
            },
          }),
        );
      }
      return;
    }

    if (req.method === "GET" && url.pathname === "/models") {
      try {
        const forceRefresh =
          url.searchParams.get("refresh")?.toLowerCase() === "true";
        const models = await deps.getRoutstr21Models(forceRefresh);
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ output: { models } }));
      } catch (error) {
        res.writeHead(500, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: String(error) }));
      }
      return;
    }

    if (req.method === "GET" && url.pathname === "/v1/models") {
      try {
        const forceRefresh =
          url.searchParams.get("refresh")?.toLowerCase() === "true";
        const models = await deps.getRoutstr21Models(forceRefresh);
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(
          JSON.stringify({
            object: "list",
            data: models.map((model) => ({ ...model, object: "model" })),
          }),
        );
      } catch (error) {
        res.writeHead(500, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: String(error) }));
      }
      return;
    }

    if (req.method === "POST" && url.pathname === "/stop") {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ output: "stopping" }));
      setTimeout(() => {
        deps.server.close(() => {
          process.exit(0);
        });
      }, 50);
      return;
    }

    if (req.method === "POST" && url.pathname === "/refund") {
      try {
        const bodyText = await readBody(req);
        const body = bodyText ? JSON.parse(bodyText) : {};
        const mintUrl = body.mintUrl as string | undefined;

        if (!mintUrl) {
          res.writeHead(400, { "Content-Type": "application/json" });
          res.end(
            JSON.stringify({ error: "Missing required 'mintUrl' field." }),
          );
          return;
        }

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
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(
            JSON.stringify({
              output: { message: "No pending tokens to refund", results: [] },
            }),
          );
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

        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(
          JSON.stringify({
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
          }),
        );
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        logger.error(`Refund error: ${message}`);
        res.writeHead(500, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: message }));
      }
      return;
    }

    if (req.method === "GET" && url.pathname === "/balance") {
      try {
        const balances = await deps.walletAdapter.getBalances();
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(
          JSON.stringify({
            output: {
              balances,
              unit: "sat",
              activeMint: deps.walletAdapter.getActiveMintUrl(),
            },
          }),
        );
      } catch (error) {
        res.writeHead(500, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: String(error) }));
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

        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(
          JSON.stringify({
            output: {
              keys,
              total: totalWallet + totalCached + totalApiKeys,
              unit: "sat",
              apikeysCalled: apiKeys.length,
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
        const output = usageTracker.listRecent(parseLimit(url.searchParams.get("limit")));
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ output }));
      } catch (error) {
        res.writeHead(500, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: String(error) }));
      }
      return;
    }

    if (req.method === "GET" && url.pathname === "/usagePi") {
      try {
        const timestamp = (url.searchParams.get("timestamp") || "").trim();
        if (!timestamp) {
          res.writeHead(400, { "Content-Type": "application/json" });
          res.end(
            JSON.stringify({
              error: "Missing required 'timestamp' query parameter.",
            }),
          );
          return;
        }

        const output = usageTracker.listForTimestamp(
          timestamp,
          parseLimit(url.searchParams.get("limit")),
        );
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ output }));
      } catch (error) {
        res.writeHead(500, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: String(error) }));
      }
      return;
    }

    if (req.method !== "POST") {
      res.writeHead(405, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "Only POST is supported." }));
      return;
    }

    let requestBody: unknown = {};
    try {
      const bodyText = await readBody(req);
      requestBody = bodyText ? JSON.parse(bodyText) : {};
    } catch (error) {
      res.writeHead(400, { "Content-Type": "application/json" });
      res.end(
        JSON.stringify({
          error: "Invalid JSON body.",
          details: error instanceof Error ? error.message : String(error),
        }),
      );
      return;
    }

    const bodyObj = requestBody as Record<string, unknown>;
    const modelId = typeof bodyObj.model === "string" ? bodyObj.model : "";

    if (!modelId) {
      res.writeHead(400, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "Missing required 'model' field." }));
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
      res.writeHead(response.status, {
        "Content-Type": "application/json",
      });
      res.end(JSON.stringify(responseBody));
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
