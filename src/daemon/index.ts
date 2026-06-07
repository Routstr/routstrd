import { createServer } from "http";
import { existsSync, unlinkSync } from "fs";
import {
  ModelManager,
  ProviderManager,
  createStorageAdapterFromStore,
  createSdkStore,
} from "@routstr/sdk";
import type { SdkLogger } from "@routstr/sdk";
import { CONFIG_DIR, DB_PATH, SOCKET_PATH, PID_FILE } from "../utils/config";
import { logger } from "../utils/logger";


function makeSdkLogger(prefix?: string): SdkLogger {
  const tag = prefix ? `[${prefix}]` : undefined;
  const fmt = (...args: unknown[]) => (tag ? [tag, ...args] : args);
  return {
    log: (...args: unknown[]) => logger.log(...fmt(...args)),
    warn: (...args: unknown[]) => logger.warn(...fmt(...args)),
    error: (...args: unknown[]) => logger.error(...fmt(...args)),
    debug: (...args: unknown[]) => logger.debug(...fmt(...args)),
    child: (p: string) => makeSdkLogger(prefix ? `${prefix}:${p}` : p),
  };
}
const daemonSdkLogger: SdkLogger = makeSdkLogger();
import { parseArgs } from "./args";
import { ensureDirs, loadDaemonConfig, loadDaemonConfigSync, saveDaemonConfig } from "./config-store";
import {
  createBunSqliteDriver,
  createBunSqliteUsageTrackingDriver,
  createShardedDiscoveryAdapter,
  createProviderRegistryFromDiscoveryAdapter,
} from "@routstr/sdk/storage";
import { createWalletAdapter } from "./wallet";
import type { AutoRefillConfig } from "./wallet/auto-refill";
import { createCocodClient } from "./wallet/cocod-client";
import { createModelService } from "./models";
import { createDaemonRequestHandler } from "./http";
import { refreshModelsAndIntegrations } from "../integrations";
import { RoutstrClient } from "@routstr/sdk";

