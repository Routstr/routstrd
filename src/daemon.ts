import { createServer, IncomingMessage, ServerResponse } from "http";
import { Readable } from "stream";
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
  createDiscoveryAdapterFromStore,
  createProviderRegistryFromStore,
  createStorageAdapterFromStore,
  createSdkStore,
  routeRequests,
  InsufficientBalanceError,
  RoutstrClient,
} from "@routstr/sdk";

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
        const row = db.query("SELECT value FROM sdk_storage WHERE key = ?").get(key) as { value: string } | undefined;
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
          "INSERT INTO sdk_storage (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value"
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
    (arg) => arg === "--provider" || arg === "-p"
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
          new Error(stderr.trim() || stdout.trim() || "Wallet CLI failed")
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
        })
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
        trusted: trustedMatch
          ? trustedValue?.toLowerCase() === "true"
          : false,
      };
    })
    .filter((entry): entry is { url: string; trusted: boolean } =>
      Boolean(entry)
    );
}

function pickTokenLine(output: string): string {
  const lines = output
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);
  return lines[lines.length - 1] || "";
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
  
  // Create adapters from our SQLite-backed store
  const discoveryAdapter = createDiscoveryAdapterFromStore(store);
  const providerRegistry = createProviderRegistryFromStore(store);
  const storageAdapter = createStorageAdapterFromStore(store);

  logger.log("Bootstrapping providers...");
  const modelManager = new ModelManager(discoveryAdapter);
  const providers = await modelManager.bootstrapProviders(false);
  logger.log(`Bootstrapped ${providers.length} providers`);
  await modelManager.fetchModels(providers);
  logger.log("Provider bootstrap complete.");

  let activeMintUrl: string | null = null;
  let mintUnits: Record<string, "sat" | "msat"> = {};

  const walletAdapter = {
    async getBalances(): Promise<Record<string, number>> {
      const output = await runWalletCommand(["balance"]);
      const balances = parseBalances(output);
      mintUnits = Object.fromEntries(
        Object.keys(balances).map((mintUrl) => [mintUrl, "sat"])
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
        logger.error("Error in walletAdapter sendToken:", error);
        throw error;
      }
    },
    async receiveToken(
      token: string
    ): Promise<{ success: boolean; amount: number; unit: "sat" | "msat" }> {
      try {
        await runWalletCommand(["receive", "cashu", token]);
        const decoded = getDecodedToken(token);
        const amount = decoded?.proofs?.reduce(
          (sum, proof) => sum + proof.amount,
          0
        );
        const unit = decoded?.unit === "msat" ? "msat" : "sat";
        return { success: true, amount: amount ?? 0, unit };
      } catch (error) {
        logger.error("Error in walletAdapter receiveToken:", error);
        return { success: false, amount: 0, unit: "sat" };
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
            })
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
            })
          );
        }
        return;
      }

      if (req.method === "GET" && url.pathname === "/models") {
        try {
          await modelManager.fetchRoutstr21Models();
          const models = discoveryAdapter.getRoutstr21Models();
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ output: { models } }));
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
            res.end(JSON.stringify({ error: "Missing required 'mintUrl' field." }));
            return;
          }

          const state = store.getState();
          const pendingDistribution = (state.cachedTokens || []).map((t: { baseUrl: string; balance?: number }) => ({
            baseUrl: t.baseUrl,
            amount: t.balance || 0,
          }));
          const apiKeysStored = (state.apiKeys || []).map((k: { baseUrl: string; balance?: number }) => ({
            baseUrl: k.baseUrl,
            amount: k.balance || 0,
          }));

          if (pendingDistribution.length === 0 && apiKeysStored.length === 0) {
            res.writeHead(200, { "Content-Type": "application/json" });
            res.end(JSON.stringify({ output: { message: "No pending tokens to refund", results: [] } }));
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
            "lazyrefund"
          );

          const spender = client.getCashuSpender();
          const results = await spender.refundProviders(refundBaseUrls, mintUrl, true);

          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(JSON.stringify({
            output: {
              message: `Refunded to ${mintUrl}`,
              pendingTokens: pendingDistribution.length,
              apiKeys: apiKeysStored.length,
              results: results.map((r: { baseUrl: string; success: boolean }) => ({
                baseUrl: r.baseUrl,
                success: r.success,
              })),
            },
          }));
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
            })
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
            0
          );

          const state = store.getState();
          const cachedTokens = state.cachedTokens || [];
          const totalCached = cachedTokens.reduce(
            (sum: number, t: { balance?: number }) => sum + (t.balance || 0),
            0
          );

          const apiKeys = state.apiKeys || [];
          const totalApiKeys = apiKeys.reduce(
            (sum: number, k: { balance?: number }) => sum + (k.balance || 0),
            0
          );

          const keys: Array<{ id: string; name: string; balance: number }> = [
            { id: "wallet", name: "Wallet", balance: totalWallet },
            ...cachedTokens.map(
              (t: { baseUrl: string; balance?: number }) => ({
                id: `cached:${t.baseUrl}`,
                name: `Cached: ${t.baseUrl}`,
                balance: t.balance || 0,
              })
            ),
            ...apiKeys.map(
              (k: { baseUrl: string; balance?: number }) => ({
                id: `apikey:${k.baseUrl}`,
                name: `API Key: ${k.baseUrl}`,
                balance: k.balance || 0,
              })
            ),
          ];

          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(
            JSON.stringify({
              output: {
                keys,
                total: totalWallet + totalCached + totalApiKeys,
                unit: "sat",
              },
            })
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
          })
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
        const response = await routeRequests({
          modelId,
          requestBody,
          forcedProvider,
          walletAdapter,
          storageAdapter,
          providerRegistry,
          discoveryAdapter,
          modelManager,
        });
        const requestId = response.headers.get("x-routstr-request-id") || undefined;
        logger.log("Request ID, ", requestId, " with path: ", url.pathname); 

        const isStream = bodyObj.stream === true;

        if (isStream) {
          const body = response.body;
          if (body) {
            const nodeReadable = Readable.fromWeb(
              body as unknown as WebReadableStream
            );
            nodeReadable.pipe(res);
          } else {
            res.end();
          }
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
            })
          );
          return;
        }

        res.writeHead(500, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: message }));
      }
    }
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

export async function startDaemon(options: { port?: string; provider?: string } = {}): Promise<void> {
  const args: string[] = [];
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

  const proc = Bun.spawn(["bun", "run", `${import.meta.dir}/daemon.ts`, ...args], {
    stdout: logFile,
    stderr: logFile,
    stdin: "ignore",
    detached: true,
  });

  proc.unref();

  const port = options.port || "8008";

  // Poll until the daemon is healthy
  for (let i = 0; i < 100; i++) {
    await new Promise((resolve) => setTimeout(resolve, 200));
    try {
      const res = await fetch(`http://localhost:${port}/health`);
      if (res.ok) {
        logger.log(`Routstr daemon started (PID: ${proc.pid}).`);
        process.exit(0);
      }
    } catch {
      // Not ready yet
    }
  }

  throw new Error("Daemon failed to start within 20 seconds");
}

// Only auto-run main() when this file is executed directly (not imported)
if (import.meta.main) {
  main().catch((error) => {
    logger.error("Failed to start Routstr daemon:", error);
    process.exit(1);
  });
}
