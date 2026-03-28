import { type IncomingMessage, type ServerResponse } from "http";
import { Readable } from "stream";
import {
  routeRequests,
  InsufficientBalanceError,
} from "@routstr/sdk";
import type { UsageTrackingDriver } from "@routstr/sdk";
import { logger } from "../../utils/logger";

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
  mode?: "xcashu" | "apikeys";
  usageTrackingDriver: UsageTrackingDriver;
}) {
  return async function handler(req: IncomingMessage, res: ServerResponse) {
    // Log all incoming headers with PipeLineHeaders tag
    
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
        const state = deps.store.getState();
        const mode = state.mode || deps.mode || "apikeys";
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(
          JSON.stringify({
            output: {
              daemon: "running",
              wallet: "connected",
              mode,
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
          "apikeys",
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
        const usageDriver = deps.usageTrackingDriver;
        const limit = parseLimit(url.searchParams.get("limit"));
        const entries = await usageDriver.list({ limit });
        const totalEntries = await usageDriver.count();
        const totalSatsCost = (
          await usageDriver.list()
        ).reduce((sum, entry) => sum + (entry.satsCost || 0), 0);
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
            },
          }),
        );
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

    const forcedProvider: string | undefined =
      url.searchParams.get("provider") ||
      (req.headers["x-routstr-provider"] as string | undefined) ||
      deps.provider ||
      undefined;

    // Convert req.headers to Record<string, string> and log with PipeLineHeaders tag
    const incomingHeaders: Record<string, string> = {};
    for (const [key, value] of Object.entries(req.headers)) {
      if (typeof value === "string") {
        incomingHeaders[key] = value;
      } else if (Array.isArray(value) && value.length > 0) {
        incomingHeaders[key] = value[0]!;
      }
    }
    logger.log(`[PipeLineHeaders] Passing headers to routeRequests: ${JSON.stringify(incomingHeaders)}`);

    try {
      await deps.ensureProvidersBootstrapped();
      const response = await routeRequests({
        modelId,
        requestBody,
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
      });

      const isStream = bodyObj.stream === true;
      const requestId =
        (response as any).requestId ||
        response.headers.get("x-routstr-request-id") ||
        undefined;
      logger.log("Request ID, ", requestId, " with path: ", url.pathname);

      if (isStream) {
        res.statusCode = response.status;
        response.headers.forEach((value, key) => {
          res.setHeader(key, value);
        });

        const body = response.body;
        if (!body) {
          res.end();
          return;
        }

        const nodeReadable = Readable.fromWeb(body as any);
        await new Promise<void>((resolve, reject) => {
          let settled = false;
          const finish = () => {
            if (settled) return;
            settled = true;
            resolve();
          };
          const fail = (err: unknown) => {
            if (settled) return;
            settled = true;
            reject(err);
          };

          res.once("finish", finish);
          res.once("close", finish);
          res.once("error", fail);
          nodeReadable.once("error", fail);

          nodeReadable.pipe(res);
        });
        return;
      }

      const responseBody = await response.json();
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
