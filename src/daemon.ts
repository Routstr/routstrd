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
  DEFAULT_CONFIG,
  type RoutstrdConfig,
} from "./utils/config";
import { logger } from "./utils/logger";

const SDK_PATH = "/home/debian/knightclaw/projects/routstr-chat/sdk/dist/index.mjs";

let sdk: any = null;

async function loadSdk() {
  if (!sdk) {
    sdk = await import(SDK_PATH);
  }
  return sdk;
}

function createBunSqliteDriver(dbPath: string) {
  const db = new SQLite(dbPath);
  
  db.exec(`
    CREATE TABLE IF NOT EXISTS sdk_storage (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL
    )
  `);

  return {
    getItem<T>(key: string, defaultValue: T): T {
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
    setItem<T>(key: string, value: T): void {
      try {
        db.query(
          "INSERT INTO sdk_storage (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value"
        ).run(key, JSON.stringify(value));
      } catch (error) {
        logger.error(`SQLite setItem failed for key "${key}":`, error);
      }
    },
    removeItem(key: string): void {
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
  const provider =
    providerFlagIndex !== -1 ? argv[providerFlagIndex + 1]?.trim() : null;

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
      if (match) {
        balances[match[1]] = Number.parseInt(match[2], 10);
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
      return {
        url: urlMatch[0],
        trusted: trustedMatch
          ? trustedMatch[1].toLowerCase() === "true"
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

  const sdkModule = await loadSdk();
  const { ModelManager, getDefaultDiscoveryAdapter, getDefaultProviderRegistry, getDefaultStorageAdapter, createMemoryDriver, createSdkStore } = sdkModule;

  // For now, use memory driver (can be upgraded to sqlite later)
  const memoryDriver = createMemoryDriver();
  const store = createSdkStore({ driver: memoryDriver });
  
  // Get adapters (these use the default store, but we'll work with what we have)
  const discoveryAdapter = getDefaultDiscoveryAdapter();
  const providerRegistry = getDefaultProviderRegistry();
  const storageAdapter = getDefaultStorageAdapter();

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
    },
    async receiveToken(
      token: string
    ): Promise<{ success: boolean; amount: number; unit: "sat" | "msat" }> {
      await runWalletCommand(["receive", "cashu", token]);
      const decoded = getDecodedToken(token);
      const amount = decoded?.proofs?.reduce(
        (sum, proof) => sum + proof.amount,
        0
      );
      const unit = decoded?.unit === "msat" ? "msat" : "sat";
      return { success: true, amount: amount ?? 0, unit };
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

      if (req.method === "GET" && url.pathname === "/keys/balance") {
        try {
          const keys: Array<{ id: string; name: string; balance: number }> = [];
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ output: { keys } }));
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
        const { routeRequests, InsufficientBalanceError } = sdkModule;
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
        const sdkModuleError = await loadSdk();
        const { InsufficientBalanceError } = sdkModuleError;
        const message = error instanceof Error ? error.message : String(error);
        logger.error(`[daemon] Error: ${message}`);

        if (error instanceof InsufficientBalanceError) {
          res.writeHead(402, { "Content-Type": "application/json" });
          res.end(
            JSON.stringify({
              error: message,
              error_type: "insufficient_balance",
              required: error.required,
              available: error.available,
              maxMintBalance: error.maxMintBalance,
              maxMintUrl: error.maxMintUrl,
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

main().catch((error) => {
  logger.error("Failed to start Routstr daemon:", error);
  process.exit(1);
});

export async function startDaemon(options: { port?: string; provider?: string } = {}): Promise<void> {
  const port = options.port ? parseInt(options.port, 10) : 8008;
  const args = [...process.argv.slice(0, 2), "daemon"];
  if (options.port) {
    args.push("--port", options.port);
  }
  if (options.provider) {
    args.push("--provider", options.provider);
  }
  
  const proc = Bun.spawn({
    cmd: ["bun", "run", `${import.meta.dir}/daemon.ts`, ...args.slice(2)],
    stdout: "inherit",
    stderr: "inherit",
  });
  await proc.exited;
}
