import { createServer, IncomingMessage, ServerResponse } from "http";
import { Transform, Readable } from "stream";
import { ReadableStream as WebReadableStream } from "stream/web";
import { spawn } from "child_process";
import { getDecodedToken } from "@cashu/cashu-ts";
import { mkdir } from "fs/promises";
import { join } from "path";
import { existsSync } from "fs";
import SQLite from "bun:sqlite";
import {
  CONFIG_DIR,
  DB_PATH,
  SOCKET_PATH,
  PID_FILE,
  CONFIG_FILE,
  LOG_FILE,
  DEFAULT_CONFIG,
  type RoutstrdConfig,
} from "./utils/config";
import { logger } from "./utils/logger";
import {
  ModelManager,
  type Model,
  createDiscoveryAdapterFromStore,
  createProviderRegistryFromStore,
  createStorageAdapterFromStore,
  createSdkStore,
  routeRequests,
  InsufficientBalanceError,
  RoutstrClient,
} from "@routstr/sdk";

type ExposedModel = Pick<Model, "id"> & Partial<Omit<Model, "id">>;

function createBunSqliteDriver(dbPath: string) {
  const db = new SQLite(dbPath);

  db.run(`
    CREATE TABLE IF NOT EXISTS sdk_storage (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL
    )
  `);

  return {
    async getItem<T>(key: string, defaultValue: T): Promise<T> {
      try {
        const row = db
          .query("SELECT value FROM sdk_storage WHERE key = ?")
          .get(key) as { value: string } | undefined;
        if (!row || typeof row.value !== "string") return defaultValue;
        try {
          return JSON.parse(row.value) as T;
        } catch (parseError) {
          if (typeof defaultValue === "string") {
            return row.value as T;
          }
          throw parseError;
        }
      } catch (error) {
        logger.error(`SQLite getItem failed for key "${key}":`, error);
        return defaultValue;
      }
    },
    async setItem<T>(key: string, value: T): Promise<void> {
      try {
        db.query(
          "INSERT INTO sdk_storage (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
        ).run(key, JSON.stringify(value));
      } catch (error) {
        logger.error(`SQLite setItem failed for key "${key}":`, error);
      }
    },
    async removeItem(key: string): Promise<void> {
      try {
        db.query("DELETE FROM sdk_storage WHERE key = ?").run(key);
      } catch (error) {
        logger.error(`SQLite removeItem failed for key "${key}":`, error);
      }
    },
  };
}

const REQUESTS_DIR = join(CONFIG_DIR, "requests");

async function ensureDirs(): Promise<void> {
  try {
    await mkdir(CONFIG_DIR, { recursive: true });
    await mkdir(REQUESTS_DIR, { recursive: true });
  } catch (error) {
    // Directory may already exist
  }
}

function parseArgs(argv: string[]): {
  port: number;
  provider: string | null;
} {
  const portFlagIndex = argv.findIndex((arg) => arg === "--port");
  const providerFlagIndex = argv.findIndex(
    (arg) => arg === "--provider" || arg === "-p",
  );

  const port =
    portFlagIndex !== -1
      ? Number.parseInt(argv[portFlagIndex + 1] || "8008", 10)
      : 8008;
  const providerValue =
    providerFlagIndex !== -1 ? argv[providerFlagIndex + 1] : undefined;
  const provider = providerValue ? providerValue.trim() : null;

  return { port, provider };
}

async function loadConfig(): Promise<RoutstrdConfig> {
  try {
    if (existsSync(CONFIG_FILE)) {
      const content = await Bun.file(CONFIG_FILE).text();
      return { ...DEFAULT_CONFIG, ...JSON.parse(content) };
    }
  } catch (error) {
    logger.error("Failed to load config:", error);
  }
  return DEFAULT_CONFIG;
}

