import { createServer } from "http";
import { existsSync } from "fs";
import {
  ProviderManager,
  createStorageAdapterFromStore,
  createSdkStore,
} from "@routstr/sdk";
// ModelManager must come from the bun entrypoint so persistent Nostr event
// storage (eventStoreDbPath) gets its SQLite-backed factory. The default
// "@routstr/sdk" export is browser-safe and throws without that factory
// (SDK 0.3.7+ browser-safe entrypoint split).
import { ModelManager } from "@routstr/sdk/bun";
import type { SdkLogger } from "@routstr/sdk";
import {
  CONFIG_DIR,
  DB_PATH,
  SOCKET_PATH,
  PID_FILE,
  REQUEST_RESPONSE_LOGS_DIR,
} from "../utils/config";
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
} from "@routstr/sdk/storage/bun";
import { createWalletAdapter } from "./wallet";
import type { AutoRefillConfig } from "./wallet/auto-refill";
import { createCocodClient } from "./wallet/cocod-client";
import { createModelService } from "./models";
import { createDaemonRequestHandler } from "./http";
import { FileRequestResponseLogSink } from "./request-response-log-sink";
import { refreshModelsAndIntegrations } from "../integrations";
import { RoutstrClient } from "@routstr/sdk";

// Global error handlers — the daemon is spawned detached with stdout/stderr
// redirected to a file, so without these, uncaught async errors would kill
// the process silently. Log to the file logger before exiting.
process.on("uncaughtException", (error) => {
  logger.error("UNCAUGHT EXCEPTION:", error);
});

process.on("unhandledRejection", (reason) => {
  logger.error("UNHANDLED REJECTION:", reason);
});

async function main(): Promise<void> {
  const args = parseArgs(process.argv);
  const config = await loadDaemonConfig();

  const port = args.port;
  const provider = args.provider || config.provider;
  const requestResponseLogDir =
    process.env.ROUTSTRD_REQUEST_RESPONSE_LOG_DIR ||
    (config.requestResponseLogging?.enabled
      ? config.requestResponseLogging.dir || REQUEST_RESPONSE_LOGS_DIR
      : undefined);
  const requestResponseLogSink = requestResponseLogDir
    ? new FileRequestResponseLogSink({
        dir: requestResponseLogDir,
        logger: daemonSdkLogger.child("request-response-log"),
      })
    : undefined;

  await ensureDirs();

  const updatedConfig = { ...config, port, provider };
  saveDaemonConfig(updatedConfig);

  const sqliteDriver = await createBunSqliteDriver(DB_PATH, { logger: daemonSdkLogger });
  const { store, hydrate } = createSdkStore({ driver: sqliteDriver });
  await hydrate;
  const usageTrackingDriver = await createBunSqliteUsageTrackingDriver({
    dbPath: DB_PATH,
    legacyStorageDriver: sqliteDriver,
  });

  const discoveryAdapter = await createShardedDiscoveryAdapter({ driver: sqliteDriver });
  const storageAdapter = createStorageAdapterFromStore(store);
  const modelManager = new ModelManager(discoveryAdapter, {
    logger: daemonSdkLogger,
    eventStoreDbPath: `${CONFIG_DIR}/events.db`,
    routstrPubkey: config.routstrPubkey,
    nostrRelays: config.relays,
  });
  // Create shared ProviderManager for consistent failure tracking across all requests
  const providerManager = new ProviderManager(discoveryAdapter, store, daemonSdkLogger);
  const { ensureProvidersBootstrapped, getRoutstr21Models, getModelProviders, refreshProvidersAndModels } =
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
    discoveryAdapter,
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
      discoveryAdapter,
      modelManager,
      ensureProvidersBootstrapped,
      getRoutstr21Models,
      getModelProviders,
      refreshProvidersAndModels,
      mode: config.mode || "apikeys",
      routstrPubkey: config.routstrPubkey,
      usageTrackingDriver,
      providerManager,
      refundClient,
      requestResponseLogSink,
    }),
  );

  Bun.write(PID_FILE, String(process.pid));

  try {
    if (existsSync(SOCKET_PATH)) {
      Bun.spawn(["rm", SOCKET_PATH]);
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

    refreshInterval = setInterval(() => {
      (async () => {
        logger.log("Running scheduled Nostr event refresh...");
        try {
          await modelManager.refreshNostrEvents();
        } catch (error) {
          logger.error("Scheduled Nostr event refresh failed:", error);
        }

        logger.log("Running scheduled model refresh...");
        try {
          await refreshModelsAndIntegrations(getRoutstr21Models, updatedConfig, "Scheduled");
        } catch (error) {
          logger.error("Scheduled model refresh failed:", error);
        }
      })().catch((error) => logger.error("Model refresh interval escaped:", error));
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

    refundInterval = setInterval(() => {
      (async () => {
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
      })().catch((error) => logger.error("Refund interval escaped:", error));
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
    if (requestResponseLogDir) {
      logger.log(`Raw request/response logs: ${requestResponseLogDir}`);
    }

    // Start the recurring model refresh job after initial bootstrap
    void ensureProvidersBootstrapped()
      .then(async () => {
        // Catch up on any Nostr events published since last run
        logger.log("Running initial Nostr event refresh...");
        await modelManager.refreshNostrEvents();

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