async function main(): Promise<void> {
  const args = parseArgs(process.argv);
  const config = await loadDaemonConfig();

  const port = args.port;
  const provider = args.provider || config.provider;

  await ensureDirs();

  const updatedConfig = { ...config, port, provider };
  saveDaemonConfig(updatedConfig);

  const sqliteDriver = await createBunSqliteDriver(DB_PATH, { logger: daemonSdkLogger });
  const { store, hydrate } = createSdkStore({ driver: sqliteDriver });
  await hydrate;
  const { Database } = await import("bun:sqlite");
  const usageTrackingDriver = createBunSqliteUsageTrackingDriver({
    dbPath: DB_PATH,
    sqlite: { Database },
    legacyStorageDriver: sqliteDriver,
  });

  const discoveryAdapter = await createShardedDiscoveryAdapter({ driver: sqliteDriver });
  const providerRegistry = createProviderRegistryFromDiscoveryAdapter(discoveryAdapter, daemonSdkLogger);
  const storageAdapter = createStorageAdapterFromStore(store);
  const modelManager = new ModelManager(discoveryAdapter, {
    logger: daemonSdkLogger,
    eventStoreDbPath: `${CONFIG_DIR}/events.db`,
  });
  // Create shared ProviderManager for consistent failure tracking across all requests
  const providerManager = new ProviderManager(providerRegistry, store, daemonSdkLogger);
  const { ensureProvidersBootstrapped, getRoutstr21Models, getModelProviders } =
    createModelService(modelManager, store);

  const walletClient = createCocodClient({ cocodPath: config.cocodPath });

  // ── Auto-refill configuration ────────────────────────────────
  // Uses a getter that reads config from disk each cycle, so
  // CLI changes take effect immediately without a daemon restart.

  const getAutoRefillConfig = (): AutoRefillConfig | undefined => {
    const cfg = loadDaemonConfigSync();
    if (cfg.nwc?.autoRefill?.enabled && cfg.nwc?.connectionString) {
      return {
        threshold: cfg.nwc.autoRefill.threshold,
        amount: cfg.nwc.autoRefill.amount,
        cooldownMs: cfg.nwc.autoRefill.cooldownMs,
      };
    }
    return undefined;
  };

  const walletAdapter = await createWalletAdapter({
    cocodPath: config.cocodPath,
    walletClient,
    getAutoRefillConfig,
    nwcConnectionString: config.nwc?.connectionString,
  });

  const refundClient = new RoutstrClient(
    walletAdapter,
    storageAdapter,
    providerRegistry,
    "min",
    "apikeys",
    { logger: daemonSdkLogger },
  );

  const server = createServer();
  server.on(
    "request",
    createDaemonRequestHandler({
      provider,
      server,
      store,
      walletClient,
      walletAdapter,
      storageAdapter,
      providerRegistry,
      discoveryAdapter,
      modelManager,
      ensureProvidersBootstrapped,
      getRoutstr21Models,
      getModelProviders,
      mode: config.mode || "apikeys",
      routstrPubkey: config.routstrPubkey,
      usageTrackingDriver,
      providerManager,
      refundClient,
    }),
  );

  Bun.write(PID_FILE, String(process.pid));

  try {
    if (existsSync(SOCKET_PATH)) {
      unlinkSync(SOCKET_PATH);
    }
  } catch {
    // Ignore
  }

  const REFRESH_INTERVAL_MS = 21 * 60 * 1000; // 21 mins

  // Recurring job to refresh routstr21 models
  let refreshInterval: ReturnType<typeof setInterval> | null = null;

  const startModelRefreshJob = () => {
    logger.log(
      `Starting recurring model refresh job (every ${REFRESH_INTERVAL_MS / 1000 / 60 / 60} hours)`,
    );

    refreshInterval = setInterval(async () => {
      logger.log("Running scheduled model refresh...");
      try {
        await refreshModelsAndIntegrations(getRoutstr21Models, updatedConfig, "Scheduled");
      } catch (error) {
        logger.error("Scheduled model refresh failed:", error);
      }
    }, REFRESH_INTERVAL_MS);
  };

  const stopModelRefreshJob = () => {
    if (refreshInterval) {
      clearInterval(refreshInterval);
      refreshInterval = null;
      logger.log("Stopped recurring model refresh job.");
    }
  };

  // Recurring job to refund pending tokens every 42 minutes
  const REFUND_INTERVAL_MS = 42 * 60 * 1000; // 42 minutes
  let refundInterval: ReturnType<typeof setInterval> | null = null;

  const startRefundJob = async () => {
    logger.log(
      `Starting recurring refund job (every ${REFUND_INTERVAL_MS / 1000 / 60} minutes)`,
    );

    refundInterval = setInterval(async () => {
      logger.log("Running scheduled refund...");
      try {
        const state = store.getState() as any;
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
          logger.log("No pending tokens to refund.");
          return;
        }

        const mintUrl = walletAdapter.getActiveMintUrl();
        if (!mintUrl) {
          logger.log("No active mint URL for refund.");
          return;
        }

        const spender = refundClient.getCashuSpender();
        const results = await spender.refundProviders(mintUrl);

        const successCount = results.filter(
          (r: { success: boolean }) => r.success,
        ).length;
        logger.log(
          `Scheduled refund completed: ${successCount}/${results.length} providers refunded.`,
        );
      } catch (error) {
        logger.error("Scheduled refund failed:", error);
      }
    }, REFUND_INTERVAL_MS);
  };

  const stopRefundJob = () => {
    if (refundInterval) {
      clearInterval(refundInterval);
      refundInterval = null;
      logger.log("Stopped recurring refund job.");
    }
  };

  server.on("close", () => {
    stopModelRefreshJob();
    stopRefundJob();

  });

  server.listen(port, async () => {
    logger.log(`Routstr daemon listening on http://localhost:${port}/v1`);

    // Start the recurring model refresh job after initial bootstrap
    void ensureProvidersBootstrapped()
      .then(async () => {
        startModelRefreshJob();
        startRefundJob();
        // Run an immediate refresh to populate models right away
        logger.log("Running initial model refresh...");
        await refreshModelsAndIntegrations(getRoutstr21Models, updatedConfig, "Initial");
      })
      .catch((error) => {
        logger.error("Initial model refresh failed:", error);
        // Still start the jobs even if initial refresh fails
        startModelRefreshJob();
        startRefundJob();
      });
  });
}

if (import.meta.main) {
  main().catch((error) => {
    logger.error("Failed to start Routstr daemon:", error);
    process.exit(1);
  });
}