function saveConfig(config: RoutstrdConfig): void {
  Bun.write(CONFIG_FILE, JSON.stringify(config, null, 2));
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

async function runWalletCommand(args: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn("cocod", args, {
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";

    child.stdout.on("data", (chunk) => {
      stdout += chunk.toString();
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk.toString();
    });
    child.on("error", (error) => reject(error));
    child.on("close", (code) => {
      if (code && code !== 0) {
        reject(
          new Error(stderr.trim() || stdout.trim() || "Wallet CLI failed"),
        );
        return;
      }
      resolve(stdout.trim());
    });
  });
}

function parseBalances(output: string): Record<string, number> {
  const trimmed = output.trim();
  if (!trimmed) return {};

  try {
    const parsed = JSON.parse(trimmed) as Record<
      string,
      { sats?: number } | number
    >;
    if (parsed && typeof parsed === "object") {
      return Object.fromEntries(
        Object.entries(parsed).map(([mintUrl, value]) => {
          if (typeof value === "number") {
            return [mintUrl, value];
          }
          if (value && typeof value === "object" && "sats" in value) {
            return [mintUrl, Number(value.sats ?? 0)];
          }
          return [mintUrl, 0];
        }),
      );
    }
  } catch {
    // Fall back to line parsing.
  }

  const balances: Record<string, number> = {};
  trimmed
    .split("\n")
    .map((line) => line.trim())
    .forEach((line) => {
      const match = line.match(/^(\S+):\s+(\d+)\s+s$/);
      const mintUrl = match?.[1];
      const amount = match?.[2];
      if (mintUrl && amount) {
        balances[mintUrl] = Number.parseInt(amount, 10);
      }
    });
  return balances;
}

function parseMints(output: string): Array<{ url: string; trusted: boolean }> {
  return output
    .split("\n")
    .map((line) => line.trim())
    .map((line) => {
      const urlMatch = line.match(/https?:\/\/\S+/i);
      if (!urlMatch) return null;
      const trustedMatch = line.match(/trusted:\s*(true|false)/i);
      const trustedValue = trustedMatch?.[1];
      return {
        url: urlMatch[0],
        trusted: trustedMatch ? trustedValue?.toLowerCase() === "true" : false,
      };
    })
    .filter((entry): entry is { url: string; trusted: boolean } =>
      Boolean(entry),
    );
}

function pickTokenLine(output: string): string {
  const lines = output
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);
  return lines[lines.length - 1] || "";
}

type UsageData = {
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
  cost: number;
  satsCost: number;
};

type UsageTrackingEntry = UsageData & {
  id: string;
  timestamp: number;
  modelId: string;
  baseUrl: string;
  requestId: string;
  client?: string;
  sessionId?: string;
  tags?: string[];
};

function extractUsageFromResponseBody(body: unknown): UsageData | null {
  if (!body || typeof body !== "object") return null;
  const usage = (body as { usage?: Record<string, unknown> }).usage;
  if (!usage || typeof usage !== "object") return null;

  const promptTokens = Number(usage.prompt_tokens ?? 0);
  const completionTokens = Number(usage.completion_tokens ?? 0);
  const totalTokens = Number(usage.total_tokens ?? 0);
  const costValue = usage.cost;

  let cost = 0;
  let satsCost = 0;

  if (typeof costValue === "number") {
    cost = costValue;
  } else if (costValue && typeof costValue === "object") {
    const costObj = costValue as Record<string, unknown>;
    const totalUsd = costObj.total_usd;
    const totalMsats = costObj.total_msats;

    cost = typeof totalUsd === "number" ? totalUsd : 0;
    satsCost = typeof totalMsats === "number" ? totalMsats / 1000 : 0;
  }

  if (
    promptTokens === 0 &&
    completionTokens === 0 &&
    totalTokens === 0 &&
    cost === 0 &&
    satsCost === 0
  ) {
    return null;
  }

  return {
    promptTokens,
    completionTokens,
    totalTokens,
    cost,
    satsCost,
  };
}

function resolveUsageBaseUrl(response: Response, fallback?: string): string {
  const responseWithBaseUrl = response as Response & { baseUrl?: unknown };
  if (typeof responseWithBaseUrl.baseUrl === "string") {
    return responseWithBaseUrl.baseUrl;
  }

  try {
    if (response.url) {
      const parsed = new URL(response.url);
      return `${parsed.protocol}//${parsed.host}`;
    }
  } catch {
    // Ignore URL parsing failures.
  }

  return fallback || "unknown";
}

function extractResponseId(body: unknown): string | undefined {
  if (!body || typeof body !== "object") return undefined;
  const id = (body as { id?: unknown }).id;
  if (typeof id !== "string") return undefined;
  const trimmed = id.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

function createSSEParserTransform(
  onUsage: (usage: UsageData) => void,
  onResponseId?: (responseId: string) => void,
): Transform {
  let buffer = "";

  const maybeCaptureUsageFromJson = (jsonText: string): void => {
    try {
      const data = JSON.parse(jsonText) as any;
      logger.log(data);
      const responseId = data.id;
      if (typeof responseId === "string" && responseId.trim().length > 0) {
        onResponseId?.(responseId.trim());
      }

      if (data.usage && !data.choices?.length) {
        const cost = data.usage.cost?.total_usd ?? data.usage.cost ?? 0;
        const msats =
          data.usage.cost?.total_msats ??
          data.metadata?.routstr?.cost?.total_msats ??
          0;
        onUsage({
          promptTokens: data.usage.prompt_tokens ?? 0,
          completionTokens: data.usage.completion_tokens ?? 0,
          totalTokens: data.usage.total_tokens ?? 0,
          cost,
          satsCost: msats / 1000,
        });
      }
    } catch {
      // Ignore non-JSON lines/events.
    }
  };

  return new Transform({
    transform(chunk, encoding, callback) {
      this.push(chunk);

      buffer += chunk.toString();
      const lines = buffer.split(/\r?\n/);
      buffer = lines.pop() || "";

      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed || trimmed === "[DONE]") {
          continue;
        }

        if (trimmed.startsWith("data: ")) {
          const dataStr = trimmed.slice(6);
          if (dataStr !== "[DONE]") {
            maybeCaptureUsageFromJson(dataStr);
          }
          continue;
        }

        if (trimmed.startsWith("data:")) {
          const dataStr = trimmed.slice(5).trimStart();
          if (dataStr !== "[DONE]") {
            maybeCaptureUsageFromJson(dataStr);
          }
          continue;
        }

        if (trimmed.startsWith("{")) {
          maybeCaptureUsageFromJson(trimmed);
        }
      }

      callback();
    },
    flush(callback) {
      const trimmed = buffer.trim();
      if (trimmed.startsWith("data: ")) {
        const dataStr = trimmed.slice(6);
        if (dataStr !== "[DONE]") {
          maybeCaptureUsageFromJson(dataStr);
        }
      } else if (trimmed.startsWith("data:")) {
        const dataStr = trimmed.slice(5).trimStart();
        if (dataStr !== "[DONE]") {
          maybeCaptureUsageFromJson(dataStr);
        }
      } else if (trimmed.startsWith("{")) {
        maybeCaptureUsageFromJson(trimmed);
      }
      callback();
    },
  });
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv);
  const config = await loadConfig();

  const port = args.port;
  const provider = args.provider || config.provider;

  await ensureDirs();

  // Save updated config
  const updatedConfig = { ...config, port, provider };
  saveConfig(updatedConfig);

  const sqliteDriver = createBunSqliteDriver(DB_PATH);
  const store = await createSdkStore({ driver: sqliteDriver });

  const appendUsageTracking = (entry: UsageTrackingEntry): void => {
    const state = store.getState();
    const nextUsage = [...(state.usageTracking || []), entry];
    state.setUsageTracking(nextUsage);
    logger.log("Usage tracking saved:", JSON.stringify(entry));
  };

  // Create adapters from our SQLite-backed store
  const discoveryAdapter = createDiscoveryAdapterFromStore(store);
  const providerRegistry = createProviderRegistryFromStore(store);
  const storageAdapter = createStorageAdapterFromStore(store);
  const modelManager = new ModelManager(discoveryAdapter);

  let providerBootstrapPromise: Promise<void> | null = null;
  const ensureProvidersBootstrapped = (): Promise<void> => {
    if (!providerBootstrapPromise) {
      providerBootstrapPromise = (async () => {
        logger.log("Bootstrapping providers...");
        const providers = await modelManager.bootstrapProviders(false);
        logger.log(`Bootstrapped ${providers.length} providers`);
        await modelManager.fetchModels(providers);
        logger.log("Provider bootstrap complete.");
      })().catch((error) => {
        logger.error("Provider bootstrap failed:", error);
        throw error;
      });
    }
    return providerBootstrapPromise;
  };

  const getRoutstr21Models = async (): Promise<ExposedModel[]> => {
    await ensureProvidersBootstrapped();

    const routstr21ModelIds = Array.from(
      new Set(await modelManager.fetchRoutstr21Models()),
    ).slice(0, 21);
    const baseUrls = modelManager.getBaseUrls();
    const discoveredModels = await modelManager.fetchModels(baseUrls);
    const modelsById = new Map(
      discoveredModels.map((model) => [model.id, model]),
    );

    return routstr21ModelIds.map((modelId) => {
      const model = modelsById.get(modelId);
      return model || { id: modelId, name: modelId };
    });
  };

  // Start bootstrap in background so daemon can become healthy quickly.
  void ensureProvidersBootstrapped().catch(() => {
    // Error is already logged; keep daemon alive for troubleshooting/retries.
  });

  let activeMintUrl: string | null = null;
  let mintUnits: Record<string, "sat" | "msat"> = {};

  const walletAdapter = {
    async getBalances(): Promise<Record<string, number>> {
      const output = await runWalletCommand(["balance"]);
      const balances = parseBalances(output);
      mintUnits = Object.fromEntries(
        Object.keys(balances).map((mintUrl) => [mintUrl, "sat"]),
      );
      if (!activeMintUrl) {
        activeMintUrl = Object.keys(balances)[0] || null;
      }
      return balances;
    },
    getMintUnits(): Record<string, "sat" | "msat"> {
      return mintUnits;
    },
    getActiveMintUrl(): string | null {
      return activeMintUrl;
    },
    async sendToken(mintUrl: string, amount: number): Promise<string> {
      const maxRetries = 3;
      const retryDelayMs = 5000;
      const retryErrorPattern = "Proof already reserved by operation";

      for (let attempt = 0; attempt <= maxRetries; attempt++) {
        try {
          const output = await runWalletCommand([
            "send",
            "cashu",
            String(amount),
            "--mint-url",
            mintUrl,
          ]);
          const token = pickTokenLine(output);
          if (!token) {
            throw new Error("Wallet CLI did not return a token.");
          }
          return token;
        } catch (error) {
          const errorMessage =
            error instanceof Error ? error.message : String(error);

          const shouldRetry =
            attempt < maxRetries &&
            errorMessage.includes(retryErrorPattern);

          if (shouldRetry) {
            logger.log(
              `sendToken attempt ${attempt + 1} failed with reserved proof error, retrying in ${retryDelayMs / 1000}s...`,
            );
            await new Promise((resolve) =>
              setTimeout(resolve, retryDelayMs),
            );
            continue;
          }

          logger.error("Error in walletAdapter sendToken:", error);
          throw error;
        }
      }
      throw new Error("sendToken failed after max retries");
    },
    async receiveToken(token: string): Promise<{
      success: boolean;
      amount: number;
      unit: "sat" | "msat";
      message?: string;
    }> {
      try {
        await runWalletCommand(["receive", "cashu", token]);
        const decoded = getDecodedToken(token);
        const amount = decoded?.proofs?.reduce(
          (sum, proof) => sum + proof.amount,
          0,
        );
        const unit = decoded?.unit === "msat" ? "msat" : "sat";
        return { success: true, amount: amount ?? 0, unit };
      } catch (error) {
        console.log("Eerro in receive", error);
        const errorMessage =
          error instanceof Error ? error.message : String(error);
        const message = errorMessage.includes("Failed to fetch mint")
          ? errorMessage
          : undefined;
        return { success: false, amount: 0, unit: "sat", message };
      }
    },
    isUsingNip60(): boolean {
      return false;
    },
  };

  try {
    const mintsOutput = await runWalletCommand(["mints", "list"]);
    const mints = parseMints(mintsOutput);
    activeMintUrl =
      mints.find((mint) => mint.trusted)?.url || mints[0]?.url || null;
  } catch (error) {
    logger.error("Failed to read mints from wallet:", error);
  }

  const server = createServer(
    async (req: IncomingMessage, res: ServerResponse) => {
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
          const balancesOutput = await runWalletCommand(["balance"]);
          const balances = parseBalances(balancesOutput);
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
          const models = await getRoutstr21Models();
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
          const models = await getRoutstr21Models();
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
          server.close(() => {
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

          const state = store.getState();
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

          const client = new RoutstrClient(
            walletAdapter,
            storageAdapter,
            providerRegistry,
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
          const message =
            error instanceof Error ? error.message : String(error);
          logger.error(`Refund error: ${message}`);
          res.writeHead(500, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ error: message }));
        }
        return;
      }

      if (req.method === "GET" && url.pathname === "/balance") {
        try {
          const output = await runWalletCommand(["balance"]);
          const balances = parseBalances(output);
          if (!activeMintUrl && Object.keys(balances).length > 0) {
            activeMintUrl = Object.keys(balances)[0] || null;
          }
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(
            JSON.stringify({
              output: {
                balances,
                unit: "sat",
                activeMint: activeMintUrl,
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
          const walletBalances = await walletAdapter.getBalances();
          const totalWallet = Object.values(walletBalances).reduce(
            (sum, balance) => sum + balance,
            0,
          );

          const state = store.getState();
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
          const requestedLimit = Number.parseInt(
            url.searchParams.get("limit") || "10",
            10,
          );
          const limit =
            Number.isFinite(requestedLimit) && requestedLimit > 0
              ? Math.min(requestedLimit, 1000)
              : 10;

          const usageTracking =
            ((store.getState().usageTracking || []) as UsageTrackingEntry[]) ||
            [];
          const recent = usageTracking.slice(-limit).reverse();
          const totalSatsCost = usageTracking.reduce(
            (sum, entry) => sum + (entry.satsCost || 0),
            0,
          );
          const recentSatsCost = recent.reduce(
            (sum, entry) => sum + (entry.satsCost || 0),
            0,
          );

          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(
            JSON.stringify({
              output: {
                entries: recent,
                totalEntries: usageTracking.length,
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

          const requestedLimit = Number.parseInt(
            url.searchParams.get("limit") || "10",
            10,
          );
          const limit =
            Number.isFinite(requestedLimit) && requestedLimit > 0
              ? Math.min(requestedLimit, 1000)
              : 10;

          const usageTracking =
            ((store.getState().usageTracking || []) as UsageTrackingEntry[]) ||
            [];
          const requestIdPrefix = `gen-${timestamp}-`;
          const filteredUsage = usageTracking.filter((entry) =>
            entry.requestId.startsWith(requestIdPrefix),
          );
          const recent = filteredUsage.slice(-limit).reverse();
          const totalSatsCost = filteredUsage.reduce(
            (sum, entry) => sum + (entry.satsCost || 0),
            0,
          );
          const recentSatsCost = recent.reduce(
            (sum, entry) => sum + (entry.satsCost || 0),
            0,
          );

          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(
            JSON.stringify({
              output: {
                entries: recent,
                totalEntries: filteredUsage.length,
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

      const forcedProvider =
        url.searchParams.get("provider") ||
        (req.headers["x-routstr-provider"] as string | undefined) ||
        provider ||
        undefined;

      try {
        await ensureProvidersBootstrapped();
        const response = await routeRequests({
          modelId,
          requestBody,
          forcedProvider,
          walletAdapter,
          storageAdapter,
          providerRegistry,
          discoveryAdapter,
          modelManager,
          debugLevel: "DEBUG",
        });

        const isStream = bodyObj.stream === true;
        // response.headers.get("content-type") === "text/event-stream";
        const requestId =
          response.headers.get("x-routstr-request-id") || undefined;
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
                const usageRequestId =
                  capturedResponseId || requestId || "unknown";
                appendUsageTracking({
                  id:
                    usageRequestId === "unknown"
                      ? `req-${Date.now()}-${modelId}`
                      : usageRequestId,
                  timestamp: Date.now(),
                  modelId,
                  baseUrl: usageBaseUrl,
                  requestId: usageRequestId,
                  ...capturedUsage,
                });
                logger.log(
                  `Streaming request usage:`,
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
          appendUsageTracking({
            id:
              responseRequestId === "unknown"
                ? `req-${Date.now()}-${modelId}`
                : responseRequestId,
            timestamp: Date.now(),
            modelId,
            baseUrl: usageBaseUrl,
            requestId: responseRequestId,
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
    },
  );

  // Write PID file
  Bun.write(PID_FILE, String(process.pid));

  // Remove old socket if exists
  try {
    if (existsSync(SOCKET_PATH)) {
      Bun.spawn(["rm", SOCKET_PATH]);
    }
  } catch {
    // Ignore
  }

  server.listen(port, async () => {
    logger.log(`Routstr daemon listening on http://localhost:${port}`);
  });
}

export async function startDaemon(
  options: { port?: string; provider?: string } = {},
): Promise<void> {
  const args: string[] = [];
  const port = options.port || "8008";
  const pollIntervalMs = 250;
  const startupTimeoutMs = 10 * 60 * 1000;

  try {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 2000);
    const existing = await fetch(`http://localhost:${port}/health`, {
      signal: controller.signal,
    });
    clearTimeout(timeoutId);
    if (existing.ok) {
      logger.log(`Routstr daemon already running on http://localhost:${port}`);
      return;
    }
  } catch {
    // Daemon is not running yet; continue with startup.
  }

  if (options.port) {
    args.push("--port", options.port);
  }
  if (options.provider) {
    args.push("--provider", options.provider);
  }

  // Spawn daemon.ts as a truly detached background process
  // stdio is set to "ignore" so the parent holds no pipe handles,
  // allowing it to exit cleanly. The child daemon logs to LOG_FILE via its own logger.
  const logFile = Bun.file(LOG_FILE);

  const proc = Bun.spawn(
    ["bun", "run", `${import.meta.dir}/daemon.ts`, ...args],
    {
      stdout: logFile,
      stderr: logFile,
      stdin: "ignore",
      detached: true,
    },
  );

  proc.unref();

  let exitCode: number | null = null;
  proc.exited.then((code) => {
    exitCode = code;
  });

  // Poll until the daemon is healthy
  const maxPolls = Math.ceil(startupTimeoutMs / pollIntervalMs);
  for (let i = 0; i < maxPolls; i++) {
    await new Promise((resolve) => setTimeout(resolve, pollIntervalMs));

    if (exitCode !== null) {
      throw new Error(
        `Daemon process exited early with code ${exitCode}. Check logs at ${LOG_FILE}`,
      );
    }

    try {
      const res = await fetch(`http://localhost:${port}/health`);
      if (res.ok) {
        logger.log(`Routstr daemon started (PID: ${proc.pid}).`);
        return;
      }
    } catch {
      // Not ready yet
    }
  }

  throw new Error(
    `Daemon failed to start within ${Math.round(startupTimeoutMs / 1000)} seconds. Check logs at ${LOG_FILE}`,
  );
}

// Only auto-run main() when this file is executed directly (not imported)
if (import.meta.main) {
  main().catch((error) => {
    logger.error("Failed to start Routstr daemon:", error);
    process.exit(1);
  });
}
